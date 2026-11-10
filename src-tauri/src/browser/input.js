// Input and emulation half of the browser bridge (concatenated after devtools.js by the Rust side,
// D316–D318): pointer and keyboard input at a point of the page (clicks with a button and count,
// hover, drag, wheel scroll, keys with modifiers and their usual effect in text fields, typing at
// the focus), the outline `find` searches, the page's main text, prefers-color-scheme emulation,
// and the agent's script runner (REPL: last expression, top-level await, JSON result). Events are
// synthesized (untrusted), as the bridge's other actions are; where the IDE can send a person's
// events through a DevTools protocol (D346), `input.prepare` says where they land and
// `input.report` what came of them. Everything returned is page data.
(() => {
  const api = window.__ideBridge?.internal;
  if (!api) return;
  const { methods, refFor, find, clip, preview, expand, page, role, nameOf, visible, squash } = api;

  // ---- Points -------------------------------------------------------------------------------

  // The agent's coordinate frame is the viewport scaled to fit `maxSide` (as the screenshot it
  // sees); core/agent/browserInput.ts coordinateFrame is the same formula.
  const frameScale = (maxSide) =>
    Math.min(1, Number(maxSide || 1568) / Math.max(1, innerWidth, innerHeight));
  const toClient = (x, y, maxSide) => {
    const s = frameScale(maxSide);
    const cx = Number(x) / s;
    const cy = Number(y) / s;
    if (!(cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight))
      throw new Error(
        `(${x}, ${y}) is outside the page: the coordinate frame is ${Math.round(innerWidth * s)}×${Math.round(innerHeight * s)}.`,
      );
    return { cx, cy };
  };
  const deepAt = (cx, cy) => {
    let el = document.elementFromPoint(cx, cy);
    while (el?.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(cx, cy);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  };
  const deepActive = () => {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el || document.body;
  };
  const label = (el) => {
    const r = role(el);
    const name = squash(nameOf(el) || "").slice(0, 60);
    return `${r || el.tagName.toLowerCase()}${name ? ` "${name}"` : ""} [ref=${refFor(el)}]`;
  };
  /** Where an action happens: a point of the frame, or an element (its center, scrolled to). */
  const targetOf = (p, prefix = "") => {
    const x = p[prefix ? `${prefix}X` : "x"];
    const y = p[prefix ? `${prefix}Y` : "y"];
    if (x !== undefined && y !== undefined) {
      const { cx, cy } = toClient(x, y, p.maxSide);
      const el = deepAt(cx, cy);
      if (!el) throw new Error(`Nothing at (${x}, ${y}).`);
      return { el, cx, cy };
    }
    const el = find(p);
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    return { el, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  };

  const modsOf = (list) => {
    const m = Array.isArray(list) ? list : [];
    return {
      ctrlKey: m.includes("ctrl"),
      shiftKey: m.includes("shift"),
      altKey: m.includes("alt"),
      metaKey: m.includes("meta"),
    };
  };
  const BUTTONS = { 0: 1, 1: 4, 2: 2 };
  const pointer = (el, type, cx, cy, extra = {}) => {
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: cx,
      clientY: cy,
      screenX: cx,
      screenY: cy,
      button: 0,
      buttons: 0,
      ...extra,
    };
    const isPointer = type.startsWith("pointer") && typeof PointerEvent === "function";
    const Ctor = isPointer
      ? PointerEvent
      : type.startsWith("drag") || type === "drop"
        ? DragEvent
        : type === "wheel"
          ? WheelEvent
          : MouseEvent;
    return el.dispatchEvent(
      new Ctor(
        type,
        isPointer ? { pointerId: 1, pointerType: "mouse", isPrimary: true, ...init } : init,
      ),
    );
  };
  const focusable = (el) =>
    el.closest?.(
      "a[href],button,input,select,textarea,summary,[tabindex],[contenteditable=''],[contenteditable=true]",
    );

  let hovered = null;
  const moveTo = (el, cx, cy, mods) => {
    if (hovered !== el) {
      if (hovered?.isConnected) {
        pointer(hovered, "pointerout", cx, cy, { ...mods, relatedTarget: el });
        pointer(hovered, "mouseout", cx, cy, { ...mods, relatedTarget: el });
        pointer(hovered, "pointerleave", cx, cy, { ...mods, bubbles: false, relatedTarget: el });
        pointer(hovered, "mouseleave", cx, cy, { ...mods, bubbles: false, relatedTarget: el });
      }
      pointer(el, "pointerover", cx, cy, mods);
      pointer(el, "mouseover", cx, cy, mods);
      pointer(el, "pointerenter", cx, cy, { ...mods, bubbles: false });
      pointer(el, "mouseenter", cx, cy, { ...mods, bubbles: false });
      hovered = el;
    }
    pointer(el, "pointermove", cx, cy, mods);
    pointer(el, "mousemove", cx, cy, mods);
  };

  /** What a double or triple click selects: a word, or the block (or the field's text). */
  const selectAt = (el, cx, cy, count) => {
    if (/^(INPUT|TEXTAREA)$/.test(el.tagName)) {
      try {
        el.select();
      } catch (_) {
        /* a field without text selection */
      }
      return;
    }
    const sel = getSelection();
    if (!sel) return;
    if (count >= 3) {
      const block = el.closest("p,li,td,th,h1,h2,h3,h4,h5,h6,pre,blockquote,div") || el;
      const range = document.createRange();
      range.selectNodeContents(block);
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    const at = document.caretRangeFromPoint?.(cx, cy);
    const node = at?.startContainer;
    if (node?.nodeType !== 3) return;
    const text = node.nodeValue || "";
    let start = at.startOffset;
    let end = at.startOffset;
    while (start > 0 && /\w/.test(text[start - 1])) start--;
    while (end < text.length && /\w/.test(text[end])) end++;
    sel.setBaseAndExtent(node, start, node, end);
  };

  const settle = () => new Promise((r) => setTimeout(r, 120));
  // A frame's worth between drag steps (a timer: animation frames stop in a hidden window).
  const tick = () => new Promise((r) => setTimeout(r, 16));

  const click = async (p) => {
    const { el, cx, cy } = targetOf(p);
    const mods = modsOf(p.modifiers);
    const button = Number(p.button ?? 0);
    const count = Math.min(3, Math.max(1, Number(p.count ?? 1)));
    moveTo(el, cx, cy, mods);
    for (let i = 1; i <= count; i++) {
      const press = { ...mods, button, detail: i };
      const down = pointer(el, "pointerdown", cx, cy, { ...press, buttons: BUTTONS[button] });
      if (down) pointer(el, "mousedown", cx, cy, { ...press, buttons: BUTTONS[button] });
      if (i === 1 && down) {
        const f = focusable(el);
        if (f && typeof f.focus === "function") f.focus();
        else if (document.activeElement && document.activeElement !== document.body)
          document.activeElement.blur?.();
      }
      pointer(el, "pointerup", cx, cy, press);
      pointer(el, "mouseup", cx, cy, press);
      if (button === 0) pointer(el, "click", cx, cy, press);
      else if (button === 1) pointer(el, "auxclick", cx, cy, press);
    }
    if (button === 2) pointer(el, "contextmenu", cx, cy, { ...mods, button: 2, buttons: 0 });
    if (button === 0 && count >= 2) {
      pointer(el, "dblclick", cx, cy, { ...mods, detail: 2 });
      selectAt(el, cx, cy, count);
    }
    await settle();
    return { clicked: label(el), ...page() };
  };

  const hover = (p) => {
    const { el, cx, cy } = targetOf(p);
    moveTo(el, cx, cy, modsOf(p.modifiers));
    return { hovered: label(el) };
  };

  const drag = async (p) => {
    // From a point, or from an element (x/y are where it goes, not where it starts).
    const from =
      p.fromX !== undefined
        ? targetOf(p, "from")
        : targetOf({ ref: p.ref, selector: p.selector, name: p.name });
    const { cx: tx, cy: ty } = toClient(p.x, p.y, p.maxSide);
    const mods = modsOf(p.modifiers);
    const source = from.el;
    moveTo(source, from.cx, from.cy, mods);
    pointer(source, "pointerdown", from.cx, from.cy, { ...mods, buttons: 1 });
    pointer(source, "mousedown", from.cx, from.cy, { ...mods, buttons: 1 });
    const draggable =
      source.closest('[draggable="true"]') ||
      (source.tagName === "IMG" ? source : null) ||
      source.closest("a[href]");
    const steps = 8;
    let target = source;
    if (draggable && typeof DataTransfer === "function") {
      // HTML drag and drop: dragstart, dragover along the way, drop where the last over accepted.
      const dataTransfer = new DataTransfer();
      if (!pointer(draggable, "dragstart", from.cx, from.cy, { ...mods, dataTransfer })) {
        pointer(source, "pointerup", from.cx, from.cy, mods);
        pointer(source, "mouseup", from.cx, from.cy, mods);
        return { dragged: false, note: "The page cancelled the drag (dragstart)." };
      }
      let accepted = false;
      let over = null;
      for (let i = 1; i <= steps; i++) {
        const cx = from.cx + ((tx - from.cx) * i) / steps;
        const cy = from.cy + ((ty - from.cy) * i) / steps;
        const el = deepAt(cx, cy) || document.body;
        if (el !== over) {
          if (over) pointer(over, "dragleave", cx, cy, { ...mods, dataTransfer });
          pointer(el, "dragenter", cx, cy, { ...mods, dataTransfer });
          over = el;
        }
        accepted = !pointer(el, "dragover", cx, cy, { ...mods, dataTransfer });
        pointer(draggable, "drag", cx, cy, { ...mods, dataTransfer });
        await tick();
      }
      target = over || document.body;
      if (accepted) pointer(target, "drop", tx, ty, { ...mods, dataTransfer });
      pointer(draggable, "dragend", tx, ty, { ...mods, dataTransfer });
      await settle();
      return { dragged: label(draggable), droppedOn: accepted ? label(target) : null, ...page() };
    }
    // Pointer dragging (sliders, canvases, sortable lists that follow the pointer).
    for (let i = 1; i <= steps; i++) {
      const cx = from.cx + ((tx - from.cx) * i) / steps;
      const cy = from.cy + ((ty - from.cy) * i) / steps;
      target = deepAt(cx, cy) || document.body;
      // Pages that capture the pointer listen on the source or the document.
      pointer(target, "pointermove", cx, cy, { ...mods, buttons: 1 });
      pointer(target, "mousemove", cx, cy, { ...mods, buttons: 1 });
      await tick();
    }
    pointer(target, "pointerup", tx, ty, mods);
    pointer(target, "mouseup", tx, ty, mods);
    await settle();
    return { dragged: label(source), to: label(target), ...page() };
  };

  const scrollable = (el, vertical) => {
    for (
      let n = el;
      n && n !== document.body && n !== document.documentElement;
      n = n.parentElement
    ) {
      const s = getComputedStyle(n);
      const overflow = vertical ? s.overflowY : s.overflowX;
      const room = vertical ? n.scrollHeight > n.clientHeight : n.scrollWidth > n.clientWidth;
      if (room && /(auto|scroll|overlay)/.test(overflow)) return n;
    }
    return null;
  };
  const wheel = (p) => {
    const at =
      p.x !== undefined || p.ref || p.selector || p.name
        ? targetOf(p)
        : { el: document.body, cx: innerWidth / 2, cy: innerHeight / 2 };
    const dx = Number(p.dx || 0);
    const dy = Number(p.dy || 0);
    const go = pointer(at.el, "wheel", at.cx, at.cy, {
      ...modsOf(p.modifiers),
      deltaX: dx,
      deltaY: dy,
      deltaMode: 0,
    });
    if (!go) return { scrolled: "the page handled the wheel itself" };
    const box = scrollable(at.el, dy !== 0);
    if (box) {
      box.scrollBy(dx, dy);
      return { scrolled: label(box), scrollTop: Math.round(box.scrollTop) };
    }
    scrollBy(dx, dy);
    return {
      scrolled: "page",
      scrollY: Math.round(scrollY),
      height: document.documentElement.scrollHeight,
    };
  };

  // ---- Keys ---------------------------------------------------------------------------------

  const isField = (el) =>
    (el.tagName === "INPUT" &&
      /^(text|search|url|tel|password|email|number|)$/i.test(el.getAttribute("type") || "")) ||
    el.tagName === "TEXTAREA";
  const hasSelectionApi = (el) => {
    try {
      return typeof el.selectionStart === "number";
    } catch (_) {
      return false;
    }
  };
  const setNative = (el, value) => {
    const proto =
      el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  };
  const inputEvent = (el, inputType, data) =>
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType, data }));
  /** Replaces the field's selection with `text` (or deletes around the caret: `del` -1 / +1). */
  const editField = (el, text, del = 0) => {
    if (el.readOnly || el.disabled) return;
    if (!hasSelectionApi(el)) {
      // number / email fields have no selection: append or drop the last character.
      setNative(el, del ? el.value.slice(0, -1) : `${el.value}${text}`);
      inputEvent(el, del ? "deleteContentBackward" : "insertText", del ? null : text);
      return;
    }
    let start = el.selectionStart ?? el.value.length;
    let end = el.selectionEnd ?? start;
    if (start === end && del < 0) start = Math.max(0, start - 1);
    if (start === end && del > 0) end = Math.min(el.value.length, end + 1);
    el.setRangeText(text, start, end, "end");
    inputEvent(
      el,
      del < 0 ? "deleteContentBackward" : del > 0 ? "deleteContentForward" : "insertText",
      del ? null : text,
    );
  };
  const insertText = (el, text) => {
    if (isField(el)) editField(el, text);
    else if (el.isContentEditable) document.execCommand("insertText", false, text);
  };
  const focusables = () =>
    Array.from(
      document.querySelectorAll(
        "a[href],button,input,select,textarea,summary,[tabindex],[contenteditable=''],[contenteditable=true]",
      ),
    ).filter((el) => el.tabIndex >= 0 && !el.disabled && visible(el));
  const moveFocus = (back) => {
    const list = focusables();
    if (!list.length) return;
    const at = list.indexOf(deepActive());
    const next = back
      ? list[at <= 0 ? list.length - 1 : at - 1]
      : list[at < 0 || at >= list.length - 1 ? 0 : at + 1];
    next?.focus();
  };
  /** The usual effect of a key the page didn't cancel. */
  const defaultAction = (el, key, m) => {
    const shortcut = m.ctrlKey || m.metaKey;
    if (shortcut && key.toLowerCase() === "a") {
      if (isField(el)) el.select();
      else if (el.isContentEditable) document.execCommand("selectAll");
      else getSelection()?.selectAllChildren(document.body);
      return;
    }
    if (shortcut || m.altKey) return;
    if (key.length === 1) {
      insertText(el, key);
      return;
    }
    const field = isField(el);
    switch (key) {
      case "Enter":
        if (el.tagName === "TEXTAREA") editField(el, "\n");
        else if (el.isContentEditable) document.execCommand("insertParagraph");
        else if (el.tagName === "INPUT" && el.form) el.form.requestSubmit();
        else if (el.tagName === "A" || el.tagName === "BUTTON" || el.tagName === "SUMMARY")
          el.click();
        return;
      case "Backspace":
      case "Delete":
        if (field) editField(el, "", key === "Backspace" ? -1 : 1);
        else if (el.isContentEditable)
          document.execCommand(key === "Backspace" ? "delete" : "forwardDelete");
        return;
      case "Tab":
        moveFocus(m.shiftKey);
        return;
      case "ArrowLeft":
      case "ArrowRight":
      case "Home":
      case "End":
        if (field && hasSelectionApi(el)) {
          const len = el.value.length;
          const pos = el.selectionStart ?? len;
          const to =
            key === "Home"
              ? 0
              : key === "End"
                ? len
                : Math.max(0, Math.min(len, pos + (key === "ArrowLeft" ? -1 : 1)));
          el.setSelectionRange(
            m.shiftKey ? Math.min(pos, to) : to,
            m.shiftKey ? Math.max(pos, to) : to,
          );
          return;
        }
        break;
      default:
        break;
    }
    if (field || el.isContentEditable || el.tagName === "SELECT") return;
    const screenful = innerHeight * 0.85;
    const scrolls = {
      ArrowDown: [0, 40],
      ArrowUp: [0, -40],
      ArrowRight: [40, 0],
      ArrowLeft: [-40, 0],
      PageDown: [0, screenful],
      PageUp: [0, -screenful],
      " ": [0, screenful],
    };
    if (key === "Home") scrollTo(scrollX, 0);
    else if (key === "End") scrollTo(scrollX, document.documentElement.scrollHeight);
    else if (scrolls[key]) scrollBy(scrolls[key][0], scrolls[key][1]);
  };
  const KEY_CODES = {
    Enter: "Enter",
    Tab: "Tab",
    Escape: "Escape",
    Backspace: "Backspace",
    Delete: "Delete",
    " ": "Space",
  };
  const pressKey = (el, key, mods) => {
    const code =
      KEY_CODES[key] ||
      (key.length === 1
        ? /[a-z]/i.test(key)
          ? `Key${key.toUpperCase()}`
          : /\d/.test(key)
            ? `Digit${key}`
            : ""
        : key);
    const init = { key, code, bubbles: true, cancelable: true, composed: true, ...mods };
    const go = el.dispatchEvent(new KeyboardEvent("keydown", init));
    const printable = key.length === 1 && !mods.ctrlKey && !mods.metaKey && !mods.altKey;
    const press = !go || !printable || el.dispatchEvent(new KeyboardEvent("keypress", init));
    if (go && press) {
      if (key === " " && /^(BUTTON|SUMMARY)$/.test(el.tagName)) el.click();
      else if (key === " " && el.tagName === "INPUT" && /^(checkbox|radio)$/i.test(el.type))
        el.click();
      else defaultAction(el, key, mods);
    }
    el.dispatchEvent(new KeyboardEvent("keyup", init));
  };

  const keys = async (p) => {
    if (p.ref || p.selector || p.name) {
      const el = find(p);
      el.focus?.();
    }
    const list = Array.isArray(p.keys) ? p.keys : [];
    const repeat = Math.min(100, Math.max(1, Number(p.repeat ?? 1)));
    for (let r = 0; r < repeat; r++)
      for (const k of list) pressKey(deepActive(), String(k.key), modsOf(k.modifiers));
    await settle();
    const chords = list.map((k) =>
      [...(k.modifiers || []), k.key === " " ? "Space" : k.key].join("+"),
    );
    const focused = deepActive();
    return {
      pressed: `${chords.join(" ")}${repeat > 1 ? ` ×${repeat}` : ""}`,
      focused: focused === document.body ? "page" : label(focused),
      ...("value" in focused && isField(focused) && { value: String(focused.value).slice(0, 500) }),
      ...page(),
    };
  };

  const type = async (p) => {
    const el = deepActive();
    const text = String(p.text ?? "");
    if (!isField(el) && !el.isContentEditable)
      throw new Error(
        `Nothing to type into: the focus is on ${el === document.body ? "the page" : label(el)}. Click a text field first (or type with its ref).`,
      );
    for (const ch of text) pressKey(el, ch === "\n" ? "Enter" : ch, modsOf([]));
    if (p.submit) pressKey(el, "Enter", modsOf([]));
    await settle();
    return {
      typed: text.length,
      into: label(el),
      ...("value" in el && isField(el) && { value: String(el.value).slice(0, 500) }),
      ...page(),
    };
  };

  methods["input.do"] = (p) => {
    switch (p.op) {
      case "click":
        return click(p);
      case "hover":
        return hover(p);
      case "drag":
        return drag(p);
      case "scroll":
        return wheel(p);
      case "key":
        return keys(p);
      case "type":
        return type(p);
      default:
        throw new Error(`Unknown input ${p.op}.`);
    }
  };

  // ---- find: the outline as lines with refs -------------------------------------------------

  methods.outline = ({ limit = 5000 } = {}) => {
    const lines = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (lines.length >= limit) return;
        if (child.nodeType === 3) {
          const text = squash(child.nodeValue || "");
          if (text && node.nodeType === 1 && !role(node))
            lines.push({ ref: refFor(node), line: `text ${JSON.stringify(text.slice(0, 200))}` });
          continue;
        }
        if (child.nodeType !== 1) continue;
        const el = child;
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|HEAD|META|LINK)$/i.test(el.tagName)) continue;
        if (el.hasAttribute("data-ide-overlay") || !visible(el)) continue;
        const r = role(el);
        if (r) {
          const name = squash(nameOf(el)).slice(0, 200);
          let line = `${r}${name ? ` ${JSON.stringify(name)}` : ""}`;
          if (r === "link") line += ` -> ${el.getAttribute("href")}`;
          if ("value" in el && r !== "button" && el.value)
            line += ` value=${JSON.stringify(String(el.value).slice(0, 100))}`;
          if (el.placeholder) line += ` placeholder=${JSON.stringify(el.placeholder)}`;
          if (el.checked) line += " [checked]";
          if (el.disabled) line += " [disabled]";
          lines.push({ ref: refFor(el), line });
        }
        walk(el.shadowRoot || el);
      }
    };
    if (document.body) walk(document.body);
    return { ...page(), lines };
  };

  // ---- Page text: the main content first ------------------------------------------------------

  methods.pageText = ({ maxChars = 20000 } = {}) => {
    const body = document.body;
    if (!body) return { ...page(), from: "none", text: "" };
    const textOf = (el) => (el.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
    const all = textOf(body);
    // The largest article, else main: when it holds a fair share of the page's text.
    const articles = Array.from(document.querySelectorAll("article"));
    const article = articles
      .map((el) => ({ el, len: textOf(el).length }))
      .sort((a, b) => b.len - a.len)[0];
    const main = document.querySelector("main, [role=main]");
    const pick =
      article && article.len >= 200 && article.len >= all.length * 0.25
        ? { from: "article", text: textOf(article.el) }
        : main && textOf(main).length >= Math.min(200, all.length * 0.25)
          ? { from: "main", text: textOf(main) }
          : { from: "body", text: all };
    return { ...page(), from: pick.from, text: clip(pick.text, Number(maxChars)) };
  };

  // ---- prefers-color-scheme emulation ---------------------------------------------------------

  let scheme = null;
  const SCHEME = /\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi;
  const original = new WeakMap();
  const rewrite = (media) =>
    media.replace(SCHEME, (_m, want) =>
      want.toLowerCase() === scheme ? "(min-width: 0px)" : "(min-width: 99999999px)",
    );
  const applyMedia = (list) => {
    if (!list) return;
    const was = original.get(list) ?? list.mediaText;
    if (!/prefers-color-scheme/i.test(was)) return;
    original.set(list, was);
    const want = scheme ? rewrite(was) : was;
    if (list.mediaText !== want) list.mediaText = want;
  };
  const applyRules = (rules, depth = 0) => {
    if (!rules || depth > 8) return;
    for (const rule of Array.from(rules)) {
      if (rule.media) applyMedia(rule.media);
      if (rule.styleSheet) {
        applyMedia(rule.styleSheet.media);
        try {
          applyRules(rule.styleSheet.cssRules, depth + 1);
        } catch (_) {
          /* another origin's sheet */
        }
      }
      if (rule.cssRules) applyRules(rule.cssRules, depth + 1);
    }
  };
  let schemeColor = null;
  const applyScheme = () => {
    for (const sheet of Array.from(document.styleSheets)) {
      applyMedia(sheet.media);
      try {
        applyRules(sheet.cssRules);
      } catch (_) {
        /* another origin's sheet: its rules can't be read */
      }
    }
    // A page that offers both schemes (`color-scheme: light dark`) gets the one asked for, for
    // its form controls and light-dark() too.
    const root = document.documentElement;
    if (!root) return;
    if (schemeColor !== null) root.style.colorScheme = schemeColor;
    const offered = getComputedStyle(root).colorScheme || "";
    if (scheme && /light/.test(offered) && /dark/.test(offered)) {
      if (schemeColor === null) schemeColor = root.style.colorScheme;
      root.style.colorScheme = scheme;
    } else if (!scheme) schemeColor = null;
  };
  const realMatchMedia = window.matchMedia?.bind(window);
  if (realMatchMedia)
    window.matchMedia = (query) =>
      realMatchMedia(
        scheme && /prefers-color-scheme/i.test(String(query)) ? rewrite(String(query)) : query,
      );
  let watcher = null;
  // A stylesheet link that finishes loading has rules to rewrite (only while emulating).
  document.addEventListener(
    "load",
    (e) => scheme && e.target?.tagName === "LINK" && applyScheme(),
    true,
  );
  methods["emulate.colorScheme"] = ({ scheme: want } = {}) => {
    scheme = want === "dark" || want === "light" ? want : null;
    applyScheme();
    if (scheme && !watcher && typeof MutationObserver === "function") {
      // Styles added later (dev servers inject them from script) follow too.
      let timer = 0;
      watcher = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(applyScheme, 30);
      });
      watcher.observe(document.documentElement, { childList: true, subtree: true });
    } else if (!scheme && watcher) {
      watcher.disconnect();
      watcher = null;
    }
    return { colorScheme: scheme ?? "auto" };
  };

  // ---- The agent's scripts: REPL semantics, JSON results --------------------------------------

  const asJson = (value, max) => {
    if (value === undefined) return "undefined";
    if (typeof value === "string") return clip(JSON.stringify(value), max);
    if (typeof Node === "function" && value instanceof Node)
      return value.nodeType === 1 ? `${preview(value)} [ref=${refFor(value)}]` : preview(value);
    if (typeof value === "function" || typeof value === "symbol") return preview(value);
    return clip(expand(value), max);
  };
  methods.evalRepl = async (p) => {
    const max = Number(p.maxChars ?? 10000);
    let value;
    try {
      if (p.mode === "async") {
        const AsyncFunction = (async () => {}).constructor;
        let fn = null;
        let lastError = null;
        for (const body of Array.isArray(p.bodies) ? p.bodies : []) {
          try {
            fn = new AsyncFunction(String(body));
            break;
          } catch (err) {
            lastError = err;
          }
        }
        if (!fn) throw lastError || new Error("Nothing to run.");
        value = await fn.call(window);
      } else {
        // Indirect eval (global scope): the last expression's value. The agent's call was approved.
        // biome-ignore lint/security/noGlobalEval: browser_eval is this feature
        const globalEval = window.eval;
        value = globalEval(String(p.code ?? ""));
        if (value && typeof value.then === "function") value = await value;
      }
    } catch (err) {
      throw new Error(
        err instanceof Error ? `${err.name}: ${err.message}` : `Thrown: ${preview(err)}`,
      );
    }
    return {
      type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
      json: asJson(value, max),
    };
  };

  // ---- Files into the page, and where an element is (D339, D340) -----------------------------

  /** The file input an element is (or a label is for), else null: anything else is dropped on. */
  const fileInputOf = (el) => {
    const isFile = (n) => n && n.tagName === "INPUT" && String(n.type).toLowerCase() === "file";
    if (isFile(el)) return el;
    const labelled = el.closest?.("label");
    if (labelled && isFile(labelled.control)) return labelled.control;
    return null;
  };
  /** What a file upload's target is: core/agent/browserUpload.ts planTransfer decides from it. */
  methods["input.fileTarget"] = (p) => {
    const { el } = targetOf(p);
    const input = fileInputOf(el);
    if (input)
      return {
        kind: "input",
        multiple: input.multiple === true,
        accept: input.getAttribute("accept") || "",
        disabled: input.disabled === true,
        label: label(input),
      };
    return { kind: "drop", label: label(el) };
  };
  const bytesOf = (b64) => {
    const bin = atob(String(b64 || ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  /**
   * Files (base64 bytes the IDE read from the workspace) set on a file input through a
   * DataTransfer, with input and change events, or dropped on the element: dragenter, dragover,
   * and drop if the page accepted it (cancelled dragover), as a drop from the desktop goes.
   */
  methods["input.files"] = async (p) => {
    if (typeof DataTransfer !== "function") throw new Error("This page can't take files.");
    const target = targetOf(p);
    const dataTransfer = new DataTransfer();
    for (const f of Array.isArray(p.files) ? p.files : [])
      dataTransfer.items.add(
        new File([bytesOf(f.data)], String(f.name || "file"), {
          type: String(f.type || ""),
          lastModified: Number(f.lastModified) || Date.now(),
        }),
      );
    const names = [...dataTransfer.files].map((f) => f.name);
    if (p.mode === "input") {
      const input = fileInputOf(target.el);
      if (!input) throw new Error(`${label(target.el)} isn't a file input.`);
      input.files = dataTransfer.files;
      input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await settle();
      return { uploaded: names, to: label(input), files: input.files.length, ...page() };
    }
    const { el, cx, cy } = target;
    const init = { dataTransfer };
    moveTo(el, cx, cy, {});
    pointer(el, "dragenter", cx, cy, init);
    const accepted = !pointer(el, "dragover", cx, cy, init);
    if (accepted) pointer(el, "drop", cx, cy, init);
    else pointer(el, "dragleave", cx, cy, init);
    await settle();
    return accepted
      ? { dropped: names, on: label(el), ...page() }
      : {
          dropped: [],
          on: label(el),
          note: "The element didn't accept the drop (no dragover handler cancelled it): try the page's file input or another element.",
        };
  };
  // ---- Trusted input (D346) -----------------------------------------------------------------
  // The IDE sends the events itself through the DevTools protocol (a person's events, isTrusted);
  // the bridge only says where they land (CSS pixels of the viewport), focuses and selects what
  // typing replaces, and reports afterwards.

  const viewport = () => ({ width: innerWidth, height: innerHeight });
  const hasLocator = (p) => !!(p.ref || p.selector || p.name);
  /** What a person's pointer would hit at the element's point, when it isn't the element. */
  const coveredBy = (el, cx, cy) => {
    const top = deepAt(cx, cy);
    return top && top !== el && !el.contains(top) && !top.contains(el) ? label(top) : null;
  };
  methods["input.prepare"] = (p) => {
    const base = { viewport: viewport() };
    switch (p.op) {
      case "click":
      case "hover": {
        const { el, cx, cy } = targetOf(p);
        const covered = hasLocator(p) ? coveredBy(el, cx, cy) : null;
        return { ...base, x: cx, y: cy, target: label(el), ...(covered && { covered }) };
      }
      case "drag": {
        const from =
          p.fromX !== undefined
            ? targetOf(p, "from")
            : targetOf({ ref: p.ref, selector: p.selector, name: p.name });
        const to = toClient(p.x, p.y, p.maxSide);
        const source = from.el;
        const draggable = !!(
          source.closest('[draggable="true"]') ||
          source.tagName === "IMG" ||
          source.closest("a[href]")
        );
        const over = deepAt(to.cx, to.cy);
        return {
          ...base,
          x: from.cx,
          y: from.cy,
          toX: to.cx,
          toY: to.cy,
          target: label(source),
          ...(over && { over: label(over) }),
          draggable,
        };
      }
      case "scroll": {
        const at =
          p.x !== undefined || hasLocator(p)
            ? targetOf(p)
            : { el: document.body, cx: innerWidth / 2, cy: innerHeight / 2 };
        return { ...base, x: at.cx, y: at.cy, target: label(at.el) };
      }
      case "key": {
        if (hasLocator(p)) find(p).focus?.();
        const focused = deepActive();
        return { ...base, focused: focused === document.body ? "page" : label(focused) };
      }
      case "type": {
        if (hasLocator(p)) {
          // Into an element: focused, its text selected so typing replaces it (clear: false
          // keeps it and types at its end), as browser.type does.
          const el = find(p);
          el.scrollIntoView({ block: "center", inline: "center" });
          el.focus?.();
          if (isField(el) && hasSelectionApi(el)) {
            const end = el.value.length;
            el.setSelectionRange(p.clear === false ? end : 0, end);
          } else if (isField(el) && p.clear !== false) el.select?.();
          else if (el.isContentEditable) {
            const range = document.createRange();
            range.selectNodeContents(el);
            if (p.clear === false) range.collapse(false);
            const sel = getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
          }
        }
        const el = deepActive();
        if (!isField(el) && !el.isContentEditable)
          throw new Error(
            `Nothing to type into: the focus is on ${el === document.body ? "the page" : label(el)}. Click a text field first (or type with its ref).`,
          );
        return { ...base, into: label(el) };
      }
      default:
        throw new Error(`Unknown input ${p.op}.`);
    }
  };
  methods["input.report"] = async () => {
    // Trusted input (D346) goes through the browser's input pipeline, which can run after this
    // message: the page handles input before its next frame, so a frame and a task later the
    // handlers have run (a console.error from a click is in the console when the click returns).
    // A hidden page gets no frames: 100 ms at most.
    await new Promise((done) => {
      const timer = setTimeout(done, 100);
      requestAnimationFrame(() =>
        setTimeout(() => {
          clearTimeout(timer);
          done();
        }, 0),
      );
    });
    const focused = deepActive();
    return {
      focused: focused === document.body ? "page" : label(focused),
      ...("value" in focused && isField(focused) && { value: String(focused.value).slice(0, 500) }),
      scrollY: Math.round(scrollY),
      ...page(),
    };
  };

  /** Where an element is in the agent's coordinate frame (scrolled into view, as actions do). */
  methods["input.locate"] = (p) => {
    const { el, cx, cy } = targetOf(p);
    const s = frameScale(p.maxSide);
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(cx * s),
      y: Math.round(cy * s),
      width: Math.round(r.width * s),
      height: Math.round(r.height * s),
    };
  };
})();

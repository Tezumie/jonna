// DevTools half of the browser bridge (concatenated after bridge.js by the Rust side): the DOM
// tree for the Elements panel (nodes by ref, lazy children), highlight and the element picker,
// matched CSS rules and box model, DOM and style edits, storage and cookies, resources for the
// Sources panel, stylesheet hot-swap, and mutation notices. Methods are added to the bridge's
// table; everything returned is page data.
(() => {
  const api = window.__ideBridge?.internal;
  if (!api) return;
  const { methods, send, refFor, find } = api;

  // ---- DOM tree -------------------------------------------------------------------------------

  const nodeById = (id) => {
    if (!id) return document;
    return find({ ref: id });
  };
  const meaningful = (n) =>
    n.nodeType === 1 ||
    n.nodeType === 10 ||
    n.nodeType === 8 ||
    (n.nodeType === 3 && (n.nodeValue || "").trim() !== "");
  const isOurs = (n) => n.nodeType === 1 && n.hasAttribute?.("data-ide-overlay");
  const describeNode = (n) => {
    const base = { id: refFor(n), kind: n.nodeType };
    if (n.nodeType === 1) {
      const children = Array.from(n.childNodes).filter((c) => meaningful(c) && !isOurs(c));
      const onlyText =
        children.length === 1 && children[0].nodeType === 3 && children[0].nodeValue.length <= 80;
      return {
        ...base,
        tag: n.tagName.toLowerCase(),
        attrs: Array.from(n.attributes).map((a) => [a.name, a.value.slice(0, 500)]),
        childCount: onlyText ? 0 : children.length,
        ...(onlyText && { text: children[0].nodeValue.trim() }),
        ...(n.shadowRoot && { shadow: true }),
      };
    }
    if (n.nodeType === 10) return { ...base, text: `<!DOCTYPE ${n.name}>` };
    return { ...base, text: (n.nodeValue || "").trim().slice(0, 500) };
  };
  methods["dom.node"] = ({ id }) => {
    const node = nodeById(id);
    const kids = node === document ? Array.from(document.childNodes) : Array.from(node.childNodes);
    return {
      node: node === document ? { id: "", kind: 9 } : describeNode(node),
      children: kids
        .filter((c) => meaningful(c) && !isOurs(c))
        .slice(0, 500)
        .map(describeNode),
    };
  };
  /** Ancestors of a node, outermost first (to reveal it in the tree). */
  methods["dom.path"] = ({ id }) => {
    const path = [];
    for (let n = nodeById(id); n && n !== document; n = n.parentNode) path.unshift(refFor(n));
    return { path };
  };
  methods["dom.outerHTML"] = ({ id }) => ({ html: api.clip(nodeById(id).outerHTML ?? "", 200000) });
  methods["dom.setOuterHTML"] = ({ id, html }) => {
    const el = nodeById(id);
    const tpl = document.createElement("template");
    tpl.innerHTML = String(html ?? "");
    const first = tpl.content.firstElementChild;
    el.replaceWith(tpl.content);
    return { id: first ? refFor(first) : null };
  };
  methods["dom.setAttribute"] = ({ id, name, value }) => {
    nodeById(id).setAttribute(String(name), String(value ?? ""));
    return { ok: true };
  };
  methods["dom.removeAttribute"] = ({ id, name }) => {
    nodeById(id).removeAttribute(String(name));
    return { ok: true };
  };
  methods["dom.setText"] = ({ id, text }) => {
    const n = nodeById(id);
    if (n.nodeType === 3 || n.nodeType === 8) n.nodeValue = String(text ?? "");
    else n.textContent = String(text ?? "");
    return { ok: true };
  };
  methods["dom.remove"] = ({ id }) => {
    nodeById(id).remove();
    return { ok: true };
  };
  methods["dom.storeGlobal"] = ({ id }) => {
    window.$0 = nodeById(id);
    return { ok: true };
  };
  methods["dom.query"] = ({ selector, limit }) => {
    const all = Array.from(document.querySelectorAll(String(selector))).slice(
      0,
      Number(limit ?? 50),
    );
    return {
      matches: all.map((el) => ({ ...describeNode(el), html: api.clip(el.outerHTML, 300) })),
    };
  };

  /**
   * Elements matching a CSS selector, else whose tag, attributes or own text contain the query
   * (case-insensitive), in document order, with their ref paths for revealing (D146).
   */
  methods["dom.search"] = ({ query, limit }) => {
    const q = String(query || "").trim();
    if (!q) return { matches: [] };
    let found = [];
    try {
      found = Array.from(document.querySelectorAll(q));
    } catch (_) {
      /* not a selector: text */
    }
    if (!found.length) {
      const needle = q.toLowerCase();
      const all = document.getElementsByTagName("*");
      for (const el of all) {
        if (isOurs(el)) continue;
        const own = Array.from(el.childNodes)
          .filter((c) => c.nodeType === 3)
          .map((c) => c.nodeValue)
          .join(" ");
        const attrs = Array.from(el.attributes)
          .map((a) => `${a.name}="${a.value}"`)
          .join(" ");
        if (`<${el.tagName.toLowerCase()} ${attrs}> ${own}`.toLowerCase().includes(needle))
          found.push(el);
      }
    }
    const total = found.length;
    return {
      total,
      matches: found
        .filter((el) => !isOurs(el))
        .slice(0, Number(limit ?? 500))
        .map((el) => {
          const path = [];
          for (let n = el; n && n !== document; n = n.parentNode) path.unshift(refFor(n));
          return { id: refFor(el), path };
        }),
    };
  };

  // Mutations, coalesced: the Elements panel refreshes what it shows.
  let watching = false;
  let mutationTimer = 0;
  const observer = new MutationObserver((records) => {
    if (!watching || records.every((r) => isOurs(r.target))) return;
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => send({ type: "dom" }), 250);
  });
  methods["dom.watch"] = ({ on }) => {
    watching = !!on;
    if (watching)
      observer.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    else observer.disconnect();
    return { watching };
  };

  // ---- Highlight and picker (drawn in a shadow root the page's CSS can't touch) ---------------

  let overlay = null;
  const ensureOverlay = () => {
    if (overlay?.host.isConnected) return overlay;
    const host = document.createElement("div");
    host.setAttribute("data-ide-overlay", "");
    host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      .b{position:fixed;box-sizing:border-box}
      .m{background:rgba(246,178,107,.35)} .p{background:rgba(147,196,125,.4)}
      .c{background:rgba(111,168,220,.5)}
      .l{position:fixed;font:11px/1.4 ui-monospace,Menlo,Consolas,monospace;background:#1e1e1e;color:#eee;
         padding:2px 6px;border-radius:3px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.4)}
      .l i{color:#9cdcfe;font-style:normal} .l b{color:#ce9178;font-weight:normal} .l s{color:#aaa;text-decoration:none}
    </style><div class="b m"></div><div class="b p"></div><div class="b c"></div><div class="l"></div>`;
    (document.body || document.documentElement).appendChild(host);
    const [m, p, c, l] = Array.from(root.querySelectorAll("div"));
    overlay = { host, m, p, c, l };
    return overlay;
  };
  const place = (box, x, y, w, h) => {
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
    box.style.width = `${Math.max(0, w)}px`;
    box.style.height = `${Math.max(0, h)}px`;
  };
  const px = (v) => Number.parseFloat(v) || 0;
  const highlight = (el) => {
    if (el?.nodeType !== 1) {
      if (overlay) overlay.host.style.display = "none";
      return;
    }
    const o = ensureOverlay();
    o.host.style.display = "";
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    const mt = px(s.marginTop),
      mr = px(s.marginRight),
      mb = px(s.marginBottom),
      ml = px(s.marginLeft);
    const bt = px(s.borderTopWidth),
      br = px(s.borderRightWidth),
      bb = px(s.borderBottomWidth),
      bl = px(s.borderLeftWidth);
    const pt = px(s.paddingTop),
      pr = px(s.paddingRight),
      pb = px(s.paddingBottom),
      pl = px(s.paddingLeft);
    place(o.m, r.left - ml, r.top - mt, r.width + ml + mr, r.height + mt + mb);
    place(o.p, r.left + bl, r.top + bt, r.width - bl - br, r.height - bt - bb);
    place(
      o.c,
      r.left + bl + pl,
      r.top + bt + pt,
      r.width - bl - br - pl - pr,
      r.height - bt - bb - pt - pb,
    );
    const id = el.id ? `#${el.id}` : "";
    const cls = el.classList.length ? `.${Array.from(el.classList).slice(0, 3).join(".")}` : "";
    o.l.innerHTML = "";
    const tag = document.createElement("i");
    tag.textContent = el.tagName.toLowerCase();
    const more = document.createElement("b");
    more.textContent = id + cls;
    const size = document.createElement("s");
    size.textContent = `  ${Math.round(r.width)} × ${Math.round(r.height)}`;
    o.l.append(tag, more, size);
    const top = r.top - mt - 22;
    o.l.style.left = `${Math.max(2, Math.min(r.left, innerWidth - 220))}px`;
    o.l.style.top = `${top > 2 ? top : Math.min(innerHeight - 22, r.bottom + mb + 4)}px`;
  };
  methods["dom.highlight"] = ({ id }) => {
    highlight(id ? nodeById(id) : null);
    return { ok: true };
  };

  let picking = null;
  const stopPicking = () => {
    if (!picking) return;
    for (const [type, fn] of picking) window.removeEventListener(type, fn, true);
    picking = null;
    highlight(null);
  };
  methods["dom.pick"] = ({ on }) => {
    stopPicking();
    if (!on) return { picking: false };
    const target = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      return el && !isOurs(el) ? el : null;
    };
    const swallow = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    picking = [
      [
        "mousemove",
        (e) => {
          const el = target(e);
          highlight(el);
          if (el) send({ type: "pickHover", id: refFor(el) });
        },
      ],
      [
        "click",
        (e) => {
          swallow(e);
          const el = target(e);
          stopPicking();
          if (!el) return;
          const path = [];
          for (let n = el; n && n !== document; n = n.parentNode) path.unshift(refFor(n));
          send({ type: "picked", id: refFor(el), path });
        },
      ],
      ["mousedown", swallow],
      ["mouseup", swallow],
      ["pointerdown", swallow],
      [
        "keydown",
        (e) => {
          if (e.key !== "Escape") return;
          swallow(e);
          stopPicking();
          send({ type: "picked", id: null, path: [] });
        },
      ],
    ];
    for (const [type, fn] of picking) window.addEventListener(type, fn, true);
    return { picking: true };
  };

  // ---- Styles ---------------------------------------------------------------------------------

  // Rules get stable ids so the Styles pane can edit them; properties switched off (the
  // checkboxes, D146) are remembered per declaration block to switch back on, in place.
  const ruleIds = new WeakMap();
  const rulesById = new Map();
  let nextRuleId = 1;
  const ruleId = (rule) => {
    let id = ruleIds.get(rule);
    if (!id) {
      id = `r${nextRuleId++}`;
      ruleIds.set(rule, id);
      rulesById.set(id, new WeakRef(rule));
    }
    return id;
  };
  const disabledProps = new WeakMap();
  const disabledOf = (style) => {
    let map = disabledProps.get(style);
    if (!map) {
      map = new Map();
      disabledProps.set(style, map);
    }
    return map;
  };
  /** [name, value, important, enabled] in written order, switched-off ones where they were. */
  const ruleProps = (style) => {
    const out = [];
    for (let i = 0; i < style.length; i++) {
      const name = style[i];
      out.push([
        name,
        style.getPropertyValue(name),
        style.getPropertyPriority(name) === "important",
        true,
      ]);
    }
    for (const [name, d] of disabledOf(style))
      out.splice(Math.min(d.index, out.length), 0, [name, d.value, d.important, false]);
    return out;
  };
  /** The declaration block to edit: the element's inline style, or a rule by id. */
  const declarations = (id, rule) => {
    if (!rule || rule === "inline") return nodeById(id).style;
    const r = rulesById.get(String(rule))?.deref();
    if (!r?.style) throw new Error("That rule is gone (the stylesheet changed); refresh.");
    return r.style;
  };
  const setDecl = (style, name, value) => {
    const v = String(value ?? "");
    if (!v.trim()) style.removeProperty(name);
    else
      style.setProperty(
        name,
        v.replace(/\s*!important\s*$/, ""),
        /!important\s*$/.test(v) ? "important" : "",
      );
  };
  const sheetName = (sheet) => {
    if (!sheet) return "";
    if (sheet.href) return sheet.href;
    const owner = sheet.ownerNode;
    return owner ? `<${owner.tagName.toLowerCase()}>` : "";
  };
  /** Specificity [ids, classes/attributes/pseudo-classes, types] of a selector (approximate). */
  const specificity = (selector) => {
    const s = selector
      .replace(/"[^"]*"|'[^']*'/g, "")
      .replace(/:where\([^()]*\)/g, "")
      .replace(/:(?:not|is|has)\(([^()]*)\)/g, " $1 ");
    const ids = (s.match(/#[\w-]+/g) || []).length;
    const classes = (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+(?:\([^)]*\))?/g) || []).length;
    const types =
      (s.match(/(?:^|[\s>+~(,])[a-zA-Z][\w-]*/g) || []).length +
      (s.match(/::[\w-]+/g) || []).length;
    return [ids, classes, types];
  };
  /** The highest specificity among the parts of a selector list that match `el`. */
  const matchedSpecificity = (el, selectorText) => {
    let best = [0, 0, 0];
    for (const part of selectorText.split(/,(?![^(]*\))/)) {
      let ok = false;
      try {
        ok = el.matches(part);
      } catch (_) {
        /* unknown selector */
      }
      if (!ok) continue;
      const sp = specificity(part.trim());
      for (let i = 0; i < 3; i++) {
        if (sp[i] > best[i]) {
          best = sp;
          break;
        }
        if (sp[i] < best[i]) break;
      }
    }
    return best;
  };
  const collectRules = (el, list, out, sheet) => {
    for (const rule of Array.from(list)) {
      if (rule.cssRules && !rule.selectorText) {
        // @media / @supports / @layer: only applying ones.
        if (rule.media && !matchMedia(rule.media.mediaText).matches) continue;
        collectRules(el, rule.cssRules, out, sheet);
        continue;
      }
      if (!rule.selectorText) continue;
      let matches = false;
      try {
        matches = el.matches(rule.selectorText);
      } catch (_) {
        /* selectors this engine doesn't know */
      }
      if (matches)
        out.push({
          id: ruleId(rule),
          specificity: matchedSpecificity(el, rule.selectorText),
          order: out.length,
          selector: rule.selectorText,
          source: sheetName(sheet),
          props: ruleProps(rule.style),
        });
    }
  };
  methods["dom.styles"] = ({ id }) => {
    const el = nodeById(id);
    if (el.nodeType !== 1) throw new Error("Not an element.");
    const rules = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let list = null;
      try {
        list = sheet.cssRules;
      } catch (_) {
        rules.push({
          selector: "(rules not readable: other origin)",
          source: sheetName(sheet),
          props: [],
        });
        continue;
      }
      if (list) collectRules(el, list, rules, sheet);
    }
    const s = getComputedStyle(el);
    const box = (side) =>
      ["Top", "Right", "Bottom", "Left"].map(
        (d) => s[`${side}${d}${side === "border" ? "Width" : ""}`],
      );
    const r = el.getBoundingClientRect();
    const computed = [];
    for (let i = 0; i < s.length; i++) computed.push([s[i], s.getPropertyValue(s[i])]);
    return {
      inline: ruleProps(el.style),
      rules: rules.reverse(),
      computed,
      box: {
        width: Math.round(r.width * 100) / 100,
        height: Math.round(r.height * 100) / 100,
        margin: box("margin"),
        border: box("border"),
        padding: box("padding"),
        position: s.position,
        display: s.display,
      },
    };
  };
  /** Sets (empty: removes) a property of the inline style or of rule `rule`. */
  methods["css.set"] = ({ id, rule, name, value }) => {
    const style = declarations(id, rule);
    disabledOf(style).delete(String(name));
    setDecl(style, String(name), value);
    return { ok: true };
  };
  /** Renames a property (keeps its value unless one is given). */
  methods["css.rename"] = ({ id, rule, from, to, value }) => {
    const style = declarations(id, rule);
    const old = style.getPropertyValue(String(from));
    const important = style.getPropertyPriority(String(from)) === "important";
    style.removeProperty(String(from));
    disabledOf(style).delete(String(from));
    if (String(to).trim())
      setDecl(style, String(to).trim(), value ?? `${old}${important ? " !important" : ""}`);
    return { ok: true };
  };
  /** Switches a property off (remembered, so it comes back in place) or back on. */
  methods["css.toggle"] = ({ id, rule, name, enabled }) => {
    const style = declarations(id, rule);
    const map = disabledOf(style);
    const key = String(name);
    if (enabled) {
      const d = map.get(key);
      if (d) {
        map.delete(key);
        setDecl(style, key, `${d.value}${d.important ? " !important" : ""}`);
      }
    } else if (!map.has(key)) {
      let index = 0;
      for (let i = 0; i < style.length; i++) if (style[i] === key) index = i;
      map.set(key, {
        value: style.getPropertyValue(key),
        important: style.getPropertyPriority(key) === "important",
        index,
      });
      style.removeProperty(key);
    }
    return { ok: true };
  };
  methods["dom.setStyle"] = ({ id, name, value }) => {
    const el = nodeById(id);
    if (value === null || value === undefined || value === "")
      el.style.removeProperty(String(name));
    else
      el.style.setProperty(
        String(name),
        String(value).replace(/\s*!important\s*$/, ""),
        /!important\s*$/.test(String(value)) ? "important" : "",
      );
    return { ok: true };
  };

  // ---- Storage and cookies --------------------------------------------------------------------

  const areaOf = (area) => (area === "session" ? sessionStorage : localStorage);
  const entries = (store) => {
    const out = [];
    try {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        out.push([k, api.clip(store.getItem(k) ?? "", 20000)]);
      }
    } catch (_) {
      /* storage blocked */
    }
    return out;
  };
  methods["storage.list"] = () => ({
    origin: location.origin,
    local: entries(localStorage),
    session: entries(sessionStorage),
    cookies: document.cookie
      ? document.cookie.split(/;\s*/).map((c) => {
          const i = c.indexOf("=");
          return i < 0 ? [c, ""] : [decodeURIComponent(c.slice(0, i)), c.slice(i + 1)];
        })
      : [],
  });
  methods["storage.set"] = ({ area, key, value }) => {
    if (area === "cookie")
      // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API isn't in WebKit
      document.cookie = `${encodeURIComponent(String(key))}=${String(value ?? "")}; path=/`;
    else areaOf(area).setItem(String(key), String(value ?? ""));
    return { ok: true };
  };
  methods["storage.remove"] = ({ area, key }) => {
    if (area === "cookie")
      // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API isn't in WebKit
      document.cookie = `${encodeURIComponent(String(key))}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    else areaOf(area).removeItem(String(key));
    return { ok: true };
  };
  const expire = (name) => {
    // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API isn't in WebKit
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  };
  methods["storage.clear"] = ({ area }) => {
    if (area === "cookie" || area === "all")
      for (const c of document.cookie.split(/;\s*/).filter(Boolean)) expire(c.split("=")[0]);
    if (area === "local" || area === "all") localStorage.clear();
    if (area === "session" || area === "all") sessionStorage.clear();
    return { ok: true };
  };

  // ---- Resources (Sources panel), fetch, stylesheet hot-swap ----------------------------------

  methods.resources = () => {
    const seen = new Map();
    const add = (url, type, extra = {}) => {
      if (!url || url.startsWith("data:") || url.includes("/__ide/")) return;
      const abs = new URL(url, location.href).href;
      if (!seen.has(abs)) seen.set(abs, { url: abs, type, ...extra });
    };
    add(location.href, "document");
    for (const s of Array.from(document.scripts)) {
      if (s.src) add(s.src, "script");
      else if (s.textContent.trim())
        seen.set(`inline:${seen.size}`, {
          url: `(inline script ${seen.size})`,
          type: "script",
          inline: api.clip(s.textContent, 100000),
        });
    }
    for (const l of Array.from(document.querySelectorAll('link[rel~="stylesheet"]')))
      add(l.href, "stylesheet");
    for (const e of performance.getEntriesByType("resource"))
      add(e.name, e.initiatorType === "link" ? "stylesheet" : e.initiatorType, {
        size: e.encodedBodySize || e.transferSize || 0,
        duration: Math.round(e.duration),
      });
    return { resources: Array.from(seen.values()) };
  };
  methods.fetchText = async ({ url }) => {
    const target = new URL(String(url), location.href);
    if (target.origin !== location.origin)
      throw new Error("Only same-origin resources can be read.");
    const r = await fetch(target.href, { cache: "no-store" });
    return {
      status: r.status,
      type: r.headers.get("content-type") || "",
      text: api.clip(await r.text(), 2000000),
    };
  };
  methods.reloadCss = () => {
    let n = 0;
    for (const l of Array.from(document.querySelectorAll('link[rel~="stylesheet"]'))) {
      try {
        const u = new URL(l.href);
        if (u.origin !== location.origin) continue;
        u.searchParams.set("ide-reload", String(Date.now()));
        l.href = u.href;
        n++;
      } catch (_) {
        /* not a URL */
      }
    }
    return { reloaded: n };
  };
  // ---- Performance (D146) --------------------------------------------------------------------
  // Page load from the Navigation / Paint Timing APIs, Core Web Vitals where the engine reports
  // them (LCP, CLS and long tasks in Chromium / WebView2; not in WebKit), resources by type, DOM
  // size and memory (Chromium). A recording samples frames per second, long tasks and memory.

  const vitals = { lcp: null, cls: 0, longTasks: [], shifts: [], events: [] };
  let observing = false;
  const observe = () => {
    if (observing || typeof PerformanceObserver === "undefined") return;
    observing = true;
    const types = PerformanceObserver.supportedEntryTypes || [];
    const watch = (type, fn, extra) => {
      if (!types.includes(type)) return;
      try {
        new PerformanceObserver((list) => list.getEntries().forEach(fn)).observe({
          type,
          buffered: true,
          ...extra,
        });
      } catch (_) {
        /* not supported */
      }
    };
    const cap = (list, n) => {
      if (list.length > n) list.shift();
    };
    watch("largest-contentful-paint", (e) => {
      vitals.lcp = Math.round(e.renderTime || e.loadTime || e.startTime);
    });
    watch("layout-shift", (e) => {
      if (e.hadRecentInput) return;
      vitals.cls += e.value;
      vitals.shifts.push({ t: e.startTime, value: e.value });
      cap(vitals.shifts, 500);
    });
    watch("longtask", (e) => {
      vitals.longTasks.push({ start: e.startTime, duration: Math.round(e.duration) });
      cap(vitals.longTasks, 1000);
    });
    // Interactions (Event Timing): clicks, keys, pointers that took a frame or more.
    watch(
      "event",
      (e) => {
        if (!e.interactionId && !/^(click|key|pointer|mouse|touch)/.test(e.name)) return;
        vitals.events.push({
          name: e.name,
          start: e.startTime,
          duration: Math.round(e.duration),
          processing: Math.round(e.processingEnd - e.processingStart),
          target: describeTarget(e.target),
        });
        cap(vitals.events, 1000);
      },
      { durationThreshold: 16 },
    );
    vitals.supported = {
      lcp: types.includes("largest-contentful-paint"),
      cls: types.includes("layout-shift"),
      longTasks: types.includes("longtask"),
      interactions: types.includes("event"),
    };
  };
  const describeTarget = (el) => {
    if (el?.nodeType !== 1) return "";
    const id = el.id ? `#${el.id}` : "";
    const cls =
      !id && typeof el.className === "string" && el.className.trim()
        ? `.${el.className.trim().split(/\s+/)[0]}`
        : "";
    return el.localName + id + cls;
  };
  // Long tasks, layout shifts and slow interactions are only reported to observers: watch from
  // the start so a reload-and-record sees the load's.
  observe();
  const memory = () => {
    const m = performance.memory;
    return m
      ? { used: m.usedJSHeapSize, total: m.totalJSHeapSize, limit: m.jsHeapSizeLimit }
      : null;
  };
  methods["perf.summary"] = () => {
    observe();
    const nav = performance.getEntriesByType("navigation")[0];
    const paint = Object.fromEntries(
      performance.getEntriesByType("paint").map((p) => [p.name, Math.round(p.startTime)]),
    );
    const byType = {};
    let bytes = 0;
    const resources = performance
      .getEntriesByType("resource")
      .filter((r) => !r.name.includes("/__ide/"));
    for (const r of resources) {
      const type = r.initiatorType || "other";
      const size = r.transferSize || r.encodedBodySize || 0;
      if (!byType[type]) byType[type] = { count: 0, bytes: 0, time: 0 };
      const t = byType[type];
      t.count++;
      t.bytes += size;
      t.time = Math.max(t.time, Math.round(r.responseEnd));
      bytes += size;
    }
    const slowest = [...resources]
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 8)
      .map((r) => ({
        url: r.name,
        type: r.initiatorType,
        duration: Math.round(r.duration),
        size: r.transferSize || r.encodedBodySize || 0,
      }));
    let depth = 0;
    const walk = (el, d) => {
      if (d > depth) depth = d;
      for (const c of el.children) walk(c, d + 1);
    };
    if (document.documentElement) walk(document.documentElement, 1);
    return {
      url: location.href,
      navigation: nav
        ? {
            ttfb: Math.round(nav.responseStart - nav.startTime),
            domInteractive: Math.round(nav.domInteractive),
            domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
            load: Math.round(nav.loadEventEnd),
            transfer: nav.transferSize || 0,
            type: nav.type,
          }
        : null,
      fcp: paint["first-contentful-paint"] ?? null,
      fp: paint["first-paint"] ?? null,
      lcp: vitals.lcp,
      cls: Math.round(vitals.cls * 1000) / 1000,
      supported: vitals.supported || {},
      longTasks: {
        count: vitals.longTasks.length,
        blocking: vitals.longTasks.reduce((sum, t) => sum + Math.max(0, t.duration - 50), 0),
      },
      resources: { count: resources.length, bytes, byType },
      slowest,
      dom: { nodes: document.getElementsByTagName("*").length, depth },
      memory: memory(),
    };
  };

  // A recording: frame by frame (requestAnimationFrame), a sample every 250 ms (frames per
  // second, JavaScript heap, DOM nodes), and on stop everything the page's timeline holds for
  // the same span — requests, long tasks, interactions, layout shifts, paint and load markers,
  // the page's own performance.mark / measure. `fromNavigation` starts it at the document's
  // start (reload and record: the bridge connects after the load began).
  let recording = null;
  methods["perf.record"] = ({ on, peek, fromNavigation }) => {
    observe();
    if (peek) {
      const r = recording;
      const last = r?.samples.at(-1);
      return r
        ? {
            recording: true,
            elapsed: Math.round(performance.now() - r.start),
            fps: last?.fps ?? null,
            heap: last?.heap ?? null,
            fromNavigation: r.fromNavigation,
            origin: performance.timeOrigin,
          }
        : { recording: false, origin: performance.timeOrigin };
    }
    if (on) {
      if (recording) cancelAnimationFrame(recording.frame);
      const now = performance.now();
      const start = fromNavigation ? 0 : now;
      recording = {
        start,
        fromNavigation: !!fromNavigation,
        samples: [],
        frames: [],
        count: 0,
        bucket: now,
        last: 0,
        frame: 0,
      };
      const nodes = document.getElementsByTagName("*");
      const tick = (t) => {
        const r = recording;
        if (!r) return;
        if (r.frames.length < 20000) r.frames.push(Math.round((t - r.start) * 10) / 10);
        r.count++;
        if (t - r.bucket >= 250) {
          const m = memory();
          r.samples.push({
            t: Math.round(t - r.start),
            fps: Math.round((r.count * 1000) / (t - r.bucket)),
            nodes: nodes.length,
            ...(m && { heap: m.used }),
          });
          r.count = 0;
          r.bucket = t;
          if (r.samples.length > 2400) r.samples.shift();
        }
        r.frame = requestAnimationFrame(tick);
      };
      recording.frame = requestAnimationFrame(tick);
      return { recording: true };
    }
    const r = recording;
    recording = null;
    if (!r) return { recording: false, samples: [], frames: [], longTasks: [], duration: 0 };
    cancelAnimationFrame(r.frame);
    const end = performance.now();
    const rel = (t) => Math.round((t - r.start) * 10) / 10;
    const inside = (t) => t >= r.start && t <= end;
    const markers = [];
    const nav = performance.getEntriesByType("navigation")[0];
    const mark = (name, label, t) => {
      if (t > 0 && inside(t)) markers.push({ name, label, t: rel(t) });
    };
    for (const p of performance.getEntriesByType("paint"))
      mark(
        p.name === "first-paint" ? "FP" : "FCP",
        p.name === "first-paint" ? "First paint" : "First contentful paint",
        p.startTime,
      );
    if (vitals.lcp) mark("LCP", "Largest contentful paint", vitals.lcp);
    if (nav) {
      mark("DCL", "DOMContentLoaded", nav.domContentLoadedEventEnd);
      mark("L", "Load", nav.loadEventEnd);
    }
    const requests = [];
    if (nav && inside(nav.startTime))
      requests.push({
        url: location.href,
        type: "document",
        start: rel(nav.startTime),
        end: rel(nav.responseEnd),
        size: nav.transferSize || 0,
      });
    for (const e of performance.getEntriesByType("resource")) {
      if (e.name.includes("/__ide/") || !inside(e.startTime)) continue;
      requests.push({
        url: e.name,
        type: e.initiatorType || "other",
        start: rel(e.startTime),
        end: rel(Math.max(e.responseEnd, e.startTime)),
        size: e.transferSize || e.encodedBodySize || 0,
      });
      if (requests.length >= 400) break;
    }
    const timings = [];
    for (const e of performance.getEntriesByType("mark"))
      if (inside(e.startTime)) timings.push({ name: e.name, start: rel(e.startTime), duration: 0 });
    for (const e of performance.getEntriesByType("measure"))
      if (inside(e.startTime))
        timings.push({ name: e.name, start: rel(e.startTime), duration: Math.round(e.duration) });
    return {
      recording: false,
      duration: Math.round(end - r.start),
      fromNavigation: r.fromNavigation,
      url: location.href,
      samples: r.samples,
      frames: r.frames,
      longTasks: vitals.longTasks
        .filter((t) => inside(t.start))
        .map((t) => ({ start: rel(t.start), duration: t.duration })),
      interactions: vitals.events
        .filter((e) => inside(e.start))
        .map((e) => ({ ...e, start: rel(e.start) })),
      shifts: vitals.shifts
        .filter((s) => inside(s.t))
        .map((s) => ({ t: rel(s.t), value: Math.round(s.value * 10000) / 10000 })),
      markers,
      requests,
      timings: timings.slice(0, 200),
      supported: { ...(vitals.supported || {}), memory: !!memory() },
    };
  };
  // ---- IndexedDB, Cache storage, service workers (Application, D146) --------------------------

  const openDb = (name) =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(String(name));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("Couldn't open the database."));
      // It didn't exist (listed a moment ago, deleted since): don't create it.
      req.onupgradeneeded = () => {
        req.transaction?.abort();
        reject(new Error("That database is gone."));
      };
    });
  const done = (req) =>
    new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const preview = (v) => {
    try {
      return api.clip(JSON.stringify(v) ?? String(v), 2000);
    } catch (_) {
      return api.clip(String(v), 2000);
    }
  };
  methods["app.indexedDB"] = async () => {
    if (typeof indexedDB === "undefined" || !indexedDB.databases)
      return { databases: [], supported: false };
    const out = [];
    for (const info of await indexedDB.databases()) {
      if (!info.name) continue;
      const entry = { name: info.name, version: info.version, stores: [] };
      try {
        const db = await openDb(info.name);
        for (const storeName of Array.from(db.objectStoreNames)) {
          const tx = db.transaction(storeName, "readonly");
          const store = tx.objectStore(storeName);
          entry.stores.push({
            name: storeName,
            keyPath: store.keyPath === null ? null : String(store.keyPath),
            count: await done(store.count()),
          });
        }
        db.close();
      } catch (e) {
        entry.error = String(e?.message || e);
      }
      out.push(entry);
    }
    return { databases: out, supported: true };
  };
  methods["app.indexedDBEntries"] = async ({ db: name, store: storeName, limit }) => {
    const db = await openDb(name);
    try {
      const store = db.transaction(String(storeName), "readonly").objectStore(String(storeName));
      const entries = [];
      await new Promise((resolve, reject) => {
        const req = store.openCursor();
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const c = req.result;
          if (!c || entries.length >= Number(limit ?? 200)) return resolve();
          entries.push([preview(c.key), preview(c.value)]);
          c.continue();
        };
      });
      return { entries };
    } finally {
      db.close();
    }
  };
  methods["app.deleteDatabase"] = ({ name }) =>
    new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(String(name));
      req.onsuccess = () => resolve({ ok: true });
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve({ ok: true, blocked: true });
    });
  methods["app.caches"] = async () => {
    if (typeof caches === "undefined") return { caches: [], supported: false };
    const out = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      out.push({ name, count: (await cache.keys()).length });
    }
    return { caches: out, supported: true };
  };
  methods["app.cacheEntries"] = async ({ name, limit }) => {
    const cache = await caches.open(String(name));
    const keys = (await cache.keys()).slice(0, Number(limit ?? 300));
    const entries = [];
    for (const req of keys) {
      const res = await cache.match(req);
      entries.push([
        req.url,
        res ? `${res.status} · ${res.headers.get("content-type") || ""}` : "",
      ]);
    }
    return { entries };
  };
  methods["app.deleteCache"] = async ({ name }) => ({ ok: await caches.delete(String(name)) });
  methods["app.serviceWorkers"] = async () => {
    if (!navigator.serviceWorker?.getRegistrations) return { workers: [], supported: false };
    const regs = await navigator.serviceWorker.getRegistrations();
    return {
      supported: true,
      workers: regs.map((r) => {
        const w = r.active || r.waiting || r.installing;
        return { scope: r.scope, state: w?.state || "none", script: w?.scriptURL || "" };
      }),
    };
  };
  methods["app.unregisterWorker"] = async ({ scope }) => {
    const regs = await navigator.serviceWorker.getRegistrations();
    const r = regs.find((x) => x.scope === scope);
    return { ok: r ? await r.unregister() : false };
  };
})();

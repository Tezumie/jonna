// The browser bridge (PLAN §8.5): injected into every HTML page served by the preview proxy
// (`<script src="/__ide/bridge.js">`) and, for external sites, run as the window's initialization
// script. It reports what the page does (navigation, console, errors, failed requests) and carries
// out the host's calls (snapshot, click, type, press, select, scroll, text, wait, eval).
//
// Frame mode: messages go to the IDE (the parent window) with postMessage; the host's origin is
// learned from its first message. External mode: messages go through one Tauri command,
// `browser_bridge_post`; calls arrive through `window.__ideBridge.receive`. Everything sent is
// page data — the IDE treats it as untrusted.
(() => {
  if (window.__ideBridge) return;
  const MODE = window.__IDE_BRIDGE_MODE__ === "external" ? "external" : "frame";
  if (MODE === "external" && window.top !== window) return;
  if (MODE === "frame" && window.parent === window) {
    // A preview opened in an outside browser (D284): no IDE around it, so it waits on the proxy's
    // change counter and reloads when a file changes, as Live Server's pages do. Only static
    // previews answer (a dev server has its own reload): anything but 200 ends the wait.
    let since = null;
    const wait = () =>
      fetch(`/__ide/live${since === null ? "" : `?since=${since}`}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
        .then((text) => {
          const n = Number(text);
          if (since !== null && n !== since) return location.reload();
          since = n;
          wait();
        })
        // The IDE closed or restarted: try again a little later.
        .catch((status) => typeof status !== "number" && setTimeout(wait, 2000));
    wait();
    return;
  }

  const NS = "ide-bridge";
  const MAX_TEXT = 2000;
  let hostOrigin = null;
  const queue = [];

  const send = (msg) => {
    msg.ns = NS;
    if (MODE === "external") {
      // In the user's own browser (D341) the IDE listens through a DevTools protocol binding.
      const post = window.__IDE_BRIDGE_POST__;
      if (typeof post === "string" && typeof window[post] === "function") {
        try {
          window[post](JSON.stringify(msg));
        } catch (_) {
          /* not serializable: dropped */
        }
        return;
      }
      try {
        window.__TAURI_INTERNALS__.invoke("browser_bridge_post", { message: msg });
      } catch (_) {
        /* not allowed here */
      }
      return;
    }
    if (hostOrigin === null) {
      if (queue.length < 200) queue.push(msg);
      return;
    }
    window.parent.postMessage(msg, hostOrigin);
  };

  const clip = (text, max = MAX_TEXT) =>
    text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text;

  const describe = (value) => {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (typeof value === "string") return value;
    try {
      const json = JSON.stringify(value);
      return json === undefined ? String(value) : json;
    } catch (_) {
      return String(value);
    }
  };

  // ---- Reporting ------------------------------------------------------------------------------

  const page = () => ({ url: location.href, title: document.title });
  // The proxy's pages a tab only passes through: a redirect's goto page, and the page a form
  // posted into a new tab is sent from (links.js). They never count as the tab's page.
  const passing = () =>
    location.hostname === "127.0.0.1" &&
    (location.pathname === "/__ide/goto" || location.pathname === "/__ide/post");
  const loaded = () => document.readyState !== "loading";
  let lastNav = "";
  const nav = () => {
    if (passing()) return; // passed through (see "hello")
    const p = page();
    const key = `${p.url}\n${p.title}`;
    if (key === lastNav) return;
    lastNav = key;
    send({ type: "nav", ...p });
  };

  // Console values as DevTools shows them: a one-line preview, an expandable JSON view for
  // objects, and a ref for elements (click to reveal in the Elements panel).
  const preview = (v, depth = 0) => {
    if (v === null) return "null";
    if (v === undefined) return "undefined";
    const t = typeof v;
    if (t === "string")
      return depth ? JSON.stringify(v.length > 200 ? `${v.slice(0, 200)}…` : v) : v;
    if (t === "number" || t === "boolean" || t === "bigint") return String(v);
    if (t === "symbol") return v.toString();
    if (t === "function") return `ƒ ${v.name || "anonymous"}()`;
    if (v instanceof Error)
      return depth ? `${v.name}: ${v.message}` : v.stack || `${v.name}: ${v.message}`;
    if (typeof Node === "function" && v instanceof Node) {
      if (v.nodeType === 1) {
        const id = v.id ? `#${v.id}` : "";
        const cls = v.classList?.length ? `.${Array.from(v.classList).slice(0, 3).join(".")}` : "";
        return `${v.tagName.toLowerCase()}${id}${cls}`;
      }
      return v.nodeType === 3
        ? `#text ${JSON.stringify((v.nodeValue || "").slice(0, 60))}`
        : v.nodeName;
    }
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? "Invalid Date" : v.toISOString();
    if (v instanceof RegExp) return String(v);
    if (typeof Promise === "function" && v instanceof Promise) return "Promise {…}";
    if (depth > 1) return Array.isArray(v) ? `Array(${v.length})` : "{…}";
    if (Array.isArray(v)) {
      const items = v.slice(0, 20).map((x) => preview(x, depth + 1));
      return `(${v.length}) [${items.join(", ")}${v.length > 20 ? ", …" : ""}]`;
    }
    if (v instanceof Map || v instanceof Set) {
      const kind = v instanceof Map ? "Map" : "Set";
      const items = Array.from(v.entries())
        .slice(0, 10)
        .map(([k, x]) =>
          kind === "Map"
            ? `${preview(k, depth + 1)} => ${preview(x, depth + 1)}`
            : preview(x, depth + 1),
        );
      return `${kind}(${v.size}) {${items.join(", ")}${v.size > 10 ? ", …" : ""}}`;
    }
    let keys = [];
    try {
      keys = Object.keys(v);
    } catch (_) {
      return "{…}";
    }
    const name = v.constructor && v.constructor.name !== "Object" ? `${v.constructor.name} ` : "";
    const body = keys.slice(0, 12).map((k) => {
      let x;
      try {
        x = v[k];
      } catch (_) {
        x = "(?)";
      }
      return `${k}: ${preview(x, depth + 1)}`;
    });
    return `${name}{${body.join(", ")}${keys.length > 12 ? ", …" : ""}}`;
  };
  /** Pretty JSON for expanding an object (cycles and DOM nodes shown as previews). */
  const expand = (v) => {
    const seen = new WeakSet();
    try {
      return clip(
        JSON.stringify(
          v,
          (_k, x) => {
            if (typeof x === "bigint") return `${x}n`;
            if (typeof x === "function") return preview(x);
            if (typeof Node === "function" && x instanceof Node) return preview(x);
            if (x instanceof Map) return Object.fromEntries(Array.from(x.entries()).slice(0, 200));
            if (x instanceof Set) return Array.from(x).slice(0, 200);
            if (x instanceof Error) return { name: x.name, message: x.message, stack: x.stack };
            if (x && typeof x === "object") {
              if (seen.has(x)) return "[Circular]";
              seen.add(x);
            }
            return x;
          },
          2,
        ) ?? "undefined",
        20000,
      );
    } catch (_) {
      return preview(v);
    }
  };
  const arg = (v) => {
    const out = { text: clip(preview(v), 4000), kind: v === null ? "null" : typeof v };
    if (typeof Node === "function" && v instanceof Node) out.ref = refFor(v);
    else if (v && typeof v === "object" && !(v instanceof Error)) out.json = expand(v);
    return out;
  };
  const report = (level, args, extra = {}) => {
    try {
      const list = args.slice(0, 20).map(arg);
      send({
        type: "console",
        level,
        text: clip(list.map((a) => a.text).join(" ")),
        args: list,
        time: Date.now(),
        ...extra,
      });
    } catch (_) {
      /* never break the page's console */
    }
  };
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = console[level];
    console[level] = function (...args) {
      report(
        level,
        args,
        level === "error"
          ? { stack: clip(new Error().stack?.split("\n").slice(2).join("\n") ?? "", 3000) }
          : {},
      );
      return original.apply(this, args);
    };
  }
  const wrap = (name, fn) => {
    const original = console[name];
    console[name] = function (...args) {
      try {
        fn(...args);
      } catch (_) {
        /* ignore */
      }
      return original?.apply(this, args);
    };
  };
  wrap("table", (data) => report("log", [data]));
  wrap("dir", (data) => report("log", [data]));
  wrap("trace", (...args) =>
    report("log", args.length ? args : ["console.trace"], {
      stack: clip(new Error().stack?.split("\n").slice(2).join("\n") ?? "", 3000),
    }),
  );
  wrap("assert", (ok, ...args) => {
    if (!ok) report("error", ["Assertion failed:", ...args]);
  });
  const counts = new Map();
  wrap("count", (label = "default") => {
    const n = (counts.get(label) ?? 0) + 1;
    counts.set(label, n);
    report("info", [`${label}: ${n}`]);
  });
  const timers = new Map();
  wrap("time", (label = "default") => timers.set(label, performance.now()));
  wrap("timeEnd", (label = "default") => {
    const t = timers.get(label);
    if (t === undefined) return;
    timers.delete(label);
    report("info", [`${label}: ${(performance.now() - t).toFixed(1)} ms`]);
  });
  wrap("group", (...args) =>
    report("log", args.length ? args : ["console.group"], { group: "start" }),
  );
  wrap("groupCollapsed", (...args) =>
    report("log", args.length ? args : ["console.group"], { group: "start" }),
  );
  wrap("groupEnd", () =>
    send({ type: "console", level: "log", text: "", args: [], group: "end", time: Date.now() }),
  );
  wrap("clear", () => send({ type: "consoleClear" }));

  window.addEventListener(
    "error",
    (e) => {
      const target = e.target;
      if (target && target !== window && target.tagName) {
        // A resource failed to load (img, script, link).
        const url = target.src || target.href || "";
        send({
          type: "network",
          method: "GET",
          url,
          status: 0,
          error: `${target.tagName.toLowerCase()} failed to load`,
        });
        return;
      }
      send({
        type: "error",
        text: clip(e.error ? describe(e.error) : String(e.message)),
        source: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : "",
        stack: e.error?.stack ? clip(String(e.error.stack), 4000) : "",
        time: Date.now(),
      });
    },
    true,
  );
  window.addEventListener("unhandledrejection", (e) => {
    send({
      type: "error",
      text: clip(`Unhandled rejection: ${describe(e.reason)}`),
      source: "",
      stack: e.reason?.stack ? clip(String(e.reason.stack), 4000) : "",
      time: Date.now(),
    });
  });

  // External windows have no proxy log: the bridge reports requests itself — except its own IPC
  // calls (reporting those would report the report, endlessly) and pages the IDE's proxy serves
  // (a popped-out local page: the proxy already logs every request).
  const proxied = () => !!document.querySelector('script[src="/__ide/bridge.js"]');
  const isIpc = (url) => /^ipc:|^tauri:|\/\/ipc\.localhost\b|__TAURI/.test(url);
  if (MODE === "external" && typeof PerformanceObserver === "function") {
    try {
      new PerformanceObserver((list) => {
        if (proxied()) return;
        for (const e of list.getEntries())
          if (!isIpc(e.name))
            send({
              type: "request",
              url: e.name,
              initiator: e.initiatorType,
              size: e.encodedBodySize || e.transferSize || 0,
              durationMs: Math.round(e.duration),
              status: e.responseStatus || 0,
            });
      }).observe({ type: "resource", buffered: true });
    } catch (_) {
      /* not supported */
    }
  }
  const originalFetch = window.fetch;
  if (originalFetch)
    window.fetch = function (input, init, ...rest) {
      const url = typeof input === "string" ? input : input?.url ? input.url : String(input);
      const method = init?.method || input?.method || "GET";
      return originalFetch.call(this, input, init, ...rest).then(
        (response) => {
          if (response.status >= 400)
            send({ type: "network", method, url: response.url || url, status: response.status });
          return response;
        },
        (err) => {
          send({ type: "network", method, url, status: 0, error: describe(err) });
          throw err;
        },
      );
    };
  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ide = { method, url: String(url) };
    this.addEventListener("loadend", () => {
      if (this.status >= 400 || this.status === 0)
        send({
          type: "network",
          method: this.__ide.method,
          url: this.responseURL || this.__ide.url,
          status: this.status,
          ...(this.status === 0 && { error: "request failed" }),
        });
    });
    return xhrOpen.call(this, method, url, ...rest);
  };

  for (const name of ["pushState", "replaceState"]) {
    const original = history[name];
    history[name] = function (...args) {
      const result = original.apply(this, args);
      setTimeout(nav, 0);
      return result;
    };
  }
  window.addEventListener("pagehide", () => send({ type: "leave" }));
  // The IDE's browser shortcuts work while the page has focus (DevTools, picker, address, reload).
  window.addEventListener(
    "keydown",
    (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const chord =
        e.key === "F12"
          ? "devtools"
          : mod && e.shiftKey && k === "i"
            ? "devtools"
            : mod && e.altKey && k === "i"
              ? "devtools"
              : mod && e.shiftKey && k === "c"
                ? "inspect"
                : mod && !e.shiftKey && k === "l"
                  ? "address"
                  : e.key === "F5" || (mod && !e.shiftKey && k === "r")
                    ? "reload"
                    : null;
      // The user's own browser (D341) keeps its keys.
      if (!chord || typeof window.__IDE_BRIDGE_POST__ === "string") return;
      e.preventDefault();
      e.stopPropagation();
      send({ type: "key", chord });
    },
    true,
  );
  window.addEventListener("popstate", nav);
  window.addEventListener("hashchange", nav);
  window.addEventListener("load", nav);
  document.addEventListener("DOMContentLoaded", () => {
    nav();
    const title = document.querySelector("title");
    if (title)
      new MutationObserver(nav).observe(title, {
        childList: true,
        characterData: true,
        subtree: true,
      });
  });

  // Links, popups and redirects to other origins: links.js (concatenated after this file).

  // ---- Snapshot (an accessibility-style outline with element refs) ----------------------------

  let refSeq = 0;
  const refs = new Map();
  const refOf = new WeakMap();
  const refFor = (el) => {
    let r = refOf.get(el);
    if (!r) {
      r = `e${++refSeq}`;
      refOf.set(el, r);
      refs.set(r, typeof WeakRef === "function" ? new WeakRef(el) : { deref: () => el });
    }
    return r;
  };

  const visible = (el) => {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    if (r.width > 0 || r.height > 0 || s.display === "contents") return true;
    // A tab behind another (its frame hidden, WebView2) lays nothing out: every box is empty, so
    // it's judged by styles up the tree instead (D254).
    const page = document.documentElement.getBoundingClientRect();
    if (page.width > 0 || page.height > 0) return false;
    for (let p = el.parentElement; p; p = p.parentElement)
      if (p.hidden || getComputedStyle(p).display === "none") return false;
    return true;
  };

  const INPUT_ROLES = {
    button: "button",
    submit: "button",
    reset: "button",
    image: "button",
    checkbox: "checkbox",
    radio: "radio",
    range: "slider",
    search: "searchbox",
  };
  const TAG_ROLES = {
    BUTTON: "button",
    SELECT: "combobox",
    TEXTAREA: "textbox",
    NAV: "navigation",
    MAIN: "main",
    HEADER: "banner",
    FOOTER: "contentinfo",
    ASIDE: "complementary",
    FORM: "form",
    UL: "list",
    OL: "list",
    LI: "listitem",
    TABLE: "table",
    TR: "row",
    TH: "columnheader",
    TD: "cell",
    DIALOG: "dialog",
    SUMMARY: "button",
    IMG: "img",
    IFRAME: "iframe",
    VIDEO: "video",
    H1: "heading",
    H2: "heading",
    H3: "heading",
    H4: "heading",
    H5: "heading",
    H6: "heading",
  };
  const role = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(/\s+/)[0];
    if (el.tagName === "A") return el.hasAttribute("href") ? "link" : null;
    if (el.tagName === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "hidden") return null;
      return INPUT_ROLES[type] || "textbox";
    }
    if (el.isContentEditable && el.getAttribute("contenteditable") !== null) return "textbox";
    return TAG_ROLES[el.tagName] || null;
  };
  const INTERACTIVE = new Set([
    "button",
    "link",
    "textbox",
    "searchbox",
    "checkbox",
    "radio",
    "combobox",
    "slider",
    "switch",
    "tab",
    "menuitem",
    "option",
    "listbox",
    "spinbutton",
    "menuitemcheckbox",
    "menuitemradio",
  ]);
  const LEAF = new Set([...INTERACTIVE, "heading", "img", "iframe", "video"]);
  const squash = (t) => t.replace(/\s+/g, " ").trim();

  const nameOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return squash(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const text = by
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText || "")
        .join(" ");
      if (squash(text)) return squash(text);
    }
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label && squash(label.innerText)) return squash(label.innerText);
    }
    const wrap = el.closest("label");
    if (wrap && wrap !== el && squash(wrap.innerText)) return squash(wrap.innerText);
    for (const attr of ["alt", "title", "placeholder"]) {
      const v = el.getAttribute(attr);
      if (v) return squash(v);
    }
    if (el.tagName === "INPUT" && /^(button|submit|reset)$/i.test(el.type))
      return el.value || el.type;
    return squash(el.innerText || el.textContent || "");
  };

  const short = (t, n = 100) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  const quote = (t) => JSON.stringify(short(t));

  const snapshot = ({ maxChars = 12000, ref: rootRef } = {}) => {
    const lines = [];
    let size = 0;
    let truncated = false;
    const push = (line) => {
      if (truncated) return;
      if (size + line.length > maxChars) {
        truncated = true;
        return;
      }
      lines.push(line);
      size += line.length + 1;
    };
    const walk = (node, depth) => {
      for (const child of node.childNodes) {
        if (truncated) return;
        if (child.nodeType === 3) {
          const text = squash(child.nodeValue || "");
          if (text && node.nodeType === 1 && !role(node))
            push(`${"  ".repeat(depth)}- text: ${quote(text)}`);
          continue;
        }
        if (child.nodeType !== 1) continue;
        const el = child;
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|HEAD|META|LINK)$/i.test(el.tagName)) continue;
        if (!visible(el)) continue;
        const r = role(el);
        if (!r) {
          walk(el, depth);
          continue;
        }
        const name = nameOf(el);
        let line = `${"  ".repeat(depth)}- ${r}`;
        if (name && r !== "list" && r !== "table" && r !== "row" && r !== "form")
          line += ` ${quote(name)}`;
        if (r === "heading")
          line += ` [level=${el.tagName.slice(1) || el.getAttribute("aria-level") || "?"}]`;
        if (INTERACTIVE.has(r) || el.hasAttribute("onclick") || el.tabIndex >= 0)
          line += ` [ref=${refFor(el)}]`;
        if (r === "link") line += ` -> ${el.getAttribute("href")}`;
        if ("value" in el && r !== "button" && el.value)
          line += ` value=${quote(String(el.value))}`;
        if (el.checked) line += " [checked]";
        if (el.disabled) line += " [disabled]";
        if (document.activeElement === el) line += " [focused]";
        push(line);
        if (!LEAF.has(r)) walk(el, depth + 1);
      }
    };
    const start = rootRef ? find({ ref: rootRef }) : document.body || document.documentElement;
    if (start) walk(start, 0);
    return {
      ...page(),
      snapshot:
        lines.join("\n") + (truncated ? "\n… (truncated: pass a ref to see part of the page)" : ""),
    };
  };

  // ---- Actions -------------------------------------------------------------------------------

  const find = ({ ref, selector, name }) => {
    if (ref) {
      const el = refs.get(String(ref))?.deref();
      if (!el?.isConnected) throw new Error(`No element ${ref} (take a new snapshot).`);
      return el;
    }
    if (selector) {
      const el = document.querySelector(String(selector));
      if (!el) throw new Error(`Nothing matches ${selector}.`);
      return el;
    }
    if (name) {
      const want = squash(String(name)).toLowerCase();
      const all = Array.from(
        document.querySelectorAll(
          "a,button,input,select,textarea,summary,[role],[onclick],label,[tabindex]",
        ),
      );
      const hit =
        all.find((el) => visible(el) && nameOf(el).toLowerCase() === want) ||
        all.find((el) => visible(el) && nameOf(el).toLowerCase().includes(want));
      if (!hit) throw new Error(`No element named "${name}".`);
      // A label stands for its control.
      return hit.tagName === "LABEL" && hit.control ? hit.control : hit;
    }
    throw new Error("Give a ref (from a snapshot), a selector or a name.");
  };

  const mouse = (el, types) => {
    const r = el.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
    };
    for (const type of types) {
      const Ctor =
        type.startsWith("pointer") && typeof PointerEvent === "function"
          ? PointerEvent
          : MouseEvent;
      el.dispatchEvent(new Ctor(type, init));
    }
  };

  const setValue = (el, value) => {
    if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
      throw new Error(
        `<${el.tagName.toLowerCase()}> isn't a text field (take a snapshot and use a textbox ref).`,
      );
    const proto =
      el.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : el.tagName === "SELECT"
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const key = (el, k) => {
    const init = {
      key: k,
      code: k.length === 1 ? `Key${k.toUpperCase()}` : k,
      bubbles: true,
      cancelable: true,
    };
    const down = el.dispatchEvent(new KeyboardEvent("keydown", init));
    el.dispatchEvent(new KeyboardEvent("keypress", init));
    el.dispatchEvent(new KeyboardEvent("keyup", init));
    if (down && k === "Enter" && el.form && el.tagName === "INPUT") el.form.requestSubmit();
  };

  const settle = () => new Promise((r) => setTimeout(r, 120));

  const methods = {
    info: () => ({
      ...page(),
      readyState: document.readyState,
      scrollY: Math.round(scrollY),
      height: document.documentElement.scrollHeight,
      viewport: { width: innerWidth, height: innerHeight },
    }),
    snapshot,
    click: async (p) => {
      const el = find(p);
      el.scrollIntoView({ block: "center", inline: "center" });
      mouse(el, ["pointerover", "mouseover", "pointerdown", "mousedown"]);
      if (typeof el.focus === "function") el.focus();
      mouse(el, ["pointerup", "mouseup"]);
      el.click();
      await settle();
      return { clicked: nameOf(el) || el.tagName.toLowerCase(), ...page() };
    },
    hover: (p) => {
      const el = find(p);
      el.scrollIntoView({ block: "center" });
      mouse(el, ["pointerover", "pointerenter", "mouseover", "mouseenter", "mousemove"]);
      return { hovered: nameOf(el) };
    },
    type: async (p) => {
      const el = find(p);
      el.focus();
      const text = String(p.text ?? "");
      if (el.isContentEditable) {
        if (p.clear !== false) el.textContent = "";
        document.execCommand("insertText", false, text);
      } else setValue(el, p.clear === false ? `${el.value}${text}` : text);
      if (p.submit) key(el, "Enter");
      await settle();
      return { typed: text.length, value: "value" in el ? String(el.value) : undefined, ...page() };
    },
    press: async (p) => {
      const el = p.ref || p.selector || p.name ? find(p) : document.activeElement || document.body;
      key(el, String(p.key || "Enter"));
      await settle();
      return { pressed: p.key || "Enter", ...page() };
    },
    select: (p) => {
      const el = find(p);
      if (el.tagName !== "SELECT") throw new Error("Not a select element.");
      const want = String(p.value ?? "");
      const option = Array.from(el.options).find(
        (o) => o.value === want || squash(o.text) === want,
      );
      if (!option)
        throw new Error(
          `No option ${want}; options: ${Array.from(el.options)
            .map((o) => o.text)
            .join(", ")}`,
        );
      setValue(el, option.value);
      return { selected: option.text };
    },
    scroll: (p) => {
      if (p.ref || p.selector || p.name) find(p).scrollIntoView({ block: "center" });
      else if (p.to === "top") scrollTo(0, 0);
      else if (p.to === "bottom") scrollTo(0, document.documentElement.scrollHeight);
      else scrollBy(0, Number(p.dy ?? innerHeight * 0.8));
      return { scrollY: Math.round(scrollY), height: document.documentElement.scrollHeight };
    },
    text: (p) => {
      const el = p.ref || p.selector || p.name ? find(p) : document.body;
      return { text: clip(el.innerText || "", Number(p.maxChars ?? 8000)) };
    },
    waitFor: async (p) => {
      const deadline = Date.now() + Math.min(Number(p.timeoutMs ?? 5000), 30000);
      for (;;) {
        const found = p.selector
          ? document.querySelector(String(p.selector))
          : p.text
            ? (document.body.innerText || "").includes(String(p.text))
            : document.readyState === "complete";
        if (found) return { found: true, ...page() };
        if (Date.now() > deadline) return { found: false, ...page() };
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    eval: async (p) => {
      // Indirect eval (global scope); the host asked, and the user approved, this.
      // biome-ignore lint/security/noGlobalEval: browser.eval is this feature
      const globalEval = window.eval;
      let value = globalEval(String(p.code ?? ""));
      if (value && typeof value.then === "function") value = await value;
      return { result: clip(describe(value), 8000) };
    },
    /** Console input: the value's preview (and JSON / element ref to expand it). */
    evaluate: async (p) => {
      // biome-ignore lint/security/noGlobalEval: the console's input line
      const globalEval = window.eval;
      try {
        let value = globalEval(String(p.code ?? ""));
        if (value && typeof value.then === "function") value = await value;
        return { ok: true, ...arg(value) };
      } catch (err) {
        return {
          ok: false,
          text: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        };
      }
    },
    navigate: (p) => {
      const url = new URL(String(p.url), location.href).href;
      // `replace`: the page the IDE moves on from (a redirect's goto page) leaves no history.
      if (p.replace) location.replace(url);
      else location.href = url;
      return { navigating: String(p.url) };
    },
    back: () => {
      // At the first page of this frame's history the tab may still go back (to the local page a
      // link to another site left, D209): say so instead of doing nothing.
      // (The Navigation API's own back() would step only this frame's entries, but it skips
      // other origins' and WebKit refuses it in a frame, so history.back() it is.)
      if (history.length <= 1) return { ok: false, atStart: true };
      history.back();
      return { ok: true };
    },
    forward: () => {
      history.forward();
      return { ok: true };
    },
    reload: () => {
      location.reload();
      return { ok: true };
    },
  };

  const receive = async (msg) => {
    if (msg?.ns !== "ide-host") return;
    if (msg.type === "hello") {
      // The proxy's goto page (a redirect to another origin, links.js) is only passed through:
      // in the frame the IDE replaces it without its help, so it never counts as the page that
      // loaded (an agent waiting for the page gets the one after it).
      if (passing()) {
        send({ type: "ready", loaded: false, passing: true, ...page() });
        return;
      }
      // Ready means the document is parsed (title, body) so snapshots see the page. `doc` tells
      // documents apart (a host may say hello more than once to the same one).
      const doc = performance.timeOrigin;
      if (loaded()) send({ type: "ready", loaded: true, doc, ...page() });
      else
        document.addEventListener("DOMContentLoaded", () =>
          send({ type: "ready", loaded: true, doc, ...page() }),
        );
      return;
    }
    if (msg.type !== "call") return;
    const fn = methods[msg.method];
    try {
      if (!fn) throw new Error(`Unknown bridge method ${msg.method}.`);
      const result = await fn(msg.params || {});
      send({ type: "result", id: msg.id, result });
    } catch (err) {
      send({ type: "result", id: msg.id, error: err instanceof Error ? err.message : String(err) });
    }
  };

  if (MODE === "frame") {
    window.addEventListener("message", (e) => {
      // The host is the parent window — or, when the frame sits in one of the IDE's auxiliary
      // windows, the main window that opened it (its code drives the aux window).
      let opener = null;
      try {
        opener = window.parent.opener;
      } catch (_) {
        /* not readable */
      }
      const fromHost = e.source === window.parent || (opener && e.source === opener);
      if (!fromHost || !e.data || e.data.ns !== "ide-host") return;
      // The host says hello first, and again when the frame moved to another IDE window (an
      // auxiliary window has its own origin): hello (re)binds the origin replies go to.
      if (hostOrigin === null || e.data.type === "hello") {
        hostOrigin = e.origin === "null" ? "*" : e.origin;
        for (const m of queue.splice(0)) window.parent.postMessage(m, hostOrigin);
      } else if (e.origin !== hostOrigin && hostOrigin !== "*") return;
      receive(e.data);
    });
    // Only "I'm here" goes out before the host has said hello; the host answers with hello.
    window.parent.postMessage({ ns: NS, type: "ready", loaded: false, ...page() }, "*");
  }

  // `internal` lets the DevTools half (devtools.js) add methods to this table.
  // Dark pages get dark scrollbars (D119). Chromium/WebKit draw light scrollbars unless the page
  // says `color-scheme: dark` or styles them; most dark pages do neither, so a light bar sat on a
  // dark page. Only when the page's background is dark and it declares no color-scheme, and in a
  // cascade layer, so any ::-webkit-scrollbar rule of the page's own (unlayered) wins over ours.
  const SCROLLBAR_STYLE_ID = "__ide-dark-scrollbars";
  const darkBackground = () => {
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(
        getComputedStyle(el).backgroundColor,
      );
      if (!m || (m[4] !== undefined && Number(m[4]) < 0.5)) continue;
      const [r, g, b] = [m[1], m[2], m[3]].map(Number);
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.35;
    }
    return false; // nothing painted: the default white canvas
  };
  const scrollbars = () => {
    try {
      const root = document.documentElement;
      // Not in the user's own browser (D341): its pages stay as they are.
      if (!root || typeof window.__IDE_BRIDGE_POST__ === "string") return;
      const existing = document.getElementById(SCROLLBAR_STYLE_ID);
      const scheme = getComputedStyle(root).colorScheme;
      const want = !(scheme && scheme !== "normal") && darkBackground();
      // A page that switches theme (a dark-mode toggle) gets its scrollbars switched too.
      if (existing) {
        if (!want) existing.remove();
        return;
      }
      if (!want) return;
      const style = document.createElement("style");
      style.id = SCROLLBAR_STYLE_ID;
      style.setAttribute("data-ide-overlay", ""); // hidden from DevTools' Elements
      style.textContent =
        "@layer ide-defaults{::-webkit-scrollbar{width:10px;height:10px;background:transparent}" +
        "::-webkit-scrollbar-thumb{background:rgba(255,255,255,.18);border-radius:5px;border:2px solid transparent;background-clip:padding-box}" +
        "::-webkit-scrollbar-thumb:hover{background-color:rgba(255,255,255,.3)}" +
        "::-webkit-scrollbar-corner{background:transparent}}";
      (document.head || root).appendChild(style);
    } catch (_) {
      /* a page that blocks this keeps its default scrollbars */
    }
  };
  if (loaded()) scrollbars();
  else document.addEventListener("DOMContentLoaded", scrollbars);
  window.addEventListener("load", scrollbars);
  setTimeout(scrollbars, 1500); // pages that paint their background from script
  let schemeFrame = 0;
  const watchScheme = () => {
    try {
      const again = () => {
        cancelAnimationFrame(schemeFrame);
        schemeFrame = requestAnimationFrame(scrollbars);
      };
      const watch = new MutationObserver(again);
      for (const el of [document.documentElement, document.body])
        if (el)
          watch.observe(el, {
            attributes: true,
            attributeFilter: ["class", "style", "data-theme"],
          });
    } catch (_) {
      /* no observer: the first decision stays */
    }
  };
  if (loaded()) watchScheme();
  else document.addEventListener("DOMContentLoaded", watchScheme);

  window.__ideBridge = {
    receive,
    version: 2,
    internal: {
      methods,
      send,
      refFor,
      find,
      clip,
      preview,
      expand,
      page,
      role,
      nameOf,
      visible,
      squash,
      mode: MODE,
    },
  };
  if (MODE === "external") {
    const doc = performance.timeOrigin;
    // A passing page in a site's webview: the IDE sends its form, nothing else.
    if (passing()) send({ type: "ready", loaded: false, passing: true, ...page() });
    else if (loaded()) send({ type: "ready", loaded: true, doc, ...page() });
    else
      document.addEventListener("DOMContentLoaded", () =>
        send({ type: "ready", loaded: true, doc, ...page() }),
      );
  }
})();

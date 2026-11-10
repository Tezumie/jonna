// Links, popups and redirects of the browser bridge (D209; concatenated after bridge.js by the
// Rust side). The tab's frame only shows pages a preview proxy serves, and it is sandboxed
// without popups, so the page can't leave on its own:
// - a navigation to another origin (a link, a form, `location.href = …`, a redirect through the
//   proxy's goto page) is cancelled and handed to the IDE as `open` / `self`: another local server
//   comes back through its own proxy in this tab, another site as the tab's other sites;
// - `target=_blank`, Ctrl/Cmd/middle-click and `window.open` become IDE browser tabs (`open` /
//   `tab`). `window.open` returns a stand-in window whose `postMessage`, `close` and `closed`
//   relay through the IDE, and the popup's tab gets a `window.opener` that relays back — so
//   sign-in popups that post their result to the opener keep working. Like a cross-origin
//   window, `document` of either throws a SecurityError and `location` can be set, not read.
//   A named target (`window.open(url, "x")`, `<a target="x">`) reuses the IDE tab of that name;
//   a form posted into a new tab is posted there.
// In other sites' windows only popups and new tabs are handled here (their navigations are
// theirs; a way back to a local server is caught by the window itself, in Rust).
(() => {
  const api = window.__ideBridge?.internal;
  if (!api) return;
  const { methods, send, mode } = api;
  // The user's own browser (D341) opens its links, tabs and popups itself.
  if (typeof window.__IDE_BRIDGE_POST__ === "string") return;
  // Only the page the IDE shows: frames inside it navigate on their own.
  if (mode === "frame" ? window.parent !== window.top : window.top !== window) return;
  const proxied =
    mode === "frame" || (location.protocol === "http:" && location.hostname === "127.0.0.1");

  const post = (msg) => {
    try {
      send(msg);
    } catch (_) {
      /* data that can't be cloned: dropped, as postMessage would throw at the page */
    }
  };
  const resolve = (href) => {
    try {
      return new URL(String(href), location.href);
    } catch (_) {
      return null;
    }
  };
  const isHttp = (u) => u.protocol === "http:" || u.protocol === "https:";
  /** The proxy address the IDE told us to go to: our own navigation, not one to intercept. */
  let allowed = "";

  // Popups need a user gesture, as in browsers; an agent's click (browser.click) counts as one.
  let agentClick = 0;
  const click = methods.click;
  methods.click = (p) => {
    agentClick = Date.now();
    return click(p);
  };
  const gesture = () =>
    Date.now() - agentClick < 1500 ||
    !navigator.userActivation ||
    navigator.userActivation.isActive;

  /** A name that picks a tab (not `_blank`, `_self` and the like). */
  const tabName = (name) => {
    const t = typeof name === "string" ? name.trim() : "";
    return t && !t.startsWith("_") ? t.slice(0, 200) : "";
  };
  const openTab = (u, popup, name, form) => {
    const n = tabName(name);
    post({
      type: "open",
      url: u.href,
      disposition: "tab",
      ...(popup && { popup }),
      ...(n && { name: n }),
      ...(form && { form }),
    });
  };
  /** What a page gets when it reaches into a window of another origin. */
  const crossOrigin = (what) =>
    new DOMException(
      `Blocked a frame from accessing "${what}" of a cross-origin window.`,
      "SecurityError",
    );
  const openHere = (u, replace, form) =>
    post({
      type: "open",
      url: u.href,
      disposition: "self",
      replace: !!replace,
      ...(form && { form }),
    });

  /** A MessageEvent from a relayed window, as the page's listeners expect it. */
  const deliver = (data, origin, source) => {
    const event = new MessageEvent("message", { data, origin: String(origin || "") });
    try {
      Object.defineProperty(event, "source", { value: source });
    } catch (_) {
      /* source stays null */
    }
    window.dispatchEvent(event);
  };
  const targetOf = (t) =>
    typeof t === "string" ? t : t && typeof t.targetOrigin === "string" ? t.targetOrigin : "/";

  // ---- Popups this page opened: stand-ins for their windows -------------------------------------

  const popups = new Map();
  const named = new Map();
  let popupSeq = 0;
  const newPopup = (name) => {
    const id = `p${Date.now().toString(36)}${++popupSeq}`;
    let href = "about:blank";
    let opened = false;
    let closed = false;
    const go = (value) => {
      const u = resolve(value);
      if (!u || !isHttp(u)) return;
      href = u.href;
      if (opened) post({ type: "popupNavigate", id, url: u.href });
      else {
        opened = true;
        openTab(u, id, name);
      }
    };
    const location = {
      get href() {
        return href;
      },
      set href(v) {
        go(v);
      },
      assign: (v) => go(v),
      replace: (v) => go(v),
      toString: () => href,
    };
    const stub = {
      name,
      opener: window,
      get closed() {
        return closed;
      },
      // The popup is another tab of the IDE: as a window of another origin is.
      get document() {
        throw crossOrigin("document");
      },
      get location() {
        return location;
      },
      set location(v) {
        go(v);
      },
      close() {
        if (!closed && opened) post({ type: "closePopup", id });
        closed = true;
      },
      focus() {
        if (opened) post({ type: "focusPopup", id });
      },
      blur() {},
      postMessage(data, targetOrigin) {
        if (!closed && opened)
          post({ type: "toPopup", id, data, targetOrigin: targetOf(targetOrigin) });
      },
    };
    popups.set(id, { stub, setClosed: () => (closed = true) });
    if (name && name !== "_blank") named.set(name, stub);
    return { stub, go };
  };
  methods.popupMessage = ({ id, data, origin }) => {
    deliver(data, origin, popups.get(String(id))?.stub ?? null);
    return { ok: true };
  };
  methods.popupClosed = ({ id }) => {
    const p = popups.get(String(id));
    if (p) {
      p.setClosed();
      popups.delete(String(id));
      for (const [name, stub] of named) if (stub === p.stub) named.delete(name);
    }
    return { ok: true };
  };

  const originalOpen = window.open;
  window.open = function (...args) {
    const [url, target, features] = args;
    const name =
      target === undefined || target === null || target === "" ? "_blank" : String(target);
    const lower = name.toLowerCase();
    const u = url === undefined || url === null || url === "" ? null : resolve(url);
    // javascript:, blob:, data:… are the engine's (blocked in the frame, as before).
    if (u && !isHttp(u) && u.href !== "about:blank") return originalOpen.apply(this, args);
    if (lower === "_self" || lower === "_parent" || lower === "_top") {
      if (u && isHttp(u)) {
        if (u.origin === location.origin || !proxied) location.href = u.href;
        else openHere(u, false);
      }
      return window;
    }
    if (!gesture()) return null; // a popup without a click: blocked, as browsers do
    if (
      /(^|,)\s*(noopener|noreferrer)\s*(=\s*(1|yes|true)\s*)?(,|$)/i.test(String(features ?? ""))
    ) {
      if (u && isHttp(u)) openTab(u, null);
      return null;
    }
    const reuse = named.get(name);
    if (reuse && !reuse.closed) {
      if (u && isHttp(u)) reuse.location.href = u.href;
      return reuse;
    }
    const { stub, go } = newPopup(name);
    if (u && isHttp(u)) go(u.href);
    return stub;
  };

  // ---- This page's tab: its window name, and an opener if another tab opened it ----------------

  // The frame's name carries what the IDE knows of the tab across its pages ("ide-tab:{json}",
  // or the older "ide-popup:<id>"); a site's webview gets it as globals.
  const tab = { popup: false, name: "" };
  const carried = mode === "frame" && /^ide-(popup|tab):/.test(window.name);
  if (mode === "frame") {
    if (window.name.startsWith("ide-popup:")) tab.popup = true;
    else if (window.name.startsWith("ide-tab:"))
      try {
        const o = JSON.parse(window.name.slice("ide-tab:".length));
        tab.popup = !!o.popup;
        tab.name = typeof o.name === "string" ? o.name : "";
      } catch (_) {
        /* not the IDE's after all */
      }
  } else {
    tab.popup = window.__IDE_POPUP__ === true;
    tab.name = typeof window.__IDE_WINDOW_NAME__ === "string" ? window.__IDE_WINDOW_NAME__ : "";
    if (tab.name && !window.name)
      try {
        window.name = tab.name;
      } catch (_) {
        /* the page keeps its own */
      }
  }
  if (carried) {
    // The page sees its tab's name, not the marker (and may set its own).
    let own = tab.name;
    try {
      Object.defineProperty(window, "name", {
        configurable: true,
        get: () => own,
        set: (v) => {
          own = String(v);
        },
      });
    } catch (_) {
      /* the page sees the marker */
    }
  }
  if (tab.popup) {
    let openerClosed = false;
    /** The opener's tab goes to `value` (a popup may navigate its opener, as browsers allow). */
    const navigateOpener = (value, replace) => {
      const u = resolve(value);
      if (u && isHttp(u)) post({ type: "openerNavigate", url: u.href, replace: !!replace });
    };
    const openerLocation = {
      get href() {
        throw crossOrigin("location.href");
      },
      set href(v) {
        navigateOpener(v, false);
      },
      assign: (v) => navigateOpener(v, false),
      replace: (v) => navigateOpener(v, true),
      toString() {
        throw crossOrigin("location");
      },
    };
    const opener = {
      get closed() {
        return openerClosed;
      },
      get document() {
        throw crossOrigin("document");
      },
      get location() {
        return openerLocation;
      },
      set location(v) {
        navigateOpener(v, false);
      },
      postMessage(data, targetOrigin) {
        if (!openerClosed) post({ type: "toOpener", data, targetOrigin: targetOf(targetOrigin) });
      },
      focus() {},
      blur() {},
      close() {},
    };
    methods.openerClosed = () => {
      openerClosed = true;
      return { ok: true };
    };
    try {
      Object.defineProperty(window, "opener", {
        configurable: true,
        get: () => opener,
        set: () => {},
      });
    } catch (_) {
      /* no opener for this page */
    }
    methods.openerMessage = ({ data, origin }) => {
      deliver(data, origin, opener);
      return { ok: true };
    };
    window.close = () => post({ type: "close" });
  }

  // ---- Links -----------------------------------------------------------------------------------

  const hasNavigation =
    proxied && !!window.navigation && typeof window.navigation.addEventListener === "function";
  const frameNamed = (name) => {
    try {
      return !!document.querySelector(
        `iframe[name="${CSS.escape(name)}"],frame[name="${CSS.escape(name)}"]`,
      );
    } catch (_) {
      return false;
    }
  };
  /** A link or form target that means a new tab (not this page, not a frame inside it). */
  const wantsTab = (target, e) => {
    if (e && (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1)) return true;
    const t = (target || "").trim();
    if (!t || /^_(self|parent|top)$/i.test(t)) return false;
    return !frameNamed(t);
  };
  const baseTarget = () => document.querySelector("base[target]")?.getAttribute("target") || "";
  const onLink = (e) => {
    if (e.defaultPrevented) return;
    const a = e.target?.closest ? e.target.closest("a[href],area[href]") : null;
    if (!a || a.hasAttribute("download")) return;
    const href = a.href && typeof a.href === "object" ? a.href.baseVal : a.href;
    const u = resolve(href);
    if (!u || !isHttp(u)) return;
    const target = a.getAttribute("target") ?? baseTarget();
    if (wantsTab(target, e)) {
      e.preventDefault();
      // A modified click is a new tab of its own; a named target picks (or names) one.
      const name = e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1 ? "" : target;
      // Links open without an opener (browsers' default for target=_blank) unless rel=opener.
      if (/(^|\s)opener(\s|$)/i.test(a.rel || "") && gesture())
        newPopup(tabName(name) || "_blank").go(u.href);
      else openTab(u, null, name);
      return;
    }
    if (!proxied || u.origin === location.origin || hasNavigation) return;
    e.preventDefault();
    openHere(u, false);
  };
  window.addEventListener("click", (e) => {
    if (e.button === 0) onLink(e);
  });
  window.addEventListener("auxclick", (e) => {
    if (e.button === 1) onLink(e);
  });

  // ---- Forms -----------------------------------------------------------------------------------

  const entriesOf = (data) =>
    Array.from(data.entries()).map(([k, v]) =>
      // Files only cross to the IDE's frame host; other sites' windows talk JSON.
      typeof v === "string" || mode === "frame" ? [k, v] : [k, v.name || ""],
    );
  window.addEventListener("submit", (e) => {
    if (e.defaultPrevented) return;
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    const sub = e.submitter || null;
    const attr = (name, fallback) =>
      (sub?.hasAttribute(`form${name}`)
        ? sub.getAttribute(`form${name}`)
        : form.getAttribute(name)) || fallback;
    const method = attr("method", "get").toLowerCase();
    if (method === "dialog") return;
    const action = resolve(sub?.hasAttribute("formaction") ? sub.formAction : form.action);
    if (!action || !isHttp(action)) return;
    const target = attr("target", baseTarget());
    const tab = wantsTab(target, null);
    // A site's own page submits its forms itself, except into a new tab (which would lose them).
    if (!tab && (!proxied || action.origin === location.origin || hasNavigation)) return;
    let data;
    try {
      data = new FormData(form, sub || undefined);
    } catch (_) {
      data = new FormData(form);
    }
    e.preventDefault();
    if (method !== "post") {
      const query = new URLSearchParams();
      for (const [k, v] of data) if (typeof v === "string") query.append(k, v);
      action.search = query.toString();
      if (tab) openTab(action, null, target);
      else openHere(action, false);
      return;
    }
    const posted = {
      method: "post",
      enctype: attr("enctype", "application/x-www-form-urlencoded"),
      entries: entriesOf(data),
    };
    // Into a new tab: the new tab posts it (from a passing page of a preview proxy).
    if (tab) openTab(action, null, target, posted);
    else openHere(action, false, posted);
  });

  /** The IDE's answer to a form for another origin: the same submission to that origin's proxy. */
  methods.submitForm = ({ action, method, enctype, entries }) => {
    const f = document.createElement("form");
    f.method = String(method || "post");
    f.enctype = String(enctype || "application/x-www-form-urlencoded");
    f.action = String(action);
    f.style.display = "none";
    f.setAttribute("data-ide-overlay", "");
    for (const [name, value] of Array.isArray(entries) ? entries : []) {
      if (typeof File === "function" && value instanceof File) {
        const input = document.createElement("input");
        input.type = "file";
        input.name = String(name);
        try {
          const dt = new DataTransfer();
          dt.items.add(value);
          input.files = dt.files;
        } catch (_) {
          /* the file is left out */
        }
        f.append(input);
      } else {
        // A textarea keeps line breaks (a hidden input would too, but not in every engine).
        const field = document.createElement("textarea");
        field.name = String(name);
        field.value = String(value);
        f.append(field);
      }
    }
    allowed = new URL(f.action, location.href).href;
    const submit = () => {
      (document.body || document.documentElement).append(f);
      HTMLFormElement.prototype.submit.call(f);
    };
    // A site's webview may ask before its passing page is parsed.
    if (document.documentElement) submit();
    else document.addEventListener("DOMContentLoaded", submit, { once: true });
    return { submitting: String(action) };
  };
  const navigate = methods.navigate;
  methods.navigate = (p) => {
    allowed = resolve(p.url)?.href ?? "";
    return navigate(p);
  };

  // ---- Every other navigation: the Navigation API (Chromium: WebView2) -------------------------

  if (hasNavigation)
    window.navigation.addEventListener("navigate", (e) => {
      if (!e.cancelable || e.hashChange || e.downloadRequest != null) return;
      if (e.navigationType === "traverse" || e.navigationType === "reload") return;
      const u = resolve(e.destination?.url);
      if (!u || !isHttp(u) || u.origin === location.origin) return;
      if (u.href === allowed) {
        allowed = "";
        return;
      }
      e.preventDefault();
      const form = e.formData
        ? {
            method: "post",
            enctype:
              e.sourceElement?.getAttribute?.("formenctype") ||
              e.sourceElement?.form?.enctype ||
              e.sourceElement?.enctype ||
              "application/x-www-form-urlencoded",
            entries: entriesOf(e.formData),
          }
        : undefined;
      openHere(u, e.navigationType === "replace", form);
    });

  // ---- A redirect to another origin, through the proxy's goto page ------------------------------

  if (proxied && location.pathname === "/__ide/goto") {
    const u = resolve(new URLSearchParams(location.search).get("url") || "");
    if (u && isHttp(u)) openHere(u, true);
  }
})();

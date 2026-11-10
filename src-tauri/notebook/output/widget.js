// The agent's inline widget (D334): an SVG or a small HTML page the model wrote, drawn in a
// sandboxed frame (no same-origin) on the output origin, under widget.html's policy (no network).
// It can't reach the IDE: it only posts the messages below to the chat, which checks each one.
//
// From the IDE ({ ns: "ide-widget", ... }):
//   ping; render: { code, mode: "svg" | "html", theme: { "--token": value }, scheme, fill,
//   maxHeight }; draft: the same with the code so far (D355: no scripts, morphed in);
//   theme: { vars, scheme }; testClick: selector (UI tests: a click inside, as the user's)
// To the IDE: ready, height (px), rendered, painted (a draft drawn), prompt (sendPrompt's text),
//   link (a clicked link),
//   error (the widget's script failed), clicked (a test click's element was found)
(() => {
  const NS = "ide-widget";
  const out = document.getElementById("out");
  const post = (message) => parent.postMessage({ ns: NS, ...message }, "*");

  // No frames of its own, no WebRTC (harden.js): ways around the page's policy.
  window.ideOutputSandbox.harden();

  // ---- Size ---------------------------------------------------------------------------------------
  let fill = false;
  let maxHeight = 0;
  let lastHeight = -1;
  const reportHeight = () => {
    if (fill) return;
    const h = Math.ceil(Math.max(out.getBoundingClientRect().height, out.scrollHeight));
    // Taller than the chat shows it: it scrolls inside.
    document.body.style.overflowY = maxHeight && h > maxHeight ? "auto" : "";
    if (h !== lastHeight) {
      lastHeight = h;
      post({ height: h });
    }
  };
  new ResizeObserver(reportHeight).observe(out);

  // ---- sendPrompt -------------------------------------------------------------------------------
  // Only from the user's click or key press in the frame (its transient activation, read through
  // getters taken before the widget's code runs, so it can't fake them). The IDE checks again:
  // the frame must have focus, and it limits how often.
  const activeGetter = (() => {
    try {
      const ua = navigator.userActivation;
      const get = Object.getOwnPropertyDescriptor(UserActivation.prototype, "isActive")?.get;
      return ua && get ? () => get.call(ua) : () => true;
    } catch {
      return () => true;
    }
  })();
  let testUntil = 0;
  const now = Date.now.bind(Date);
  Object.defineProperty(window, "sendPrompt", {
    value: (text) => {
      if (!activeGetter() && now() > testUntil) {
        console.warn("sendPrompt works only from a click or a key press.");
        return false;
      }
      post({ prompt: String(text ?? "") });
      return true;
    },
    writable: false,
    configurable: false,
  });

  // Links open outside (the frame can't navigate itself away).
  document.addEventListener(
    "click",
    (e) => {
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!a) return;
      const href = a.getAttribute("href") || "";
      if (href.startsWith("#")) return;
      e.preventDefault();
      if (/^https?:\/\//i.test(a.href)) post({ link: a.href });
    },
    true,
  );

  let errors = 0;
  window.addEventListener("error", (e) => {
    // A few are enough to say it failed.
    if (++errors <= 3) post({ error: String(e.message || "Script error") });
  });

  // The scheme is a class (is-dark / is-light) for widgets that care: setting color-scheme would
  // make the frame paint an opaque backdrop.
  const applyTheme = (vars, scheme) => {
    for (const [k, v] of Object.entries(vars || {}))
      if (/^--[\w-]+$/.test(k)) document.documentElement.style.setProperty(k, String(v));
    if (scheme === "light" || scheme === "dark") {
      document.documentElement.classList.toggle("is-dark", scheme === "dark");
      document.documentElement.classList.toggle("is-light", scheme === "light");
    }
  };

  /** Puts the code in `el` and runs its scripts in order (innerHTML alone runs none). */
  async function setHtml(el, code) {
    el.innerHTML = code;
    for (const old of [...el.querySelectorAll("script")]) {
      const type = (old.getAttribute("type") || "").trim().toLowerCase();
      if (type && !/^(text|application)\/(javascript|ecmascript)$|^module$/.test(type)) continue;
      const s = document.createElement("script");
      for (const a of old.attributes) s.setAttribute(a.name, a.value);
      if (old.src) {
        // Blocked by the policy unless it's this origin's: waits for the error either way.
        const done = new Promise((resolve) => {
          s.onload = resolve;
          s.onerror = resolve;
        });
        old.replaceWith(s);
        await done;
      } else {
        s.textContent = old.textContent;
        old.replaceWith(s);
      }
    }
  }

  // ---- Drafts (D355) ----------------------------------------------------------------------------
  // While the call is written the IDE sends the code so far (cut to what's whole, scripts left
  // out). It's morphed into the page rather than set again: what's drawn stays put (no flicker,
  // animations and pictures keep going) and only what changed is touched.
  const sameKind = (a, b) =>
    a.nodeType === b.nodeType && a.nodeName === b.nodeName && a.namespaceURI === b.namespaceURI;

  function morphChildren(target, source) {
    const want = [...source.childNodes];
    want.forEach((w, i) => {
      const have = target.childNodes[i];
      if (!have) target.appendChild(document.importNode(w, true));
      else if (!sameKind(have, w)) have.replaceWith(document.importNode(w, true));
      else if (have.nodeType === Node.TEXT_NODE || have.nodeType === Node.COMMENT_NODE) {
        if (have.data !== w.data) have.data = w.data;
      } else if (have.nodeType === Node.ELEMENT_NODE) {
        for (const a of [...have.attributes])
          if (!w.hasAttributeNS(a.namespaceURI, a.localName))
            have.removeAttributeNS(a.namespaceURI, a.localName);
        for (const a of w.attributes)
          if (have.getAttributeNS(a.namespaceURI, a.localName) !== a.value)
            have.setAttributeNS(a.namespaceURI, a.name, a.value);
        morphChildren(have, w);
      }
    });
    while (target.childNodes.length > want.length) target.lastChild.remove();
  }

  function draft(r) {
    if (rendered) return; // the finished widget is drawn: a late draft changes nothing
    applyTheme(r.theme, r.scheme);
    fill = !!r.fill;
    maxHeight = typeof r.maxHeight === "number" ? r.maxHeight : 0;
    document.body.classList.toggle("is-fill", fill);
    const t = document.createElement("template");
    t.innerHTML = String(r.code || "");
    // The IDE leaves scripts out; so does the page (a draft never runs code).
    for (const s of t.content.querySelectorAll("script")) s.remove();
    try {
      morphChildren(out, t.content);
    } catch {
      out.replaceChildren(document.importNode(t.content, true));
    }
    post({ painted: true });
    requestAnimationFrame(reportHeight);
  }

  let rendered = false;
  async function render(r) {
    applyTheme(r.theme, r.scheme);
    fill = !!r.fill;
    maxHeight = typeof r.maxHeight === "number" ? r.maxHeight : 0;
    document.body.classList.toggle("is-fill", fill);
    // Drawn once per page: a second render (the IDE asking again) only updates the theme.
    if (rendered) {
      post({ rendered: true });
      return;
    }
    rendered = true;
    try {
      await setHtml(out, String(r.code || ""));
    } catch (err) {
      const p = document.createElement("p");
      p.className = "note";
      p.textContent = `This widget failed: ${err?.message ? err.message : err}`;
      out.appendChild(p);
      post({ error: String(err?.message ? err.message : err) });
    }
    post({ rendered: true });
    requestAnimationFrame(reportHeight);
    // Fonts and images settle a moment later.
    setTimeout(reportHeight, 300);
  }

  window.addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const m = e.data;
    if (!m || m.ns !== NS) return;
    if (m.ping) post({ ready: true });
    else if (m.render) void render(m.render);
    else if (m.draft) draft(m.draft);
    else if (m.theme) applyTheme(m.theme.vars, m.theme.scheme);
    else if (typeof m.testClick === "string") {
      let el = null;
      try {
        el = document.querySelector(m.testClick);
      } catch {
        // Not a selector.
      }
      if (el) {
        testUntil = now() + 1500;
        el.click();
      }
      post({ clicked: !!el });
    }
  });
  post({ ready: true });
})();

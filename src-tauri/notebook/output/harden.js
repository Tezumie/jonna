// The output pages' network limit and hardening (D204), shared by output.js (one output per
// frame) and notebook.js (a VS Code controller's notebook, D295). Runs before any output's or
// extension's code; each page takes the functions once at its start.
(() => {
  /** Only what the extension was allowed: `network` is "none", "any" or a list of hosts. */
  function limitNetwork(network) {
    const hosts =
      network === "any"
        ? ["https:"]
        : Array.isArray(network)
          ? network.map((h) => `https://${h}`)
          : [];
    const extra = hosts.length ? ` ${hosts.join(" ")}` : "";
    const policy = [
      "default-src 'none'",
      `script-src 'unsafe-inline' 'unsafe-eval' blob: data:${extra}`,
      // blob: the page's own copies of files (notebook.js: local files by VS Code's addresses).
      `style-src 'unsafe-inline' data: blob:${extra}`,
      `img-src data: blob:${extra}`,
      `font-src data: blob:${extra}`,
      `media-src data: blob:${extra}`,
      `connect-src blob:${extra}`,
    ].join("; ");
    const meta = document.createElement("meta");
    meta.httpEquiv = "Content-Security-Policy";
    meta.content = policy;
    document.head.prepend(meta);
  }

  /**
   * Closes the ways around that network limit a page has besides fetches (D204): no WebRTC (its
   * ICE requests reach any host), no DNS prefetching, and no frames of its own (a blank child
   * frame would bring fresh, unpatched globals). The frame navigating itself is refused by the
   * IDE page's own frame-src (only the local origins); popups are off for renderer frames.
   */
  let hardened = false;
  function harden() {
    if (hardened) return;
    hardened = true;
    const dns = document.createElement("meta");
    dns.httpEquiv = "x-dns-prefetch-control";
    dns.content = "off";
    document.head.prepend(dns);
    for (const name of Object.getOwnPropertyNames(window))
      if (/^(webkit|moz)?RTC/.test(name))
        try {
          delete window[name];
        } catch {
          // Not configurable: shadowed below.
        }
    for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "XSLTProcessor"])
      try {
        if (name in window)
          Object.defineProperty(window, name, { value: undefined, configurable: false });
      } catch {
        // Already gone.
      }
    // Elements that make a browsing context, by local name (a namespace prefix too).
    const FRAMES = /^(iframe|frame|frameset|object|embed|portal|fencedframe)$/i;
    const TAGS =
      /<(\/?)\s*((?:[\w.-]+:)?)(iframe|frame|frameset|object|embed|portal|fencedframe)(?=[\s/>]|$)/gi;
    const clean = (html) => String(html).replace(TAGS, "<$1$2x-blocked-$3");
    const swap = (proto, key, wrap) => {
      const d = proto && Object.getOwnPropertyDescriptor(proto, key);
      if (!d) return;
      if (typeof d.value === "function")
        Object.defineProperty(proto, key, {
          ...d,
          value: wrap(d.value),
          writable: false,
          configurable: false,
        });
      else if (d.set)
        Object.defineProperty(proto, key, { ...d, set: wrap(d.set), configurable: false });
    };
    const localName = (name) => String(name).split(":").pop();
    swap(
      Document.prototype,
      "createElement",
      (f) =>
        function (name, options) {
          return f.call(
            this,
            FRAMES.test(localName(name)) ? `x-blocked-${localName(name)}` : name,
            options,
          );
        },
    );
    swap(
      Document.prototype,
      "createElementNS",
      (f) =>
        function (ns, name, options) {
          return FRAMES.test(localName(name))
            ? f.call(this, "http://www.w3.org/1999/xhtml", `x-blocked-${localName(name)}`)
            : f.call(this, ns, name, options);
        },
    );
    // A customized built-in (`new class extends HTMLIFrameElement`, `extends: "iframe"`).
    swap(
      CustomElementRegistry.prototype,
      "define",
      (f) =>
        function (name, ctor, options) {
          if (options && FRAMES.test(String(options.extends)))
            throw new Error("Frames can't be made here.");
          return f.call(this, name, ctor, options);
        },
    );
    swap(
      DOMImplementation.prototype,
      "createDocument",
      (f) =>
        function (ns, name, doctype) {
          return f.call(
            this,
            ns,
            name && FRAMES.test(localName(name)) ? "x-blocked" : name,
            doctype,
          );
        },
    );
    for (const proto of [Element.prototype, ShadowRoot.prototype])
      for (const key of ["innerHTML", "outerHTML"])
        swap(
          proto,
          key,
          (f) =>
            function (html) {
              return f.call(this, clean(html));
            },
        );
    swap(
      Element.prototype,
      "insertAdjacentHTML",
      (f) =>
        function (where, html) {
          return f.call(this, where, clean(html));
        },
    );
    for (const proto of [Element.prototype, ShadowRoot.prototype])
      swap(
        proto,
        "setHTMLUnsafe",
        (f) =>
          function (html, ...rest) {
            return f.call(this, clean(html), ...rest);
          },
      );
    if (typeof Document.parseHTMLUnsafe === "function") {
      const parse = Document.parseHTMLUnsafe;
      Object.defineProperty(Document, "parseHTMLUnsafe", {
        value: (html, ...rest) => parse.call(Document, clean(html), ...rest),
        writable: false,
        configurable: false,
      });
    }
    for (const key of ["write", "writeln"])
      swap(
        Document.prototype,
        key,
        (f) =>
          function (...html) {
            return f.apply(this, html.map(clean));
          },
      );
    swap(
      Document.prototype,
      "execCommand",
      (f) =>
        function (cmd, ui, value) {
          return f.call(this, cmd, ui, typeof value === "string" ? clean(value) : value);
        },
    );
    swap(
      DOMParser.prototype,
      "parseFromString",
      (f) =>
        function (text, type) {
          return f.call(this, clean(text), type);
        },
    );
    swap(
      Range.prototype,
      "createContextualFragment",
      (f) =>
        function (html) {
          return f.call(this, clean(html));
        },
    );
    swap(
      HTMLIFrameElement.prototype,
      "srcdoc",
      (f) =>
        function (html) {
          return f.call(this, clean(html));
        },
    );
  }

  window.ideOutputSandbox = Object.freeze({ limitNetwork, harden });
})();

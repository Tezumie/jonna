// A VS Code controller's notebook output page (D295, the IDE's notebookPage.ts): one page per
// notebook, as VS Code's back-layer webview, drawing every output an extension's renderer takes.
// It runs the extensions' `notebookPreload` modules first (their activate(context) gets
// postKernelMessage / onDidReceiveKernelMessage, the controller's messages), then renderers
// (VS Code's renderer API: activate(context) → renderOutputItem(item, element, signal),
// disposeOutputItem(id); context.postMessage / onDidReceiveMessage / getRenderer / getState /
// setState / workspace.isTrusted / settings). Sandboxed, on an origin of its own: it reaches the
// IDE only by the messages below, and the network its extensions were allowed (harden.js).
//
// From the IDE ({ ns: "ide-nb-page", ... }):
//   init: { preloads: [{ id, code } | { id, error }], network, theme, trusted, settings }
//   renderer: { id, code, mimeTypes } | { id, error }
//   render: { id, rendererId, mime, items: [{ mime, value, metadata }] }   dispose: { id }
//     (rendererId "ide.builtin": the page draws it itself, with `before` HTML and `cdn`)
//   layout: [{ id, top, left, width, visible }]   theme: {...}
//   kernelMessage: the controller's message   rendererMessage: { rendererId, message }
//   resourceData: { id, data, type } | { id, error }: a file the page asked for
// To the IDE: ready, heights: [{ id, height }], kernelMessage, rendererMessage: { rendererId,
//   message }, needRenderer: id, link: url, error: text, resource: { id, url } (one of VS
//   Code's webview addresses of a local file).
(() => {
  const NS = "ide-nb-page";
  const { limitNetwork, harden } = window.ideOutputSandbox;
  const root = document.getElementById("outputs");
  const post = (message) => parent.postMessage({ ns: NS, ...message }, "*");
  const report = (err) => post({ error: String(err && err.message ? err.message : err) });

  /** A small Event / Emitter pair, VS Code's shape (listen → { dispose }). */
  const emitter = () => {
    const listeners = new Set();
    return {
      fire(value) {
        for (const l of [...listeners])
          try {
            l(value);
          } catch (err) {
            report(err);
          }
      },
      event: (listener) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    };
  };

  // ---- Local files by VS Code's webview addresses -----------------------------------------------
  // A controller's asWebviewUri gives `https://file%2B.vscode-resource.vscode-cdn.net/<path>`
  // (Jupyter's widget modules, copied into its folder). This page can't reach files: a script,
  // style sheet, picture or fetch of such an address asks the IDE for the file (the kernel's
  // extension folder or the workspace's, notebookPage.ts) and loads it as a blob.
  const RESOURCE = /^https:\/\/file(?:\+|%2b)\.vscode-resource\.vscode-cdn\.net\//i;
  const isResource = (v) => typeof v === "string" && RESOURCE.test(v);
  const resourceWaits = new Map();
  const resourceBlobs = new Map();
  let resourceSeq = 0;
  function resourceBlob(url) {
    let blob = resourceBlobs.get(url);
    if (!blob) {
      blob = new Promise((resolve, reject) => {
        const id = ++resourceSeq;
        resourceWaits.set(id, { resolve, reject });
        post({ resource: { id, url } });
      }).then((r) => URL.createObjectURL(new Blob([r.data], { type: r.type })));
      resourceBlobs.set(url, blob);
      blob.catch(() => resourceBlobs.delete(url));
    }
    return blob;
  }
  function resourceArrived(r) {
    const wait = resourceWaits.get(r?.id);
    if (!wait) return;
    resourceWaits.delete(r.id);
    if (r.error) wait.reject(new Error(r.error));
    else wait.resolve(r);
  }
  /** An element's src / href setter that loads those addresses through the IDE first. */
  function redirect(proto, prop) {
    const d = proto && Object.getOwnPropertyDescriptor(proto, prop);
    if (!d?.set) return;
    Object.defineProperty(proto, prop, {
      ...d,
      set(value) {
        if (!isResource(value)) return d.set.call(this, value);
        // Set when the file is here (a script inserted without a src runs once it gets one).
        resourceBlob(String(value)).then(
          (url) => d.set.call(this, url),
          (err) => {
            report(err);
            this.dispatchEvent(new Event("error"));
          },
        );
      },
    });
  }
  if (typeof HTMLScriptElement === "function") redirect(HTMLScriptElement.prototype, "src");
  if (typeof HTMLLinkElement === "function") redirect(HTMLLinkElement.prototype, "href");
  if (typeof HTMLImageElement === "function") redirect(HTMLImageElement.prototype, "src");
  const setAttribute = typeof Element === "function" && Element.prototype.setAttribute;
  if (typeof setAttribute === "function")
    Element.prototype.setAttribute = function (name, value) {
      const key = String(name).toLowerCase();
      if ((key === "src" || key === "href") && isResource(value) && key in this) {
        this[key] = value;
        return;
      }
      return setAttribute.call(this, name, value);
    };
  const pageFetch = typeof window.fetch === "function" ? window.fetch : null;
  if (pageFetch)
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input?.url;
      if (isResource(url))
        return resourceBlob(url).then((blob) => pageFetch.call(window, blob, init));
      return pageFetch.call(this, input, init);
    };

  // Some extensions' webview code looks for VS Code's webview API; the notebook page has one.
  let webviewState;
  window.acquireVsCodeApi = () => ({
    postMessage: () => {},
    getState: () => webviewState,
    setState: (s) => {
      webviewState = s;
      return s;
    },
  });

  const applyTheme = (theme) => {
    if (!theme) return;
    for (const [k, v] of Object.entries(theme)) document.documentElement.style.setProperty(k, v);
    // VS Code's body classes (some renderers' styles follow them).
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg-surface").trim();
    const dark = isDark(bg);
    document.body.classList.toggle("vscode-dark", dark);
    document.body.classList.toggle("vscode-light", !dark);
    document.body.dataset.vscodeThemeKind = dark ? "vscode-dark" : "vscode-light";
  };
  /** Whether a CSS color (#rgb, #rrggbb, rgb()) is dark. */
  function isDark(color) {
    let r;
    let g;
    let b;
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
    if (hex) {
      const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
      [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
    } else {
      const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(color);
      if (!m) return false;
      [r, g, b] = [m[1], m[2], m[3]].map(Number);
    }
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
  }

  // Links open outside (the page can't navigate itself away).
  document.addEventListener(
    "click",
    (e) => {
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!a) return;
      const href = a.getAttribute("href") || "";
      if (href.startsWith("#") || href.startsWith("javascript:")) return;
      e.preventDefault();
      post({ link: /^https?:\/\//i.test(href) ? a.href : href });
    },
    true,
  );

  /** A module's code: imported (an ES module), else run with a module.exports object. */
  async function importCode(code) {
    let moduleError = null;
    try {
      const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      try {
        const mod = await import(url);
        if (mod && typeof mod.activate === "function") return mod;
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      // Not a module (or this engine can't import a blob): a classic script below.
      moduleError = err;
    }
    try {
      const module = { exports: {} };
      // biome-ignore lint/security/noGlobalEval: an extension's own script, in this sandbox.
      new Function("module", "exports", code)(module, module.exports);
      const mod = module.exports;
      return mod && mod.default && typeof mod.default.activate === "function" ? mod.default : mod;
    } catch (err) {
      throw moduleError || err;
    }
  }

  // ---- Preloads and the controller's messages ---------------------------------------------------
  const kernelMessages = emitter();
  /** Messages that came before the preloads listened (they start listening as they activate). */
  let earlyKernel = [];
  let markPreloadsDone;
  const preloadsSettled = new Promise((resolve) => {
    markPreloadsDone = resolve;
  });
  const kernelContext = Object.freeze({
    onDidReceiveKernelMessage: kernelMessages.event,
    postKernelMessage: (data) => post({ kernelMessage: data }),
  });

  async function runPreloads(list) {
    await Promise.all(
      (list || []).map(async (p) => {
        if (p.error) {
          report(`Notebook preload ${p.id}: ${p.error}`);
          return;
        }
        try {
          const mod = await importCode(p.code);
          // Renderers wait for every preload (VS Code's order); one that never finishes
          // activating holds them 30 s at most.
          if (mod && typeof mod.activate === "function")
            await Promise.race([
              mod.activate(kernelContext),
              new Promise((resolve) => setTimeout(resolve, 30_000)),
            ]);
        } catch (err) {
          report(`Notebook preload ${p.id}: ${err && err.message ? err.message : err}`);
        }
      }),
    );
  }

  // ---- Renderers --------------------------------------------------------------------------------
  let trusted = false;
  let settings = {
    lineLimit: 30,
    outputScrolling: true,
    outputWordWrap: false,
    linkifyFilePaths: true,
    minimalError: false,
  };
  const settingsChanged = emitter();
  const rendererState = new Map();
  /** The scripts the IDE sent, by renderer id. */
  const scripts = new Map();
  const renderers = new Map();

  /** A renderer's script: the IDE sends it with its first output, or when asked for it. */
  function scriptOf(id) {
    let s = scripts.get(id);
    if (!s) {
      let resolve;
      const promise = new Promise((r) => {
        resolve = r;
      });
      s = { promise, resolve, asked: false };
      scripts.set(id, s);
    }
    return s;
  }

  function rendererOf(id) {
    let r = renderers.get(id);
    if (r) return r;
    const messages = emitter();
    const context = Object.freeze({
      postMessage: (message) => post({ rendererMessage: { rendererId: id, message } }),
      onDidReceiveMessage: messages.event,
      // Another renderer's API (its script asked of the IDE); undefined when there's none.
      getRenderer: async (other) => {
        try {
          return await rendererOf(other).load();
        } catch {
          return undefined;
        }
      },
      getState: () => rendererState.get(id),
      setState: (state) => rendererState.set(id, state),
      workspace: Object.freeze({
        get isTrusted() {
          return trusted;
        },
      }),
      settings: Object.freeze({
        get lineLimit() {
          return settings.lineLimit;
        },
        get outputScrolling() {
          return settings.outputScrolling;
        },
        get outputWordWrap() {
          return settings.outputWordWrap;
        },
        get linkifyFilePaths() {
          return settings.linkifyFilePaths;
        },
        get minimalError() {
          return settings.minimalError;
        },
      }),
      onDidChangeSettings: settingsChanged.event,
    });
    let loading = null;
    r = {
      messages,
      api: null,
      load() {
        loading ??= (async () => {
          // Preloads first (VS Code: kernelPreloads.waitForAllCurrent()).
          await preloadsSettled;
          const s = scriptOf(id);
          if (!s.asked && !s.code) {
            s.asked = true;
            post({ needRenderer: id });
          }
          const script = await s.promise;
          if (script.error) throw new Error(script.error);
          const mod = await importCode(script.code);
          if (!mod || typeof mod.activate !== "function")
            throw new Error(`the renderer ${id} exports no activate(context)`);
          r.api = (await mod.activate(context)) || null;
          return r.api;
        })();
        return loading;
      },
    };
    renderers.set(id, r);
    return r;
  }

  // ---- Outputs ----------------------------------------------------------------------------------
  /** Live outputs by id: their element, their renderer, a signal to stop their drawing. */
  const outputs = new Map();

  /** The bytes of a value (pictures come base64-encoded in notebooks). */
  function bytesOf(mime, value) {
    if (/^image\//.test(mime) && mime !== "image/svg+xml" && typeof value === "string") {
      const bin = atob(value.replace(/\s+/g, ""));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new TextEncoder().encode(textOf(value));
  }
  const textOf = (value) => (typeof value === "string" ? value : JSON.stringify(value));

  /** VS Code's OutputItem: one mime type of an output. */
  function outputItem(id, item, all) {
    const make = (it) => ({
      id,
      mime: it.mime,
      metadata: it.metadata || {},
      text: () => textOf(it.value),
      json: () => (typeof it.value === "string" ? JSON.parse(it.value) : it.value),
      data: () => bytesOf(it.mime, it.value),
      blob: () => new Blob([bytesOf(it.mime, it.value)], { type: it.mime }),
    });
    const main = make(item);
    // VS Code's own (some renderers fall back to another mime type of the output with it).
    main._allOutputItems = all.map((it) => ({ mime: it.mime, getItem: async () => make(it) }));
    return main;
  }

  const note = (text) => {
    const p = document.createElement("p");
    p.className = "note";
    p.textContent = text;
    return p;
  };
  const pre = (text) => {
    const p = document.createElement("pre");
    p.className = "text";
    p.textContent = text;
    return p;
  };

  // Heights go to the IDE together, once a frame.
  const dueHeights = new Map();
  let heightFrame = 0;
  const sizes = new ResizeObserver((entries) => {
    for (const e of entries) {
      const id = e.target.dataset.output;
      if (id && outputs.has(id)) dueHeights.set(id, Math.ceil(e.target.offsetHeight));
    }
    if (dueHeights.size && !heightFrame)
      heightFrame = requestAnimationFrame(() => {
        heightFrame = 0;
        post({ heights: [...dueHeights].map(([id, height]) => ({ id, height })) });
        dueHeights.clear();
      });
  });

  function stopOutput(id) {
    const o = outputs.get(id);
    if (!o) return null;
    o.abort.abort();
    const api = renderers.get(o.rendererId)?.api;
    try {
      api?.disposeOutputItem?.(id);
    } catch (err) {
      report(err);
    }
    return o;
  }

  async function render(r) {
    const old = stopOutput(r.id);
    const el = old?.el ?? document.createElement("div");
    if (!old) {
      el.className = "output";
      el.dataset.output = r.id;
      root.appendChild(el);
      sizes.observe(el);
    }
    el.replaceChildren();
    const abort = new AbortController();
    outputs.set(r.id, { el, rendererId: r.rendererId, abort });
    const items = Array.isArray(r.items) ? r.items : [];
    const item = items.find((it) => it.mime === r.mime);
    const inner = document.createElement("div");
    el.appendChild(inner);
    if (r.rendererId === BUILTIN) {
      try {
        await renderBuiltin(inner, items, Array.isArray(r.before) ? r.before : [], r.cdn);
      } catch (err) {
        if (!abort.signal.aborted)
          inner.appendChild(note(`This output failed: ${err?.message ?? err}`));
      }
      return;
    }
    try {
      if (!item) throw new Error(`no ${r.mime} data`);
      const api = await rendererOf(r.rendererId).load();
      if (abort.signal.aborted) return;
      if (!api || typeof api.renderOutputItem !== "function")
        throw new Error(`${r.rendererId}: activate() returned no renderOutputItem`);
      await api.renderOutputItem(outputItem(r.id, item, items), inner, abort.signal);
    } catch (err) {
      if (abort.signal.aborted) return;
      // VS Code's "fall back to the next renderer": here, the output's text.
      const plain = items.find((it) => it.mime === "text/plain");
      inner.replaceChildren();
      if (!(err && err.name === "vscode.fallbackToNextRenderer"))
        inner.appendChild(note(`This output failed: ${err && err.message ? err.message : err}`));
      if (plain) inner.appendChild(pre(textOf(plain.value)));
    }
  }

  // ---- The page's own outputs (HTML with scripts, JavaScript, Plotly, Bokeh) -------------------
  // What the IDE draws in a frame of its own for its kernels (output.js), drawn here in the
  // notebook's one page, as VS Code draws every output in its webview: Bokeh's show() finds the
  // library its output_notebook() loaded, and widgets' and Plotly's scripts share the window.
  const BUILTIN = "ide.builtin";
  const loadedScripts = new Map();
  /** Loads a script once (in order with others); rejects when it can't be fetched. */
  function loadScript(src) {
    if (!loadedScripts.has(src))
      loadedScripts.set(
        src,
        new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = src;
          s.onload = () => resolve();
          s.onerror = () => reject(new Error(`Couldn't load ${src}`));
          document.head.appendChild(s);
        }),
      );
    return loadedScripts.get(src);
  }

  /** Puts HTML in `el` and runs its scripts in order (innerHTML alone runs none). */
  async function setHtml(el, html) {
    el.innerHTML = html;
    for (const old of [...el.querySelectorAll("script")]) {
      const type = (old.getAttribute("type") || "").trim().toLowerCase();
      if (type && !/^(text|application)\/(javascript|ecmascript)$|^module$/.test(type)) continue;
      const s = document.createElement("script");
      for (const a of old.attributes) s.setAttribute(a.name, a.value);
      if (old.src) {
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

  /** Runs an output's JavaScript the way the classic notebook did (`element` is its div). */
  function runJs(code, element) {
    try {
      // A notebook output's own code, in this sandbox.
      new Function("element", code).call(window, element);
    } catch (err) {
      element.appendChild(note(`JavaScript error: ${err?.message ?? err}`));
    }
  }

  async function plotly(el, fig, data, cdn) {
    if (!window.Plotly) {
      try {
        await loadScript(`${cdn}plotly.js-dist-min@3/plotly.min.js`);
      } catch {
        // Offline: the figure's own HTML (it may bundle Plotly), else its picture or text.
        if (data["text/html"]) return setHtml(el, textOf(data["text/html"]));
        if (data["image/png"]) {
          const img = document.createElement("img");
          img.src = `data:image/png;base64,${textOf(data["image/png"])}`;
          el.appendChild(img);
          return;
        }
        el.appendChild(
          note("This Plotly figure needs Plotly from the internet, which isn't reachable."),
        );
        if (data["text/plain"]) el.appendChild(pre(textOf(data["text/plain"])));
        return;
      }
    }
    const div = document.createElement("div");
    el.appendChild(div);
    const layout = { ...(fig.layout || {}) };
    // The IDE's colors unless the figure chose its own template.
    if (!layout.template) {
      const fg = getComputedStyle(document.documentElement).getPropertyValue("--fg-default").trim();
      layout.paper_bgcolor = layout.paper_bgcolor || "rgba(0,0,0,0)";
      layout.plot_bgcolor = layout.plot_bgcolor || "rgba(0,0,0,0)";
      layout.font = { color: fg, ...(layout.font || {}) };
    }
    await window.Plotly.newPlot(div, fig.data || [], layout, {
      responsive: true,
      ...(fig.config || {}),
    });
  }

  /** One output the page draws itself: its mime bundle, and the HTML outputs before it. */
  async function renderBuiltin(el, items, before, cdn) {
    const data = {};
    for (const it of items) data[it.mime] = it.value;
    const base =
      typeof cdn === "string" && /^https:\/\//.test(cdn) ? cdn : "https://cdn.jsdelivr.net/npm/";
    for (const html of before) {
      const b = document.createElement("div");
      el.appendChild(b);
      await setHtml(b, html);
    }
    const fig = data["application/vnd.plotly.v1+json"];
    if (fig) {
      const parsed = typeof fig === "string" ? JSON.parse(fig) : fig;
      return plotly(el, parsed, data, base);
    }
    const bokehLoad = data["application/vnd.bokehjs_load.v0+json"];
    if (bokehLoad) {
      if (data["text/html"]) await setHtml(el, textOf(data["text/html"]));
      return runJs(textOf(bokehLoad), el);
    }
    if (data["text/html"]) {
      await setHtml(el, textOf(data["text/html"]));
      if (data["application/vnd.bokehjs_exec.v0+json"] && data["application/javascript"])
        runJs(textOf(data["application/javascript"]), el);
      return;
    }
    if (data["application/javascript"]) return runJs(textOf(data["application/javascript"]), el);
    if (data["text/plain"]) el.appendChild(pre(textOf(data["text/plain"])));
  }

  function dispose(id) {
    const o = stopOutput(id);
    if (!o) return;
    sizes.unobserve(o.el);
    o.el.remove();
    outputs.delete(id);
    dueHeights.delete(id);
  }

  function layout(list) {
    for (const p of list || []) {
      const o = outputs.get(p.id);
      if (!o) continue;
      o.el.style.top = `${p.top}px`;
      o.el.style.left = `${p.left}px`;
      o.el.style.width = `${p.width}px`;
      o.el.classList.toggle("is-visible", !!p.visible);
    }
  }

  // ---- Messages ---------------------------------------------------------------------------------
  let initialized = false;
  /** Messages that came before init (renders wait for their renderers, which wait for preloads). */
  const beforeInit = [];

  async function init(m) {
    limitNetwork(m.network);
    if (m.network !== "any") harden();
    applyTheme(m.theme);
    trusted = m.trusted === true;
    if (m.settings) settings = { ...settings, ...m.settings };
    initialized = true;
    for (const queued of beforeInit.splice(0)) handle(queued);
    await runPreloads(m.preloads);
    markPreloadsDone();
    // The controller's messages that came while the preloads activated.
    const early = earlyKernel;
    earlyKernel = null;
    for (const message of early) kernelMessages.fire(message);
  }

  function handle(m) {
    if (m.render) void render(m.render);
    else if (m.dispose) dispose(m.dispose.id);
    else if (m.layout) layout(m.layout);
    else if (m.renderer) {
      const s = scriptOf(m.renderer.id);
      s.code = m.renderer.code;
      s.resolve(m.renderer);
    } else if ("kernelMessage" in m) {
      if (earlyKernel) {
        if (earlyKernel.length < 5000) earlyKernel.push(m.kernelMessage);
      } else kernelMessages.fire(m.kernelMessage);
    } else if (m.rendererMessage) {
      const r = renderers.get(m.rendererMessage.rendererId);
      // A renderer not loaded yet hears nothing (as in VS Code: it has no listener yet).
      r?.messages.fire(m.rendererMessage.message);
    } else if (m.resourceData) resourceArrived(m.resourceData);
    else if (m.theme) applyTheme(m.theme);
    else if (m.settings) {
      settings = { ...settings, ...m.settings };
      settingsChanged.fire(settings);
    }
  }

  window.addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const m = e.data;
    if (!m || m.ns !== NS) return;
    if (m.ping) post({ ready: true });
    else if (m.init) {
      if (!initialized) void init(m.init);
    } else if (!initialized) beforeInit.push(m);
    else handle(m);
  });
  post({ ready: true });
})();

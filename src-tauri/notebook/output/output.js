// A notebook output that runs code (D189): HTML with scripts, JavaScript, Plotly, Bokeh and
// Jupyter widgets. The page runs on an origin of its own in a sandboxed frame (no same-origin):
// it can't reach the IDE, only post the messages below to the notebook view, which owns the
// kernel. Libraries a notebook needs (Plotly, the widget manager) come from a CDN, as in Jupyter.
//
// From the IDE ({ ns: "ide-nb-out", ... }):
//   render: { output: { data, metadata }, preloads: [js...], widgets?: { comms: [comm_open...],
//             live }, renderer?: { id, mime, code, network }, cdn, theme: { "--token": value } }
//   comm: a comm message for the widgets; commDone: { localId, ok }; theme: {...};
//   rendererMessage: the extension's message for its renderer (D204)
// To the IDE: ready, height (px), send: { localId, kind, comm_id, data, metadata, buffers }
//   (a widget's message for the kernel), link: url (a clicked link), error: text,
//   rendererMessage: the renderer's message for its extension.
//
// An extension's renderer (D204, VS Code's notebook renderer API): its script (an ES module, or
// one setting module.exports) exports activate(context) → { renderOutputItem(item, element,
// signal), disposeOutputItem?(id) }. Before it runs, a content security policy limits the page
// to the network its extension was allowed (none by default).
(() => {
  const NS = "ide-nb-out";
  const out = document.getElementById("out");
  const post = (message) => parent.postMessage({ ns: NS, ...message }, "*");
  let cdn = "https://cdn.jsdelivr.net/npm/";

  // ---- Size -------------------------------------------------------------------------------------
  let lastHeight = -1;
  const reportHeight = () => {
    const h = Math.ceil(
      Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight,
        out.scrollHeight + 8,
      ),
    );
    if (h !== lastHeight) {
      lastHeight = h;
      post({ height: h });
    }
  };
  new ResizeObserver(reportHeight).observe(document.body);
  new MutationObserver(() => requestAnimationFrame(reportHeight)).observe(out, {
    childList: true,
    subtree: true,
    attributes: true,
  });

  // Links open outside (the frame can't navigate itself away).
  document.addEventListener(
    "click",
    (e) => {
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!a) return;
      const href = a.getAttribute("href") || "";
      if (href.startsWith("#") || href.startsWith("javascript:")) return;
      e.preventDefault();
      // As written: a relative link is a file next to the notebook (the IDE opens it).
      post({ link: /^https?:\/\//i.test(href) ? a.href : href });
    },
    true,
  );

  const applyTheme = (theme) => {
    if (!theme) return;
    for (const [k, v] of Object.entries(theme)) document.documentElement.style.setProperty(k, v);
  };

  const note = (text) => {
    const p = document.createElement("p");
    p.className = "note";
    p.textContent = text;
    return p;
  };
  const textOf = (v) =>
    typeof v === "string" ? v : Array.isArray(v) ? v.join("") : JSON.stringify(v);

  // ---- Scripts ----------------------------------------------------------------------------------
  const loaded = new Map();
  /** Loads a script once (in order with others); rejects when it can't be fetched. */
  const loadScript = (src) => {
    if (!loaded.has(src))
      loaded.set(
        src,
        new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = src;
          s.onload = () => resolve();
          s.onerror = () => reject(new Error(`Couldn't load ${src}`));
          document.head.appendChild(s);
        }),
      );
    return loaded.get(src);
  };

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
      // Deliberate eval: a notebook output's own code, in its own sandbox.
      new Function("element", code).call(window, element);
    } catch (err) {
      element.appendChild(note(`JavaScript error: ${err?.message ? err.message : err}`));
    }
  }

  // ---- Plotly -----------------------------------------------------------------------------------
  async function plotly(el, fig, data) {
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
      const css = getComputedStyle(document.documentElement);
      const fg = css.getPropertyValue("--fg-default").trim();
      layout.paper_bgcolor = layout.paper_bgcolor || "rgba(0,0,0,0)";
      layout.plot_bgcolor = layout.plot_bgcolor || "rgba(0,0,0,0)";
      layout.font = { color: fg, ...(layout.font || {}) };
    }
    await window.Plotly.newPlot(div, fig.data || [], layout, {
      responsive: true,
      ...(fig.config || {}),
    });
  }

  const pre = (text) => {
    const p = document.createElement("pre");
    p.className = "text";
    p.textContent = text;
    return p;
  };

  // ---- Widgets ----------------------------------------------------------------------------------
  let manager = null;
  let managerReady = null;
  const comms = new Map();
  const callbacks = new Map();
  let localSeq = 0;
  const queued = [];

  const toBuffers = (list) =>
    (list || []).map((b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new DataView(bytes.buffer);
    });
  const fromBuffers = (list) =>
    (list || []).map((b) => {
      const bytes =
        b instanceof ArrayBuffer
          ? new Uint8Array(b)
          : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000)
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    });

  /** The comm a widget model talks through: to the kernel by way of the notebook view. */
  class Comm {
    constructor(id, target) {
      this.comm_id = id;
      this.target_name = target;
      this._onMsg = null;
      this._onClose = null;
      // Messages that came before the model listened (it's still being created).
      this._early = [];
      comms.set(id, this);
    }
    _send(kind, data, cbs, metadata, buffers) {
      const localId = ++localSeq;
      if (cbs) callbacks.set(localId, cbs);
      post({
        send: {
          localId,
          kind,
          comm_id: this.comm_id,
          data,
          metadata: metadata || {},
          buffers: fromBuffers(buffers),
        },
      });
      return String(localId);
    }
    open(data, cbs, metadata, buffers) {
      return this._send("comm_open", data, cbs, metadata, buffers);
    }
    send(data, cbs, metadata, buffers) {
      return this._send("comm_msg", data, cbs, metadata, buffers);
    }
    close(data, cbs, metadata, buffers) {
      comms.delete(this.comm_id);
      return this._send("comm_close", data, cbs, metadata, buffers);
    }
    on_msg(cb) {
      this._onMsg = cb;
      for (const m of this._early.splice(0)) cb(m);
    }
    on_close(cb) {
      this._onClose = cb;
    }
  }

  const msgOf = (m) => ({
    content: m.content,
    metadata: m.metadata || {},
    buffers: toBuffers(m.buffers),
    header: { msg_type: m.kind },
  });

  async function comm(m) {
    if (!manager) {
      queued.push(m);
      return;
    }
    const id = m.content?.comm_id;
    if (m.kind === "comm_open") {
      if (comms.has(id)) return;
      await manager.handle_comm_open(new Comm(id, m.content.target_name), msgOf(m));
    } else if (m.kind === "comm_msg") {
      const c = comms.get(id);
      if (c?._onMsg) c._onMsg(msgOf(m));
      else if (c) c._early.push(msgOf(m));
    } else if (m.kind === "comm_close") {
      const c = comms.get(id);
      comms.delete(id);
      if (c?._onClose) c._onClose(msgOf(m));
    }
  }

  /** Loads RequireJS and the widget manager (once). */
  function widgetManager() {
    managerReady ??= (async () => {
      await loadScript(`${cdn}requirejs@2.3.7/require.js`);
      const base = `${cdn}@jupyter-widgets/html-manager@1.0.15/dist/libembed-amd`;
      window.requirejs.config({
        paths: { "@jupyter-widgets/html-manager/dist/libembed-amd": base },
      });
      const lib = await new Promise((resolve, reject) =>
        window.requirejs(["@jupyter-widgets/html-manager/dist/libembed-amd"], resolve, reject),
      );
      const hm = await new Promise((resolve, reject) =>
        window.requirejs(["@jupyter-widgets/html-manager"], resolve, reject),
      );
      class IdeManager extends hm.HTMLManager {
        constructor() {
          super({ loader: lib.requireLoader });
        }
        _create_comm(target, modelId, data, metadata, buffers) {
          const c = comms.get(modelId) || new Comm(modelId, target);
          if (data !== undefined) c.open(data, undefined, metadata, buffers);
          return Promise.resolve(c);
        }
        _get_comm_info() {
          return Promise.resolve({});
        }
      }
      return new IdeManager();
    })();
    return managerReady;
  }

  async function widget(el, view, widgets, data) {
    try {
      const m = await widgetManager();
      for (const open of widgets.comms || []) {
        const id = open.content.comm_id;
        if (comms.has(id)) continue;
        await m.handle_comm_open(new Comm(id, open.content.target_name), msgOf(open));
      }
      manager = m;
      for (const q of queued.splice(0)) await comm(q);
      const model = await m.get_model(view.model_id);
      if (!model) throw new Error("its state isn't known: run the cell again");
      const v = await m.create_view(model, {});
      await m.display_view(v, el);
      if (!widgets.live) el.appendChild(note("Saved widget: run the notebook to use it."));
    } catch (err) {
      el.replaceChildren(
        note(
          `This widget can't be shown (${err?.message ? err.message : err}). Widgets need the internet the first time (their scripts come from a CDN).`,
        ),
      );
      if (data["text/plain"]) el.appendChild(pre(textOf(data["text/plain"])));
    }
  }

  // ---- An extension's renderer (D204) ------------------------------------------------------------
  const rendererListeners = new Set();
  let rendererState;

  // The network limit and hardening (harden.js, loaded first).
  const { limitNetwork, harden } = window.ideOutputSandbox;

  /** The renderer's module: imported (an ES module), else run with a module.exports object. */
  async function loadRenderer(code) {
    try {
      const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      try {
        const mod = await import(url);
        if (mod && typeof mod.activate === "function") return mod;
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch {
      // Not a module (or this engine can't import a blob): a classic script.
    }
    const module = { exports: {} };
    // Deliberate eval: the extension's renderer, in this sandbox.
    new Function("module", "exports", code)(module, module.exports);
    const mod = module.exports;
    if (mod && typeof mod.activate === "function") return mod;
    if (mod?.default && typeof mod.default.activate === "function") return mod.default;
    throw new Error("the renderer exports no activate(context)");
  }

  /** VS Code's output item: the output's data for one mime type. */
  function outputItem(output, mime) {
    const value = output.data?.[mime];
    const text = () =>
      typeof value === "string"
        ? value
        : Array.isArray(value)
          ? value.join("")
          : JSON.stringify(value);
    const bytes = () => {
      const t = text();
      // Pictures come base64-encoded in notebooks.
      if (/^image\//.test(mime) && mime !== "image/svg+xml" && typeof value === "string") {
        const bin = atob(t.replace(/\s+/g, ""));
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      }
      return new TextEncoder().encode(t);
    };
    return {
      id: "output",
      mime,
      metadata: output.metadata?.[mime] || output.metadata || {},
      text,
      json: () => (typeof value === "string" ? JSON.parse(value) : value),
      data: bytes,
      blob: () => new Blob([bytes()], { type: mime }),
    };
  }

  async function renderWithRenderer(el, r, output) {
    // Drawn again (the frame reloaded): the earlier drawing's listeners go.
    rendererListeners.clear();
    limitNetwork(r.network);
    harden();
    const mod = await loadRenderer(r.code);
    const api = await mod.activate({
      postMessage: (message) => post({ rendererMessage: message }),
      onDidReceiveMessage: (listener) => {
        rendererListeners.add(listener);
        return { dispose: () => rendererListeners.delete(listener) };
      },
      getState: () => rendererState,
      setState: (state) => {
        rendererState = state;
      },
      workspace: { isTrusted: true },
      rendererId: r.id,
    });
    if (!api || typeof api.renderOutputItem !== "function")
      throw new Error("activate() returned no renderOutputItem");
    await api.renderOutputItem(outputItem(output, r.mime), el, new AbortController().signal);
  }

  // ---- Render -----------------------------------------------------------------------------------
  async function render(r) {
    cdn = r.cdn || cdn;
    applyTheme(r.theme);
    out.replaceChildren();
    const data = r.output?.data || {};
    // Earlier outputs that set up libraries (a Bokeh load, init_notebook_mode's script).
    for (const js of r.preloads || []) runJs(js, document.createElement("div"));
    // The HTML outputs this one works on (Bokeh's plot element, its "Loading BokehJS" notice).
    for (const html of r.before || []) {
      const b = document.createElement("div");
      out.appendChild(b);
      await setHtml(b, html);
    }
    const el = document.createElement("div");
    out.appendChild(el);
    try {
      if (r.renderer) return await renderWithRenderer(el, r.renderer, r.output || {});
      const view = data["application/vnd.jupyter.widget-view+json"];
      if (view && r.widgets) return await widget(el, view, r.widgets, data);
      const fig = data["application/vnd.plotly.v1+json"];
      if (fig) return await plotly(el, fig, data);
      const bokehLoad = data["application/vnd.bokehjs_load.v0+json"];
      if (bokehLoad) {
        if (data["text/html"]) await setHtml(el, textOf(data["text/html"]));
        return runJs(textOf(bokehLoad), el);
      }
      if (data["text/html"]) {
        await setHtml(el, textOf(data["text/html"]));
        // Bokeh's show(): the document's script comes as JavaScript beside the HTML.
        if (data["application/vnd.bokehjs_exec.v0+json"] && data["application/javascript"])
          runJs(textOf(data["application/javascript"]), el);
        return;
      }
      if (data["application/javascript"]) return runJs(textOf(data["application/javascript"]), el);
      if (data["text/plain"]) el.appendChild(pre(textOf(data["text/plain"])));
    } catch (err) {
      post({ error: String(err?.message ? err.message : err) });
      el.appendChild(note(`This output failed: ${err?.message ? err.message : err}`));
    } finally {
      requestAnimationFrame(reportHeight);
    }
  }

  window.addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const m = e.data;
    if (!m || m.ns !== NS) return;
    if (m.ping) post({ ready: true });
    else if (m.render) void render(m.render);
    else if (m.comm) void comm(m.comm);
    else if (m.commDone) {
      const cbs = callbacks.get(m.commDone.localId);
      callbacks.delete(m.commDone.localId);
      if (cbs?.iopub?.status) cbs.iopub.status({ content: { execution_state: "idle" } });
    } else if (m.theme) applyTheme(m.theme);
    else if ("rendererMessage" in m)
      for (const listener of rendererListeners) {
        try {
          listener(m.rendererMessage);
        } catch (err) {
          post({ error: String(err?.message ? err.message : err) });
        }
      }
  });
  post({ ready: true });
})();

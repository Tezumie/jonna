// D295: the controller's output page script (src-tauri/notebook/output/notebook.js) run in a
// small fake page: preloads activate first and hear the controller's messages (those that came
// early too), renderers get VS Code's context and output items, messages go both ways, a missing
// renderer falls back to the output's text.
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import pageScript from "../../../../src-tauri/notebook/output/notebook.js?raw";

const NS = "ide-nb-page";
const tick = () => new Promise((r) => setTimeout(r, 0));
/** A value made in the fake page, as this realm's plain data. */
const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null));

interface FakeElement {
  tag: string;
  children: FakeElement[];
  className: string;
  textContent: string;
  dataset: Record<string, string>;
  style: Record<string, string>;
  offsetHeight: number;
  classList: { toggle(name: string, on?: boolean): void; has(name: string): boolean };
  appendChild(child: FakeElement): FakeElement;
  replaceChildren(...children: FakeElement[]): void;
  remove(): void;
  parent: FakeElement | null;
}

function element(tag: string): FakeElement {
  const classes = new Set<string>();
  const el: FakeElement = {
    tag,
    children: [],
    className: "",
    textContent: "",
    dataset: {},
    style: {},
    offsetHeight: 40,
    parent: null,
    classList: {
      toggle: (name, on) => {
        if (on ?? !classes.has(name)) classes.add(name);
        else classes.delete(name);
      },
      has: (name) => classes.has(name),
    },
    appendChild(child) {
      child.parent = el;
      el.children.push(child);
      return child;
    },
    replaceChildren(...children) {
      el.children = [];
      for (const c of children) el.appendChild(c);
    },
    remove() {
      if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el);
      el.parent = null;
    },
  };
  return el;
}

function page(windowExtra: Record<string, unknown> = {}) {
  const posted: Record<string, unknown>[] = [];
  const root = element("div");
  let onMessage: (e: { source: unknown; data: unknown }) => void = () => {};
  const parent = { postMessage: (m: Record<string, unknown>) => posted.push(m) };
  const sizes: { cb: (entries: { target: FakeElement }[]) => void; seen: FakeElement[] }[] = [];
  const context = vm.createContext({
    parent,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    JSON,
    Map,
    Set,
    TextEncoder,
    Uint8Array,
    Object,
    Number,
    String,
    Error,
    atob,
    requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
    // Import of a blob fails here: the page's classic-script path runs the modules.
    URL: {
      createObjectURL: () => {
        throw new Error("no blobs here");
      },
      revokeObjectURL: () => {},
    },
    Blob: class {
      constructor(readonly parts: unknown[]) {}
    },
    AbortController,
    ResizeObserver: class {
      seen: FakeElement[] = [];
      constructor(cb: (entries: { target: FakeElement }[]) => void) {
        sizes.push({ cb, seen: this.seen });
      }
      observe(el: FakeElement) {
        this.seen.push(el);
      }
      unobserve() {}
    },
    getComputedStyle: () => ({ getPropertyValue: () => "#1e1e1e" }),
    Element: class {},
    document: {
      getElementById: () => root,
      createElement: (tag: string) => element(tag),
      addEventListener: () => {},
      documentElement: { style: { setProperty: () => {} } },
      body: { classList: { toggle: () => {} }, dataset: {} },
    },
    window: {} as Record<string, unknown>,
  });
  const win = context.window as Record<string, unknown>;
  win.ideOutputSandbox = { limitNetwork: () => {}, harden: () => {} };
  Object.assign(win, windowExtra);
  win.addEventListener = (type: string, h: typeof onMessage) => {
    if (type === "message") onMessage = h;
  };
  vm.runInContext(pageScript, context);
  const send = (m: Record<string, unknown>) =>
    onMessage({ source: parent, data: { ns: NS, ...m } });
  return { posted, root, send, context, sizes };
}

const PRELOAD = `module.exports = {
  activate(ctx) {
    globalThis.heard = [];
    ctx.onDidReceiveKernelMessage((m) => globalThis.heard.push(m));
    ctx.postKernelMessage({ type: "IPyWidgets_Request_Widget_Version" });
    globalThis.preloaded = true;
  },
};`;

const RENDERER = `module.exports = {
  activate(ctx) {
    globalThis.trusted = ctx.workspace.isTrusted;
    ctx.onDidReceiveMessage((m) => (globalThis.rendererHeard = m));
    return {
      renderOutputItem(item, element) {
        if (!globalThis.preloaded) throw new Error("rendered before the preloads");
        element.textContent = item.json().model_id + ":" + item.mime;
        globalThis.rendered = item.id;
        ctx.postMessage({ command: "query-widget-state", model_id: item.json().model_id });
      },
      disposeOutputItem(id) {
        globalThis.disposed = id;
      },
    };
  },
};`;

test("D295: the page runs preloads, then renderers, with messages both ways", async () => {
  const p = page();
  assert.deepEqual(plain(p.posted[0]), { ns: NS, ready: true });
  // A controller's message and an output before the page has its preloads: they wait.
  p.send({ kernelMessage: { type: "early" } });
  p.send({ renderer: { id: "widgets", code: RENDERER, mimeTypes: ["x/widget"] } });
  p.send({
    render: {
      id: "o1",
      rendererId: "widgets",
      mime: "x/widget",
      items: [
        { mime: "x/widget", value: { model_id: "m1" }, metadata: {} },
        { mime: "text/plain", value: "IntSlider()", metadata: {} },
      ],
    },
  });
  p.send({
    init: {
      preloads: [{ id: "jupyter/kernel.js", code: PRELOAD }],
      network: "any",
      theme: {},
      trusted: true,
      settings: {},
    },
  });
  for (let i = 0; i < 20 && !p.context.rendered; i++) await tick();
  const c = p.context as Record<string, unknown>;
  assert.equal(c.rendered, "o1");
  assert.equal(c.trusted, true);
  assert.deepEqual(plain(c.heard), [{ type: "early" }]);
  const out = p.root.children[0];
  assert.equal(out?.dataset.output, "o1");
  assert.equal(out?.children[0]?.textContent, "m1:x/widget");
  const bodies = p.posted.map(({ ns: _ns, ...rest }) => rest);
  assert.ok(
    bodies.some(
      (m) =>
        JSON.stringify(m) ===
        JSON.stringify({ kernelMessage: { type: "IPyWidgets_Request_Widget_Version" } }),
    ),
  );
  assert.ok(
    bodies.some(
      (m) =>
        JSON.stringify(m) ===
        JSON.stringify({
          rendererMessage: {
            rendererId: "widgets",
            message: { command: "query-widget-state", model_id: "m1" },
          },
        }),
    ),
  );
  // The extension's messages reach the renderer and the preloads.
  p.send({ rendererMessage: { rendererId: "widgets", message: { command: "ok" } } });
  p.send({ kernelMessage: { type: "IPyWidgets_Reply_Widget_Version", payload: 8 } });
  assert.deepEqual(plain(c.rendererHeard), { command: "ok" });
  assert.deepEqual(plain((c.heard as unknown[]).at(-1)), {
    type: "IPyWidgets_Reply_Widget_Version",
    payload: 8,
  });
  // Placed where the IDE says; its height goes back.
  p.send({ layout: [{ id: "o1", top: 120, left: 8, width: 600, visible: true }] });
  assert.equal(out?.style.top, "120px");
  assert.ok(out?.classList.has("is-visible"));
  for (const s of p.sizes) s.cb(s.seen.map((target) => ({ target })));
  for (let i = 0; i < 5; i++) await tick();
  assert.ok(bodies.length < p.posted.length);
  assert.deepEqual(plain(p.posted.at(-1)), { ns: NS, heights: [{ id: "o1", height: 40 }] });
  p.send({ dispose: { id: "o1" } });
  assert.equal(c.disposed, "o1");
  assert.equal(p.root.children.length, 0);
});

test("outputs that run code are drawn by the page itself, sharing its window", async () => {
  const p = page();
  p.send({ init: { preloads: [], network: "none", theme: {}, trusted: true, settings: {} } });
  // An earlier output sets a library up; a later one uses it (Bokeh's load, then show()).
  const js = (id: string, code: string) =>
    p.send({
      render: {
        id,
        rendererId: "ide.builtin",
        mime: "application/javascript",
        items: [{ mime: "application/javascript", value: code, metadata: {} }],
        before: [],
        cdn: "https://cdn.example/npm/",
      },
    });
  js("b1", "window.lib = { draw: (el) => { el.textContent = 'drawn'; } };");
  js("b2", "window.lib.draw(element);");
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(p.root.children[1]?.children[0]?.textContent, "drawn");
  // No script was asked of the IDE for the page's own renderer.
  assert.ok(!p.posted.some((m) => "needRenderer" in m));
});

test("a fetch of VS Code's webview address of a local file asks the IDE for it", async () => {
  const fetched: unknown[] = [];
  const p = page({
    fetch: (input: unknown) => {
      fetched.push(input);
      return Promise.resolve("response");
    },
  });
  p.context.URL = {
    createObjectURL: (b: { parts: unknown[] }) => `blob:${String(b.parts[0])}`,
    revokeObjectURL: () => {},
  };
  const win = p.context.window as { fetch(u: string): Promise<unknown> };
  const url = "https://file%2B.vscode-resource.vscode-cdn.net/c%3A/ext/temp/widgets/index.js";
  const got = win.fetch(url);
  await tick();
  const asked = p.posted.find((m) => "resource" in m)?.resource as { id: number; url: string };
  assert.equal(asked?.url, url);
  p.send({ init: { preloads: [], network: "none", theme: {}, trusted: true, settings: {} } });
  p.send({ resourceData: { id: asked.id, data: "BYTES", type: "text/javascript" } });
  assert.equal(await got, "response");
  assert.deepEqual(fetched, ["blob:BYTES"]);
  // Other addresses go out as they are.
  await win.fetch("https://example.com/x.js");
  assert.equal(fetched.at(-1), "https://example.com/x.js");
});

test("D295: an output whose renderer can't load shows why, and its text", async () => {
  const p = page();
  p.send({ init: { preloads: [], network: "none", theme: {}, trusted: false, settings: {} } });
  p.send({
    render: {
      id: "o2",
      rendererId: "missing",
      mime: "x/y",
      items: [
        { mime: "x/y", value: "?", metadata: {} },
        { mime: "text/plain", value: "the text", metadata: {} },
      ],
    },
  });
  for (let i = 0; i < 10 && !p.posted.some((m) => m.needRenderer); i++) await tick();
  assert.ok(p.posted.some((m) => m.needRenderer === "missing"));
  p.send({ renderer: { id: "missing", error: "No renderer missing." } });
  for (let i = 0; i < 10; i++) await tick();
  const inner = p.root.children[0]?.children[0];
  assert.match(inner?.children[0]?.textContent ?? "", /No renderer missing/);
  assert.equal(inner?.children[1]?.textContent, "the text");
});

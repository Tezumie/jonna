// One output page per notebook whose kernel is a VS Code controller (D295), as VS Code's
// back-layer webview: a single sandboxed frame (the output origin's notebook.html) lies over the
// cell list and draws every output an extension's renderer takes, each placed over the slot its
// cell keeps for it (the slot gets the height the page reports). The page loads the extensions'
// `notebookPreload` scripts once, before any renderer; their postKernelMessage reaches the
// controller (its onDidReceiveMessage) and the controller's postMessage reaches them, so
// Jupyter's ipywidgets kernel side and its widget renderer share one page as in VS Code.
// The frame's clip path is the union of the slots' visible rectangles (notebookPageModel.ts): it
// takes the pointer there only, and the cells stay usable everywhere else.
//
// Why one overlay rather than a frame per output with a shared context: Jupyter's renderer
// finds the widget manager its preload made through `window` (`window.ipywidgetsKernel`), so
// the preloads and every renderer must run in the same page, and only that page can draw.
import { h } from "../../../core/dom/index";
import type { Disposable } from "../../../core/lifecycle/index";
import { DisposableStore } from "../../../core/lifecycle/index";
import type { NotebookKernel, NotebookRenderer } from "../../../core/notebook/providers";
import { pathKey } from "../../../core/paths/index";
import type { WorkbenchServices } from "../../../workbench/services";
import type { NbOutput } from "./model";
import {
  changedPlaces,
  clipPathOf,
  outputItems,
  type Rect,
  readHeights,
  resourcePathOf,
  resourceType,
  type SlotPlace,
  visibleRect,
} from "./notebookPageModel";
import { outputOrigin, themeVars } from "./outputFrame";

const NS = "ide-nb-page";

export interface NotebookPageDeps {
  services: WorkbenchServices;
  /** The cell list (the scroller the page lies in). */
  list(): HTMLElement;
  path(): string;
  notebookType(): string;
  kernel(): NotebookKernel | null;
  openLink(url: string): void;
  /** Where the page's own outputs load their libraries from (notebook.output.cdn). */
  cdn(): string;
}

interface Slot {
  element: HTMLElement;
  output: NbOutput;
  /** An extension's renderer, or the page's own (BUILTIN_RENDERER: outputs that run code). */
  renderer: NotebookRenderer | null;
  mime: string;
  /** The page's own: the HTML outputs drawn before a script output (Bokeh's element). */
  before?: readonly NbOutput[];
}

/**
 * The page's own renderer (notebook.js): outputs the IDE draws itself that run code (HTML with
 * scripts, JavaScript, Plotly, Bokeh), drawn in the page as VS Code draws every output in its
 * one webview, so they share its window with the extensions' renderers and preloads.
 */
export const BUILTIN_RENDERER = "ide.builtin";

type Network = "none" | "any" | readonly string[];

/** The widest of several extensions' networks ("any" wins; else every host). */
function unionNetwork(list: readonly Network[]): "none" | "any" | string[] {
  if (list.includes("any")) return "any";
  const hosts = [...new Set(list.flatMap((n) => (typeof n === "string" ? [] : [...n])))];
  return hosts.length ? hosts : "none";
}

export class NotebookOutputPage implements Disposable {
  private readonly store = new DisposableStore();
  private readonly frame: HTMLIFrameElement;
  private readonly slots = new Map<string, Slot>();
  private places = new Map<string, SlotPlace>();
  private seq = 0;
  /** The page answered and has its preloads: messages go straight in. */
  private initialized = false;
  private initializing = false;
  private listening: Window | null = null;
  /** Messages for the page until it's initialized. */
  private queue: Record<string, unknown>[] = [];
  private readonly sentRenderers = new Set<string>();
  private layoutFrame = 0;
  private readonly resize: ResizeObserver;
  private readonly mutations: MutationObserver;
  private generation = 0;

  constructor(private readonly deps: NotebookPageDeps) {
    this.frame = h("iframe", {
      class: "nb-page-frame",
      // Scripts only: no same-origin (it can't reach the IDE), no forms, no popups (links go
      // through the IDE, as renderers' do).
      sandbox: "allow-scripts",
      title: "Outputs",
      loading: "eager",
      tabindex: "-1",
    }) as HTMLIFrameElement;
    this.frame.style.height = "0px";
    this.frame.style.clipPath = clipPathOf([]);
    const list = deps.list();
    list.append(this.frame);
    this.store.add({ dispose: () => this.frame.remove() });
    this.resize = new ResizeObserver(() => this.schedule());
    this.resize.observe(list);
    this.mutations = new MutationObserver((records) => {
      // The page's own frame changing isn't a layout change.
      if (records.every((r) => r.target === this.frame)) return;
      this.schedule();
    });
    this.mutations.observe(list, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "hidden"],
    });
    const onScroll = (e: Event) => {
      // The list scrolls the page with it; an outputs area scrolling inside it moves its slots.
      if (e.target !== list) this.schedule();
    };
    list.addEventListener("scroll", onScroll, true);
    this.store.add({
      dispose: () => {
        this.resize.disconnect();
        this.mutations.disconnect();
        list.removeEventListener("scroll", onScroll, true);
        cancelAnimationFrame(this.layoutFrame);
      },
    });
    // The controller's messages for this notebook (VS Code's NotebookController.postMessage).
    this.store.add(
      deps.services.notebooks.registerKernelPage({
        source: () => deps.kernel()?.option.source ?? null,
        path: () => deps.path(),
        post: (message) => {
          this.send({ kernelMessage: message });
          return true;
        },
      }),
    );
    // Renderers' messages from their extensions (createRendererMessaging's postMessage).
    this.store.add(
      deps.services.notebooks.onRendererMessage((m) => {
        if (m.path && pathKey(m.path) !== pathKey(deps.path())) return;
        this.send({ rendererMessage: { rendererId: m.renderer, message: m.message } });
      }),
    );
    this.listen();
    let loads = 0;
    this.frame.addEventListener("load", () => {
      const before = this.listening;
      this.listen();
      // Its first load usually said it's ready already. Loaded again (moved to another window,
      // put back in the list), or never heard: asked again; it starts over.
      const heard = this.initialized || this.initializing;
      if (++loads > 1 || before !== this.listening || !heard) {
        this.reloaded();
        this.frame.contentWindow?.postMessage({ ns: NS, ping: true }, "*");
      }
    });
    void outputOrigin().then(
      (origin) => {
        if (!this.store.isDisposed) this.frame.src = `${origin}/notebook.html`;
      },
      () => {},
    );
  }

  /** The page loaded again (moved, emptied list): it starts over; an init under way is dropped. */
  private reloaded(): void {
    if (this.initialized || this.initializing) this.generation++;
    this.initialized = false;
    this.initializing = false;
  }

  private listen(): void {
    const win = this.frame.ownerDocument.defaultView;
    if (!win || win === this.listening) return;
    this.listening?.removeEventListener("message", this.onMessage);
    win.addEventListener("message", this.onMessage);
    this.listening = win;
  }

  /** A slot for output `o`, drawn by `renderer` for its `mime`; disposing it takes it away. */
  slot(
    o: NbOutput,
    renderer: NotebookRenderer | null,
    mime: string,
    before?: readonly NbOutput[],
  ): Disposable & { element: HTMLElement } {
    const id = `o${++this.seq}`;
    const element = h("div", { class: "nb-page-slot", "data-output": id });
    element.style.height = "0px";
    const slot: Slot = { element, output: o, renderer, mime, ...(before?.length && { before }) };
    this.slots.set(id, slot);
    this.resize.observe(element);
    this.sendRender(id, slot);
    this.schedule();
    return {
      element,
      dispose: () => {
        if (!this.slots.delete(id)) return;
        this.resize.unobserve(element);
        this.places.delete(id);
        this.send({ dispose: { id } });
        this.schedule();
      },
    };
  }

  /** The IDE's colors changed. */
  sendTheme(): void {
    if (this.initialized) this.post({ theme: themeVars() });
  }

  private sendRender(id: string, slot: Slot): void {
    const { renderer, mime, output } = slot;
    this.send({
      render: {
        id,
        rendererId: renderer?.id ?? BUILTIN_RENDERER,
        mime,
        items: outputItems(output.data ?? {}, output.metadata ?? {}),
        ...(!renderer && {
          before: (slot.before ?? []).flatMap((b) => {
            const html = b.data?.["text/html"];
            return typeof html === "string" ? [html] : Array.isArray(html) ? [html.join("")] : [];
          }),
          cdn: this.deps.cdn(),
        }),
      },
    });
  }

  private send(message: Record<string, unknown>): void {
    if (this.store.isDisposed) return;
    if (!this.initialized) {
      // A page that never answers mustn't grow this without end.
      if (this.queue.length < 5000) this.queue.push(message);
      return;
    }
    this.sendNow(message);
  }

  /** Messages go out one after another: a renderer's script (read first) never overtakes. */
  private outbox: Promise<void> = Promise.resolve();

  /** Sends a renderer's script first, the first time the page needs it; order is kept. */
  private sendNow(message: Record<string, unknown>): void {
    const generation = this.generation;
    const render = message.render as { rendererId?: string } | undefined;
    const rendererId =
      render?.rendererId &&
      render.rendererId !== BUILTIN_RENDERER &&
      !this.sentRenderers.has(render.rendererId)
        ? render.rendererId
        : null;
    if (rendererId) this.sentRenderers.add(rendererId);
    this.outbox = this.outbox
      .then(async () => {
        if (rendererId) await this.sendRenderer(rendererId);
        if (generation === this.generation && !this.store.isDisposed) this.post(message);
      })
      .catch(() => {});
  }

  private async sendRenderer(id: string): Promise<void> {
    const generation = this.generation;
    const renderer = this.deps.services.notebooks.renderer(id);
    let code: string | null = null;
    let error: string | undefined;
    try {
      code = renderer ? await renderer.code() : null;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    if (generation !== this.generation) return;
    this.post({
      renderer: {
        id,
        ...(code !== null ? { code, mimeTypes: renderer?.mimeTypes ?? [] } : {}),
        ...(error || !renderer ? { error: error ?? `No renderer ${id}.` } : {}),
      },
    });
  }

  private post(message: Record<string, unknown>): void {
    this.frame.contentWindow?.postMessage({ ns: NS, ...message }, "*");
  }

  /** The page said it's ready: its preloads, then what waited. */
  private async init(): Promise<void> {
    const generation = ++this.generation;
    this.sentRenderers.clear();
    const { services } = this.deps;
    const preloads = await services.notebooks.preloadsFor(this.deps.notebookType());
    const codes = await Promise.all(
      preloads.map((p) =>
        p.code().then(
          (code) => ({ id: p.id, code }),
          (err: unknown) => ({
            id: p.id,
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      ),
    );
    // The controller's own scripts (VS Code's rendererScripts) after the contributed preloads.
    const kernelScripts =
      (await this.deps
        .kernel()
        ?.messaging?.rendererScripts?.()
        .catch(() => [])) ?? [];
    codes.push(...kernelScripts);
    if (generation !== this.generation || this.store.isDisposed) return;
    // The page's own outputs load Plotly from the notebook's CDN (as their own frames do); the
    // rest is what the extensions in it were allowed.
    const cdnHost = /^https:\/\/([^/?#]+)/i.exec(this.deps.cdn())?.[1]?.toLowerCase();
    const network = unionNetwork([
      ...preloads.map((p) => p.network()),
      ...services.notebooks.allRenderers().map((r) => r.network()),
      cdnHost ? [cdnHost] : "none",
    ]);
    this.post({
      init: {
        preloads: codes,
        network: typeof network === "string" ? network : [...network],
        theme: themeVars(),
        trusted: services.trust.state.peek() === "trusted",
        settings: {
          lineLimit: services.settings.peek<number>("notebook.output.textLineLimit") ?? 30,
          outputScrolling: services.settings.peek<boolean>("notebook.output.scrolling") !== false,
          outputWordWrap: services.settings.peek<boolean>("notebook.output.wordWrap") === true,
          linkifyFilePaths: true,
          minimalError: false,
        },
      },
    });
    this.initialized = true;
    this.places = new Map();
    // A reload starts over: every slot is drawn again.
    const queued = this.queue;
    this.queue = [];
    const rendered = new Set<string>();
    for (const m of queued) {
      const r = m.render as { id?: string } | undefined;
      if (r?.id) rendered.add(r.id);
      this.sendNow(m);
    }
    for (const [id, slot] of this.slots) if (!rendered.has(id)) this.sendRender(id, slot);
    this.schedule();
  }

  /** Messages from the page: only this frame's. */
  private readonly onMessage = (e: MessageEvent): void => {
    if (e.source !== this.frame.contentWindow) return;
    const m = e.data as Record<string, unknown> | null;
    if (!m || m.ns !== NS) return;
    if (m.ready) {
      // Once per load (it says so on load and again when asked).
      if (!this.initialized && !this.initializing) {
        this.initializing = true;
        void this.init().finally(() => {
          this.initializing = false;
        });
      }
      return;
    }
    if ("heights" in m) {
      for (const { id, height } of readHeights(m.heights)) {
        const slot = this.slots.get(id);
        if (slot) slot.element.style.height = `${Math.ceil(height)}px`;
      }
      this.schedule();
    } else if ("kernelMessage" in m) this.deps.kernel()?.messaging?.post(m.kernelMessage);
    else if ("rendererMessage" in m) this.fromRenderer(m.rendererMessage);
    else if (typeof m.needRenderer === "string") {
      if (!this.sentRenderers.has(m.needRenderer)) {
        const id = m.needRenderer;
        this.sentRenderers.add(id);
        this.outbox = this.outbox.then(() => this.sendRenderer(id)).catch(() => {});
      }
    } else if ("resource" in m) void this.resource(m.resource);
    else if (typeof m.link === "string") this.link(m.link);
    else if (typeof m.error === "string") console.warn(`Notebook output: ${m.error}`);
  };

  /** Renderers' messages for their extensions: at most 200 a second, 1 MB each. */
  private sent = { second: 0, count: 0 };
  private fromRenderer(raw: unknown): void {
    const r = (raw ?? {}) as { rendererId?: unknown; message?: unknown };
    if (typeof r.rendererId !== "string") return;
    const second = Math.floor(Date.now() / 1000);
    if (second !== this.sent.second) this.sent = { second, count: 0 };
    if (++this.sent.count > 200) return;
    try {
      if (JSON.stringify(r.message ?? null).length > 1_000_000) return;
    } catch {
      return;
    }
    this.deps.services.notebooks.renderer(r.rendererId)?.receive(r.message, this.deps.path());
  }

  /** Files the page asked for: 2000 per page, 32 MB each. */
  private resources = 0;

  /**
   * A file the page loads by one of VS Code's webview addresses (a controller's asWebviewUri:
   * widget modules Jupyter copies into its folder): read by the kernel's extension (its own
   * folder or the workspace's), sent back as bytes the page makes a blob of.
   */
  private async resource(raw: unknown): Promise<void> {
    const r = (raw ?? {}) as { id?: unknown; url?: unknown };
    if (typeof r.id !== "number" || typeof r.url !== "string") return;
    const generation = this.generation;
    const answer = (body: Record<string, unknown>) => {
      if (generation === this.generation && !this.store.isDisposed)
        this.post({ resourceData: { id: r.id, ...body } });
    };
    const path = resourcePathOf(r.url);
    const read = this.deps.kernel()?.messaging?.readResource;
    if (!path || !read || ++this.resources > 2000)
      return answer({ error: `${r.url} can't be loaded here.` });
    try {
      const data = await read(path);
      if (data.byteLength > 32 * 1024 * 1024) throw new Error(`${path} is too large.`);
      answer({ data, type: resourceType(path) });
    } catch (err) {
      answer({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  private lastLink = 0;
  /** A link clicked in an output: only right after a click in the page (as output frames'). */
  private link(href: string): void {
    const doc = this.frame.ownerDocument;
    const clicked = doc.activeElement === this.frame && doc.hasFocus();
    const now = Date.now();
    if (!clicked || now - this.lastLink < 1000) return;
    this.lastLink = now;
    this.deps.openLink(href);
  }

  private schedule(): void {
    if (this.layoutFrame || this.store.isDisposed) return;
    this.layoutFrame = requestAnimationFrame(() => {
      this.layoutFrame = 0;
      this.layout();
    });
  }

  /** Where each slot is now: the page's elements follow, the clip path shows only them. */
  private layout(): void {
    const list = this.deps.list();
    // The list was emptied (a notebook that failed to load, then loaded): the page comes back
    // (it reloads, and draws every slot again).
    if (!this.frame.isConnected && this.slots.size) list.append(this.frame);
    const origin = this.frame.getBoundingClientRect();
    const now: SlotPlace[] = [];
    const shown: Rect[] = [];
    let bottom = 0;
    for (const [id, slot] of this.slots) {
      const el = slot.element;
      const r = el.isConnected ? el.getBoundingClientRect() : null;
      if (!r || (r.width === 0 && r.height === 0 && !el.offsetParent)) {
        now.push({ id, top: 0, left: 0, width: 0, visible: false });
        continue;
      }
      const place = { id, top: r.top - origin.top, left: r.left - origin.left, width: r.width };
      now.push({ ...place, visible: true });
      bottom = Math.max(bottom, place.top + r.height);
      // Areas that clip it (a collapsed or scrolling outputs area).
      const clips: Rect[] = [];
      for (let p = el.parentElement; p && p !== list; p = p.parentElement) {
        const style = getComputedStyle(p);
        if (style.overflowX !== "visible" || style.overflowY !== "visible") {
          const c = p.getBoundingClientRect();
          clips.push({ left: c.left, top: c.top, width: c.width, height: c.height });
        }
      }
      const v = visibleRect({ left: r.left, top: r.top, width: r.width, height: r.height }, clips);
      if (v) shown.push({ ...v, left: v.left - origin.left, top: v.top - origin.top });
    }
    const height = `${Math.ceil(bottom)}px`;
    if (this.frame.style.height !== height) this.frame.style.height = height;
    const clip = clipPathOf(shown);
    if (this.frame.style.clipPath !== clip) this.frame.style.clipPath = clip;
    if (!this.initialized) return;
    const changed = changedPlaces(this.places, now);
    this.places = new Map(now.map((p) => [p.id, p]));
    // After the renders before it (an output's element exists by then).
    if (changed.length) this.sendNow({ layout: changed });
  }

  dispose(): void {
    this.listening?.removeEventListener("message", this.onMessage);
    this.listening = null;
    this.slots.clear();
    this.queue = [];
    this.store.dispose();
  }
}

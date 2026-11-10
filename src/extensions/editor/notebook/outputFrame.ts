// Outputs that run code (D189) — HTML with scripts, JavaScript, Plotly, Bokeh, Jupyter widgets —
// each in a frame: a page of the IDE's (src-tauri/notebook/output) served on a local origin of
// its own and sandboxed without same-origin, so the output's code can't reach the IDE. The page
// and the notebook talk by messages: the output to draw, the IDE's colors, its height, links,
// and widgets' comm messages (to and from the kernel, through the notebook's WidgetStore). An
// extension's output renderer (D204) runs in such a frame too, limited to the network its
// extension was allowed (a content security policy), with messages to and from the extension.
import { h } from "../../../core/dom/index";
import { call } from "../../../core/ipc/invoke";
import type { Disposable } from "../../../core/lifecycle/index";
import { DisposableStore } from "../../../core/lifecycle/index";
import { THEME_TOKENS } from "../../extensions/webview";
import type { NbOutput } from "./model";
import type { CommMessage, WidgetStore } from "./widgets";

const NS = "ide-nb-out";
const WIDGET_VIEW = "application/vnd.jupyter.widget-view+json";

let origin: Promise<string> | null = null;
/** The output page's origin (its proxy starts on first use). */
export function outputOrigin(): Promise<string> {
  origin ??= call<string>("notebook_output_origin").catch((err: unknown) => {
    origin = null;
    throw err;
  });
  return origin;
}

export interface FrameContext {
  /** Where the page loads its libraries from (notebook.output.cdn). */
  cdn(): string;
  /** The notebook's widgets, and whether a kernel is behind them. */
  widgets(): { store: WidgetStore; live: boolean };
  /** Sends a widget's message to the kernel; true once it was handled. */
  sendComm(
    kind: "comm_msg" | "comm_close",
    commId: string,
    data: unknown,
    metadata: unknown,
    buffers: string[],
  ): Promise<boolean>;
  openLink(url: string): void;
  /** The tallest a frame grows (long outputs scroll inside it), null: no limit. */
  maxHeight(): number | null;
}

/** An extension's renderer drawing this output (D204). */
export interface RendererBinding {
  id: string;
  /** The output's mime type it draws. */
  mime: string;
  code(): Promise<string>;
  network(): "none" | "any" | readonly string[];
  /** The frame's message for the extension. */
  send(message: unknown): void;
  /** The extension's messages for the frame. */
  onMessage(listener: (message: unknown) => void): Disposable;
}

const asText = (v: unknown): string =>
  typeof v === "string" ? v : Array.isArray(v) ? v.join("") : "";

/** HTML that needs its scripts (more than a stray <script> next to real content). */
const scriptedHtml = (html: string) => /<script\b/i.test(html);

/**
 * Whether an output is drawn in a frame: it carries code to run. A widget only when there is
 * state for it (else its text says what it was); scripted HTML too, unless it brings its own
 * picture (matplotlib's interactive backends send a PNG beside it).
 */
export function needsFrame(o: NbOutput, widgets: WidgetStore | null): boolean {
  const data = o.data ?? {};
  const view = data[WIDGET_VIEW] as { model_id?: string } | undefined;
  if (view?.model_id) return !!widgets?.has(view.model_id);
  if (
    "application/vnd.plotly.v1+json" in data ||
    "application/vnd.bokehjs_load.v0+json" in data ||
    "application/vnd.bokehjs_exec.v0+json" in data
  )
    return true;
  const html = asText(data["text/html"]);
  if (html && scriptedHtml(html)) return !("image/png" in data);
  return "application/javascript" in data && !("text/html" in data);
}

/** Code an earlier output ran to set a library up for later ones (Bokeh's output_notebook). */
export function preloadOf(o: NbOutput): string | null {
  const load = o.data?.["application/vnd.bokehjs_load.v0+json"];
  return load ? asText(load) : null;
}

/** An output whose code needs the set-up of earlier outputs (Bokeh's show()). */
export function needsPreloads(o: NbOutput): boolean {
  return !!o.data && "application/vnd.bokehjs_exec.v0+json" in o.data;
}

/** A script output (JavaScript, a Bokeh load or show) that works on the HTML shown before it. */
const scriptOnly = (o: NbOutput) => {
  const data = o.data ?? {};
  return (
    ("application/javascript" in data ||
      "application/vnd.bokehjs_load.v0+json" in data ||
      "application/vnd.bokehjs_exec.v0+json" in data) &&
    !("text/html" in data)
  );
};
const plainHtml = (o: NbOutput) =>
  o.output_type === "display_data" &&
  !!o.data &&
  "text/html" in o.data &&
  Object.keys(o.data).every((k) => k === "text/html" || k === "text/plain");

/**
 * Outputs that go together (D189): Bokeh (and classic-notebook JavaScript) sends the element to
 * draw in as one HTML output and the script that fills it as the next, as Jupyter shares one
 * page between them. Here each runs in a frame: the HTML right before a script output goes into
 * that script's frame (by index), and isn't drawn on its own.
 */
export function outputGroups(outputs: readonly NbOutput[]): {
  /** Indices drawn inside a later output's frame. */
  companions: Set<number>;
  /** A script output's index → the HTML outputs drawn before it in its frame. */
  before: Map<number, NbOutput[]>;
} {
  const companions = new Set<number>();
  const before = new Map<number, NbOutput[]>();
  outputs.forEach((o, i) => {
    if (!scriptOnly(o)) return;
    const html: NbOutput[] = [];
    for (let j = i - 1; j >= 0; j--) {
      const prev = outputs[j];
      if (!prev || !plainHtml(prev) || companions.has(j)) break;
      html.unshift(prev);
      companions.add(j);
    }
    if (html.length) before.set(i, html);
  });
  return { companions, before };
}

/** The IDE's colors for an output page (its tokens' values now). */
export const themeVars = (): Record<string, string> => {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    THEME_TOKENS.map((t) => [t, style.getPropertyValue(t).trim()]).filter(([, v]) => v),
  );
};

/** Every live frame: the theme goes to all of them when it changes. */
const frames = new Set<OutputFrame>();
export function refreshFrameThemes(): void {
  for (const f of frames) f.sendTheme();
}

export class OutputFrame {
  readonly element: HTMLElement;
  private readonly frame: HTMLIFrameElement;
  private readonly store = new DisposableStore();
  private ready = false;
  private listening: Window | null = null;
  private height = 24;

  constructor(
    private readonly ctx: FrameContext,
    private readonly output: NbOutput,
    private readonly preloads: string[],
    /** HTML outputs that belong to this one (drawn first, in the same page). */
    private readonly before: NbOutput[] = [],
    private readonly renderer: RendererBinding | null = null,
  ) {
    this.frame = h("iframe", {
      class: "nb-out-frame",
      // Scripts only: no same-origin (it can't reach the IDE), no forms, no navigating the IDE.
      // An extension's renderer gets no popups either (its links go through the IDE like
      // everyone's): a popup would be a way around the network it was granted (D204 audit).
      sandbox: renderer
        ? "allow-scripts"
        : "allow-scripts allow-popups allow-popups-to-escape-sandbox",
      title: "Output",
      loading: "eager",
    }) as HTMLIFrameElement;
    this.frame.style.height = `${this.height}px`;
    this.element = h("div", { class: "nb-out-frame-box" }, this.frame);
    frames.add(this);
    this.store.add({ dispose: () => frames.delete(this) });
    // The page says it's ready while loading (heard here); a view in another window hears it
    // there, once loaded: it's asked again then.
    this.listen();
    this.frame.addEventListener("load", () => {
      const before = this.listening;
      this.listen();
      // Reloaded in another window (moving a view adopts its frame, which reloads it): the
      // ready message went where nobody listened; asked again.
      if (!this.ready || before !== this.listening) {
        this.ready = false;
        this.frame.contentWindow?.postMessage({ ns: NS, ping: true }, "*");
      }
    });
    if (renderer)
      this.store.add(renderer.onMessage((message) => this.post({ rendererMessage: message })));
    this.store.add(
      ctx.widgets().store.onMessage(({ message, from }) => {
        // A frame's own change isn't sent back to it.
        if (this.needsWidgets() && from !== this) this.post({ comm: message });
      }),
    );
    void outputOrigin().then(
      (o) => {
        if (this.store.isDisposed) return;
        this.frame.src = `${o}/index.html`;
      },
      (err: unknown) => {
        this.element.replaceChildren(
          h(
            "div",
            { class: "nb-out-note" },
            `This output can't be shown: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      },
    );
  }

  private needsWidgets(): boolean {
    return !!this.output.data?.[WIDGET_VIEW];
  }

  private listen(): void {
    const win = this.frame.ownerDocument.defaultView;
    if (!win || win === this.listening) return;
    this.listening?.removeEventListener("message", this.onMessage);
    win.addEventListener("message", this.onMessage);
    this.listening = win;
  }

  private readonly onMessage = (e: MessageEvent): void => {
    if (e.source !== this.frame.contentWindow) return;
    const m = e.data as Record<string, unknown> | null;
    if (!m || m.ns !== NS) return;
    if (m.ready) {
      this.ready = true;
      this.render();
    } else if (typeof m.height === "number") this.setHeight(m.height);
    else if (typeof m.link === "string") this.link(m.link);
    else if ("rendererMessage" in m && this.renderer) this.fromRenderer(m.rendererMessage);
    else if (m.send && typeof m.send === "object" && this.needsWidgets())
      // Only a widget's frame talks to the kernel.
      this.forward(m.send as Record<string, unknown>);
  };

  /** Messages for the extension in the current second: at most 50 (a runaway page can't flood it). */
  private sent = { second: 0, count: 0 };

  private fromRenderer(message: unknown): void {
    const second = Math.floor(Date.now() / 1000);
    if (second !== this.sent.second) this.sent = { second, count: 0 };
    if (++this.sent.count > 50) return;
    // And small: 1 MB of JSON at most per message.
    try {
      if (JSON.stringify(message ?? null).length > 1_000_000) return;
    } catch {
      return;
    }
    this.renderer?.send(message);
  }

  private lastLink = 0;
  /** A link the user clicked in the output: only right after a click in this frame (D189). */
  private link(href: string): void {
    const doc = this.frame.ownerDocument;
    const clicked = doc.activeElement === this.frame && doc.hasFocus();
    const now = Date.now();
    if (!clicked || now - this.lastLink < 1000) return;
    this.lastLink = now;
    this.ctx.openLink(href);
  }

  private forward(send: Record<string, unknown>): void {
    const kind = send.kind;
    const localId = send.localId;
    if ((kind !== "comm_msg" && kind !== "comm_close") || typeof send.comm_id !== "string") return;
    const { live, store } = this.ctx.widgets();
    // The widget's state follows the user's change here too (ipywidgets 7 echoes nothing back),
    // and the other frames showing it are told.
    if (kind === "comm_msg")
      store.handle(
        {
          kind,
          content: {
            comm_id: send.comm_id,
            data: (send.data ?? {}) as CommMessage["content"]["data"],
          },
          buffers: Array.isArray(send.buffers) ? (send.buffers as string[]) : [],
        },
        this,
      );
    const done = live
      ? this.ctx.sendComm(
          kind,
          send.comm_id,
          send.data ?? {},
          send.metadata ?? {},
          Array.isArray(send.buffers) ? (send.buffers as string[]) : [],
        )
      : Promise.resolve(false);
    void done.then((ok) => this.post({ commDone: { localId, ok } }));
  }

  private setHeight(px: number): void {
    const max = this.ctx.maxHeight();
    const h = Math.max(16, max ? Math.min(px, max) : px);
    if (h === this.height) return;
    this.height = h;
    this.frame.style.height = `${h}px`;
    this.frame.setAttribute("scrolling", max && px > max ? "yes" : "no");
  }

  private render(): void {
    if (this.renderer) {
      void this.renderWithRenderer(this.renderer);
      return;
    }
    const { store, live } = this.ctx.widgets();
    this.post({
      render: {
        output: { data: this.output.data ?? {}, metadata: this.output.metadata ?? {} },
        preloads: this.preloads,
        before: this.before.map((o) => asText(o.data?.["text/html"])),
        ...(this.needsWidgets() && { widgets: { comms: store.snapshot(), live } }),
        cdn: this.ctx.cdn(),
        theme: themeVars(),
      },
    });
  }

  private async renderWithRenderer(r: RendererBinding): Promise<void> {
    let code: string;
    try {
      code = await r.code();
    } catch (err) {
      code = `throw new Error(${JSON.stringify(`The renderer's script can't be read: ${err instanceof Error ? err.message : String(err)}`)});`;
    }
    if (this.store.isDisposed) return;
    const network = r.network();
    this.post({
      render: {
        output: { data: this.output.data ?? {}, metadata: this.output.metadata ?? {} },
        renderer: {
          id: r.id,
          mime: r.mime,
          code,
          network: typeof network === "string" ? network : [...network],
        },
        cdn: this.ctx.cdn(),
        theme: themeVars(),
      },
    });
  }

  sendTheme(): void {
    if (this.ready) this.post({ theme: themeVars() });
  }

  private post(message: Record<string, unknown>): void {
    if (!this.ready) return;
    this.frame.contentWindow?.postMessage({ ns: NS, ...message }, "*");
  }

  dispose(): void {
    this.listening?.removeEventListener("message", this.onMessage);
    this.listening = null;
    this.store.dispose();
  }
}

export type { CommMessage };

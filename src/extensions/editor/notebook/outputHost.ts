// What a notebook's cells show besides their text (split from view.ts, D204): outputs that run
// code in sandboxed frames (D189) and extensions' renderers there, Markdown images and links, and
// extensions' items in cells' status rows. It redraws outputs when the folder's trust, the theme
// or the renderers change.

import { fsIpc } from "../../../core/ipc/fs";
import { remoteImages } from "../../../core/ipc/remoteImage";
import { DisposableStore } from "../../../core/lifecycle/index";
import type { NotebookKernel } from "../../../core/notebook/providers";
import { dirname, pathKey, resolveInRoot } from "../../../core/paths/index";
import { effect } from "../../../core/reactive/index";
import type { WorkbenchServices } from "../../../workbench/services";
import type { CellView } from "./cell";
import type { NbCell, NbOutput } from "./model";
import { NotebookOutputPage } from "./notebookPage";
import {
  type FrameContext,
  needsFrame,
  needsPreloads,
  OutputFrame,
  preloadOf,
  refreshFrameThemes,
} from "./outputFrame";
import type { WidgetStore } from "./widgets";

export interface OutputHostDeps {
  services: WorkbenchServices;
  widgets: WidgetStore;
  path(): string;
  notebookType(): string;
  cells(): readonly CellView[];
  kernel(): NotebookKernel | null;
  run(command: string, input?: Record<string, unknown>): void;
  /** The cell list (a controller's output page lies in it, D295). */
  list?(): HTMLElement;
}

export class NotebookOutputHost {
  private readonly store = new DisposableStore();
  private readonly objectUrls = new Map<string, string>();
  /** Cells whose status row items are due (extensions' providers, D204). */
  private readonly statusDue = new Set<CellView>();
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  readonly frameContext: FrameContext;

  constructor(private readonly deps: OutputHostDeps) {
    const { services } = deps;
    this.frameContext = {
      cdn: () =>
        services.settings.peek<string>("notebook.output.cdn") || "https://cdn.jsdelivr.net/npm/",
      widgets: () => {
        const k = deps.kernel();
        const live =
          !!k &&
          k.info.peek()?.mode === "jupyter" &&
          k.status.peek() !== "dead" &&
          k.status.peek() !== "stopped" &&
          !deps.widgets.isSaved;
        return { store: deps.widgets, live };
      },
      sendComm: (kind, commId, data, metadata, buffers) => {
        const k = deps.kernel();
        return k ? k.sendComm(kind, commId, data, metadata, buffers) : Promise.resolve(false);
      },
      openLink: (url) => this.openLink(url),
      maxHeight: () => null,
    };
    const redraw = () =>
      queueMicrotask(() => {
        for (const c of deps.cells()) c.redrawOutputs();
      });
    // Trusted (or not) since they were drawn: outputs that run code are drawn again.
    let trust = services.trust.state.peek();
    this.store.add(
      effect(() => {
        const now = services.trust.state.value;
        if (now !== trust) {
          trust = now;
          redraw();
        }
        return undefined;
      }),
    );
    // Output frames take the IDE's colors (D189).
    this.store.add(
      effect(() => {
        services.theme.theme.value;
        queueMicrotask(() => {
          refreshFrameThemes();
          this.page?.sendTheme();
        });
        return undefined;
      }),
    );
    this.store.add({
      dispose: () => {
        this.page?.dispose();
        this.page = null;
      },
    });
    // An extension's renderer came or went (it started after the notebook opened): the outputs
    // it draws are drawn again.
    const rendererIds = () =>
      services.notebooks
        .allRenderers()
        .map((r) => r.id)
        .join(",");
    let renderersSeen = rendererIds();
    this.store.add(
      services.notebooks.onDidChange(() => {
        const now = rendererIds();
        if (now === renderersSeen) return;
        renderersSeen = now;
        redraw();
      }),
    );
    this.store.add(
      services.notebooks.onDidChangeStatusProviders(() => {
        for (const c of deps.cells()) this.statusDue.add(c);
        this.scheduleStatus();
      }),
    );
    this.store.add({
      dispose: () => {
        clearTimeout(this.statusTimer);
        for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
      },
    });
  }

  /** The output page of a VS Code controller's notebook (D295), while its kernel is one. */
  private page: NotebookOutputPage | null = null;

  /** Whether the notebook's outputs belong in a controller's output page now. */
  private wantsPage(): boolean {
    return (
      !!this.deps.list &&
      !!this.deps.kernel()?.messaging &&
      this.deps.services.trust.state.peek() === "trusted"
    );
  }

  /** The page, made when the notebook first needs it. */
  private currentPage(): NotebookOutputPage | null {
    if (!this.wantsPage()) return null;
    const list = this.deps.list;
    if (!this.page && list)
      this.page = new NotebookOutputPage({
        services: this.deps.services,
        list,
        path: () => this.deps.path(),
        notebookType: () => this.deps.notebookType(),
        kernel: () => this.deps.kernel(),
        openLink: (url) => this.openLink(url),
        cdn: () => this.frameContext.cdn(),
      });
    return this.page;
  }

  /**
   * The kernel changed (or its state): outputs move into a controller's page, or back out of it
   * (they're drawn again then).
   */
  kernelChanged(): void {
    const wants = this.wantsPage();
    if (wants === !!this.page) return;
    if (!wants) {
      this.page?.dispose();
      this.page = null;
    }
    // Made now, as VS Code's webview is with the notebook: its preloads answer the controller
    // from the start (Jupyter's widgets' handshake), before any output needs them.
    else this.currentPage();
    queueMicrotask(() => {
      for (const c of this.deps.cells()) c.redrawOutputs();
    });
  }

  /** Set-up code of the outputs above `o` (a Bokeh load, Plotly's notebook mode). */
  private preloadsBefore(cell: CellView, o: NbOutput): string[] {
    const out: string[] = [];
    for (const c of this.deps.cells()) {
      for (const x of c.cell.outputs) {
        if (x === o) return out;
        const js = preloadOf(x);
        if (js) out.push(js);
      }
      if (c === cell) break;
    }
    return out;
  }

  /**
   * The frame an output is drawn in, or null to draw it inline: an extension's renderer for one
   * of its mime types (D204), or an output that runs code (D189). Only in a trusted folder: a
   * downloaded notebook's saved outputs are drawn as text until the folder is trusted.
   */
  frame(
    o: NbOutput,
    cell: CellView,
    before: NbOutput[],
  ): { element: HTMLElement; dispose(): void } | null {
    const { services } = this.deps;
    if (services.trust.state.peek() !== "trusted") return null;
    // A VS Code controller's notebook (D295): extensions' renderers draw in its one output page,
    // Jupyter widgets too (the controller's preloads hold them there).
    const page = this.currentPage();
    const found = services.notebooks.rendererFor(Object.keys(o.data ?? {}), { widgets: !!page });
    if (found && page) return page.slot(o, found.renderer, found.mime);
    // Outputs that run code are drawn in the page too (VS Code draws every output in its one
    // webview): they share its window with the extensions' preloads and renderers.
    if (page && needsFrame(o, null))
      return page.slot(o, null, Object.keys(o.data ?? {})[0] ?? "", before);
    if (found) {
      const { renderer, mime } = found;
      return new OutputFrame(this.frameContext, o, [], [], {
        id: renderer.id,
        mime,
        code: () => renderer.code(),
        network: () => renderer.network(),
        send: (message) => renderer.receive(message, this.deps.path()),
        onMessage: (listener) =>
          services.notebooks.onRendererMessage((m) => {
            if (
              m.renderer === renderer.id &&
              (!m.path || pathKey(m.path) === pathKey(this.deps.path()))
            )
              listener(m.message);
          }),
      });
    }
    return needsFrame(o, this.deps.widgets)
      ? new OutputFrame(
          this.frameContext,
          o,
          needsPreloads(o) ? this.preloadsBefore(cell, o) : [],
          before,
        )
      : null;
  }

  /** Markdown images: inline attachments, data URLs, and the folder's pictures. */
  image(src: string, cell: NbCell): string | null | Promise<string | null> {
    const { services } = this.deps;
    if (src.startsWith("data:image/")) return src;
    if (src.startsWith("attachment:")) {
      const att = (cell.extra.attachments ?? {}) as Record<string, Record<string, string>>;
      const bundle = att[src.slice("attachment:".length)];
      const mime = bundle && Object.keys(bundle).find((m) => m.startsWith("image/"));
      return mime ? `data:${mime};base64,${bundle[mime]}` : null;
    }
    if (/^https:\/\//i.test(src))
      return services.settings.peek<boolean>("markdown.preview.remoteImages") === false
        ? null
        : remoteImages.url(src);
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null;
    let rel = src.split(/[?#]/)[0] ?? src;
    try {
      rel = decodeURI(rel);
    } catch {
      // A stray "%" ("100%.png"): as written, not a throw that breaks the cell's Markdown.
    }
    const file = resolveInRoot(dirname(this.deps.path()), rel);
    // Any of the workspace's folders (D251).
    if (!services.workspace.contains(file)) return null;
    // One URL per picture for the view's life (revoked when it closes).
    const known = this.objectUrls.get(file);
    if (known) return known;
    return fsIpc
      .read(file)
      .then((bytes) => {
        const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
        this.objectUrls.set(file, url);
        return url;
      })
      .catch(() => null);
  }

  openLink(href: string): void {
    if (/^https?:\/\//i.test(href)) this.deps.run("ui.openLink", { url: href });
    // A UNC or "//host" path would make Windows connect to that host when it's read (D161):
    // a notebook's link (or an output frame's) never opens one.
    else if (/^[\\/]{2}/.test(href.trim())) return;
    else if (!href.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/i.test(href))
      this.deps.run("editor.openFile", {
        path: resolveInRoot(dirname(this.deps.path()), href.split("#")[0] ?? href),
      });
  }

  /** A cell's status row items are due (it's new or changed): asked for 300 ms later. */
  statusChanged(cell: CellView): void {
    this.statusDue.add(cell);
    this.scheduleStatus();
  }

  private scheduleStatus(): void {
    if (this.statusTimer !== undefined) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = undefined;
      const due = [...this.statusDue];
      this.statusDue.clear();
      const cells = this.deps.cells();
      for (const c of due) {
        const index = cells.indexOf(c);
        if (index < 0) continue;
        void this.deps.services.notebooks
          .cellStatusItems({
            path: this.deps.path(),
            notebookType: this.deps.notebookType(),
            cell: {
              id: c.cell.id,
              index,
              kind: c.cell.kind,
              language: c.language(),
              source: c.cell.source,
              metadata: c.cell.metadata,
              executionCount: c.cell.executionCount,
              outputs: c.cell.outputs.length,
            },
          })
          .then((items) => {
            if (!this.store.isDisposed) c.setStatusItems(items.slice(0, 8));
          });
      }
    }, 300);
  }

  dispose(): void {
    this.store.dispose();
  }
}

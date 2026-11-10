// The viewers' dock views (view state `{ path }`):
// - "image": a raster image file (default viewer for .png/.jpg/…), with zoom.
// - "markdownPreview": a rendered Markdown file, live as you type in its editor, following the
//   editor's scroll; links open files, anchors scroll, double-click jumps to the source line.
// - "svgPreview": the SVG drawn as an image (scripts never run: it's an <img>), live as you type.
import type { Json } from "../../core/dock/index";
import { h, morph, on } from "../../core/dom/index";
import { Emitter } from "../../core/events/index";
import { fsIpc } from "../../core/ipc/fs";
import { remoteImages } from "../../core/ipc/remoteImage";
import { DisposableStore } from "../../core/lifecycle/index";
import { basename, dirname, resolveInRoot } from "../../core/paths/index";
import { fileIconTint } from "../../ui/fileTint";
import { fileIcon } from "../../ui/Icon";
import { isMarkdownControl, markdownNodes } from "../../ui/markdown/render";
import type {
  DockView,
  DockViewContext,
  DockViewDescriptor,
  TabAction,
} from "../../workbench/dock/views";
import { stateField } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { ImageCanvas, mimeFor } from "./image";
import { MarkdownFindBar } from "./previewFindBar";

const pathOf = (state: Json): string => {
  const p = stateField(state, "path");
  return typeof p === "string" ? p : "";
};

/** Common descriptor parts: file icon, tint, git decorations, path tooltip. */
export function fileDescriptor(
  type: string,
  title: (name: string) => string,
  create: (path: string, ctx: DockViewContext) => DockView,
  actions?: (path: string) => TabAction[],
): DockViewDescriptor {
  return {
    type,
    title: (state) => title(basename(pathOf(state))),
    icon: (state) => fileIcon(basename(pathOf(state))),
    tint: (state) => fileIconTint(basename(pathOf(state))),
    resource: (state) => pathOf(state) || undefined,
    tooltip: (state) => pathOf(state),
    defaultPlacement: "main",
    editorLike: true,
    duplicate: (state) => state,
    ...(actions && { actions: (state: Json) => actions(pathOf(state)) }),
    create: (state, ctx) => create(pathOf(state), ctx),
  };
}

export abstract class FileView implements DockView {
  readonly element: HTMLElement;
  protected readonly store = new DisposableStore();
  protected readonly changed = this.store.add(new Emitter<void>());
  readonly onDidChange = this.changed.event;
  protected visible = false;

  constructor(
    protected path: string,
    protected readonly services: WorkbenchServices,
    cls: string,
  ) {
    this.element = h("div", { class: `viewer-view ${cls}`, tabindex: "-1" });
  }

  /** The open document's text (unsaved edits too), else the file on disk. */
  protected async text(): Promise<string> {
    const live = this.services.documents.text(this.path);
    if (live !== null) return live;
    return new TextDecoder().decode(await fsIpc.read(this.path)).replace(/^﻿/, "");
  }

  /** Re-renders shortly after the document changes (typing), at most every 150 ms. */
  protected followDocument(render: () => void): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.store.add({ dispose: () => clearTimeout(timer) });
    this.store.add(
      this.services.documents.onDidChange((p) => {
        if (p !== this.path) return;
        clearTimeout(timer);
        timer = setTimeout(render, 150);
      }),
    );
  }

  onShow(): void {
    this.visible = true;
  }
  onHide(): void {
    this.visible = false;
  }
  focus(): void {
    this.element.focus();
  }
  serialize(): Json {
    return { path: this.path };
  }
  dispose(): void {
    this.store.dispose();
  }
}

const zoomActions = (canvas: ImageCanvas | undefined): TabAction[] => [
  { icon: "zoom-out", title: "Zoom out", command: "viewer.zoom", input: { direction: "out" } },
  { icon: "zoom-in", title: "Zoom in", command: "viewer.zoom", input: { direction: "in" } },
  canvas?.zoomLevel === null
    ? {
        icon: "scan",
        title: "Actual size (100%)",
        command: "viewer.zoom",
        input: { direction: "actual" },
      }
    : { icon: "scan", title: "Fit to view", command: "viewer.zoom", input: { direction: "fit" } },
];

/** Views with an image canvas answer viewer.zoom. */
export interface Zoomable {
  canvas: ImageCanvas;
}

class ImageView extends FileView implements Zoomable {
  readonly canvas = this.store.add(new ImageCanvas());
  private mtime = 0;

  constructor(path: string, services: WorkbenchServices) {
    super(path, services, "image-view");
    this.element.append(this.canvas.element);
    this.canvas.onZoom = () => this.changed.fire();
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const stat = await fsIpc.stat(this.path);
      if (stat.mtimeMs === this.mtime) return;
      this.mtime = stat.mtimeMs;
      const bytes = await fsIpc.read(this.path);
      if (this.store.isDisposed) return;
      const blob = new Blob([bytes as BlobPart], { type: mimeFor(this.path) });
      this.canvas.setUrl(URL.createObjectURL(blob), bytes.length);
    } catch (err) {
      this.canvas.showError(err instanceof Error ? err.message : String(err));
    }
  }

  actions(): TabAction[] {
    return zoomActions(this.canvas);
  }

  /** Coming back to the tab picks up a changed file (no watcher per image). */
  override onShow(): void {
    super.onShow();
    void this.load();
  }
  onResize(): void {
    this.canvas.apply();
  }
}

class SvgPreview extends FileView implements Zoomable {
  readonly canvas = this.store.add(new ImageCanvas());

  constructor(path: string, services: WorkbenchServices) {
    super(path, services, "image-view");
    this.element.append(this.canvas.element);
    this.canvas.onZoom = () => this.changed.fire();
    this.followDocument(() => void this.render());
    void this.render();
  }

  private async render(): Promise<void> {
    try {
      const text = await this.text();
      if (this.store.isDisposed) return;
      const blob = new Blob([text], { type: "image/svg+xml" });
      this.canvas.setUrl(URL.createObjectURL(blob), blob.size);
    } catch (err) {
      this.canvas.showError(err instanceof Error ? err.message : String(err));
    }
  }

  actions(): TabAction[] {
    return [
      ...zoomActions(this.canvas),
      {
        icon: "code",
        title: "Open source",
        command: "viewer.togglePreview",
        input: { path: this.path, tabId: "$tab" },
      },
    ];
  }
  onResize(): void {
    this.canvas.apply();
  }
}

/** A block of the preview with the source line it starts on and its top in the scrolled content. */
interface LineBlock {
  el: HTMLElement;
  line: number;
  top: number;
}

export class MarkdownPreview extends FileView {
  readonly body = h("div", { class: "md md-document" });
  /** Find in the preview (Ctrl/Cmd+F, the markdown.find… commands, D210). */
  readonly find: MarkdownFindBar;
  private readonly images = new Map<string, string | Promise<string | null>>();
  /** The re-render due after pictures loaded (one for a burst of loads). */
  private pendingRender: ReturnType<typeof setTimeout> | undefined;
  /** Find's refresh after colored code was patched in (one for a burst). */
  private pendingFind: ReturnType<typeof setTimeout> | undefined;
  /** The blocks with a source line and their offsets, until the document or its size changes. */
  private blocks: LineBlock[] | null = null;
  /** performance.now() of our own scroll changes, to tell them from the reader's (no loops). */
  private scrolledByUs = 0;
  private editorScrolledByUs = 0;
  private cursorLine = -1;
  private renderToken = 0;

  constructor(
    path: string,
    services: WorkbenchServices,
    private readonly ctx: DockViewContext,
  ) {
    super(path, services, "markdown-preview");
    this.find = this.store.add(
      new MarkdownFindBar({
        body: this.body,
        scroller: this.element,
        run: (command, input) => this.run(command, { ...input }),
      }),
    );
    // The bar stays at the top right while the document scrolls (a zero-height sticky anchor).
    this.element.append(h("div", { class: "md-find-anchor" }, this.find.element), this.body);
    // `markdownPreviewFocus` (and its find's): the keys Ctrl+F, Enter, Escape… are the preview's.
    const focusKeys = (to: EventTarget | null = document.activeElement) => {
      const inside = to instanceof Node && this.element.contains(to);
      services.context.set("markdownPreviewFocus", inside);
      services.context.set("markdownFindVisible", inside && this.find.isOpen);
      services.context.set("markdownFindInputFocus", inside && this.find.holds(to));
    };
    this.focusKeys = focusKeys;
    this.store.add(on(this.element, "focusin", (e) => focusKeys(e.target)));
    // Where focus goes: inside (the bar, the document) keeps the keys, elsewhere drops them.
    this.store.add(on(this.element, "focusout", (e) => focusKeys(e.relatedTarget)));
    this.store.add({
      dispose: () => {
        if (!this.element.contains(document.activeElement)) return;
        services.context.set("markdownPreviewFocus", false);
        services.context.set("markdownFindVisible", false);
        services.context.set("markdownFindInputFocus", false);
      },
    });
    this.store.add({
      dispose: () => {
        clearTimeout(this.pendingRender);
        clearTimeout(this.pendingFind);
      },
    });
    // Pictures loading, a narrower window, zoom: the blocks moved.
    const resized = new ResizeObserver(() => (this.blocks = null));
    resized.observe(this.body);
    this.store.add({ dispose: () => resized.disconnect() });
    this.store.add({
      dispose: () => {
        for (const url of this.images.values())
          if (typeof url === "string") URL.revokeObjectURL(url);
      },
    });
    this.followDocument(() => void this.render());
    // Editor → preview: follow its scroll (interpolated by source line) and mark its cursor's block.
    this.store.add(
      services.documents.onDidScroll(({ path: p, line, cursor }) => {
        if (p !== this.path) return;
        if (cursor !== this.cursorLine) this.markCursor(cursor);
        if (performance.now() - this.editorScrolledByUs < 150) return;
        this.scrollToLine(line);
      }),
    );
    // Preview → editor: the reader scrolling the preview scrolls the editor.
    this.store.add(
      on(
        this.element,
        "scroll",
        () => {
          if (performance.now() - this.scrolledByUs < 150) return;
          this.editorScrolledByUs = performance.now();
          this.services.documents.requestScroll(this.path, this.lineAtTop());
        },
        { passive: true },
      ),
    );
    // Double-click a block: jump to its line in the source.
    this.store.add(
      on(this.body, "dblclick", (e) => {
        if (isMarkdownControl(e.target)) return;
        const block = (e.target as Element).closest<HTMLElement>("[data-line]");
        if (block?.dataset.line)
          this.run("editor.openFile", { path: this.path, line: Number(block.dataset.line) + 1 });
      }),
    );
    void this.render();
  }

  title(): string {
    return `Preview ${basename(this.path)}`;
  }

  /** The previewed file. */
  get file(): string {
    return this.path;
  }

  /** Updates the focus context keys (the find bar opened or closed). */
  readonly focusKeys: (to?: EventTarget | null) => void;

  /** Opens the find bar (or updates its search); `focus` puts the cursor in it. */
  openFind(options: Parameters<MarkdownFindBar["open"]>[0]): void {
    this.find.open(options);
    this.focusKeys();
  }

  /** Closes the find bar; focus goes back to the document when it was in the bar. */
  closeFind(): void {
    const hadFocus = this.find.element.contains(document.activeElement);
    this.find.close();
    if (hadFocus) this.element.focus({ preventScroll: true });
    this.focusKeys();
  }

  override onShow(): void {
    super.onShow();
    this.blocks = null;
    this.find.refresh();
  }
  override onHide(): void {
    super.onHide();
    this.find.hideHighlights();
  }

  private run(command: string, input: unknown): void {
    void this.services.dispatcher.execute(command, input).catch(() => {});
  }

  private async render(): Promise<void> {
    const token = ++this.renderToken;
    let text: string;
    try {
      text = await this.text();
    } catch (err) {
      this.body.replaceChildren(
        h("div", { class: "empty-state" }, err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    if (this.store.isDisposed || token !== this.renderToken) return;
    const top = this.element.scrollTop;
    this.usedColored = new Set();
    const next = h(
      "div",
      { class: "md md-document" },
      ...markdownNodes(text, {
        headingShift: 0,
        lines: true,
        softBreaks: "space",
        openLink: (href) => this.openLink(href),
        copy: (t) => this.run("ui.copyText", { text: t }),
        image: (src) => this.image(src),
        highlight: (code, lang) => this.highlight(code, lang),
      }),
    );
    // Update in place: unchanged blocks (and their images) stay, the reading position holds.
    morph(this.body, next);
    this.blocks = null;
    this.scrolledByUs = performance.now();
    this.element.scrollTop = top;
    if (this.cursorLine >= 0) this.markCursor(this.cursorLine);
    this.find.refresh();
  }

  /** Points this preview at another Markdown file (links between .md files, like VS Code). */
  private retarget(path: string, fragment?: string): void {
    this.path = path;
    this.cursorLine = -1;
    this.ctx.updateState({ path });
    this.changed.fire();
    this.scrolledByUs = performance.now();
    this.element.scrollTop = 0;
    void this.render().then(() => fragment && this.openLink(`#${fragment}`));
  }

  private dir(): string {
    return dirname(this.path);
  }

  /** One re-render for a burst of loaded pictures. */
  private scheduleRender(): void {
    if (this.pendingRender !== undefined || this.store.isDisposed) return;
    this.pendingRender = setTimeout(() => {
      this.pendingRender = undefined;
      void this.render();
    }, 50);
  }

  /**
   * Workspace images become blob: URLs, cached per source: a known one is returned at once (so
   * in-place re-renders keep it), a new one loads and the preview re-renders when it's there.
   */
  private image(src: string): string | null | Promise<string | null> {
    // Remote images (badges, logos in READMEs) show as in GitHub's and VS Code's previews,
    // fetched by the backend (the window's CSP allows none, D210), unless turned off.
    if (/^https:\/\//i.test(src)) {
      if (this.services.settings.peek<boolean>("markdown.preview.remoteImages") === false)
        return null;
      const remote = remoteImages.url(src);
      // A <picture>'s <source> (a README's dark / light logo) takes only a URL known now: once
      // the picture has loaded, draw again so it's chosen.
      if (remote instanceof Promise)
        void remote.then((url) => {
          if (url) this.scheduleRender();
        });
      return remote;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null;
    const key = `${this.dir()}|${src}`;
    const cached = this.images.get(key);
    if (cached !== undefined) return cached;
    let rel = src.split(/[?#]/)[0] ?? src;
    try {
      rel = decodeURI(rel);
    } catch {
      // keep as written
    }
    const path = resolveInRoot(this.dir(), rel);
    // Any of the workspace's folders (D251).
    if (!this.services.workspace.contains(path)) return null;
    const load = fsIpc
      .read(path)
      .then((bytes) => {
        if (this.store.isDisposed) return null;
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeFor(path) }));
        this.images.set(key, url);
        this.scheduleRender();
        return url;
      })
      .catch(() => {
        // Not there (yet): forget it, so a later render tries again once it exists.
        this.images.delete(key);
        return null;
      });
    this.images.set(key, load);
    return load;
  }

  /** Colored code by language and text: the engine's spans, parsed once (null while pending). */
  private readonly colored = new Map<string, DocumentFragment | null>();
  /** The `colored` keys the latest render asked for (filled while it builds, synchronously). */
  private usedColored = new Set<string>();

  /**
   * Colored code from a per-preview cache (synchronous, so in-place re-renders keep the colors);
   * an unknown block is colorized in the background and patched into the page when it's ready,
   * not by a re-render: a long document has hundreds of blocks (D278).
   */
  private highlight(code: string, lang: string): Node[] | null {
    if (!lang) return null;
    const key = `${lang}\u0000${code}`;
    this.usedColored.add(key);
    if (!this.colored.has(key)) {
      this.colored.set(key, null);
      void this.services.documents
        .highlight(code, lang)
        .then((html) => {
          if (!html || this.store.isDisposed) return;
          // Drop the oldest entries the document no longer uses. Evicting blocks still in it
          // would re-request them on the next render, which evicts others, forever, in a
          // document with more blocks than the cap: so the cap grows to the document instead.
          if (this.colored.size > 500)
            for (const old of [...this.colored.keys()]) {
              if (this.colored.size <= 500) break;
              if (old !== key && !this.usedColored.has(old)) this.colored.delete(old);
            }
          // The engine escapes the code; its output is spans with theme classes.
          const template = document.createElement("template");
          template.innerHTML = html;
          this.colored.set(key, template.content);
          this.patchColored(code, lang, template.content);
        })
        .catch(() => {});
      return null;
    }
    const colored = this.colored.get(key);
    return colored ? Array.from(colored.cloneNode(true).childNodes) : null;
  }

  /** Colors the page's plain blocks of `code` in `lang` (the latest render showed them plain). */
  private patchColored(code: string, lang: string, colored: DocumentFragment): void {
    let patched = false;
    for (const el of Array.from(this.body.querySelectorAll<HTMLElement>(".md-pre code"))) {
      if (el.firstElementChild || el.textContent !== code) continue;
      // The label is the language or a file name ("src/main.rs" colors as "rs").
      const label = el.closest(".md-pre")?.querySelector(".md-pre-lang")?.textContent ?? "";
      if (label !== lang && label.split(".").pop() !== lang) continue;
      el.replaceChildren(colored.cloneNode(true));
      patched = true;
    }
    // Find's matches pointed into the plain text: search again once the burst is over.
    if (patched && this.find.isOpen && this.pendingFind === undefined)
      this.pendingFind = setTimeout(() => {
        this.pendingFind = undefined;
        this.find.refresh();
      }, 100);
  }

  private openLink(href: string): void {
    if (href.startsWith("#")) {
      let id = href.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {
        // as written
      }
      // Headings' ids, and raw HTML's id / name (kept as data-anchor, D210).
      const target = this.body.querySelector(
        `[id="${CSS.escape(id)}"], [data-anchor="${CSS.escape(id)}"]`,
      );
      if (target) {
        this.element.scrollTop = this.topOf(target as HTMLElement) - 8;
      }
      return;
    }
    if (/^(https?|mailto):/i.test(href)) {
      this.run("ui.openLink", { url: href });
      return;
    }
    const [file, fragment] = href.split("#");
    if (!file) return;
    // A UNC or "//host" link would make Windows connect to that host when it's read (D161).
    if (/^[\\/]{2}/.test(file.trim())) return;
    let rel = file;
    try {
      rel = decodeURI(file);
    } catch {
      // as written
    }
    const target = resolveInRoot(this.dir(), rel);
    // Markdown links stay in the preview (VS Code's default); other files open in the editor.
    if (/\.(md|markdown|mdx)$/i.test(target)) this.retarget(target, fragment);
    else this.run("editor.openFile", { path: target });
  }

  // ---- Scroll sync (VS Code's approach: interpolate between blocks tagged with source lines) ----

  private topOf(el: HTMLElement): number {
    return (
      el.getBoundingClientRect().top -
      this.element.getBoundingClientRect().top +
      this.element.scrollTop
    );
  }

  /**
   * Blocks with a source line, in document order, one per line (the outermost), with their tops
   * in the scrolled content. Measured once per render or resize (one layout), then binary
   * searched: every scroll asks, and a long document has thousands of blocks (D278).
   */
  private lineBlocks(): LineBlock[] {
    if (this.blocks) return this.blocks;
    const out: LineBlock[] = [];
    const origin = this.element.getBoundingClientRect().top - this.element.scrollTop;
    for (const el of Array.from(this.body.querySelectorAll<HTMLElement>("[data-line]"))) {
      const line = Number(el.dataset.line);
      if (Number.isNaN(line) || el.offsetParent === null) continue;
      const last = out[out.length - 1];
      if (last && line <= last.line) continue;
      out.push({ el, line, top: el.getBoundingClientRect().top - origin });
    }
    // Hidden, nothing has a layout: measure again when shown.
    if (out.length > 0) this.blocks = out;
    return out;
  }

  /** The index of the last block whose `key` is at most `value` (-1: none). */
  private lastBlockAtMost(
    blocks: readonly LineBlock[],
    key: "line" | "top",
    value: number,
  ): number {
    let low = 0;
    let high = blocks.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const block = blocks[mid];
      if (block && block[key] <= value) {
        found = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    return found;
  }

  /** Scrolls so fractional source line `line` (0-based) is at the top. */
  private scrollToLine(line: number): void {
    if (!this.visible) return;
    this.scrolledByUs = performance.now();
    if (line <= 0) {
      this.element.scrollTop = 0;
      return;
    }
    const blocks = this.lineBlocks();
    const at = this.lastBlockAtMost(blocks, "line", line);
    const prev = blocks[at];
    const next = blocks[at + 1];
    if (!prev) {
      this.element.scrollTop = 0;
      return;
    }
    const y = next
      ? prev.top + ((line - prev.line) / (next.line - prev.line)) * (next.top - prev.top)
      : prev.top + (line - prev.line) * 20;
    this.element.scrollTop = Math.max(0, y - 8);
  }

  /** The fractional source line at the top of the preview (the inverse of scrollToLine). */
  private lineAtTop(): number {
    if (this.element.scrollTop <= 0) return 0;
    const y = this.element.scrollTop + 8;
    const blocks = this.lineBlocks();
    const at = this.lastBlockAtMost(blocks, "top", y);
    const prev = blocks[at];
    const next = blocks[at + 1];
    if (!prev) return 0;
    if (!next) return prev.line + Math.min(1, (y - prev.top) / Math.max(1, prev.el.offsetHeight));
    return (
      prev.line + ((y - prev.top) / Math.max(1, next.top - prev.top)) * (next.line - prev.line)
    );
  }

  /** A bar beside the block holding the editor's cursor (VS Code's "mark editor selection"). */
  private markCursor(line: number): void {
    this.cursorLine = line;
    for (const el of Array.from(this.body.querySelectorAll(".is-cursor-line")))
      el.classList.remove("is-cursor-line");
    const blocks = this.lineBlocks();
    const hit = blocks[this.lastBlockAtMost(blocks, "line", line)]?.el;
    hit?.classList.add("is-cursor-line");
  }

  actions(): TabAction[] {
    return [
      {
        icon: "code",
        title: "Open source",
        command: "viewer.togglePreview",
        input: { path: this.path, tabId: "$tab" },
      },
    ];
  }
}

export function viewerDescriptors(services: WorkbenchServices): DockViewDescriptor[] {
  return [
    fileDescriptor(
      "image",
      (name) => name,
      (path) => new ImageView(path, services),
    ),
    fileDescriptor(
      "markdownPreview",
      (name) => `Preview ${name}`,
      (path, ctx) => new MarkdownPreview(path, services, ctx),
    ),
    fileDescriptor(
      "svgPreview",
      (name) => `Preview ${name}`,
      (path) => new SvgPreview(path, services),
    ),
  ];
}

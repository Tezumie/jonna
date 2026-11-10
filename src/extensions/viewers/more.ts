// More viewers (D118), each a dock view with state `{ path }`:
// - "hexView": any binary file as a hex dump (offset · bytes · text), virtualised so large files
//   scroll smoothly. Default for common binary types (.pyc, .class, .wasm, .exe…); the editor's
//   "binary file" notice opens it for the rest.
// - "media": audio and video files with the platform's player (VS Code's media preview).
// - "csvPreview": .csv / .tsv as a table with a sticky header, live as the file is edited.
import { h, on } from "../../core/dom/index";
import { fsIpc } from "../../core/ipc/fs";
import type { DockViewDescriptor } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { guessDelimiter, hexRow, parseDelimited } from "./formats";
import { FileView, fileDescriptor } from "./views";

/** Files bigger than this aren't loaded into a viewer (they'd all be in memory). */
const MAX_BYTES = 50 * 1024 * 1024;
const ROW_HEIGHT = 20;
const MAX_SCROLL_PX = 8_000_000;

export const BINARY_EXTENSIONS = [
  ".pyc",
  ".pyo",
  ".class",
  ".wasm",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".o",
  ".obj",
  ".a",
  ".lib",
  ".bin",
  ".dat",
  ".pdb",
  ".node",
];
export const AUDIO_EXTENSIONS = [".mp3", ".wav", ".ogg", ".oga", ".m4a", ".aac", ".flac", ".opus"];
export const VIDEO_EXTENSIONS = [".mp4", ".webm", ".ogv", ".mov", ".m4v"];
export const CSV_EXTENSIONS = [".csv", ".tsv"];

const MEDIA_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".opus": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
  ".m4v": "video/mp4",
};
const extOf = (path: string) => path.slice(path.lastIndexOf(".")).toLowerCase();

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Reads the file unless it's too big; the view shows `message` instead. */
async function readLimited(path: string): Promise<{ bytes: Uint8Array } | { message: string }> {
  const stat = await fsIpc.stat(path);
  if (stat.size > MAX_BYTES)
    return { message: `${sizeLabel(stat.size)} is too large to show here (limit 50 MB).` };
  return { bytes: await fsIpc.read(path) };
}

class HexView extends FileView {
  private bytes: Uint8Array = new Uint8Array();
  private readonly scroller = h("div", { class: "hex-scroller", tabindex: "0" });
  private readonly spacer = h("div", { class: "hex-spacer" });
  private readonly rows = h("div", { class: "hex-rows" });
  private readonly info = h("div", { class: "viewer-info" });
  private frame = 0;

  constructor(path: string, services: WorkbenchServices) {
    super(path, services, "hex-view");
    this.spacer.append(this.rows);
    this.scroller.append(this.spacer);
    this.element.append(this.info, this.scroller);
    this.scroller.setAttribute("aria-label", `Bytes of ${path.split(/[\\/]/).pop() ?? path}`);
    this.store.add(
      on(this.scroller, "scroll", () => {
        cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(() => this.draw());
      }),
    );
    this.store.add({ dispose: () => cancelAnimationFrame(this.frame) });
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const r = await readLimited(this.path);
      if (this.store.isDisposed) return;
      if ("message" in r) {
        this.info.textContent = r.message;
        return;
      }
      this.bytes = r.bytes;
      this.info.textContent = `${sizeLabel(r.bytes.length)} · read-only hex view`;
      this.spacer.style.height = `${Math.min(Math.ceil(r.bytes.length / 16) * ROW_HEIGHT, MAX_SCROLL_PX)}px`;
      this.draw();
    } catch (err) {
      this.info.textContent = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Only the rows in view (plus a few) exist in the DOM. Past MAX_SCROLL_PX of rows (browsers cap
   * element heights around 33M px — a 26 MB file), the scroll position maps to rows proportionally.
   */
  private draw(): void {
    const total = Math.ceil(this.bytes.length / 16);
    const view = this.scroller.clientHeight || 800;
    const count = Math.ceil(view / ROW_HEIGHT) + 10;
    const top = this.scroller.scrollTop;
    const scaled = total * ROW_HEIGHT > MAX_SCROLL_PX;
    const first = scaled
      ? Math.round((top / Math.max(1, MAX_SCROLL_PX - view)) * Math.max(0, total - count + 10))
      : Math.max(0, Math.floor(top / ROW_HEIGHT) - 5);
    const last = Math.min(total, first + count);
    this.rows.style.transform = `translateY(${scaled ? top : first * ROW_HEIGHT}px)`;
    const out: HTMLElement[] = [];
    for (let r = first; r < last; r++) {
      const row = hexRow(this.bytes, r * 16);
      out.push(
        h(
          "div",
          { class: "hex-row" },
          h("span", { class: "hex-offset" }, row.offset),
          h("span", { class: "hex-bytes" }, row.hex),
          h("span", { class: "hex-text" }, row.text),
        ),
      );
    }
    this.rows.replaceChildren(...out);
  }

  override onShow(): void {
    super.onShow();
    this.draw();
  }
  onResize(): void {
    this.draw();
  }
}

class MediaView extends FileView {
  private url: string | null = null;

  constructor(path: string, services: WorkbenchServices) {
    super(path, services, "media-view");
    this.store.add({
      dispose: () => {
        if (this.url) URL.revokeObjectURL(this.url);
      },
    });
    void this.load();
  }

  private async load(): Promise<void> {
    const ext = extOf(this.path);
    const video = VIDEO_EXTENSIONS.includes(ext);
    try {
      const r = await readLimited(this.path);
      if (this.store.isDisposed) return;
      if ("message" in r) {
        this.element.append(h("div", { class: "empty-state" }, r.message));
        return;
      }
      this.element.append(
        h(
          "div",
          { class: "media-info" },
          `${video ? "Video" : "Audio"} · ${sizeLabel(r.bytes.length)}`,
        ),
      );
      this.url = URL.createObjectURL(
        new Blob([r.bytes as BlobPart], { type: MEDIA_MIME[ext] ?? "application/octet-stream" }),
      );
      const player = h(video ? "video" : "audio", {
        class: "media-player",
        controls: true,
        src: this.url,
        preload: "metadata",
      }) as HTMLMediaElement;
      const error = h("div", { class: "empty-state", hidden: true });
      this.store.add(
        on(player, "error", () => {
          error.textContent =
            "This file can't be played here (format not supported by the system's player).";
          error.hidden = false;
          player.hidden = true;
        }),
      );
      this.element.append(player, error);
    } catch (err) {
      this.element.append(
        h("div", { class: "empty-state" }, err instanceof Error ? err.message : String(err)),
      );
    }
  }

  override onHide(): void {
    super.onHide();
    this.element.querySelector<HTMLMediaElement>("audio, video")?.pause();
  }
}

/** Rows shown at most (the rest is counted). */
const CSV_ROWS = 5000;

class CsvPreview extends FileView {
  private readonly info = h("div", { class: "viewer-info" });
  private readonly body = h("div", { class: "csv-scroller" });

  constructor(path: string, services: WorkbenchServices) {
    super(path, services, "csv-view");
    this.element.append(this.info, this.body);
    this.followDocument(() => void this.render());
    void this.render();
  }

  private token = 0;
  private stale = false;

  override onShow(): void {
    super.onShow();
    if (this.stale) void this.render();
  }

  private async render(): Promise<void> {
    // Hidden: rebuild when shown (typing in the CSV shouldn't rebuild 5000 rows per keystroke).
    if (!this.visible && this.body.childElementCount) {
      this.stale = true;
      return;
    }
    this.stale = false;
    const token = ++this.token;
    try {
      const text = await this.text();
      if (this.store.isDisposed || token !== this.token) return;
      const delimiter = guessDelimiter(this.path, text);
      const { rows, truncated } = parseDelimited(text, delimiter, CSV_ROWS + 1);
      const [head = [], ...data] = rows;
      const width = Math.max(head.length, ...data.slice(0, 200).map((r) => r.length));
      const cells = (row: string[], tag: "th" | "td") =>
        Array.from({ length: width }, (_, i) => h(tag, null, row[i] ?? ""));
      const table = h(
        "table",
        { class: "csv-table" },
        h("thead", null, h("tr", null, h("th", { class: "csv-index" }, ""), ...cells(head, "th"))),
        h(
          "tbody",
          null,
          ...data.map((row, i) =>
            h("tr", null, h("td", { class: "csv-index" }, String(i + 1)), ...cells(row, "td")),
          ),
        ),
      );
      const name = delimiter === "\t" ? "tab" : `"${delimiter}"`;
      this.info.textContent = `${data.length}${truncated ? "+" : ""} rows · ${width} columns · separated by ${name}${truncated ? ` · showing the first ${CSV_ROWS}` : ""}`;
      this.body.replaceChildren(table);
    } catch (err) {
      this.info.textContent = err instanceof Error ? err.message : String(err);
    }
  }
}

export function moreViewerDescriptors(services: WorkbenchServices): DockViewDescriptor[] {
  return [
    fileDescriptor(
      "hexView",
      (name) => `${name} (hex)`,
      (path) => new HexView(path, services),
    ),
    fileDescriptor(
      "media",
      (name) => name,
      (path) => new MediaView(path, services),
    ),
    fileDescriptor(
      "csvPreview",
      (name) => `Preview ${name}`,
      (path) => new CsvPreview(path, services),
    ),
  ];
}

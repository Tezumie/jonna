// More viewers (D120), dock views with state `{ path }`:
// - "fontPreview": a font file (.ttf .otf .woff .woff2) — its name, a sample at several sizes and
//   the printable ASCII glyphs; loaded with the FontFace API from the file's bytes (no URL).
// (Notebooks moved to the editor: editor/notebook, D188.)
// - "archive": a ZIP archive's contents (.zip .jar .war .vsix .whl .nupkg .epub .apk) as a
//   table: path, size, compressed size, modified date.
import { h } from "../../core/dom/index";
import { fsIpc } from "../../core/ipc/fs";
import { basename } from "../../core/paths/index";
import type { DockViewDescriptor } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { parseZip } from "./formats";
import { FileView, fileDescriptor } from "./views";

export const FONT_EXTENSIONS = [".ttf", ".otf", ".woff", ".woff2"];
export const ARCHIVE_EXTENSIONS = [
  ".zip",
  ".jar",
  ".war",
  ".vsix",
  ".whl",
  ".nupkg",
  ".epub",
  ".apk",
];

const MAX_BYTES = 50 * 1024 * 1024;

function sizeLabel(bytes: number): string {
  if (bytes < 0) return "> 4 GB";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function readLimited(path: string): Promise<Uint8Array> {
  const stat = await fsIpc.stat(path);
  if (stat.size > MAX_BYTES)
    throw new Error(`${sizeLabel(stat.size)} is too large to show here (limit 50 MB).`);
  return fsIpc.read(path);
}

const SAMPLE = "The quick brown fox jumps over the lazy dog";
const SIZES = [12, 16, 24, 36, 48, 72];
let fontCounter = 0;

class FontView extends FileView {
  private face: FontFace | null = null;

  constructor(path: string, services: WorkbenchServices) {
    super(path, services, "font-view");
    this.store.add({
      dispose: () => {
        if (this.face) document.fonts.delete(this.face);
      },
    });
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const bytes = await readLimited(this.path);
      if (this.store.isDisposed) return;
      const family = `__ide_font_preview_${++fontCounter}`;
      const face = new FontFace(family, bytes.slice().buffer as ArrayBuffer);
      await face.load();
      if (this.store.isDisposed) return;
      document.fonts.add(face);
      this.face = face;
      const font = (size: number) => ({ "font-family": `"${family}"`, "font-size": `${size}px` });
      const glyphs = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("");
      this.element.append(
        h("div", { class: "viewer-info" }, `${basename(this.path)} · ${sizeLabel(bytes.length)}`),
        h(
          "div",
          { class: "font-body" },
          h(
            "div",
            { class: "font-name", style: font(40) },
            basename(this.path).replace(/\.[^.]+$/, ""),
          ),
          ...SIZES.map((size) =>
            h(
              "div",
              { class: "font-sample" },
              h("span", { class: "font-size" }, `${size}`),
              h("span", { style: font(size) }, SAMPLE),
            ),
          ),
          h("div", { class: "font-glyphs", style: font(28) }, glyphs),
        ),
      );
    } catch (err) {
      this.element.append(
        h(
          "div",
          { class: "empty-state" },
          `This font can't be shown: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }
}

class ArchiveView extends FileView {
  constructor(path: string, services: WorkbenchServices) {
    super(path, services, "archive-view");
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const bytes = await readLimited(this.path);
      if (this.store.isDisposed) return;
      const zip = parseZip(bytes);
      if (!zip) throw new Error("This isn't a ZIP archive (or it's damaged).");
      const files = zip.entries.filter((e) => !e.dir);
      const total = files.reduce((t, e) => t + Math.max(0, e.size), 0);
      const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
      const shown = sorted.slice(0, 5000);
      this.element.append(
        h(
          "div",
          { class: "viewer-info" },
          `${files.length} files · ${sizeLabel(total)} unpacked · ${sizeLabel(bytes.length)} packed${zip.comment ? ` · ${zip.comment}` : ""}${shown.length < sorted.length ? " · showing the first 5000" : ""}`,
        ),
        h(
          "div",
          { class: "csv-scroller" },
          h(
            "table",
            { class: "csv-table archive-table" },
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                h("th", null, "Path"),
                h("th", null, "Size"),
                h("th", null, "Packed"),
                h("th", null, "Modified"),
              ),
            ),
            h(
              "tbody",
              null,
              ...shown.map((e) =>
                h(
                  "tr",
                  null,
                  h(
                    "td",
                    { class: "archive-name", title: e.name },
                    `${e.name}${e.encrypted ? " (encrypted)" : ""}`,
                  ),
                  h("td", { class: "archive-size" }, sizeLabel(e.size)),
                  h("td", { class: "archive-size" }, sizeLabel(e.compressed)),
                  h("td", null, e.modified ? e.modified.toLocaleString() : ""),
                ),
              ),
            ),
          ),
        ),
      );
    } catch (err) {
      this.element.append(
        h("div", { class: "empty-state" }, err instanceof Error ? err.message : String(err)),
      );
    }
  }
}

export function richViewerDescriptors(services: WorkbenchServices): DockViewDescriptor[] {
  return [
    fileDescriptor(
      "fontPreview",
      (name) => name,
      (path) => new FontView(path, services),
    ),
    fileDescriptor(
      "archive",
      (name) => name,
      (path) => new ArchiveView(path, services),
    ),
  ];
}

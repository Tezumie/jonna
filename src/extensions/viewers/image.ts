// The image canvas shared by the image viewer and the SVG preview (VS Code's image preview):
// checkerboard behind transparent pixels, "fit" until the user zooms, click to zoom in, Alt+click
// to zoom out, Ctrl/Cmd+wheel or pinch to zoom around the pointer, and a size / zoom label.
// Images come from blob: URLs (workspace files are read through IPC, never by URL).
import { h, on } from "../../core/dom/index";
import { DisposableStore } from "../../core/lifecycle/index";

const STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 20];

export class ImageCanvas {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly img: HTMLImageElement;
  private readonly label: HTMLElement;
  private readonly error: HTMLElement;
  /** null = fit to the view (never larger than 100%). */
  private scale: number | null = null;
  private url: string | null = null;
  private bytes = 0;
  /** Called when zoom changes (the tab's actions show fit vs. 100%). */
  onZoom: () => void = () => {};

  constructor() {
    this.img = h("img", { class: "image-canvas-img", alt: "", draggable: "false" });
    this.label = h("div", { class: "image-canvas-label" });
    this.error = h("div", { class: "empty-state image-canvas-error", hidden: true });
    this.element = h(
      "div",
      { class: "image-canvas is-fit", tabindex: "0" },
      h("div", { class: "image-canvas-stage" }, this.img),
      this.label,
      this.error,
    );
    this.store.add(on(this.img, "load", () => this.apply()));
    this.store.add(
      on(this.img, "error", () =>
        this.showError("This image can't be shown (unsupported or corrupt)."),
      ),
    );
    this.store.add(
      on(this.element, "click", (e) => {
        if (e.target !== this.img) return;
        this.zoom(e.altKey ? "out" : "in", e);
      }),
    );
    this.store.add(
      on(
        this.element,
        "wheel",
        (e) => {
          if (!e.ctrlKey && !e.metaKey) return;
          e.preventDefault();
          this.zoom(e.deltaY < 0 ? "in" : "out", e);
        },
        { passive: false },
      ),
    );
    this.store.add({ dispose: () => this.setUrl(null, 0) });
  }

  /** Shows the image at `url` (a blob: URL this canvas now owns and revokes). */
  setUrl(url: string | null, bytes: number): void {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = url;
    this.bytes = bytes;
    this.error.hidden = true;
    if (url) this.img.src = url;
    else this.img.removeAttribute("src");
  }

  showError(message: string): void {
    this.error.textContent = message;
    this.error.hidden = false;
    this.label.textContent = "";
  }

  get zoomLevel(): number | null {
    return this.scale;
  }

  zoom(
    direction: "in" | "out" | "fit" | "actual",
    at?: { clientX: number; clientY: number },
  ): void {
    if (direction === "fit") this.scale = null;
    else if (direction === "actual") this.scale = 1;
    else {
      const now = this.scale ?? this.fitScale();
      const next =
        direction === "in"
          ? (STEPS.find((s) => s > now + 1e-3) ?? STEPS[STEPS.length - 1])
          : ([...STEPS].reverse().find((s) => s < now - 1e-3) ?? STEPS[0]);
      this.scale = next ?? now;
    }
    // Keep the point under the pointer in place while zooming.
    const box = this.element.getBoundingClientRect();
    const fx = at
      ? (at.clientX - box.left + this.element.scrollLeft) / Math.max(1, this.element.scrollWidth)
      : 0.5;
    const fy = at
      ? (at.clientY - box.top + this.element.scrollTop) / Math.max(1, this.element.scrollHeight)
      : 0.5;
    this.apply();
    if (this.scale !== null) {
      this.element.scrollLeft =
        fx * this.element.scrollWidth - (at ? at.clientX - box.left : box.width / 2);
      this.element.scrollTop =
        fy * this.element.scrollHeight - (at ? at.clientY - box.top : box.height / 2);
    }
    this.onZoom();
  }

  private fitScale(): number {
    const w = this.img.naturalWidth || 1;
    const hgt = this.img.naturalHeight || 1;
    const box = this.element.getBoundingClientRect();
    return Math.min(1, (box.width - 32) / w, (box.height - 32) / hgt);
  }

  /** Re-applies the zoom (after load or a resize). */
  apply(): void {
    const w = this.img.naturalWidth;
    const hgt = this.img.naturalHeight;
    const fit = this.scale === null;
    this.element.classList.toggle("is-fit", fit);
    const scale = fit ? this.fitScale() : (this.scale as number);
    if (w && hgt) {
      this.img.style.width = `${Math.max(1, Math.round(w * scale))}px`;
      this.img.style.height = `${Math.max(1, Math.round(hgt * scale))}px`;
      // Pixel art stays crisp when enlarged.
      this.img.classList.toggle("is-pixelated", scale > 2);
      const size = this.bytes ? ` · ${formatBytes(this.bytes)}` : "";
      this.label.textContent = `${w} × ${hgt}${size} · ${Math.round(scale * 100)}%${fit ? " (fit)" : ""}`;
    }
  }

  dispose(): void {
    this.store.dispose();
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};

/** Raster formats the webview can draw (opened in the image viewer by default). */
export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif"];

export function mimeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  return MIME[path.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

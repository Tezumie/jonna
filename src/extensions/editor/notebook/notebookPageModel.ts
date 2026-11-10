// The layout of a controller's output page (D295, notebookPage.ts): every output drawn by an
// extension's renderer is one element of a single page per notebook, as VS Code's back-layer
// webview has them, placed over the slot its cell keeps for it. The page lies over the cell list;
// its clip path is the union of the slots' visible rectangles, so only those take the pointer and
// the cells stay usable everywhere else. DOM-free and tested.

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The part of `rect` inside every one of `clips` (a collapsed or scrolled outputs area). */
export function visibleRect(rect: Rect, clips: readonly Rect[]): Rect | null {
  let left = rect.left;
  let top = rect.top;
  let right = rect.left + rect.width;
  let bottom = rect.top + rect.height;
  for (const c of clips) {
    left = Math.max(left, c.left);
    top = Math.max(top, c.top);
    right = Math.min(right, c.left + c.width);
    bottom = Math.min(bottom, c.top + c.height);
  }
  if (right - left <= 0 || bottom - top <= 0) return null;
  return { left, top, width: right - left, height: bottom - top };
}

const px = (n: number) => String(Math.round(n * 100) / 100);

/**
 * A CSS clip-path showing only `rects` (each a subpath, clockwise, so they add up under the
 * default nonzero rule); nothing at all without any.
 */
export function clipPathOf(rects: readonly Rect[]): string {
  const shown = rects.filter((r) => r.width > 0 && r.height > 0);
  if (!shown.length) return "inset(0 100% 100% 0)";
  const d = shown
    .map((r) => `M${px(r.left)} ${px(r.top)}h${px(r.width)}v${px(r.height)}h${px(-r.width)}Z`)
    .join("");
  return `path('${d}')`;
}

/** One slot's place in the page (`visible` false: hidden, its element too). */
export interface SlotPlace {
  id: string;
  top: number;
  left: number;
  width: number;
  visible: boolean;
}

/** The page's heights report: `{ id, height }` pairs (others left out). */
export function readHeights(value: unknown): { id: string; height: number }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((x) => {
    const o = (x ?? {}) as { id?: unknown; height?: unknown };
    return typeof o.id === "string" && typeof o.height === "number" && Number.isFinite(o.height)
      ? [{ id: o.id, height: Math.max(0, Math.min(o.height, 100_000)) }]
      : [];
  });
}

/** The places that changed since `before` (by id), to post only those. */
export function changedPlaces(
  before: ReadonlyMap<string, SlotPlace>,
  now: readonly SlotPlace[],
): SlotPlace[] {
  return now.filter((p) => {
    const b = before.get(p.id);
    return (
      !b ||
      b.visible !== p.visible ||
      Math.abs(b.top - p.top) > 0.5 ||
      Math.abs(b.left - p.left) > 0.5 ||
      Math.abs(b.width - p.width) > 0.5
    );
  });
}

/** An output's data as the page's renderers get it: one item per mime type, in its order. */
export function outputItems(
  data: Readonly<Record<string, unknown>>,
  metadata: Readonly<Record<string, unknown>>,
): { mime: string; value: unknown; metadata: unknown }[] {
  const textual = (mime: string) =>
    mime.startsWith("text/") || mime === "image/svg+xml" || mime === "application/javascript";
  return Object.entries(data).map(([mime, value]) => ({
    mime,
    // nbformat keeps text as a list of lines.
    value:
      textual(mime) && Array.isArray(value) && value.every((v) => typeof v === "string")
        ? value.join("")
        : value,
    metadata: (metadata[mime] as unknown) ?? metadata,
  }));
}

/** VS Code's host for a webview's local files (a controller's asWebviewUri addresses). */
const RESOURCE = /^https:\/\/file(?:\+|%2b)\.vscode-resource\.vscode-cdn\.net(\/[^?#]*)/i;

/**
 * The local path a page asks for with one of VS Code's webview addresses
 * (`https://file%2B.vscode-resource.vscode-cdn.net/c%3A/x/a.js`), or null for any other address.
 * Windows drive paths come back with backslashes.
 */
export function resourcePathOf(url: string): string | null {
  const m = RESOURCE.exec(url);
  if (!m?.[1]) return null;
  let path: string;
  try {
    path = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  if (path.split("/").includes("..")) return null;
  const drive = /^\/([A-Za-z]:)(\/.*)?$/.exec(path);
  return drive ? `${drive[1]}${(drive[2] ?? "/").replace(/\//g, "\\")}` : path;
}

const RESOURCE_TYPES: Readonly<Record<string, string>> = {
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  css: "text/css",
  json: "application/json",
  map: "application/json",
  html: "text/html",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  wasm: "application/wasm",
};

/** A file's media type for the page (by its extension; unknown ones are bytes). */
export function resourceType(path: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
  return RESOURCE_TYPES[ext] ?? "application/octet-stream";
}

// Open VSX's pictures and texts for the Extensions view and an extension's store page: the
// window's CSP loads no remote images (and nothing loads from the page, AGENTS.md), so the
// backend fetches them from Open VSX's hosts only (src-tauri extensions/store.rs `file`, size-
// capped) and they're shown as blob: URLs. Cached for the window's life; a few fetches at once.

import { h } from "../../core/dom/index";
import { readmeImageSource } from "../../core/extensions/openVsx";
import { extIpc } from "../../core/ipc/extensions";
import { remoteImages, sniffImage } from "../../core/ipc/remoteImage";
import type { WorkbenchServices } from "../../workbench/services";

const MAX_IMAGES = 400;
const MAX_TEXTS = 30;
/** Fetches at once: Open VSX is a shared service. */
const MAX_PARALLEL = 4;
/** A failed picture is tried again after this long (not on every re-render). */
const RETRY_MS = 60_000;

type Entry = { url: string | null; at: number };
const images = new Map<string, Entry>();
const loadingImages = new Map<string, Promise<string | null>>();
const texts = new Map<string, Promise<string>>();

let running = 0;
const waiting: (() => void)[] = [];
async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await task();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function remember(url: string, entry: Entry): void {
  images.delete(url);
  images.set(url, entry);
  while (images.size > MAX_IMAGES) {
    const [oldest, old] = images.entries().next().value as [string, Entry];
    images.delete(oldest);
    // Still shown somewhere maybe: revoked a little later, by which time a re-render has a new one.
    if (old.url) {
      const stale = old.url;
      setTimeout(() => URL.revokeObjectURL(stale), 30_000);
    }
  }
}

/**
 * A blob: URL for an Open VSX picture: at once when it's known (string or null), else a
 * promise. `kind` "icon" for an extension's icon, "image" for a README's.
 */
export function storeImage(
  url: string,
  kind: "icon" | "image" = "icon",
): string | null | Promise<string | null> {
  const known = images.get(url);
  if (known && (known.url || Date.now() - known.at < RETRY_MS)) {
    // Most recently used last, so the oldest go first.
    images.delete(url);
    images.set(url, known);
    return known.url;
  }
  const busy = loadingImages.get(url);
  if (busy) return busy;
  const load = limited(() => extIpc.storeImage(url, kind))
    .then((bytes) => {
      const mime = sniffImage(bytes);
      const blob = mime ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime })) : null;
      remember(url, { url: blob, at: Date.now() });
      return blob;
    })
    .catch(() => {
      remember(url, { url: null, at: Date.now() });
      return null;
    })
    .finally(() => loadingImages.delete(url));
  loadingImages.set(url, load);
  return load;
}

/** Whether an icon is already loaded (a row can show it without waiting to be seen). */
export function storeImageKnown(url: string): boolean {
  return !!images.get(url)?.url;
}

/** A README, changelog or package.json from Open VSX (cached; a failure is retried next time). */
export function storeText(url: string): Promise<string> {
  const known = texts.get(url);
  if (known) return known;
  const load = limited(() => extIpc.storeText(url));
  texts.set(url, load);
  load.catch(() => texts.delete(url));
  while (texts.size > MAX_TEXTS) {
    const oldest = texts.keys().next().value as string;
    texts.delete(oldest);
  }
  return load;
}

/**
 * A store README's image: Open VSX's own files through the store's fetch, other https images
 * through the Markdown preview's remote images (when `markdown.preview.remoteImages` allows).
 */
export function readmeImage(
  services: WorkbenchServices,
  src: string,
  base: string | undefined,
): string | null | Promise<string | null> {
  const source = readmeImageSource(src, base);
  if (!source) return null;
  if (source.kind === "data") return source.url;
  if (source.kind === "store") return storeImage(source.url, "image");
  return services.settings.peek<boolean>("markdown.preview.remoteImages") === false
    ? null
    : remoteImages.url(source.url);
}

const TINTS = ["ts", "python", "style", "rust", "go", "markup", "json", "shell"];

/**
 * An Open VSX extension's tile: its initials on a tint until its icon is loaded. With `lazy`,
 * the icon is fetched when the tile is first seen (the view's IntersectionObserver calls
 * `loadStoreIcon`), else at once.
 */
export function storeAvatar(
  item: { id: string; displayName: string; iconUrl?: string },
  size: "md" | "lg" = "md",
  lazy = false,
): HTMLElement {
  const initials =
    item.displayName
      .split(/[\s._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w.charAt(0).toUpperCase())
      .join("") || "?";
  let hash = 0;
  for (const c of item.id) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  const tint = TINTS[Math.abs(hash) % TINTS.length] ?? "ts";
  const el = h(
    "div",
    {
      class: `ext-avatar is-${size}`,
      style: { "--ext-tint": `var(--file-icon-${tint})` },
      "aria-hidden": "true",
    },
    initials,
  );
  if (!item.iconUrl) return el;
  el.dataset.storeIcon = item.iconUrl;
  if (!lazy || storeImageKnown(item.iconUrl)) loadStoreIcon(el);
  return el;
}

/** Fetches (or takes from the cache) a tile's icon and shows it in place of the initials. */
export function loadStoreIcon(el: HTMLElement): void {
  const url = el.dataset.storeIcon;
  if (!url) return;
  delete el.dataset.storeIcon;
  const show = (blob: string | null) => {
    if (!blob) return;
    el.classList.add("has-image");
    el.replaceChildren(h("img", { src: blob, alt: "" }));
  };
  const got = storeImage(url, "icon");
  if (got instanceof Promise) void got.then(show);
  else show(got);
}

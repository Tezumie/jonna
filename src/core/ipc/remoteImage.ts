// https:// images in Markdown (D210): the window's CSP allows no remote images, so the backend
// fetches them (public https hosts only, size and type checked: src-tauri/src/ipc/remote_image.rs)
// and they're shown as blob: URLs, shared by every preview for the window's life. The type is
// read from the bytes; anything that isn't a known picture shows the alt text.
import { call } from "./invoke";

const MAX_CACHED = 300;
/** The pictures kept in all (each may be up to 10 MB): the oldest go past this. */
const MAX_CACHED_BYTES = 64 * 1024 * 1024;
/** Fetches at once (a README with hundreds of badges doesn't open hundreds of requests). */
const MAX_PARALLEL = 6;
/** A failed fetch is retried after this long (not on every re-render). */
const RETRY_MS = 60_000;

type Entry = { url: string | null; at: number; bytes: number };
const cache = new Map<string, Entry>();
const loading = new Map<string, Promise<string | null>>();
let cachedBytes = 0;

let running = 0;
const waiting: (() => void)[] = [];
/** Runs `task` when fewer than MAX_PARALLEL fetches are under way. */
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

/** The picture's type from its first bytes, or null for anything that isn't one. */
export function sniffImage(b: Uint8Array): string | null {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (at(4, 0x66, 0x74, 0x79, 0x70)) {
    const brand = String.fromCharCode(...b.subarray(8, 12));
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  if (at(0, 0x42, 0x4d)) return "image/bmp";
  if (at(0, 0, 0, 1, 0)) return "image/x-icon";
  // SVG (badges): text that has an <svg element near the start. Shown through <img>, which runs
  // no script in it.
  const head = new TextDecoder().decode(b.subarray(0, 2048)).replace(/^﻿/, "").trimStart();
  if (head.startsWith("<") && /<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

async function fetchImage(src: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const bytes = new Uint8Array(
    await limited(() => call<ArrayBuffer>("remote_image", { url: src })),
  );
  const mime = sniffImage(bytes);
  return mime ? { bytes, mime } : null;
}

function remember(src: string, entry: Entry): void {
  const before = cache.get(src);
  if (before) {
    cache.delete(src);
    cachedBytes -= before.bytes;
    if (before.url) URL.revokeObjectURL(before.url);
  }
  cache.set(src, entry);
  cachedBytes += entry.bytes;
  while (cache.size > MAX_CACHED || (cachedBytes > MAX_CACHED_BYTES && cache.size > 1)) {
    const [oldest, old] = cache.entries().next().value as [string, Entry];
    cache.delete(oldest);
    cachedBytes -= old.bytes;
    if (old.url) URL.revokeObjectURL(old.url);
  }
}

export const remoteImages = {
  /** A blob: URL for an https image: at once when it's known, else when it's loaded (null: alt). */
  url(src: string): string | null | Promise<string | null> {
    const known = cache.get(src);
    if (known && (known.url || Date.now() - known.at < RETRY_MS)) return known.url;
    const busy = loading.get(src);
    if (busy) return busy;
    const load = fetchImage(src)
      .then((img) => {
        const url = img
          ? URL.createObjectURL(new Blob([img.bytes as BlobPart], { type: img.mime }))
          : null;
        remember(src, { url, at: Date.now(), bytes: img?.bytes.length ?? 0 });
        return url;
      })
      .catch(() => {
        remember(src, { url: null, at: Date.now(), bytes: 0 });
        return null;
      })
      .finally(() => loading.delete(src));
    loading.set(src, load);
    return load;
  },
  /** The same picture as a data: URL (self-contained HTML for extension pages); not cached. */
  async dataUrl(src: string): Promise<string | null> {
    const img = await fetchImage(src).catch(() => null);
    if (!img) return null;
    let binary = "";
    for (let i = 0; i < img.bytes.length; i += 0x8000)
      binary += String.fromCharCode(...img.bytes.subarray(i, i + 0x8000));
    return `data:${img.mime};base64,${btoa(binary)}`;
  },
};

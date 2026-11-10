// nbformat's output shape (D202): read from a file or from an extension's notebook data into the
// editor's (`text` and mime strings joined). DOM-free; tested through the notebook model's tests.
import type { NbOutput } from "./types";

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** nbformat's "multiline string": a string or a list of lines. */
export const joinText = (v: unknown): string =>
  Array.isArray(v)
    ? v.map((x) => (typeof x === "string" ? x : "")).join("")
    : typeof v === "string"
      ? v
      : "";

/** `o[k] = value` as an own key even for "__proto__" (a file's key is kept, never a prototype). */
export function setOwn(o: Record<string, unknown>, k: string, value: unknown): void {
  Object.defineProperty(o, k, { value, enumerable: true, writable: true, configurable: true });
}

/** The raster image types a model reads (MCP image content, D222). */
const RASTER = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/**
 * Outputs' raster images as base64 with their type, in order (one per output: the first raster
 * type it has), at most `max` and `maxBytes` of base64 in all; the rest are left out.
 */
export function outputImages(
  outputs: readonly NbOutput[],
  max = 4,
  maxBytes = 4_000_000,
): { mimeType: string; data: string }[] {
  const out: { mimeType: string; data: string }[] = [];
  let total = 0;
  for (const o of outputs) {
    if (!o.data || out.length >= max) continue;
    const mimeType = RASTER.find((m) => m in (o.data as Record<string, unknown>));
    if (!mimeType) continue;
    // Base64 may come split in lines (nbformat) or with a trailing newline.
    const data = joinText(o.data[mimeType]).replace(/\s+/g, "");
    if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || total + data.length > maxBytes) continue;
    total += data.length;
    out.push({ mimeType, data });
  }
  return out;
}

/** Mime types whose data is JSON, not text (not split into lines). */
export const isJsonMime = (mime: string) => mime === "application/json" || /\+json$/.test(mime);

export function readOutput(raw: unknown): NbOutput | null {
  if (!isObject(raw) || typeof raw.output_type !== "string") return null;
  const out: NbOutput = { ...raw, output_type: raw.output_type };
  if ("text" in raw) out.text = joinText(raw.text);
  if (isObject(raw.data)) {
    const data: Record<string, unknown> = {};
    for (const [mime, value] of Object.entries(raw.data))
      setOwn(data, mime, isJsonMime(mime) ? value : Array.isArray(value) ? joinText(value) : value);
    out.data = data;
  }
  if (Array.isArray(raw.traceback))
    out.traceback = raw.traceback.filter((l): l is string => typeof l === "string");
  return out;
}

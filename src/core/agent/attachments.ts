// Attachments on agent messages (D131): files picked or dropped from anywhere, big pastes and
// images, shown as cards above the message box and sent as context. Workspace files and
// @-mentions stay paths (read when the message is sent); these carry their content. DOM-free.

export interface Upload {
  id: string;
  kind: "image" | "text";
  /** File name, or "Pasted text". */
  name: string;
  /** Text content, or a base64 PNG for images. */
  data: string;
  /** A big paste turned into a card. */
  pasted?: boolean;
  lines?: number;
  /** The text was cut at MAX_TEXT_CHARS. */
  truncated?: boolean;
}

/** What a sent message keeps of its attachments (saved with the chat; image data isn't). */
export interface SentAttachment {
  kind: "image" | "text" | "file" | "mention";
  name: string;
  /** The start of the text (cards show it). */
  preview?: string;
  /** The text itself, up to VIEW_TEXT_CHARS, for the viewer (D158). */
  text?: string;
  lines?: number;
  pasted?: boolean;
  /** A "mention" chip saying the message came from a widget's sendPrompt (D334). */
  widget?: boolean;
}

/** Text a sent attachment keeps for the viewer (saved with the chat). */
export const VIEW_TEXT_CHARS = 50_000;

/** `text` as kept for the viewer: whole, or cut with a note. */
export const viewText = (text: string): string =>
  text.length > VIEW_TEXT_CHARS ? `${text.slice(0, VIEW_TEXT_CHARS)}\n… (cut here)` : text;

export const MAX_UPLOADS = 20;
export const MAX_TEXT_CHARS = 100_000;
const PASTE_MIN_CHARS = 1500;
const PASTE_MIN_LINES = 15;

/** Lines of a text (a final newline doesn't start another). */
export const countLines = (text: string): number =>
  text ? text.replace(/\r?\n$/, "").split("\n").length : 0;

/** A paste big enough to become a card instead of going into the box. */
export const isBigPaste = (text: string): boolean =>
  text.length >= PASTE_MIN_CHARS || countLines(text) >= PASTE_MIN_LINES;

let seq = 0;
const nextId = () => `up${++seq}`;

export function textUpload(name: string, text: string, pasted = false): Upload {
  const truncated = text.length > MAX_TEXT_CHARS;
  return {
    id: nextId(),
    kind: "text",
    name,
    data: truncated ? `${text.slice(0, MAX_TEXT_CHARS)}\n… (truncated)` : text,
    lines: countLines(text),
    ...(pasted && { pasted: true }),
    ...(truncated && { truncated: true }),
  };
}

export const imageUpload = (name: string, png: string): Upload => ({
  id: nextId(),
  kind: "image",
  name,
  data: png,
});

/** Bytes as text, or null for binary files (a NUL byte, or mostly invalid UTF-8, near the start). */
export function decodeText(bytes: Uint8Array): string | null {
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) return null;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const sample = text.slice(0, 4096);
  const bad = sample.split("�").length - 1;
  if (sample.length && bad / sample.length > 0.02) return null;
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i;
export const isImageName = (name: string): boolean => IMAGE_EXT.test(name);

/** An image file's MIME type from its name (`image/png`), "" when it isn't one. */
export function imageMime(name: string): string {
  const ext = IMAGE_EXT.exec(name)?.[1]?.toLowerCase();
  if (!ext) return "";
  return `image/${ext === "jpg" ? "jpeg" : ext === "ico" ? "x-icon" : ext}`;
}

/**
 * The start of a text for a card: no blank lines, long runs of one symbol ("=====") shortened,
 * repeated separator lines dropped, at most `n` characters.
 */
export function previewOf(text: string, n = 300): string {
  const out: string[] = [];
  const isRule = (l: string) => !/[\p{L}\p{N}]/u.test(l) && l.length > 3;
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const l = raw.trim().replace(/([^\w\s])\1{5,}/g, (_m, c: string) => c.repeat(6));
    if (!l) continue;
    if (isRule(l) && out.length && isRule(out[out.length - 1] ?? "")) continue;
    out.push(l);
    if (out.join("\n").length > n) break;
  }
  return out.join("\n").slice(0, n);
}

/** The context an upload sends with the message (images go as images instead). */
export function uploadContext(u: Upload): string | null {
  if (u.kind !== "text") return null;
  const fence = "`".repeat(Math.max(3, ...(u.data.match(/`+/g) ?? []).map((m) => m.length + 1)));
  const head = u.pasted ? "Pasted text" : `Attached file ${u.name}`;
  return `${head}${u.truncated ? " (truncated)" : ""}:\n${fence}\n${u.data}\n${fence}`;
}

export function sentAttachment(u: Upload): SentAttachment {
  return u.kind === "image"
    ? { kind: "image", name: u.name }
    : {
        kind: "text",
        name: u.name,
        preview: previewOf(u.data, 300),
        text: viewText(u.data),
        ...(u.lines && { lines: u.lines }),
        ...(u.pasted && { pasted: true }),
      };
}

/** The card's badge: "PASTED", "PNG", "TS", "FILE". */
export function badgeOf(a: { kind: string; name: string; pasted?: boolean }): string {
  if (a.pasted) return "PASTED";
  const dot = a.name.lastIndexOf(".");
  const ext = dot > 0 ? a.name.slice(dot + 1) : "";
  return (ext || (a.kind === "image" ? "IMG" : "FILE")).toUpperCase().slice(0, 6);
}

/** A file name for saving an upload into the project (D196): its own name, made safe, with an
 * extension that fits (".png" / ".txt" when it has none; a data URL's type for images). */
export function uploadFileName(upload: Pick<Upload, "kind" | "name" | "data" | "pasted">): string {
  const base = (upload.pasted ? "" : upload.name)
    .split(/[\\/]/)
    .pop()
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters aren't allowed in Windows file names.
    ?.replace(/[<>:"|?*\u0000-\u001f]/g, "")
    .trim();
  const fallback = upload.kind === "image" ? "image" : "pasted";
  const name = base && base !== "." && base !== ".." ? base : fallback;
  if (/\.[A-Za-z0-9]{1,8}$/.test(name)) return name;
  if (upload.kind === "text") return `${name}.txt`;
  const mime = /^data:image\/([a-z0-9.+-]+);/i.exec(upload.data)?.[1]?.toLowerCase();
  const ext = mime === "jpeg" ? "jpg" : mime === "svg+xml" ? "svg" : (mime ?? "png");
  return `${name}.${ext}`;
}

/** An upload's bytes: an image's base64 (or data URL) decoded, text as UTF-8. */
export function uploadBytes(upload: Pick<Upload, "kind" | "data">): Uint8Array {
  if (upload.kind === "text") return new TextEncoder().encode(upload.data);
  const b64 = upload.data.startsWith("data:")
    ? upload.data.slice(upload.data.indexOf(",") + 1)
    : upload.data;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

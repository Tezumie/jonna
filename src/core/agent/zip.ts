// Reading .zip attachments (D227): the central directory, and stored or deflated entries through
// the platform's DecompressionStream ("deflate-raw"), so no dependency. Zip64 and encrypted
// entries are listed but not read. DOM-free (DecompressionStream exists in Node and the webview).
import { decodeText, isImageName, MAX_TEXT_CHARS } from "./attachments";

export interface ZipEntry {
  /** Path inside the archive, with forward slashes. */
  name: string;
  dir: boolean;
  size: number;
  /**
   * The entry's bytes, or null when it can't be read (encrypted, zip64, unknown method) or would
   * be bigger than `limit` (the size the archive declares can lie: a "zip bomb").
   */
  read(limit?: number): Promise<Uint8Array | null>;
}

export const isZipName = (name: string): boolean => /\.zip$/i.test(name);

/** True for bytes that start like a zip (local header or an empty archive). */
export const looksLikeZip = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 &&
  bytes[0] === 0x50 &&
  bytes[1] === 0x4b &&
  (bytes[2] === 3 || bytes[2] === 5) &&
  (bytes[3] === 4 || bytes[3] === 6);

/** Inflates `data`, giving up (null) once the output passes `limit` bytes. */
async function inflateRaw(data: Uint8Array, limit: number): Promise<Uint8Array | null> {
  const reader = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Most an entry is read to without a limit of the caller's. */
const DEFAULT_READ_LIMIT = 16 * 1024 * 1024;

/** The entries of a zip archive; throws when the bytes aren't one. */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record is in the last 64 KiB + 22 bytes (it may end in a comment).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip archive.");
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const utf8 = new TextDecoder("utf-8");
  const latin = new TextDecoder("latin1");
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count && at + 46 <= bytes.length; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) break;
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const packed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const rawName = bytes.subarray(at + 46, at + 46 + nameLength);
    // Bit 11: the name is UTF-8; otherwise it's CP437, which latin1 approximates for ASCII names.
    const name = ((flags & 0x800) !== 0 ? utf8 : latin).decode(rawName).replace(/\\/g, "/");
    at += 46 + nameLength + extraLength + commentLength;
    const unreadable = (flags & 1) !== 0 || packed === 0xffffffff || (method !== 0 && method !== 8);
    entries.push({
      name,
      dir: name.endsWith("/"),
      size,
      read: async (limit = DEFAULT_READ_LIMIT) => {
        if (unreadable || local + 30 > bytes.length) return null;
        if (view.getUint32(local, true) !== 0x04034b50) return null;
        const start =
          local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        const data = bytes.subarray(start, start + packed);
        if (data.length < packed) return null;
        if (method === 0) return data.length > limit ? null : data;
        return inflateRaw(data, limit).catch(() => null);
      },
    });
  }
  return entries;
}

/** Files bigger than this are listed but not inlined. */
const MAX_INLINE_FILE = 512 * 1024;

/**
 * A zip as one text attachment: where it is (so the agent can extract it with a command), the
 * file list, then the text files' contents until MAX_TEXT_CHARS. Images and binaries are listed.
 */
export async function zipAsText(
  name: string,
  bytes: Uint8Array,
  path?: string,
): Promise<{ text: string; files: number }> {
  const entries = readZip(bytes).filter((e) => !e.dir && !/(^|\/)__MACOSX\//.test(e.name));
  const head = [
    `Zip archive ${name}${path ? ` at ${path}` : ""}: ${entries.length} file${entries.length === 1 ? "" : "s"}.`,
    path
      ? "To work on these files, extract the archive into the project with a command (ask the user where first)."
      : "It was pasted, so it has no path on disk: its text files are below.",
    "",
    "Files:",
    ...entries.map((e) => `  ${e.name} (${e.size} bytes)`),
  ];
  let text = head.join("\n");
  for (const e of entries) {
    if (text.length >= MAX_TEXT_CHARS) break;
    if (e.size > MAX_INLINE_FILE || isImageName(e.name)) continue;
    const data = await e.read(MAX_INLINE_FILE);
    const content = data && decodeText(data);
    if (content == null) continue;
    text += `\n\n=== ${e.name} ===\n${content}`;
  }
  return { text, files: entries.length };
}

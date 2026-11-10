// File encodings (D199, D204, VS Code's "Reopen / Save with encoding"): every WHATWG encoding.
// Decoding is the platform's TextDecoder. Encoding back: UTF-8 with or without a BOM, UTF-16 LE /
// BE with their BOM and the single-byte code pages here (a table built from the decoder); the
// multi-byte legacy encodings (Shift JIS, EUC-JP, ISO-2022-JP, GBK, GB 18030, Big5, EUC-KR) are
// `native`: written by the Rust side (encoding_rs, the same WHATWG tables). DOM-free, tested.

export interface EncodingInfo {
  id: string;
  label: string;
  /** The TextDecoder label (and the WHATWG name the Rust encoder takes). */
  decoder: string;
  /** Can be written back. */
  canSave: boolean;
  /** Written by the native encoder (no table here). */
  native?: boolean;
}

const single = (id: string, label: string): EncodingInfo => ({
  id,
  label,
  decoder: id,
  canSave: true,
});

const multi = (id: string, label: string): EncodingInfo => ({
  id,
  label,
  decoder: id,
  canSave: true,
  native: true,
});

export const ENCODINGS: readonly EncodingInfo[] = [
  { id: "utf8", label: "UTF-8", decoder: "utf-8", canSave: true },
  { id: "utf8bom", label: "UTF-8 with BOM", decoder: "utf-8", canSave: true },
  { id: "utf16le", label: "UTF-16 LE", decoder: "utf-16le", canSave: true },
  { id: "utf16be", label: "UTF-16 BE", decoder: "utf-16be", canSave: true },
  single("windows-1252", "Western (Windows 1252)"),
  single("iso-8859-1", "Western (ISO 8859-1)"),
  single("iso-8859-3", "Western (ISO 8859-3)"),
  single("iso-8859-15", "Western (ISO 8859-15)"),
  single("macintosh", "Western (Mac Roman)"),
  single("windows-1250", "Central European (Windows 1250)"),
  single("iso-8859-2", "Central European (ISO 8859-2)"),
  single("windows-1251", "Cyrillic (Windows 1251)"),
  single("iso-8859-5", "Cyrillic (ISO 8859-5)"),
  single("koi8-r", "Cyrillic (KOI8-R)"),
  single("koi8-u", "Cyrillic (KOI8-U)"),
  single("ibm866", "Cyrillic (CP 866)"),
  single("x-mac-cyrillic", "Cyrillic (Mac)"),
  single("windows-1253", "Greek (Windows 1253)"),
  single("iso-8859-7", "Greek (ISO 8859-7)"),
  single("windows-1254", "Turkish (Windows 1254)"),
  single("windows-1255", "Hebrew (Windows 1255)"),
  single("iso-8859-8", "Hebrew (ISO 8859-8)"),
  single("iso-8859-8-i", "Hebrew (ISO 8859-8-I)"),
  single("windows-1256", "Arabic (Windows 1256)"),
  single("iso-8859-6", "Arabic (ISO 8859-6)"),
  single("windows-1257", "Baltic (Windows 1257)"),
  single("iso-8859-4", "Baltic (ISO 8859-4)"),
  single("iso-8859-13", "Estonian (ISO 8859-13)"),
  single("iso-8859-10", "Nordic (ISO 8859-10)"),
  single("iso-8859-14", "Celtic (ISO 8859-14)"),
  single("iso-8859-16", "Romanian (ISO 8859-16)"),
  single("windows-1258", "Vietnamese (Windows 1258)"),
  single("windows-874", "Thai (Windows 874)"),
  multi("shift_jis", "Japanese (Shift JIS)"),
  multi("euc-jp", "Japanese (EUC-JP)"),
  multi("iso-2022-jp", "Japanese (ISO-2022-JP)"),
  multi("gbk", "Simplified Chinese (GBK)"),
  multi("gb18030", "Simplified Chinese (GB 18030)"),
  multi("big5", "Traditional Chinese (Big5)"),
  multi("euc-kr", "Korean (EUC-KR)"),
];

export function encodingInfo(id: string): EncodingInfo | undefined {
  return ENCODINGS.find((e) => e.id === id);
}

/**
 * Our encoding for a WHATWG name (the Rust detector's answer, D204): `utf-8` → `utf8`,
 * `utf-16le` → `utf16le`, the others are their own id. Undefined when we don't list it.
 */
export function encodingForWhatwgName(name: string): EncodingInfo | undefined {
  const lower = name.toLowerCase();
  const ids: Record<string, string> = {
    "utf-8": "utf8",
    "utf-16le": "utf16le",
    "utf-16be": "utf16be",
  };
  return encodingInfo(ids[lower] ?? lower);
}

/** The BOM a file starts with, as an encoding id (null: none). */
export function bomEncoding(bytes: Uint8Array): "utf8bom" | "utf16le" | "utf16be" | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf8bom";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf16be";
  return null;
}

/** Bytes → text in `id` (a BOM matching it is dropped). */
export function decodeWith(bytes: Uint8Array, id: string): string {
  const info = encodingInfo(id);
  if (!info) throw new Error(`Unknown encoding ${id}.`);
  const bom = bomEncoding(bytes);
  let body = bytes;
  if ((id === "utf8" || id === "utf8bom") && bom === "utf8bom") body = bytes.subarray(3);
  else if ((id === "utf16le" && bom === "utf16le") || (id === "utf16be" && bom === "utf16be"))
    body = bytes.subarray(2);
  if (info.decoder === LATIN1) return latin1(body);
  return new TextDecoder(info.decoder, { ignoreBOM: true }).decode(body);
}

/**
 * WHATWG decodes the label "iso-8859-1" as Windows-1252 (0x96 is "–"), but real ISO 8859-1 maps
 * every byte to the code point of the same number; a file saved as it must not gain 1252's
 * characters, so it's decoded (and its save table built) byte for byte.
 */
const LATIN1 = "iso-8859-1";
function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192)
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}

const tables = new Map<string, Map<number, number>>();

/** Code point → byte for a single-byte code page (from its decoder). */
function singleByteTable(decoder: string): Map<number, number> {
  let table = tables.get(decoder);
  if (table) return table;
  table = new Map();
  const all = new Uint8Array(256);
  for (let i = 0; i < 256; i++) all[i] = i;
  const chars = [...(decoder === LATIN1 ? latin1(all) : new TextDecoder(decoder).decode(all))];
  chars.forEach((ch, byte) => {
    const cp = ch.codePointAt(0) ?? 0xfffd;
    if (cp !== 0xfffd && !table?.has(cp)) table?.set(cp, byte);
  });
  tables.set(decoder, table);
  return table;
}

/** Characters `text` holds that `id` can't write (up to `limit`). */
export function unencodable(text: string, id: string, limit = 5): string[] {
  const info = encodingInfo(id);
  // Native encodings are checked by their encoder, which names what it can't hold.
  if (!info?.canSave || info.native || id.startsWith("utf")) return [];
  const table = singleByteTable(info.decoder);
  const out: string[] = [];
  for (const ch of text) {
    if (!table.has(ch.codePointAt(0) ?? 0) && !out.includes(ch)) out.push(ch);
    if (out.length >= limit) break;
  }
  return out;
}

/** Text → bytes in `id`; throws when it can't write some characters (or the encoding at all). */
export function encodeWith(text: string, id: string): Uint8Array {
  const info = encodingInfo(id);
  if (!info) throw new Error(`Unknown encoding ${id}.`);
  if (!info.canSave) throw new Error(`Saving in ${info.label} isn't supported: save as UTF-8.`);
  if (info.native) throw new Error(`${info.label} is written by the native encoder.`);
  if (id === "utf8") return new TextEncoder().encode(text);
  if (id === "utf8bom") {
    const body = new TextEncoder().encode(text);
    const out = new Uint8Array(body.length + 3);
    out.set([0xef, 0xbb, 0xbf]);
    out.set(body, 3);
    return out;
  }
  if (id === "utf16le" || id === "utf16be") {
    const out = new Uint8Array(2 + text.length * 2);
    const le = id === "utf16le";
    out.set(le ? [0xff, 0xfe] : [0xfe, 0xff]);
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      out[2 + i * 2] = le ? unit & 0xff : unit >> 8;
      out[3 + i * 2] = le ? unit >> 8 : unit & 0xff;
    }
    return out;
  }
  const table = singleByteTable(info.decoder);
  const chars = [...text];
  const out = new Uint8Array(chars.length);
  chars.forEach((ch, i) => {
    const byte = table.get(ch.codePointAt(0) ?? 0);
    if (byte === undefined)
      throw new Error(`${info.label} can't hold "${ch}": save as UTF-8, or remove it.`);
    out[i] = byte;
  });
  return out;
}

/** The Rust encoder (D204): text → bytes in a WHATWG encoding; throws "can't hold …". */
export type NativeEncoder = (text: string, whatwgName: string) => Promise<Uint8Array>;

/** Text → bytes in `id`, through the native encoder when the encoding needs it. */
export async function encodeText(
  text: string,
  id: string,
  native: NativeEncoder,
): Promise<Uint8Array> {
  const info = encodingInfo(id);
  if (!info?.native) return encodeWith(text, id);
  try {
    return await native(text, info.decoder);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The IPC error reads "invalid argument: can't hold …" (Rust's Error::Invalid display).
    const held = /can't hold .*/.exec(message);
    if (held) throw new Error(`${info.label} ${held[0]}: save as UTF-8, or remove them.`);
    throw err;
  }
}

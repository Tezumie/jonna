// Bytes on disk ↔ editor text, DOM-free so it is unit-tested: UTF-8 decoding (BOM noted, invalid
// UTF-8 flagged rather than silently replaced), binary detection, and telling an external change
// from the echo of the IDE's own save.

import { bomEncoding, decodeWith, encodingForWhatwgName, encodingInfo } from "./encodings";

const BOM = [0xef, 0xbb, 0xbf];

/** A NUL byte in the first 8 KB means binary (same heuristic as git). */
export function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/**
 * Bytes from disk → text (UTF-8, BOM noted), or binary. Invalid UTF-8 is flagged `notUtf8` (the
 * text then holds U+FFFD replacements, fine to show but not to save back).
 */
/**
 * UTF-16 without a BOM (D200, files.autoGuessEncoding): most of the odd (LE) or even (BE) bytes of
 * the start are NUL and the others hardly ever are — ASCII text saved as UTF-16.
 */
export function guessUtf16(bytes: Uint8Array): "utf16le" | "utf16be" | null {
  const n = Math.min(bytes.length - (bytes.length % 2), 4096);
  if (n < 8) return null;
  let evenNul = 0;
  let oddNul = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) evenNul++;
    if (bytes[i + 1] === 0) oddNul++;
  }
  const pairs = n / 2;
  if (oddNul > pairs * 0.4 && evenNul < pairs * 0.05) return "utf16le";
  if (evenNul > pairs * 0.4 && oddNul < pairs * 0.05) return "utf16be";
  return null;
}

/**
 * How a file that isn't UTF-8 is read (D200, D204): with `files.autoGuessEncoding`, the
 * detector's guess (`guessed`, chardetng in Rust) or else Windows-1252 (the usual legacy encoding
 * of Windows text); otherwise `files.encoding` when it's another encoding; otherwise it opens
 * read-only and asks. VS Code also lets the guess win over files.encoding.
 */
export interface DecodeOptions {
  /** files.encoding: the encoding for files that aren't valid UTF-8. */
  fallback?: string;
  /** files.autoGuessEncoding. */
  guess?: boolean;
  /** The detector's answer for these bytes (a WHATWG name), when `guess` asked for one. */
  guessed?: string | null;
}

/** Valid UTF-8 (an ASCII file is). */
export function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the detector should look at these bytes (D204): guessing is on and they're text that
 * isn't UTF-8 (no BOM, no NUL byte, not BOM-less UTF-16).
 */
export function wantsGuess(bytes: Uint8Array, guess: boolean | undefined): boolean {
  if (!guess || bomEncoding(bytes) || guessUtf16(bytes) || isBinary(bytes)) return false;
  return !isUtf8(bytes);
}

export function decodeFile(
  bytes: Uint8Array,
  encoding?: string,
  options: DecodeOptions = {},
): {
  text: string;
  binary: boolean;
  hadBom: boolean;
  notUtf8: boolean;
  /** utf8, utf8bom, utf16le, utf16be, or the `encoding` asked for (D199). */
  encoding: string;
} {
  // A file reopened in another encoding (D199) is read in it.
  if (encoding && encoding !== "utf8" && encoding !== "utf8bom") {
    return {
      text: decodeWith(bytes, encoding),
      binary: false,
      hadBom: false,
      notUtf8: false,
      encoding,
    };
  }
  // UTF-16 with its BOM is text, though half its bytes are NUL.
  const bom = bomEncoding(bytes);
  if (bom === "utf16le" || bom === "utf16be")
    return {
      text: decodeWith(bytes, bom),
      binary: false,
      hadBom: true,
      notUtf8: false,
      encoding: bom,
    };
  if (options.guess) {
    const utf16 = guessUtf16(bytes);
    if (utf16)
      return {
        text: decodeWith(bytes, utf16),
        binary: false,
        hadBom: false,
        notUtf8: false,
        encoding: utf16,
      };
  }
  const binary = isBinary(bytes);
  const hadBom = BOM.every((b, i) => bytes[i] === b);
  const enc = hadBom ? "utf8bom" : "utf8";
  if (binary) return { text: "", binary, hadBom, notUtf8: false, encoding: enc };
  const body = hadBom ? bytes.subarray(3) : bytes;
  try {
    // ignoreBOM: the BOM was already stripped; a second one is content.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
    return { text, binary, hadBom, notUtf8: false, encoding: enc };
  } catch {
    const guessed = options.guessed ? encodingForWhatwgName(options.guessed) : undefined;
    const fallback =
      options.fallback && !options.fallback.startsWith("utf") ? options.fallback : null;
    const other = options.guess
      ? guessed && !guessed.id.startsWith("utf")
        ? guessed.id
        : (fallback ?? "windows-1252")
      : fallback;
    // Read in it; one we can't write back (Shift JIS…) stays read-only.
    if (other && encodingInfo(other))
      return {
        text: decodeWith(bytes, other),
        binary,
        hadBom: false,
        notUtf8: !encodingInfo(other)?.canSave,
        encoding: other,
      };
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(body);
    return { text, binary, hadBom, notUtf8: true, encoding: enc };
  }
}

/**
 * For a read-only document (opened from bytes that weren't UTF-8, or in an encoding that can't be
 * written): its file's new bytes read as UTF-8 (or UTF-16 with a BOM) when they now are — the file
 * was rewritten as UTF-8 elsewhere, so the document becomes writable (D218). Null when they still
 * need the old reading (or are binary).
 */
export function utf8Again(
  bytes: Uint8Array,
): { text: string; encoding: string; hadBom: boolean } | null {
  const reading = decodeFile(bytes);
  if (reading.binary || reading.notUtf8) return null;
  return { text: reading.text, encoding: reading.encoding, hadBom: reading.hadBom };
}

/**
 * What a file-watcher report means for an open document: "same" (disk matches the buffer),
 * "ownWrite" (disk holds what the IDE last loaded or wrote: the echo of our own save, even if the
 * user typed on since), or "external" (someone else changed the file).
 */
export function diskChange(
  disk: string,
  current: string,
  lastKnown: string | undefined,
): "same" | "ownWrite" | "external" {
  if (disk === current) return "same";
  if (disk === lastKnown) return "ownWrite";
  return "external";
}

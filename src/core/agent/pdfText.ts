// The text of a PDF, for the agent's read_file (D253): no library (pdf.js would be ~2 MB for what
// the agent needs, which is the words). It reads the objects (object streams too), inflates
// FlateDecode streams with the platform's DecompressionStream, walks the page tree, and turns
// each page's text operators into lines, decoding strings through the font's ToUnicode map (or
// its simple encoding). Form XObjects are followed. Scanned pages (images only), encrypted files
// and exotic encodings give little or no text: the caller says so instead of guessing.

/** The pages' text, in order. */
export interface PdfText {
  pages: string[];
  /** The file is encrypted (its strings can't be read). */
  encrypted: boolean;
}

/** Most pages read (a 2000-page manual is still mostly reachable with offset). */
const MAX_PAGES = 1000;
/** Most characters kept in all. */
const MAX_CHARS = 3_000_000;
/** How deep Form XObjects nest before we stop following them. */
const MAX_FORM_DEPTH = 4;
/** Most Form XObjects run for a page: forms calling each other many times would multiply. */
const MAX_FORM_RUNS = 1000;

// --- Values ------------------------------------------------------------------------------------

type PdfValue =
  | number
  | boolean
  | null
  | { name: string }
  | { str: string } // bytes as a binary string (one char per byte)
  | { ref: number }
  | PdfValue[]
  | PdfDict;
interface PdfDict {
  dict: Map<string, PdfValue>;
}

interface PdfObject {
  value: PdfValue;
  /** The stream's raw bytes (binary string), undecoded. */
  stream?: string;
}

const isDict = (v: PdfValue | undefined): v is PdfDict =>
  typeof v === "object" && v !== null && "dict" in v;
const isName = (v: PdfValue | undefined): v is { name: string } =>
  typeof v === "object" && v !== null && "name" in v;
const isRef = (v: PdfValue | undefined): v is { ref: number } =>
  typeof v === "object" && v !== null && "ref" in v;

const WHITE = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set("()<>[]{}/%".split("").map((c) => c.charCodeAt(0)));

/** A tokenizer over a binary string: PDF objects and content streams use the same syntax. */
class Lexer {
  pos = 0;
  constructor(readonly s: string) {}

  private skipWhite(): void {
    const s = this.s;
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos);
      if (WHITE.has(c)) this.pos++;
      else if (c === 37 /* % */) {
        while (this.pos < s.length && s[this.pos] !== "\n" && s[this.pos] !== "\r") this.pos++;
      } else break;
    }
  }

  /** The next token: a value, or an operator / keyword as `{ op }`; null at the end. */
  next(): PdfValue | { op: string } | { close: string } | undefined {
    this.skipWhite();
    const s = this.s;
    if (this.pos >= s.length) return undefined;
    const c = s[this.pos] as string;
    if (c === "/") {
      let end = this.pos + 1;
      while (end < s.length && !WHITE.has(s.charCodeAt(end)) && !DELIM.has(s.charCodeAt(end)))
        end++;
      const raw = s.slice(this.pos + 1, end);
      this.pos = end;
      return {
        name: raw.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))),
      };
    }
    if (c === "(") return { str: this.literal() };
    if (c === "<") {
      if (s[this.pos + 1] === "<") {
        this.pos += 2;
        return this.dict();
      }
      const end = s.indexOf(">", this.pos);
      const hex = s.slice(this.pos + 1, end < 0 ? s.length : end).replace(/[^0-9a-fA-F]/g, "");
      this.pos = end < 0 ? s.length : end + 1;
      let out = "";
      for (let i = 0; i < hex.length; i += 2)
        out += String.fromCharCode(parseInt((hex.slice(i, i + 2) + "0").slice(0, 2), 16));
      return { str: out };
    }
    if (c === "[") {
      this.pos++;
      const items: PdfValue[] = [];
      for (;;) {
        const t = this.value();
        if (t === undefined || (typeof t === "object" && t !== null && "close" in t)) break;
        items.push(t as PdfValue);
      }
      return items;
    }
    if (c === "]" || c === ">" || c === ")" || c === "}" || c === "{") {
      this.pos += c === ">" && s[this.pos + 1] === ">" ? 2 : 1;
      return { close: c };
    }
    let end = this.pos;
    while (end < s.length && !WHITE.has(s.charCodeAt(end)) && !DELIM.has(s.charCodeAt(end))) end++;
    if (end === this.pos) end++;
    const word = s.slice(this.pos, end);
    this.pos = end;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      // "12 0 R" is a reference.
      const save = this.pos;
      if (/^\d+$/.test(word)) {
        const m = /^\s+(\d+)\s+R(?=[\s/<>[\]()%]|$)/.exec(s.slice(this.pos, this.pos + 24));
        if (m) {
          this.pos += m[0].length;
          return { ref: Number(word) };
        }
      }
      this.pos = save;
      return Number(word);
    }
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    return { op: word };
  }

  /** A value (operators inside arrays and dicts are skipped as nothing). */
  private value(): PdfValue | { close: string } | undefined {
    for (;;) {
      const t = this.next();
      if (t === undefined) return undefined;
      if (typeof t === "object" && t !== null && "op" in t) continue;
      return t;
    }
  }

  private dict(): PdfDict {
    const dict = new Map<string, PdfValue>();
    for (;;) {
      const key = this.value();
      if (key === undefined || (typeof key === "object" && key !== null && "close" in key)) break;
      if (!isName(key as PdfValue)) continue;
      const v = this.value();
      if (v === undefined || (typeof v === "object" && v !== null && "close" in v)) break;
      dict.set((key as { name: string }).name, v as PdfValue);
    }
    return { dict };
  }

  private literal(): string {
    const s = this.s;
    let depth = 0;
    let out = "";
    this.pos++; // (
    while (this.pos < s.length) {
      const c = s[this.pos++] as string;
      if (c === "\\") {
        const e = s[this.pos++] ?? "";
        const map: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
        if (e in map) out += map[e];
        else if (/[0-7]/.test(e)) {
          let oct = e;
          while (oct.length < 3 && /[0-7]/.test(s[this.pos] ?? "")) oct += s[this.pos++];
          out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        } else if (e === "\r") {
          if (s[this.pos] === "\n") this.pos++;
        } else if (e !== "\n") out += e;
      } else if (c === "(") {
        depth++;
        out += c;
      } else if (c === ")") {
        if (depth === 0) break;
        depth--;
        out += c;
      } else out += c;
    }
    return out;
  }
}

// --- The file ----------------------------------------------------------------------------------

/** Bytes as a binary string, one char per byte (latin1 would remap 0x80–0x9F). */
function binary(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}

function bytesOf(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

async function inflate(data: string): Promise<string | null> {
  for (const format of ["deflate", "deflate-raw"] as const) {
    try {
      const stream = new Blob([bytesOf(data) as BlobPart])
        .stream()
        .pipeThrough(new DecompressionStream(format));
      return binary(new Uint8Array(await new Response(stream).arrayBuffer()));
    } catch {
      // A truncated stream throws at its end: try the other framing, then give up.
    }
  }
  return null;
}

function ascii85(data: string): string {
  const s = data.replace(/\s/g, "").replace(/~>.*$/, "");
  let out = "";
  let group: number[] = [];
  for (const ch of s) {
    if (ch === "z" && !group.length) {
      out += "\0\0\0\0";
      continue;
    }
    group.push(ch.charCodeAt(0) - 33);
    if (group.length === 5) {
      let n = 0;
      for (const d of group) n = n * 85 + d;
      out += String.fromCharCode((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
      group = [];
    }
  }
  if (group.length > 1) {
    const pad = 5 - group.length;
    while (group.length < 5) group.push(84);
    let n = 0;
    for (const d of group) n = n * 85 + d;
    const bytes = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    out += String.fromCharCode(...bytes.slice(0, 4 - pad));
  }
  return out;
}

class PdfFile {
  readonly objects = new Map<number, PdfObject>();
  private readonly decoded = new Map<number, string | null>();
  trailer: PdfDict | null = null;

  constructor(readonly s: string) {
    this.scan();
  }

  /** Every `N G obj … endobj` in the file (later ones win: incremental updates). */
  private scan(): void {
    const s = this.s;
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    for (let m = re.exec(s); m; m = re.exec(s)) {
      const num = Number(m[1]);
      const lexer = new Lexer(s);
      lexer.pos = m.index + m[0].length;
      const value = lexer.next();
      if (
        value === undefined ||
        (typeof value === "object" && value !== null && ("op" in value || "close" in value))
      )
        continue;
      const obj: PdfObject = { value: value as PdfValue };
      // A stream follows its dictionary.
      const after = /^\s*stream\r?\n/.exec(s.slice(lexer.pos, lexer.pos + 32));
      if (after && isDict(obj.value)) {
        const start = lexer.pos + after[0].length;
        const length = obj.value.dict.get("Length");
        // A negative length could land on an earlier endstream: the scan would go back and find
        // this object again, forever.
        let end = typeof length === "number" && length >= 0 ? start + length : -1;
        if (end < 0 || !/^\s*endstream/.test(s.slice(end, end + 32))) {
          end = s.indexOf("endstream", start);
          if (end < 0) end = s.length;
          // The EOL before endstream isn't data.
          if (s[end - 1] === "\n") end--;
          if (s[end - 1] === "\r") end--;
        }
        obj.stream = s.slice(start, end);
        re.lastIndex = end;
      } else re.lastIndex = lexer.pos;
      this.objects.set(num, obj);
      if (isDict(obj.value) && (obj.value.dict.get("Type") as { name?: string })?.name === "XRef")
        this.trailer ??= obj.value;
    }
    const t = s.lastIndexOf("trailer");
    if (t >= 0) {
      const lexer = new Lexer(s);
      lexer.pos = t + 7;
      const v = lexer.next();
      if (isDict(v as PdfValue)) this.trailer = v as PdfDict;
    }
  }

  /** Objects packed in object streams (PDF 1.5): unpacked into the table. */
  async unpackObjectStreams(): Promise<void> {
    for (const [num, obj] of [...this.objects]) {
      if (
        !isDict(obj.value) ||
        (obj.value.dict.get("Type") as { name?: string })?.name !== "ObjStm"
      )
        continue;
      const data = await this.streamOf(num);
      if (!data) continue;
      const first = Number(obj.value.dict.get("First")) || 0;
      const header = data.slice(0, first).trim().split(/\s+/).map(Number);
      // No more objects than the header lists: /N is the file's word (1e12 would never end).
      const n = Math.min(Number(obj.value.dict.get("N")) || 0, header.length / 2);
      for (let i = 0; i < n; i++) {
        const inner = header[i * 2];
        const offset = header[i * 2 + 1];
        if (inner === undefined || offset === undefined || this.objects.has(inner)) continue;
        const lexer = new Lexer(data);
        lexer.pos = first + offset;
        const value = lexer.next();
        if (
          value !== undefined &&
          !(typeof value === "object" && value !== null && ("op" in value || "close" in value))
        )
          this.objects.set(inner, { value: value as PdfValue });
      }
    }
  }

  get(v: PdfValue | undefined, depth = 0): PdfValue | undefined {
    if (isRef(v) && depth < 16) return this.get(this.objects.get(v.ref)?.value, depth + 1);
    return v;
  }

  dictOf(v: PdfValue | undefined): Map<string, PdfValue> | null {
    const d = this.get(v);
    return isDict(d) ? d.dict : null;
  }

  /** An object's stream, decoded (FlateDecode, ASCII85, ASCIIHex); null when it can't be. */
  async streamOf(num: number): Promise<string | null> {
    if (this.decoded.has(num)) return this.decoded.get(num) ?? null;
    const obj = this.objects.get(num);
    let data: string | null = obj?.stream ?? null;
    if (data !== null && isDict(obj?.value)) {
      const f = this.get(obj.value.dict.get("Filter"));
      const filters = (Array.isArray(f) ? f : f ? [f] : []).map((x) => (isName(x) ? x.name : ""));
      for (const filter of filters) {
        if (data === null) break;
        if (filter === "FlateDecode" || filter === "Fl") data = await inflate(data);
        else if (filter === "ASCII85Decode" || filter === "A85") data = ascii85(data);
        else if (filter === "ASCIIHexDecode" || filter === "AHx") {
          const hex = data.replace(/[^0-9a-fA-F]/g, "");
          let out = "";
          for (let i = 0; i < hex.length; i += 2)
            out += String.fromCharCode(parseInt((hex.slice(i, i + 2) + "0").slice(0, 2), 16));
          data = out;
        } else data = null; // images (DCT, JBIG2…) and LZW: not text
      }
    }
    this.decoded.set(num, data);
    return data;
  }

  /** The pages in order: the page tree from the catalog, else every /Page object. */
  pages(): Map<string, PdfValue>[] {
    const out: Map<string, PdfValue>[] = [];
    const seen = new Set<Map<string, PdfValue>>();
    const walk = (node: PdfValue | undefined, inherited: Map<string, PdfValue>, depth: number) => {
      const d = this.dictOf(node);
      if (!d || seen.has(d) || depth > 64 || out.length >= MAX_PAGES) return;
      seen.add(d);
      const here = new Map(inherited);
      for (const key of ["Resources"]) if (d.has(key)) here.set(key, d.get(key) as PdfValue);
      const kids = this.get(d.get("Kids"));
      if (Array.isArray(kids)) for (const k of kids) walk(k, here, depth + 1);
      else {
        const page = new Map(d);
        if (!page.has("Resources") && here.has("Resources"))
          page.set("Resources", here.get("Resources") as PdfValue);
        out.push(page);
      }
    };
    const root = this.dictOf(this.trailer?.dict.get("Root"));
    walk(root?.get("Pages"), new Map(), 0);
    if (out.length) return out;
    // No usable catalog (a damaged file): the page objects by number.
    for (const num of [...this.objects.keys()].sort((a, b) => a - b)) {
      const d = this.dictOf(this.objects.get(num)?.value);
      if ((d?.get("Type") as { name?: string })?.name === "Page")
        out.push(d as Map<string, PdfValue>);
      if (out.length >= MAX_PAGES) break;
    }
    return out;
  }
}

// --- Fonts -------------------------------------------------------------------------------------

/** cp1252's 0x80–0x9F (WinAnsiEncoding); the rest of it is latin1. */
const WIN_ANSI_HIGH = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";

/** Glyph names a /Differences array commonly uses that aren't one character. */
const GLYPHS: Record<string, string> = {
  space: " ",
  quoteright: "’",
  quoteleft: "‘",
  quotedblleft: "“",
  quotedblright: "”",
  endash: "–",
  emdash: "—",
  bullet: "•",
  ellipsis: "…",
  fi: "fi",
  fl: "fl",
  ff: "ff",
  ffi: "ffi",
  ffl: "ffl",
  hyphen: "-",
  period: ".",
  comma: ",",
  colon: ":",
  semicolon: ";",
  exclam: "!",
  question: "?",
  parenleft: "(",
  parenright: ")",
  slash: "/",
  quotesingle: "'",
  quotedbl: '"',
  ampersand: "&",
  percent: "%",
  dollar: "$",
  numbersign: "#",
  at: "@",
  plus: "+",
  minus: "−",
  equal: "=",
  underscore: "_",
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};

function glyphText(name: string): string {
  if (name.length === 1) return name;
  // `uniXXXX…` is one UTF-16 unit per four digits (`uni00660069` is "fi", a ligature): read as
  // one number it isn't a code point, and fromCodePoint threw, failing the whole file.
  const uni = /^uni((?:[0-9A-Fa-f]{4})+)$/.exec(name)?.[1];
  if (uni) return String.fromCharCode(...(uni.match(/.{4}/g) ?? []).map((h) => parseInt(h, 16)));
  const u = /^u([0-9A-Fa-f]{4,6})$/.exec(name)?.[1];
  if (u) {
    const code = parseInt(u, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : "";
  }
  return GLYPHS[name] ?? "";
}

interface Font {
  /** Codes are two bytes (a Type0 font). */
  twoByte: boolean;
  map: Map<number, string>;
  /** A simple font's fallback for codes not in `map`. */
  simple: (code: number) => string;
}

function utf16(s: string): string {
  let out = "";
  for (let i = 0; i + 1 < s.length; i += 2)
    out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
  return out;
}

const codeOf = (s: string) => {
  let n = 0;
  for (let i = 0; i < s.length; i++) n = n * 256 + s.charCodeAt(i);
  return n;
};

/** A ToUnicode CMap's bfchar and bfrange entries. */
export function parseToUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  const lexer = new Lexer(cmap);
  const tokens: (PdfValue | { op: string })[] = [];
  for (let t = lexer.next(); t !== undefined; t = lexer.next())
    if (!(typeof t === "object" && t !== null && "close" in t)) tokens.push(t as PdfValue);
  const str = (v: unknown) =>
    typeof v === "object" && v !== null && "str" in v ? (v as { str: string }).str : null;
  // Codes a range may still fill: a few KB of full-width ranges would otherwise cost billions.
  let budget = 1 << 20;
  for (let i = 0; i < tokens.length; i++) {
    const op = (tokens[i] as { op?: string }).op;
    if (op === "beginbfchar") {
      for (
        i++;
        i + 1 < tokens.length && (tokens[i] as { op?: string }).op !== "endbfchar";
        i += 2
      ) {
        const src = str(tokens[i]);
        const dst = str(tokens[i + 1]);
        if (src !== null && dst !== null) map.set(codeOf(src), utf16(dst));
      }
    } else if (op === "beginbfrange") {
      for (
        i++;
        i + 2 < tokens.length && (tokens[i] as { op?: string }).op !== "endbfrange";
        i += 3
      ) {
        const lo = str(tokens[i]);
        const hi = str(tokens[i + 1]);
        const dst = tokens[i + 2];
        if (lo === null || hi === null) continue;
        const from = codeOf(lo);
        const to = Math.min(codeOf(hi), from + 0xffff);
        if (Array.isArray(dst)) {
          dst.forEach((d, k) => {
            const t = str(d);
            if (t !== null && from + k <= to) map.set(from + k, utf16(t));
          });
        } else {
          const base = str(dst);
          if (base === null || base.length < 2) continue;
          // The last UTF-16 unit counts up across the range.
          const head = utf16(base.slice(0, -2));
          const last = (base.charCodeAt(base.length - 2) << 8) | base.charCodeAt(base.length - 1);
          for (let c = from; c <= to && budget > 0; c++, budget--)
            map.set(c, head + String.fromCharCode(last + (c - from)));
        }
      }
    }
  }
  return map;
}

async function loadFont(file: PdfFile, ref: PdfValue | undefined): Promise<Font> {
  const d = file.dictOf(ref);
  const subtype = (file.get(d?.get("Subtype")) as { name?: string } | undefined)?.name;
  const twoByte = subtype === "Type0";
  let map = new Map<number, string>();
  const tu = d?.get("ToUnicode");
  if (isRef(tu)) {
    const cmap = await file.streamOf(tu.ref);
    if (cmap) map = parseToUnicode(cmap);
  }
  // A simple font: WinAnsi (or close to it) plus its /Differences.
  const differences = new Map<number, string>();
  const enc = file.get(d?.get("Encoding"));
  const encDict = file.dictOf(enc);
  const diffs = file.get(encDict?.get("Differences"));
  if (Array.isArray(diffs)) {
    let code = 0;
    for (const x of diffs) {
      if (typeof x === "number") code = x;
      else if (isName(x)) differences.set(code++, glyphText(x.name));
    }
  }
  const simple = (code: number) => {
    const diff = differences.get(code);
    if (diff !== undefined) return diff;
    if (code >= 0x80 && code <= 0x9f) return WIN_ANSI_HIGH[code - 0x80] ?? "";
    return code < 32 ? "" : String.fromCharCode(code);
  };
  return { twoByte, map, simple };
}

/** `s` without control characters (tab, line breaks and the replacement character too). */
function withoutControls(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c < 32 || c === 0x7f || c === 0xfffd) {
      if (c === 9 || c === 10 || c === 13) out += " ";
      continue;
    }
    out += ch;
  }
  return out;
}

function decodeString(font: Font | undefined, s: string): string {
  if (!font) return withoutControls(s);
  let out = "";
  if (font.twoByte) {
    for (let i = 0; i + 1 < s.length; i += 2) {
      const code = (s.charCodeAt(i) << 8) | s.charCodeAt(i + 1);
      out += font.map.get(code) ?? "";
    }
    return out;
  }
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    out += font.map.get(code) ?? font.simple(code);
  }
  return out;
}

// --- Content streams ---------------------------------------------------------------------------

interface Writer {
  lines: string[];
  line: string;
  /** The y of the text last shown: text at another y starts a new line. */
  lastY: number | null;
  /** Form XObjects run so far (MAX_FORM_RUNS). */
  forms: number;
}

const newline = (w: Writer) => {
  w.lines.push(w.line);
  w.line = "";
};

async function runContent(
  file: PdfFile,
  content: string,
  resources: Map<string, PdfValue> | null,
  w: Writer,
  fonts: Map<string, Font>,
  depth: number,
): Promise<void> {
  const fontDict = file.dictOf(resources?.get("Font"));
  const xobjects = file.dictOf(resources?.get("XObject"));
  let font: Font | undefined;
  /** The current line's y (text space; BT starts at 0) and the leading T* moves by. */
  let y = 0;
  let leading = 12;
  const lexer = new Lexer(content);
  const operands: PdfValue[] = [];
  const show = (s: string) => {
    if (w.lastY !== null && Math.abs(y - w.lastY) > 0.5 && w.line) newline(w);
    w.lastY = y;
    w.line += decodeString(font, s);
  };
  for (let t = lexer.next(); t !== undefined; t = lexer.next()) {
    if (typeof t === "object" && t !== null && "close" in t) continue;
    if (!(typeof t === "object" && t !== null && "op" in t)) {
      operands.push(t as PdfValue);
      if (operands.length > 64) operands.shift();
      continue;
    }
    const op = t.op;
    const num = (i: number) => {
      const v = operands[operands.length - i];
      return typeof v === "number" ? v : 0;
    };
    switch (op) {
      case "BI": {
        // An inline image: its data runs to EI.
        const end = content.indexOf("EI", lexer.pos);
        lexer.pos = end < 0 ? content.length : end + 2;
        break;
      }
      case "Tf": {
        const name = operands[operands.length - 2];
        if (isName(name)) {
          const key = `${depth}:${name.name}`;
          let f = fonts.get(key);
          if (!f) {
            f = await loadFont(file, fontDict?.get(name.name));
            fonts.set(key, f);
          }
          font = f;
        }
        break;
      }
      case "Tj": {
        const s = operands[operands.length - 1];
        if (typeof s === "object" && s !== null && "str" in s) show(s.str);
        break;
      }
      case "'":
      case '"': {
        y -= leading;
        const s = operands[operands.length - 1];
        if (typeof s === "object" && s !== null && "str" in s) show(s.str);
        break;
      }
      case "TJ": {
        const arr = operands[operands.length - 1];
        if (Array.isArray(arr))
          for (const part of arr) {
            if (typeof part === "number") {
              // A big negative adjustment is a gap between words.
              if (part < -200 && !w.line.endsWith(" ")) w.line += " ";
            } else if (typeof part === "object" && part !== null && "str" in part) show(part.str);
          }
        break;
      }
      case "BT":
        y = 0;
        break;
      case "TL":
        leading = num(1) || leading;
        break;
      case "Td":
      case "TD":
        if (op === "TD") leading = -num(1) || leading;
        y += num(1);
        if (Math.abs(num(1)) <= 0.01 && num(2) > 0 && w.line && !w.line.endsWith(" "))
          w.line += " ";
        break;
      case "T*":
        y -= leading;
        break;
      case "Tm":
        y = num(1);
        if (w.lastY !== null && Math.abs(y - w.lastY) <= 0.5 && w.line && !w.line.endsWith(" "))
          w.line += " ";
        break;
      case "ET":
        if (w.line && !w.line.endsWith(" ")) w.line += " ";
        break;
      case "Do": {
        const name = operands[operands.length - 1];
        const target = isName(name) ? xobjects?.get(name.name) : undefined;
        const d = file.dictOf(target);
        if (
          depth < MAX_FORM_DEPTH &&
          w.forms < MAX_FORM_RUNS &&
          isRef(target) &&
          (d?.get("Subtype") as { name?: string })?.name === "Form"
        ) {
          w.forms++;
          const inner = await file.streamOf(target.ref);
          if (inner)
            await runContent(
              file,
              inner,
              file.dictOf(d?.get("Resources")) ?? resources,
              w,
              fonts,
              depth + 1,
            );
        }
        break;
      }
    }
    operands.length = 0;
  }
}

/** Tidies a page's lines: trims, joins runs of blank lines, drops control characters. */
function tidy(lines: string[]): string {
  const out: string[] = [];
  for (const raw of lines) {
    const line = withoutControls(raw)
      .replace(/[ \t]+/g, " ")
      .trim();
    if (!line && (!out.length || out[out.length - 1] === "")) continue;
    out.push(line);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/** The text of the PDF in `bytes`, page by page; throws if it isn't a PDF. */
export async function pdfText(bytes: Uint8Array): Promise<PdfText> {
  const s = binary(bytes);
  if (!s.slice(0, 1024).includes("%PDF-")) throw new Error("not a PDF file");
  const file = new PdfFile(s);
  await file.unpackObjectStreams();
  const encrypted = !!file.trailer?.dict.has("Encrypt");
  const pages: string[] = [];
  const fonts = new Map<string, Font>();
  let total = 0;
  for (const page of file.pages()) {
    if (total > MAX_CHARS) break;
    const contents = file.get(page.get("Contents"));
    const refs = (Array.isArray(contents) ? contents : [page.get("Contents")]).filter(isRef);
    let content = "";
    for (const r of refs) content += `${(await file.streamOf(r.ref)) ?? ""}\n`;
    const w: Writer = { lines: [], line: "", lastY: null, forms: 0 };
    // Fonts are per page's resources: keyed by page so two pages' /F1 don't mix.
    fonts.clear();
    await runContent(file, content, file.dictOf(page.get("Resources")), w, fonts, 0);
    newline(w);
    const text = tidy(w.lines);
    total += text.length;
    pages.push(text);
  }
  return { pages, encrypted };
}

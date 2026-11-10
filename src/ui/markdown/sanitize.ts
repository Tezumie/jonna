// Raw HTML in Markdown (D210), as GitHub and VS Code's preview show it: markdown-it with `html`
// on, then a strict sanitizer. The source HTML is never handed to the browser's parser: tags are
// read by a small tokenizer (CommonMark's grammar for open / close tags), checked against an
// allowlist of tags and attributes, and either rebuilt as a tree of plain data (`SafeNode`) or
// (D218, `SafeHtmlWriter`) rewritten as clean HTML that only then goes to an inert DOMParser for
// HTML's tree-building rules (htmlTree.ts checks its tree again); render.ts turns the tree into
// fresh elements. So no script, handler, style, frame or form can come
// through, URLs are limited to http(s), mailto, data:image and relative files, and ids can't
// clobber the app's own (they become `data-anchor`). DOM-free and tested.

/** A tag as written: `<img src="a.png">`, `</a>`, `<br/>`. */
export interface HtmlTag {
  name: string;
  /** Attribute names lowercased; values with character references decoded. */
  attrs: [string, string][];
  close: boolean;
  selfClosing: boolean;
  /** The tag's source text. */
  raw: string;
}

export type SafeNode =
  | { kind: "text"; text: string }
  | { kind: "element"; tag: string; attrs: Record<string, string>; children: SafeNode[] }
  /** A placeholder for a node the caller renders itself (inline Markdown between tags). */
  | { kind: "slot"; index: number };

const ATTR = String.raw`(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>\x60]+|'[^']{0,4000}'|"[^"]{0,4000}"))?)`;
const OPEN = new RegExp(String.raw`<([A-Za-z][A-Za-z0-9-]*)(${ATTR}{0,64})\s*(\/?)>`, "y");
const CLOSE = /<\/([A-Za-z][A-Za-z0-9-]*)\s*>/y;
const ATTR_ITEM = /\s+([A-Za-z_:][\w.:-]*)(?:\s*=\s*([^\s"'=<>`]+|'[^']*'|"[^"]*"))?/g;

/** The tag starting at `text[i]` (a "<"), or null when it isn't one. */
export function readTag(text: string, i: number): HtmlTag | null {
  if (text[i] !== "<") return null;
  if (text[i + 1] === "/") {
    CLOSE.lastIndex = i;
    const m = CLOSE.exec(text);
    if (!m) return null;
    return {
      name: (m[1] as string).toLowerCase(),
      attrs: [],
      close: true,
      selfClosing: false,
      raw: m[0],
    };
  }
  OPEN.lastIndex = i;
  const m = OPEN.exec(text);
  if (!m) return null;
  const attrs: [string, string][] = [];
  for (const a of (m[2] ?? "").matchAll(ATTR_ITEM)) {
    let value = a[2] ?? "";
    if (/^(["']).*\1$/s.test(value)) value = value.slice(1, -1);
    attrs.push([(a[1] as string).toLowerCase(), decodeEntities(value)]);
  }
  return {
    name: (m[1] as string).toLowerCase(),
    attrs,
    close: false,
    selfClosing: m[3] === "/",
    raw: m[0],
  };
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  colon: ":",
  sol: "/",
  tab: "\t",
  newline: "\n",
  lpar: "(",
  rpar: ")",
  period: ".",
  comma: ",",
  excl: "!",
  num: "#",
  percnt: "%",
  semi: ";",
  equals: "=",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
  times: "×",
  divide: "÷",
  deg: "°",
  plusmn: "±",
  larr: "←",
  rarr: "→",
  uarr: "↑",
  darr: "↓",
  check: "✓",
  hearts: "♥",
  star: "☆",
  starf: "★",
  emsp: "\u2003",
  ensp: "\u2002",
  thinsp: "\u2009",
  zwj: "\u200d",
  zwnj: "\u200c",
};

function codePoint(n: number): string {
  // NUL, surrogates and beyond Unicode read as U+FFFD (HTML's rule).
  if (n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return "\ufffd";
  return String.fromCodePoint(n);
}

/**
 * Character references decoded as the browser would in an attribute (numeric ones with or
 * without ";", the common named ones; `&Tab;` and `&colon;` too, so they can't hide a scheme).
 * Unknown names stay as written.
 */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(
    /&(?:#(\d{1,8});?|#[xX]([0-9a-fA-F]{1,7});?|([A-Za-z][A-Za-z0-9]{1,31});)/g,
    (whole, dec?: string, hex?: string, name?: string) => {
      if (dec) return codePoint(Number.parseInt(dec, 10));
      if (hex) return codePoint(Number.parseInt(hex, 16));
      const named = name ? (NAMED[name] ?? NAMED[name.toLowerCase()]) : undefined;
      return named ?? whole;
    },
  );
}

/** A Markdown text's `&name;` / `&#n;` references (CommonMark: the ";" is required). */
export function decodeTextEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g,
    (whole, dec?: string, hex?: string, name?: string) => {
      if (dec) return codePoint(Number.parseInt(dec, 10));
      if (hex) return codePoint(Number.parseInt(hex, 16));
      return (name && NAMED[name]) ?? whole;
    },
  );
}

const IMAGE_DATA =
  /^data:image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)[;,]/;

/** C0 / C1 controls, space, soft hyphen, zero-width characters, BOM. */
function isInvisible(code: number): boolean {
  return (
    code <= 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0xad ||
    (code >= 0x200b && code <= 0x200f) ||
    code === 0xfeff
  );
}

/**
 * A URL fit for a link (`kind: "link"`: http, https, mailto, `#anchor`, a relative file) or an
 * image (`"image"`: http, https, data:image/…, a relative file), else null. Character references,
 * whitespace and control characters can't hide a scheme ("jav&#x09;ascript:"); a UNC or
 * protocol-relative path ("\\host\share", "//host") is refused (Windows would reach the network).
 */
export function safeUrl(raw: string, kind: "link" | "image"): string | null {
  // Tabs and line breaks vanish (as the URL parser drops them); C0 and spaces are trimmed.
  let value = "";
  for (const ch of decodeEntities(raw)) if (ch !== "\t" && ch !== "\n" && ch !== "\r") value += ch;
  let from = 0;
  let to = value.length;
  while (from < to && value.charCodeAt(from) <= 0x20) from++;
  while (to > from && value.charCodeAt(to - 1) <= 0x20) to--;
  value = value.slice(from, to);
  if (!value) return null;
  // What the browser would read as the scheme: controls, invisible characters and spaces don't
  // count.
  let probe = "";
  let control = false;
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (!isInvisible(code)) probe += ch;
    else if (code < 0x20 || code === 0x7f) control = true;
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(probe)?.[1]?.toLowerCase();
  if (scheme) {
    if (scheme === "http" || scheme === "https") return value;
    if (scheme === "mailto") return kind === "link" ? value : null;
    if (scheme === "data")
      return kind === "image" && IMAGE_DATA.test(probe.toLowerCase()) ? value : null;
    return null;
  }
  // Something that only looks scheme-less to us ("java\u0000script:") is refused.
  if (control) return null;
  // A network path, written plainly or percent-encoded (the preview decodes relative paths).
  let decoded = probe;
  try {
    decoded = decodeURIComponent(probe);
  } catch {
    // as written
  }
  for (const p of [probe, decoded])
    if (/^[\\/]{2}/.test(p) || /^[\\/]?[a-z]:/i.test(p) || /^[\\/][\\/]?[a-z]:/i.test(p))
      return null;
  if (kind === "image" && value.startsWith("#")) return null;
  return value;
}

/** `srcset` candidates ("a.png 1x, b.png 2x"), each URL checked; empty when none is fit. */
export function safeSrcset(raw: string): { url: string; descriptor: string }[] {
  const out: { url: string; descriptor: string }[] = [];
  // Candidates end at ", " or at a "," after a descriptor (a data: URL has commas of its own).
  for (const part of decodeEntities(raw).split(/,\s+|(?<=\s\d+(?:\.\d+)?[wx])\s*,|,$/)) {
    const m = /^\s*(\S+)(?:\s+(\d+(?:\.\d+)?[wx]))?\s*$/.exec(part);
    if (!m) continue;
    const url = safeUrl(m[1] as string, "image");
    if (url) out.push({ url, descriptor: m[2] ?? "" });
    if (out.length >= 8) break;
  }
  return out;
}

/** Tags kept (as themselves, or renamed: center → div, strike → s, tt → code). */
const KEEP = new Set(
  "a abbr b bdi bdo blockquote br caption center cite code col colgroup dd del details dfn div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p picture pre q rp rt ruby s samp section small source span strike strong sub summary sup table tbody td tfoot th thead time tr tt u ul var wbr".split(
    " ",
  ),
);
/** Tags dropped with everything inside them. */
const DROP = new Set(
  "script style iframe frame frameset object embed applet form input button textarea select option optgroup label fieldset legend link meta base svg math template noscript noembed noframes xmp plaintext title head audio video canvas dialog portal param track area map slot".split(
    " ",
  ),
);
/** Their content is text up to their end tag (not tags): skipped as a whole. */
export const RAW_TEXT = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
]);
export const VOID = new Set([
  "img",
  "br",
  "hr",
  "source",
  "wbr",
  "col",
  "input",
  "link",
  "meta",
  "base",
  "embed",
  "param",
  "track",
  "area",
]);
const RENAMED: Record<string, string> = { center: "div", strike: "s", tt: "code" };

export type TagPolicy = "keep" | "drop" | "unwrap";

/** What happens to a tag: kept (cleaned), dropped with its content, or unwrapped (content kept). */
export function tagPolicy(name: string): TagPolicy {
  const tag = name.toLowerCase();
  if (KEEP.has(tag)) return "keep";
  if (DROP.has(tag)) return "drop";
  return "unwrap";
}

const PER_TAG: Record<string, readonly string[]> = {
  a: ["href"],
  img: ["src", "alt", "width", "height", "srcset", "loading"],
  source: ["srcset", "media", "type", "width", "height"],
  td: ["colspan", "rowspan", "valign", "width", "height"],
  th: ["colspan", "rowspan", "valign", "width", "height", "scope"],
  tr: ["valign"],
  col: ["span", "width"],
  colgroup: ["span", "width"],
  table: ["width"],
  ol: ["start", "reversed", "type"],
  li: ["value"],
  details: ["open"],
  time: ["datetime"],
  abbr: [],
};
const GLOBAL = ["title", "align", "dir", "id", "name"];

const VALID: Record<string, (v: string, tag: string) => string | null> = {
  title: (v) => v.slice(0, 1000),
  alt: (v) => v.slice(0, 1000),
  align: (v) =>
    /^(left|right|center|justify|top|middle|bottom|baseline|absmiddle)$/i.test(v)
      ? v.toLowerCase()
      : null,
  valign: (v) => (/^(top|middle|bottom|baseline)$/i.test(v) ? v.toLowerCase() : null),
  dir: (v) => (/^(ltr|rtl|auto)$/i.test(v) ? v.toLowerCase() : null),
  width: (v) => (/^\d{1,5}(\.\d{1,3})?(%|px)?$/.test(v.trim()) ? v.trim() : null),
  height: (v) => (/^\d{1,5}(\.\d{1,3})?(%|px)?$/.test(v.trim()) ? v.trim() : null),
  colspan: (v) => (/^[1-9]\d{0,2}$/.test(v.trim()) ? v.trim() : null),
  rowspan: (v) => (/^[1-9]\d{0,2}$/.test(v.trim()) ? v.trim() : null),
  span: (v) => (/^[1-9]\d{0,2}$/.test(v.trim()) ? v.trim() : null),
  start: (v) => (/^-?\d{1,9}$/.test(v.trim()) ? v.trim() : null),
  value: (v) => (/^-?\d{1,9}$/.test(v.trim()) ? v.trim() : null),
  reversed: () => "",
  open: () => "",
  type: (v, tag) =>
    tag === "ol"
      ? /^[1aAiI]$/.test(v)
        ? v
        : null
      : /^[\w.+-]{1,40}\/[\w.+-]{1,60}$/.test(v)
        ? v.toLowerCase()
        : null,
  media: (v) => (/^[\w\s():,.\-/]{1,200}$/.test(v) ? v : null),
  datetime: (v) => (/^[\w:.+\- ]{1,64}$/.test(v) ? v : null),
  loading: (v) => (/^(lazy|eager)$/i.test(v) ? v.toLowerCase() : null),
  scope: (v) => (/^(row|col|rowgroup|colgroup)$/i.test(v) ? v.toLowerCase() : null),
  href: (v) => safeUrl(v, "link"),
  src: (v) => safeUrl(v, "image"),
  srcset: (v) => {
    const list = safeSrcset(v);
    return list.length
      ? list.map((c) => (c.descriptor ? `${c.url} ${c.descriptor}` : c.url)).join(", ")
      : null;
  },
};

/**
 * A kept tag's name and its harmless attributes (each validated; ids and names as `data-anchor`
 * so `#anchor` links work without clobbering the app's ids). Null for a tag that isn't kept.
 */
export function cleanTag(
  name: string,
  attrs: readonly [string, string][],
): { tag: string; attrs: Record<string, string> } | null {
  const tag = name.toLowerCase();
  if (!KEEP.has(tag)) return null;
  const allowed = PER_TAG[tag] ?? [];
  const out: Record<string, string> = {};
  for (const [rawName, value] of attrs) {
    const key = rawName.toLowerCase();
    if (!allowed.includes(key) && !GLOBAL.includes(key)) continue;
    if (key === "id" || key === "name") {
      const anchor = value.trim();
      if (/^[\p{L}\p{N}_.:-]{1,100}$/u.test(anchor)) out["data-anchor"] = anchor;
      continue;
    }
    const check = VALID[key];
    const clean = check ? check(value, tag) : null;
    if (clean !== null && !(key in out)) out[key] = clean;
  }
  const renamed = RENAMED[tag];
  if (tag === "center") out.align = "center";
  return { tag: renamed ?? tag, attrs: out };
}

const MAX_DEPTH = 48;
const MAX_OPEN = 512;
/** Opening one of these closes an open <p> (HTML's implied end tags, the common ones). */
const CLOSES_P = new Set(
  "address blockquote details div dl figure h1 h2 h3 h4 h5 h6 hr ol p pre section table ul".split(
    " ",
  ),
);

type Frame = { name: string; children: SafeNode[]; drop: boolean };

/**
 * Builds a `SafeNode` tree from tags, text and slots in document order: kept tags become
 * elements (end tags close the nearest open one of the same name, unclosed ones close at the
 * end), dropped tags swallow their content, unknown tags keep only their content — or, with
 * `unknownAsText` (inline HTML in prose: "Vec<T>"), show as written.
 */
export class SafeHtmlBuilder {
  readonly roots: SafeNode[] = [];
  private readonly stack: Frame[] = [];

  constructor(private readonly options: { unknownAsText?: boolean } = {}) {}

  private get children(): SafeNode[] {
    return this.stack[this.stack.length - 1]?.children ?? this.roots;
  }
  /** Open dropped tags (their content is skipped). */
  private drops = 0;
  private get dropping(): boolean {
    return this.drops > 0;
  }
  private push(frame: Frame): void {
    // Thousands of unclosed tags: the rest are ignored (their text still shows).
    if (this.stack.length >= MAX_OPEN) return;
    this.stack.push(frame);
    if (frame.drop) this.drops++;
  }
  private truncate(length: number): void {
    for (let i = length; i < this.stack.length; i++) if (this.stack[i]?.drop) this.drops--;
    this.stack.length = length;
  }

  text(text: string): void {
    if (!text || this.dropping) return;
    const last = this.children[this.children.length - 1];
    if (last?.kind === "text") last.text += text;
    else this.children.push({ kind: "text", text });
  }

  slot(index: number): void {
    if (!this.dropping) this.children.push({ kind: "slot", index });
  }

  tag(tag: HtmlTag): void {
    if (tag.close) this.close(tag);
    else this.open(tag);
  }

  private open(tag: HtmlTag): void {
    const name = tag.name;
    // "<script/>" still opens a script (HTML ignores the slash there).
    const isVoid = VOID.has(name) || (tag.selfClosing && !RAW_TEXT.has(name));
    if (this.dropping) {
      // Nested tags inside dropped content only count so that end tags pair up.
      if (!isVoid) this.push({ name, children: [], drop: true });
      return;
    }
    const policy = tagPolicy(name);
    if (policy === "drop") {
      if (!isVoid) this.push({ name, children: [], drop: true });
      return;
    }
    if (policy === "unwrap" || this.stack.length >= MAX_DEPTH) {
      if (this.options.unknownAsText && policy === "unwrap") this.text(tag.raw);
      else if (!isVoid) this.push({ name, children: this.children, drop: false });
      return;
    }
    this.implyEnds(name);
    const clean = cleanTag(name, tag.attrs);
    if (!clean) return;
    const el: SafeNode = { kind: "element", tag: clean.tag, attrs: clean.attrs, children: [] };
    this.children.push(el);
    if (!isVoid) this.push({ name, children: el.children, drop: false });
  }

  private close(tag: HtmlTag): void {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i]?.name !== tag.name) continue;
      this.truncate(i);
      return;
    }
    // A stray end tag: nothing to close. Unknown ones in prose show as written.
    if (this.options.unknownAsText && tagPolicy(tag.name) === "unwrap" && !this.dropping)
      this.text(tag.raw);
  }

  /** HTML's common implied end tags: a new <li> ends the open one, a <tr> its row, and so on. */
  private implyEnds(name: string): void {
    const closeTo = (names: string[], boundary: string[]) => {
      for (let i = this.stack.length - 1; i >= 0; i--) {
        const n = this.stack[i]?.name ?? "";
        if (boundary.includes(n)) return;
        if (names.includes(n)) {
          this.truncate(i);
          return;
        }
      }
    };
    if (name === "li") closeTo(["li"], ["ul", "ol"]);
    else if (name === "dt" || name === "dd") closeTo(["dt", "dd"], ["dl"]);
    else if (name === "tr") closeTo(["tr"], ["table", "thead", "tbody", "tfoot"]);
    else if (name === "td" || name === "th") closeTo(["td", "th"], ["tr", "table"]);
    else if (name === "thead" || name === "tbody" || name === "tfoot")
      closeTo(["thead", "tbody", "tfoot"], ["table"]);
    if (CLOSES_P.has(name) && this.stack[this.stack.length - 1]?.name === "p")
      this.truncate(this.stack.length - 1);
  }
}

/** Raw HTML's text (character references decoded) and tags, in order. */
export type HtmlToken = { kind: "text"; text: string } | { kind: "tag"; tag: HtmlTag };

/**
 * The tokens of raw HTML: comments, doctypes and processing instructions left out, and the
 * content of script-like elements (RAW_TEXT) skipped with their tags.
 */
export function htmlTokens(html: string): HtmlToken[] {
  const out: HtmlToken[] = [];
  let i = 0;
  let text = "";
  const flush = () => {
    if (text) out.push({ kind: "text", text: decodeEntities(text) });
    text = "";
  };
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      text += html.slice(i);
      break;
    }
    text += html.slice(i, lt);
    i = lt;
    if (html.startsWith("<!--", i)) {
      flush();
      const end = html.indexOf("-->", i + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[i + 1] === "!" || html[i + 1] === "?") {
      flush();
      const end = html.indexOf(">", i);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const tag = readTag(html, i);
    if (!tag) {
      text += "<";
      i++;
      continue;
    }
    flush();
    i += tag.raw.length;
    if (!tag.close && RAW_TEXT.has(tag.name)) {
      // Script-like content isn't markup: skip to its end tag (or the end).
      const end = new RegExp(`</${tag.name}\\s*>`, "ig");
      end.lastIndex = i;
      const m = end.exec(html);
      i = m ? m.index + m[0].length : html.length;
      continue;
    }
    out.push({ kind: "tag", tag });
  }
  flush();
  return out;
}

/** A block of raw HTML as a safe tree (comments, doctypes and dropped tags' content left out). */
export function sanitizeHtml(html: string): SafeNode[] {
  const b = new SafeHtmlBuilder();
  for (const t of htmlTokens(html)) {
    if (t.kind === "text") b.text(t.text);
    else b.tag(t.tag);
  }
  return b.roots;
}

/** The attribute that marks where the Markdown between HTML blocks goes (never from the source). */
export const SLOT_ATTR = "data-md-slot";

const escapeText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Raw HTML (and the Markdown blocks between HTML blocks, as placeholders) rewritten as clean HTML
 * text for the browser's own parser (D218), which then gives it HTML's full semantics (implied end
 * tags, tables' foster parenting, misnested formatting) — as markdown-it's output gets in VS Code.
 * Only kept tags are written, each with its checked attributes (cleanTag) and escaped values;
 * dropped tags vanish with their content, unknown ones leave their content; text is escaped. So
 * the parser only ever sees allowlisted markup, and its tree is checked again when it's rebuilt
 * as fresh elements (render.ts). Also keeps the tokens (for a builder where there's no parser) and
 * an estimate of the elements left open (so a `<details>` before Markdown takes it in).
 */
export class SafeHtmlWriter {
  /**
   * `inline`: the HTML is a paragraph's inline tags around its Markdown (`<b>…</b>` in prose):
   * slots are inline (`<span>`), and unknown tags show as written ("Vec<T>"), as the builder's
   * `unknownAsText` does.
   */
  constructor(readonly options: { inline?: boolean } = {}) {}

  private out = "";
  /** Every token and slot, in order. */
  readonly tokens: (HtmlToken | { kind: "slot"; index: number })[] = [];
  /** Dropped tags open (their content is skipped). */
  private readonly drops: string[] = [];
  /** Kept elements open, roughly as the parser will have them. */
  private readonly open: string[] = [];

  get html(): string {
    return this.out;
  }

  /** Elements the HTML so far leaves open (Markdown that follows goes inside them). */
  get openCount(): number {
    return this.open.length;
  }

  /** Raw HTML (an HTML block). */
  write(html: string): void {
    for (const t of htmlTokens(html)) {
      if (t.kind === "text") this.text(t.text);
      else this.tag(t.tag);
    }
  }

  text(text: string): void {
    this.tokens.push({ kind: "text", text });
    if (!this.drops.length) this.out += escapeText(text);
  }

  /** Where Markdown block `index` goes: a block element, as the Markdown's own would be. */
  slot(index: number): void {
    this.tokens.push({ kind: "slot", index });
    if (this.drops.length) return;
    if (this.options.inline) {
      this.out += `<span ${SLOT_ATTR}="${index}"></span>`;
      return;
    }
    if (this.open[this.open.length - 1] === "p") this.open.pop();
    this.out += `<div ${SLOT_ATTR}="${index}"></div>`;
  }

  tag(tag: HtmlTag): void {
    this.tokens.push({ kind: "tag", tag });
    const name = tag.name;
    const isVoid = VOID.has(name);
    // As the builder counts them: "<svg/>" opens nothing to skip.
    const opensDropped = !tag.close && !isVoid && !(tag.selfClosing && !RAW_TEXT.has(name));
    if (this.drops.length) {
      if (tag.close) {
        const at = this.drops.lastIndexOf(name);
        if (at >= 0) this.drops.length = at;
      } else if (opensDropped && this.drops.length < MAX_OPEN) this.drops.push(name);
      return;
    }
    const policy = tagPolicy(name);
    if (policy === "drop") {
      if (opensDropped && this.drops.length < MAX_OPEN) this.drops.push(name);
      return;
    }
    if (policy === "unwrap") {
      if (this.options.inline) this.out += escapeText(tag.raw);
      return;
    }
    const clean = cleanTag(name, tag.attrs);
    if (!clean) return;
    if (tag.close) {
      // `</br>` is a <br> to the parser; other void end tags are ignored.
      if (isVoid) {
        if (name === "br") this.out += "<br>";
        return;
      }
      this.out += `</${clean.tag}>`;
      const at = this.open.lastIndexOf(name);
      if (at >= 0) this.open.length = at;
      return;
    }
    let attrs = "";
    for (const [key, value] of Object.entries(clean.attrs))
      attrs += value === "" ? ` ${key}` : ` ${key}="${escapeAttr(value)}"`;
    this.out += `<${clean.tag}${attrs}>`;
    if (isVoid) return;
    if (CLOSES_P.has(name) && this.open[this.open.length - 1] === "p") this.open.pop();
    if (this.open.length < MAX_OPEN) this.open.push(name);
  }
}

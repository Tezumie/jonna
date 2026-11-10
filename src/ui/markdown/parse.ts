// A small Markdown parser for chat answers and file previews (DESIGN.md §14): headings (ATX and
// setext), paragraphs, fenced code, lists (nested by indentation, GFM task items), quotes, rules,
// GFM tables, HTML comments (dropped), math ($$ blocks, D172); inline code, bold, italic,
// strikethrough, links, autolinks, images, math ($…$, GitHub's rules: no space inside the dollars,
// none followed by a digit, so "$5 and $10" stays text). Top-level blocks carry their source line (preview scroll sync).
// Raw HTML (CommonMark's HTML blocks and inline tags, D210) is kept as tags for sanitize.ts.
// Produces a tree that render.ts turns into DOM nodes (never innerHTML). Tolerates unfinished
// input (streaming: an unclosed fence is still a code block). DOM-free and tested.

import { decodeTextEntities, type HtmlTag, readTag } from "./sanitize";

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "del"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] }
  | { kind: "image"; src: string; alt: string }
  | { kind: "mark" | "sub" | "sup"; children: Inline[] }
  /** `[^id]` — numbered by the renderer in order of first reference. */
  | { kind: "footnoteRef"; id: string }
  /** A raw HTML tag in the text (`<img src=…>`, `<a href=…>`, `</a>`): render.ts sanitizes. */
  | { kind: "tag"; tag: HtmlTag }
  | { kind: "br"; soft?: boolean }
  /** `$x^2$` (TeX, drawn by the renderer). */
  | { kind: "math"; tex: string };

export type Block = (
  | { kind: "heading"; level: number; children: Inline[] }
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "code"; lang: string; text: string; closed: boolean; info?: string }
  /** `checked[i]`: a GFM task item's box (true/false), null for a plain item. */
  | { kind: "list"; ordered: boolean; start: number; items: Block[][]; checked: (boolean | null)[] }
  | { kind: "quote"; children: Block[] }
  | { kind: "rule" }
  /** `$$ … $$` on lines of their own (or one line), TeX. */
  | { kind: "math"; tex: string }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][] }
  /** GitHub alert: `> [!NOTE]` / TIP / IMPORTANT / WARNING / CAUTION. */
  | { kind: "alert"; type: string; children: Block[] }
  | { kind: "deflist"; items: { term: Inline[]; defs: Block[][] }[] }
  /** Raw HTML block: rendered through an allowlist sanitizer (no scripts, no handlers). */
  | { kind: "htmlBlock"; html: string }
  | { kind: "footnotes"; items: { id: string; children: Block[] }[] }
) & {
  /** 0-based source line where the block starts. */
  line?: number;
};

/**
 * `re` (written with a leading ^) matched at `index` without copying the rest of the text: a sticky
 * copy of the regex, cached. Parsing a long paragraph (a streamed chat answer) stays linear.
 */
// Keyed by source + flags: a regex literal is a new object each time it's evaluated.
const STICKY = new Map<string, RegExp>();
function matchAt(re: RegExp, text: string, index: number): RegExpExecArray | null {
  const key = `${re.flags}/${re.source}`;
  let sticky = STICKY.get(key);
  if (!sticky) {
    sticky = new RegExp(re.source.replace(/^\^/, ""), `${re.flags.replace("y", "")}y`);
    STICKY.set(key, sticky);
  }
  sticky.lastIndex = index;
  return sticky.exec(text);
}

/** The index of the "]" closing the "[" at `open` (nested pairs and `code` skipped), or -1. */
function matchingBracket(text: string, open: number): number {
  let depth = 0;
  // Link labels are short: give up after a while (an unmatched "[" in a long paragraph).
  const end = Math.min(text.length, open + 2000);
  for (let j = open; j < end; j++) {
    const ch = text[j];
    if (ch === "\\") j++;
    else if (ch === "`") {
      const end = text.indexOf("`", j + 1);
      if (end < 0) return -1;
      j = end;
    } else if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) return j;
    else if (ch === "\n" && text[j + 1] === "\n") return -1;
  }
  return -1;
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ kind: "text", text: buf });
    buf = "";
  };
  let noCommentEnd = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (
      c === "\\" &&
      i + 1 < text.length &&
      /[\\`*_[\]()#+\-.!|<>~$&]/.test(text[i + 1] as string)
    ) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const ticks = matchAt(/^`+/, text, i)?.[0] ?? "`";
      const end = text.indexOf(ticks, i + ticks.length);
      if (end > 0) {
        flush();
        out.push({
          kind: "code",
          text: text.slice(i + ticks.length, end).replace(/^ (.*) $/, "$1"),
        });
        i = end + ticks.length;
        continue;
      }
    }
    if (c === "$") {
      const m = inlineMath(text, i);
      if (m) {
        flush();
        out.push({ kind: "math", tex: m.tex });
        i = m.end;
        continue;
      }
    }
    if ((c === "*" || c === "_") && text[i + 1] === c) {
      const end = text.indexOf(c + c, i + 2);
      if (end > i + 2) {
        flush();
        out.push({ kind: "strong", children: parseInline(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((c === "*" || c === "_") && text[i + 1] !== " " && text[i + 1] !== c) {
      const prev = i > 0 ? (text[i - 1] as string) : " ";
      const end = text.indexOf(c, i + 1);
      // "_" inside words (snake_case) is not emphasis.
      if (end > i + 1 && text[end - 1] !== " " && !(c === "_" && /\w/.test(prev))) {
        flush();
        out.push({ kind: "em", children: parseInline(text.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (c === "!" && text[i + 1] === "[") {
      const m = matchAt(
        /^!\[([^\]]{0,500})\]\(<?([^)\s>]{1,2000})>?(?:\s+"[^"]{0,500}")?\)/,
        text,
        i,
      );
      if (m) {
        flush();
        out.push({ kind: "image", src: m[2] as string, alt: m[1] as string });
        i += m[0].length;
        continue;
      }
    }
    if (c === "~" && text[i + 1] === "~") {
      const end = text.indexOf("~~", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ kind: "del", children: parseInline(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((c === "h" || c === "w") && /\W|^$/.test(i > 0 ? (text[i - 1] as string) : "")) {
      const m = matchAt(/^(?:https?:\/\/|www\.)[^\s<]*[^\s<.,:;"')\]!?]/, text, i);
      if (m) {
        flush();
        const href = m[0].startsWith("www.") ? `https://${m[0]}` : m[0];
        out.push({ kind: "link", href, children: [{ kind: "text", text: m[0] }] });
        i += m[0].length;
        continue;
      }
    }
    if (c === "[" && text[i + 1] === "^") {
      const m = matchAt(/^\[\^([^\]\s]{1,100})\]/, text, i);
      if (m) {
        flush();
        out.push({ kind: "footnoteRef", id: m[1] as string });
        i += m[0].length;
        continue;
      }
    }
    if (c === "=" && text[i + 1] === "=") {
      const end = text.indexOf("==", i + 2);
      if (end > i + 2 && text[i + 2] !== " ") {
        flush();
        out.push({ kind: "mark", children: parseInline(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((c === "~" || c === "^") && text[i + 1] !== c && text[i + 1] !== " ") {
      // H~2~O and x^2^ (no spaces inside, like markdown-it-sub/sup).
      const m = c === "~" ? matchAt(/^~([^~\s]+)~/, text, i) : matchAt(/^\^([^^\s]+)\^/, text, i);
      if (m) {
        flush();
        out.push({ kind: c === "~" ? "sub" : "sup", children: parseInline(m[1] as string) });
        i += m[0].length;
        continue;
      }
    }
    if (c === "<") {
      const br = matchAt(/^<br\s*\/?>/i, text, i);
      if (br) {
        flush();
        out.push({ kind: "br" });
        i += br[0].length;
        continue;
      }
      if (!noCommentEnd && text.startsWith("<!--", i)) {
        const end = text.indexOf("-->", i + 4);
        if (end > 0) {
          flush();
          i = end + 3;
          continue;
        }
        // None later either: don't search again ("<!--" × 30000 stays linear).
        noCommentEnd = true;
      }
      if (/[A-Za-z/]/.test(text[i + 1] ?? "")) {
        const tag = readTag(text, i);
        if (tag) {
          flush();
          out.push({ kind: "tag", tag });
          i += tag.raw.length;
          continue;
        }
      }
    }
    if (c === "&") {
      const m = matchAt(/^&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/, text, i);
      if (m) {
        buf += decodeTextEntities(m[0]);
        i += m[0].length;
        continue;
      }
    }
    if (c === "[") {
      // The label may hold brackets itself: a badge is [![alt](image)](link).
      const close = matchingBracket(text, i);
      const m = close > i ? /^\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/.exec(text.slice(close + 1)) : null;
      if (m) {
        flush();
        out.push({
          kind: "link",
          href: m[1] as string,
          children: parseInline(text.slice(i + 1, close)),
        });
        i = close + 1 + m[0].length;
        continue;
      }
    }
    if (c === "<") {
      const m = matchAt(/^<(https?:\/\/[^>\s]+)>/, text, i);
      if (m) {
        flush();
        out.push({
          kind: "link",
          href: m[1] as string,
          children: [{ kind: "text", text: m[1] as string }],
        });
        i += m[0].length;
        continue;
      }
    }
    if (c === "\n") {
      // Two trailing spaces or a backslash: a hard break; else a soft one (shown as a space in
      // documents, as a break in chat — see RenderOptions.softBreaks).
      const hard = /( {2,}|\\)$/.test(buf);
      buf = buf.replace(/( {2,}|\\)$/, "");
      flush();
      out.push(hard ? { kind: "br" } : { kind: "br", soft: true });
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/**
 * `$tex$` at `i` (GitHub's rules): `$$tex$$` too; the opening `$` not followed by a space, the
 * closing one not preceded by a space nor followed by a digit, within the paragraph.
 */
function inlineMath(text: string, i: number): { tex: string; end: number } | null {
  const double = text[i + 1] === "$";
  const open = double ? 2 : 1;
  const first = text[i + open];
  if (!first || first === " " || first === "\n" || first === "$") return null;
  const limit = Math.min(text.length, i + 2000);
  for (let j = i + open; j < limit; j++) {
    const ch = text[j];
    if (ch === "\\") {
      j++;
      continue;
    }
    if (ch === "\n" && text[j + 1] === "\n") return null;
    if (ch !== "$") continue;
    if (double && text[j + 1] !== "$") continue;
    if (text[j - 1] === " " || text[j - 1] === "\n") return null;
    const after = text[j + open];
    if (after && /\d/.test(after)) return null;
    const tex = text.slice(i + open, j);
    return tex.trim() ? { tex, end: j + open } : null;
  }
  return null;
}

const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const FENCE = /^(\s*)(```+|~~~+)\s*([\w+#.-]*)(.*)$/;

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  // YAML front matter: blanked (not removed) so source lines stay aligned.
  if (/^---\s*$/.test(lines[0] ?? "")) {
    const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end > 0) for (let i = 0; i <= end; i++) lines[i] = "";
  }
  const notes: { id: string; children: Block[] }[] = [];
  const blocks = parseLines(lines, 0, notes);
  if (notes.length) blocks.push({ kind: "footnotes", items: notes });
  return blocks;
}

/** CommonMark's HTML block start conditions: 6 (block tags, up to a blank line) and 1 (raw). */
const HTML_BLOCK =
  /^\s{0,3}<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|picture|search|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(\s|>|\/>|$)/i;
const HTML_RAW_BLOCK = /^\s{0,3}<(pre|script|style|textarea)(\s|>|$)/i;
/** Condition 7: a line holding one complete open or close tag and nothing else. */
function isHtmlTagLine(line: string): boolean {
  const start = line.indexOf("<");
  if (start < 0 || start > 3 || line.slice(0, start).trim()) return false;
  const tag = readTag(line, start);
  return !!tag && !line.slice(start + tag.raw.length).trim();
}
const ALERT = /^\[!(note|tip|important|warning|caution)\]\s*$/i;

const TASK = /^\[([ xX])\]\s+/;

/** Quotes and lists nested deeper than this stay text: 3000 `>` overflowed the stack (D161). */
const MAX_NESTING = 40;
let nesting = 0;

function parseLines(
  lines: string[],
  base = 0,
  notes: { id: string; children: Block[] }[] = [],
): Block[] {
  if (nesting >= MAX_NESTING)
    return [{ kind: "paragraph", children: parseInline(lines.join("\n")), line: base }];
  nesting++;
  try {
    return parseBlocks(lines, base, notes);
  } finally {
    nesting--;
  }
}

function parseBlocks(
  lines: string[],
  base: number,
  notes: { id: string; children: Block[] }[],
): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  let para: string[] = [];
  let paraStart = 0;
  const push = (block: Block, start: number) => blocks.push({ ...block, line: base + start });
  const endPara = () => {
    if (para.length) push({ kind: "paragraph", children: parseInline(para.join("\n")) }, paraStart);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i] as string;
    const start = i;
    const fence = FENCE.exec(line);
    if (fence) {
      endPara();
      const marker = fence[2] as string;
      const body: string[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        if ((lines[i] as string).trim().startsWith(marker)) {
          closed = true;
          i++;
          break;
        }
        body.push(lines[i] as string);
        i++;
      }
      if (!closed) while (body.length && body[body.length - 1]?.trim() === "") body.pop();
      const info = `${fence[3] ?? ""}${fence[4] ?? ""}`.trim();
      push(
        {
          kind: "code",
          lang: fence[3] ?? "",
          text: body.join("\n"),
          closed,
          ...(info !== (fence[3] ?? "") && { info }),
        },
        start,
      );
      continue;
    }
    if (!line.trim()) {
      endPara();
      i++;
      continue;
    }
    // Display math: "$$" alone on a line up to the next, or "$$ … $$" on one line.
    if (/^\s*\$\$/.test(line) && para.length === 0) {
      const one = /^\s*\$\$(.+)\$\$\s*$/.exec(line);
      if (one?.[1]?.trim()) {
        push({ kind: "math", tex: one[1].trim() }, start);
        i++;
        continue;
      }
      if (/^\s*\$\$\s*$/.test(line)) {
        const body: string[] = [];
        let j = i + 1;
        while (j < lines.length && !/^\s*\$\$\s*$/.test(lines[j] as string))
          body.push(lines[j++] as string);
        if (j < lines.length && body.join("").trim()) {
          push({ kind: "math", tex: body.join("\n").trim() }, start);
          i = j + 1;
          continue;
        }
      }
    }
    // HTML comments (often badges' or tools' markers in READMEs) aren't shown.
    if (/^\s*<!--/.test(line)) {
      endPara();
      while (i < lines.length && !(lines[i] as string).includes("-->")) i++;
      i++;
      continue;
    }
    // Footnote definition: [^id]: text, continued by indented lines.
    const note = /^\[\^([^\]\s]+)\]:\s?(.*)$/.exec(line);
    if (note) {
      endPara();
      const body = [note[2] as string];
      i++;
      while (
        i < lines.length &&
        (/^(\s{2,}|\t)\S/.test(lines[i] as string) ||
          ((lines[i] as string).trim() === "" && /^(\s{2,}|\t)\S/.test(lines[i + 1] ?? "")))
      ) {
        body.push((lines[i] as string).replace(/^(\s{2,4}|\t)/, ""));
        i++;
      }
      notes.push({ id: note[1] as string, children: parseLines(body, base + start, notes) });
      continue;
    }
    // HTML block (CommonMark types 1, 6 and 7): up to a blank line (a <details> too, D218: the
    // Markdown after the blank line is Markdown, and render.ts nests it in the open element);
    // <pre> / <script> / <style> / <textarea> to their end tag.
    const raw = para.length === 0 ? HTML_RAW_BLOCK.exec(line) : null;
    if (raw) {
      const close = new RegExp(`</${raw[1]}\\s*>`, "i");
      const body: string[] = [];
      while (i < lines.length) {
        const l = lines[i] as string;
        body.push(l);
        i++;
        if (close.test(l)) break;
      }
      push({ kind: "htmlBlock", html: body.join("\n") }, start);
      continue;
    }
    // Condition 6 (block tags) may end a paragraph ("Hidden" then "</details>"); 7 may not.
    if (HTML_BLOCK.test(line) || (para.length === 0 && isHtmlTagLine(line))) {
      endPara();
      const body: string[] = [];
      while (i < lines.length) {
        const l = lines[i] as string;
        if (l.trim() === "") break;
        body.push(l);
        i++;
      }
      push({ kind: "htmlBlock", html: body.join("\n") }, start);
      continue;
    }
    // Definition list: "Term" then ": definition" lines.
    if (para.length === 1 && /^:\s+\S/.test(line)) {
      const items: { term: Inline[]; defs: Block[][] }[] = [];
      const term = para[0] as string;
      const termStart = paraStart;
      para = [];
      let current = { term: parseInline(term), defs: [] as Block[][] };
      items.push(current);
      while (i < lines.length) {
        const l = lines[i] as string;
        if (/^:\s+\S/.test(l)) {
          current.defs.push(parseLines([l.replace(/^:\s+/, "")], base + i, notes));
          i++;
        } else if (l.trim() && /^:\s+\S/.test(lines[i + 1] ?? "")) {
          current = { term: parseInline(l), defs: [] };
          items.push(current);
          i++;
        } else if (
          l.trim() === "" &&
          /^:\s+\S|^\S/.test(lines[i + 1] ?? "") &&
          /^:\s/.test(lines[i + 2] ?? lines[i + 1] ?? "")
        ) {
          i++;
        } else break;
      }
      push({ kind: "deflist", items }, termStart);
      continue;
    }
    // Setext heading: a paragraph line underlined with === or ---.
    if (para.length === 1 && /^\s*(=+|-+)\s*$/.test(line)) {
      push(
        {
          kind: "heading",
          level: line.trim().startsWith("=") ? 1 : 2,
          children: parseInline(para[0] as string),
        },
        paraStart,
      );
      para = [];
      i++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (heading) {
      endPara();
      push(
        {
          kind: "heading",
          level: (heading[1] as string).length,
          children: parseInline(heading[2] as string),
        },
        start,
      );
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      endPara();
      push({ kind: "rule" }, start);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      endPara();
      const inner: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] as string)) {
        inner.push((lines[i] as string).replace(/^\s*>\s?/, ""));
        i++;
      }
      const alert = ALERT.exec(inner[0] ?? "");
      if (alert)
        push(
          {
            kind: "alert",
            type: (alert[1] as string).toLowerCase(),
            children: parseLines(inner.slice(1), base + start + 1, notes),
          },
          start,
        );
      else push({ kind: "quote", children: parseLines(inner, base + start, notes) }, start);
      continue;
    }
    const next = lines[i + 1] ?? "";
    if (
      line.includes("|") &&
      /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$|^\s*\|\s*:?-+:?\s*\|\s*$/.test(next)
    ) {
      endPara();
      const header = splitRow(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (
        i < lines.length &&
        (lines[i] as string).includes("|") &&
        (lines[i] as string).trim()
      ) {
        rows.push(splitRow(lines[i] as string).map(parseInline));
        i++;
      }
      push({ kind: "table", header, rows }, start);
      continue;
    }
    const item = LIST.exec(line);
    if (item && (para.length === 0 || !/^\s/.test(line))) {
      endPara();
      const indent = (item[1] as string).length;
      const ordered = /\d/.test(item[2] as string);
      const items: { lines: string[]; at: number }[] = [];
      while (i < lines.length) {
        const l = lines[i] as string;
        const m = LIST.exec(l);
        if (m && (m[1] as string).length === indent && /\d/.test(m[2] as string) === ordered) {
          items.push({ lines: [m[3] as string], at: i });
          i++;
          continue;
        }
        // Continuation: indented deeper, or a blank line followed by an indented line.
        if (l.trim() === "" && /^\s{2,}\S/.test(lines[i + 1] ?? "") && items.length) {
          items[items.length - 1]?.lines.push("");
          i++;
          continue;
        }
        if (/^\s+\S/.test(l) && l.length - l.trimStart().length > indent && items.length) {
          items[items.length - 1]?.lines.push(
            l.slice(Math.min(indent + 2, l.length - l.trimStart().length)),
          );
          i++;
          continue;
        }
        break;
      }
      const checked = items.map((it) => {
        const m = TASK.exec(it.lines[0] ?? "");
        if (!m) return null;
        it.lines[0] = (it.lines[0] ?? "").slice(m[0].length);
        return m[1] !== " ";
      });
      const startNo = ordered ? Number.parseInt(item[2] as string, 10) : 1;
      push(
        {
          kind: "list",
          ordered,
          start: startNo,
          items: items.map((it) => parseLines(it.lines, base + it.at, notes)),
          checked,
        },
        start,
      );
      continue;
    }
    if (para.length === 0) paraStart = i;
    para.push(line);
    i++;
  }
  endPara();
  return blocks;
}

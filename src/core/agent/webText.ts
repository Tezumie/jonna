// A web page as text for the agent's context (`@web`, `web.fetch`, D130): HTML reduced to
// Markdown-like text — headings, paragraphs, lists, links, code — without scripts, styles,
// navigation and other page chrome. DOM-free (runs in tests and workers); a small tag walker,
// not a full HTML parser: pages only need to read well, not round-trip.

const SKIP = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "head",
  "nav",
  "footer",
  "aside",
  "form",
  "button",
  "select",
]);
const BLOCK = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "header",
  "table",
  "tr",
  "ul",
  "ol",
  "dl",
  "dt",
  "dd",
  "blockquote",
  "figure",
  "figcaption",
  "hr",
  "details",
  "summary",
]);
const VOID = new Set(["br", "img", "hr", "input", "meta", "link", "source", "wbr", "col", "area"]);

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  middot: "·",
  bull: "•",
  times: "×",
  rarr: "→",
  larr: "←",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X"
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[name.toLowerCase()] ?? m;
  });
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(
    attrs,
  );
  const v = m?.[1] ?? m?.[2] ?? m?.[3];
  return v === undefined ? undefined : decodeEntities(v);
}

function absolute(href: string, base: string): string {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

/** The page's <title>, if any. */
export function htmlTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m?.[1] ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}

/** The main content: <main>, else the single <article>, else <body>, else everything. */
function mainPart(html: string): string {
  const pick = (tag: string) => {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*)</${tag}>`, "i");
    return re.exec(html)?.[1];
  };
  const articles = html.match(/<article\b/gi)?.length ?? 0;
  return pick("main") ?? (articles === 1 ? pick("article") : undefined) ?? pick("body") ?? html;
}

/** HTML → Markdown-like text. `base` resolves relative links. */
export function htmlToText(html: string, base = ""): string {
  const source = mainPart(html.replace(/<!--[\s\S]*?-->/g, ""));
  const out: string[] = [];
  let skipping: string | null = null;
  let skipDepth = 0;
  let pre = 0;
  const listStack: { ordered: boolean; n: number }[] = [];
  let link: { href: string; start: number } | null = null;
  const newline = (count = 1) => {
    // The newlines the output ends with, from its last pieces: joining all of it each time was
    // quadratic (a 300 KB page of divs took a minute).
    let trailing = 0;
    let any = false;
    for (let i = out.length - 1; i >= 0 && trailing < count; i--) {
      const piece = out[i] ?? "";
      if (!piece) continue;
      any = true;
      const n = /\n*$/.exec(piece)?.[0].length ?? 0;
      trailing += n;
      if (n < piece.length) break;
    }
    if (any && trailing < count) out.push("\n".repeat(count - trailing));
  };
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/g;
  let last = 0;
  const pushText = (raw: string) => {
    if (skipping || !raw) return;
    const text = decodeEntities(raw);
    if (pre) {
      out.push(text);
      return;
    }
    const collapsed = text.replace(/\s+/g, " ");
    const prev = out[out.length - 1] ?? "";
    out.push(/[\s]$/.test(prev) || !prev ? collapsed.replace(/^ /, "") : collapsed);
  };
  for (let m = tagRe.exec(source); m; m = tagRe.exec(source)) {
    pushText(source.slice(last, m.index));
    last = tagRe.lastIndex;
    const closing = m[1] === "/";
    const tag = (m[2] ?? "").toLowerCase();
    const attrs = m[3] ?? "";
    const selfClosing = m[4] === "/" || VOID.has(tag);
    if (skipping) {
      if (tag === skipping) skipDepth += closing ? -1 : selfClosing ? 0 : 1;
      if (skipDepth === 0) skipping = null;
      continue;
    }
    if (!closing && SKIP.has(tag) && !selfClosing) {
      skipping = tag;
      skipDepth = 1;
      continue;
    }
    if (/^h[1-6]$/.test(tag)) {
      newline(2);
      if (!closing) out.push(`${"#".repeat(Number(tag[1]))} `);
      continue;
    }
    switch (tag) {
      case "br":
        out.push("\n");
        continue;
      case "hr":
        newline(2);
        out.push("---");
        newline(2);
        continue;
      case "pre":
        newline(closing ? 1 : 2);
        out.push(closing ? "```" : "```\n");
        if (closing) {
          pre = Math.max(0, pre - 1);
          newline(2);
        } else pre++;
        continue;
      case "code":
        if (!pre) out.push("`");
        continue;
      case "ul":
      case "ol":
        if (closing) listStack.pop();
        else listStack.push({ ordered: tag === "ol", n: 0 });
        // A blank line around a top-level list; nested ones just start a line.
        newline(listStack.length === 0 || (!closing && listStack.length === 1) ? 2 : 1);
        continue;
      case "li": {
        if (closing) continue;
        newline(1);
        const list = listStack[listStack.length - 1];
        const indent = "  ".repeat(Math.max(0, listStack.length - 1));
        if (list) list.n++;
        out.push(`${indent}${list?.ordered ? `${list.n}.` : "-"} `);
        continue;
      }
      case "td":
      case "th":
        if (!closing) out.push(" | ");
        continue;
      case "strong":
      case "b":
        out.push("**");
        continue;
      case "em":
      case "i":
        out.push("_");
        continue;
      case "img": {
        const alt = attr(attrs, "alt");
        if (alt) out.push(`[image: ${alt}]`);
        continue;
      }
      case "a": {
        if (!closing) {
          const href = attr(attrs, "href");
          link =
            href && !href.startsWith("#") && !/^javascript:/i.test(href)
              ? { href: absolute(href, base), start: out.length }
              : null;
          if (link) out.push("[");
        } else if (link) {
          const text = out.slice(link.start + 1).join("");
          if (text.trim()) out.push(`](${link.href})`);
          else out.splice(link.start, out.length - link.start);
          link = null;
        }
        continue;
      }
    }
    if (BLOCK.has(tag)) newline(tag === "tr" || tag === "dt" || tag === "dd" ? 1 : 2);
  }
  pushText(source.slice(last));
  return out
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\*\*\s*\*\*/g, "")
    .trim();
}

export interface WebPageText {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

/** A fetched page's body as text: HTML converted, other text kept, capped at `maxChars`. */
export function pageText(
  page: { url: string; contentType: string; text: string; truncated: boolean },
  maxChars = 40000,
): WebPageText {
  const html = /html|xml/i.test(page.contentType) || /^\s*<(!doctype|html)/i.test(page.text);
  const body = html ? htmlToText(page.text, page.url) : page.text.trim();
  const cut = body.length > maxChars;
  return {
    url: page.url,
    title: html ? htmlTitle(page.text) : "",
    text: cut ? `${body.slice(0, maxChars)}\n… (truncated)` : body,
    truncated: cut || page.truncated,
  };
}

/** "example.com", "https://example.com/a" → a URL to fetch (https when no scheme is given). */
export function normalizeUrl(input: string): string {
  const t = input.trim();
  if (/^https?:\/\//i.test(t)) return t;
  const scheme = /^([a-z][\w+.-]*):\/\//i.exec(t)?.[1];
  if (scheme) throw new Error(`Only http and https pages can be fetched, not ${scheme}:`);
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(t) || /^localhost(:\d+)?(\/|$)/.test(t))
    return `${t.startsWith("localhost") ? "http" : "https"}://${t}`;
  throw new Error(`Not a web address: ${input}`);
}

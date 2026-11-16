// Search over the user guide (the Documentation tab's search box, `help.showDocs {query}`):
// each page is cut into sections at its headings, and a query finds the sections that hold
// every one of its words. DOM-free.
import type { DocPage } from "./pages";

export interface DocSection {
  /** The page's id ("08-git.md"). */
  page: string;
  pageTitle: string;
  /** The section's heading; the page's title for what comes before the first heading. */
  heading: string;
  /** 1 for the page's title, 2 and 3 for the headings under it. */
  level: number;
  /** The heading's id in the rendered page ("#anchor" links use it); "" for the page's top. */
  anchor: string;
  /** The section's words as plain text. */
  text: string;
}

export interface DocHit {
  section: DocSection;
  /** A piece of the section's text around the first word found, with the words to mark. */
  snippet: { text: string; marks: [start: number, end: number][] };
  score: number;
}

/** A heading's id as the Markdown renderer makes it (`slug` in ui/markdown/render.ts). */
export function headingAnchor(heading: string): string {
  return heading
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

/** Markdown's marks taken off a line, so what is searched and shown reads as text. */
export function plainText(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_]+)[*_](?=$|[\s).,;:!?])/g, "$1$2")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")
    .replace(/^\s*>\s?/, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A page cut at its headings (levels 1 to 3); code blocks keep their text and aren't cut. */
export function pageSections(page: DocPage): DocSection[] {
  const out: DocSection[] = [];
  let now: DocSection = {
    page: page.id,
    pageTitle: page.title,
    heading: page.title,
    level: 1,
    anchor: "",
    text: "",
  };
  const lines: string[] = [];
  const close = () => {
    now.text = lines.join(" ").replace(/\s+/g, " ").trim();
    lines.length = 0;
    // The page's top is listed even when it has no words of its own: its title is searched.
    if (now.text !== "" || now.level === 1) out.push(now);
  };
  let fence: string | null = null;
  for (const line of page.text.split(/\r?\n/)) {
    const mark = /^\s*(```+|~~~+)/.exec(line)?.[1];
    if (mark) {
      if (fence === null) fence = mark.slice(0, 3);
      else if (mark.startsWith(fence)) fence = null;
      continue;
    }
    if (fence !== null) {
      lines.push(line.trim());
      continue;
    }
    const heading = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = (heading[1] as string).length;
      const title = plainText(heading[2] as string);
      // The page's own title opens the section already begun.
      if (level === 1 && out.length === 0 && lines.length === 0) continue;
      close();
      now = {
        page: page.id,
        pageTitle: page.title,
        heading: title,
        level,
        anchor: headingAnchor(title),
        text: "",
      };
      continue;
    }
    // A table's ruler and a rule say nothing.
    if (/^\s*[|:\-\s]+$/.test(line)) continue;
    const text = plainText(line);
    if (text) lines.push(text);
  }
  close();
  return out;
}

/** A query's words, lower-cased; at most eight. */
export function queryWords(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 8);
}

const SNIPPET = 160;

function snippetOf(text: string, words: readonly string[]): DocHit["snippet"] {
  const lower = text.toLowerCase();
  const first = Math.min(
    ...words.map((w) => lower.indexOf(w)).filter((at) => at >= 0),
    Number.POSITIVE_INFINITY,
  );
  let start = Number.isFinite(first) ? Math.max(0, first - 50) : 0;
  // From a word's start, not its middle.
  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space >= 0 && space < first) start = space + 1;
  }
  const end = Math.min(text.length, start + SNIPPET);
  const piece = `${start > 0 ? "… " : ""}${text.slice(start, end)}${end < text.length ? " …" : ""}`;
  const marks: [number, number][] = [];
  const pieceLower = piece.toLowerCase();
  for (const word of words) {
    for (let at = pieceLower.indexOf(word); at >= 0; at = pieceLower.indexOf(word, at + 1)) {
      marks.push([at, at + word.length]);
    }
  }
  marks.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  // Overlapping marks become one.
  const merged: [number, number][] = [];
  for (const mark of marks) {
    const last = merged[merged.length - 1];
    if (last && mark[0] <= last[1]) last[1] = Math.max(last[1], mark[1]);
    else merged.push([mark[0], mark[1]]);
  }
  return { text: piece, marks: merged };
}

/**
 * The sections that hold every word of `query` (in their heading, their page's title or their
 * text), best first: a word in a heading counts for more than one in the text, a whole word
 * for more than part of one. Empty for an empty query.
 */
export function searchDocs(sections: readonly DocSection[], query: string, limit = 40): DocHit[] {
  const words = queryWords(query);
  if (words.length === 0) return [];
  const hits: DocHit[] = [];
  sections.forEach((section, index) => {
    const heading = section.heading.toLowerCase();
    const title = section.pageTitle.toLowerCase();
    const text = section.text.toLowerCase();
    let score = 0;
    for (const word of words) {
      const inHeading = heading.includes(word);
      const inTitle = title.includes(word);
      const at = text.indexOf(word);
      if (!inHeading && !inTitle && at < 0) return;
      if (inHeading) score += heading === word ? 14 : 8;
      // The title counts for its own top section, less for the sections under it.
      if (inTitle) score += section.level === 1 ? 6 : 1;
      if (at >= 0) {
        score += 2;
        const whole = new RegExp(
          `(^|[^\\p{L}\\p{N}])${escapeRegExp(word)}($|[^\\p{L}\\p{N}])`,
          "u",
        );
        if (whole.test(text)) score += 1;
        // Said more than once: more about it.
        if (text.indexOf(word, at + word.length) >= 0) score += 1;
      }
    }
    // The whole query as written, together.
    const phrase = words.length > 1 ? query.trim().toLowerCase().replace(/\s+/g, " ") : "";
    if (phrase && (text.includes(phrase) || heading.includes(phrase))) score += 5;
    hits.push({
      section,
      snippet: snippetOf(section.text || section.heading, words),
      // Earlier in the guide first among equals.
      score: score - index / 10_000,
    });
  });
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

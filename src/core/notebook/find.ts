// Find and replace across a notebook's cells (D204), as VS Code's notebook find: one query over
// every cell's source (Markdown and code, each can be left out) and optionally the outputs' text;
// matches in notebook order, a current match moved by next / previous, and replace (one or all,
// sources only: outputs are the kernel's). DOM-free and tested.

export interface FindOptions {
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  /** Markdown cells' source (default true). */
  markdown?: boolean;
  /** Code (and raw) cells' source (default true). */
  code?: boolean;
  /** Outputs' text (default false). */
  outputs?: boolean;
}

export interface FindCell {
  id: string;
  kind: "code" | "markdown" | "raw";
  source: string;
  /** Each output's text ("" for one without text). */
  outputs?: readonly string[];
}

export interface FindMatch {
  cellId: string;
  cellIndex: number;
  /** In the cell's source, or in its output number `output`. */
  where: "source" | "output";
  output?: number;
  /** Offsets in the searched text. */
  start: number;
  end: number;
  /** 1-based; the end column is exclusive (as the editor's ranges). */
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

/** Most matches kept (a one-letter query in a big notebook). */
export const MAX_MATCHES = 5000;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The query as a global regular expression, or an error message for a bad pattern. */
export function findPattern(options: FindOptions): RegExp | string | null {
  if (!options.query) return null;
  let source = options.regex ? options.query : escapeRegExp(options.query);
  if (options.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  try {
    return new RegExp(source, `gu${options.caseSensitive ? "" : "i"}m`);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Offset → 1-based line and column. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function positionOf(starts: readonly number[], offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] as number) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - (starts[lo] as number) + 1 };
}

/** Every match of `pattern` in `text` (empty matches skipped), at most `limit`. */
export function matchesIn(
  text: string,
  pattern: RegExp,
  limit = MAX_MATCHES,
): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const re = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  for (let m = re.exec(text); m && out.length < limit; m = re.exec(text)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export function findInCells(cells: readonly FindCell[], options: FindOptions): FindMatch[] {
  const pattern = findPattern(options);
  if (!(pattern instanceof RegExp)) return [];
  const out: FindMatch[] = [];
  const push = (
    cell: FindCell,
    index: number,
    text: string,
    where: "source" | "output",
    output?: number,
  ) => {
    if (out.length >= MAX_MATCHES) return;
    const starts = lineStarts(text);
    for (const m of matchesIn(text, pattern, MAX_MATCHES - out.length)) {
      const a = positionOf(starts, m.start);
      const b = positionOf(starts, m.end);
      out.push({
        cellId: cell.id,
        cellIndex: index,
        where,
        ...(output !== undefined && { output }),
        start: m.start,
        end: m.end,
        line: a.line,
        column: a.column,
        endLine: b.line,
        endColumn: b.column,
      });
    }
  };
  for (const [i, cell] of cells.entries()) {
    const wanted = cell.kind === "markdown" ? options.markdown !== false : options.code !== false;
    if (wanted) push(cell, i, cell.source.replace(/\r\n?/g, "\n"), "source");
    if (options.outputs && cell.outputs)
      for (const [j, text] of cell.outputs.entries()) if (text) push(cell, i, text, "output", j);
  }
  return out;
}

/**
 * The replacement text for one match: with `regex`, `$1`, `$&`, `$<name>` refer to the match's
 * groups (as in VS Code); otherwise the text as typed.
 */
export function replacementFor(
  text: string,
  match: { start: number; end: number },
  replacement: string,
  options: FindOptions,
): string {
  if (!options.regex) return replacement;
  const pattern = findPattern(options);
  if (!(pattern instanceof RegExp)) return replacement;
  const re = new RegExp(pattern.source, pattern.flags.replace("g", "y"));
  re.lastIndex = match.start;
  const m = re.exec(text);
  if (!m || m.index !== match.start) return replacement;
  return m[0].replace(new RegExp(pattern.source, pattern.flags.replace("g", "")), replacement);
}

/** `source` with every match replaced (sources only); the number of replacements. */
export function replaceAllIn(
  source: string,
  options: FindOptions,
  replacement: string,
): { text: string; count: number } {
  const pattern = findPattern(options);
  if (!(pattern instanceof RegExp)) return { text: source, count: 0 };
  const text = source.replace(/\r\n?/g, "\n");
  const matches = matchesIn(text, pattern, Number.MAX_SAFE_INTEGER);
  if (!matches.length) return { text: source, count: 0 };
  let out = "";
  let at = 0;
  for (const m of matches) {
    out += text.slice(at, m.start) + replacementFor(text, m, replacement, options);
    at = m.end;
  }
  return { text: out + text.slice(at), count: matches.length };
}

/** The match to make current after `from` (a cell index and offset), going `direction`. */
export function nearestMatch(
  matches: readonly FindMatch[],
  from: { cellIndex: number; offset: number },
  direction: 1 | -1 = 1,
): number {
  if (!matches.length) return -1;
  if (direction === 1) {
    const i = matches.findIndex(
      (m) =>
        m.cellIndex > from.cellIndex || (m.cellIndex === from.cellIndex && m.start >= from.offset),
    );
    return i < 0 ? 0 : i;
  }
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i] as FindMatch;
    if (m.cellIndex < from.cellIndex || (m.cellIndex === from.cellIndex && m.start < from.offset))
      return i;
  }
  return matches.length - 1;
}

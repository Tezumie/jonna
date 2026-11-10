// Word-level changes inside changed lines (D207: the merge editor's highlights, like VS Code's
// inner-line diff): the words, spaces and punctuation of `modified` that differ from `original`,
// by the same Myers diff over tokens. DOM-free.

import { diffLines } from "./index";

/** A changed stretch of one line: 0-based line (within the given lines), columns [start, end). */
export interface WordRange {
  line: number;
  start: number;
  end: number;
}

/** Above this many characters on either side, no word highlights (the lines say enough). */
const MAX_CHARS = 20_000;

interface Token {
  text: string;
  line: number;
  column: number;
}

/** Newlines, runs of other white space, words, and single other characters. */
function tokenize(lines: readonly string[]): Token[] {
  const out: Token[] = [];
  lines.forEach((text, line) => {
    if (line > 0) out.push({ text: "\n", line: line - 1, column: lines[line - 1]?.length ?? 0 });
    for (const m of text.matchAll(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu))
      out.push({ text: m[0], line, column: m.index ?? 0 });
  });
  return out;
}

/**
 * Where `modified` differs from `original` word by word. Nothing when either side is empty (a
 * pure insertion or deletion: the whole lines are the change) or too large.
 */
export function wordChanges(original: readonly string[], modified: readonly string[]): WordRange[] {
  const size = (l: readonly string[]) => l.reduce((n, s) => n + s.length + 1, 0);
  if (!original.length || !modified.length) return [];
  if (size(original) > MAX_CHARS || size(modified) > MAX_CHARS) return [];
  const a = tokenize(original);
  const b = tokenize(modified);
  // diffLines compares terminated lines: one token per "line".
  const keyed = (t: readonly Token[]) => t.map((x) => `${x.text}\n`);
  const out: WordRange[] = [];
  for (const c of diffLines(keyed(a), keyed(b))) {
    for (let i = c.modifiedStart; i < c.modifiedEnd; i++) {
      const t = b[i];
      if (!t || t.text === "\n") continue;
      const last = out[out.length - 1];
      // Neighbouring tokens of one line become one range.
      if (last && last.line === t.line && last.end === t.column) last.end += t.text.length;
      else out.push({ line: t.line, start: t.column, end: t.column + t.text.length });
    }
  }
  return out;
}

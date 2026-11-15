// A change to a file as text for a terminal: how many lines it adds and removes, and a unified
// diff with a few lines of context. Built on the IDE's own line diff. Pure.
import { diffLines, splitLines } from "../../core/diff/index";
import type { Style } from "./style";

export interface DiffCounts {
  added: number;
  removed: number;
}

/** Lines added and removed going from `before` to `after` (a missing file is no lines). */
export function diffCounts(before: string | null, after: string | null): DiffCounts {
  const a = splitLines(before ?? "");
  const b = splitLines(after ?? "");
  let added = 0;
  let removed = 0;
  for (const c of diffLines(a, b)) {
    added += c.modifiedEnd - c.modifiedStart;
    removed += c.originalEnd - c.originalStart;
  }
  return { added, removed };
}

/** "+3 -1", coloured. */
export function countsText(counts: DiffCounts, style: Style): string {
  return `${style.green(`+${counts.added}`)} ${style.red(`-${counts.removed}`)}`;
}

const bare = (line: string): string => line.replace(/\r?\n$|\r$/, "");

/**
 * A unified diff of one file (`context` unchanged lines around each change), at most `maxLines`
 * lines of it (the rest is counted in a last line). Empty when nothing changed.
 */
export function unifiedDiff(
  path: string,
  before: string | null,
  after: string | null,
  style: Style,
  options: { context?: number; maxLines?: number } = {},
): string {
  const context = options.context ?? 3;
  const maxLines = options.maxLines ?? 400;
  const a = splitLines(before ?? "");
  const b = splitLines(after ?? "");
  const changes = diffLines(a, b);
  if (!changes.length) return "";
  const out: string[] = [
    style.bold(`--- ${before === null ? "/dev/null" : path}`),
    style.bold(`+++ ${after === null ? "/dev/null" : path}`),
  ];
  let i = 0;
  while (i < changes.length) {
    // Changes whose contexts touch are one hunk.
    let j = i;
    while (j + 1 < changes.length) {
      const here = changes[j];
      const next = changes[j + 1];
      if (!here || !next || next.originalStart - here.originalEnd > context * 2) break;
      j++;
    }
    const first = changes[i];
    const last = changes[j];
    if (!first || !last) break;
    const startA = Math.max(0, first.originalStart - context);
    const startB = Math.max(0, first.modifiedStart - context);
    const endA = Math.min(a.length, last.originalEnd + context);
    const endB = Math.min(b.length, last.modifiedEnd + context);
    out.push(style.cyan(`@@ -${startA + 1},${endA - startA} +${startB + 1},${endB - startB} @@`));
    let at = startA;
    for (let k = i; k <= j; k++) {
      const c = changes[k];
      if (!c) continue;
      for (; at < c.originalStart; at++) out.push(` ${bare(a[at] ?? "")}`);
      for (let x = c.originalStart; x < c.originalEnd; x++)
        out.push(style.red(`-${bare(a[x] ?? "")}`));
      for (let x = c.modifiedStart; x < c.modifiedEnd; x++)
        out.push(style.green(`+${bare(b[x] ?? "")}`));
      at = c.originalEnd;
    }
    for (; at < endA; at++) out.push(` ${bare(a[at] ?? "")}`);
    i = j + 1;
  }
  if (out.length > maxLines) {
    const more = out.length - maxLines;
    return `${out.slice(0, maxLines).join("\n")}\n${style.dim(`… ${more} more lines`)}\n`;
  }
  return `${out.join("\n")}\n`;
}

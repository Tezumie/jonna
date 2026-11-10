// The debug console's line diff, DOM-free so it's unit-tested without the view (its icons).
import type { ConsoleLine } from "./controller";

/**
 * How to bring the lines `shown` up to `lines`: drop `drop` from the top, remove the last one
 * shown when `redrawLast`, then append `lines.slice(appendFrom)`. `null` means redraw (cleared,
 * or the last line shown is gone). Lines are matched by identity, since the controller only
 * appends, trims the front and replaces its last line with a longer copy (output that continued
 * an unfinished line, consoleSessions.ts continueOutput).
 */
export function consoleDiff(
  shown: readonly ConsoleLine[],
  lines: readonly ConsoleLine[],
): { drop: number; appendFrom: number; redrawLast?: true } | null {
  const last = shown[shown.length - 1];
  if (last === undefined) return { drop: 0, appendFrom: 0 };
  let at = lines.lastIndexOf(last);
  let redrawLast = false;
  if (at < 0) {
    // Continued: its copy is where it was, right after the line shown before it.
    const before = shown[shown.length - 2];
    at = before === undefined ? 0 : lines.lastIndexOf(before) + 1;
    if ((before !== undefined && at === 0) || !continuedAs(last, lines[at])) return null;
    redrawLast = true;
  }
  const drop = shown.length - 1 - at;
  if (drop < 0) return null;
  // The first line kept must be the list's first, or the list changed some other way: redraw.
  const firstKept = redrawLast && drop === shown.length - 1 ? lines[at] : shown[drop];
  if (firstKept !== lines[0]) return null;
  return redrawLast ? { drop, appendFrom: at, redrawLast: true } : { drop, appendFrom: at + 1 };
}

/** `next` can be `line` continued: output of the same console and stream. */
function continuedAs(line: ConsoleLine, next: ConsoleLine | undefined): boolean {
  return (
    next !== undefined &&
    line.kind === "output" &&
    next.kind === "output" &&
    next.sessionId === line.sessionId &&
    (next.stderr ?? false) === (line.stderr ?? false)
  );
}

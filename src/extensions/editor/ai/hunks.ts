// Per-hunk review of an inline edit (D172), like Cursor's Ctrl+K: the model's rewrite of the
// selected lines, split into the changed regions (hunks) against the original; each is accepted
// or rejected on its own, and the lines in the editor are always `compose()`: unchanged lines,
// then each hunk's new lines, or its old ones once rejected. DOM-free and tested.
import { diffLines } from "../../../core/diff/index";

export type HunkState = "pending" | "accepted" | "rejected";

export type Segment =
  | { kind: "same"; lines: string[] }
  | { kind: "hunk"; removed: string[]; added: string[]; state: HunkState };

const lines = (text: string) => (text === "" ? [] : text.split("\n"));

/** The rewrite `next` of `original` (both "\n"-joined lines), as unchanged runs and hunks. */
export function segmentsOf(original: string, next: string): Segment[] {
  const a = lines(original);
  const b = lines(next);
  // diffLines compares lines with their terminators (all "\n" here).
  const changes = diffLines(
    a.map((l) => `${l}\n`),
    b.map((l) => `${l}\n`),
  );
  const out: Segment[] = [];
  let at = 0;
  for (const c of changes) {
    if (c.originalStart > at) out.push({ kind: "same", lines: a.slice(at, c.originalStart) });
    out.push({
      kind: "hunk",
      removed: a.slice(c.originalStart, c.originalEnd),
      added: b.slice(c.modifiedStart, c.modifiedEnd),
      state: "pending",
    });
    at = c.originalEnd;
  }
  if (at < a.length) out.push({ kind: "same", lines: a.slice(at) });
  return out;
}

/** The lines as they stand: rejected hunks put back their old lines. */
export function compose(segments: readonly Segment[]): string {
  return segments
    .flatMap((s) => (s.kind === "same" ? s.lines : s.state === "rejected" ? s.removed : s.added))
    .join("\n");
}

/** Where each hunk's lines are in `compose()`'s text (0-based start, line count), by hunk. */
export function hunkPositions(segments: readonly Segment[]): { start: number; count: number }[] {
  const out: { start: number; count: number }[] = [];
  let line = 0;
  for (const s of segments) {
    if (s.kind === "same") {
      line += s.lines.length;
      continue;
    }
    const count = s.state === "rejected" ? s.removed.length : s.added.length;
    out.push({ start: line, count });
    line += count;
  }
  return out;
}

export function hunks(segments: readonly Segment[]): Extract<Segment, { kind: "hunk" }>[] {
  return segments.filter((s): s is Extract<Segment, { kind: "hunk" }> => s.kind === "hunk");
}

/** "+3 −1" for the bar. */
export function hunkStat(segments: readonly Segment[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks(segments))
    if (h.state !== "rejected") {
      added += h.added.length;
      removed += h.removed.length;
    }
  return { added, removed };
}

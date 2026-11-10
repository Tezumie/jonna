// Three-way merge for the merge editor (D204, VS Code's): the changes each side (current = ours,
// incoming = theirs) made to the common base, grouped where they overlap; a group both sides
// changed differently is a conflict. The result is a list of segments, one per region (common
// text or a change), so accepting a side replaces just that segment and edits typed into the
// result move the segments' boundaries. DOM-free; lines are 0-based, ranges half-open.

import { diffLines, type LineChange } from "./index";

export type MergeChoice = "current" | "incoming" | "both" | "bothIncomingFirst" | "base";

/** Lines start..end (0-based, end exclusive). */
export interface LineSpan {
  start: number;
  end: number;
}

export interface MergeChange {
  /** Its index among the changes (stable for one computation). */
  id: number;
  base: LineSpan;
  current: LineSpan;
  incoming: LineSpan;
  /** Both sides changed these base lines, differently. */
  conflict: boolean;
}

/** How a change stands in the result. */
export interface ChangeState {
  /** What the result holds for it ("edited": typed by hand); null: an unhandled conflict (base text). */
  choice: MergeChoice | "edited" | null;
  handled: boolean;
}

type Region =
  | { kind: "common"; base: LineSpan; current: LineSpan; incoming: LineSpan }
  | {
      kind: "change";
      change: MergeChange;
    };

export type MergePane = "base" | "current" | "incoming" | "result";

/** Text → lines without terminators; whether it ended with a newline; its line ending. */
export function textLines(text: string): { lines: string[]; finalNewline: boolean; eol: string } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (text === "") return { lines: [], finalNewline: false, eol };
  const lines = text.split(/\r?\n/);
  const finalNewline = lines[lines.length - 1] === "";
  if (finalNewline) lines.pop();
  return { lines, finalNewline, eol };
}

const terminated = (lines: readonly string[]) => lines.map((l) => `${l}\n`);

/** Overlapping (or one inserting inside / at the edge of the other) base ranges. */
function touches(a: LineChange, b: LineChange): boolean {
  const aEmpty = a.originalStart === a.originalEnd;
  const bEmpty = b.originalStart === b.originalEnd;
  if (aEmpty || bEmpty) return a.originalStart <= b.originalEnd && b.originalStart <= a.originalEnd;
  return a.originalStart < b.originalEnd && b.originalStart < a.originalEnd;
}

const sameLines = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((l, i) => l === b[i]);

/**
 * The changes `current` and `incoming` made to `base`, grouped: each group's span in all three
 * texts, and whether it's a conflict (both changed it, not the same way).
 */
export function computeMergeChanges(
  base: readonly string[],
  current: readonly string[],
  incoming: readonly string[],
): MergeChange[] {
  // Both sides added the file (no base, D219): against an empty base everything would be one
  // conflict. Like git's own markers, the lines both have in common are common text and each
  // stretch where they differ is a conflict (even one side adding lines the other hasn't: both
  // added the file, so neither is "the change").
  if (base.length === 0 && current.length > 0 && incoming.length > 0)
    return diffLines(terminated(current), terminated(incoming)).map((c, id) => ({
      id,
      base: { start: 0, end: 0 },
      current: { start: c.originalStart, end: c.originalEnd },
      incoming: { start: c.modifiedStart, end: c.modifiedEnd },
      conflict: true,
    }));
  const ours = diffLines(terminated(base), terminated(current)).map((c) => ({ c, side: 0 }));
  const theirs = diffLines(terminated(base), terminated(incoming)).map((c) => ({ c, side: 1 }));
  const all = [...ours, ...theirs].sort(
    (a, b) => a.c.originalStart - b.c.originalStart || a.c.originalEnd - b.c.originalEnd,
  );
  const out: MergeChange[] = [];
  // Base → side line offset after the side's changes so far (for a side with no change in a group).
  const delta = [0, 0];
  let i = 0;
  while (i < all.length) {
    const first = all[i] as (typeof all)[number];
    const group = [first];
    let start = first.c.originalStart;
    let end = first.c.originalEnd;
    i++;
    // Grow the group while the next change (either side) touches it.
    while (i < all.length) {
      const next = all[i] as (typeof all)[number];
      const span: LineChange = {
        originalStart: start,
        originalEnd: end,
        modifiedStart: 0,
        modifiedEnd: 0,
      };
      if (!touches(span, next.c) && !group.some((g) => touches(g.c, next.c))) break;
      group.push(next);
      start = Math.min(start, next.c.originalStart);
      end = Math.max(end, next.c.originalEnd);
      i++;
    }
    const spanOf = (side: number): LineSpan => {
      const mine = group.filter((g) => g.side === side).map((g) => g.c);
      const d = delta[side] ?? 0;
      if (!mine.length) return { start: start + d, end: end + d };
      const head = mine[0] as LineChange;
      const tail = mine[mine.length - 1] as LineChange;
      return {
        start: head.modifiedStart - (head.originalStart - start),
        end: tail.modifiedEnd + (end - tail.originalEnd),
      };
    };
    const cur = spanOf(0);
    const inc = spanOf(1);
    delta[0] = cur.end - end;
    delta[1] = inc.end - end;
    const both = group.some((g) => g.side === 0) && group.some((g) => g.side === 1);
    const conflict =
      both && !sameLines(current.slice(cur.start, cur.end), incoming.slice(inc.start, inc.end));
    out.push({ id: out.length, base: { start, end }, current: cur, incoming: inc, conflict });
  }
  return out;
}

/**
 * The merge editor's model: the three inputs, the changes, and the result as segments (one per
 * region) with each change's state. Accepting replaces a change's segment; `setResultText`
 * takes a hand edit of the whole result and keeps the segments in step.
 */
export class MergeModel {
  readonly base: string[];
  readonly current: string[];
  readonly incoming: string[];
  readonly changes: MergeChange[];
  private readonly regions: Region[];
  private segments: string[][] = [];
  private states: ChangeState[] = [];
  private readonly eol: string;
  private finalNewline: boolean;
  /** The merged final newline, back after reset() (a hand edit may have changed it). */
  private readonly mergedFinalNewline: boolean;

  constructor(base: string, current: string, incoming: string) {
    const b = textLines(base);
    const c = textLines(current);
    const i = textLines(incoming);
    this.base = b.lines;
    this.current = c.lines;
    this.incoming = i.lines;
    // The current side's line ending; when it has no line break at all (empty, or one line),
    // the first side that has one (a CRLF file isn't joined with LF).
    this.eol = [current, incoming, base].find((t) => t.includes("\n"))?.includes("\r\n")
      ? "\r\n"
      : "\n";
    // The final newline merges like a line (D219): the side that changed it from the base wins,
    // so one only the incoming side added (or took away) isn't lost.
    this.finalNewline =
      c.lines.length === 0
        ? i.finalNewline
        : c.finalNewline === b.finalNewline
          ? i.finalNewline
          : c.finalNewline;
    this.mergedFinalNewline = this.finalNewline;
    this.changes = computeMergeChanges(this.base, this.current, this.incoming);
    this.regions = [];
    let at = { base: 0, current: 0, incoming: 0 };
    const common = (to: { base: number; current: number; incoming: number }) => {
      if (to.base > at.base || to.current > at.current || to.incoming > at.incoming)
        this.regions.push({
          kind: "common",
          base: { start: at.base, end: to.base },
          current: { start: at.current, end: to.current },
          incoming: { start: at.incoming, end: to.incoming },
        });
    };
    for (const change of this.changes) {
      common({
        base: change.base.start,
        current: change.current.start,
        incoming: change.incoming.start,
      });
      this.regions.push({ kind: "change", change });
      at = { base: change.base.end, current: change.current.end, incoming: change.incoming.end };
    }
    common({
      base: this.base.length,
      current: this.current.length,
      incoming: this.incoming.length,
    });
    this.reset();
  }

  /** Back to the start: every one-sided change taken, every conflict unhandled (base text). */
  reset(): void {
    this.finalNewline = this.mergedFinalNewline;
    this.states = this.changes.map((c) => {
      if (c.conflict) return { choice: null, handled: false };
      const currentChanged = !sameLines(
        this.lines("current", c.current),
        this.lines("base", c.base),
      );
      return { choice: currentChanged ? "current" : "incoming", handled: true };
    });
    this.segments = this.regions.map((r) =>
      r.kind === "common"
        ? this.current.slice(r.current.start, r.current.end)
        : this.linesFor(r.change, this.stateOf(r.change.id).choice),
    );
  }

  private lines(pane: "base" | "current" | "incoming", span: LineSpan): string[] {
    return this[pane].slice(span.start, span.end);
  }

  /** What the result holds for `change` with `choice` (null / "edited": the base text). */
  linesFor(change: MergeChange, choice: MergeChoice | "edited" | null): string[] {
    const cur = this.lines("current", change.current);
    const inc = this.lines("incoming", change.incoming);
    switch (choice) {
      case "current":
        return cur;
      case "incoming":
        return inc;
      case "both":
        return [...cur, ...inc];
      case "bothIncomingFirst":
        return [...inc, ...cur];
      default:
        return this.lines("base", change.base);
    }
  }

  stateOf(id: number): ChangeState {
    return this.states[id] ?? { choice: null, handled: false };
  }

  get conflictCount(): number {
    return this.changes.filter((c) => c.conflict).length;
  }

  /** Conflicts not handled yet ("2 of 5 conflicts left"). */
  get unhandledCount(): number {
    return this.changes.filter((c) => c.conflict && !this.stateOf(c.id).handled).length;
  }

  /** The result text. */
  text(): string {
    const lines = this.segments.flat();
    return lines.join(this.eol) + (this.finalNewline && lines.length ? this.eol : "");
  }

  /** Sets a change's segment to `choice` (marks it handled). */
  accept(id: number, choice: MergeChoice): void {
    const change = this.changes[id];
    const at = this.regionIndex(id);
    if (!change || at < 0) return;
    this.segments[at] = this.linesFor(change, choice);
    this.states[id] = { choice, handled: true };
  }

  /** Marks a conflict handled (or not) without changing its text. */
  setHandled(id: number, handled: boolean): void {
    const st = this.states[id];
    if (st) this.states[id] = { ...st, handled };
  }

  /** One change back to how it started (a conflict: unhandled, at the base text). */
  resetChange(id: number): void {
    const change = this.changes[id];
    const at = this.regionIndex(id);
    if (!change || at < 0) return;
    if (!change.conflict) {
      const currentChanged = !sameLines(
        this.lines("current", change.current),
        this.lines("base", change.base),
      );
      this.accept(id, currentChanged ? "current" : "incoming");
      return;
    }
    this.segments[at] = this.linesFor(change, null);
    this.states[id] = { choice: null, handled: false };
  }

  /** The result's lines of change `id` now. */
  /** The result's lines for change `id` (its word highlights, D209). */
  resultLinesOf(id: number): string[] {
    const at = this.regionIndex(id);
    return at < 0 ? [] : [...(this.segments[at] ?? [])];
  }

  resultSpan(id: number): LineSpan {
    const at = this.regionIndex(id);
    let start = 0;
    for (let r = 0; r < at; r++) start += this.segments[r]?.length ?? 0;
    return { start, end: start + (this.segments[at]?.length ?? 0) };
  }

  private regionIndex(id: number): number {
    return this.regions.findIndex((r) => r.kind === "change" && r.change.id === id);
  }

  /**
   * The user edited the result: `text` is all of it now. The edit is diffed against the result
   * as it was, so each segment keeps its lines; a change whose lines were typed over is
   * "edited" (handled) unless they now match one of the choices.
   */
  setResultText(text: string): void {
    const next = textLines(text);
    this.finalNewline = next.finalNewline || (next.lines.length === 0 && this.finalNewline);
    const old = this.segments.flat();
    if (sameLines(old, next.lines)) return;
    const edits = diffLines(terminated(old), terminated(next.lines));
    const bounds = [0];
    for (const seg of this.segments) bounds.push((bounds[bounds.length - 1] ?? 0) + seg.length);
    const mapped = bounds.map((b, i) => {
      if (i === 0) return 0;
      if (i === bounds.length - 1) return next.lines.length;
      // Text inserted at a boundary joins the change next to it (the conflict being resolved).
      const before = this.regions[i - 1];
      const after = this.regions[i];
      const preferAfter = after?.kind === "change" && before?.kind !== "change";
      return mapBoundary(b, edits, preferAfter);
    });
    for (let i = 1; i < mapped.length; i++)
      mapped[i] = Math.max(mapped[i] as number, mapped[i - 1] as number);
    const segments = this.regions.map((_r, i) =>
      next.lines.slice(mapped[i] as number, mapped[i + 1] as number),
    );
    this.regions.forEach((r, i) => {
      if (r.kind !== "change") return;
      const before = this.segments[i] ?? [];
      const now = segments[i] ?? [];
      if (sameLines(before, now)) return;
      const choices: MergeChoice[] = ["current", "incoming", "both", "bothIncomingFirst"];
      const match = choices.find((c) => sameLines(this.linesFor(r.change, c), now));
      this.states[r.change.id] = { choice: match ?? "edited", handled: true };
    });
    this.segments = segments;
  }

  /** Where `line` (0-based) of one pane is in another (scroll sync). */
  mapLine(from: MergePane, to: MergePane, line: number): number {
    const spans = this.regions.map((r, i) => this.regionSpans(r, i));
    const inFrom = spans.findIndex((s) => line >= s[from].start && line < s[from].end);
    const index = inFrom >= 0 ? inFrom : spans.findIndex((s) => s[from].start >= line);
    const region = spans[index < 0 ? spans.length - 1 : index];
    if (!region) return 0;
    const offset = Math.max(0, line - region[from].start);
    const target = region[to];
    return Math.min(target.start + offset, Math.max(target.start, target.end - 1));
  }

  private regionSpans(r: Region, index: number): Record<MergePane, LineSpan> {
    let start = 0;
    for (let i = 0; i < index; i++) start += this.segments[i]?.length ?? 0;
    const result = { start, end: start + (this.segments[index]?.length ?? 0) };
    return r.kind === "common"
      ? { base: r.base, current: r.current, incoming: r.incoming, result }
      : { base: r.change.base, current: r.change.current, incoming: r.change.incoming, result };
  }

  /** The next (or previous) conflict from result line `line`, wrapping around. */
  nextConflict(line: number, direction: "next" | "previous", unhandledOnly = false): number | null {
    const list = this.changes.filter(
      (c) => c.conflict && (!unhandledOnly || !this.stateOf(c.id).handled),
    );
    if (!list.length) return null;
    const starts = list.map((c) => ({ id: c.id, start: this.resultSpan(c.id).start }));
    if (direction === "next") return (starts.find((s) => s.start > line) ?? starts[0])?.id ?? null;
    return (
      ([...starts].reverse().find((s) => s.start < line) ?? starts[starts.length - 1])?.id ?? null
    );
  }
}

/** Where boundary `b` (between lines) of the old text is after `edits`. */
function mapBoundary(b: number, edits: readonly LineChange[], preferAfter: boolean): number {
  let delta = 0;
  for (const c of edits) {
    if (c.originalEnd < b || (c.originalEnd === b && c.originalStart < b)) {
      delta = c.modifiedEnd - c.originalEnd;
      continue;
    }
    if (c.originalStart > b) break;
    // A change that starts right at the boundary belongs after it.
    if (c.originalStart === b && c.originalEnd > b) return c.modifiedStart;
    // An insertion at the boundary, or a change spanning it.
    return preferAfter ? c.modifiedStart : c.modifiedEnd;
  }
  return b + delta;
}

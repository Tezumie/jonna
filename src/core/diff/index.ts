// Line diff (Myers, O(ND)) for quick-diff gutter bars and hunk staging. DOM-free.
// Texts are split into lines that keep their terminators, so a change can be applied to either side
// and joined back byte for byte; lines compare without the terminator ("a\r\n" equals "a\n").

/** One changed region; half-open 0-based line ranges in each text. */
export interface LineChange {
  originalStart: number;
  originalEnd: number;
  modifiedStart: number;
  modifiedEnd: number;
}

/**
 * Splits keeping "\n" / "\r\n" / a lone "\r" on each line; a final line without terminator is kept
 * too. A lone "\r" ends a line because the editor counts it as one: line numbers here must match
 * the editor's, or a file with stray "\r"s shows every line as changed and staging hits the wrong
 * lines.
 */
export function splitLines(text: string): string[] {
  const lines: string[] = [];
  let at = 0;
  // The next "\n" and "\r" at or after `at`, looked for again only once passed: searching for
  // each on every line reads to the end of a text that has none of them (LF files have no "\r"),
  // which took minutes on a file of 300,000 lines and froze the window.
  let nl = text.indexOf("\n");
  let cr = text.indexOf("\r");
  while (at < text.length) {
    if (nl >= 0 && nl < at) nl = text.indexOf("\n", at);
    if (cr >= 0 && cr < at) cr = text.indexOf("\r", at);
    if (nl < 0 && cr < 0) {
      lines.push(text.slice(at));
      break;
    }
    // The first break: a "\r" before the next "\n" ends the line there, unless it's "\r\n".
    let end: number;
    if (cr >= 0 && (nl < 0 || cr < nl)) end = text[cr + 1] === "\n" ? cr + 2 : cr + 1;
    else end = nl + 1;
    lines.push(text.slice(at, end));
    at = end;
  }
  return lines;
}

function content(line: string): string {
  if (line.endsWith("\r\n")) return line.slice(0, -2);
  return line.endsWith("\n") || line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Above this many edits the middle is reported as one change (keeps huge rewrites fast). The diff
 * reruns after every typing pause, and the trace grows with the square of the edits (~4 MB at
 * 1000), so a rewrite that large is cheaper and just as useful shown as one block.
 */
const MAX_EDITS = 1000;

/** The changes turning `original` into `modified` (lines from `splitLines`). */
export function diffLines(original: readonly string[], modified: readonly string[]): LineChange[] {
  // A last line without a newline differs from the same text with one ("\ No newline at end").
  const keyed = (lines: readonly string[]) =>
    lines.map((l, i) => (i === lines.length - 1 && !l.endsWith("\n") ? `${l}\u0000` : content(l)));
  const a = keyed(original);
  const b = keyed(modified);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) return [];
  const changes = myers(a, b, start, endA, start, endB);
  return (
    changes ?? [
      { originalStart: start, originalEnd: endA, modifiedStart: start, modifiedEnd: endB },
    ]
  );
}

/** Myers' greedy algorithm with a trace for backtracking; null if it needs more than MAX_EDITS. */
function myers(
  a: readonly string[],
  b: readonly string[],
  a0: number,
  a1: number,
  b0: number,
  b1: number,
): LineChange[] | null {
  const n = a1 - a0;
  const m = b1 - b0;
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    // Round d only reads diagonals -d..d of the previous round, so keep just that slice (index
    // k + d) instead of the whole array — copying all of `v` each round was O(MAX_EDITS²) memory.
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))
          ? (v[offset + k + 1] ?? 0)
          : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return null;
  // Backtrack: collect the edit script as (x, y) points, then merge runs into changes.
  const edits: { kind: "del" | "ins"; x: number; y: number }[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d] as Int32Array;
    const k = x - y;
    const down = k === -d || (k !== d && (prev[d + k - 1] ?? 0) < (prev[d + k + 1] ?? 0));
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[d + prevK] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX + (down ? 0 : 1) && y > prevY + (down ? 1 : 0)) {
      x--;
      y--;
    }
    if (down) edits.push({ kind: "ins", x: prevX, y: prevY });
    else edits.push({ kind: "del", x: prevX, y: prevY });
    x = prevX;
    y = prevY;
  }
  edits.reverse();
  const changes: LineChange[] = [];
  for (const e of edits) {
    const ax = a0 + e.x;
    const by = b0 + e.y;
    const last = changes[changes.length - 1];
    if (last && last.originalEnd === ax && last.modifiedEnd === by) {
      if (e.kind === "del") last.originalEnd++;
      else last.modifiedEnd++;
    } else {
      changes.push({
        originalStart: ax,
        originalEnd: ax + (e.kind === "del" ? 1 : 0),
        modifiedStart: by,
        modifiedEnd: by + (e.kind === "ins" ? 1 : 0),
      });
    }
  }
  return changes;
}

export type LineMarkKind = "added" | "modified" | "deleted";

/** A gutter mark on the modified side; 1-based inclusive lines ("deleted" marks the line after). */
export interface LineMark {
  kind: LineMarkKind;
  startLine: number;
  endLine: number;
  /** Staged (in the index, not committed): drawn dimmed (D203, VS Code's staged bars). */
  staged?: boolean;
}

/**
 * Staged lines (D203): the marks of the file against HEAD that the marks against the index don't
 * cover — what `git add` took but no commit has yet. Both lists are on the same (buffer) lines.
 */
export function stagedMarks(
  againstHead: readonly LineMark[],
  againstIndex: readonly LineMark[],
): LineMark[] {
  const unstaged = new Set<number>();
  for (const m of againstIndex) for (let l = m.startLine; l <= m.endLine; l++) unstaged.add(l);
  const out: LineMark[] = [];
  for (const m of againstHead) {
    if (m.kind === "deleted") {
      if (!unstaged.has(m.startLine)) out.push({ ...m, staged: true });
      continue;
    }
    let start = -1;
    for (let l = m.startLine; l <= m.endLine + 1; l++) {
      const free = l <= m.endLine && !unstaged.has(l);
      if (free && start < 0) start = l;
      if (!free && start >= 0) {
        out.push({ kind: m.kind, startLine: start, endLine: l - 1, staged: true });
        start = -1;
      }
    }
  }
  return out;
}

export function lineMarks(changes: readonly LineChange[]): LineMark[] {
  return changes.map((c) => {
    if (c.modifiedStart === c.modifiedEnd) {
      // Deleted lines show between modifiedStart - 1 and modifiedStart.
      const line = Math.max(1, c.modifiedStart);
      return { kind: "deleted", startLine: line, endLine: line };
    }
    return {
      kind: c.originalStart === c.originalEnd ? "added" : "modified",
      startLine: c.modifiedStart + 1,
      endLine: c.modifiedEnd,
    };
  });
}

/** The change touching 1-based modified-side `line` (deleted changes count for the line after). */
export function changeAtLine(changes: readonly LineChange[], line: number): LineChange | undefined {
  const i = line - 1;
  return changes.find((c) =>
    c.modifiedStart === c.modifiedEnd
      ? i === c.modifiedStart || i === c.modifiedStart - 1
      : i >= c.modifiedStart && i < c.modifiedEnd,
  );
}

/** `original` with one change applied (staging a hunk: index + that change). */
export function applyChange(
  original: readonly string[],
  modified: readonly string[],
  change: LineChange,
): string {
  const inserted = modified.slice(change.modifiedStart, change.modifiedEnd);
  const out = [
    ...original.slice(0, change.originalStart),
    ...inserted,
    ...original.slice(change.originalEnd),
  ];
  return fixLastLine(out).join("");
}

/**
 * `original` with only the changes on lines `from`..`to` of `modified` applied (1-based,
 * inclusive; D200: stage selected lines, VS Code's "Stage selected ranges"). A change of as many
 * new lines as old ones is taken line for line; another partly selected change brings its
 * selected new lines and drops all its old ones; a deletion counts when the selection touches the
 * line before or after it.
 */
export function applySelectedLines(
  original: readonly string[],
  modified: readonly string[],
  from: number,
  to: number,
): string {
  const lo = Math.min(from, to) - 1;
  const hi = Math.max(from, to) - 1;
  const out: string[] = [];
  let at = 0;
  for (const c of diffLines(original, modified)) {
    const selected =
      c.modifiedStart === c.modifiedEnd
        ? c.modifiedStart - 1 <= hi && c.modifiedStart >= lo
        : c.modifiedStart <= hi && c.modifiedEnd - 1 >= lo;
    if (!selected) continue;
    out.push(...original.slice(at, c.originalStart));
    const oldCount = c.originalEnd - c.originalStart;
    const newCount = c.modifiedEnd - c.modifiedStart;
    if (oldCount === newCount) {
      // Line for line (VS Code): a selected line takes its new text, the others keep theirs.
      for (let k = 0; k < newCount; k++) {
        const i = c.modifiedStart + k;
        out.push((i >= lo && i <= hi ? modified[i] : original[c.originalStart + k]) as string);
      }
    } else {
      out.push(...modified.slice(Math.max(c.modifiedStart, lo), Math.min(c.modifiedEnd, hi + 1)));
    }
    at = c.originalEnd;
  }
  out.push(...original.slice(at));
  return fixLastLine(out).join("");
}

/** `modified` with one change undone (reverting a hunk: back to the original's lines). */
export function revertChange(
  original: readonly string[],
  modified: readonly string[],
  change: LineChange,
): string {
  const restored = original.slice(change.originalStart, change.originalEnd);
  const out = [
    ...modified.slice(0, change.modifiedStart),
    ...restored,
    ...modified.slice(change.modifiedEnd),
  ];
  return fixLastLine(out).join("");
}

/** A line spliced into the middle must end with a newline (the source's last line may not). */
function fixLastLine(lines: string[]): string[] {
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i] as string;
    if (!line.endsWith("\n")) lines[i] = `${line}${eolOf(lines)}`;
  }
  return lines;
}

function eolOf(lines: readonly string[]): string {
  return lines.some((l) => l.endsWith("\r\n")) ? "\r\n" : "\n";
}

/** Counts of added and removed lines, for "+12 −3" labels. */
export function diffStat(changes: readonly LineChange[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const c of changes) {
    added += c.modifiedEnd - c.modifiedStart;
    removed += c.originalEnd - c.originalStart;
  }
  return { added, removed };
}

/**
 * `theirs`' changes to `base` applied on top of `ours` (another edit of `base`): an agent's
 * proposal accepted after the user edited the file meanwhile keeps both. Null when a change of
 * each touches the same or adjacent lines (a conflict: the caller asks for a fresh review).
 */
export function rebase(base: string, ours: string, theirs: string): string | null {
  if (ours === base) return theirs;
  if (theirs === base || theirs === ours) return ours;
  const baseLines = splitLines(base);
  const ourLines = splitLines(ours);
  const theirLines = splitLines(theirs);
  const mine = diffLines(baseLines, ourLines);
  const agent = diffLines(baseLines, theirLines);
  for (const a of agent)
    for (const u of mine)
      if (a.originalStart <= u.originalEnd && u.originalStart <= a.originalEnd) return null;
  let out = [...ourLines];
  // Last first: earlier positions stay valid. A base position maps into `ours` by the size
  // change of the user's edits before it.
  for (const a of [...agent].reverse()) {
    let shift = 0;
    for (const u of mine)
      if (u.originalEnd <= a.originalStart)
        shift += u.modifiedEnd - u.modifiedStart - (u.originalEnd - u.originalStart);
    out = [
      ...out.slice(0, a.originalStart + shift),
      ...theirLines.slice(a.modifiedStart, a.modifiedEnd),
      ...out.slice(a.originalEnd + shift),
    ];
  }
  return fixLastLine(out).join("");
}

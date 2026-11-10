// Merge conflicts in text (D120): the `<<<<<<<` / `|||||||` / `=======` / `>>>>>>>` blocks git
// leaves, and resolving one by keeping the current side, the incoming side or both (VS Code's
// "Accept current / incoming / both changes"). DOM-free; lines are 1-based.

export interface Conflict {
  /** The `<<<<<<<` line. */
  start: number;
  /** The `|||||||` line of a diff3 conflict, if any. */
  base?: number;
  /** The `=======` line. */
  separator: number;
  /** The `>>>>>>>` line. */
  end: number;
  currentLabel: string;
  incomingLabel: string;
}

export type ConflictChoice = "current" | "incoming" | "both";

export function findConflicts(text: string): Conflict[] {
  if (!text.includes("<<<<<<<")) return [];
  const lines = text.split(/\r?\n/);
  const out: Conflict[] = [];
  let open: Partial<Conflict> | null = null;
  lines.forEach((line, i) => {
    const n = i + 1;
    if (line.startsWith("<<<<<<<")) open = { start: n, currentLabel: line.slice(7).trim() };
    else if (!open) return;
    else if (line.startsWith("|||||||") && open.separator === undefined && open.base === undefined)
      open.base = n;
    else if (/^=======\s*$/.test(line) && open.separator === undefined) open.separator = n;
    else if (line.startsWith(">>>>>>>") && open.separator !== undefined) {
      out.push({
        start: open.start as number,
        ...(open.base !== undefined && { base: open.base }),
        separator: open.separator,
        end: n,
        currentLabel: open.currentLabel ?? "",
        incomingLabel: line.slice(7).trim(),
      });
      open = null;
    }
  });
  return out;
}

/** The conflict whose block contains `line`, or the first one after it. */
export function conflictAt(conflicts: readonly Conflict[], line: number): Conflict | undefined {
  return (
    conflicts.find((c) => line >= c.start && line <= c.end) ?? conflicts.find((c) => c.start > line)
  );
}

/** The lines that replace the block for `choice` (without the markers). */
export function resolvedLines(
  lines: readonly string[],
  c: Conflict,
  choice: ConflictChoice,
): string[] {
  const current = lines.slice(c.start, (c.base ?? c.separator) - 1);
  const incoming = lines.slice(c.separator, c.end - 1);
  return choice === "current"
    ? current
    : choice === "incoming"
      ? incoming
      : [...current, ...incoming];
}

/** `text` with `conflict` (or every conflict) resolved; line endings kept. */
export function resolveConflicts(
  text: string,
  choice: ConflictChoice,
  which: Conflict | "all",
): { text: string; resolved: number } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const targets = which === "all" ? findConflicts(text) : [which];
  // Bottom-up so earlier line numbers stay valid.
  for (const c of [...targets].sort((a, b) => b.start - a.start))
    lines.splice(c.start - 1, c.end - c.start + 1, ...resolvedLines(lines, c, choice));
  return { text: lines.join(eol), resolved: targets.length };
}

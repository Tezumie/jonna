// Finding rows in a tree by their label (D200): type-ahead (typing jumps to the next row starting
// with what was typed, VS Code's list keyboard navigation) and the find widget's matching
// (Ctrl+Alt+F in the explorer: highlight or filter). DOM-free and tested.

/** How long typed characters keep adding to the type-ahead prefix. */
export const TYPE_AHEAD_MS = 800;

/** The type-ahead prefix after typing `key` at `now`. */
export class TypeAhead {
  private prefix = "";
  private last = 0;

  push(key: string, now: number): string {
    this.prefix = now - this.last > TYPE_AHEAD_MS ? key : this.prefix + key;
    this.last = now;
    return this.prefix;
  }

  reset(): void {
    this.prefix = "";
    this.last = 0;
  }
}

/**
 * The index of the row a type-ahead `prefix` goes to: the first after `active` whose label starts
 * with it (case-insensitive), wrapping around; a longer prefix may stay on the current row. When
 * the same letter is typed again ("ss"), it cycles through rows starting with that letter.
 */
export function typeAheadIndex(labels: readonly string[], active: number, prefix: string): number {
  if (!prefix || !labels.length) return -1;
  const p = prefix.toLowerCase();
  const repeated = p.length > 1 && [...p].every((c) => c === p[0]);
  const wanted = repeated ? (p[0] ?? p) : p;
  // A longer prefix refines the current match; a new letter (or a repeat) moves on.
  const start = p.length > 1 && !repeated ? Math.max(0, active) : active + 1;
  for (let i = 0; i < labels.length; i++) {
    const at = (start + i) % labels.length;
    if ((labels[at] ?? "").toLowerCase().startsWith(wanted)) return at;
  }
  return -1;
}

/** Whether a label matches the find widget's text: a case-insensitive substring. */
export function findMatches(label: string, query: string): boolean {
  return !!query && label.toLowerCase().includes(query.toLowerCase());
}

/** The next (or previous) matching row from `active`, wrapping; -1 when none matches. */
export function nextMatch(
  labels: readonly string[],
  active: number,
  query: string,
  backwards = false,
): number {
  const n = labels.length;
  for (let i = 1; i <= n; i++) {
    const at = (((backwards ? active - i : active + i) % n) + n) % n;
    if (findMatches(labels[at] ?? "", query)) return at;
  }
  return -1;
}

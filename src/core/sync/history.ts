// Which snapshots a project keeps (D435). DOM-free.
//
// History is counted in days the project was worked on, not days on the calendar: the last
// `keepDays` days that have a snapshot are kept. Within the most recent such day every snapshot
// stays; of an earlier day, the last one of each computer (one computer's only copy of a day
// isn't removed because another computer made a snapshot later that day). A pinned snapshot is
// never removed and doesn't count: pinned under a name on a computer, or marked to keep from
// the account page (`staysPinned`).

export interface DatedSnapshot {
  id: string;
  /** When, in ms. */
  time: number;
  pinned: boolean;
  /** The computer that made it (its device id); absent: all count as one computer. */
  device?: string;
}

/**
 * Whether a snapshot is kept whatever its age: it has a name it was pinned under (in its
 * sealed record), or the service's "keep" mark, set from the account page. Either is enough.
 */
export function staysPinned(name: string | null | undefined, keep: boolean | undefined): boolean {
  return !!name || keep === true;
}

/** How many snapshots of a project the service's "keep" mark can exempt from history. */
export const KEEP_MARKS_HONOURED = 50;

/**
 * The snapshots whose "keep" mark counts: the newest `cap` of those marked. The mark is the
 * service's word, beside the record and not sealed, so it can't be allowed to switch history
 * off: marked on every snapshot, it would keep them all, for ever. Past the cap a marked
 * snapshot ages like any other. (A name it was pinned under is sealed content, and always
 * counts.)
 */
export function keepMarksHonoured(
  snapshots: readonly { id: string; time: number; keep?: boolean }[],
  cap = KEEP_MARKS_HONOURED,
): Set<string> {
  return new Set(
    snapshots
      .filter((s) => s.keep === true)
      .sort((a, b) => b.time - a.time)
      .slice(0, Math.max(0, cap))
      .map((s) => s.id),
  );
}

/** The day a time falls on, in the computer's own time zone ("2026-11-15"). */
export function dayOf(time: number): string {
  const d = new Date(time);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** The ids of the snapshots to remove. `keepDays` 0 or less keeps everything. */
export function planPrune(
  snapshots: readonly DatedSnapshot[],
  keepDays: number,
  day: (time: number) => string = dayOf,
): string[] {
  if (keepDays <= 0) return [];
  const unpinned = snapshots.filter((s) => !s.pinned).sort((a, b) => b.time - a.time);
  const days: string[] = [];
  /** Day and computer already kept. */
  const kept = new Set<string>();
  const remove: string[] = [];
  for (const snapshot of unpinned) {
    const on = day(snapshot.time);
    if (!days.includes(on)) days.push(on);
    const index = days.indexOf(on);
    const mark = `${on}
${snapshot.device ?? ""}`;
    const first = !kept.has(mark);
    kept.add(mark);
    // Older than the days kept.
    if (index >= keepDays) remove.push(snapshot.id);
    // An earlier day keeps only each computer's last snapshot (the first met, newest first).
    else if (index > 0 && !first) remove.push(snapshot.id);
  }
  return remove;
}

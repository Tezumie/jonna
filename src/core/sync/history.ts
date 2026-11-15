// Which snapshots a project keeps (D435). DOM-free.
//
// History is counted in days the project was worked on, not days on the calendar: the last
// `keepDays` days that have a snapshot are kept. Within the most recent such day every snapshot
// stays; of an earlier day, its last one. A pinned snapshot is never removed and doesn't count.

export interface DatedSnapshot {
  id: string;
  /** When, in ms. */
  time: number;
  pinned: boolean;
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
  const remove: string[] = [];
  for (const snapshot of unpinned) {
    const on = day(snapshot.time);
    const first = !days.includes(on);
    if (first) days.push(on);
    const index = days.indexOf(on);
    // Older than the days kept.
    if (index >= keepDays) remove.push(snapshot.id);
    // An earlier day keeps only its last snapshot (the first met, newest first).
    else if (index > 0 && !first) remove.push(snapshot.id);
  }
  return remove;
}

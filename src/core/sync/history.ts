// Which snapshots a project keeps (D435). DOM-free.
//
// History is counted in days the project was worked on, not days on the calendar: the last
// `keepDays` days that have a snapshot are kept. Within the most recent such day every snapshot
// stays; of an earlier day, the last one of each computer (one computer's only copy of a day
// isn't removed because another computer made a snapshot later that day). A pinned snapshot is
// never removed and doesn't count.

export interface DatedSnapshot {
  id: string;
  /** When, in ms. */
  time: number;
  pinned: boolean;
  /** The computer that made it (its device id); absent: all count as one computer. */
  device?: string;
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

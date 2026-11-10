// The Timeline (D196, like VS Code's): a file's local-history versions and the git commits that
// changed it, merged newest first and grouped by day. DOM-free and tested.

export interface LocalVersion {
  id: string;
  /** Milliseconds since the epoch. */
  timestamp: number;
  source: string;
}

export interface FileCommit {
  hash: string;
  author: string;
  /** Seconds since the epoch. */
  time: number;
  subject: string;
}

export type TimelineItem =
  | { kind: "local"; id: string; time: number; source: string }
  | { kind: "git"; id: string; time: number; subject: string; author: string };

export interface TimelineGroup {
  label: string;
  items: TimelineItem[];
}

/** Both lists as one, newest first (a commit and a save at the same moment: the save first). */
export function mergeTimeline(
  local: readonly LocalVersion[],
  commits: readonly FileCommit[],
): TimelineItem[] {
  const items: TimelineItem[] = [
    ...local.map((v) => ({
      kind: "local" as const,
      id: v.id,
      time: v.timestamp,
      source: v.source,
    })),
    ...commits.map((c) => ({
      kind: "git" as const,
      id: c.hash,
      time: c.time * 1000,
      subject: c.subject,
      author: c.author,
    })),
  ];
  return items.sort((a, b) => b.time - a.time || (a.kind === "local" ? -1 : 1));
}

const DAY = 86_400_000;

/** Today, Yesterday, Earlier this week, then by month ("March 2026"). `now` in local time. */
export function groupTimeline(items: readonly TimelineItem[], now = new Date()): TimelineGroup[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const label = (t: number): string => {
    if (t >= startOfToday) return "Today";
    if (t >= startOfToday - DAY) return "Yesterday";
    if (t >= startOfToday - 6 * DAY) return "Earlier this week";
    const d = new Date(t);
    return d.toLocaleString("en-US", { month: "long", year: "numeric" });
  };
  const groups: TimelineGroup[] = [];
  for (const item of items) {
    const l = label(item.time);
    const last = groups[groups.length - 1];
    if (last?.label === l) last.items.push(item);
    else groups.push({ label: l, items: [item] });
  }
  return groups;
}

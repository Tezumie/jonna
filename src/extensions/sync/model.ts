// Sync, DOM-free (D435): the words the Sync tab and the commands share.

export interface ActivityLike {
  state: "off" | "idle" | "syncing" | "offline" | "error" | "other";
  message: string | null;
  at: number | null;
}

/** "640 B", "12 KB", "1.2 GB": one decimal below ten of a unit. */
export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit > 0 && value < 10 ? 1 : 0;
  // "1.0 GB" reads as "1 GB".
  return `${value.toFixed(digits).replace(/\.0$/, "")} ${units[unit]}`;
}

/** "1.2 GB of 50 GB" (just the use when the account has no limit). */
export function storageText(used: number, limit: number): string {
  return limit > 0 ? `${formatSize(used)} of ${formatSize(limit)}` : formatSize(used);
}

/** How full the storage is, 0 to 1. */
export function storageShare(used: number, limit: number): number {
  return limit > 0 ? Math.min(1, Math.max(0, used / limit)) : 0;
}

/**
 * The status line's words. `time` (when there is one) is shown after `text` as a relative time
 * that stays current.
 */
export function activityLine(activity: ActivityLike): { text: string; time: number | null } {
  switch (activity.state) {
    case "syncing":
      return { text: "Syncing…", time: null };
    case "offline":
      return { text: "Offline: will retry", time: null };
    case "other":
      return { text: "Another window is syncing", time: null };
    case "error":
      return { text: activity.message ?? "Sync ran into a problem.", time: null };
    default:
      return activity.at === null
        ? { text: "Waiting for the first sync", time: null }
        : { text: "Synced", time: activity.at };
  }
}

/** A device's platform as a word ("windows" → "Windows"). */
export function platformLabel(platform: string): string {
  const known: Record<string, string> = {
    windows: "Windows",
    win32: "Windows",
    macos: "macOS",
    darwin: "macOS",
    linux: "Linux",
  };
  return known[platform.toLowerCase()] ?? platform;
}

/** "1 file", "3 files". */
export function countOf(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * A time the service gave, in ms: its times may be in seconds or in milliseconds, and a time in
 * seconds stays below this for the next thirty thousand years.
 */
export function serviceTime(time: number | null): number | null {
  if (time === null || !Number.isFinite(time) || time <= 0) return null;
  return time < 1e12 ? time * 1000 : time;
}

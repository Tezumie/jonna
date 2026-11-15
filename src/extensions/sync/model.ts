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

/** What leaves this computer sealed, and what the service can still see. */
export const PRIVACY_NOTE =
  "File contents, chats, settings and your own files are encrypted on this computer before they leave. The service can see project names, how many items there are, their sizes and dates, the names of your files (not their contents) and your computers' names.";

// ------------------------------------------------------------ what the account holds

/** A record as the overview reads it (the engine's records fit). */
export interface OverviewRecord {
  collection: string;
  id: string;
  deleted: boolean;
  text: string | null;
  device: string | null;
  updatedAt: number | null;
  info?: Record<string, string | number | boolean> | null;
}

export interface OverviewFile {
  path: string;
  bytes: number;
  updatedAt: number | null;
}

export interface OverviewProject {
  id: string;
  name: string;
  chats: number;
  snapshots: number;
  /** The size of the latest snapshot (snapshots share what didn't change, so they don't add up). */
  snapshotBytes: number;
  /** When something of the project last changed in the account, in ms. */
  lastChange: number | null;
  /** The computer that made that change, by name. */
  lastComputer: string | null;
  /** Whether a folder on this computer syncs as this project. */
  here: boolean;
  folder: string | null;
}

export interface SyncOverview {
  settings: { count: number; updatedAt: number | null } | null;
  files: OverviewFile[];
  /** Chats that belong to no folder. */
  accountChats: number;
  projects: OverviewProject[];
}

export const EMPTY_OVERVIEW: SyncOverview = {
  settings: null,
  files: [],
  accountChats: 0,
  projects: [],
};

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const str = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/** A record's sealed text as an object; {} when there is none or it isn't one. */
function parsed(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * What the account holds, from its records: the labels (`info`) first, the text only where a
 * record has no label (one written before labels, or by this computer a moment ago).
 * `devices` names the computers; `folders` are the folders that sync from this computer.
 */
export function buildOverview(
  records: readonly OverviewRecord[],
  devices: readonly { id: string; name: string }[],
  folders: readonly { id: string; path: string }[],
): SyncOverview {
  const computers = new Map(devices.map((d) => [d.id, d.name]));
  const overview: SyncOverview = { settings: null, files: [], accountChats: 0, projects: [] };
  const projects = new Map<string, OverviewProject & { named: boolean; latest: number }>();
  const project = (id: string) => {
    let entry = projects.get(id);
    if (!entry) {
      const folder = folders.find((f) => f.id === id);
      entry = {
        id,
        name: "",
        chats: 0,
        snapshots: 0,
        snapshotBytes: 0,
        lastChange: null,
        lastComputer: null,
        here: !!folder,
        folder: folder?.path ?? null,
        named: false,
        latest: 0,
      };
      projects.set(id, entry);
    }
    return entry;
  };
  const touched = (
    entry: OverviewProject,
    time: number | null,
    record: OverviewRecord,
    computer: string | null,
  ) => {
    if (time === null || (entry.lastChange !== null && time <= entry.lastChange)) return;
    entry.lastChange = time;
    entry.lastComputer = (record.device ? computers.get(record.device) : undefined) ?? computer;
  };

  for (const record of records) {
    if (record.deleted) continue;
    const info = record.info ?? {};
    const updatedAt = serviceTime(record.updatedAt);
    const { collection } = record;
    if (collection === "settings") {
      if (record.id !== "user") continue;
      let count = num(info.settings);
      if (count === null) {
        const keys = parsed(record.text).keys;
        count =
          keys && typeof keys === "object"
            ? Object.values(keys as Record<string, { d?: unknown } | null>).filter((k) => !k?.d)
                .length
            : 0;
      }
      overview.settings = { count, updatedAt };
    } else if (collection === "files") {
      const text = str(info.path) === null ? parsed(record.text) : {};
      const path = str(info.path) ?? str(text.path);
      if (path === null || info.deleted === true || text.deleted === true) continue;
      const body = typeof text.text === "string" ? text.text.length : 0;
      overview.files.push({ path, bytes: num(info.bytes) ?? body, updatedAt });
    } else if (collection === "projects") {
      const entry = project(record.id);
      entry.name = str(info.name) ?? str(parsed(record.text).name) ?? "";
      entry.named = true;
      touched(entry, updatedAt, record, null);
    } else if (collection.startsWith("chats.")) {
      // A chat deleted on another computer stays as a marker: not a chat any more.
      if (info.deleted === true) continue;
      if (record.info == null && parsed(record.text).deleted === true) continue;
      if (collection === "chats.account") {
        overview.accountChats++;
        continue;
      }
      const entry = project(collection.slice("chats.".length));
      entry.chats++;
      touched(entry, num(info.updated) ?? updatedAt, record, null);
    } else if (collection.startsWith("snap.")) {
      const entry = project(collection.slice("snap.".length));
      const summary = record.info == null ? parsed(record.text) : {};
      const time = num(info.time) ?? num(summary.time) ?? updatedAt;
      entry.snapshots++;
      if (time !== null && time >= entry.latest) {
        entry.latest = time;
        entry.snapshotBytes = num(info.bytes) ?? num(summary.bytes) ?? 0;
      }
      touched(entry, time, record, str(info.computer) ?? str(summary.deviceName));
    }
  }

  overview.files.sort((a, b) => a.path.localeCompare(b.path));
  overview.projects = [...projects.values()]
    .map(({ named: _named, latest: _latest, ...p }) => ({
      ...p,
      name: p.name || folderName(p.folder) || "Unnamed project",
    }))
    .sort((a, b) => Number(b.here) - Number(a.here) || a.name.localeCompare(b.name));
  return overview;
}

/** A folder's own name ("C:\\work\\site" → "site"). */
export function folderName(path: string | null): string {
  return path?.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
}

/** The kinds of the user's own files, in the order they are listed, with their words. */
export const FILE_KINDS: readonly (readonly [kind: string, label: string])[] = [
  ["keybindings", "Keyboard shortcuts"],
  ["rules", "Rules"],
  ["snippets", "Snippets"],
  ["agents", "Agents"],
  ["commands", "Commands"],
  ["outputStyles", "Output styles"],
  ["skills", "Skills"],
];

/** Which kind one of the user's files is, by its synced name (also its `sync.<kind>` setting). */
export function fileKind(path: string): string {
  if (path.startsWith("keybindings.")) return "keybindings";
  if (path.startsWith("AGENTS.")) return "rules";
  const folder = path.split("/")[0] ?? "";
  return folder === "output-styles" ? "outputStyles" : folder;
}

/** The user's files by kind, in the listed order; kinds without files are left out. */
export function groupFiles(
  files: readonly OverviewFile[],
): { kind: string; label: string; files: OverviewFile[] }[] {
  const groups = new Map<string, OverviewFile[]>();
  for (const file of files) {
    const kind = fileKind(file.path);
    const known = FILE_KINDS.some(([k]) => k === kind) ? kind : "other";
    groups.set(known, [...(groups.get(known) ?? []), file]);
  }
  return [...FILE_KINDS, ["other", "Other"] as const].flatMap(([kind, label]) => {
    const list = groups.get(kind);
    return list ? [{ kind, label, files: list }] : [];
  });
}

/** A project row's counts: "3 chats · 12 snapshots · latest snapshot 4 MB". */
export function projectCounts(project: OverviewProject): string {
  const parts = [countOf(project.chats, "chat"), countOf(project.snapshots, "snapshot")];
  if (project.snapshots > 0) parts.push(`latest snapshot ${formatSize(project.snapshotBytes)}`);
  return parts.join(" · ");
}

// ------------------------------------------------------------ storage, history, the status bar

/** What to say as storage fills: nothing below 80%, more from 95%. */
export function storageNotice(
  used: number,
  limit: number,
): { level: 80 | 95; text: string } | null {
  const share = storageShare(used, limit);
  const percent = Math.floor(share * 100);
  if (share >= 0.95)
    return {
      level: 95,
      text: `Storage is ${percent}% full. When it is full, new snapshots stop; settings and chats keep syncing.`,
    };
  if (share >= 0.8) return { level: 80, text: `Storage is ${percent}% full.` };
  return null;
}

/** How long snapshots are kept (`sync.historyDays`). */
export function retentionText(days: number): string {
  if (!(days > 0)) return "Keeps every snapshot";
  const whole = Math.max(1, Math.round(days));
  return whole === 1
    ? "Keeps the last day this project was worked on"
    : `Keeps the last ${whole} days this project was worked on`;
}

export interface StatusBarWords {
  /** With `$(icon)` for an icon. */
  text: string;
  tooltip: string;
  error: boolean;
}

/**
 * The status bar item: there only when sync is open to the account and on here (or waiting to
 * be approved). An icon and a short word; the rest is the tooltip.
 */
export function statusBarWords(
  available: boolean,
  state: string | null,
  activity: ActivityLike,
): StatusBarWords | null {
  if (!available) return null;
  if (state === "pending")
    return { text: "$(cloud) Waiting", tooltip: "Sync: waiting for approval", error: false };
  if (state !== "on") return null;
  switch (activity.state) {
    case "syncing":
      return { text: "$(refresh-cw) Syncing…", tooltip: "Sync: syncing…", error: false };
    case "offline":
      return { text: "$(cloud) Offline", tooltip: "Sync: offline, will retry", error: false };
    case "other":
      return { text: "$(cloud) Sync", tooltip: "Sync: another window is syncing", error: false };
    case "error":
      return {
        text: "$(circle-alert) Sync error",
        tooltip: `Sync: ${activity.message ?? "Sync ran into a problem."}`,
        error: true,
      };
    default:
      return activity.at === null
        ? { text: "$(cloud) Sync", tooltip: "Sync: waiting for the first sync", error: false }
        : { text: "$(cloud) Synced", tooltip: "Sync: everything is synced", error: false };
  }
}

// ------------------------------------------------------------ recent activity

export interface SyncEvent {
  at: number;
  text: string;
  error: boolean;
}

/** How many events the log keeps. */
export const LOG_LIMIT = 30;

/** The log with one more event, newest first; the same sentence twice in a row is said once. */
export function withEvent(log: readonly SyncEvent[], event: SyncEvent): SyncEvent[] {
  const [last, ...rest] = log;
  if (last && last.text === event.text && last.error === event.error)
    return [event, ...rest].slice(0, LOG_LIMIT);
  return [event, ...log].slice(0, LOG_LIMIT);
}

/** What a pass changed in the account, as a sentence; null when nothing did. */
export function passSentence(changed: number): string | null {
  return changed > 0 ? `Synced: ${countOf(changed, "item")} changed.` : null;
}

/** How many records differ between two readings of the account (by version). */
export function changedCount(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
): number {
  let changed = 0;
  for (const [key, version] of after) if (before.get(key) !== version) changed++;
  return changed;
}

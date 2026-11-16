// Sync, DOM-free (D435): the words the Sync tab and the commands share.
import { planPageUrl } from "../../core/ownServices";

export interface ActivityLike {
  state: "off" | "idle" | "syncing" | "offline" | "error" | "other" | "blocked" | "lapsed";
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
      return {
        text: /slow down/i.test(activity.message ?? "")
          ? "The service asked to slow down: will retry"
          : "Offline: will retry",
        time: null,
      };
    case "other":
      return { text: "Another window is syncing", time: null };
    case "blocked":
      return { text: "Waiting for this computer's keys to catch up", time: null };
    case "lapsed":
      return { text: "Sync ended: nothing syncs until you renew", time: null };
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
  /** Whether that computer is this one. */
  lastHere: boolean;
  /** Whether a folder on this computer syncs as this project. */
  here: boolean;
  folder: string | null;
  /** That folder isn't on this computer any more (moved or deleted). */
  folderMissing: boolean;
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
 * What the account holds, from its records: their sealed text, and the label (`info`) only
 * where a record's text isn't here.
 * `devices` names the computers; `folders` are the folders that sync from this computer.
 */
export function buildOverview(
  records: readonly OverviewRecord[],
  devices: readonly { id: string; name: string }[],
  folders: readonly { id: string; path: string; missing?: boolean }[],
  /** This computer's device id, to tell its own changes. */
  deviceId: string | null = null,
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
        lastHere: false,
        here: !!folder,
        folder: folder?.path ?? null,
        folderMissing: folder?.missing === true,
        named: false,
        latest: 0,
      };
      projects.set(id, entry);
    }
    return entry;
  };
  /** `device`: who made the change, from sealed content when it says (else the service's word). */
  const touched = (
    entry: OverviewProject,
    time: number | null,
    device: string | null,
    computer: string | null,
  ) => {
    if (time === null || (entry.lastChange !== null && time <= entry.lastChange)) return;
    entry.lastChange = time;
    entry.lastComputer = (device ? computers.get(device) : undefined) ?? computer;
    entry.lastHere = deviceId !== null && device === deviceId;
  };

  for (const record of records) {
    if (record.deleted) continue;
    // What is shown comes from the sealed text, which only the account's computers can write.
    // The label (`info`) is the service's to read and so to change: it stands in only for a
    // record whose text isn't here (not loaded, or not readable yet), and never decides that
    // something is deleted.
    const loaded = record.text !== null && record.text !== undefined;
    const sealed = parsed(record.text);
    const info = loaded ? {} : (record.info ?? {});
    const updatedAt = serviceTime(record.updatedAt);
    const { collection } = record;
    if (collection === "settings") {
      if (record.id !== "user") continue;
      const keys = sealed.keys;
      const count =
        keys && typeof keys === "object"
          ? Object.values(keys as Record<string, { d?: unknown } | null>).filter((k) => !k?.d)
              .length
          : (num(info.settings) ?? 0);
      overview.settings = { count, updatedAt };
    } else if (collection === "files") {
      const path = str(sealed.path) ?? str(info.path);
      if (path === null || sealed.deleted === true) continue;
      const bytes = typeof sealed.text === "string" ? sealed.text.length : (num(info.bytes) ?? 0);
      overview.files.push({ path, bytes, updatedAt });
    } else if (collection === "projects") {
      const entry = project(record.id);
      entry.name = str(sealed.name) ?? str(info.name) ?? "";
      entry.named = true;
      touched(entry, updatedAt, record.device, null);
    } else if (collection.startsWith("chats.")) {
      // A chat deleted on another computer stays as a sealed marker: not a chat any more.
      if (sealed.deleted === true) continue;
      if (collection === "chats.account") {
        overview.accountChats++;
        continue;
      }
      const entry = project(collection.slice("chats.".length));
      entry.chats++;
      const meta = sealed.meta as { updated?: unknown } | null | undefined;
      const changed = num(meta?.updated) ?? num(info.updated) ?? updatedAt;
      touched(entry, changed, record.device, null);
    } else if (collection.startsWith("snap.")) {
      const entry = project(collection.slice("snap.".length));
      const time = num(sealed.time) ?? num(info.time) ?? updatedAt;
      entry.snapshots++;
      if (time !== null && time >= entry.latest) {
        entry.latest = time;
        entry.snapshotBytes = num(sealed.bytes) ?? num(info.bytes) ?? 0;
      }
      touched(
        entry,
        time,
        str(sealed.device) ?? record.device,
        str(sealed.deviceName) ?? str(info.computer),
      );
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

/** A project's counts: "3 chats · 12 snapshots". */
export function projectCounts(project: { chats: number; snapshots: number }): string {
  return `${countOf(project.chats, "chat")} · ${countOf(project.snapshots, "snapshot")}`;
}

/**
 * A snapshot's size in words. A snapshot can hold no files at all (only commits or stashes
 * travelled): that is said, not "0 B".
 */
export function snapshotSize(bytes: number): string {
  return bytes > 0 ? formatSize(bytes) : "no changed files";
}

/** A snapshot's files and size: "3 files · 4 MB", or "no changed files" when it holds none. */
export function snapshotFacts(files: number, bytes: number, between = " · "): string {
  return files > 0 || bytes > 0
    ? `${countOf(files, "file")}${between}${formatSize(bytes)}`
    : "no changed files";
}

/**
 * Where a project last changed: "on this computer" when it was this one (whatever it is
 * called), else "on <name>"; "" when it isn't known.
 */
export function changedOn(project: { lastHere: boolean; lastComputer: string | null }): string {
  if (project.lastHere) return "on this computer";
  return project.lastComputer ? `on ${project.lastComputer}` : "";
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
  /** The subscription ended (`planSituation` says "lapsed"). */
  lapsed = false,
): StatusBarWords | null {
  if (!available) return null;
  if (state === "pending")
    return { text: "$(cloud) Waiting", tooltip: "Sync: waiting for approval", error: false };
  if (state !== "on") return null;
  // Said quietly: the Sync tab has the rest, and the way to renew.
  if (lapsed || activity.state === "lapsed")
    return {
      text: "$(cloud) Sync ended",
      tooltip: "Sync: your subscription ended. Nothing syncs until you renew it.",
      error: false,
    };
  switch (activity.state) {
    case "syncing":
      return { text: "$(refresh-cw) Syncing…", tooltip: "Sync: syncing…", error: false };
    case "offline":
      return { text: "$(cloud) Offline", tooltip: "Sync: offline, will retry", error: false };
    case "other":
      return { text: "$(cloud) Sync", tooltip: "Sync: another window is syncing", error: false };
    case "blocked":
      return {
        text: "$(cloud) Waiting",
        tooltip: "Sync: waiting for this computer's keys to catch up",
        error: false,
      };
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

// ------------------------------------------------------------ the plan (the subscription)

/** What the plan needs of the account's profile (`AccountProfile` fits). */
export interface PlanProfile {
  sync?: boolean;
  syncState?: "on" | "lapsed" | "off" | null;
  syncUntil?: number | null;
  syncOffered?: boolean;
}

/** What the plan needs of where sync stands (`SyncStatus` fits). */
export interface PlanStatus {
  state: string;
  lapsedUntil?: number | null;
}

/**
 * Where the account stands with the subscription. "none": nothing to say about sync (signed
 * out, or sync is neither had nor on sale). "offered": it could buy sync. "lapsed": its
 * subscription ended; what is synced can be read, nothing written. "on": it has sync.
 */
export type PlanSituation = "none" | "offered" | "lapsed" | "on";

/** Whether a status was read from the sync service itself (not "nobody" or "not for you"). */
const statusKnown = (status: PlanStatus | null): status is PlanStatus =>
  !!status && status.state !== "signedOut" && status.state !== "unavailable";

/**
 * Which situation a profile and a status are. The sync service's own word on "lapsed" counts
 * once it was read (it is asked more often than the profile); before that, the profile's.
 */
export function planSituation(
  profile: PlanProfile | null,
  status: PlanStatus | null,
): PlanSituation {
  if (!profile) return "none";
  if (profile.sync !== true || status?.state === "unavailable")
    return profile.syncOffered === true ? "offered" : "none";
  const lapsed = statusKnown(status)
    ? typeof status.lapsedUntil === "number"
    : profile.syncState === "lapsed";
  return lapsed ? "lapsed" : "on";
}

/** When what is synced is deleted, in ms, for a lapsed account; null when it isn't known. */
export function lapsedUntil(profile: PlanProfile | null, status: PlanStatus | null): number | null {
  const fromStatus = statusKnown(status) ? serviceTime(status.lapsedUntil ?? null) : null;
  return fromStatus ?? serviceTime(profile?.syncUntil ?? null);
}

/** A date as the lapsed callout says it: "3 March", with the year when it isn't this one. */
export function retentionDate(time: number, now = Date.now()): string {
  const day = new Date(time);
  return day.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    ...(day.getFullYear() !== new Date(now).getFullYear() && { year: "numeric" }),
  });
}

/** What a lapsed account is told, with the date what is synced is deleted when it is known. */
export function lapsedSentence(until: number | null, now = Date.now()): string {
  const kept =
    until === null
      ? "What is synced stays readable for a while, then it is deleted."
      : until <= now
        ? "What is synced is about to be deleted."
        : `What is synced stays readable until ${retentionDate(until, now)}, then it is deleted.`;
  return `Your Sync subscription ended. ${kept} Your computers keep their own files and chats.`;
}

/** The pass's sentence while lapsed (the activity's message, and said once in the log). */
export const LAPSED_ACTIVITY = "Your Sync subscription ended. Nothing syncs until you renew it.";

/** Why something that writes to the account can't be done while lapsed. */
export const LAPSED_REASON = "Your Sync subscription ended. Renew it to do this.";

/** What Sync does, in three short lines (the offer, and before sync is turned on). */
export const SYNC_BENEFITS: readonly string[] = [
  "Your settings, keyboard shortcuts, and your own rules, skills and agents.",
  "The chats of the projects you choose to sync.",
  "Snapshots of unfinished work in those projects, with a history.",
];

/**
 * The account page's plan section (buying, renewing, cards, invoices, storage): the page
 * product.json names (`planPagePath`, docs/own-services.md), on the accounts server `base`.
 */
export function planUrl(base: string): string {
  return planPageUrl(base);
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

// ------------------------------------------------------------ the tab's pages

/** The Sync tab's pages, in the navigation's order. */
export const SYNC_PAGES = [
  {
    id: "overview",
    title: "Overview",
    lead: "Whether sync is working, and what is in your account.",
  },
  {
    id: "projects",
    title: "Projects",
    lead: "The folders whose chats and unfinished work travel with you.",
  },
  {
    id: "content",
    title: "Settings and files",
    lead: "What this computer sends and takes, and what the account holds of it.",
  },
  {
    id: "computers",
    title: "Computers",
    lead: "The computers that can read what you sync.",
  },
  {
    id: "security",
    title: "Security and privacy",
    lead: "Your recovery key, and what the service can and can't see.",
  },
  {
    id: "storage",
    title: "Storage",
    lead: "How much the account holds, and how long snapshots are kept.",
  },
  {
    id: "activity",
    title: "Activity",
    lead: "What sync did lately, as seen from this window.",
  },
] as const;

export type SyncPageId = (typeof SYNC_PAGES)[number]["id"];

export const SYNC_PAGE_IDS = [
  "overview",
  "projects",
  "content",
  "computers",
  "security",
  "storage",
  "activity",
] as const satisfies readonly SyncPageId[];

export function isSyncPage(value: unknown): value is SyncPageId {
  return typeof value === "string" && (SYNC_PAGE_IDS as readonly string[]).includes(value);
}

/** The page a key moves to in the navigation (the arrows, Home, End); null for other keys. */
export function pageByKey(current: SyncPageId, key: string): SyncPageId | null {
  const at = SYNC_PAGE_IDS.indexOf(current);
  const last = SYNC_PAGE_IDS.length - 1;
  const to =
    key === "ArrowDown" || key === "ArrowRight"
      ? Math.min(last, at + 1)
      : key === "ArrowUp" || key === "ArrowLeft"
        ? Math.max(0, at - 1)
        : key === "Home"
          ? 0
          : key === "End"
            ? last
            : -1;
  return SYNC_PAGE_IDS[to] ?? null;
}

/** The privacy line as two lists (Security and privacy). */
export const SERVICE_CAN_SEE: readonly string[] = [
  "Project names",
  "How many items there are, their sizes and dates",
  "The names of your files",
  "Your computers' names",
];
export const SERVICE_CANT_READ: readonly string[] = [
  "File contents",
  "Chats",
  "Settings",
  "What is in your own files",
];

export interface OverviewTile {
  page: SyncPageId;
  label: string;
  /** The number, large. */
  value: string;
}

/** The overview's tiles: a number and what it counts; each opens its page. */
export function overviewTiles(
  overview: SyncOverview,
  devices: readonly { status: string }[],
): OverviewTile[] {
  const sum = (pick: (p: OverviewProject) => number) =>
    overview.projects.reduce((total, p) => total + pick(p), 0);
  const computers = devices.filter((d) => d.status === "approved").length;
  const chats = overview.accountChats + sum((p) => p.chats);
  const snapshots = sum((p) => p.snapshots);
  return [
    {
      page: "projects",
      label: overview.projects.length === 1 ? "Project" : "Projects",
      value: String(overview.projects.length),
    },
    { page: "content", label: chats === 1 ? "Chat" : "Chats", value: String(chats) },
    {
      page: "projects",
      label: snapshots === 1 ? "Snapshot" : "Snapshots",
      value: String(snapshots),
    },
    {
      page: "computers",
      label: computers === 1 ? "Computer" : "Computers",
      value: String(computers),
    },
  ];
}

export interface AttentionItem {
  kind: "device" | "storage" | "error" | "project";
  text: string;
  /** The one thing to do about it: the button's words. */
  action: string;
  /** Where the button goes, */
  page?: SyncPageId;
  /** or the command it runs. */
  command?: string;
}

/** What needs the person, most pressing first; empty when nothing does. */
export function attentionItems(input: {
  /** Computers waiting to join. */
  waiting: readonly { name: string }[];
  usage: number;
  limit: number;
  activity: ActivityLike;
  /** The open folder, when one is open on this computer. */
  project: { name: string; on: boolean } | null;
  /** The subscription ended: what would need a write isn't asked for. */
  lapsed?: boolean;
}): AttentionItem[] {
  const items: AttentionItem[] = [];
  // The lapsed callout says what there is to do; nothing else can be done about the rest.
  if (input.lapsed) return items;
  if (input.activity.state === "error")
    items.push({
      kind: "error",
      text: input.activity.message ?? "Sync ran into a problem.",
      action: "Retry",
      command: "sync.syncNow",
    });
  for (const device of input.waiting)
    items.push({
      kind: "device",
      text: `${device.name} wants to join. Check its code before you approve it.`,
      action: "Review",
      page: "computers",
    });
  const storage = storageNotice(input.usage, input.limit);
  if (storage)
    items.push({ kind: "storage", text: storage.text, action: "Open storage", page: "storage" });
  if (input.project && !input.project.on)
    items.push({
      kind: "project",
      text: `${input.project.name || "This folder"} isn't synced yet.`,
      action: "Open projects",
      page: "projects",
    });
  return items;
}

/** Projects by the size of their latest snapshot, largest first; those without one left out. */
export function storageByProject(
  overview: SyncOverview,
): { id: string; name: string; bytes: number; snapshots: number }[] {
  return overview.projects
    .filter((p) => p.snapshots > 0)
    .map((p) => ({ id: p.id, name: p.name, bytes: p.snapshotBytes, snapshots: p.snapshots }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
}

/**
 * What the account holds of one kind that syncs (`key`: its `sync.<kind>` setting), in a few
 * words, beside its switch.
 */
export function heldSummary(key: string, overview: SyncOverview): string {
  const kind = key.replace(/^sync\./, "");
  if (kind === "settings")
    return overview.settings ? countOf(overview.settings.count, "setting") : "Nothing yet";
  if (kind === "chats") {
    const inProjects = overview.projects.reduce((total, p) => total + p.chats, 0);
    return overview.accountChats + inProjects === 0
      ? "Nothing yet"
      : `${overview.accountChats} without a folder · ${inProjects} in projects`;
  }
  if (kind === "snapshots") {
    const withSome = overview.projects.filter((p) => p.snapshots > 0);
    const total = withSome.reduce((sum, p) => sum + p.snapshots, 0);
    return total === 0
      ? "Nothing yet"
      : `${countOf(total, "snapshot")} in ${countOf(withSome.length, "project")}`;
  }
  const files = overview.files.filter((f) => fileKind(f.path) === kind).length;
  return files === 0 ? "Nothing yet" : countOf(files, "file");
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** A day as a heading: Today, Yesterday, or the date (with the year when it isn't this one). */
export function dayLabel(time: number, now = Date.now()): string {
  const day = new Date(time);
  const today = new Date(now);
  if (sameDay(day, today)) return "Today";
  if (sameDay(day, new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)))
    return "Yesterday";
  return day.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    ...(day.getFullYear() !== today.getFullYear() && { year: "numeric" }),
  });
}

/** Rows under their day's heading, in the order given (newest first stays newest first). */
export function groupByDay<T>(
  rows: readonly T[],
  timeOf: (row: T) => number,
  now = Date.now(),
): { label: string; rows: T[] }[] {
  const groups: { label: string; rows: T[] }[] = [];
  for (const row of rows) {
    const label = dayLabel(timeOf(row), now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.rows.push(row);
    else groups.push({ label, rows: [row] });
  }
  return groups;
}

/** A time of day for a row under a day's heading ("14:05" or "2:05 PM", as the system has it). */
export function timeOfDay(time: number): string {
  return new Date(time).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// ------------------------------------------------------------ the loop's timing

/** How long to wait after passes that failed in a row for want of a connection: 1, 2, 5, 10 min. */
export function backoffMs(failures: number): number {
  const minutes = [1, 2, 5, 10];
  const at = Math.min(Math.max(1, Math.floor(failures)), minutes.length) - 1;
  return (minutes[at] ?? 10) * 60_000;
}

/**
 * How long to leave before looking again for something to snapshot, given how long the look
 * that found nothing took: at least `least`, and forty times the look, so walking a huge
 * folder takes a small share of the time.
 */
export function snapshotSpacing(tookMs: number, least: number): number {
  return Math.max(least, 40 * Math.max(0, tookMs));
}

// ------------------------------------------------------------ before a large first snapshot

/** As `syncIpc.snapshotEstimate` gives it. */
export interface EstimateLike {
  kind: "git" | "folder";
  files: number;
  bytes: number;
  tooLarge: number;
  largest: [string, number, number][];
  truncated: boolean;
}

/** A folder without git this large (or larger than a snapshot holds) is asked about first. */
export const LARGE_FILES = 2_000;
export const LARGE_BYTES = 200 * 1024 * 1024;

/**
 * What to say before syncing a large folder that has no git: its numbers, its largest parts,
 * what is left out. Null when there is nothing to ask (a git project sends only what differs
 * from its commit; a small folder just syncs).
 */
export function estimateWarning(estimate: EstimateLike): string | null {
  if (estimate.kind !== "folder") return null;
  const large =
    estimate.truncated || estimate.files >= LARGE_FILES || estimate.bytes >= LARGE_BYTES;
  if (!large) return null;
  const lines = [
    `This folder has no git, so a snapshot holds every file: ${countOf(estimate.files, "file")}, ${formatSize(estimate.bytes)}.`,
  ];
  const largest = estimate.largest.slice(0, 5);
  if (largest.length > 0)
    lines.push(
      `The largest:\n${largest.map(([name, bytes, files]) => `${name}  ${formatSize(bytes)}${files > 1 ? ` (${countOf(files, "file")})` : ""}`).join("\n")}`,
    );
  if (estimate.truncated)
    lines.push("That is more files than a snapshot holds: the rest would be left out.");
  if (estimate.tooLarge > 0)
    lines.push(`Files over 100 MB are left out (${countOf(estimate.tooLarge, "file")} here).`);
  lines.push("You can choose what to leave out first, as in a .gitignore file.");
  return lines.join("\n\n");
}

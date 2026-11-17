// Sync as the app runs it (D435): where it stands, the loop's passes, the open project and its
// snapshots. No view code: the Sync view and the commands both go through this.

import { agentStoreIpc } from "../../core/ipc/agent";
import { fsIpc } from "../../core/ipc/fs";
import {
  onSyncFailure,
  type SnapshotCreated,
  type SnapshotEstimate,
  type SnapshotFile,
  type SnapshotRestored,
  type SnapshotSummary,
  type SyncRecord,
  type SyncStatus,
  syncIpc,
} from "../../core/ipc/sync";
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import { accountsServer } from "../../core/ownServices";
import { product } from "../../core/product";
import { type Signal, signal } from "../../core/reactive/index";
import { parseJsonc } from "../../core/settings/jsonc";
import { isLanguageOverrideKey } from "../../core/settings/languageOverrides";
import { type SyncBackend, SyncEngine, type SyncLayer } from "../../core/sync/engine";
import { codeOf, isFull, isRateLimited, messageOf, STANDING_CODES } from "../../core/sync/errors";
import { keepMarksHonoured, planPrune, staysPinned } from "../../core/sync/history";
import {
  type IncomingItem,
  incomingItems,
  incomingNotice,
  incomingRevision,
  pathsToAccept,
} from "../../core/sync/incoming";
import {
  type ChatsPort,
  chatsLayer,
  type FilesPort,
  filesLayer,
  type SettingsPort,
  settingsLayer,
} from "../../core/sync/layers";
import { entrySyncs, type SyncSettingsFilter, settingSyncs } from "../../core/sync/localSettings";
import { ONLY_VERIFIED_SETTING } from "../../core/team/shares";
import type { WorkbenchServices } from "../../workbench/services";
import { wentOffWords } from "./kept";
import {
  backoffMs,
  buildOverview,
  changedCount,
  countOf,
  EMPTY_OVERVIEW,
  folderName,
  LAPSED_ACTIVITY,
  passSentence,
  type SyncEvent,
  type SyncOverview,
  type SyncPageId,
  snapshotFacts,
  snapshotSpacing,
  storageNotice,
  withEvent,
} from "./model";
import { ProjectSharing } from "./sharing";

/** How often a pass runs while the app is open. */
const PASS_MS = 60_000;
/**
 * A computer waiting to be approved asks this often, for a while: its answer to the approving
 * computer's check (and then the approval) shouldn't take a minute to show.
 */
const WAITING_MS = 4_000;
const WAITING_FOR_MS = 15 * 60_000;
/** How long a status read stays good. */
const STATUS_MS = 5 * 60_000;
/** A snapshot at most this often. */
const SNAPSHOT_MS = 3 * 60_000;
/** The longest a closing window waits for its last snapshot. */
const CLOSE_SNAPSHOT_MS = 4_000;
/** A project's missing name is written again at most this often. */
const NAME_RETRY_MS = 10 * 60_000;
/** The claim on the loop is renewed this often while a pass runs. */
const LEASE_RENEW_MS = 30_000;
/** Whether the folders that sync still exist is looked at this often. */
const FOLDERS_CHECK_MS = 10 * 60_000;
/** After "Check code": how often the status is asked for, and for how long at most. */
const REVIEW_POLL_MS = 2_000;
const REVIEW_POLL_FOR_MS = 3 * 60_000;

const KEYS_WAIT = "Waiting for this computer's keys to catch up";
const FULL_ACTIVITY =
  "Storage is full: nothing new is sent to the account until there is room. What it holds still arrives here.";

export interface SyncActivity {
  /**
   * "other": another window of this profile runs the loop. "blocked": the account holds
   * something sealed with keys this computer doesn't have yet; nothing syncs until it does.
   * "lapsed": the account's subscription ended; the account is read, nothing is written.
   */
  state: "off" | "idle" | "syncing" | "offline" | "error" | "other" | "blocked" | "lapsed";
  message: string | null;
  /** When the last pass finished well, in ms. */
  at: number | null;
}

export interface SyncProject {
  root: string;
  /** Null until the project has an identity (a git remote, or sync turned on for it). */
  id: string | null;
  kind: "file" | "remote" | null;
  /** Whether this project syncs from this computer. */
  on: boolean;
  /** Whether another computer of the account syncs it already. */
  known: boolean;
}

export interface SnapshotRow {
  id: string;
  version: number;
  summary: SnapshotSummary;
  /** Marked to keep from the account page: pinned there, whatever its name here. */
  keep: boolean;
}

/** A folder as a key: one spelling per folder (Windows paths don't tell case apart). */
const pathKey = (path: string) => {
  const plain = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(plain) || plain.startsWith("//") ? plain.toLowerCase() : plain;
};

/** A folder that syncs from this computer: its project, and the folder as it is spelled here. */
interface SyncedFolder {
  id: string;
  path: string;
  /** The snapshot this folder was last brought to. */
  restored?: string;
}

export class SyncController implements Disposable {
  /** Null until first read. */
  readonly status: Signal<SyncStatus | null> = signal<SyncStatus | null>(null);
  readonly activity: Signal<SyncActivity> = signal<SyncActivity>({
    state: "off",
    message: null,
    at: null,
  });
  readonly project: Signal<SyncProject | null> = signal<SyncProject | null>(null);
  /** The open project's snapshots, newest first. */
  readonly snapshots: Signal<SnapshotRow[]> = signal<SnapshotRow[]>([]);
  /** What the account holds, as last read: recomputed after each pass. No content. */
  readonly overview: Signal<SyncOverview> = signal<SyncOverview>(EMPTY_OVERVIEW);
  /** What sync did lately, newest first. Kept in memory only. */
  readonly log: Signal<SyncEvent[]> = signal<SyncEvent[]>([]);
  /**
   * What another of the account's computers synced here and the person hasn't accepted on
   * this one (`core/sync/incoming.ts`): read after each pass and when the tab asks.
   */
  readonly incoming: Signal<IncomingItem[]> = signal<IncomingItem[]>([]);
  /**
   * Waiting computers whose code was asked for and hasn't come yet (device ids): the waiting
   * computer answers a moment later, and the status is asked for until it has.
   */
  readonly reviewing: Signal<string[]> = signal<string[]>([]);
  /** Sharing synced projects with the account's team (sharing.ts); idle in a build without teams. */
  readonly sharing: ProjectSharing;

  private readonly store = new DisposableStore();
  private readonly engine: SyncEngine;
  private readonly owner = `w-${Math.random().toString(36).slice(2, 10)}`;
  private leader = false;
  /** A renewal of the claim came back "no": the pass ends after the action under way. */
  private leaseLost = false;
  private statusAt = 0;
  /** How often the status was read (to tell "since the last read"). */
  private statusReads = 0;
  /** The status read during which the service refused a write for want of room (-1: none). */
  private refusedAtRead = -1;
  /** Whether "storage is full" was said in the log since the account last had room. */
  private fullSaid = false;
  private snapshotAt = 0;
  /** How long to leave between two looks for something to snapshot. */
  private snapshotGap = SNAPSHOT_MS;
  /** Snapshot calls run one after the other, never two at once. */
  private snapshotQueue: Promise<unknown> = Promise.resolve();
  /** Passes that failed in a row for want of a connection (or on the service's "slow down"). */
  private failures = 0;
  /** The timer starts no pass before this. */
  private nextPassAt = 0;
  private foldersAt = 0;
  /** Folders that sync from here and aren't on this computer any more (folder keys). */
  private missingFolders = new Set<string>();
  private reviewTimer: ReturnType<typeof setInterval> | undefined;
  private reviewUntil = 0;
  private passing: Promise<void> | null = null;
  private disposed = false;
  /** The fullest storage a notification was shown for, this run (0, 80 or 95). */
  private storageWarned = 0;
  /** The waiting computers a notification was shown for, this run (ids). */
  private readonly announced = new Set<string>();
  /** When each project's missing name was last written (project id to ms). */
  private readonly namedAt = new Map<string, number>();
  /** The "keep" marks this window set (snapshot id to the mark), until the account says so too. */
  private readonly keepSet = new Map<string, boolean>();
  /** Chats this window is writing (ids), given by the agent's own state. */
  private busyChats: () => ReadonlySet<string> = () => new Set();

  constructor(private readonly services: WorkbenchServices) {
    this.sharing = this.store.add(
      new ProjectSharing({
        base: () => this.base(),
        on: () => this.status.peek()?.state === "on",
        lapsed: () => this.isLapsed(),
        project: () => {
          const open = this.project.peek();
          if (!open?.on || !open.id) return null;
          const { id, root } = open;
          const known = this.overview.peek().projects.find((entry) => entry.id === id)?.name;
          return { root, id, name: known?.trim() || folderName(root) };
        },
        onlyVerified: () => this.services.settings.peek<boolean>(ONLY_VERIFIED_SETTING) === true,
        afterSnapshots: (work) => this.afterSnapshots(work),
        note: (text, failure) => this.note(text, failure),
      }),
    );
    const backend: SyncBackend = {
      changes: (since) => syncIpc.changes(this.base(), since),
      put: (collection, id, expect, text, info) =>
        syncIpc.put(this.base(), collection, id, expect, text, info ?? null),
    };
    const led = (layer: SyncLayer, on: () => boolean = () => true): SyncLayer => {
      // Only the window that holds the claim writes; the others just read the account. A
      // layer switched off doesn't run at all: what it kept of its last sync stays as it is.
      // Nor does any while the subscription is ended: a layer writes.
      const runs = () => this.leader && !this.isLapsed() && on();
      const observe = layer.observe?.bind(layer);
      return {
        name: layer.name,
        ...(observe && { observe: (ctx) => (runs() ? observe(ctx) : Promise.resolve()) }),
        run: (ctx) => (runs() ? layer.run(ctx) : Promise.resolve()),
      };
    };
    this.engine = new SyncEngine(
      backend,
      {
        load: () => syncIpc.stateLoad(),
        // Only the window that runs the loop keeps its state: another's copy is older.
        save: (text) => (this.leader ? syncIpc.stateSave(text) : Promise.resolve()),
      },
      [
        led(settingsLayer(this.settingsPort())),
        led(filesLayer(this.filesPort())),
        led(chatsLayer(this.chatsPort()), () => this.on("chats")),
      ],
      {
        // What the layers report: a conflict kept aside, one item that couldn't sync.
        note: (event) => this.note(event.text, event.kind === "failure"),
        stopped: () => this.leaseLost || this.disposed,
        full: () => this.storageFull(),
      },
    );
    const timer = setInterval(() => {
      // Held back after failures (no connection, the service asking to slow down).
      if (Date.now() >= this.nextPassAt) void this.pass();
    }, PASS_MS);
    this.store.add({ dispose: () => clearInterval(timer) });
    let waitingSince = 0;
    const waiting = setInterval(() => {
      if (this.status.peek()?.state !== "pending") {
        waitingSince = 0;
        return;
      }
      waitingSince ||= Date.now();
      // After a while the minute's pass is enough: nobody is at the other computer.
      if (Date.now() - waitingSince < WAITING_FOR_MS && Date.now() >= this.nextPassAt) {
        void this.pass();
      }
    }, WAITING_MS);
    this.store.add({ dispose: () => clearInterval(waiting) });
    // A write refused because the subscription ended, whichever call met it: where things
    // stand is read again (a pass that is running does that itself).
    this.store.add(
      onSyncFailure((code) => {
        if (code !== "SyncLapsed" || this.disposed || this.passing || this.isLapsed()) return;
        void this.refreshStatus().catch(() => null);
      }),
    );
  }

  /**
   * Whether the account's subscription ended while sync is on here: what is synced can be read
   * (snapshots listed and restored), and nothing is written until it is renewed.
   */
  isLapsed(): boolean {
    const status = this.status.peek();
    return status?.state === "on" && typeof status.lapsedUntil === "number";
  }

  /**
   * Whether the account has no room, as far as this computer knows: its usage is at its limit,
   * or the service refused a write for want of room and the status wasn't read again since.
   * Nothing new is sent meanwhile (no chat sealed and posted every minute only to be refused,
   * no snapshot); what the account holds is still read and still arrives here.
   */
  private storageFull(): boolean {
    const status = this.status.peek();
    if (status?.state !== "on") return false;
    if (status.storageLimit > 0 && status.usageBytes >= status.storageLimit) return true;
    return this.refusedAtRead === this.statusReads;
  }

  /** The service refused a write for want of room: held until the status is read again. */
  private noteRefused(): void {
    this.refusedAtRead = this.statusReads;
    // Read again at the next pass: it says whether there is room by then.
    this.statusAt = 0;
  }

  /** Says that the account is full: as the activity, and once in the log until it has room. */
  private showFull(at: number | null): void {
    this.activity.value = { state: "error", message: FULL_ACTIVITY, at };
    if (this.fullSaid) return;
    this.fullSaid = true;
    this.note(FULL_ACTIVITY, true);
  }

  /** Whether a pass is running now. */
  busy(): boolean {
    return this.passing !== null;
  }

  /**
   * Reads where sync stands again and passes, after the pass under way (which may have read
   * the status before whatever changed).
   */
  async recheck(): Promise<void> {
    if (this.passing) await this.passing.catch(() => {});
    await this.pass(true);
  }

  /** Says that the subscription ended: as the activity, and once in the log. */
  private showLapsed(): void {
    const now = this.activity.peek();
    if (now.state === "lapsed") return;
    this.activity.value = { state: "lapsed", message: LAPSED_ACTIVITY, at: now.at };
    this.note(LAPSED_ACTIVITY);
  }

  /** The accounts server ("" when the build has none). */
  base(): string {
    return accountsServer(this.services.settings.peek<string | undefined>("accounts.serverUrl"));
  }

  private on(key: string): boolean {
    return this.services.settings.peek<boolean | undefined>(`sync.${key}`) !== false;
  }

  /** The folders that sync from this computer, by folder key. */
  private projects(): Record<string, SyncedFolder> {
    const value = this.services.settings.peek<unknown>("sync.projects");
    const out: Record<string, SyncedFolder> = {};
    if (!value || typeof value !== "object") return out;
    for (const [folder, entry] of Object.entries(value as Record<string, unknown>)) {
      const e = entry as Partial<SyncedFolder> | null;
      if (e && typeof e.id === "string" && typeof e.path === "string") {
        out[folder] = {
          id: e.id,
          path: e.path,
          ...(typeof e.restored === "string" && { restored: e.restored }),
        };
      }
    }
    return out;
  }

  // ------------------------------------------------------------ the ports

  private settingsPort(): SettingsPort {
    const { settings } = this.services;
    const listed = (key: string): ReadonlySet<string> => {
      const value = settings.peek<unknown>(key);
      return new Set(Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);
    };
    const filter = (): SyncSettingsFilter => ({
      known: (key) => settings.registry.get(key) !== undefined,
      extra: listed("sync.extraSettings"),
      ignored: listed("sync.ignoredSettings"),
    });
    return {
      read: async () => {
        if (!this.on("settings")) return null;
        const file = settings.filePath("user");
        if (!file) return null;
        try {
          const [bytes, stat] = await Promise.all([fsIpc.read(file), fsIpc.stat(file)]);
          const parsed = parseJsonc(new TextDecoder().decode(bytes));
          // A file with a syntax error is being fixed by its owner: left alone.
          if (!parsed.ok) return null;
          const values = parsed.value;
          if (!values || typeof values !== "object" || Array.isArray(values)) return null;
          return { values: values as Record<string, unknown>, mtimeMs: stat.mtimeMs };
        } catch (err) {
          // No settings file: no opinion (not "every setting removed").
          if (codeOf(err) === "NotFound") return { values: {}, mtimeMs: 0, missing: true };
          return null;
        }
      },
      apply: async (edits) => {
        const values: Record<string, unknown> = {};
        for (const { key, value } of edits) values[key] = value;
        await settings.updateMany(values, "user");
      },
      // Settings that run programs, point somewhere, loosen a protection or that this computer
      // doesn't know never travel, in either direction (core/sync/localSettings.ts).
      skip: (key) => !isLanguageOverrideKey(key) && !settingSyncs(key, filter()),
      skipEntry: (key, value) => !entrySyncs(key, value, filter()),
      now: () => Date.now(),
    };
  }

  private filesPort(): FilesPort {
    const kind = (path: string): string => {
      if (path.startsWith("keybindings.")) return "keybindings";
      if (path.startsWith("AGENTS.")) return "rules";
      const folder = path.split("/")[0] ?? "";
      return folder === "output-styles" ? "outputStyles" : folder;
    };
    return {
      scan: () => syncIpc.userFiles(),
      read: (path) => syncIpc.userFileRead(path),
      write: (path, text) => syncIpc.userFileWrite(path, text),
      include: (path) => this.on(kind(path)),
      now: () => Date.now(),
    };
  }

  private chatsPort(): ChatsPort {
    const collectionOf = (workspace: string | null): string | null => {
      if (!this.on("chats")) return null;
      if (workspace === null) return "chats.account";
      const folder = this.projects()[pathKey(workspace)];
      return folder ? `chats.${folder.id}` : null;
    };
    return {
      list: async () => {
        const chats = await agentStoreIpc.list();
        const stamps = await agentStoreIpc.stamps(chats.map((c) => c.id));
        return chats.flatMap((chat, i) => {
          const stamp = stamps[i];
          if (!stamp) return [];
          const meta = (chat.meta ?? {}) as { workspace?: unknown; updated?: unknown };
          return [
            {
              id: chat.id,
              workspace: typeof meta.workspace === "string" ? meta.workspace : null,
              stamp,
              updated: typeof meta.updated === "number" ? meta.updated : 0,
            },
          ];
        });
      },
      collectionOf,
      folderOf: (collection) => {
        if (collection === "chats.account") return null;
        const id = collection.slice("chats.".length);
        // The folder as it is spelled here: the open one, else as it was when turned on.
        const open = this.project.peek();
        if (open?.on && open.id === id) return open.root;
        for (const folder of Object.values(this.projects())) {
          if (folder.id === id) return folder.path;
        }
        return undefined;
      },
      push: (collection, id, expect) => syncIpc.chatPush(this.base(), collection, id, expect),
      pull: (collection, id, saveAs, workspace, ifStamp) =>
        syncIpc.chatPull(this.base(), collection, id, saveAs, workspace, ifStamp),
      deleted: () => syncIpc.chatsDeleted(),
      clearDeleted: (ids) => syncIpc.chatsDeletedClear(ids),
      remove: (id) => agentStoreIpc.delete(id),
      stamp: async (id) => (await agentStoreIpc.stamps([id]))[0] ?? null,
      newId: () => `s-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      busy: (id) => this.busyChats().has(id),
      same: (collection, id) => syncIpc.chatSame(this.base(), collection, id).catch(() => false),
    };
  }

  // ------------------------------------------------------------ the overview and the log

  /** Adds a sentence to the recent activity. */
  note(text: string, error = false): void {
    this.log.value = withEvent(this.log.peek(), { at: Date.now(), text, error });
  }

  /** Reads what the account holds again, from the records as last read. */
  private readOverview(): void {
    const status = this.status.peek();
    const next =
      status?.state === "on"
        ? buildOverview(
            this.engine.allRecords(),
            status.devices,
            Object.entries(this.projects()).map(([folder, entry]) => ({
              id: entry.id,
              path: entry.path,
              missing: this.missingFolders.has(folder),
            })),
            status.deviceId,
          )
        : EMPTY_OVERVIEW;
    if (JSON.stringify(next) !== JSON.stringify(this.overview.peek())) this.overview.value = next;
  }

  /**
   * The open project's entry in the account gets its name when it has none the service can
   * read (made before names were labels, or its write failed): the account page lists
   * projects by that label. Tried again at most every ten minutes.
   */
  private async nameProject(): Promise<void> {
    if (!this.leader || this.isLapsed()) return;
    const open = this.project.peek();
    const seen = new Set<string>();
    if (open?.on && open.id) {
      seen.add(open.id);
      await this.nameOne({ id: open.id, root: open.root, kind: open.kind });
    }
    // The other folders that sync from here: the account page lists a project by its name,
    // and a folder that was never opened since (a reset, an older build) has none there.
    for (const folder of Object.values(this.projects())) {
      if (seen.has(folder.id)) continue;
      seen.add(folder.id);
      await this.nameOne({ id: folder.id, root: folder.path, kind: undefined });
    }
  }

  private async nameOne(project: { id: string; root: string; kind: unknown }): Promise<void> {
    const record = this.engine.records("projects").find((r) => r.id === project.id);
    if (record?.unreadable) return;
    const live = record && !record.deleted ? record : null;
    const label = live?.info?.name;
    if (typeof label === "string" && label !== "") return;
    if (Date.now() - (this.namedAt.get(project.id) ?? 0) < NAME_RETRY_MS) return;
    this.namedAt.set(project.id, Date.now());
    let kept: { name?: unknown; kind?: unknown } = {};
    try {
      const parsed: unknown = live?.text ? JSON.parse(live.text) : null;
      if (parsed && typeof parsed === "object") kept = parsed as typeof kept;
    } catch {
      // Not an entry this version wrote: named from the folder.
    }
    const name =
      (typeof kept.name === "string" && kept.name.trim()) || folderName(project.root) || "Project";
    const failed = await syncIpc
      .put(
        this.base(),
        "projects",
        project.id,
        record ? record.version : null,
        JSON.stringify({ name, kind: kept.kind ?? project.kind }),
        { name },
      )
      .then(
        (result) => (result.outcome === "done" ? null : "another computer wrote it first"),
        (err: unknown) => messageOf(err),
      );
    if (failed !== null)
      this.note(`The project's name couldn't be written to the account: ${failed}`, true);
    // The entry as the account has it now, label included.
    else await this.engine.tick().catch(() => {});
  }

  /** Each record's version, to tell what a pass changed. */
  private versions(): Map<string, number> {
    return new Map(
      this.engine.allRecords().map((r) => [`${r.collection}/${r.id}`, r.version] as const),
    );
  }

  /** Says once per run that storage is filling up, at 80% and at 95%. */
  private warnStorage(status: SyncStatus): void {
    const notice = storageNotice(status.usageBytes, status.storageLimit);
    if (!notice || notice.level <= this.storageWarned) return;
    this.storageWarned = notice.level;
    this.services.notifications.show("warning", notice.text, {
      title: "Sync",
      actions: [{ label: "Open storage", run: () => this.showPage("storage") }],
    });
    this.note(notice.text);
  }

  /** Opens the Sync tab on a page (from a notification's button). */
  private showPage(page: SyncPageId): void {
    void this.services.dispatcher.execute("sync.show", { page }).catch(() => {});
  }

  /** Says once per run and computer that one is waiting to be let in. */
  private announceWaiting(status: SyncStatus): void {
    for (const device of status.devices) {
      if (device.status !== "pending" || this.announced.has(device.id)) continue;
      this.announced.add(device.id);
      this.services.notifications.show(
        "info",
        `${device.name} wants to join sync. Check its code before you approve it.`,
        { title: "Sync", actions: [{ label: "Review", run: () => this.showPage("computers") }] },
      );
      this.note(`${device.name} asked to join sync.`);
    }
  }

  /** The agent tells which chats it is writing right now, so they wait a pass. */
  setBusyChats(read: () => ReadonlySet<string>): void {
    this.busyChats = read;
  }

  // ------------------------------------------------------------ status and passes

  /** Reads where sync stands (also catches this device up: new keys, removed, reset). */
  async refreshStatus(): Promise<SyncStatus | null> {
    const base = this.base();
    if (!base) {
      this.status.value = null;
      return null;
    }
    const status = await syncIpc.status(base);
    this.statusAt = Date.now();
    this.statusReads++;
    const before = this.status.peek();
    this.status.value = status;
    if (status.state !== "on") {
      // Whatever was read belongs to keys this device no longer has.
      if (before?.state === "on") this.engine.reset();
      this.activity.value = { state: "off", message: null, at: null };
      this.readOverview();
    } else if (typeof status.lapsedUntil === "number") {
      // Nothing to warn about or to approve: neither can be acted on until it is renewed.
      this.showLapsed();
    } else {
      // Renewed: the next pass says how it went.
      const now = this.activity.peek();
      if (now.state === "lapsed")
        this.activity.value = { state: "idle", message: null, at: now.at };
      this.warnStorage(status);
      this.announceWaiting(status);
    }
    if (status.notice) {
      const words = wentOffWords(status.notice);
      this.services.notifications.show("warning", words, {
        title: "Sync",
        actions: [{ label: "Open sync", run: () => this.showPage("overview") }],
      });
      this.note(words, true);
    }
    return status;
  }

  /**
   * Starts checking a waiting computer. Its code shows once that computer has answered: the
   * status is asked for every couple of seconds until then, whether or not the tab is open.
   */
  async reviewDevice(device: string): Promise<void> {
    await syncIpc.reviewDevice(this.base(), device);
    this.reviewing.value = [...new Set([...this.reviewing.peek(), device])];
    this.reviewUntil = Date.now() + REVIEW_POLL_FOR_MS;
    await this.refreshStatus();
    this.settleReviews();
    if (this.reviewing.peek().length === 0 || this.reviewTimer !== undefined) return;
    this.reviewTimer = setInterval(() => {
      if (this.disposed || Date.now() > this.reviewUntil) {
        this.reviewing.value = [];
        this.settleReviews();
        return;
      }
      void this.refreshStatus()
        .catch(() => null)
        .then(() => this.settleReviews());
    }, REVIEW_POLL_MS);
  }

  /** Drops the computers whose code has come (or that are gone); stops asking when none is left. */
  private settleReviews(): void {
    const devices = this.status.peek()?.devices ?? [];
    const open = this.reviewing
      .peek()
      .filter((id) =>
        devices.some((d) => d.id === id && d.status === "pending" && d.code === null),
      );
    if (open.length !== this.reviewing.peek().length) this.reviewing.value = open;
    if (open.length === 0 && this.reviewTimer !== undefined) {
      clearInterval(this.reviewTimer);
      this.reviewTimer = undefined;
    }
  }

  /** One pass now (the timer calls this too). */
  pass(force = false): Promise<void> {
    this.passing ??= this.runPass(force).finally(() => {
      this.passing = null;
    });
    return this.passing;
  }

  /** The engine's pass, with what was read shown whether or not a layer failed. */
  private async tick(): Promise<void> {
    try {
      await this.engine.tick();
    } finally {
      this.readOverview();
      await this.readIncoming();
    }
  }

  /**
   * Reads what arrived by sync and waits to be accepted here, and says once (in the window
   * that runs the loop) that some of it can run commands. Never fails: what was read last stays.
   */
  async readIncoming(): Promise<IncomingItem[]> {
    try {
      const files = await syncIpc.incoming();
      const items = await incomingItems(files, (path) =>
        syncIpc.userFileRead(path).catch(() => null),
      );
      if (JSON.stringify(items) !== JSON.stringify(this.incoming.peek()))
        this.incoming.value = items;
      const words = this.leader ? incomingNotice(items) : null;
      if (words) {
        await syncIpc.incomingTold();
        this.services.notifications.show("info", words, {
          title: "Sync",
          actions: [{ label: "Review", run: () => this.showPage("overview") }],
        });
        this.note(words);
      }
    } catch {
      // Not readable just now: asked again after the next pass.
    }
    return this.incoming.peek();
  }

  /**
   * The person accepts what arrived (`id`: one item of `incoming`; null: all of it) on this
   * computer. Returns how many items that was.
   */
  async acceptIncoming(id: string | null): Promise<number> {
    const items = await this.readIncoming();
    const paths = pathsToAccept(items, id);
    await syncIpc.incomingAccept(paths);
    // The shortcuts that waited come into use now (no file changed to say so).
    incomingRevision.value++;
    await this.readIncoming();
    return id === null ? items.length : 1;
  }

  private async runPass(force: boolean): Promise<void> {
    if (this.disposed || !this.base()) return;
    const before = this.activity.peek();
    let renew: ReturnType<typeof setInterval> | undefined;
    this.leaseLost = false;
    try {
      // A computer waiting for approval asks every pass, whether or not the tab is open.
      const waiting = this.status.peek()?.state === "pending";
      if (force || waiting || Date.now() - this.statusAt > STATUS_MS) await this.refreshStatus();
      if (this.status.peek()?.state !== "on") return;
      if (this.isLapsed()) {
        await this.readOnlyPass();
        return;
      }
      const leader = await syncIpc.lease(this.owner);
      // Taking the loop over from another window: its saved bases are newer than this
      // window's copy. What was read of the account stays.
      if (leader && !this.leader) this.engine.reloadBases();
      this.leader = leader;
      if (leader) {
        // A long pass keeps its claim, so no second window starts writing meanwhile.
        renew = setInterval(() => {
          void syncIpc.lease(this.owner).then(
            (still) => {
              if (!still) this.leaseLost = true;
            },
            () => {},
          );
        }, LEASE_RENEW_MS);
      }
      this.activity.value = { ...before, state: "syncing", message: null };
      await this.refreshProject();
      const versions = this.versions();
      await this.tick();
      if (this.engine.blocked) {
        // Something sealed with keys this computer doesn't hold yet: reading the status is
        // what fetches them. Then the account is read again.
        await this.refreshStatus();
        if (this.status.peek()?.state !== "on") return;
        await this.tick();
      }
      if (this.engine.blocked) {
        this.activity.value = { state: "blocked", message: KEYS_WAIT, at: before.at };
        this.note(`${KEYS_WAIT}. Nothing syncs until they have.`);
        return;
      }
      this.readSnapshots();
      if (!this.leaseLost) {
        await this.maybeSnapshot(false);
        // A shared project's share: its keys, and its members and shares now and then.
        await this.sharing.tend();
        await this.nameProject();
        await this.checkFolders();
      }
      this.readOverview();
      const sentence =
        before.at === null
          ? "Synced with the account."
          : passSentence(changedCount(versions, this.versions()));
      if (sentence) this.note(sentence);
      if (this.leaseLost) this.leader = false;
      this.failures = 0;
      this.nextPassAt = 0;
      // (The subscription may have ended while the pass ran: that stays said.)
      if (this.isLapsed()) return;
      if (this.leader && this.storageFull()) {
        // Read and fetched; nothing sent, for want of room. Said until there is room.
        this.showFull(Date.now());
        return;
      }
      this.fullSaid = false;
      this.activity.value = {
        state: this.leader ? "idle" : "other",
        message: null,
        at: Date.now(),
      };
    } catch (err) {
      const code = codeOf(err);
      if (isFull(err)) {
        // The account has no room. What it holds was still read and fetched; sending waits,
        // and is tried again later, and later still each time: 1, 2, 5, 10 minutes.
        this.failures++;
        this.nextPassAt = Date.now() + backoffMs(this.failures);
        this.noteRefused();
        this.showFull(before.at);
      } else if (code === "SyncOffline" || isRateLimited(err)) {
        // Tried again later, and later still each time it fails: 1, 2, 5, 10 minutes.
        this.failures++;
        this.nextPassAt = Date.now() + backoffMs(this.failures);
        const slow = code !== "SyncOffline";
        this.activity.value = {
          ...before,
          state: "offline",
          message: slow ? "The service asked to slow down: will retry" : messageOf(err),
        };
        this.note(
          slow ? "The service asked to slow down: sync will retry." : "Offline: sync will retry.",
          true,
        );
      } else if (STANDING_CODES.includes(code)) {
        // Something changed elsewhere (or this computer's keys are gone): where things stand
        // is read again. Still "on" afterwards, the failure is said as it is.
        // An ended subscription isn't an error: reading the status said so (`showLapsed`).
        const status = await this.refreshStatus().catch(() => null);
        if (status?.state === "on" && !this.isLapsed()) {
          this.activity.value = { ...before, state: "error", message: messageOf(err) };
          this.note(messageOf(err), true);
        }
      } else {
        this.activity.value = { ...before, state: "error", message: messageOf(err) };
        this.note(messageOf(err), true);
      }
    } finally {
      clearInterval(renew);
      // Whatever way the pass ended, it isn't "syncing" any more.
      if (this.activity.peek().state === "syncing") {
        const on = this.status.peek()?.state === "on";
        this.activity.value = on
          ? { ...before, state: before.state === "syncing" ? "idle" : before.state }
          : { state: "off", message: null, at: null };
      }
    }
  }

  /**
   * The pass while the subscription is ended: the account is read (so its snapshots can be
   * listed and restored, and the tab shows what it holds) and nothing is written: no layer, no
   * snapshot, no name, no pruning. The claim on the loop isn't needed and is given up.
   */
  private async readOnlyPass(): Promise<void> {
    if (this.leader) {
      this.leader = false;
      void syncIpc.leaseRelease(this.owner).catch(() => {});
    }
    await this.refreshProject();
    await this.tick();
    this.readSnapshots();
    this.readOverview();
    this.failures = 0;
    this.nextPassAt = 0;
    this.showLapsed();
  }

  /** Looks, now and then, whether the folders that sync from here are still on this computer. */
  private async checkFolders(): Promise<void> {
    if (Date.now() - this.foldersAt < FOLDERS_CHECK_MS) return;
    this.foldersAt = Date.now();
    const entries = Object.entries(this.projects());
    if (entries.length === 0) {
      this.missingFolders = new Set();
      return;
    }
    const exist = await syncIpc
      .foldersExist(entries.map(([, entry]) => entry.path))
      .catch(() => null);
    // Not known isn't "gone".
    if (!exist) return;
    this.missingFolders = new Set(
      entries.filter((_, index) => exist[index] === false).map(([folder]) => folder),
    );
  }

  /**
   * Forgets a folder that synced from this computer (it was moved or deleted). Only this
   * computer's note of it goes: nothing in the account is touched.
   */
  async forgetFolder(folder: string): Promise<boolean> {
    const projects = { ...this.projects() };
    const keys = Object.entries(projects)
      .filter(([key, entry]) => key === pathKey(folder) || entry.path === folder)
      .map(([key]) => key);
    if (keys.length === 0) return false;
    for (const key of keys) {
      delete projects[key];
      this.missingFolders.delete(key);
    }
    await this.services.settings.update("sync.projects", projects, "user");
    await this.refreshProject();
    this.readOverview();
    this.note(
      `${folderName(folder) || folder} is no longer noted as a folder that syncs from here.`,
    );
    return true;
  }

  /** Gives this computer another name in the account's list of computers. */
  async renameDevice(name: string): Promise<string> {
    const kept = await syncIpc.renameDevice(this.base(), name);
    await this.refreshStatus();
    this.readOverview();
    this.note(`This computer is now called ${kept}.`);
    return kept;
  }

  /**
   * Gives a project another name in the account (what every computer and the account page
   * show). Folders keep their own names.
   */
  async renameProject(id: string, name: string): Promise<void> {
    await this.engine.tick().catch(() => {});
    const record = this.engine.records("projects").find((r) => r.id === id);
    if (record?.unreadable)
      throw new Error("This computer's keys haven't caught up yet. Try again in a moment.");
    let kept: { kind?: unknown } = {};
    try {
      const parsed: unknown =
        record && !record.deleted && record.text ? JSON.parse(record.text) : null;
      if (parsed && typeof parsed === "object") kept = parsed as typeof kept;
    } catch {
      // Not an entry this version wrote: only the name is kept.
    }
    const result = await syncIpc.put(
      this.base(),
      "projects",
      id,
      record ? record.version : null,
      JSON.stringify({ name, kind: kept.kind }),
      { name },
    );
    if (result.outcome !== "done")
      throw new Error("Another computer changed the project just now. Try again.");
    await this.engine.tick().catch(() => {});
    this.readOverview();
    this.note(`A project was renamed to ${name}.`);
  }

  /**
   * Stops syncing a project from this computer: every folder noted here as that project is
   * forgotten. Nothing in the account is touched. Returns whether any folder was.
   */
  async stopSyncingProject(id: string): Promise<boolean> {
    const projects = { ...this.projects() };
    const keys = Object.entries(projects)
      .filter(([, entry]) => entry.id === id)
      .map(([key]) => key);
    if (keys.length === 0) return false;
    for (const key of keys) {
      delete projects[key];
      this.missingFolders.delete(key);
    }
    await this.services.settings.update("sync.projects", projects, "user");
    await this.refreshProject();
    this.readOverview();
    return true;
  }

  /** What a first snapshot of the open folder would take. */
  estimate(): Promise<SnapshotEstimate> {
    const root = this.services.workspace.root.peek();
    if (!root) return Promise.reject(new Error("Open a folder first."));
    return syncIpc.snapshotEstimate(root);
  }

  /** The open folder's list of what snapshots leave out (made when missing); its path. */
  ignoreFile(): Promise<string> {
    const root = this.services.workspace.root.peek();
    if (!root) return Promise.reject(new Error("Open a folder first."));
    return syncIpc.ignoreFile(root);
  }

  // ------------------------------------------------------------ the open project

  /** Reads the open folder's identity and whether it syncs. */
  async refreshProject(): Promise<SyncProject | null> {
    const { workspace } = this.services;
    const root = workspace.root.peek();
    if (!root || workspace.remote.peek() || this.status.peek()?.state !== "on") {
      this.project.value = null;
      return null;
    }
    const identity = await syncIpc
      .project(this.base(), root, product.workspaceFolderName, false)
      .catch(() => null);
    const mine = this.projects()[pathKey(root)]?.id;
    const project: SyncProject = {
      root,
      id: identity?.id ?? null,
      kind: identity?.kind ?? null,
      // The id it was turned on with must still be its id (a folder swapped for another isn't).
      on: !!identity && mine === identity.id,
      known:
        !!identity &&
        this.engine.records("projects").some((r) => r.id === identity.id && !r.deleted),
    };
    this.project.value = project;
    return project;
  }

  /** Turns sync on or off for the open project, from this computer. */
  async setProjectSync(on: boolean): Promise<void> {
    const root = this.services.workspace.root.peek();
    if (!root) throw new Error("Open a folder first.");
    const projects = { ...this.projects() };
    if (on) {
      const identity = await syncIpc.project(this.base(), root, product.workspaceFolderName, true);
      if (!identity) throw new Error("This folder couldn't be given a project identity.");
      projects[pathKey(root)] = { id: identity.id, path: root };
      // The account's list of projects, so other computers recognise this one.
      const name = root.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "Project";
      const now = this.engine.records("projects").find((r) => r.id === identity.id);
      // A project the account already names keeps that name: the folder here may be called
      // something else.
      const named = !!now && !now.deleted && typeof now.info?.name === "string";
      if (!named) {
        const failed = await syncIpc
          .put(
            this.base(),
            "projects",
            identity.id,
            now ? now.version : null,
            JSON.stringify({ name, kind: identity.kind }),
            // The name is readable by the service, so the account page can list projects.
            { name },
          )
          .then(
            (result) => (result.outcome === "done" ? null : "another computer wrote it first"),
            (err: unknown) => messageOf(err),
          );
        // Not fatal (the project syncs, and a later pass writes the name again), but said.
        if (failed !== null)
          this.note(`The project's name couldn't be written to the account: ${failed}`, true);
      }
      if (identity.kind === "file") {
        this.services.notifications.show(
          "info",
          `This project's identity is kept in ${product.workspaceFolderName}/project.json. Commit it to share the identity with collaborators, or ignore it to keep it personal.`,
          { title: "Sync" },
        );
      }
    } else delete projects[pathKey(root)];
    await this.services.settings.update("sync.projects", projects, "user");
    await this.refreshProject();
    this.readSnapshots();
    this.readOverview();
    this.note(
      on ? "This project syncs from this computer." : "This project stopped syncing from here.",
    );
    // A first snapshot at once, unless another computer's are there to continue from.
    if (on) void this.pass(true).then(() => this.maybeSnapshot(false).catch(() => null));
  }

  /** Where the open project's snapshots are kept; null while it doesn't sync. */
  collection(): string | null {
    const project = this.project.peek();
    return project?.on && project.id ? `snap.${project.id}` : null;
  }

  private readSnapshots(): void {
    const collection = this.collection();
    if (!collection) {
      if (this.snapshots.peek().length > 0) this.snapshots.value = [];
      return;
    }
    const rows: SnapshotRow[] = [];
    const ids = new Set<string>();
    for (const r of this.engine.records(collection)) {
      const row = snapshotRow(r);
      if (!row) continue;
      ids.add(row.id);
      // What this window set a moment ago holds until the account says the same.
      const set = this.keepSet.get(row.id);
      if (set !== undefined && set !== row.keep) row.keep = set;
      else this.keepSet.delete(row.id);
      rows.push(row);
    }
    for (const id of [...this.keepSet.keys()]) if (!ids.has(id)) this.keepSet.delete(id);
    rows.sort((a, b) => b.summary.time - a.summary.time);
    this.snapshots.value = rows;
  }

  /** A snapshot when one is due; calls wait for one another (never two at once). */
  private maybeSnapshot(force: boolean): Promise<SnapshotCreated | null> {
    const next = this.snapshotQueue.then(() => this.takeSnapshot(force));
    this.snapshotQueue = next.catch(() => null);
    return next;
  }

  /**
   * Runs `work` in the snapshots' own queue: once the snapshot under way is done, and before
   * the next starts. What reads the folder as a snapshot does (a share's copy) goes through here.
   */
  private afterSnapshots<T>(work: () => Promise<T>): Promise<T> {
    const next = this.snapshotQueue.then(work);
    this.snapshotQueue = next.catch(() => null);
    return next;
  }

  private async takeSnapshot(force: boolean): Promise<SnapshotCreated | null> {
    const collection = this.collection();
    const project = this.project.peek();
    if (!collection || !project || !this.on("snapshots") || this.isLapsed()) return null;
    if (!force && Date.now() - this.snapshotAt < this.snapshotGap) return null;
    // No room in the account: the folder isn't walked and sealed every few minutes only to be
    // refused. One asked for by hand is still tried (and says why it failed).
    // The snapshots history no longer keeps are still removed, which may make room.
    if (!force && this.storageFull()) {
      this.snapshotAt = Date.now();
      await this.prune().catch(() => {});
      return null;
    }
    this.snapshotAt = Date.now();
    const everything =
      this.services.settings.peek<string | undefined>("sync.snapshotScope") === "everything";
    // Other computers have snapshots of this project and this one has none: its state now is
    // noted, not stored, so "Continue from" stays on offer until work is done here.
    const mine = this.status.peek()?.deviceId;
    const rows = this.snapshots.peek();
    const baseline = rows.length > 0 && !rows.some((r) => r.summary.device === mine);
    const started = Date.now();
    let created: SnapshotCreated | null;
    try {
      created = await syncIpc.snapshotCreate(
        this.base(),
        project.root,
        collection,
        everything,
        force,
        baseline,
      );
    } catch (err) {
      // No room: the snapshots history no longer keeps are removed, which may make some. No
      // other is tried until the status was read again.
      if (isFull(err)) {
        this.noteRefused();
        await this.prune().catch(() => {});
      }
      throw err;
    }
    if (!created) {
      // Nothing changed. Finding that out walks the folder: a huge one isn't walked every few
      // minutes, but in proportion to how long the walk takes.
      this.snapshotGap = snapshotSpacing(Date.now() - started, SNAPSHOT_MS);
      return null;
    }
    this.note(
      `Snapshot taken: ${snapshotFacts(created.summary.files, created.summary.bytes, ", ")}.`,
    );
    await this.engine.tick().catch(() => {});
    this.readSnapshots();
    await this.prune();
    this.readOverview();
    // A shared project: the same goes to its share, now that the account's snapshot is done.
    await this.sharing.afterSnapshot();
    return created;
  }

  /**
   * A last snapshot as the window (or the folder) closes, when something changed since the
   * last one; the spacing between snapshots doesn't apply. Waits a few seconds at most and
   * never fails: closing goes on either way.
   */
  async snapshotOnClose(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (this.disposed || this.status.peek()?.state !== "on" || this.isLapsed()) return;
      if (!this.collection() || !this.on("snapshots")) return;
      this.snapshotAt = 0;
      const waited = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CLOSE_SNAPSHOT_MS);
      });
      const taken = this.maybeSnapshot(false).then(
        () => undefined,
        () => undefined,
      );
      await Promise.race([taken, waited]);
    } catch {
      // Closing doesn't wait for sync.
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------ the account's projects

  /**
   * Another folder that syncs from this computer under the open folder's own id file: the open
   * folder is probably a copy of it. Null when there is none, or when the id comes from a git
   * remote (two clones rightly share it).
   */
  async copiedFrom(): Promise<string | null> {
    const root = this.services.workspace.root.peek();
    if (!root) return null;
    const identity = await syncIpc
      .project(this.base(), root, product.workspaceFolderName, false)
      .catch(() => null);
    if (identity?.kind !== "file") return null;
    for (const [folder, entry] of Object.entries(this.projects())) {
      if (entry.id === identity.id && folder !== pathKey(root)) return entry.path;
    }
    return null;
  }

  /** Gives the open folder a new identity of its own (a copy that is a project of its own). */
  async separateProject(): Promise<string> {
    const root = this.services.workspace.root.peek();
    if (!root) throw new Error("Open a folder first.");
    const id = await syncIpc.projectSeparate(root, product.workspaceFolderName);
    await this.refreshProject();
    return id;
  }

  /** Makes the open folder the account's project `id`, then syncs it from here. */
  async linkProject(id: string): Promise<void> {
    const root = this.services.workspace.root.peek();
    if (!root) throw new Error("Open a folder first.");
    const now = await this.refreshProject();
    if (now?.on) throw new Error("This folder already syncs. Stop syncing it first.");
    // An id file of its own is replaced; a git remote's id just gets the file, which wins.
    await syncIpc.projectLink(root, product.workspaceFolderName, id, now?.kind === "file");
    await this.setProjectSync(true);
  }

  /**
   * Deletes a project's synced copy from the account: its snapshots, its chats' records and its
   * entry. Nothing on any computer is touched. Returns how many records were removed and how
   * many couldn't be (changed again meanwhile; trying again gets them).
   */
  async deleteProjectFromAccount(id: string): Promise<{ removed: number; failed: number }> {
    const base = this.base();
    await this.engine.tick().catch(() => {});
    const records = [
      ...this.engine.records(`snap.${id}`),
      ...this.engine.records(`chats.${id}`),
      // Last, so a delete that stopped half way still lists the project to try again.
      ...this.engine.records("projects").filter((r) => r.id === id),
    ].filter((r) => !r.deleted);
    let removed = 0;
    let failed = 0;
    for (const record of records) {
      try {
        let result = await syncIpc.put(base, record.collection, record.id, record.version, null);
        // Another computer wrote it meanwhile: once more, over what it wrote.
        if (result.outcome === "conflict" && result.current && !result.current.deleted)
          result = await syncIpc.put(
            base,
            record.collection,
            record.id,
            result.current.version,
            null,
          );
        const gone =
          result.outcome === "done" ||
          (result.outcome === "conflict" && (!result.current || result.current.deleted));
        if (gone) removed++;
        else failed++;
      } catch {
        failed++;
      }
    }
    await syncIpc.gc(base).catch(() => null);
    await this.pass(true);
    this.note(`A project was deleted from the account (${countOf(removed, "item")}).`);
    return { removed, failed };
  }

  /** A snapshot of the open project now, whether or not anything changed. */
  async snapshotNow(force = true): Promise<SnapshotCreated | null> {
    if (!this.collection()) throw new Error("Turn sync on for this project first.");
    const created = await this.maybeSnapshot(force);
    // Asked for by hand: history is tidied also when nothing new was stored.
    if (!created) await this.prune().catch(() => {});
    return created;
  }

  /** Removes the snapshots history no longer keeps, then frees what only they used. */
  private async prune(): Promise<void> {
    const collection = this.collection();
    if (!collection || this.isLapsed()) return;
    const days = this.services.settings.peek<number | undefined>("sync.historyDays") ?? 30;
    const rows = this.snapshots.peek();
    // The account page's mark counts for the newest few marked, not for any number.
    const marked = keepMarksHonoured(
      rows.map((r) => ({ id: r.id, time: r.summary.time, keep: r.keep })),
    );
    const remove = planPrune(
      rows.map((r) => ({
        id: r.id,
        time: r.summary.time,
        // Under a name here, or marked to keep from the account page.
        pinned: staysPinned(r.summary.pinned, marked.has(r.id)),
        // An earlier day keeps each computer's last snapshot, not only the day's last.
        device: r.summary.device,
      })),
      days,
    );
    if (remove.length === 0) return;
    for (const id of remove) {
      const row = rows.find((r) => r.id === id);
      if (row) await syncIpc.put(this.base(), collection, id, row.version, null).catch(() => {});
    }
    await this.engine.tick().catch(() => {});
    this.readSnapshots();
    void syncIpc.gc(this.base()).catch(() => {});
  }

  snapshotFiles(id: string): Promise<SnapshotFile[]> {
    const collection = this.collection();
    if (!collection) throw new Error("This project doesn't sync.");
    return syncIpc.snapshotFiles(this.base(), collection, id);
  }

  /** The open folder's own changes a restore would have to set aside. */
  localChanges(): Promise<string[]> {
    const root = this.project.peek()?.root;
    return root ? syncIpc.snapshotLocalChanges(root) : Promise.resolve([]);
  }

  async restore(id: string, stash: boolean): Promise<SnapshotRestored> {
    const collection = this.collection();
    const project = this.project.peek();
    if (!collection || !project) throw new Error("This project doesn't sync.");
    const restored = await syncIpc.snapshotRestore(
      this.base(),
      collection,
      id,
      project.root,
      stash,
    );
    // What a restore leaves isn't new work: no snapshot of it until something changes.
    this.snapshotAt = Date.now();
    // Remembered, so the snapshot just continued from isn't offered again.
    const projects = { ...this.projects() };
    const folder = projects[pathKey(project.root)];
    if (folder) {
      projects[pathKey(project.root)] = { ...folder, restored: id };
      await this.services.settings.update("sync.projects", projects, "user").catch(() => {});
    }
    this.snapshots.value = [...this.snapshots.peek()];
    this.note(`Restored a snapshot: ${countOf(restored.files, "file")}.`);
    return restored;
  }

  async restoreFile(id: string, path: string): Promise<void> {
    const collection = this.collection();
    const project = this.project.peek();
    if (!collection || !project) throw new Error("This project doesn't sync.");
    await syncIpc.snapshotRestoreFile(this.base(), collection, id, project.root, path);
  }

  async pin(id: string, name: string | null): Promise<void> {
    const collection = this.collection();
    if (!collection) throw new Error("This project doesn't sync.");
    await syncIpc.snapshotPin(this.base(), collection, id, name);
    await this.engine.tick().catch(() => {});
    this.readSnapshots();
  }

  /**
   * Sets or clears the account page's "keep" mark on a snapshot. The mark is the service's, not
   * part of the record: what was set here shows at once, and until the account says the same.
   */
  async keep(id: string, keep: boolean): Promise<void> {
    const collection = this.collection();
    if (!collection) throw new Error("This project doesn't sync.");
    await syncIpc.snapshotKeep(this.base(), collection, id, keep);
    this.keepSet.set(id, keep);
    await this.engine.tick().catch(() => {});
    this.readSnapshots();
  }

  async deleteSnapshot(id: string): Promise<void> {
    const collection = this.collection();
    const row = this.snapshots.peek().find((r) => r.id === id);
    if (!collection || !row) throw new Error("That snapshot is gone.");
    const result = await syncIpc.put(this.base(), collection, id, row.version, null);
    if (result.outcome !== "done") throw new Error("The snapshot changed; try again.");
    await this.engine.tick().catch(() => {});
    this.readSnapshots();
    void syncIpc.gc(this.base()).catch(() => {});
  }

  /** The newest snapshot another computer made that is newer than this computer's own. */
  continueFrom(): SnapshotRow | null {
    const mine = this.status.peek()?.deviceId;
    const rows = this.snapshots.peek();
    const newest = rows[0];
    if (!newest || newest.summary.device === mine) return null;
    const root = this.project.peek()?.root;
    const restored = root ? this.projects()[pathKey(root)]?.restored : undefined;
    return newest.id === restored ? null : newest;
  }

  dispose(): void {
    this.disposed = true;
    // Another window takes the loop over at once instead of waiting the claim out.
    if (this.leader) void syncIpc.leaseRelease(this.owner).catch(() => {});
    clearInterval(this.reviewTimer);
    this.store.dispose();
  }
}

function snapshotRow(record: SyncRecord): SnapshotRow | null {
  if (record.deleted || !record.text) return null;
  try {
    const summary = JSON.parse(record.text) as SnapshotSummary;
    if (typeof summary.time !== "number" || typeof summary.device !== "string") return null;
    return { id: record.id, version: record.version, summary, keep: record.keep === true };
  } catch {
    return null;
  }
}

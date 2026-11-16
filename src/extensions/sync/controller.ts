// Sync as the app runs it (D435): where it stands, the loop's passes, the open project and its
// snapshots. No view code: the Sync view and the commands both go through this.

import { agentStoreIpc } from "../../core/ipc/agent";
import { fsIpc } from "../../core/ipc/fs";
import {
  type SnapshotCreated,
  type SnapshotFile,
  type SnapshotRestored,
  type SnapshotSummary,
  type SyncRecord,
  type SyncStatus,
  syncIpc,
} from "../../core/ipc/sync";
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import { product } from "../../core/product";
import { type Signal, signal } from "../../core/reactive/index";
import { parseJsonc } from "../../core/settings/jsonc";
import { type SyncBackend, SyncEngine, type SyncLayer } from "../../core/sync/engine";
import { planPrune } from "../../core/sync/history";
import {
  type ChatsPort,
  chatsLayer,
  type FilesPort,
  filesLayer,
  type SettingsPort,
  settingsLayer,
} from "../../core/sync/layers";
import type { WorkbenchServices } from "../../workbench/services";
import { accountsServer } from "../accounts/model";
import {
  buildOverview,
  changedCount,
  countOf,
  EMPTY_OVERVIEW,
  formatSize,
  passSentence,
  type SyncEvent,
  type SyncOverview,
  type SyncPageId,
  storageNotice,
  withEvent,
} from "./model";

/** How often a pass runs while the app is open. */
const PASS_MS = 60_000;
/** How long a status read stays good. */
const STATUS_MS = 5 * 60_000;
/** A snapshot at most this often. */
const SNAPSHOT_MS = 3 * 60_000;
/** The longest a closing window waits for its last snapshot. */
const CLOSE_SNAPSHOT_MS = 4_000;

/** Settings that always stay on the computer they were set on. */
const LOCAL_SETTINGS = ["accounts.serverUrl", "sync.projects"];

export interface SyncActivity {
  /** "other": another window of this profile runs the loop. */
  state: "off" | "idle" | "syncing" | "offline" | "error" | "other";
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
}

const codeOf = (err: unknown): string =>
  err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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

  private readonly store = new DisposableStore();
  private readonly engine: SyncEngine;
  private readonly owner = `w-${Math.random().toString(36).slice(2, 10)}`;
  private leader = false;
  private statusAt = 0;
  private snapshotAt = 0;
  private passing: Promise<void> | null = null;
  private disposed = false;
  /** The fullest storage a notification was shown for, this run (0, 80 or 95). */
  private storageWarned = 0;
  /** The waiting computers a notification was shown for, this run (ids). */
  private readonly announced = new Set<string>();
  /** Chats this window is writing (ids), given by the agent's own state. */
  private busyChats: () => ReadonlySet<string> = () => new Set();

  constructor(private readonly services: WorkbenchServices) {
    const backend: SyncBackend = {
      changes: (since) => syncIpc.changes(this.base(), since),
      put: (collection, id, expect, text, info) =>
        syncIpc.put(this.base(), collection, id, expect, text, info ?? null),
    };
    const led = (layer: SyncLayer): SyncLayer => ({
      name: layer.name,
      // Only the window that holds the claim writes; the others just read the account.
      run: (ctx) => (this.leader ? layer.run(ctx) : Promise.resolve()),
    });
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
        led(chatsLayer(this.chatsPort())),
      ],
    );
    const timer = setInterval(() => void this.pass(), PASS_MS);
    this.store.add({ dispose: () => clearInterval(timer) });
  }

  /** The accounts server ("" when the build has none). */
  base(): string {
    return accountsServer(
      this.services.settings.peek<string | undefined>("accounts.serverUrl"),
      product.accountsUrl,
    );
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
          // No settings file yet: nothing set here.
          if (codeOf(err) === "NotFound") return { values: {}, mtimeMs: 0 };
          return null;
        }
      },
      apply: async (edits) => {
        const values: Record<string, unknown> = {};
        for (const { key, value } of edits) values[key] = value;
        await settings.updateMany(values, "user");
      },
      skip: (key) => {
        if (LOCAL_SETTINGS.includes(key)) return true;
        const ignored = settings.peek<unknown>("sync.ignoredSettings");
        return Array.isArray(ignored) && ignored.includes(key);
      },
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
        if (!this.on("chats")) return [];
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
      pull: (collection, id, saveAs, workspace) =>
        syncIpc.chatPull(this.base(), collection, id, saveAs, workspace),
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
        ? buildOverview(this.engine.allRecords(), status.devices, Object.values(this.projects()))
        : EMPTY_OVERVIEW;
    if (JSON.stringify(next) !== JSON.stringify(this.overview.peek())) this.overview.value = next;
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
    const before = this.status.peek();
    this.status.value = status;
    if (status.state !== "on") {
      // Whatever was read belongs to keys this device no longer has.
      if (before?.state === "on") this.engine.reset();
      this.activity.value = { state: "off", message: null, at: null };
      this.readOverview();
    } else {
      this.warnStorage(status);
      this.announceWaiting(status);
    }
    if (status.notice) {
      this.services.notifications.show(
        "warning",
        status.notice === "removed"
          ? "This computer was removed from sync on another one. Sync is off here; your files and chats are untouched."
          : "Sync was reset from the account page. It is off here until you turn it on again; your files and chats are untouched.",
        { title: "Sync" },
      );
    }
    return status;
  }

  /** One pass now (the timer calls this too). */
  pass(force = false): Promise<void> {
    this.passing ??= this.runPass(force).finally(() => {
      this.passing = null;
    });
    return this.passing;
  }

  private async runPass(force: boolean): Promise<void> {
    if (this.disposed || !this.base()) return;
    try {
      // A computer waiting for approval asks every pass, whether or not the tab is open.
      const waiting = this.status.peek()?.state === "pending";
      if (force || waiting || Date.now() - this.statusAt > STATUS_MS) await this.refreshStatus();
      if (this.status.peek()?.state !== "on") return;
      const leader = await syncIpc.lease(this.owner);
      // Taking over (or handing over) the loop: what this window kept in memory may be older
      // than what the window before it saved.
      if (leader !== this.leader) this.engine.reset();
      this.leader = leader;
      const before = this.activity.peek();
      this.activity.value = { ...before, state: "syncing", message: null };
      await this.refreshProject();
      const versions = this.versions();
      try {
        await this.engine.tick();
      } finally {
        // Whatever was read shows, also when a layer failed.
        this.readOverview();
      }
      this.readSnapshots();
      await this.maybeSnapshot(false);
      this.readOverview();
      const sentence =
        before.at === null
          ? "Synced with the account."
          : passSentence(changedCount(versions, this.versions()));
      if (sentence) this.note(sentence);
      this.activity.value = {
        state: this.leader ? "idle" : "other",
        message: null,
        at: Date.now(),
      };
    } catch (err) {
      const code = codeOf(err);
      const before = this.activity.peek();
      if (code === "SyncOffline") {
        this.activity.value = { ...before, state: "offline", message: messageOf(err) };
        this.note("Offline: sync will retry.", true);
      } else if (["SyncSignedOut", "SyncNotApproved", "SyncReset", "SyncOff"].includes(code)) {
        // Something changed elsewhere: read where things stand again, quietly.
        await this.refreshStatus().catch(() => {});
      } else {
        this.activity.value = { ...before, state: "error", message: messageOf(err) };
        this.note(messageOf(err), true);
      }
    }
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
      if (!named)
        await syncIpc
          .put(
            this.base(),
            "projects",
            identity.id,
            now ? now.version : null,
            JSON.stringify({ name, kind: identity.kind }),
            // The name is readable by the service, so the account page can list projects.
            { name },
          )
          .catch(() => {});
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

  private collection(): string | null {
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
    for (const r of this.engine.records(collection)) {
      const row = snapshotRow(r);
      if (row) rows.push(row);
    }
    rows.sort((a, b) => b.summary.time - a.summary.time);
    this.snapshots.value = rows;
  }

  private async maybeSnapshot(force: boolean): Promise<SnapshotCreated | null> {
    const collection = this.collection();
    const project = this.project.peek();
    if (!collection || !project || !this.on("snapshots")) return null;
    if (!force && Date.now() - this.snapshotAt < SNAPSHOT_MS) return null;
    this.snapshotAt = Date.now();
    const everything =
      this.services.settings.peek<string | undefined>("sync.snapshotScope") === "everything";
    // Other computers have snapshots of this project and this one has none: its state now is
    // noted, not stored, so "Continue from" stays on offer until work is done here.
    const mine = this.status.peek()?.deviceId;
    const rows = this.snapshots.peek();
    const baseline = rows.length > 0 && !rows.some((r) => r.summary.device === mine);
    const created = await syncIpc.snapshotCreate(
      this.base(),
      project.root,
      collection,
      everything,
      force,
      baseline,
    );
    if (!created) return null;
    this.note(
      `Snapshot taken: ${countOf(created.summary.files, "file")}, ${formatSize(created.summary.bytes)}.`,
    );
    await this.engine.tick().catch(() => {});
    this.readSnapshots();
    await this.prune();
    this.readOverview();
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
      if (this.disposed || this.status.peek()?.state !== "on") return;
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
    return this.maybeSnapshot(force);
  }

  /** Removes the snapshots history no longer keeps, then frees what only they used. */
  private async prune(): Promise<void> {
    const collection = this.collection();
    if (!collection) return;
    const days = this.services.settings.peek<number | undefined>("sync.historyDays") ?? 30;
    const rows = this.snapshots.peek();
    const remove = planPrune(
      rows.map((r) => ({ id: r.id, time: r.summary.time, pinned: !!r.summary.pinned })),
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
    this.store.dispose();
  }
}

function snapshotRow(record: SyncRecord): SnapshotRow | null {
  if (record.deleted || !record.text) return null;
  try {
    const summary = JSON.parse(record.text) as SnapshotSummary;
    if (typeof summary.time !== "number" || typeof summary.device !== "string") return null;
    return { id: record.id, version: record.version, summary };
  } catch {
    return null;
  }
}

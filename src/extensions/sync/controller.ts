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

/** How often a pass runs while the app is open. */
const PASS_MS = 60_000;
/** How long a status read stays good. */
const STATUS_MS = 5 * 60_000;
/** A snapshot at most this often. */
const SNAPSHOT_MS = 3 * 60_000;

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

  private readonly store = new DisposableStore();
  private readonly engine: SyncEngine;
  private readonly owner = `w-${Math.random().toString(36).slice(2, 10)}`;
  private leader = false;
  private statusAt = 0;
  private snapshotAt = 0;
  private passing: Promise<void> | null = null;
  private disposed = false;
  /** Chats this window is writing (ids), given by the agent's own state. */
  private busyChats: () => ReadonlySet<string> = () => new Set();

  constructor(private readonly services: WorkbenchServices) {
    const backend: SyncBackend = {
      changes: (since) => syncIpc.changes(this.base(), since),
      put: (collection, id, expect, text) => syncIpc.put(this.base(), collection, id, expect, text),
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
    };
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
      if (force || Date.now() - this.statusAt > STATUS_MS) await this.refreshStatus();
      if (this.status.peek()?.state !== "on") return;
      const leader = await syncIpc.lease(this.owner);
      // Taking over (or handing over) the loop: what this window kept in memory may be older
      // than what the window before it saved.
      if (leader !== this.leader) this.engine.reset();
      this.leader = leader;
      const before = this.activity.peek();
      this.activity.value = { ...before, state: "syncing", message: null };
      await this.refreshProject();
      await this.engine.tick();
      this.readSnapshots();
      await this.maybeSnapshot(false);
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
      } else if (["SyncSignedOut", "SyncNotApproved", "SyncReset", "SyncOff"].includes(code)) {
        // Something changed elsewhere: read where things stand again, quietly.
        await this.refreshStatus().catch(() => {});
      } else {
        this.activity.value = { ...before, state: "error", message: messageOf(err) };
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
      await syncIpc
        .put(
          this.base(),
          "projects",
          identity.id,
          now ? now.version : null,
          JSON.stringify({ name, kind: identity.kind }),
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
    await this.engine.tick().catch(() => {});
    this.readSnapshots();
    await this.prune();
    return created;
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

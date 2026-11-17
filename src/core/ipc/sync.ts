// Sync (Rust: src-tauri/src/sync, D435). `base` is the accounts server, as for the account.
// Everything stored is sealed on this computer; these calls hand over and get back plain text.
import { call as invoke } from "./invoke";

/** Hears the code of every sync call that failed ("" when the failure has none). */
let failureListener: ((code: string) => void) | null = null;

/**
 * One listener for the codes of failed sync calls (the sync controller): a code that says where
 * sync stands changed (`SyncLapsed`) is acted on whichever call met it. Returns how to stop.
 */
export function onSyncFailure(listener: (code: string) => void): { dispose(): void } {
  failureListener = listener;
  return {
    dispose: () => {
      if (failureListener === listener) failureListener = null;
    },
  };
}

/** A sync call; its failure is passed on as it is, after the listener heard its code. */
function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args).catch((err: unknown) => {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : "";
    failureListener?.(code);
    throw err;
  });
}

export interface SyncDevice {
  id: string;
  name: string;
  platform: string;
  status: "approved" | "pending";
  createdAt: number | null;
  lastSeenAt: number | null;
  /**
   * Six digits both computers show while one approves the other. Null until a computer that
   * syncs has started checking the waiting one (`reviewDevice`).
   */
  code: string | null;
  /** This computer started checking that waiting one; its code comes once it has answered. */
  checking?: boolean;
  current: boolean;
}

export type SyncState = "signedOut" | "unavailable" | "off" | "pending" | "on";

export interface SyncStatus {
  state: SyncState;
  /** Why sync went off by itself, said once: the account's sync was reset, or this device removed. */
  notice: "reset" | "removed" | "keysLost" | null;
  /** Whether the account has sync set up on some device. */
  exists: boolean;
  deviceId: string | null;
  deviceName: string | null;
  code: string | null;
  devices: SyncDevice[];
  recoveryCreatedAt: number | null;
  usageBytes: number;
  storageLimit: number;
  epoch: number;
  /**
   * The account's subscription ended: until then (ms) what is synced can still be read, and
   * every write is refused (`SyncLapsed`). Null while the subscription runs.
   */
  lapsedUntil: number | null;
}

export interface SyncRecord {
  collection: string;
  id: string;
  version: number;
  seq: number;
  deleted: boolean;
  text: string | null;
  /** Sealed with keys this device doesn't hold yet. */
  unreadable: boolean;
  /** Its content opens with no key at all: it counts as empty, and the next write replaces it. */
  damaged?: boolean;
  refs: number;
  device: string | null;
  updatedAt: number | null;
  /** The record's label, readable by the service (names, counts, sizes, dates). Not sealed. */
  info?: SyncInfo | null;
  /**
   * The service's "keep" mark (a snapshot pinned from the account page): history never removes
   * it. Beside the record, not in its sealed content; absent from an older service.
   */
  keep?: boolean;
}

/** A label the service can read: a flat object of text, numbers and yes/no. Never content. */
export type SyncInfo = Record<string, string | number | boolean>;

export interface SyncChanges {
  epoch: number;
  seq: number;
  gcEpoch: number;
  more: boolean;
  records: SyncRecord[];
}

export type SyncPut =
  | { outcome: "done"; version: number; seq: number }
  | { outcome: "conflict"; current: SyncRecord | null }
  | { outcome: "gc"; gcEpoch: number };

/** A snapshot as its record describes it (what a list shows without opening it). */
export interface SnapshotSummary {
  v: number;
  device: string;
  deviceName: string;
  /** When, in ms. */
  time: number;
  kind: "git" | "folder";
  head: string | null;
  branch: string | null;
  files: number;
  deleted: number;
  bytes: number;
  skipped: number;
  fingerprint: string;
  /** Kept whatever its age, under this name. */
  pinned?: string;
}

export interface SnapshotCreated {
  id: string;
  summary: SnapshotSummary;
  uploadedBytes: number;
}

export interface SnapshotFile {
  path: string;
  size: number;
  deleted: boolean;
}

/**
 * How a snapshot's file stands against the folder: the same content, other content, not in
 * the folder, or not compared. For a deletion: "differs" while the file is still in the folder.
 */
export type SnapshotStanding = "same" | "differs" | "missing" | "unknown";

export interface SnapshotComparedFile extends SnapshotFile {
  state: SnapshotStanding;
}

export interface SnapshotCompared {
  /** Every file and deletion of the snapshot, by path. */
  files: SnapshotComparedFile[];
  /** How many were left uncompared because the snapshot names more than are compared. */
  truncated: number;
}

/** One file of a snapshot as text; `reason` says why there is none (too large, not text). */
export interface SnapshotFileText {
  text: string | null;
  size: number;
  reason: "large" | "binary" | null;
}

export interface SnapshotRestored {
  files: number;
  deleted: number;
  branch: string | null;
  detached: boolean;
  notes: string[];
  stashed: string | null;
}

/** What a first snapshot of a folder would take. */
export interface SnapshotEstimate {
  /** "git": only what differs from the commit travels as files. "folder": every file. */
  kind: "git" | "folder";
  files: number;
  bytes: number;
  /** Files over the size limit, which stay out. */
  tooLarge: number;
  /** The largest top-level folders and files: [name, bytes, files]. */
  largest: [string, number, number][];
  /** More files than a snapshot holds: the rest would be left out. */
  truncated: boolean;
}

/** The user's own files as a scan found them. */
export interface SyncUserFiles {
  /** The files that sync, with their content's hash. */
  files: SyncUserFile[];
  /**
   * Names that are there but can't sync as they are (too large, not text, read failed): they
   * are neither sent nor taken to be deleted.
   */
  kept: string[];
  /** False when part of the scan failed or was cut short: nothing missing means "deleted". */
  complete: boolean;
}

/** One of the user's own files that sync, under its name on every computer. */
export interface SyncUserFile {
  path: string;
  hash: string;
  mtimeMs: number;
}

export const syncIpc = {
  /** Where sync stands here, catching up with what other devices did. */
  status: (base: string): Promise<SyncStatus> => call<SyncStatus>("sync_status", { base }),
  /** Makes the keys and returns the recovery key to show; nothing is sent yet. */
  prepare: (base: string, name: string): Promise<string> =>
    call<string>("sync_prepare", { base, name }),
  /** Turns sync on for the account, once the recovery key (or its last group) is typed back. */
  setup: (base: string, typed: string): Promise<void> => call<void>("sync_setup", { base, typed }),
  /** Asks to join. The code to compare shows in the status once a computer checks this one. */
  join: (base: string, name: string): Promise<void> => call<void>("sync_join", { base, name }),
  /** Gives this computer another name in the account's list; resolves with the name as kept. */
  renameDevice: (base: string, name: string): Promise<string> =>
    call<string>("sync_rename_device", { base, name }),
  /**
   * Starts checking a waiting device. The code both computers show appears in the status a
   * moment later, once the waiting one has answered (ask for the status again).
   */
  reviewDevice: (base: string, device: string): Promise<void> =>
    call<void>("sync_review_device", { base, device }),
  joinRecovery: (base: string, name: string, key: string): Promise<void> =>
    call<void>("sync_join_recovery", { base, name, key }),
  approve: (base: string, device: string): Promise<void> =>
    call<void>("sync_approve", { base, device }),
  removeDevice: (base: string, device: string): Promise<void> =>
    call<void>("sync_remove_device", { base, device }),
  newRecoveryKey: (base: string): Promise<string> =>
    call<string>("sync_new_recovery_key", { base }),
  changes: (base: string, since: number): Promise<SyncChanges> =>
    call<SyncChanges>("sync_changes", { base, since }),
  get: (base: string, collection: string, id: string): Promise<SyncRecord | null> =>
    call<SyncRecord | null>("sync_record_get", { base, collection, id }),
  /** Writes over the version it was made from (`expect`; null: new). `text` null deletes. */
  put: (
    base: string,
    collection: string,
    id: string,
    expect: number | null,
    text: string | null,
    info: SyncInfo | null = null,
  ): Promise<SyncPut> =>
    call<SyncPut>("sync_record_put", { base, collection, id, expect, text, info }),
  /** Uploads a saved chat as a record; null when the chat has no file. */
  chatPush: (
    base: string,
    collection: string,
    id: string,
    expect: number | null,
  ): Promise<SyncPut | null> =>
    call<SyncPut | null>("sync_chat_push", { base, collection, id, expect }),
  /**
   * Saves a synced chat as the chat `saveAs`, in the folder `workspace`; the record's version.
   * `ifStamp` is the stamp the local chat must still have (null: it must not exist): when it
   * was saved meanwhile nothing is written and the result is null.
   */
  chatPull: (
    base: string,
    collection: string,
    id: string,
    saveAs: string,
    workspace: string | null,
    ifStamp: string | null,
  ): Promise<number | null> =>
    call<number | null>("sync_chat_pull", { base, collection, id, saveAs, workspace, ifStamp }),
  /** Chats deleted on this computer since they were last asked about (ids). */
  chatsDeleted: (): Promise<string[]> => call<string[]>("sync_chats_deleted"),
  /** Forgets those deletions once the account knows of them. */
  chatsDeletedClear: (ids: string[]): Promise<void> =>
    call<void>("sync_chats_deleted_clear", { ids }),
  /** A project's name from its git remote's address; null for a local-only address. */
  projectName: (base: string, remote: string): Promise<string | null> =>
    call<string | null>("sync_project_name", { base, remote }),
  /**
   * Captures the open folder `root` as a snapshot in `collection`; null when nothing changed
   * since this computer's last one (unless `force`). `everything`: the whole history too.
   */
  snapshotCreate: (
    base: string,
    root: string,
    collection: string,
    everything: boolean,
    force: boolean,
    baseline = false,
  ): Promise<SnapshotCreated | null> =>
    call<SnapshotCreated | null>("sync_snapshot_create", {
      base,
      root,
      collection,
      everything,
      force,
      baseline,
    }),
  snapshotFiles: (base: string, collection: string, id: string): Promise<SnapshotFile[]> =>
    call<SnapshotFile[]>("sync_snapshot_files", { base, collection, id }),
  /**
   * A snapshot's files, each with how it stands against the open folder `root`. Reads the
   * folder; writes nothing.
   */
  snapshotCompare: (
    base: string,
    collection: string,
    id: string,
    root: string,
  ): Promise<SnapshotCompared> =>
    call<SnapshotCompared>("sync_snapshot_compare", { base, collection, id, root }),
  /**
   * One file of a snapshot (`path` relative to the project) as text, written nowhere; null when
   * the snapshot doesn't hold the file.
   */
  snapshotFileText: (
    base: string,
    collection: string,
    id: string,
    path: string,
  ): Promise<SnapshotFileText | null> =>
    call<SnapshotFileText | null>("sync_snapshot_file_text", { base, collection, id, path }),
  /** The open folder's own changed files (none while it is as a restore left it). */
  snapshotLocalChanges: (root: string): Promise<string[]> =>
    call<string[]>("sync_snapshot_local_changes", { root }),
  /** Brings `root` to a snapshot; local changes refuse it (`SyncDirty`) unless `stash`. */
  snapshotRestore: (
    base: string,
    collection: string,
    id: string,
    root: string,
    stash: boolean,
  ): Promise<SnapshotRestored> =>
    call<SnapshotRestored>("sync_snapshot_restore", { base, collection, id, root, stash }),
  snapshotRestoreFile: (
    base: string,
    collection: string,
    id: string,
    root: string,
    path: string,
  ): Promise<void> =>
    call<void>("sync_snapshot_restore_file", { base, collection, id, root, path }),
  /** Pins a snapshot under a name, or unpins it (`name` null). */
  snapshotPin: (base: string, collection: string, id: string, name: string | null): Promise<void> =>
    call<void>("sync_snapshot_pin", { base, collection, id, name }),
  /**
   * Sets or clears the mark the account page puts on a snapshot to keep it. The name a snapshot
   * is pinned under (`snapshotPin`) is another thing; a snapshot can have both.
   */
  snapshotKeep: (base: string, collection: string, id: string, keep: boolean): Promise<void> =>
    call<void>("sync_snapshot_keep", { base, collection, id, keep }),
  /** Removes stored content nothing refers to any more; the bytes in use afterwards. */
  gc: (base: string): Promise<number | null> => call<number | null>("sync_gc", { base }),
  userFiles: (): Promise<SyncUserFiles> => call<SyncUserFiles>("sync_user_files"),
  userFileRead: (path: string): Promise<string | null> =>
    call<string | null>("sync_user_file_read", { path }),
  /** Writes one of the user's synced files (`text` null removes it). */
  userFileWrite: (path: string, text: string | null): Promise<SyncUserFile | null> =>
    call<SyncUserFile | null>("sync_user_file_write", { path, text }),
  /** What the sync loop keeps between runs. */
  stateLoad: (): Promise<string | null> => call<string | null>("sync_state_load"),
  stateSave: (text: string): Promise<void> => call<void>("sync_state_save", { text }),
  /**
   * Which project the open folder `root` is: its id file when it has one, else its git
   * remote's address; with `create`, a new id file when it has neither. `folderName` is
   * the product's workspace folder name. Null: no identity yet.
   */
  project: (
    base: string,
    root: string,
    folderName: string,
    create: boolean,
  ): Promise<{ id: string; kind: "file" | "remote" } | null> =>
    call<{ id: string; kind: "file" | "remote" } | null>("sync_project", {
      base,
      root,
      folderName,
      create,
    }),
  /** This computer's own name, to offer when it joins. */
  deviceName: (): Promise<string> => call<string>("sync_device_name"),
  /** Gives up this window's claim on the sync loop (it is closing). */
  leaseRelease: (owner: string): Promise<void> => call<void>("sync_lease_release", { owner }),
  /** Whether the chat saved here is exactly the one in the record. */
  chatSame: (base: string, collection: string, id: string): Promise<boolean> =>
    call<boolean>("sync_chat_same", { base, collection, id }),
  /** Makes the open folder the account's project `id` (writes its id file). */
  projectLink: (root: string, folderName: string, id: string, replace: boolean): Promise<void> =>
    call<void>("sync_project_link", { root, folderName, id, replace }),
  /** Gives the open folder a new identity of its own; the new id. */
  projectSeparate: (root: string, folderName: string): Promise<string> =>
    call<string>("sync_project_separate", { root, folderName }),
  /** What a first snapshot of the open folder would take, to say before a large one starts. */
  snapshotEstimate: (root: string): Promise<SnapshotEstimate> =>
    call<SnapshotEstimate>("sync_snapshot_estimate", { root }),
  /** The open folder's `.syncignore` (made with an explanation when missing); its path. */
  ignoreFile: (root: string): Promise<string> => call<string>("sync_ignore_file", { root }),
  /** Which of these folders exist on this computer. */
  foldersExist: (paths: string[]): Promise<boolean[]> =>
    call<boolean[]>("sync_folders_exist", { paths }),
  /** Claims the sync loop for this window; false while another window of the profile has it. */
  lease: (owner: string): Promise<boolean> => call<boolean>("sync_lease", { owner }),
};

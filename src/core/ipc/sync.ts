// Sync (Rust: src-tauri/src/sync, D435). `base` is the accounts server, as for the account.
// Everything stored is sealed on this computer; these calls hand over and get back plain text.
import { call } from "./invoke";

export interface SyncDevice {
  id: string;
  name: string;
  platform: string;
  status: "approved" | "pending";
  createdAt: number | null;
  lastSeenAt: number | null;
  /** Six digits both computers show while one approves the other. */
  code: string;
  current: boolean;
}

export type SyncState = "signedOut" | "unavailable" | "off" | "pending" | "on";

export interface SyncStatus {
  state: SyncState;
  /** Why sync went off by itself, said once: the account's sync was reset, or this device removed. */
  notice: "reset" | "removed" | null;
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
  refs: number;
  device: string | null;
  updatedAt: number | null;
}

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

export interface SnapshotRestored {
  files: number;
  deleted: number;
  branch: string | null;
  detached: boolean;
  notes: string[];
  stashed: string | null;
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
  /** Asks to join; returns the code to compare on a device that approves. */
  join: (base: string, name: string): Promise<string> => call<string>("sync_join", { base, name }),
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
  ): Promise<SyncPut> => call<SyncPut>("sync_record_put", { base, collection, id, expect, text }),
  /** Uploads a saved chat as a record; null when the chat has no file. */
  chatPush: (
    base: string,
    collection: string,
    id: string,
    expect: number | null,
  ): Promise<SyncPut | null> =>
    call<SyncPut | null>("sync_chat_push", { base, collection, id, expect }),
  /** Saves a synced chat as the chat `saveAs`, in the folder `workspace`; the record's version. */
  chatPull: (
    base: string,
    collection: string,
    id: string,
    saveAs: string,
    workspace: string | null,
  ): Promise<number | null> =>
    call<number | null>("sync_chat_pull", { base, collection, id, saveAs, workspace }),
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
  ): Promise<SnapshotCreated | null> =>
    call<SnapshotCreated | null>("sync_snapshot_create", {
      base,
      root,
      collection,
      everything,
      force,
    }),
  snapshotFiles: (base: string, collection: string, id: string): Promise<SnapshotFile[]> =>
    call<SnapshotFile[]>("sync_snapshot_files", { base, collection, id }),
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
  /** Removes stored content nothing refers to any more; the bytes in use afterwards. */
  gc: (base: string): Promise<number | null> => call<number | null>("sync_gc", { base }),
  userFiles: (): Promise<SyncUserFile[]> => call<SyncUserFile[]>("sync_user_files"),
  userFileRead: (path: string): Promise<string | null> =>
    call<string | null>("sync_user_file_read", { path }),
  /** Writes one of the user's synced files (`text` null removes it). */
  userFileWrite: (path: string, text: string | null): Promise<SyncUserFile | null> =>
    call<SyncUserFile | null>("sync_user_file_write", { path, text }),
  /** What the sync loop keeps between runs. */
  stateLoad: (): Promise<string | null> => call<string | null>("sync_state_load"),
  stateSave: (text: string): Promise<void> => call<void>("sync_state_save", { text }),
  /** Claims the sync loop for this window; false while another window of the profile has it. */
  lease: (owner: string): Promise<boolean> => call<boolean>("sync_lease", { owner }),
};

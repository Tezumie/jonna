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
};

// Sharing a project with a team (Rust: src-tauri/src/sync/share, docs/sync.md). `base` is the
// accounts server, as for sync, and sync must be on for this device: what an account keeps of
// sharing (its member key, the teammates' keys it pinned, the keys of what it shares) is in its
// own vault. Keys never reach the front end: these calls hand over fingerprints, lists and text.
//
// A failed call's `code` says why: "ShareNoTeam", "ShareNotMember", "ShareWaiting" (the share's
// keys haven't reached this account), "ShareKeyChanged" (the sharer's key isn't the one this
// account pinned), "ShareNoMemberKey", "ShareNotSharer", "ShareGone", "ShareNotShared",
// "ShareTooMany", "ShareKeys" (keys that don't fit, or are older than the ones this computer
// saw: refused), "ShareTargetNotEmpty", "SharePins" (the list of teammates' keys couldn't be
// read as far as it was written: nothing is shared or read), "ShareKeyFilesInHistory" (commits
// that weren't pushed hold key files, which the message names: the snapshot isn't shared),
// "ShareRemoteChanged" (a copy's clone address isn't the one that was shown), and sync's own
// ("SyncLapsed", "SyncFull", "SyncOff", "SyncOffline", "SyncSignedOut"…).
import { call } from "./invoke";
import type {
  SnapshotFile,
  SnapshotFileText,
  SnapshotRestored,
  SnapshotStanding,
  SnapshotSummary,
} from "./sync";

export interface ShareMe {
  /**
   * This account's member key as a teammate checks it: 30 digits, six groups of five. It is
   * of the key and of whose key it is (the account).
   */
  fingerprint: string;
  /** The service has the key (false while the subscription is ended: it takes none then). */
  published: boolean;
}

/**
 * Where a teammate stands for this account: the service has no key for them; pinned and not
 * compared yet; verified; or the service shows another key than the one pinned (nothing is
 * shared with them, and nothing of theirs is read, until the new key is accepted).
 */
export type ShareMemberState = "nokey" | "new" | "verified" | "changed";

export interface ShareMember {
  uid: string;
  name: string;
  you: boolean;
  state: ShareMemberState;
  /** Of the pinned key (for `you`: this account's own). Null while there is none. */
  fingerprint: string | null;
  /** Of the key the service shows now, while the state is "changed". */
  pendingFingerprint: string | null;
  /** When the key was pinned, in ms. */
  pinnedAt: number | null;
}

/** The newest snapshot's label as the service read it off the record: for showing only. */
export interface ShareLatest {
  time: number | null;
  computer: string;
  kind: string;
  files: number;
  bytes: number;
  branch: string | null;
}

/**
 * Whether this account can read a share: it is its own; its keys are here; they aren't yet
 * (the sharer's computer hands them over the next time it syncs); or the sharer's key isn't
 * the one this account pinned.
 */
export type ShareState = "mine" | "ready" | "waiting" | "keyChanged";

export interface ShareInfo {
  /** `<the sharer's account>.<project>`. */
  id: string;
  project: string;
  name: string;
  chats: boolean;
  owner: { uid: string; name: string };
  mine: boolean;
  state: ShareState;
  keyVersion: number;
  rotationNeeded: boolean;
  usageBytes: number;
  updatedAt: number | null;
  latest: ShareLatest | null;
}

export interface ShareWaiting {
  uid: string;
  name: string;
  /** No key published yet; their key changed and wasn't accepted; or not verified (when only verified members get keys). */
  why: "noKey" | "keyChanged" | "notVerified";
}

/** What starting or syncing a share came to. */
export interface ShareSynced {
  id: string;
  /** The snapshot taken; null when the folder is as the share's last snapshot left it. */
  snapshot: string | null;
  /** How many key files the share's newest snapshot left out. */
  keyFiles: number;
  /** Members who were handed the keys just now. */
  wrapsAdded: number;
  /** The keys were renewed (someone left the team, or a key changed). */
  renewed: boolean;
  /** Members who don't have the keys, and why. */
  waiting: ShareWaiting[];
}

export interface SharedSnapshot {
  id: string;
  summary: SnapshotSummary;
}

export interface SharedFile extends SnapshotFile {
  /** Against the folder that was given; null when none was. */
  state: SnapshotStanding | null;
}

export interface SharedFiles {
  files: SharedFile[];
  /** How many were left uncompared (a snapshot can name more than are compared). */
  truncated: number;
  /** What the snapshot left out: [path, why] ("a key file", "too large"…). */
  skipped: [string, string][];
}

export interface ShareCopy {
  path: string;
  /** The folder was cloned from the project's remote first. */
  cloned: boolean;
  /** Said when a clone was asked for and the remote couldn't be cloned from. */
  note: string | null;
  restored: SnapshotRestored;
}

/** What a copy of a shared snapshot would do first. */
export interface ShareCopyPlan {
  /**
   * The address the folder would be cloned from (the one the sharer works from), to show
   * and ask about. Null: the project has no remote that can be shown.
   */
  remote: string | null;
}

export const shareIpc = {
  /** This account's fingerprint; makes and publishes its member key when that wasn't done. */
  me: (base: string): Promise<ShareMe> => call<ShareMe>("share_me", { base }),
  /** The team's members, each with their fingerprint and where they stand. */
  members: (base: string): Promise<ShareMember[]> => call<ShareMember[]>("share_members", { base }),
  /**
   * Marks a teammate verified or not. `fingerprint` is the one that was compared: refused
   * ("ShareKeyChanged") when it isn't the pinned key's any more.
   */
  setVerified: (base: string, uid: string, fingerprint: string, verified: boolean): Promise<void> =>
    call<void>("share_set_verified", { base, uid, fingerprint, verified }),
  /** Accepts a teammate's changed key (`fingerprint`: the new key's, as the list showed it). */
  acceptKey: (base: string, uid: string, fingerprint: string): Promise<void> =>
    call<void>("share_accept_key", { base, uid, fingerprint }),
  /** The team's shares, each with whether this account can read it. */
  list: (base: string): Promise<ShareInfo[]> => call<ShareInfo[]>("share_list", { base }),
  /**
   * Starts sharing `project` under `name` (shared already: sets the name and the chats switch)
   * and hands its keys to the members who may have them; with the open folder `root`, takes
   * its first snapshot.
   */
  start: (
    base: string,
    share: {
      root: string | null;
      project: string;
      name: string;
      chats: boolean;
      onlyVerified: boolean;
    },
  ): Promise<ShareSynced> => call<ShareSynced>("share_start", { base, ...share }),
  /** Changes a share's name and whether its chats are shared. */
  update: (base: string, project: string, name: string, chats: boolean): Promise<ShareInfo> =>
    call<ShareInfo>("share_update", { base, project, name, chats }),
  /** Stops a share (the sharer, or the team's owner): it is deleted with all it holds. */
  stop: (base: string, id: string): Promise<void> => call<void>("share_stop", { base, id }),
  /**
   * Sees to the keys of this account's share of `project`, then writes a snapshot of the open
   * folder `root` into it when the folder changed since the last one.
   */
  sync: (
    base: string,
    root: string,
    project: string,
    onlyVerified: boolean,
  ): Promise<ShareSynced> => call<ShareSynced>("share_sync", { base, root, project, onlyVerified }),
  /** A share's snapshots, newest first. */
  snapshots: (base: string, id: string): Promise<SharedSnapshot[]> =>
    call<SharedSnapshot[]>("share_snapshots", { base, id }),
  /**
   * The files a snapshot of a share holds; with the open folder `root`, each with how it
   * stands against that folder. Nothing is written.
   */
  snapshotFiles: (
    base: string,
    id: string,
    snapshot: string,
    root: string | null,
  ): Promise<SharedFiles> =>
    call<SharedFiles>("share_snapshot_files", { base, id, snapshot, root }),
  /** One file of a share's snapshot as text; null when the snapshot doesn't hold it. */
  fileText: (
    base: string,
    id: string,
    snapshot: string,
    path: string,
  ): Promise<SnapshotFileText | null> =>
    call<SnapshotFileText | null>("share_file_text", { base, id, snapshot, path }),
  /**
   * What a copy of a share's snapshot would do first: the address it would clone from, for
   * the person to see and agree to. Nothing is written, and nothing is asked of that address.
   */
  copyPlan: (base: string, id: string, snapshot: string): Promise<ShareCopyPlan> =>
    call<ShareCopyPlan>("share_copy_plan", { base, id, snapshot }),
  /**
   * Whether the open folder `root` is a clone of the repository the share is of (their git
   * remotes are one address). A reader's own sync id of the project is never the sharer's,
   * so this is how a reader's folder is known to be the shared project.
   */
  matchesFolder: (base: string, id: string, root: string): Promise<boolean> =>
    call<boolean>("share_matches_folder", { base, id, root }),
  /**
   * A copy of a share's snapshot in the new or empty folder `target`. `cloneFrom`: the
   * address `copyPlan` gave, once the person agreed to clone from it (refused with
   * "ShareRemoteChanged" when the share names another by now); null: nothing reaches out to
   * it. The clone asks nobody to sign in and is stopped when it takes too long; the copy is
   * then made of what the snapshot carries, and `note` says so. Then the snapshot goes on
   * top. The folder is not trusted.
   */
  openCopy: (
    base: string,
    id: string,
    snapshot: string,
    target: string,
    cloneFrom: string | null,
  ): Promise<ShareCopy> =>
    call<ShareCopy>("share_open_copy", {
      base,
      id,
      snapshot,
      target,
      clone: cloneFrom !== null,
      remote: cloneFrom,
    }),
};

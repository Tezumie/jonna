// How two computers' changes are joined (D435). Pure and DOM-free: each function takes what
// this computer has now, what it had when it last synced (the base), and what the account
// has, and says what to send, what to apply here, and the new base.
//
// - Settings merge by key: two different settings changed on two computers both survive; the
//   same one changed on both takes the later change (each change dated when it was first seen,
//   not by the file's time). A computer with no memory of a sync takes the account's word
//   where the two differ.
// - Files (keybindings, rules, snippets, skills...) are whole: changed on one side, that side's
//   version is taken; changed on both, the later one wins and the other is kept beside it.

/** JSON with object keys in order, so equal values are equal text. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// ---------------------------------------------------------------- settings

/** One setting as the account has it: its value, or that it was removed, and when. */
export interface SettingEntry {
  /** The value (absent when removed). */
  v?: unknown;
  /** Removed. */
  d?: true;
  /** When, in ms. */
  t: number;
}

/** The synced settings record. */
export interface SettingsRecord {
  keys: Record<string, SettingEntry>;
}

export interface SettingsMergeInput {
  /** The user settings file's top-level keys now. */
  local: Record<string, unknown>;
  /** Key to the canonical JSON of its value at the last sync (absent: it wasn't set). */
  base: Record<string, string>;
  remote: SettingsRecord | null;
  /**
   * When the settings file last changed: the date of a change here that has none of its own
   * in `localTimes`. The file is also written for reasons that aren't the person's (the app's
   * own notes in it), so this alone can make an old change look new.
   */
  localTime: number;
  /** When each setting changed here was first seen changed (`stampSettings`), by key. */
  localTimes?: Readonly<Record<string, number>>;
  /**
   * Whether this computer remembers a sync (absent: whether `base` has anything). Without one
   * (a computer joining, or one that lost what it kept) nothing says which side changed, so
   * the account's word is taken where the two differ.
   */
  hasBase?: boolean;
  /**
   * The memory of a sync was dropped because the account's sync says it was set up again
   * (another epoch), not because this computer is new to it. That is the service's word:
   * where the two differ, this computer's value stays and goes to the account (`kept`),
   * instead of the account's replacing it. A service that could force "set up again" could
   * otherwise bring back older settings on every computer.
   */
  keepLocal?: boolean;
  /** Settings that stay on this computer. */
  skip: (key: string) => boolean;
}

export interface SettingsMergeResult {
  record: SettingsRecord;
  /** Whether `record` differs from `remote` (it needs writing). */
  recordChanged: boolean;
  /** What to change in the settings file here; `value` undefined removes the key. */
  apply: { key: string; value: unknown }[];
  base: Record<string, string>;
  /**
   * Values this computer had that gave way to the account's with no history to go by (each is
   * in `apply` too): to be said, so they aren't lost unseen.
   */
  replaced: { key: string; value: unknown }[];
  /**
   * Values this computer kept where the account's differed, after the account's sync was set
   * up again (`keepLocal`): `value` is the account's, which wasn't applied. To be said.
   */
  kept: { key: string; value: unknown }[];
}

/** When a setting changed here was first seen changed: the value it had then, and the time. */
export interface SettingStamp {
  /** The value's canonical JSON ("" when the setting was removed). */
  c: string;
  /** In ms. */
  t: number;
}

/**
 * Dates the settings changed here since the last sync, each at the moment it is first seen to
 * differ from the base (called at every pass, also the ones that can't reach the account).
 * `seenAt` is the settings file's time when that is known and not in the future, else now: the
 * file's time can only be later than the change, never earlier, and a stamp, once made, stays
 * while the value does. So a later rewrite of the file (the app noting something of its own in
 * it) no longer makes an old change look new. Returns the stamps to keep; `changed` says
 * whether they differ from `stamps`.
 */
export function stampSettings(input: {
  local: Record<string, unknown>;
  base: Readonly<Record<string, string>>;
  stamps: Readonly<Record<string, SettingStamp>>;
  seenAt: number;
  skip: (key: string) => boolean;
}): { stamps: Record<string, SettingStamp>; changed: boolean } {
  const stamps: Record<string, SettingStamp> = {};
  for (const key of new Set([...Object.keys(input.local), ...Object.keys(input.base)])) {
    if (key === "__proto__" || input.skip(key)) continue;
    const now = Object.hasOwn(input.local, key) ? canonical(input.local[key]) : undefined;
    if (now === (Object.hasOwn(input.base, key) ? input.base[key] : undefined)) continue;
    const before = Object.hasOwn(input.stamps, key) ? input.stamps[key] : undefined;
    stamps[key] = before && before.c === (now ?? "") ? before : { c: now ?? "", t: input.seenAt };
  }
  return { stamps, changed: canonical(stamps) !== canonical(input.stamps) };
}

export function mergeSettings(input: SettingsMergeInput): SettingsMergeResult {
  const record: SettingsRecord = { keys: { ...(input.remote?.keys ?? {}) } };
  const base: Record<string, string> = {};
  const apply: { key: string; value: unknown }[] = [];
  const replaced: { key: string; value: unknown }[] = [];
  const kept: { key: string; value: unknown }[] = [];
  const hasBase = input.hasBase ?? Object.keys(input.base).length > 0;
  let recordChanged = false;
  const keys = new Set([
    ...Object.keys(input.local),
    ...Object.keys(input.base),
    ...Object.keys(record.keys),
  ]);
  for (const key of keys) {
    if (input.skip(key)) continue;
    const local = key in input.local ? canonical(input.local[key]) : undefined;
    const before = input.base[key];
    const entry = record.keys[key];
    // The account's value: what it says, or (when it never heard of the key) no opinion.
    const remote = entry ? (entry.d ? undefined : canonical(entry.v)) : before;
    const localChanged = local !== before;
    const remoteChanged = entry !== undefined && remote !== before;
    // When the change here was made: its own date when it has one, else the file's.
    const localTime = input.localTimes?.[key] ?? input.localTime;
    const takeLocal = () => {
      record.keys[key] =
        local === undefined ? { d: true, t: localTime } : { v: input.local[key], t: localTime };
      recordChanged = true;
      if (local !== undefined) base[key] = local;
    };
    const takeRemote = () => {
      apply.push({ key, value: entry?.d ? undefined : entry?.v });
      if (remote !== undefined) base[key] = remote;
    };
    if (!hasBase && entry !== undefined && local !== undefined && local !== remote) {
      if (input.keepLocal) {
        // The memory is gone on the service's word (the account's sync was "set up again"):
        // what is here stays, and is what the account gets.
        kept.push({ key, value: entry.d ? undefined : entry.v });
        takeLocal();
      } else {
        // No memory of a sync, and the two differ (the account has another value, or says
        // the setting was removed): nothing tells an old value here from a new one, so the
        // account's stands, and a setting removed elsewhere isn't brought back.
        replaced.push({ key, value: input.local[key] });
        takeRemote();
      }
    } else if (localChanged && remoteChanged) {
      if (local === remote) {
        if (local !== undefined) base[key] = local;
      } else if ((entry?.t ?? 0) > localTime) takeRemote();
      else takeLocal();
    } else if (localChanged) takeLocal();
    else if (remoteChanged) takeRemote();
    else if (before !== undefined) base[key] = before;
  }
  return { record, recordChanged, apply, base, replaced, kept };
}

// ---------------------------------------------------------------- files

/** A file here now. */
export interface LocalFile {
  hash: string;
  mtimeMs: number;
}

/** A file as the account has it. */
export interface RemoteFile {
  version: number;
  deleted: boolean;
  /** The content's hash (absent when deleted). */
  hash?: string;
  /** When that content was last changed on the computer that sent it. */
  mtimeMs?: number;
}

/** What this computer last synced for a file: the content, and the account's version of it. */
export interface FileBase {
  /** Absent: the file was deleted as of that sync. */
  hash?: string;
  version: number;
}

export type FileAction =
  /** Send this computer's file (over `expect`). */
  | { kind: "upload"; path: string; expect: number | null }
  /** Tell the account the file was deleted here. */
  | { kind: "deleteRemote"; path: string; expect: number }
  /** Write the account's file here. */
  | { kind: "download"; path: string }
  | { kind: "deleteLocal"; path: string }
  /** Both sides already agree: only the base needs to say so. */
  | { kind: "adopt"; path: string }
  /** Both changed: `winner`'s content becomes the file; the other is kept beside it. */
  | { kind: "conflict"; path: string; winner: "local" | "remote"; expect: number };

export function planFiles(
  local: ReadonlyMap<string, LocalFile>,
  base: Readonly<Record<string, FileBase>>,
  remote: ReadonlyMap<string, RemoteFile>,
): FileAction[] {
  const actions: FileAction[] = [];
  const paths = new Set([...local.keys(), ...Object.keys(base), ...remote.keys()]);
  for (const path of [...paths].sort()) {
    const here = local.get(path);
    const before = base[path];
    const there = remote.get(path);
    const thereHash = there && !there.deleted ? there.hash : undefined;
    const localChanged = here?.hash !== before?.hash;
    // The account moved on when its version isn't the one this computer synced.
    const remoteChanged = there !== undefined && there.version !== (before?.version ?? 0);
    if (!localChanged && !remoteChanged) continue;
    if (localChanged && !remoteChanged) {
      if (here) actions.push({ kind: "upload", path, expect: there ? there.version : null });
      else if (there && !there.deleted) {
        actions.push({ kind: "deleteRemote", path, expect: there.version });
      }
      continue;
    }
    if (!there) continue;
    if (!localChanged) {
      if (there.deleted) {
        if (here) actions.push({ kind: "deleteLocal", path });
      } else actions.push({ kind: "download", path });
      continue;
    }
    // Both changed. The same content on both sides is no conflict.
    if (here?.hash === thereHash) {
      actions.push({ kind: "adopt", path });
      continue;
    }
    // A delete never beats a change: the changed file is kept.
    if (!here) actions.push({ kind: "download", path });
    else if (there.deleted) actions.push({ kind: "upload", path, expect: there.version });
    else {
      const winner = (there.mtimeMs ?? 0) > here.mtimeMs ? "remote" : "local";
      actions.push({ kind: "conflict", path, winner, expect: there.version });
    }
  }
  return actions;
}

/**
 * Where the losing side of a conflict is kept, beside the file: `name.conflict.ext`, and for
 * the ones after it (`copy` 2, 3...) `name.conflict-2.ext`, so an earlier copy isn't written
 * over.
 */
export function conflictPath(path: string, copy = 1): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const mark = copy > 1 ? `.conflict-${Math.floor(copy)}` : ".conflict";
  return dot > slash + 1 ? `${path.slice(0, dot)}${mark}${path.slice(dot)}` : `${path}${mark}`;
}

/** Whether a name is a conflict copy (`conflictPath`): kept beside its file, never synced. */
export function isConflictCopy(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return /\.conflict(-\d+)?(\.|$)/.test(name);
}

/** A record id for a file path: readable for ordinary names, never longer than a record id. */
export function fileRecordId(path: string): string {
  let out = "";
  for (const ch of path) {
    if (/[A-Za-z0-9.-]/.test(ch)) out += ch;
    else if (ch === "/") out += "__";
    else out += `_${ch.codePointAt(0)?.toString(16) ?? "0"}_`;
  }
  if (out.length <= 72) return out;
  // Two 32-bit hashes of the whole path keep long names apart.
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b + c, 0x9e3779b1) >>> 0;
  }
  return `${out.slice(0, 54)}-${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

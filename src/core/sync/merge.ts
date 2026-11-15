// How two computers' changes are joined (D435). Pure and DOM-free: each function takes what
// this computer has now, what it had when it last synced (the base), and what the account
// has, and says what to send, what to apply here, and the new base.
//
// - Settings merge by key: two different settings changed on two computers both survive; the
//   same one changed on both takes the later change.
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
  /** When the settings file last changed (its changes are dated by it). */
  localTime: number;
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
}

export function mergeSettings(input: SettingsMergeInput): SettingsMergeResult {
  const record: SettingsRecord = { keys: { ...(input.remote?.keys ?? {}) } };
  const base: Record<string, string> = {};
  const apply: { key: string; value: unknown }[] = [];
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
    const takeLocal = () => {
      record.keys[key] =
        local === undefined
          ? { d: true, t: input.localTime }
          : { v: input.local[key], t: input.localTime };
      recordChanged = true;
      if (local !== undefined) base[key] = local;
    };
    const takeRemote = () => {
      apply.push({ key, value: entry?.d ? undefined : entry?.v });
      if (remote !== undefined) base[key] = remote;
    };
    if (localChanged && remoteChanged) {
      if (local === remote) {
        if (local !== undefined) base[key] = local;
      } else if ((entry?.t ?? 0) > input.localTime) takeRemote();
      else takeLocal();
    } else if (localChanged) takeLocal();
    else if (remoteChanged) takeRemote();
    else if (before !== undefined) base[key] = before;
  }
  return { record, recordChanged, apply, base };
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

/** Where the losing side of a conflict is kept: `name.conflict.ext`, beside the file. */
export function conflictPath(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash + 1 ? `${path.slice(0, dot)}.conflict${path.slice(dot)}` : `${path}.conflict`;
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

// The workspace's folders for extensions (D251, VS Code's multi-root workspaces), worker side,
// and the checks the host shares: a mirror of the folders behind VS Code's synchronous
// `workspace.workspaceFolders` / `rootPath` / `name` / `workspaceFile` (the host sends it when
// the worker starts and again whenever it changes, "fs.read" only), getWorkspaceFolder,
// asRelativePath, onDidChangeWorkspaceFolders, updateWorkspaceFolders (VS Code's splice
// semantics: checked here, and again on the host against the real list), the folder a watcher's
// or findFiles' glob is relative to, and the gate every extension path goes through.
// DOM-free, unit-tested.
import { basename, isAbsolute, samePath } from "../paths/index";
import { folderOf, type WorkspaceFolder } from "../workspace/workspaceFile";
import type { Disposable } from "./rpc";
import type { Request } from "./rpcTerminals";

export type { WorkspaceFolder } from "../workspace/workspaceFile";

/** What the worker knows of the workspace (sent by the host; none without "fs.read"). */
export interface WorkspaceSnapshot {
  /** Every folder, the first (the primary) first; empty with nothing open. */
  folders: WorkspaceFolder[];
  /** The workspace's name as the IDE shows it; null with nothing open. */
  name: string | null;
  /** The `.code-workspace` file of a multi-root workspace; null for a single folder. */
  file: string | null;
}

/** Folders added to or taken out of the workspace (not when it opens or closes). */
export interface WorkspaceFoldersChange {
  readonly added: readonly WorkspaceFolder[];
  readonly removed: readonly WorkspaceFolder[];
}

/** A folder for updateWorkspaceFolders: an absolute path, and the name to show (optional). */
export interface FolderToAdd {
  path: string;
  name?: string;
}

/**
 * VS Code's RelativePattern: `pattern` matched against paths relative to `base` (a workspace
 * folder, or any absolute folder path).
 */
export interface RelativePattern {
  base: string | { path: string };
  pattern: string;
}

export type GlobPattern = string | RelativePattern;

export interface WorkspaceFoldersApi {
  /** The folders (VS Code's workspaceFolders): undefined with nothing open (or without "fs.read"). */
  readonly workspaceFolders: readonly WorkspaceFolder[] | undefined;
  /** The first folder's path (VS Code's deprecated rootPath). */
  readonly rootPath: string | undefined;
  /** The workspace's name: the folder's, or "<file> (Workspace)" for a multi-root one. */
  readonly name: string | undefined;
  /** The `.code-workspace` file of a multi-root workspace; undefined for a single folder. */
  readonly workspaceFile: string | undefined;
  /** The folder holding an absolute `path` (the innermost when folders nest). */
  getWorkspaceFolder(path: string): WorkspaceFolder | undefined;
  /**
   * `path` relative to its folder, with "/" (the folder's name in front when there are several,
   * or as `includeWorkspaceFolder` says); a path outside every folder comes back as it is.
   */
  asRelativePath(path: string, includeWorkspaceFolder?: boolean): string;
  /** Folders were added or taken out ("fs.read"). */
  onDidChangeWorkspaceFolders(listener: (event: WorkspaceFoldersChange) => void): Disposable;
  /**
   * VS Code's updateWorkspaceFolders: removes `deleteCount` folders from `start` and adds
   * `foldersToAdd` there. False when the input is invalid, nothing would change, or an update is
   * still under way; else true, and the change happens (the user is asked before folders are
   * added; they go at the end, with their folder's name). "fs.read" and "fs.write".
   */
  updateWorkspaceFolders(
    start: number,
    deleteCount: number | undefined | null,
    ...foldersToAdd: FolderToAdd[]
  ): boolean;
  /** Every folder, asked of the IDE ("fs.read"); [] with nothing open. */
  folders(): Promise<WorkspaceFolder[]>;
  /** The folder holding `path` (absolute, or relative as the fs calls take it), else null. */
  folderOf(path: string): Promise<WorkspaceFolder | null>;
  /** Same as onDidChangeWorkspaceFolders. */
  onDidChangeFolders(listener: (event: WorkspaceFoldersChange) => void): Disposable;
}

// ---- Pure helpers (shared with the host) -----------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function readFolder(v: unknown): WorkspaceFolder | null {
  if (!isRecord(v) || typeof v.path !== "string" || !v.path) return null;
  return {
    path: v.path,
    name: typeof v.name === "string" && v.name ? v.name : basename(v.path) || v.path,
    index: typeof v.index === "number" ? v.index : 0,
  };
}

/** A snapshot as the host sent it, checked; undefined for anything else. */
export function readSnapshot(v: unknown): WorkspaceSnapshot | undefined {
  if (!isRecord(v) || !Array.isArray(v.folders)) return undefined;
  const folders = v.folders.flatMap((f) => readFolder(f) ?? []);
  return {
    folders: folders.map((f, index) => ({ ...f, index })),
    name: typeof v.name === "string" ? v.name : null,
    file: typeof v.file === "string" ? v.file : null,
  };
}

function readFolders(v: unknown): WorkspaceFolder[] {
  return Array.isArray(v) ? v.flatMap((f) => readFolder(f) ?? []) : [];
}

/** VS Code's getWorkspaceFolder: the folder holding an absolute `path` (innermost), if any. */
export function getWorkspaceFolder<T extends { path: string }>(
  folders: readonly T[],
  path: unknown,
): T | undefined {
  if (typeof path !== "string" || !isAbsolute(path)) return undefined;
  return folderOf(folders, path);
}

/**
 * VS Code's asRelativePath: relative to the folder holding `path`, with "/". A folder itself
 * counts as in the folder around it (VS Code's resolveParent), so a lone folder's own path comes
 * back unchanged. The folder's name goes in front when `includeWorkspaceFolder` is true, or
 * (left out) when there are several folders.
 */
export function asRelativePath(
  folders: readonly WorkspaceFolder[],
  path: unknown,
  includeWorkspaceFolder?: boolean,
): string {
  if (typeof path !== "string") return "";
  const owner = folderOf(
    folders.filter((f) => !samePath(f.path, path)),
    path,
  );
  if (!owner) return path;
  const include =
    typeof includeWorkspaceFolder === "boolean" ? includeWorkspaceFolder : folders.length > 1;
  const rel = relativeTo(owner.path, path) ?? "";
  return include && owner.name ? `${owner.name}/${rel}` : rel;
}

/** What updateWorkspaceFolders will do: the folders after it, and those added and removed. */
export interface FolderUpdatePlan {
  next: { path: string; name: string }[];
  added: { path: string; name: string }[];
  removed: { path: string; name: string }[];
}

/**
 * VS Code's updateWorkspaceFolders checks, on `current`: whole numbers (deleteCount null or
 * undefined is 0), something to add or remove, no more removed than there are, every folder to
 * add an absolute path (repeats of one are dropped), no folder twice afterwards, and a real
 * change. The IDE adds folders at the end and takes them out (it doesn't reorder or rename them
 * through this call), so a change that only reorders or renames is null too, and so is one that
 * would leave no folder (closing the workspace is the user's). Null means "return false".
 */
export function planFolderUpdate(
  current: readonly { path: string; name: string }[],
  start: unknown,
  deleteCount: unknown,
  foldersToAdd: readonly unknown[],
): FolderUpdatePlan | null {
  const count = deleteCount === undefined || deleteCount === null ? 0 : deleteCount;
  if (!isWholeNumber(start) || !isWholeNumber(count)) return null;
  const toAdd: { path: string; name: string }[] = [];
  for (const raw of foldersToAdd) {
    if (!isRecord(raw) || typeof raw.path !== "string" || !isAbsolute(raw.path)) return null;
    if (raw.name !== undefined && typeof raw.name !== "string") return null;
    const path = raw.path;
    if (toAdd.some((f) => samePath(f.path, path))) continue;
    toAdd.push({ path, name: (raw.name as string | undefined) || basename(path) || path });
  }
  if (count === 0 && !toAdd.length) return null;
  if (start + count > current.length) return null;
  const next = current.map((f) => ({ path: f.path, name: f.name }));
  next.splice(start, count, ...toAdd);
  for (const [i, f] of next.entries())
    if (next.some((other, j) => j !== i && samePath(other.path, f.path))) return null;
  const added = next.filter((f) => !current.some((c) => samePath(c.path, f.path)));
  const removed = current
    .filter((c) => !next.some((f) => samePath(c.path, f.path)))
    .map((f) => ({ path: f.path, name: f.name }));
  if ((!added.length && !removed.length) || !next.length) return null;
  return { next, added, removed };
}

function isWholeNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** `path` relative to `root`, with "/" (null when it isn't inside, or is `root` itself). */
export function relativeTo(root: string, path: string): string | null {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const r = norm(root);
  const p = norm(path);
  // Windows paths compare without case.
  const windows = /^[a-z]:\//i.test(r) || r.startsWith("//");
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (p.length <= r.length + 1 || !same(p.slice(0, r.length), r) || p[r.length] !== "/")
    return null;
  return p.slice(r.length + 1);
}

/** The base folder of a RelativePattern (a path, or a workspace folder), else null. */
export function patternBase(pattern: unknown): string | null {
  if (!isRecord(pattern) || typeof pattern.pattern !== "string") return null;
  const base = pattern.base;
  if (typeof base === "string") return base || null;
  if (isRecord(base) && typeof base.path === "string") return base.path || null;
  return null;
}

/**
 * The paths a glob is tested against for `path` (D251): for a RelativePattern, `path` relative to
 * its base; for a plain glob, relative to each folder holding it (a file in a nested folder is
 * tried against both). Empty when `path` is in none of them.
 */
export function relativeCandidates(
  folders: readonly { path: string }[],
  base: string | null,
  path: string,
): string[] {
  if (base !== null) {
    const rel = relativeTo(base, path);
    return rel === null ? [] : [rel];
  }
  return folders.flatMap((f) => relativeTo(f.path, path) ?? []);
}

/** What the extension path gate needs of the workspace (the WorkspaceService). */
export interface WorkspaceGate {
  root: string | null;
  /** More than one folder: the messages say "the workspace's folders". */
  multiRoot: boolean;
  resolve(path: string): string;
  contains(path: string): boolean;
}

/**
 * A path from an extension made absolute (D251): relative ones as the workspace resolves them
 * (to the first folder, or a folder named first: "api/src/x.ts"), and only inside one of the
 * workspace's folders. With one folder it's what it always was (`resolveInRoot` + `isWithin`).
 */
export function gateWorkspacePath(ws: WorkspaceGate, path: unknown): string {
  if (!ws.root) throw new Error("No folder is open.");
  if (typeof path !== "string") throw new Error("path must be a string");
  const full = ws.resolve(path);
  if (!ws.contains(full))
    throw new Error(
      ws.multiRoot
        ? `${path} is outside the workspace's folders.`
        : `${path} is outside the open folder.`,
    );
  return full;
}

// ---- Worker side ---------------------------------------------------------------------------

function frozenFolders(folders: readonly WorkspaceFolder[]): readonly WorkspaceFolder[] {
  return Object.freeze(folders.map((f) => Object.freeze({ ...f })));
}

/**
 * The worker's mirror of the folders and the API on it. `receive` takes the host's "workspace"
 * calls: "snapshot" (the folders changed: a rename, the workspace opened, closed or saved under a
 * name) and "changed" ({ snapshot, added, removed }: folders added or taken out).
 */
export function createWorkspaceFolders(
  request: Request,
  initial: unknown,
): { api: WorkspaceFoldersApi; receive(target: string, args: unknown): void } {
  let snapshot = readSnapshot(initial);
  let shown = frozenFolders(snapshot?.folders ?? []);
  /** An update sent and not answered yet (VS Code refuses another until it's confirmed). */
  let updating = false;
  const listeners = new Set<(event: WorkspaceFoldersChange) => void>();
  const take = (next: WorkspaceSnapshot | undefined) => {
    snapshot = next;
    shown = frozenFolders(next?.folders ?? []);
  };
  const onChange = (listener: (event: WorkspaceFoldersChange) => void): Disposable => {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
  };
  const api: WorkspaceFoldersApi = {
    get workspaceFolders() {
      return shown.length ? shown : undefined;
    },
    get rootPath() {
      return shown[0]?.path;
    },
    get name() {
      return snapshot?.name ?? undefined;
    },
    get workspaceFile() {
      return snapshot?.file ?? undefined;
    },
    getWorkspaceFolder: (path) => getWorkspaceFolder(shown, path),
    asRelativePath: (path, includeWorkspaceFolder) =>
      asRelativePath(shown, path, includeWorkspaceFolder),
    onDidChangeWorkspaceFolders: onChange,
    onDidChangeFolders: onChange,
    updateWorkspaceFolders(start, deleteCount, ...foldersToAdd) {
      if (!snapshot || updating) return false;
      const plan = planFolderUpdate(snapshot.folders, start, deleteCount, foldersToAdd);
      if (!plan) return false;
      updating = true;
      void request("workspace.updateFolders", {
        start,
        deleteCount: deleteCount ?? 0,
        folders: foldersToAdd.map((f) => ({
          path: f.path,
          ...(typeof f.name === "string" && { name: f.name }),
        })),
      })
        .catch((err: unknown) => console.error(err instanceof Error ? err.message : String(err)))
        .finally(() => {
          updating = false;
        });
      return true;
    },
    folders: () => request<unknown>("workspace.folders").then(readFolders),
    folderOf: (path) =>
      request<unknown>("workspace.folderOf", { path: String(path) }).then(
        (f) => readFolder(f) ?? null,
      ),
  };
  return {
    api,
    receive(target, args) {
      if (target === "snapshot") {
        take(readSnapshot(args));
        return;
      }
      if (target !== "changed" || !isRecord(args)) return;
      take(readSnapshot(args.snapshot));
      const event: WorkspaceFoldersChange = Object.freeze({
        added: frozenFolders(readFolders(args.added)),
        removed: frozenFolders(readFolders(args.removed)),
      });
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
        }
      }
    },
  };
}

/** Adds the folder API's properties to `target` (its getters stay getters, unlike a spread). */
export function withWorkspaceFolders<T extends object>(
  target: T,
  folders: WorkspaceFoldersApi,
): T & WorkspaceFoldersApi {
  Object.defineProperties(target, Object.getOwnPropertyDescriptors(folders));
  return target as T & WorkspaceFoldersApi;
}

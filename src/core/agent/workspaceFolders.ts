// The agent and a workspace's folders (D251): how a path the model writes is resolved, whether it
// stays inside the workspace (the file sandbox), and which `.aiignore` rules apply to it. With
// one folder everything is exactly what it was with `resolveInRoot(root, …)` / `isWithin(root, …)`.
// With several, a relative path may start with a folder's name ("api/src/x.ts", as the workspace
// writes paths), anything else is relative to the first folder, and a path is inside the
// workspace when it's inside any of its folders. DOM-free and tested.

import {
  basename,
  isAbsolute,
  isWithin,
  joinPath,
  relativePath,
  resolveInRoot,
} from "../paths/index";
import { folderOf } from "../workspace/workspaceFile";
import type { AgentIgnore } from "./ignore";

/** A folder of the workspace as the agent sees it. */
export interface AgentFolder {
  path: string;
  name: string;
}

/** The folders to work with: `folders`, else the single `primary` (nothing open: none). */
export function foldersOrPrimary(
  folders: readonly AgentFolder[],
  primary: string | null,
): readonly AgentFolder[] {
  if (folders.length) return folders;
  return primary ? [{ path: primary, name: basename(primary) || primary }] : [];
}

/**
 * `path` made absolute as the workspace resolves it (WorkspaceService.resolve): absolute as is
 * (spelled with its folder's case), a folder's name in front picks that folder (multi-root only),
 * anything else is relative to the first folder.
 */
export function resolveInFolders(folders: readonly AgentFolder[], path: string): string {
  const root = folders[0]?.path ?? "";
  if (folders.length <= 1 || isAbsolute(path)) {
    const owner = isAbsolute(path) ? folderOf(folders, path) : undefined;
    return resolveInRoot(owner?.path ?? root, path);
  }
  const clean = path.replace(/^\.?[\\/]+/, "");
  const [head, ...rest] = clean.split(/[\\/]/);
  const named = folders.find((f) => f.name === head);
  if (named) return rest.length ? resolveInRoot(named.path, rest.join("/")) : named.path;
  return resolveInRoot(root, path);
}

/** Whether `abs` is one of the folders or inside one. */
export function inFolders(folders: readonly AgentFolder[], abs: string): boolean {
  return folders.some((f) => isWithin(f.path, abs));
}

/**
 * The agent's file sandbox: `path` resolved, when it lands inside one of the folders; null for
 * anything else (outside every folder, `..` out of one, nothing open). `..` is collapsed before
 * the check, so "api/../../x" is judged as the path it is.
 */
export function sandboxPath(folders: readonly AgentFolder[], path: string): string | null {
  if (!folders.length) return null;
  const abs = resolveInFolders(folders, path);
  return inFolders(folders, abs) ? abs : null;
}

/**
 * `abs` as the workspace shows it (WorkspaceService.relative): relative to the first folder with
 * one folder; with several, its folder's name in front ("api/src/x.ts"). Outside: unchanged.
 */
export function relativeInFolders(folders: readonly AgentFolder[], abs: string): string {
  if (folders.length <= 1) {
    const root = folders[0]?.path;
    return root ? relativePath(root, abs) : abs;
  }
  const f = folderOf(folders, abs);
  if (!f) return abs;
  const rel = relativePath(f.path, abs);
  return rel ? `${f.name}/${rel}` : f.name;
}

/**
 * The relative spellings a path pattern (agent.autoApprove, written relative to "the folder") is
 * matched against: the workspace's (`relativeInFolders`) and, with several folders, also relative
 * to the folder holding it ("src/x.ts" in "api"). A rule that asks on either asks.
 */
export function pathReadings(folders: readonly AgentFolder[], abs: string): string[] {
  const shown = relativeInFolders(folders, abs);
  if (folders.length <= 1) return [shown];
  const owner = folderOf(folders, abs);
  const own = owner ? relativePath(owner.path, abs) : shown;
  return own === shown ? [shown] : [shown, own];
}

/**
 * The paths a command's input names (`path`, `paths`, `uri`, `file`, `files`, `from`, `to`), made
 * absolute: one inside a folder as is; with several folders one starting with a folder's name in
 * that folder; anything else joined onto the first folder (as it always was: "../x" stays
 * "<root>/../x", which the ignore rules then judge by its spelling).
 */
export function inputPathsIn(folders: readonly AgentFolder[], input: unknown): string[] {
  const root = folders[0]?.path;
  if (!root || !input || typeof input !== "object") return [];
  const values: unknown[] = [];
  for (const key of ["path", "paths", "uri", "file", "files", "from", "to"]) {
    const v = (input as Record<string, unknown>)[key];
    if (Array.isArray(v)) values.push(...v);
    else values.push(v);
  }
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== "string" || !v) continue;
    out.push(inputPathIn(folders, v.replace(/^file:\/\//, "")));
  }
  return out;
}

/** One input path, absolute (see inputPathsIn). */
export function inputPathIn(folders: readonly AgentFolder[], value: string): string {
  const root = folders[0]?.path ?? "";
  if (inFolders(folders, value)) return value;
  if (folders.length > 1 && !isAbsolute(value)) {
    const [head, ...rest] = value.replace(/^\.?[\\/]+/, "").split(/[\\/]/);
    const named = folders.find((f) => f.name === head);
    if (named) return rest.length ? resolveInRoot(named.path, rest.join("/")) : named.path;
  }
  return joinPath(root, value);
}

/** A folder's own `.aiignore` matcher (its rule files, the defaults and agent.ignoreFiles). */
export interface FolderIgnore {
  folder: AgentFolder;
  matcher: AgentIgnore;
}

/**
 * The ignore rules of every folder (D199, D251): each folder's files are judged by that folder's
 * rules, relative to that folder. A file inside nested folders is excluded when any of them
 * excludes it (a package folder's `!rule` can't bring back what its repository's rules hide).
 */
export class FolderIgnores {
  constructor(readonly entries: readonly FolderIgnore[]) {}

  /** Whether any folder has rules. */
  get size(): number {
    return this.entries.reduce((n, e) => n + e.matcher.size, 0);
  }

  /** Whether `abs` is excluded. False outside every folder (the tools refuse that anyway). */
  ignored(abs: string, isDir = false): boolean {
    for (const e of this.entries) {
      if (!e.matcher.size || !isWithin(e.folder.path, abs)) continue;
      const rel = relativePath(e.folder.path, abs);
      if (rel && rel !== "." && e.matcher.ignored(rel, isDir)) return true;
    }
    return false;
  }

  /**
   * Whether a workspace-relative path is excluded (search and find results, as the workspace
   * writes them). One folder: matched as given (as it always was). Several: by the folder its
   * name picks, and also as a path in the first folder — a name that is also a subfolder of the
   * first folder is excluded when either reading excludes it.
   */
  ignoredRel(rel: string, isDir = false): boolean {
    if (isAbsolute(rel)) return this.ignored(rel, isDir);
    const first = this.entries[0];
    if (!first) return false;
    if (first.matcher.size && first.matcher.ignored(rel, isDir)) return true;
    if (this.entries.length <= 1) return false;
    const folders = this.entries.map((e) => e.folder);
    const [head] = rel.replace(/^\.?[\\/]+/, "").split(/[\\/]/);
    if (!folders.some((f) => f.name === head)) return false;
    return this.ignored(resolveInFolders(folders, rel), isDir);
  }

  /** Whether `rel`, relative to the first folder (a helper's worktree of it), is excluded. */
  ignoredInFirst(rel: string, isDir = false): boolean {
    const first = this.entries[0];
    return !!first?.matcher.size && first.matcher.ignored(rel, isDir);
  }
}

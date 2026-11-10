// Multi-root workspaces (D251): the `.code-workspace` file VS Code writes, read and edited here.
// A JSONC object with `folders` ([{ path, name? }]: relative to the file's folder or absolute),
// `settings` (the workspace's own settings layer), and `launch` / `tasks` (workspace-wide ones).
// DOM-free: the workbench reads the file through IPC and keeps the parsed result.

import {
  basename,
  dirname,
  isWindowsPath,
  isWithin,
  relativePath,
  resolveInRoot,
  samePath,
} from "../paths/index";
import { parseJsonc } from "../settings/jsonc";
import { setJsoncNestedProperty, setJsoncProperty } from "../settings/jsoncEdit";

export const WORKSPACE_EXTENSION = ".code-workspace";

/** A folder as the file writes it. */
export interface WorkspaceFolderEntry {
  path: string;
  name?: string;
}

/** A folder of the open workspace: absolute path, the name shown for it, its place. */
export interface WorkspaceFolder {
  path: string;
  name: string;
  index: number;
}

export interface WorkspaceFileData {
  folders: WorkspaceFolderEntry[];
  /** The workspace's settings layer (between the user's and each folder's). */
  settings: Record<string, unknown>;
  /** Workspace-wide launch configurations and compounds (`launch.configurations`, `compounds`). */
  launch: Record<string, unknown> | null;
  /** Workspace-wide tasks (`tasks.tasks`). */
  tasks: Record<string, unknown> | null;
  /** Entries the file had that can't be used here (a remote `uri`), for a notice. */
  skipped: string[];
}

export type WorkspaceFileResult =
  | { ok: true; data: WorkspaceFileData }
  | { ok: false; error: string };

/** True for a path whose name ends in `.code-workspace` (any case). */
export function isWorkspaceFile(path: string): boolean {
  return basename(path).toLowerCase().endsWith(WORKSPACE_EXTENSION);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A `file:` URI's path ("file:///c%3A/x" → "c:/x", "file:///home/me" → "/home/me"); null for any
 * other scheme (VS Code's remote URIs can't be opened as local folders).
 */
export function fileUriPath(uri: string): string | null {
  const m = /^file:\/\/([^/]*)(\/.*)?$/i.exec(uri.trim());
  if (!m) return null;
  let path: string;
  try {
    path = decodeURIComponent(m[2] ?? "/");
  } catch {
    return null;
  }
  // A drive letter after the slash ("/c:/x") is a Windows path.
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  // A host ("file://server/share") is a UNC path.
  if (m[1]) path = `\\\\${m[1]}${path.replaceAll("/", "\\")}`;
  return path;
}

/** Parses a workspace file's text; folders without a usable path are skipped (and listed). */
export function parseWorkspaceFile(text: string): WorkspaceFileResult {
  // An empty file is a workspace with no folders yet (a new untitled one being written).
  if (!text.trim()) {
    return {
      ok: true,
      data: { folders: [], settings: {}, launch: null, tasks: null, skipped: [] },
    };
  }
  const parsed = parseJsonc(text);
  if (!parsed.ok)
    return {
      ok: false,
      error: `Syntax error on line ${parsed.error.line}: ${parsed.error.message}`,
    };
  if (!isObject(parsed.value)) return { ok: false, error: "A workspace file must be an object." };
  const doc = parsed.value;
  const folders: WorkspaceFolderEntry[] = [];
  const skipped: string[] = [];
  for (const raw of Array.isArray(doc.folders) ? doc.folders : []) {
    if (!isObject(raw)) continue;
    const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : undefined;
    let path: string | null = null;
    if (typeof raw.path === "string" && raw.path.trim()) path = raw.path.trim();
    else if (typeof raw.uri === "string") {
      path = fileUriPath(raw.uri);
      if (path === null) skipped.push(raw.uri);
    }
    if (path) folders.push({ path, ...(name && { name }) });
  }
  return {
    ok: true,
    data: {
      folders,
      settings: isObject(doc.settings) ? doc.settings : {},
      launch: isObject(doc.launch) ? doc.launch : null,
      tasks: isObject(doc.tasks) ? doc.tasks : null,
      skipped,
    },
  };
}

/**
 * The file's folders as absolute paths (relative ones against the file's own folder), with the
 * names shown for them (the entry's `name`, else the folder's name). A folder listed twice
 * counts once (the first).
 */
export function resolveFolders(
  workspaceFile: string,
  entries: readonly WorkspaceFolderEntry[],
): WorkspaceFolder[] {
  const base = dirname(workspaceFile);
  const out: WorkspaceFolder[] = [];
  for (const entry of entries) {
    // A relative path written on another OS ("../api" or "..\\api") resolves either way.
    const path = resolveInRoot(base, entry.path);
    if (out.some((f) => samePath(f.path, path))) continue;
    out.push({ path, name: entry.name ?? (basename(path) || path), index: out.length });
  }
  return out;
}

/**
 * How a folder is written in the file: relative to the file's folder when it is inside it or a
 * sibling's (VS Code's habit, so a workspace file in a repo moves with it), else absolute.
 * Relative paths use "/" so the file reads the same on every OS.
 */
export function folderEntryPath(workspaceFile: string, folder: string): string {
  const base = dirname(workspaceFile);
  if (isWithin(base, folder)) return relativePath(base, folder) || ".";
  const parent = dirname(base);
  if (parent !== base && isWithin(parent, folder) && sameRootKind(base, folder))
    return `../${relativePath(parent, folder)}`;
  return folder;
}

const sameRootKind = (a: string, b: string) => isWindowsPath(a) === isWindowsPath(b);

/** `text` with its `folders` replaced by `folders` (comments elsewhere in the file kept). */
export function withFolders(
  text: string,
  workspaceFile: string,
  folders: readonly { path: string; name?: string }[],
): string {
  const entries = folders.map((f) => {
    const path = folderEntryPath(workspaceFile, f.path);
    const own = basename(f.path);
    // A name equal to the folder's own isn't written (VS Code doesn't either).
    return f.name && f.name !== own ? { path, name: f.name } : { path };
  });
  return setJsoncProperty(text.trim() ? text : "{}\n", "folders", entries);
}

/** `text` with the workspace setting `key` set (or removed when `value` is undefined). */
export function withWorkspaceSetting(text: string, key: string, value: unknown): string {
  return setJsoncNestedProperty(text.trim() ? text : "{}\n", "settings", key, value);
}

/** A new workspace file's text for `folders`. */
export function newWorkspaceText(
  workspaceFile: string,
  folders: readonly { path: string; name?: string }[],
): string {
  return withFolders('{\n  "folders": [],\n  "settings": {}\n}\n', workspaceFile, folders);
}

/** The name a workspace shows as: the file's name without `.code-workspace`. */
export function workspaceFileName(workspaceFile: string): string {
  const name = basename(workspaceFile);
  return name.toLowerCase().endsWith(WORKSPACE_EXTENSION)
    ? name.slice(0, -WORKSPACE_EXTENSION.length)
    : name;
}

/**
 * The folder of `folders` that holds `path`: the innermost when folders nest (a package folder
 * added beside its repository), so a file belongs to the most specific one.
 */
export function folderOf<T extends { path: string }>(
  folders: readonly T[],
  path: string,
): T | undefined {
  let best: T | undefined;
  for (const f of folders)
    if (isWithin(f.path, path) && (!best || f.path.length > best.path.length)) best = f;
  return best;
}

/**
 * A path as the workspace shows it: relative to its folder, with the folder's name in front when
 * there are several ("api/src/main.ts", VS Code's asRelativePath); the path itself outside them.
 */
export function workspaceRelative(
  folders: readonly WorkspaceFolder[],
  path: string,
  withFolderName = folders.length > 1,
): string {
  const f = folderOf(folders, path);
  if (!f) return path;
  const rel = relativePath(f.path, path);
  if (!withFolderName) return rel;
  return rel ? `${f.name}/${rel}` : f.name;
}

// The open folders' workspace folders (D177, D189): where the IDE keeps a project's settings,
// tasks, launch configurations, snippets, agent memory and commands, extensions and screenshots.
//
// The IDE's own folder (product.json: workspaceFolderName) is where everything is
// written; it's created when something is first saved. Folders a project may already have under
// other names (workspaceFolderAliases: ".vscode", the legacy folder name) are read too, but never created.
// When more than one exists, the order of precedence is the IDE's own, then the aliases in
// order: a file or setting in a higher one overrides the same in a lower one (the explorer marks
// lower folders that have overridden files, and offers to merge them into the IDE's own).
//
// Which exist is known per workspace folder (D251: a multi-root workspace has several, each with
// its own `.vscode`): the functions taking a `root` use that folder's; those without one, the
// first folder's.
import { fsIpc } from "../core/ipc/fs";
import { isWithin, joinPath, pathKey } from "../core/paths/index";
import { product } from "../core/product";

interface Present {
  /** Aliases that exist in the folder, in order of precedence. */
  aliases: string[];
  primary: boolean;
}

const NONE: Present = { aliases: [], primary: false };
/** Per workspace folder (by path key). */
const present = new Map<string, Present>();
/** The first folder's key: the one the root-less functions mean. */
let current: string | null = null;

const presentFor = (root: string | null | undefined): Present =>
  (root ? present.get(pathKey(root)) : current ? present.get(current) : undefined) ?? NONE;

/** Accepted names, in order of precedence (the IDE's own first). */
export function workspaceFolderCandidates(): readonly string[] {
  return [product.workspaceFolderName, ...product.workspaceFolderAliases];
}

/** Of `existing`, the accepted names in order of precedence. */
export function presentInOrder(
  existing: ReadonlySet<string>,
  candidates: readonly string[] = workspaceFolderCandidates(),
): string[] {
  return candidates.filter((name) => existing.has(name));
}

/** Where the IDE writes: always its own folder, never an alias. */
export function workspaceFolderName(): string {
  return product.workspaceFolderName;
}

/**
 * The folders read, in order of precedence: the IDE's own (even before it exists), then aliases
 * that exist — in `root` (default: the first workspace folder).
 */
export function workspaceFolders(root?: string | null): readonly string[] {
  return [product.workspaceFolderName, ...presentFor(root).aliases];
}

/** Folders that exist in `root` (default: the first workspace folder), in order of precedence. */
export function presentWorkspaceFolders(root?: string | null): readonly string[] {
  const p = presentFor(root);
  return [...(p.primary ? [product.workspaceFolderName] : []), ...p.aliases];
}

/** `<root>/<IDE's folder>/<parts…>`: where to write. */
export function workspaceFolderPath(root: string, ...parts: string[]): string {
  return parts.reduce((path, part) => joinPath(path, part), joinPath(root, workspaceFolderName()));
}

/** `<root>/<folder>/<parts…>` for every folder read in `root`, highest precedence first. */
export function workspaceFolderPaths(root: string, ...parts: string[]): string[] {
  return workspaceFolders(root).map((folder) =>
    parts.reduce((path, part) => joinPath(path, part), joinPath(root, folder)),
  );
}

/** "<folder>/<parts…>" labels matching workspaceFolderPaths(root, …) (D251). */
export function workspaceFolderLabelsOf(root: string | null, ...parts: string[]): string[] {
  return workspaceFolders(root).map((folder) => [folder, ...parts].join("/"));
}

/** True when `path` is inside `<root>/<any workspace folder>/<parts…>`. */
export function isInWorkspaceFolders(root: string, path: string, ...parts: string[]): boolean {
  return workspaceFolderPaths(root, ...parts).some((dir) => isWithin(dir, path));
}

/** The first of `<folder>/<parts…>` that exists (by precedence), else the IDE's own path. */
export async function findWorkspaceFile(root: string, ...parts: string[]): Promise<string> {
  for (const path of workspaceFolderPaths(root, ...parts))
    if (await fsIpc.stat(path).catch(() => null)) return path;
  return workspaceFolderPath(root, ...parts);
}

/** Creates the IDE's own folder in `root` if needed (before writing into it); returns its path. */
export async function ensureWorkspaceFolder(root: string): Promise<string> {
  const key = pathKey(root);
  const p = present.get(key);
  if (!p?.primary) {
    await fsIpc.createDir(root, product.workspaceFolderName).catch(() => {});
    present.set(key, { aliases: p?.aliases ?? [], primary: true });
  }
  return joinPath(root, product.workspaceFolderName);
}

/** Looks at `root` for the folders that exist (its own `.vscode`, the IDE's folder…). */
async function scan(root: string): Promise<Present> {
  const existing = new Set<string>();
  await Promise.all(
    workspaceFolderCandidates().map(async (name) => {
      const stat = await fsIpc.stat(joinPath(root, name)).catch(() => null);
      if (stat?.kind === "dir") existing.add(name);
    }),
  );
  const order = presentInOrder(existing);
  return {
    primary: order.includes(product.workspaceFolderName),
    aliases: order.filter((name) => name !== product.workspaceFolderName),
  };
}

/**
 * Looks at the first workspace folder (when a workspace opens, or the folder's top level changed)
 * for the folders that exist; null forgets every folder (nothing is open).
 */
export async function resolveWorkspaceFolder(root: string | null): Promise<string> {
  if (!root) {
    present.clear();
    current = null;
    return product.workspaceFolderName;
  }
  const key = pathKey(root);
  // A new first folder: the others' entries go (they're scanned again as they're added).
  if (current !== key) present.clear();
  current = key;
  present.set(key, await scan(root));
  return product.workspaceFolderName;
}

/** Looks at another workspace folder (D251: added to the workspace, or its top level changed). */
export async function resolveWorkspaceFolderOf(root: string): Promise<void> {
  present.set(pathKey(root), await scan(root));
}

/** Forgets a folder taken out of the workspace. */
export function forgetWorkspaceFolderOf(root: string): void {
  const key = pathKey(root);
  if (key !== current) present.delete(key);
}

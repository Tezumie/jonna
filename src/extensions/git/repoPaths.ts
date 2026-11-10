// Which repository a path or a `repository` input means (D204). DOM-free, tested.
import { isWithin, pathKey, resolveInRoot, samePath } from "../../core/paths/index";

/** The repository among `roots` that contains `path` most closely (index), or -1. */
export function deepestRoot(roots: readonly string[], path: string): number {
  let best = -1;
  let bestLength = -1;
  roots.forEach((root, i) => {
    if (!root || !isWithin(root, path)) return;
    const length = pathKey(root).length;
    if (length > bestLength) {
      best = i;
      bestLength = length;
    }
  });
  return best;
}

/**
 * The repositories (indexes into `roots`) whose files changed on disk (D220: the file watcher's
 * batches start `git status` only where it can have changed). `overflow` (more than the batch
 * lists): every repository.
 */
export function repositoriesTouched(
  roots: readonly string[],
  changes: { paths: readonly string[]; overflow: boolean },
): Set<number> {
  const out = new Set<number>();
  if (changes.overflow) {
    roots.forEach((root, i) => {
      if (root) out.add(i);
    });
    return out;
  }
  for (const path of changes.paths) {
    const i = deepestRoot(roots, path);
    if (i >= 0) out.add(i);
  }
  return out;
}

/**
 * How often a repository's status is read without a change event, while the window is focused
 * (D220): VS Code watches files instead of polling, and so do we when the file watcher runs; the
 * slow poll only catches what a watcher misses (network drives, WSL folders). Without a watcher,
 * the old 5 s.
 */
export function statusPollMs(watching: boolean): number {
  return watching ? 60_000 : 5000;
}

/**
 * The order of a "Choose a repository" picker (VS Code's): the selected one first, the rest as
 * listed.
 */
export function pickerOrder<T>(repos: readonly T[], selected: T | undefined): T[] {
  const i = selected === undefined ? -1 : repos.indexOf(selected);
  return i <= 0 ? [...repos] : [repos[i] as T, ...repos.slice(0, i), ...repos.slice(i + 1)];
}

/** What `matchRepository` needs of a multi-root workspace (D251). */
export interface RepositoryWorkspace {
  /** Its folders, the first first (one: a single folder, matched as before). */
  folders: readonly { path: string; name: string }[];
  /** A workspace path made absolute (`WorkspaceService.resolve`: "api/src" is in folder "api"). */
  resolve: (path: string) => string;
}

/**
 * Which repository a `repository` input names: its root (absolute or workspace-relative, "."
 * for the folder itself) or its folder name; -1 when none matches. In a multi-root workspace a
 * workspace folder's name means that folder's repository (the deepest one holding the folder).
 */
export function matchRepository(
  repos: readonly { root: string; name: string }[],
  workspaceRoot: string,
  wanted: string,
  workspace?: RepositoryWorkspace,
): number {
  const w = wanted.trim();
  if (!w) return -1;
  const resolve = workspace?.resolve ?? ((p: string) => resolveInRoot(workspaceRoot, p));
  const abs = w === "." ? workspaceRoot : resolve(w);
  const byRoot = repos.findIndex((r) => r.root && samePath(r.root, abs));
  if (byRoot >= 0) return byRoot;
  const folder =
    workspace && workspace.folders.length > 1
      ? workspace.folders.find((f) => f.name === w)
      : undefined;
  if (folder) {
    const holding = deepestRoot(
      repos.map((r) => r.root),
      folder.path,
    );
    if (holding >= 0) return holding;
  }
  const byName = repos.findIndex((r) => r.name === w);
  if (byName >= 0) return byName;
  // "." when the folder is inside its repository (a subfolder of it is open): that repository.
  return w === "."
    ? deepestRoot(
        repos.map((r) => r.root),
        workspaceRoot,
      )
    : -1;
}

/**
 * A repository's name in a multi-root workspace (D251): the name of the workspace folder it is,
 * else of the first folder inside it (a folder opened below its repository's root). Undefined
 * with one folder, or when no folder is or lies in it: then it's named by its own folder.
 */
export function repositoryFolderName(
  folders: readonly { path: string; name: string }[],
  root: string,
): string | undefined {
  if (folders.length < 2 || !root) return undefined;
  const same = folders.find((f) => samePath(f.path, root));
  if (same) return same.name;
  return folders.find((f) => isWithin(root, f.path))?.name;
}

/**
 * The workspace folders no repository holds (D251: what "Initialize repository" offers in a
 * multi-root workspace), in order.
 */
export function foldersWithoutRepository<T extends { path: string }>(
  folders: readonly T[],
  repoRoots: readonly string[],
): T[] {
  return folders.filter((f) => deepestRoot(repoRoots, f.path) < 0);
}

/**
 * The repositories Source control shows in "multiple" mode (VS Code's selection in its
 * Repositories view): every one not hidden, in order. Hiding them all would leave an empty view,
 * so then the selected one (else the first) still shows.
 */
export function shownRepositories<T>(
  repos: readonly T[],
  hidden: ReadonlySet<string>,
  keyOf: (repo: T) => string,
  selected: T | undefined,
): T[] {
  const shown = repos.filter((r) => !hidden.has(keyOf(r)));
  if (shown.length || !repos.length) return shown;
  const fallback = selected !== undefined && repos.includes(selected) ? selected : repos[0];
  return fallback === undefined ? [] : [fallback];
}

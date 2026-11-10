// Multi-root workspaces (D251) for tasks, launch configurations and terminals: which folder a
// config file, a task or a command belongs to, and how their names say so. With one folder
// everything here gives what the single-folder code did (no names added, the root everywhere).
// DOM-free and tested; `chooseFolder.ts` asks which folder with the quick pick.
import { basename, isAbsolute, isWithin, samePath } from "../../core/paths/index";
import { folderOf } from "../../core/workspace/workspaceFile";

/** A workspace folder as these helpers need it. */
export interface FolderRef {
  name: string;
  path: string;
}

/** A config file to read (tasks.json, launch.json), with the folder it belongs to. */
export interface ConfigFile<F extends FolderRef = FolderRef> {
  path: string;
  /** How its entries' `source` reads: ".vscode/tasks.json", "api/.vscode/tasks.json". */
  source: string;
  folder: F;
}

/**
 * Every folder's config files, folder by folder (the first folder first), each folder's in its
 * own precedence (`filesOf`: `[path, label]`, highest first). With several folders a file's
 * `source` starts with its folder's name ("api/.vscode/launch.json").
 */
export function configFilesOf<F extends FolderRef>(
  folders: readonly F[],
  filesOf: (folder: string) => readonly [string, string][],
): ConfigFile<F>[] {
  const multi = folders.length > 1;
  return folders.flatMap((folder) =>
    filesOf(folder.path).map(([path, label]) => ({
      path,
      source: multi ? `${folder.name}/${label}` : label,
      folder,
    })),
  );
}

/** A name as pickers and agents see it in a multi-root workspace: "build (api)". */
export function qualifiedName(name: string, folder: FolderRef | undefined, multi: boolean): string {
  return multi && folder ? `${name} (${folder.name})` : name;
}

/** Something with a qualified label (a task, a launch configuration). */
export interface Named {
  /** The name as shown and looked up: "build", or "build (api)" in a multi-root workspace. */
  label: string;
  /** The name as written, when `label` has the folder's name added. */
  name?: string;
  /** The workspace folder it belongs to (absolute). */
  workspaceFolder?: string;
}

/** The name as written in its file ("build" for "build (api)"). */
export const plainName = (x: Named): string => x.name ?? x.label;

/**
 * Finds `wanted` among `all` (D251): its exact label ("build (api)"), else the one named so (as
 * written, "build") in the folder `near` (a dependency of a task in that folder, the active
 * file's folder), else the only one named so. Throws when several folders have one and none is
 * nearer; undefined when there's none.
 */
export function findNamed<T extends Named>(
  all: readonly T[],
  wanted: string,
  near?: string | null,
): T | undefined {
  const named = all.filter((x) => plainName(x) === wanted);
  if (near) {
    const inFolder = named.find((x) => x.workspaceFolder && samePath(x.workspaceFolder, near));
    if (inFolder) return inFolder;
  }
  const exact = all.find((x) => x.label === wanted);
  if (exact) return exact;
  if (named.length <= 1) return named[0];
  // Unqualified ones (user tasks) don't compete with folders' own.
  const plain = named.filter((x) => x.name === undefined);
  if (plain.length === 1) return plain[0];
  throw new Error(
    `Several folders have "${wanted}": ${named.map((x) => `"${x.label}"`).join(", ")}. Use one of those labels.`,
  );
}

/**
 * The folder a command's `folder` input names: a folder's name, its path, or a path inside it.
 * Throws for one that isn't in the workspace.
 */
export function folderByInput<F extends FolderRef>(folders: readonly F[], input: string): F {
  const given = input.trim();
  const byName = folders.find((f) => f.name === given);
  if (byName) return byName;
  if (isAbsolute(given)) {
    const exact = folders.find((f) => samePath(f.path, given));
    if (exact) return exact;
    const holder = folderOf(folders, given);
    if (holder) return holder;
  }
  const byBase = folders.find((f) => basename(f.path) === given);
  if (byBase) return byBase;
  throw new Error(
    `"${input}" isn't a folder of the workspace (${folders.map((f) => f.name).join(", ")}).`,
  );
}

/** The folder for a file that may be outside every folder: its own, else `fallback`. */
export function folderForFile<F extends FolderRef>(
  folders: readonly F[],
  file: string | null | undefined,
  fallback: F | undefined,
): F | undefined {
  return (file ? folderOf(folders, file) : undefined) ?? fallback;
}

/** Whether `path` is in one of `folders`. */
export const inFolders = (folders: readonly FolderRef[], path: string): boolean =>
  folders.some((f) => isWithin(f.path, path));

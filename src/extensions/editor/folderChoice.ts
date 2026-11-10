// Which workspace folder a command that needs one acts on (D251, the brief's rule): the `folder`
// input (a path or a folder's name) when given; with one folder, it; with several, the folder of
// the file the user is in (the active editor), else ask. Agents pass the input, so they're never
// asked. `folderChoice` is the DOM-free decision; `chooseFolder` asks when it says to.
import { samePath } from "../../core/paths/index";
import { folderOf, type WorkspaceFolder } from "../../core/workspace/workspaceFile";
import type { WorkbenchServices } from "../../workbench/services";

export type FolderChoice =
  | { kind: "folder"; folder: WorkspaceFolder }
  | { kind: "ask" }
  | { kind: "none" }
  | { kind: "unknown"; wanted: string };

export function folderChoice(
  folders: readonly WorkspaceFolder[],
  wanted: string | undefined,
  near: string | null | undefined,
): FolderChoice {
  if (wanted) {
    const found =
      folders.find((f) => samePath(f.path, wanted)) ?? folders.find((f) => f.name === wanted);
    return found ? { kind: "folder", folder: found } : { kind: "unknown", wanted };
  }
  const [first] = folders;
  if (!first) return { kind: "none" };
  if (folders.length === 1) return { kind: "folder", folder: first };
  const owner = near ? folderOf(folders, near) : undefined;
  return owner ? { kind: "folder", folder: owner } : { kind: "ask" };
}

/** The file of the focused (or most recent) editor tab, for "the folder the user is in". */
export function activeFilePath(services: Pick<WorkbenchServices, "dock">): string | null {
  const tab = services.dock.recentTab((t) => t.viewType === "editor");
  const path = (tab?.viewState as { path?: unknown } | null | undefined)?.path;
  return typeof path === "string" ? path : null;
}

/**
 * The folder to act on (see above); null when nothing is open or the user dismissed the question.
 * Throws for a `wanted` folder that isn't one of the workspace's.
 */
export async function chooseFolder(
  services: Pick<WorkbenchServices, "workspace" | "quickInput" | "dock">,
  wanted: string | undefined,
  placeholder: string,
  near: string | null = activeFilePath(services),
): Promise<WorkspaceFolder | null> {
  const folders = services.workspace.folders.peek();
  // A window from before the folder list existed (or a test double): the root is the folder.
  const list: readonly WorkspaceFolder[] = folders.length
    ? folders
    : (() => {
        const root = services.workspace.root.peek();
        return root ? [{ path: root, name: root.split(/[\\/]/).pop() || root, index: 0 }] : [];
      })();
  const choice = folderChoice(list, wanted, near);
  if (choice.kind === "folder") return choice.folder;
  if (choice.kind === "unknown")
    throw new Error(`${choice.wanted} isn't a folder of this workspace.`);
  if (choice.kind === "none") return null;
  const picked = await services.quickInput.pick(
    list.map((f) => ({ id: f.path, label: f.name, description: f.path })),
    { placeholder },
  );
  return list.find((f) => picked && samePath(f.path, picked.id)) ?? null;
}

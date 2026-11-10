// Multi-root workspaces (D251, VS Code's): add a folder to the window's workspace, take one out,
// name it, save the workspace as a `.code-workspace` file, open one. The WorkspaceService does the
// work (workbench/workspace.ts); these are its commands, for the menus, the palette and agents.
import { dialogIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { basename, dirname, joinPath, samePath } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import { isWorkspaceFile, WORKSPACE_EXTENSION } from "../../core/workspace/workspaceFile";
import type { WorkbenchServices } from "../../workbench/services";
import { isUntitledWorkspace } from "../../workbench/workspace";

const WORKSPACE_FILTER = [{ name: "Workspace", extensions: [WORKSPACE_EXTENSION.slice(1)] }];

export function registerWorkspaceCommands(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, workspace, quickInput } = services;

  /** A folder of the workspace by path or by its name (agents name them), or ask. */
  const pickFolder = async (wanted: string | undefined, placeholder: string) => {
    const folders = workspace.folders.peek();
    if (wanted) {
      const found =
        folders.find((f) => samePath(f.path, wanted)) ??
        folders.find((f) => f.name === wanted) ??
        workspace.missing.peek().find((m) => samePath(m.path, wanted) || m.name === wanted);
      if (!found) throw new Error(`${wanted} isn't a folder of this workspace.`);
      return found.path;
    }
    const picked = await quickInput.pick(
      [
        ...folders.map((f) => ({ id: f.path, label: f.name, description: f.path })),
        ...workspace.missing.peek().map((m) => ({
          id: m.path,
          label: m.name,
          description: `${m.path} (missing)`,
        })),
      ],
      { placeholder },
    );
    return picked?.id ?? null;
  };

  sub.add(
    dispatcher.register({
      id: "workspace.addFolder",
      title: "Add folder to workspace…",
      category: "File",
      description:
        "Adds folders to the window's workspace (VS Code's multi-root workspaces, D251): a window with one folder becomes an untitled workspace with both, without reloading; with nothing open, the first opens as the folder. Without `paths`, shows the folder picker. Returns the folders added.",
      input: s.object({
        paths: s.array(s.string()).describe("Absolute folder paths").optional(),
        trust: s
          .boolean()
          .describe(
            "Joining a trusted workspace, folders not decided about yet are trusted (true) or restricted (false) without asking",
          )
          .optional(),
      }),
      effects: ["write"],
      agent: "hidden",
      run: async ({ paths, trust }) => {
        let wanted: string[] = paths ?? [];
        if (!paths) {
          const root = workspace.root.peek();
          const picked = await dialogIpc.pickFolder(
            "Add Folder to Workspace",
            root ? dirname(root) : undefined,
          );
          if (picked) wanted = [picked];
        }
        if (!wanted.length) return { added: [] };
        const added = await workspace.addFolders(wanted, trust === undefined ? {} : { trust });
        return { added: added.map((f) => ({ name: f.name, path: f.path })) };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "workspace.removeFolder",
      title: "Remove folder from workspace…",
      category: "File",
      description:
        "Takes a folder out of a multi-root workspace (the folder itself stays on disk; its editors close). `path`: the folder's path or name; without it, asks which. The last folder can't be removed (close the workspace instead).",
      input: s.object({ path: s.string().describe("A folder's path or name").optional() }),
      effects: ["write"],
      when: "workbenchState == workspace",
      agent: "hidden",
      run: async ({ path }) => {
        const target = await pickFolder(path, "Remove which folder from the workspace?");
        if (!target) return { removed: null };
        return { removed: (await workspace.removeFolder(target)) ? target : null };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "workspace.renameFolder",
      title: "Rename folder in workspace…",
      category: "File",
      description:
        "Sets the name a multi-root workspace shows for one of its folders (saved in the workspace file; the folder on disk keeps its name). Empty `name`: the folder's own name again.",
      input: s.object({
        path: s.string().describe("A folder's path or name").optional(),
        name: s.string().optional(),
      }),
      effects: ["write"],
      when: "workbenchState == workspace",
      agent: "hidden",
      run: async ({ path, name }) => {
        const target = await pickFolder(path, "Rename which folder?");
        if (!target) return { renamed: null };
        const current = workspace.folders.peek().find((f) => samePath(f.path, target));
        const next =
          name ??
          (await quickInput.prompt({
            prompt: `Name shown for ${target}`,
            value: current?.name ?? basename(target),
          }));
        if (next === null || next === undefined) return { renamed: null };
        await workspace.renameFolder(target, next);
        return { renamed: target, name: next.trim() || basename(target) };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "workspace.saveAs",
      title: "Save workspace as…",
      category: "File",
      description:
        "Saves the window's workspace as a .code-workspace file (D251): an untitled multi-root workspace gets a name and place, a single folder becomes a workspace. Its state (open tabs, layout) moves with it. Without `path`, shows the save dialog.",
      input: s.object({
        path: s.string().describe("Absolute path ending in .code-workspace").optional(),
      }),
      effects: ["write"],
      when: "workspaceOpen",
      agent: "hidden",
      run: async ({ path }) => {
        const root = workspace.root.peek();
        if (!root) throw new Error("Open a folder first.");
        const file = workspace.file.peek();
        const suggested =
          file && !isUntitledWorkspace(file)
            ? file
            : joinPath(dirname(root), `${basename(root)}${WORKSPACE_EXTENSION}`);
        let target = path ?? (await dialogIpc.pickSavePath("Save Workspace As", suggested));
        if (!target) return { saved: null };
        if (!isWorkspaceFile(target)) target = `${target}${WORKSPACE_EXTENSION}`;
        return { saved: await workspace.saveAs(target) };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "workspace.openWorkspaceFile",
      title: "Open workspace from file…",
      category: "File",
      description:
        "Opens a .code-workspace file (a multi-root workspace, VS Code's format) in this window. Without `path`, shows the file picker. Unsaved editors are confirmed first.",
      input: s.object({
        path: s.string().describe("Absolute path of a .code-workspace file").optional(),
      }),
      effects: ["read"],
      agent: "hidden",
      run: async ({ path }) => {
        const target =
          path ??
          (await dialogIpc.pickFile("Open Workspace from File", undefined, WORKSPACE_FILTER));
        if (!target) return { opened: null };
        if (!isWorkspaceFile(target)) throw new Error("Pick a .code-workspace file.");
        return { opened: await workspace.open(target), workspace: target };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "workspace.reloadWorkspaceFile",
      title: "Reload workspace file",
      category: "File",
      description:
        "Reads the open .code-workspace file again (it changed outside the IDE): its settings, tasks and launch configurations apply, and folders it now lists join only after the user confirms them. Done by itself when the window gets focus.",
      input: s.empty(),
      effects: ["read"],
      when: "workbenchState == workspace",
      agent: "hidden",
      palette: false,
      run: async () => {
        await workspace.reloadFile();
        return {
          folders: workspace.folders.peek().map((f) => f.path),
          missing: workspace.missing.peek().map((m) => ({ path: m.path, error: m.error })),
        };
      },
    }),
  );
}

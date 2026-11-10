// Built-in Explorer: the workspace folder (`workspace.openFolder`, `ide://workspace`) and the
// file tree with create/rename/delete. Paths in command inputs may be absolute or relative to
// the workspace root (friendlier for agents).

import type { BuiltinExtension } from "../../core/extensions/index";
import { dragDropIpc, fsIpc } from "../../core/ipc/fs";
import { instancesIpc } from "../../core/ipc/instances";
import { isTauri } from "../../core/ipc/invoke";
import { appIpc, clipboardIpc, dialogIpc, openerIpc } from "../../core/ipc/system";
import { basename, dirname, displayPath, isWindowsPath, samePath } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import { applyBaseLayout } from "../../workbench/baseLayout";
import type { WorkbenchServices } from "../../workbench/services";
import { locationLabel } from "../../workbench/workspace";
import {
  presentWorkspaceFolders,
  workspaceFolderName,
  workspaceFolders,
} from "../../workbench/workspaceFolder";
import { registerClipboardCommands } from "./clipboard";
import manifest from "./extension.json";
import { registerFileCommands } from "./fileCommands";
import { registerFolderView } from "./folderView";
import { registerOpenDropped } from "./openDropped";
import { createdOperation } from "./undo";
import { ExplorerView } from "./view";
import { registerWorkspaceCommands } from "./workspaceCommands";
import { registerWorkspaceFolders } from "./workspaceFolders";
import { registerWslCommands } from "./wsl";

/** A real path (not a multi-root tree's hidden workspace row, D251). */
const isPath = (id: string) => !id.startsWith("\u0000");

export const explorerExtension: BuiltinExtension<WorkbenchServices> = {
  manifest,
  activate({ subscriptions: sub, services }) {
    const { dispatcher, workspace, views, persistence, state } = services;
    let view: ExplorerView | undefined;

    sub.add(
      views.register({
        id: "explorer.view",
        title: "Explorer",
        command: "explorer.focus",
        icon: "files",
        actions: [
          { command: "explorer.newFile", icon: "file-plus", title: "New file…" },
          { command: "explorer.newFolder", icon: "folder-plus", title: "New folder…" },
          { command: "explorer.collapseAll", icon: "list-collapse", title: "Collapse folders" },
          { command: "explorer.moreActions", icon: "ellipsis", title: "More actions…", menu: true },
        ],
        create(host) {
          view = new ExplorerView(host, services);
          return view;
        },
      }),
    );
    // Created eagerly so the tree loads as soon as a folder opens.
    views.activate("explorer.view");
    registerWorkspaceFolders(sub, services);
    registerFolderView(sub, services);
    registerWslCommands(sub, services);

    sub.add(
      dispatcher.register({
        id: "explorer.toggleExcludedFiles",
        title: "Toggle hidden files",
        category: "Explorer",
        description:
          "Shows or hides, in the explorer, the files and folders files.exclude hides (.git, .DS_Store…); shown, they're dimmed and still excluded from search and quick open.",
        input: s.object({ show: s.boolean().optional() }),
        effects: ["write"],
        run: async ({ show }) => {
          const next =
            show ??
            services.settings.peek<boolean | undefined>("explorer.showExcludedFiles") !== true;
          await services.settings.update("explorer.showExcludedFiles", next);
          return { showing: next };
        },
      }),
    );
    /**
     * The folder is open in another window (not this one): that window comes to the front
     * instead of opening it twice (D209, VS Code).
     */
    const openElsewhere = async (folder: string): Promise<boolean> => {
      // This window's folder, or its workspace file (D251).
      const here = workspace.location.peek();
      if (!isTauri() || (here && samePath(here, folder))) return false;
      return instancesIpc.focusFolder(folder).catch(() => false);
    };
    sub.add(
      dispatcher.register({
        id: "workbench.newWindow",
        title: "New window",
        category: "File",
        description:
          "Opens another IDE window (empty, or on `folder`). A folder already open in another window brings that window to the front instead (VS Code).",
        input: s.object({ folder: s.string().describe("Absolute folder path").optional() }),
        effects: [],
        agent: "hidden",
        run: async ({ folder }) => {
          if (folder && (await openElsewhere(folder))) return { spawned: false, focused: folder };
          return { spawned: await appIpc.newWindow(folder) };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "workspace.openFolder",
        title: "Open folder…",
        category: "File",
        description:
          "Opens a folder as the workspace (or a .code-workspace file: a multi-root workspace, D251). Without `path`, shows the system folder picker. Unsaved editors are confirmed first. `newWindow` opens it in another IDE window instead. A folder already open in another window brings that window to the front (VS Code); `focused` says so. To add a folder beside the open one: workspace.addFolder.",
        input: s.object({
          path: s.string().describe("Absolute folder path (or .code-workspace file)").optional(),
          newWindow: s.boolean().describe("Open in a new window").optional(),
        }),
        effects: ["read"],
        agent: "hidden",
        run: async ({ path, newWindow }, ctx) => {
          // A remote window browses the remote (D252).
          if (!path && services.context.get("remoteConnected") === true)
            return ctx.execute("remote.openFolder");
          const target = path ?? (await dialogIpc.pickFolder("Open Folder"));
          if (!target) return { opened: null };
          if (await openElsewhere(target)) return { opened: null, focused: target };
          if (newWindow) return { opened: target, newWindow: await appIpc.newWindow(target) };
          return { opened: await workspace.open(target) };
        },
      }),
    );

    // Files dragged in from the OS: the folder under the pointer lights up; dropping copies them
    // there (explorer.importDropped). Dropped elsewhere they open (explorer.openDropped).
    // A drag coming in from the system while the explorer is hidden opens it (once per drag),
    // so there's somewhere to drop.
    let opened = false;
    void dragDropIpc
      .listen((e) => {
        if (e.kind !== "over") opened = false;
        else if (!opened && workspace.root.peek() && !services.layout.sidebarVisible.peek()) {
          opened = true;
          if (!document.elementFromPoint(e.x, e.y)?.closest("[data-os-drop]"))
            void dispatcher.execute("view.show", { id: "explorer.view" }).catch(() => {});
        }
        if (e.kind === "leave") return view?.osDragOver(null);
        // Over a part that takes system drops itself (the agent chat attaches them).
        if (document.elementFromPoint(e.x, e.y)?.closest("[data-os-drop]"))
          return view?.osDragOver(null);
        const dir = view?.canEditInline() ? view.dropFolderAt(e.x, e.y) : null;
        if (e.kind === "over") return view?.canEditInline() && view.osDragOver({ x: e.x, y: e.y });
        view?.osDragOver(null);
        if (dir) {
          void dispatcher.execute("explorer.importDropped", { dest: dir }).catch(() => {});
          return;
        }
        // Elsewhere: open them (files in an editor, a folder as or beside the workspace, D281).
        void dispatcher.execute("explorer.openDropped", { x: e.x, y: e.y }).catch(() => {});
      })
      .then((d) => sub.add(d));

    sub.add(
      dispatcher.register({
        id: "explorer.revealInOs",
        title: "Reveal in file manager",
        category: "File",
        description:
          "Shows a file or folder in the system file manager (Explorer, Finder…), selected.",
        input: s.object({
          path: s.string().describe("Default: the explorer selection").optional(),
        }),
        effects: [],
        agent: "hidden",
        run: async ({ path }) => {
          const target = path
            ? workspace.resolve(path)
            : (view?.tree?.selection?.path ?? workspace.root.peek());
          if (!target) throw new Error("Nothing to reveal.");
          await openerIpc.revealInOs(target);
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "explorer.importDropped",
        title: "Copy dropped files here",
        category: "File",
        description:
          "Copies the files last dropped onto the window from the OS into folder `dest`.",
        input: s.object({ dest: s.string().describe("Folder, absolute or workspace-relative") }),
        effects: ["write"],
        when: "workspaceOpen",
        agent: "hidden",
        palette: false,
        run: async ({ dest }, ctx) => {
          const dir = workspace.resolve(dest);
          const created = await dragDropIpc.importDropped(dir);
          for (const path of created)
            services.events.emit("files.didCreate", { path, kind: "file" });
          await view?.refresh([dir]);
          if (created.length)
            services.history.push(
              createdOperation(
                {
                  services,
                  refresh: async (dirs) => void (await view?.refresh([...new Set(dirs)])),
                },
                created,
                created.length === 1
                  ? `Add ${basename(created[0] ?? "")}`
                  : `Add ${created.length} items`,
              ),
            );
          const last = created[created.length - 1];
          if (last) await ctx.execute("explorer.reveal", { path: last });
          return { created };
        },
      }),
    );

    sub.add(
      dispatcher.register({
        id: "explorer.copyPath",
        title: "Copy path",
        category: "File",
        description:
          "Copies a file or folder path (absolute, or relative to the workspace) to the clipboard.",
        input: s.object({
          path: s.string().describe("File or folder (default: explorer selection)").optional(),
          relative: s.boolean().optional(),
        }),
        effects: [],
        agent: "hidden",
        run: async ({ path, relative }) => {
          const target = path ? workspace.resolve(path) : view?.tree?.selection?.path;
          if (!target) throw new Error("Select a file or folder.");
          // Relative to the folder that holds it; a multi-root workspace's has the folder's name
          // in front, as VS Code's (D251).
          const owner = workspace.folderOf(target)?.path ?? workspace.root.peek() ?? "";
          const rel = workspace.isMultiRoot()
            ? // A workspace down to one folder writes that folder itself as "", as one folder does.
              workspace.relative(target) || "."
            : displayPath(owner, target) || ".";
          const text = relative ? (isWindowsPath(owner) ? rel.replaceAll("/", "\\") : rel) : target;
          await clipboardIpc.writeText(text);
          return { copied: text };
        },
      }),
    );

    sub.add(
      dispatcher.register({
        id: "workspace.closeFolder",
        title: "Close folder",
        category: "File",
        description:
          "Closes the open folder or workspace (asks about unsaved editors first) and shows the welcome tab.",
        input: s.empty(),
        effects: [],
        when: "workspaceOpen",
        agent: "hidden",
        run: async () => {
          const closed = await workspace.close();
          // The same layout as a window opened without a folder (D163).
          if (closed)
            applyBaseLayout(services, {
              terminal: false,
              // Chats, without focus (D164): a palette opened meanwhile keeps it.
              showSidebar: () => (services.views.active.value = "agent.chats"),
            });
          return { closed };
        },
      }),
    );

    sub.add(
      dispatcher.register({
        id: "workspace.openRecent",
        title: "Open recent…",
        category: "File",
        description:
          "Opens a recently used folder or workspace (.code-workspace, D251). Without `path`, lists them (newest first) to pick from.",
        input: s.object({
          path: s.string().describe("Absolute folder path (or .code-workspace file)").optional(),
        }),
        effects: ["read"],
        agent: "hidden",
        run: async ({ path }) => {
          const recent = workspace.recentOrdered();
          const target =
            path ??
            (
              await services.quickInput.pick(
                recent.map((p) => ({ id: p, label: locationLabel(p), description: p })),
                { placeholder: "Select a folder to open" },
              )
            )?.id;
          if (!target) return { opened: null };
          if (await openElsewhere(target)) return { opened: null, focused: target };
          return { opened: await workspace.open(target) };
        },
      }),
    );

    sub.add(
      dispatcher.register({
        id: "workspace.removeRecent",
        title: "Remove from recent",
        category: "File",
        description: "Removes a folder from the recently opened list (the folder itself stays).",
        input: s.object({ path: s.string().describe("Absolute folder path") }),
        effects: [],
        agent: "hidden",
        palette: false,
        run: async ({ path }) => {
          await workspace.removeRecent(path);
          return { recent: workspace.recent.peek().length };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "workspace.pinRecent",
        title: "Pin folder in recent",
        category: "File",
        description:
          "Pins a folder at the top of the recent folders (the welcome page, File → Open recent), or unpins it; pinned folders are never dropped from the list.",
        input: s.object({
          path: s.string().describe("Absolute folder path"),
          pinned: s.boolean().describe("Default true").optional(),
        }),
        effects: [],
        agent: "hidden",
        palette: false,
        run: async ({ path, pinned }) => {
          await workspace.setPinned(path, pinned ?? true);
          return { pinned: workspace.pinned.peek().length };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "workspace.newFile",
        title: "New file…",
        category: "File",
        description:
          "Creates a file: in the open folder (explorer.newFile), or — with no folder open — wherever the system save dialog says, opening its folder.",
        input: s.empty(),
        effects: ["write"],
        agent: "hidden",
        run: async () => {
          if (workspace.root.peek()) return dispatcher.execute("explorer.newFile");
          const path = await dialogIpc.pickSavePath("New file", "untitled.txt");
          if (!path) return { created: null };
          // Files are reachable inside the open folder: open the file's folder first.
          if (!(await workspace.open(dirname(path)))) return { created: null };
          const exists = await fsIpc
            .stat(path)
            .then(() => true)
            .catch(() => false);
          if (!exists) await fsIpc.write(path, new Uint8Array());
          await dispatcher.execute("editor.openFile", { path });
          return { created: path };
        },
      }),
    );

    sub.add(
      dispatcher.register({
        id: "explorer.focus",
        title: "Show explorer",
        category: "View",
        description: "Shows the file explorer in the sidebar and focuses it.",
        input: s.empty(),
        effects: [],
        run: (_input, ctx) => ctx.execute("view.show", { id: "explorer.view" }),
      }),
    );
    sub.add(
      dispatcher.register({
        id: "explorer.refresh",
        title: "Refresh explorer",
        category: "Explorer",
        description: "Re-reads every expanded folder from disk.",
        input: s.empty(),
        effects: ["read"],
        when: "workspaceOpen",
        run: () => view?.refresh(),
      }),
    );
    sub.add(
      dispatcher.register({
        id: "explorer.moreActions",
        title: "Explorer: more actions",
        category: "Explorer",
        description:
          "Opens the explorer's actions menu (refresh, reveal, terminal, copy path, close folder) at `x`, `y` (default: the mouse).",
        input: s.object({ x: s.number().optional(), y: s.number().optional() }),
        effects: [],
        run: ({ x, y }) => view?.showMoreMenu(x ?? 200, y ?? 80),
      }),
    );
    sub.add(
      dispatcher.register({
        id: "explorer.collapseAll",
        title: "Collapse folders in explorer",
        category: "Explorer",
        description: "Collapses every folder in the file tree.",
        input: s.empty(),
        effects: [],
        when: "workspaceOpen",
        run: () => view?.tree?.collapseAll(),
      }),
    );
    sub.add(
      dispatcher.register({
        id: "explorer.reveal",
        title: "Reveal in explorer",
        category: "Explorer",
        description: "Expands the folders leading to `path` and selects it in the file tree.",
        input: s.object({
          path: s.string().describe("File or folder, absolute or relative to the workspace root"),
        }),
        effects: ["read"],
        when: "workspaceOpen",
        run: async ({ path }, ctx) => {
          const root = workspace.root.peek();
          if (!root || !view?.tree) return;
          const target = workspace.resolve(path);
          if (!workspace.contains(target)) throw new Error(`Not inside the workspace: ${path}`);
          await ctx.execute("view.show", { id: "explorer.view" });
          await view.revealPath(target);
        },
      }),
    );

    sub.add(
      dispatcher.register({
        id: "explorer.find",
        title: "Find in explorer",
        category: "Explorer",
        description:
          "Opens the explorer's find bar (Ctrl+Alt+F): rows whose names contain `query` are highlighted among the shown rows (expanded folders), or with `filter` the only ones shown; the first match is selected. Returns how many match. To find a file anywhere, use quick open.",
        input: s.object({
          query: s.string().optional(),
          filter: s.boolean().describe("Show only matching rows (and their folders)").optional(),
        }),
        effects: ["read"],
        when: "workspaceOpen",
        run: async ({ query, filter }, ctx) => {
          await ctx.execute("view.show", { id: "explorer.view" });
          if (!view) throw new Error("The explorer isn't open.");
          return { matches: view.find(query, filter) };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "explorer.closeFind",
        title: "Close find in explorer",
        category: "Explorer",
        description: "Closes the explorer's find bar and shows every row again.",
        input: s.object({}),
        effects: [],
        palette: false,
        when: "workspaceOpen",
        run: () => view?.closeFind(),
      }),
    );
    sub.add(
      dispatcher.register({
        id: "explorer.dragOut",
        title: "Drag files out of the window",
        category: "Explorer",
        description:
          "Starts the operating system's drag of `paths` (workspace files or folders) out of the window, for another app to take; it needs the mouse button down, so it's run when an explorer drag leaves the window (D200). Returns whether they were dropped.",
        input: s.object({
          paths: s.array(s.string()).describe("Files or folders, absolute or relative to the root"),
        }),
        effects: ["read"],
        agent: "hidden",
        // Only useful mid-drag.
        palette: false,
        when: "workspaceOpen",
        run: async ({ paths }) => {
          const root = workspace.root.peek();
          if (!root) throw new Error("No folder is open.");
          const targets = paths.map((p) => workspace.resolve(p));
          const outside = targets.find((p) => !workspace.contains(p));
          if (outside) throw new Error(`Not inside the workspace: ${outside}`);
          return { result: await fsIpc.startDrag(targets) };
        },
      }),
    );

    registerWorkspaceCommands(sub, services);
    registerOpenDropped(sub, services);
    registerFileCommands(sub, services, () => view);
    registerClipboardCommands(sub, services, () => view);

    // ide://workspace — what an agent needs to orient itself.
    sub.add(
      state.register("ide://workspace", {
        description:
          "Open workspace: root (the first folder) path, name, trust, risky (downloads / home / desktop / temp / root, or null), expanded folders (relative), selection. A multi-root workspace (D251): `file` (its .code-workspace) and `folders` [{ name, path, risky, existingWorkspaceFolders }] (relative paths start with the folder's name), `missing` folders it lists that couldn't open.",
        get: () => {
          const root = workspace.root.peek();
          const tree = view?.tree;
          const file = workspace.file.peek();
          const rel = (p: string) => workspace.relative(p);
          return {
            root,
            name: root ? (file ? workspace.name.peek() : basename(root)) : null,
            open: root !== null,
            ...(file && {
              file,
              folders: workspace.folders.peek().map((f) => ({
                name: f.name,
                path: f.path,
                risky: services.trust.risky.riskOf(f.path)?.kind ?? null,
                existingWorkspaceFolders: [...presentWorkspaceFolders(f.path)],
              })),
              missing: workspace.missing
                .peek()
                .map((m) => ({ name: m.name, path: m.path, error: m.error })),
            }),
            // Where the IDE writes this project's settings, tasks, memory… (D189): extensions put
            // their project files there too (D181). workspaceFolders: every one read, highest
            // precedence first (the IDE's own, then a .vscode or the legacy folder the project has).
            workspaceFolder: workspaceFolderName(),
            workspaceFolders: [...workspaceFolders()],
            existingWorkspaceFolders: [...presentWorkspaceFolders()],
            // "trusted" | "restricted" | "unknown" (not decided yet). The git branch: ide://git/status.
            trust: services.trust.state.peek(),
            // D213: "downloads" (the Downloads folder or one in it), "home", "desktop", "temp"; null.
            risky: services.trust.risky.riskOf(root)?.kind ?? null,
            expandedFolders: root && tree ? tree.expandedIds().filter(isPath).map(rel) : [],
            selection: root && tree?.selection ? rel(tree.selection.path) : null,
            // Folder chains shown as one row (explorer.compactFolders), by their innermost folder.
            compactFolders: root && view ? view.compactRows().map(rel) : [],
          };
        },
      }),
    );

    // Persist expanded folders per workspace.
    sub.add(
      persistence.register("explorer", {
        save: () => {
          const root = workspace.root.peek();
          // Relative to their folder; a multi-root workspace's start with the folder's name (D251).
          return {
            expanded:
              root && view?.tree
                ? view.tree
                    .expandedIds()
                    .filter(isPath)
                    .map((p) => workspace.relative(p))
                : [],
          };
        },
        restore: (data) => {
          const root = workspace.root.peek();
          const expanded = (data as { expanded?: unknown }).expanded;
          if (!root || !view || !Array.isArray(expanded)) return;
          view.pendingExpanded = expanded
            .filter((p): p is string => typeof p === "string")
            .map((p) => workspace.resolve(p));
        },
      }),
    );
  },
};

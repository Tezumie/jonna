// The explorer's context menus (split from view.ts, D251): a row's or the empty area's, in VS
// Code's groups and order, and the header's ⋯ menu. A multi-root workspace's folder rows and
// header offer the workspace's actions (add, remove, rename a folder; save, close the workspace).
import { matchesWhen } from "../../core/context/index";
import type { DirEntry } from "../../core/ipc/fs";
import type { DisposableStore } from "../../core/lifecycle/index";
import { dirname, pathKey } from "../../core/paths/index";
import { knownIcon } from "../../ui/Icon";
import { type MenuItem, showContextMenu } from "../../ui/Menu";
import type { Tree } from "../../ui/Tree";
import { resourceContext } from "../../workbench/extensionFeatures";
import type { WorkbenchServices } from "../../workbench/services";
import { workspaceFolderCandidates, workspaceFolderName } from "../../workbench/workspaceFolder";
import { languageForPath } from "../editor/languages";

/** What the menus need from the explorer view. */
export interface ExplorerMenuHost {
  readonly services: WorkbenchServices;
  readonly store: DisposableStore;
  readonly tree: Tree<DirEntry> | undefined;
  run(command: string, input?: unknown): void;
  multiRoot(): boolean;
  folderFor(path: string): string | null;
  isFolderRow(entry: DirEntry | null | undefined): boolean;
}

export function openExplorerMenu(
  view: ExplorerMenuHost,
  item: DirEntry | null,
  x: number,
  y: number,
  extension: { id?: string | null; loaded?: boolean; dev?: boolean } | null,
): void {
  const key = (id: string) => view.services.keyboard.labelFor(id);
  const many = (view.tree?.selectedItems().length ?? 0) > 1;
  const isDir = item?.kind === "dir";
  const isFile = item?.kind === "file";
  const root = (item ? view.folderFor(item.path) : view.services.workspace.root.peek()) ?? "";
  const folder = item ? (isDir ? item.path : dirname(item.path)) : root;
  const multi = view.multiRoot();
  // A multi-root workspace's folder row: the folder itself can't be renamed, moved or deleted
  // here, only taken out of the workspace (D251).
  const folderRow = view.isFolderRow(item);
  const selected = (): string[] => {
    const paths = view.tree?.selectedItems().map((e) => e.path) ?? [];
    return item && !paths.includes(item.path) ? [item.path] : paths;
  };
  const run =
    (command: string, input: unknown = {}) =>
    () =>
      view.run(command, input);
  const viewers = isFile && item ? view.services.viewers.for(item.path) : [];
  const groups: MenuItem[][] = [];
  if (!item && multi)
    groups.push([
      {
        label: "Add folder to workspace…",
        icon: "folder-plus",
        run: run("workspace.addFolder"),
      },
    ]);
  if (item || !multi)
    groups.push([
      {
        label: "New file…",
        icon: "file-plus",
        keybinding: key("explorer.newFile"),
        run: run("explorer.newFile", { parent: item ? item.path : root }),
      },
      {
        label: "New folder…",
        icon: "folder-plus",
        keybinding: key("explorer.newFolder"),
        run: run("explorer.newFolder", { parent: item ? item.path : root }),
      },
      {
        label: "Reveal in file manager",
        icon: "folder-search",
        keybinding: key("explorer.revealInOs"),
        run: run("explorer.revealInOs", { path: folder }),
      },
      {
        label: "Open in integrated terminal",
        icon: "square-terminal",
        run: run("terminal.create", { cwd: folder }),
      },
    ]);
  if (isFile && item && !many)
    groups.push([
      {
        label: "Open to the side",
        icon: "columns-2",
        keybinding: key("editor.openToSide"),
        run: run("editor.openFile", { path: item.path, toSide: true }),
      },
      ...(viewers.length
        ? [
            {
              label: "Open with…",
              icon: "file-symlink" as const,
              run: run("editor.reopenWith", { path: item.path }),
            },
          ]
        : []),
      ...(viewers.some((v) => v.kind === "preview")
        ? [
            {
              label: "Open preview",
              icon: "eye" as const,
              keybinding: key("viewer.openPreview"),
              run: run("viewer.openPreview", { path: item.path }),
            },
            {
              label: "Open preview to the side",
              icon: "columns-2" as const,
              keybinding: key("viewer.openPreviewToSide"),
              run: run("viewer.openPreview", { path: item.path, toSide: true }),
            },
          ]
        : []),
      {
        label: "Reveal in file manager",
        icon: "folder-search",
        keybinding: key("explorer.revealInOs"),
        run: run("explorer.revealInOs", { path: item.path }),
      },
      {
        label: "Open in integrated terminal",
        icon: "square-terminal",
        run: run("terminal.create", { cwd: folder }),
      },
    ]);
  if (isDir && item)
    groups.push([
      {
        label: "Find in folder…",
        icon: "search",
        run: run("search.show", {
          include: [`${view.services.workspace.relative(item.path)}/**`],
        }),
      },
    ]);
  if (isFile && item && !many) {
    const base = view.services.context.get("explorerCompareBase");
    groups.push([
      {
        label: "Select for compare",
        icon: "git-compare",
        run: run("explorer.selectForCompare", { path: item.path }),
      },
      ...(typeof base === "string" && base !== item.path
        ? [
            {
              label: `Compare with ${base.split(/[\\/]/).pop() ?? "selected"}`,
              icon: "git-compare" as const,
              run: run("explorer.compareWithSelected", { path: item.path }),
            },
          ]
        : []),
    ]);
  }
  if (isFile && item && !many && view.services.dispatcher.has("history.show"))
    groups.push([
      { label: "Open timeline", icon: "history", run: run("history.show", { path: item.path }) },
    ]);
  if (item && view.services.dispatcher.has("agent.addContext"))
    groups.push([
      {
        label: isDir ? "Add folder to chat" : many ? "Add files to chat" : "Add file to chat",
        icon: "agent",
        run: run("agent.addContext", { paths: selected() }),
      },
    ]);
  // Always offered: the explorer's own copy, or what's on the system clipboard (a screenshot,
  // text) pasted as a new file (D190).
  const paste: MenuItem[] = view.services.workspace.root.peek()
    ? [
        {
          label: "Paste",
          icon: "clipboard-paste",
          keybinding: key("explorer.paste"),
          run: run("explorer.paste", item ? { dest: item.path } : {}),
        },
      ]
    : [];
  if (item && !folderRow)
    groups.push([
      {
        label: "Cut",
        icon: "scissors",
        keybinding: key("explorer.cut"),
        run: run("explorer.cut"),
      },
      {
        label: "Copy",
        icon: "copy",
        keybinding: key("explorer.copy"),
        run: run("explorer.copy"),
      },
      {
        label: "Duplicate",
        icon: "copy-plus",
        run: run("explorer.duplicate", { paths: selected() }),
      },
      ...(isDir ? paste : []),
    ]);
  else if (paste.length && (!multi || folderRow)) groups.push(paste);
  if (item && !many)
    groups.push([
      {
        label: "Copy path",
        icon: "clipboard-copy",
        keybinding: key("explorer.copyPath"),
        run: run("explorer.copyPath", { path: item.path }),
      },
      {
        label: "Copy relative path",
        icon: "clipboard-copy",
        run: run("explorer.copyPath", { path: item.path, relative: true }),
      },
    ]);
  if (item && folderRow && !many)
    groups.push([
      {
        label: "Rename in workspace…",
        icon: "pencil",
        run: run("workspace.renameFolder", { path: item.path }),
      },
      {
        label: "Remove folder from workspace",
        icon: "folder-x",
        run: run("workspace.removeFolder", { path: item.path }),
      },
    ]);
  if (item && !folderRow)
    groups.push([
      ...(!many
        ? [
            {
              label: "Rename…",
              icon: "pencil" as const,
              keybinding: key("explorer.rename"),
              run: run("explorer.rename", { path: item.path }),
            },
          ]
        : []),
      {
        label: many ? "Delete selected" : "Delete",
        icon: "trash-2",
        destructive: true,
        keybinding: key("explorer.delete"),
        run: run("explorer.delete", many ? {} : { path: item.path, withNested: true }),
      },
    ]);
  if (!item)
    groups.push([
      { label: "Refresh", icon: "refresh-cw", run: run("explorer.refresh") },
      { label: "Collapse folders", icon: "list-collapse", run: run("explorer.collapseAll") },
      multi
        ? { label: "Save workspace as…", icon: "save", run: run("workspace.saveAs") }
        : { label: "Close folder", icon: "folder-x", run: run("workspace.closeFolder") },
      ...(multi
        ? [
            {
              label: "Close workspace",
              icon: "folder-x" as const,
              run: run("workspace.closeFolder"),
            },
          ]
        : []),
    ]);
  if (!item)
    groups.push([
      {
        label: "Show hidden files",
        checked:
          view.services.settings.peek<boolean | undefined>("explorer.showExcludedFiles") === true,
        run: run("explorer.toggleExcludedFiles"),
      },
    ]);
  // Another workspace folder at the top of the project (.vscode, the legacy folder name; D189).
  // (At the top of any of a multi-root workspace's folders.)
  const root0 = item ? view.services.workspace.folderOf(item.path)?.path : undefined;
  if (
    item &&
    isDir &&
    !many &&
    root0 &&
    pathKey(dirname(item.path)) === pathKey(root0) &&
    item.name !== workspaceFolderName() &&
    workspaceFolderCandidates().includes(item.name)
  )
    groups.push([
      {
        label: `Merge into ${workspaceFolderName()}…`,
        icon: "git-merge",
        run: run("workspace.mergeFolder", {
          folder: item.name,
          ...(multi && { root: root0 }),
        }),
      },
    ]);
  // An extension's folder (D176): run it for development, install it for every folder.
  if (item && isDir && extension && !many) {
    const id = extension.id ?? undefined;
    const ext: MenuItem[] = [];
    if (!extension.loaded)
      ext.push({
        label: "Run as development extension",
        icon: "play",
        run: run("extensions.loadUnpacked", { folder: item.path }),
      });
    if (!extension.loaded || extension.dev)
      ext.push({
        label: "Install extension permanently",
        icon: "box",
        run:
          extension.loaded && id
            ? run("extensions.installPermanently", { id })
            : run("extensions.installFromFolder", { folder: item.path }),
      });
    if (extension.loaded && id)
      ext.push({
        label: "Extension details",
        icon: "info",
        run: run("extensions.showDetails", { id }),
      });
    groups.push(ext);
  }
  // Commands extensions add here (`menus` in their manifest, D176).
  const target = item?.path ?? root;
  if (target) {
    const keys = resourceContext(
      target,
      !item || isDir,
      isFile ? languageForPath(target) : undefined,
    );
    const contributed = view.services.extensionFeatures
      .menuItems("explorer/context", (when) =>
        matchesWhen(when, (k: string) => (k in keys ? keys[k] : view.services.context.get(k))),
      )
      .map(
        (m): MenuItem => ({
          label: m.title,
          ...(m.icon && { icon: knownIcon(m.icon) }),
          run: run(m.command, { path: target }),
        }),
      );
    if (contributed.length) groups.push(contributed);
  }
  const items = groups
    .filter((g) => g.length)
    .flatMap((g, i) => g.map((it, j) => ({ ...it, separatorBefore: i > 0 && j === 0 })));
  view.store.add(showContextMenu(x, y, items));
}

/** The header's ⋯ menu: folder-level actions (VS Code's explorer "…" plus close folder). */
export function showExplorerMoreMenu(view: ExplorerMenuHost, x: number, y: number): void {
  const key = (id: string) => view.services.keyboard.labelFor(id);
  const root = view.services.workspace.root.peek();
  const run =
    (command: string, input: unknown = {}) =>
    () =>
      view.run(command, input);
  // A multi-root workspace (D251): its actions instead of one folder's.
  if (root && view.multiRoot()) {
    view.store.add(
      showContextMenu(x, y, [
        {
          label: "New file…",
          icon: "file-plus",
          keybinding: key("explorer.newFile"),
          run: run("explorer.newFile"),
        },
        { label: "New folder…", icon: "folder-plus", run: run("explorer.newFolder") },
        {
          label: "Refresh",
          icon: "refresh-cw",
          separatorBefore: true,
          run: run("explorer.refresh"),
        },
        { label: "Collapse folders", icon: "list-collapse", run: run("explorer.collapseAll") },
        {
          label: "Show hidden files",
          checked:
            view.services.settings.peek<boolean | undefined>("explorer.showExcludedFiles") === true,
          run: run("explorer.toggleExcludedFiles"),
        },
        {
          label: "Find in workspace…",
          icon: "search",
          keybinding: key("search.show"),
          run: run("search.show"),
        },
        {
          label: "Add folder to workspace…",
          icon: "folder-plus",
          separatorBefore: true,
          run: run("workspace.addFolder"),
        },
        { label: "Save workspace as…", icon: "save", run: run("workspace.saveAs") },
        {
          label: "Open folder…",
          icon: "folder-open",
          separatorBefore: true,
          keybinding: key("workspace.openFolder"),
          run: run("workspace.openFolder"),
        },
        { label: "Close workspace", icon: "folder-x", run: run("workspace.closeFolder") },
      ]),
    );
    return;
  }
  const items: MenuItem[] = root
    ? [
        {
          label: "New file…",
          icon: "file-plus",
          keybinding: key("explorer.newFile"),
          run: run("explorer.newFile"),
        },
        { label: "New folder…", icon: "folder-plus", run: run("explorer.newFolder") },
        {
          label: "Refresh",
          icon: "refresh-cw",
          separatorBefore: true,
          run: run("explorer.refresh"),
        },
        { label: "Collapse folders", icon: "list-collapse", run: run("explorer.collapseAll") },
        {
          label: "Show hidden files",
          checked:
            view.services.settings.peek<boolean | undefined>("explorer.showExcludedFiles") === true,
          run: run("explorer.toggleExcludedFiles"),
        },
        {
          label: "Reveal in file manager",
          icon: "folder-search",
          separatorBefore: true,
          run: run("explorer.revealInOs", { path: root }),
        },
        {
          label: "Open in integrated terminal",
          icon: "square-terminal",
          run: run("terminal.create", { cwd: root }),
        },
        {
          label: "Find in folder…",
          icon: "search",
          keybinding: key("search.show"),
          run: run("search.show"),
        },
        {
          label: "Copy path",
          icon: "clipboard-copy",
          separatorBefore: true,
          run: run("explorer.copyPath", { path: root }),
        },
        {
          label: "Open folder…",
          icon: "folder-open",
          separatorBefore: true,
          keybinding: key("workspace.openFolder"),
          run: run("workspace.openFolder"),
        },
        {
          label: "Add folder to workspace…",
          icon: "folder-plus",
          run: run("workspace.addFolder"),
        },
        { label: "Close folder", icon: "folder-x", run: run("workspace.closeFolder") },
      ]
    : [
        {
          label: "Open folder…",
          icon: "folder-open",
          keybinding: key("workspace.openFolder"),
          run: run("workspace.openFolder"),
        },
      ];
  view.store.add(showContextMenu(x, y, items));
}

# extensions/explorer

Workspace folder + file tree. Lazy, virtualized `Tree`; refreshes from watcher batches of the
expanded folders; ignored files dimmed. Multi-select (Ctrl/Cmd, Shift), DESIGN.md §12.4 row states,
indent guides on hover, tinted file icons. Single click opens a preview tab, double-click/Enter a
normal one; the active editor's file is revealed (`explorer.autoReveal`). Chains of single folders show as one row (`explorer.compactFolders`, D122). Dragging rows onto a
folder moves them (`treeMove.ts`, the target folder is highlighted while dragging); files dropped
from the OS are copied in (`explorer.importDropped`); dropped anywhere else they open
(`openDropped.ts`, `explorer.openDropped`, D281: files in the group under the pointer, a folder as
or beside the workspace); cut/copy/paste in `clipboard.ts`. New file /
folder and rename edit inline in the tree (`inlineEdit.ts`, validated as you type). Sticky folder
rows at the top while scrolling (`Tree` `sticky` option; click one to jump to and collapse it).

**Commands:** `workspace.openFolder` (Ctrl+K Ctrl+O / ⌘O; `newWindow`), `workbench.newWindow` (Ctrl+Shift+N, a second IDE process, D139), `explorer.focus` (Ctrl/Cmd+Shift+E),
`explorer.refresh`, `explorer.collapseAll`, `explorer.reveal`, `explorer.newFile`,
`explorer.newFolder`, `explorer.rename` (F2), `explorer.delete` (Delete / ⌘⌫; destructive → confirm;
all selected items), `explorer.cut` / `explorer.copy` / `explorer.paste` (Ctrl/Cmd+X/C/V in the
sidebar), `explorer.move`, `explorer.copyPath`, `explorer.importDropped`,
`explorer.restoreDeleted` (what was deleted from this folder in the last 30 days, from the app
trash), `explorer.toggleExcludedFiles` (`explorer.showExcludedFiles`: what `files.exclude`
hides, dimmed), `explorer.moreActions` (the header's "…" menu), `workspace.openRecent`,
`workspace.removeRecent`, `workspace.closeFolder`.
Paths may be absolute or relative to the workspace root.

**Settings:** `explorer.autoReveal`, `explorer.compactFolders`, `explorer.folderIcons`,
`explorer.showExcludedFiles`, `explorer.confirmUndo`, `explorer.fileNesting.enabled` / `.expand` /
`.patterns` (D201).

**State:** `ide://workspace` (with `workspaceFolder`, D181). **Persists:** expanded folders. The
sidebar view is `explorer.view`; Timeline is a collapsed section under it by default, and Outline
too once it's hidden from the activity bar.

Context menus follow VS Code's groups and order (D87): open to the side / with / preview, reveal
in file manager (`explorer.revealInOs`), integrated terminal, find in folder, timeline, add to
chat, cut/copy/paste, copy path, rename/delete. Every file operation is a workspace history entry
(`undo.ts`, D86): Ctrl/Cmd+Z in the explorer undoes it; deletes go to the app trash.

Undo (`undo.ts`, D141): created / deleted / moved operations check first, roll back partial
work, reopen expanded folders after a restored delete. Import updates (`imports.ts`, DOM-free
and tested; `importUpdates.ts`): after a rename or move, relative imports to moved JS/TS files
are rewritten as `editor.updateImportsOnFileMove` says, in the same undo entry.

Dragging rows onto the dock (D190): the selection goes together when the dragged row is in it
(`editor.openPaths` opens them in one group); a folder opens as a folder browser tab
(`folderView.ts`, view type `folder`): up a level (inside the open folder), folders first, a file
opens in that group and the browser closes. Paste (`clipboard.ts`) turns text or a picture copied
elsewhere into a new file named inline; the explorer's own Copy puts the paths on the system
clipboard too, which is how Paste tells the two apart.

WSL (D192): `wsl.ts` has `workspace.openWslFolder` (Windows only; picks a distribution, starts the
folder dialog at its home) and the "WSL: <distro>" status item. The Rust side routes programs in
a `\\wsl.localhost\…` folder through `wsl.exe` (`src-tauri/src/wsl.rs`). `workspace.pinRecent`
pins a folder at the top of the recent list.

Workspace folders (D189): `workspaceFolders.ts` marks the project's lower workspace folder
(`.vscode`, …) where the IDE's own overrides it, and `workspace.mergeFolder` merges it into the
IDE's own.

The root as a target (D200): a click on the space below the rows or on the root header, or
Escape, clears the selection; a right-click there opens the root's menu with nothing selected, so
New file / New folder go to the root. `findBar.ts`: the find bar (`explorer.find {query?,
filter?}`, Ctrl+Alt+F; `explorer.closeFind`) over the tree's find API (`ui/treeFind.ts`); typing
in the tree moves to the next matching name. `explorer.dragOut {paths}`: a drag leaving the
window starts the OS drag (`fsIpc.startDrag`, Rust `fs_start_drag`, the `drag` crate), started by
the dock's drag controller (`workbench/dock/dnd.ts`).

File nesting (D201, VS Code's `explorer.fileNesting.enabled` (off), `.expand` (on), `.patterns`
with VS Code's defaults): `nesting.ts` (DOM-free, tested) works out which files of a folder go
under which (`${capture}`, `${basename}`, `${extname}`, `${dirname}`, `*`; one level; a file named
by two parents goes under the shorter name; cycles stay at the top). A nest parent row
(`is-nest-parent`) has its own chevron (`data-tree-twistie`): a click on the name opens the file,
the chevron toggles (`TreeDataSource.opensWithChildren` / `startsExpanded`). Revealing a nested
file expands its parent. A collapsed nest parent stands for its nested files too (D203, VS Code's
explorer context): delete, cut, copy, duplicate and a drag of the selection take them along
(`withNestedFiles` in `nesting.ts`, `ExplorerView.withNestedFiles`), and the delete confirmation
counts and lists them; an expanded one acts on itself only (its nested files are rows to select).
Given paths (`path` / `paths`, agents) act on those alone unless `withNested: true`, which the
context menu's Delete and a drag pass.

Multi-root workspaces (D251): `workspaceCommands.ts` has `workspace.addFolder`, `removeFolder`,
`renameFolder`, `saveAs`, `openWorkspaceFile`. In a multi-root workspace the tree's hidden root
is the workspace (`WORKSPACE_ROOT`) and its rows are the folders (`is-workspace-folder`; no
rename, move or delete of a folder itself, only Rename in workspace / Remove folder from
workspace); each folder has its own files.exclude (`settings.peekAt`), reveal and drop scope;
expanded folders persist as `workspace.relative` paths. The header is the workspace's. The
context and ⋯ menus are in `viewMenus.ts`.

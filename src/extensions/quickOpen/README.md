# extensions/quickOpen

Quick access (DESIGN.md §12.6 quick input), VS Code's model (D133): the first character picks
what the box searches — `quickAccess.ts` (tested) parses it.

| Prefix | Searches | Keys |
|---|---|---|
| (none) | files: the Rust workspace index (fuzzy-ranked there), this workspace's recent files first; `file:line[:col]` | Ctrl/Cmd+P, Ctrl/Cmd+E |
| `>` | commands with keybindings, ordered by `commandRank.ts` (tested): how well the label matches (a word start, consecutive letters, scattered), then recently run first; a start of "theme" puts Color theme first. Asks for required arguments (`input.ts`) | Ctrl/Cmd+Shift+P, F1 |
| `@` | symbols in the active editor (`ide://editors/active/outline`) | Ctrl/Cmd+Shift+O |
| `#` | symbols in the workspace (`workspaceSymbols.ts`: language servers' `workspace/symbol` plus a declaration search; tested) | Ctrl/Cmd+T |
| `@:` | the same, grouped by kind ("functions (3)"; `groupByKind`, tested) | |
| `:` | a line (and column) in the active editor | Ctrl+G |
| `%` | text in the folder's files (a detached Rust search, the first 100 lines, the search settings' excludes and smart case) | |
| `edt ` | open editors, by group | |
| `view ` | views: the side bar's, the panels, extensions' openers | |
| `task ` | tasks (`tasks.list`), run with `tasks.run` | |
| `debug ` | launch configurations, the active file's, "Add configuration…" | |
| `term ` | terminals (`ide://terminals`), and "Create new terminal" | |
| `?` | the prefixes | |

The word providers live in `providers.ts`; each lists what an existing command or state path knows
and a pick runs that command. Rows can start a group (`QuickPickItem.separator`). In any mode that
lists files (files, `@`, `#`, `%`, `edt `), **Ctrl/Cmd+Enter** opens the picked file to the side
and **→** at the end of the text opens it in the background, the box staying open (VS Code's).

`goto.ts` parses `file:line[:col]` (tested). Ctrl+Tab / Ctrl+Shift+Tab switch between open editors,
most recently used first (release Ctrl to open).

**Commands:** `quickOpen.show {query?}`, `quickOpen.goToSymbol`, `quickOpen.goToWorkspaceSymbol`,
`quickOpen.openView` ("view "), `quickOpen.quickTextSearch` ("%"), `quickOpen.showEditors` ("edt "),
`quickOpen.switchEditor {back?}`; for agents `quickOpen.search {query, limit}` (files) and
`quickOpen.findSymbols {query, limit}` (declarations). `quickOpen.pickFile {extensions?}` lets the user
pick a project file and returns its relative path (for pages and extensions).
**State:** `ide://workspace/recentFiles`. **Persists:** recent files per workspace.

**Multi-root workspaces (D251):** files come from every folder (the index's items name their
folder's `root` when it isn't the first; `goto.ts` `indexItemFile`, tested) and show workspace paths
(the folder's name first); rows open by absolute path. Recent files persist as workspace paths
(`workspace.relative` / `resolve`), and `ide://workspace/recentFiles` lists them so. `#` and
`quickOpen.findSymbols` keep symbols from every folder (`SymbolScope`), `%` searches every folder
with each one's excludes (`search/folders.ts`), `term ` and `edt ` describe paths the same way.

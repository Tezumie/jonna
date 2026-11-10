# extensions/search

Search and replace in files, as the sidebar's search view (`view.ts`): query with match case /
whole word / regex toggles, replace field with preserve case and a live preview, include/exclude
globs with "only open editors" and "use exclude settings and ignore files" toggles, results tree
(file → lines) filled while the Rust search (`src-tauri/src/search`) streams over a Channel.
`model.ts` holds the results, the preview logic and `effectiveOptions` (the `search.*` settings
applied to what the form holds), DOM-free and tested.

**Multi-root workspaces (D251, `folders.ts`, tested):** every folder is searched. An include /
exclude glob starting with a folder's name (`api/**`, `./api/src`, the bare `api`) means "in that
folder" (VS Code's), others apply in every folder; each folder gets its own `search.exclude` /
`files.exclude` (`settings.peekAt`). Folders that end up with the same options share one Rust call
(no `roots` when that's all of them); otherwise the runs go one after the other into one result
set (`chainSearches`: one `done`, the result limit shared). Results carry workspace paths (the
folder's name first), so the tree view's top level is the folders, `ide://search/last`, copy,
dismiss, replace and search editors (`.code-search` paths) resolve them back with
`workspace.resolve`. "Find in folder…" passes `<workspace.relative(folder)>/**`. A removed
folder's results go.

**`search.find`** (D306, not in the palette): the same search apart from the view (its query,
options and results stay), returning every matching file with its lines and ranges, up to
`maxResults`; `multiLine` lets a regex span lines with `.` matching line breaks (Rust's
`SearchOptions.multi_line`). The agent's search tool runs on it.

**Commands:** `search.show` (Ctrl/Cmd+Shift+F), `search.run` (agents: waits and returns up to 200
lines), `search.replace` (confirms; writes files; `lines` for one result), `search.cancel`,
`search.clear`, `search.dismiss`, `search.collapseAll`, `search.expandAll`, `search.copyResults`,
`search.toggleOption`, `search.findInFolder`, `search.excludeFolder`.
**Settings:** `search.exclude`, `search.useIgnoreFiles`, `search.followSymlinks`,
`search.smartCase`, `search.maxResults`, `search.searchOnType`,
`search.searchOnTypeDebouncePeriod`, `search.showLineNumbers`, `search.collapseResults`,
`search.seedWithNearestWord` (D192: with no selection, Find in files starts with the word at the
cursor).
**State:** `ide://search/last` (with `viewMode`).

**History and tree (D172):** Up / Down in the query, replace, include and exclude boxes walk
`SearchModel.history` (`InputHistory`, saved per folder with the view mode); a query is
remembered on Enter, on leaving the box, on opening a result, and for every `search.run` that
waits (agents, the palette). `search.toggleViewMode` (the header's tree button) groups results by
folder (`folderTree`, single-child folders compacted like VS Code); `search.defaultViewMode`.

Results can be dismissed per file or per line (the ✕ on a row, `search.dismiss`; they return with
the next search). Right-click a result for VS Code's menu (D139).

Replace all is one workspace undo entry (D86): each file goes back to its local-history snapshot
unless it changed since.

**Search editors (D196):** `searchEditor.ts` — a search in an editor tab (dock view
`searchEditor`): query, toggles, include / exclude and context lines on top, the results below as
a document; click a line to go there. Saved as `.code-search` files in VS Code's format
(`core/search/searchEditor.ts`, tested), which open in it (a viewer registered for the extension)
and search again. Commands: `search.openEditor` (also the Search view's header button; without a
query, the view's), `searchEditor.run`, `searchEditor.save`. Setting:
`search.searchEditor.defaultNumberOfContextLines`. State: `ide://search/editor`.

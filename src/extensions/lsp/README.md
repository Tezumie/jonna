# extensions/lsp

The language-server client (D68). Servers come from extensions' `contributes.languageServers`
(e.g. `builtin.language-servers`) and the user's `lsp.servers` setting (`servers.ts`, tested), and
start when a document of one of their languages opens (`manager.ts`). Each runs in the Rust host
(`src-tauri/src/lsp`: stdio + framing); the protocol client is `src/core/lsp` (DOM-free, tested);
running clients are published on `services.languageClients` and the editor attaches them to Monaco
(`editor/monaco/lsp.ts`: sync, markers, providers). A server that crashes while running starts
again after a second, at most 4 times in 3 minutes (then it stays failed, with a notification).
Messages to one server go out in order (`core/ipc/ordered.ts`: each Tauri send is its own async
command); a relative `command` (`./node_modules/.bin/x`) is under the folder, and on Windows an
absolute one without extension finds its `.cmd` shim.

**Commands:** `lsp.list`, `lsp.restart`, `lsp.stop`, `lsp.showLog`, `lsp.install {server?}`,
`lsp.statusAction`, and for agents `lsp.hover`, `lsp.definition`, `lsp.references`, `lsp.symbols`,
`lsp.codeActions {path, line, column}` (files that aren't open are opened in the server just for the
query). **Settings:** `lsp.enabled`, `lsp.servers` (user scope only), `lsp.offerInstall`,
`lsp.dontOfferInstall`. **Status bar:** the active file's server: running, starting (with the
server's work-done progress, e.g. "indexing"), "Install X" when it's missing, or failed (click:
install or log). **State:** `ide://lsp`.

**Install on demand (D199).** A contributed server can list `install` methods
(`{ tool, package, platforms? }`; tools npm, pip, go, rustup, dotnet, gem, brew, winget).
`install.ts` (DOM-free, tested) turns one into a command line; `lsp.install` picks the first method
whose tool is on PATH and runs it in a terminal (`terminal.runCommand`), then starts the server.
When a file opens and its server is missing, a notification offers Install / Don't ask again
(not for servers from the user's `lsp.servers`, nor ones without install methods).

**Protocol (D199):** the client advertises `workspace/applyEdit`, `workspace/executeCommand`,
`didChangeWatchedFiles` (sent from the files.* events), `$/progress`, `window/showMessageRequest`
(a notification with the server's buttons), and the editor providers: code actions (with resolve),
code lens, inlay hints, semantic tokens, folding and selection ranges, declaration, document links.

**D204:** semantic tokens with deltas (`full/delta`, applied to the tokens kept per document,
`core/lsp/semanticTokens.ts`) and ranges (the visible range while a large file's full tokens are
on the way), colored through VS Code's type → TextMate scope table (`editor/monaco/semanticStyling.ts`;
`editor.semanticHighlighting.enabled`, on); workspace pull diagnostics (`workspace/diagnostic`
with result ids and partial results, `editor/monaco/lspPull.ts`), shown in Problems for files that
aren't open and pulled again after edits and on `workspace/diagnostic/refresh`. **Server settings:**
`serverSettings.ts` (tested) holds the known settings of pyright, rust-analyzer, gopls,
typescript-language-server, clangd, yaml and lua servers; the "Language server settings" tab
(`settingsView.ts`, `lsp.openServerSettings {server?}`, also from the status bar item) shows them
as controls plus the user's `settings` / `initializationOptions` as JSON. Writes go to
`lsp.servers.<name>` (merged key by key over the server's own); a settings-only change is sent with
`workspace/didChangeConfiguration` (the merged settings, also sent once after start) without a
restart; anything else restarts. Commands `lsp.serverSettings`, `lsp.setServerSetting {server, key,
value?, target?}`, `lsp.setServerSettingsJson`. State `ide://lsp/settings`.

**D218:** the settings page knows 12 servers (also intelephense, bash-language-server, taplo,
ruby-lsp, zls); the workspace is pulled again 2 s after each `workspace/diagnostic` answer (VS
Code's client; failures back off to 60 s, a server without the method or `ServerCancelled` with
`retriggerRequest: false` stops the timed pulls, a hidden window waits), `nextWorkspacePull` /
`workspacePullOutcome` in `core/lsp/workspaceDiagnostics.ts`; a notebook's save is its joined
document's (`client.joinedDocuments`, set by the notebook binding, D229); `didSave` sends the text when the
server's `save.includeText` asks (`client.didSave(path, text?)`, the editor binding's
`flushDocument` sends a pending change first); a closed file's model kept for undo is closed for
the server (`editor/monaco/keptClosed.ts`: didClose, reopened with didOpen), so what the server
reports for closed files is listed; pushes for files with no model are listed too (marker service
`changeOne`). The stdio host's `lsp_start` / `lsp_send` / `lsp_stop` / `lsp_close_stdin` (and
`stop_all` on reload / folder close) run on blocking threads.

**Python interpreter (D200):** `python.ts` (tested): `python.defaultInterpreterPath`, else the
folder's `.venv` / `venv` / `env`, given to servers of Python as `python.pythonPath`
(`LspManager.extraSettings`, merged over the server's settings; `configurationChanged` sends
`workspace/didChangeConfiguration`). `python.selectInterpreter {path?}` and the status bar's
Python item. On Windows `lsp.install` reads PATH again after an install (`appIpc.refreshPath`).

**Call and type hierarchies, document colors (m7-11).** D255: a hierarchy comes from a
`HierarchySource` (`hierarchySource.ts`, tested): the language server's, or an extension's
provider where no server answers (its items turned into LSP's shape and back). `hierarchy.ts` registers the commands and
`hierarchyView.ts` the `hierarchy` dock tab (singleton, bottom, not restored after a restart),
VS Code's Call Hierarchy / Type Hierarchy view: a header ("Callers of f"), a lazy tree (the roots
open expanded; each row's next level is asked when it's expanded, `core/lsp/hierarchy.ts`
`HierarchySession`), a toolbar button that switches direction (incoming ↔ outgoing calls,
supertypes ↔ subtypes; the roots stay, their levels are asked again), and a click on a row opens
the first call site (incoming: in the caller; outgoing: in the parent) or the type in a preview.
**Commands:** `lsp.showCallHierarchy` (Shift+Alt+H, when the active file's server offers it) and
`lsp.showTypeHierarchy` `{path?, line?, column?, direction?}` (default: the active editor's
cursor; both in the editor's context menu while the server offers them, context keys
`editorHasCallHierarchyProvider` / `editorHasTypeHierarchyProvider`), `lsp.setHierarchyDirection
{direction?}` (the toolbar's switch), and for agents `lsp.callHierarchy` / `lsp.typeHierarchy`
`{path, line, column, direction?, depth?}` (1–4 levels, at most 200 rows): name, kind, path,
1-based line/column, `calls` (the call sites) and `children`. **State:** `ide://lsp/hierarchy`
(kind, direction, server, `outdated`, the rows loaded so far with their `id`).
**m7.12:** `lsp.refreshHierarchy` (the tab's Refresh: prepare asked again where the view was
opened, same direction; the old roots are asked again when nothing is found there now) and
`lsp.showHierarchyOfItem {id}` (re-roots on a row, same direction, VS Code's Show call hierarchy
on a row). Rows have a menu: Show call/type hierarchy of this item, Go to definition
(`editor.openFile` at the symbol, where a click opens the call site), Copy path
(`explorer.copyPath`), Refresh. An edit or save in a file the tree points into (its symbols'
and call sites' files) shows a "Results may be outdated." bar with Refresh; the tree isn't
rebuilt under the user. `core/lsp/hierarchy.ts` gained `findNode`, `treeFiles`, `nodeOrigin`. The client advertises `callHierarchy`,
`typeHierarchy` and `colorProvider`; document colors are attached in `editor/monaco/lsp.ts`
(not for css/scss/less/json/jsonc, which Monaco's own services already color).

**Multi-root workspaces (D251).** One server per language for the window (as VS Code), with every
folder: `initialize`'s `workspaceFolders` and the `workspace/workspaceFolders` request list them
(`rootUri` and `${workspaceFolder}` in args are the first; `${workspaceFolder:Name}` names one).
A folder added or removed goes to running servers as `workspace/didChangeWorkspaceFolders` when
they announce `workspace.workspaceFolders.changeNotifications` (`LanguageClient.setWorkspaceFolders`,
`LspManager.foldersChanged`); others keep their folders, not restarted. A server still starting
is told once it's initialized; a rename alone (nothing added or taken out) isn't sent or logged.
With one folder servers get it named as before (the last part of its path: "C:" for a drive's
root, "root" for /). `workspace/configuration`
passes each item's `scopeUri`, so Pyright gets each folder's interpreter: venvs and
`python.defaultInterpreterPath` are looked for per folder (`ide://lsp` `python.folders`).
Agent queries resolve paths with `workspace.resolve` and show them with `workspace.relative`.
Tests: `core/lsp/folders.test.ts`, `servers.test.ts`.

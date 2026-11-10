# Extensions (third-party)

Hosts third-party extensions (D102; author guide: `docs/extensions.md`).

- `manager.ts` — `ExtensionManager`: finds installed and unpacked extensions (`extIpc.list`),
  validates manifests, asks for permissions, starts/stops/reloads them, polls unpacked folders
  for changes, lists folders under `<workspace folder>/extensions` (the IDE's own, or the project's
  `.vscode`, D177) that aren't loaded (with their
  manifest errors; D110), and answers the dispatcher's `authorize` for `caller: ext` (`extensions.*`
  commands ask the user, D261). Ids being installed or removed are `busy`: a refresh doesn't
  start them meanwhile; a folder that stops being trusted stops code running in Node
  (`stopUntrustedCode`).
- `crossExtension.ts` (tested) — what VS Code packages share, as the manager answers it (D295):
  one command registry (`routeVscodeCommand`: a declared command by its VS Code id, one
  registered only in code through its owner, `CodeCommandOwners`), view containers another
  package declares (`findViewContainer`), and the `vscode.extensions` list (`vscodePackageList`).
- `registry.ts` — `registry.json` parsing (unpacked folders, disabled ids, granted permissions,
  bundled extensions already seeded).
- Bundled extensions (D121) live in `src-tauri/bundled-extensions/` and are seeded by Rust
  (`seed_bundled`) into the installed ones once, disabled (Git tools on, D208);
  `extensions.restoreBundled` brings back the ones the user uninstalled (as on first start).
  A shipped bundled extension may claim built-in namespaces (`"namespaces": ["git"]`,
  `inClaimedNamespace`); the runtime skips such names for any other copy.
- `runtime.ts` — `ExtensionRuntime`: one extension's contributions (commands, keybindings,
  settings, views in the sidebar, panel or editor area) and its worker's requests, each checked
  against the granted permissions; activation (`*`, `onStartupFinished`, `onLanguage:`,
  `workspaceContains:`). `stop()` awaits the worker's process exit; a worker still starting is
  disposed with the runtime, and a disposed runtime answers no requests (D261). `stopCode()`
  stops only its code (trust revoked). A VS Code package's contributions as VS Code takes them:
  its manifest's warnings logged, a setting declared already shared (both may change it), its
  `configurationDefaults` registered (not for user-only, restricted or credential settings), its
  keys resolved (`resolveVscodeKeybindings`; unresolvable ones skipped with a warning), a view
  in another extension's container placed there (`viewContainer` from the manager; VS Code's
  "added to 'Explorer'" when none has it), and a command whose id the IDE has left the IDE's
  (VS Code would let it shadow the built-in one; here agents and the UI run the IDE's), with the
  extension's own keys for it still running its code.
- `runtimeApi.ts` — `ExtensionApiHost` (D176): status bar items, `editor.*`, `languages.*`
  (problems, hover and completion providers), `webview.openInWindow`, and the declarative menus,
  agents, MCP servers and model providers, into `services.extensionFeatures`.
- `runtimeProviders.ts` — the other language providers (D229, VS Code's
  `languages.register…Provider`): definition, references, formatting (document and range), code
  actions, rename, signature help, document symbols, code lens, inlay hints, semantic tokens; D234
  adds type definition, implementation, declaration, document highlights, folding ranges,
  document links, colors (`presentations` part), on-type formatting (`fs.write`), inline
  completions and workspace symbols (`ExtensionFeatures.workspaceSymbols`, merged by quick open).
  `languages.register { feature }` → a "provider" call to the worker; answers are checked by
  `workbench/extensionProviders.ts` (tested: paths in the folder, only its own commands on lenses
  and actions, limits) and bridged to Monaco by `editor/monaco/extensionProviders.ts`. The ones that
  change files (formatting, code actions, rename) need `fs.write`. Second calls go to
  `<id>.<part>` (tested, `runtimeProviders.test.ts`): rename's `prepare` (registered with
  `prepare: true`; Monaco's `resolveRenameLocation`, a throw is the reason shown), a code action's
  `resolve` and `release` (registered with `resolve: true`; offered actions carry a `resolveId`,
  their edits are asked for when chosen, Monaco's `resolveCodeAction`, and the ids are released
  when Monaco drops the list). `languages.refresh { id }` fires a semantic tokens provider's
  `onDidChange` (Monaco asks again). Code lenses keep their whole range.
  As in VS Code (the D295 audit): no time limits — Monaco's cancellation becomes an AbortSignal,
  `ExtensionWorker.call(…, signal)` posts `{ t: "cancel", id }` and the worker's `CallToken` (the
  provider's second argument; the shim's CancellationToken) fires. Providers are asked about the
  folder's files and, a VS Code package's, about any document open in the editor (`canAsk`:
  others open, `untitled:`, notebook cells with their text in `context.cell`), and the places they answer
  with (definitions, references, links, hierarchy items, inlay hint parts) may be anywhere on
  disk (`readablePath`); edits stay in the folder. Completions: no cap but `MAX_COMPLETIONS`
  (10 000), `{ items, isIncomplete }`, `resolve` (`<id>.resolve`), commit characters,
  insert/replace ranges, snippets, label details, a command after (the extension's own or
  triggerSuggest / triggerParameterHints). Inlay hints keep label parts (location, command,
  tooltip), `textEdits` and `resolve`; `semanticTokens` with `range: true` is a range provider;
  `inlineValues` feeds the debugger's inline values. Problems keep Hint, tags, their source, a
  code's web page and related places (`workbench/extensionDiagnostics.ts`), up to 50 000 files;
  `languages.list` is every language the editor knows (VS Code's getLanguages).
- `runtimeProgress.ts` — `ide.ui.withProgress` (D229): a progress toast
  (`Notifications.progress`, Cancel → the task's token) or a status bar item, per task.
- `bisect.ts` (tested), `bisectCommands.ts` — extension bisect (D229, VS Code's Help → Start
  extension bisect): `extensions.startBisect {confirm?, restart?}` turns half of the running
  extensions off (the registry's `bisect`, so it survives the restart; the user's own
  enabled/disabled list isn't touched) and restarts; after each restart a notification and the
  status bar item ask; `extensions.bisectAnswer {answer: good | bad | stop, restart?, disable?}`
  narrows it to one and offers to disable it; `extensions.stopBisect`. State
  `ide://extensions/bisect`; context key `extensionBisectActive`.
- `runtimeNotebooks.ts` — `ExtensionNotebooks` (D202): `contributes.notebooks` types (read and
  written by the worker's serializer) and kernel sources in `services.notebooks`; `ExtensionKernel`
  is the notebook editor's handle on a kernel living in the worker.
- `runtimeExtras.ts` — `ExtensionExtrasHost` (D202): workspace trust (`workspace.isTrusted`,
  `requireTrust`), the folder events (`workspace.didOpen` / `willClose` / `didClose` /
  `didChangeTrust`, and `didChangeFolders` { added, removed }, D251), context keys (`<id>.…`), `ui.showDialog`, and `state.register` paths
  (`ide://ext/<id>/…`; a shipped bundled extension may claim paths it declares).
- `runtimeGit.ts` — `ExtensionGitHost` (D208): `ide.git.*` ("git": repositories, blame, line log,
  diff names, rev-parse, merge-base, refs, stashes, show, the `git.didChange` event) on
  `services.gitAccess`, `ide.github.*` ("github": notifications) and
  `ide.editor.setLineAnnotations` ("fs.read", `services.gutterMarks.annotate`). runtime.ts also
  serves `documents.didChange` (250 ms per file), `tree.message`, `view.title` (a view's title and
  description from code, `services.views.titles`) and tree items' `actions` /
  `strong` (treeView.ts), commands' `when`, and views' `sectionOf` / `sectionOrder`.
- `runtimeOutput.ts` — `ExtensionOutputHost`: `ide.ui.createOutputChannel(name)` (VS Code's
  `window.createOutputChannel`), the extension's own Output channel `ext.<id>~<name>` (worker side
  `core/extensions/rpcOutput.ts`: lines batched per turn); `ide://extensions` `live.outputChannels`.
  A log channel (`{ log: true }`) is listed in `extensionFeatures.logChannels`; its worker hears
  the levels the user picks (`logLevels.get`, "provider" `logLevels`).
- `logLevelCommands.ts` — `extensions.setLogLevel` ("Set log level…", VS Code's Developer: Set Log
  Level): the default level or a log channel's own (`core/extensions/logLevels.ts`,
  `extensionFeatures.logLevels`), kept in the global state (`logLevels`); the shim's
  LogOutputChannel.logLevel / onDidChangeLogLevel and env.logLevel / onDidChangeLogLevel follow it.
  State `ide://extensions/logLevels`.
- `runtimeProcess.ts` — `ExtensionProcesses` (D202): `process.spawn` on the stdio host
  (`lspIpc`), "shell" + trust, 8 per extension, output batched to the worker, all killed when
  it stops, its worker dies, the folder closes or turns restricted. `interrupt()` is SIGINT, and on
  Windows a Ctrl+C on the program's hidden console (`src-tauri/src/lsp/ctrl_c.rs`, D229).
- `runtimeWorkbench.ts` — `ExtensionWorkbenchHost` (D233): what an extension plugs into the
  workbench's features, in five parts; the checks are DOM-free in `workbenchChecks.ts` (tested).
  - `runtimeTerminals.ts`: `ide.terminals.create` — a pseudoterminal ("terminal",
    `core/ipc/virtualPty.ts`, a tab with `pseudo` state) or a shell ("shell", trusted folder) — and
    task providers (`contributes.taskDefinitions`; custom executions run in a pseudoterminal).
    D264: `terminals.setEnvironment` (new terminals' variables, "shell",
    `extensionFeatures.terminalEnv`), link providers (`extensionFeatures.terminalLinks`, asked
    with a 500 ms limit) and the manifest's terminal profiles (`contributeProfiles`,
    `extensionFeatures.terminalProfiles`: picking one starts the code and asks its provider).
    A terminal made with `background` opens unshown; with `onEvent` the host follows it
    (`followTerminal`): process id, the tab closing or the process ending, being the terminal used
    last, the user typing, and shell integration (folder, commands' start and end) on
    `terminal.<id>`. The terminals it didn't make (the user's) are reported too, "terminal"
    (`terminals.watchOthers`, then `terminals.others` as they open; ids `u<n>`), followed the same
    way. A command's output (VS Code's TerminalShellExecution.read()) is cut from the terminal's
    output by its shell-integration marks (`terminalOutput.ts`, `CommandOutputCapture`): the first
    read asks `terminals.read`, the rest comes as `output` events until the command ends.
  - `runtimeScm.ts`, `scmSection.ts`: source controls, a section of `scm.view` each (input box,
    accept button, groups and resources in an `ExtensionTreeView`), counted in its badge, quick
    diff originals.
  - `runtimeDebugAdapters.ts`: `contributes.debuggers` types in the debug extension's registry from
    the start; executable, server port or inline adapters.
  - `runtimeAuth.ts`: authentication providers (sessions kept in the keychain when the provider
    doesn't), `getSession` (another extension's session only after a dialog), `ide.secrets`
    (`ext_secret_get` / `ext_secret_set`).
  - `runtimeFileSystems.ts`: `registerFileSystemProvider` — a scheme the editor reads and saves
    through, and an Explorer section (not for a VS Code package's, D260).
  - `runtimeWebviewPanels.ts`: `ide.ui.createWebviewPanel` (VS Code's `window.createWebviewPanel`):
    a dock tab of the type `extpanel:<id>` with a `WebviewFrame` (same origin, CSP and theme as
    a declared webview view); the HTML the code sets is served by the folder's proxy at
    `/__webview-<name>.html` (Rust `ext_webview_page`, a new name per change, so relative URLs reach
    the extension's files), `WebviewFrame.navigate` loads it; messages both ways, title and icon,
    `reveal`, view state (visible / active) and the tab's closing back to the worker. 50 per
    extension. Listed in `ide://extensions/providers`. A panel of a view type it can restore (a
    serializer its code registered, `webviewPanel.serializer`, or `onWebviewPanel:<viewType>` in
    its activation events) is saved with the folder (`extensions.webviewPanels`: view type, title,
    group and the state its page gave `setState`, which the bridge also posts to the host); after
    a restart it waits in `extensionFeatures.restorablePanels` (`workbench/webviewPanelRestore.ts`)
    until the extension is loaded, which reopens the tab, starts the code and calls
    `webviewPanelSerializer.<viewType>` (VS Code's deserializeWebviewPanel; getState() returns the
    saved state). Declared localResourceRoots and the workspace's folders are served at
    `/__fs/<absolute path>` (Rust `ext_webview_roots`, inside the workspace only).
  - `runtimeTesting.ts`: `ide.tests.createTestController` (VS Code's test API): each controller is
    an entry of `services.extensionFeatures.tests` (`workbench/extensionTests.ts`, which checks the
    worker's items, profiles and run events); the Testing view shows them and runs their profiles
    (`tests.runExtension`, `extensions/testing`).
  - `runtimeDebugAdapters.ts` also asks providers' `provideDebugConfigurations` for "Add
    configuration…" (`DebugAdapterEntry.provideConfigurations`; `checkProvidedConfigurations`
    in `workbenchChecks.ts`; an extension activating on `onDebugInitialConfigurations` /
    `onDebugDynamicConfigurations` / `onDebug` is started for it).
  - `workbenchCommands.ts`: `extensions.scmSetInput` / `scmAccept` / `scmOpenResource`,
    `extensions.authSignIn` / `authSignOut`, `ide://extensions/providers`.
  - `fileSystemCommands.ts` (D234): `extensions.fsNewFile` / `fsNewFolder` / `fsRename` /
    `fsDelete` through a file system provider (the Explorer section's buttons and row menu). A
    provider's `fireDidChange` reaches open editors (`FileSystemRegistry.onDidChangeFiles`, the
    editor's diskSync.ts); a restored tab of its scheme waits for it (`whenServed`, which starts
    extensions activating on `onFileSystem:<scheme>`); `editor.getText` / `replaceRange` and
    `ide.editor.text / replace / open` take registered URIs. The Accounts menu lists providers'
    accounts.
- `runtimeEditorEvents.ts` (D234): `editor.didChangeActive` / `didChangeSelection` /
  `didChangeVisibleRange` for `ide.events.on` ("fs.read"; `editorChanges` tested), from
  `ide://editors/active` after the editor's activity or a layout change.
- `runtimeEnv.ts` (D234): `env.openExternal` (https, http, mailto), `env.clipboardRead/Write`
  ("clipboard"), `fs.findFiles` (the file index by glob, every folder; a RelativePattern's
  `{ base, pattern }`: `workbenchChecks.ts` `matchWorkspaceFiles`, tested), `findText` and
  `workspaceContains` (every folder; runtime.ts checks folders added later again; a glob asks
  the index's quick search for its literal text first, then matches the folders' file list —
  up to the 50,000 the index lists, shared by every extension's check for 2 s).
- `runtimeWorkspace.ts` — `ExtensionWorkspaceHost` (D251, multi-root workspaces; worker side
  `core/extensions/rpcWorkspace.ts`, tested): the path gate every extension path goes through
  (`workspacePath` / `writablePath`: `workspace.resolve`, then inside one of the folders, never
  elsewhere; `.git` folders not writable), the folders mirror the worker keeps for VS Code's
  synchronous `workspace.workspaceFolders` / `rootPath` / `name` / `workspaceFile` (in the start
  message, then "workspace" calls: "snapshot" on any change, "changed" { snapshot, added, removed }
  from `onDidChangeFolders`; only with "fs.read"), the `workspace.root` / `folders` / `folderOf`
  requests, `workspace.updateFolders` (VS Code's updateWorkspaceFolders, `planFolderUpdate`
  checked again here; the user is asked before folders are added, then the workspace service's
  `addFolders` / `removeFolder` run directly — the workbench's `workspace.addFolder` /
  `removeFolder` commands are agent-hidden, which the permission policy refuses to extensions
  too; the request resolves false when the user declines or the change fails, and a failure is
  shown), and the workspaceState key (the workspace's location: the
  folder for one, the workspace file for several).
  `runtimeApi.ts` also has decoration types (`editor.createDecorationType` /
  `setDecorationType` / `clearDecorationType` / `disposeDecorationType`; checked by
  `workbench/extensionDecorationTypes.ts`, drawn with a generated stylesheet by
  `editor/monaco/extensionFeatures.ts`), and runtime.ts `storage.*` with `scope: "workspace"`
  (workspaceState, keyed in runtimeWorkspace.ts), quick pick separators / matchOnDescription and password input.
  `runtimeDebugAdapters.ts` resolves configurations (`debug.registerConfigurationProvider`).
- `runtimeHooks.ts` — `ExtensionHooksHost`, more of VS Code's API (worker side
  `core/extensions/rpcHooks.ts`, `rpcComments.ts`, `rpcChat.ts`; registry
  `workbench/extensionHooks.ts`, tested):
  - the `type` override: `ide.commands.register("type", …)` ("fs.write") takes what's typed in
    the editor (one extension at a time; a notice names it, with Keep and Turn off →
    `extensions.turnOffTypeOverride`, settings `extensions.typeOverride.acknowledged` /
    `.blocked`); `ide.commands.execute("default:type", { text })` types as the editor would
    (owner only; `hooks.typeDefault`, called directly: a UI-only command would be refused to an
    extension); `ide.editor.setOptions({ cursorStyle })` sets every editor's cursor
    while it owns typing or until reset;
  - `ide.ui.registerUriHandler` (one per extension; activation `onUri`) and `ide.env.uriScheme`
    (product.json's `urlScheme`): `extensions.openUri {uri}` (the user's; UI-only) hands `<scheme>://<extension id>/…`
    to it. The OS doesn't send such links to the IDE yet (no protocol registration);
  - `ide.workspace.applyEdit(edit)` / `createWorkspaceEdit()`: text edits across files (an open
    file changes in its editor, unsaved; a closed one on disk), files created, renamed or moved
    (`explorer.move` / `explorer.rename`) and deleted (`explorer.delete`, confirmed, to the app's
    trash), in order (`textEdits.ts` `planWorkspaceEdit`, tested);
  - `onWillSaveTextDocument` / `onWillSaveNotebookDocument` with `waitUntil` (1.5 s each; text
    edits need "fs.write");
  - `showQuickPick(items, { canPickMany: true })` (a session with a checkbox per row);
  - `runtimeQuickInput.ts`: live quick input sessions (`quickInput.open / update / hide`, VS
    Code's createQuickPick / createInputBox) on `QuickInput.openSession`; the user's value
    (debounced 50 ms), active and selected rows, Enter, buttons and the end go back on
    `quickInput.<id>`;
  - `runtimeTabs.ts`: `window.tabGroups` — snapshots of the editor groups on "tabs.didChange"
    ("fs.read", `core/extensions/tabModel.ts`), `tabs.close`;
  - `runtimeViews.ts`: views' visibility (`view.watch`, `view.<id>.visible`: an instance on
    screen) and tree badges (`tree.update`);
  - tree views' `handleDrop` / `dragAndDropController` (rows dragged within the view) and
    `TreeItem.checkboxState` with `onDidChangeCheckboxState` (`treeView.ts`).
  - `runtimeComments.ts`: `ide.comments.createCommentController` ("fs.read"): threads as a gutter
    mark with the thread on hover and code lenses (latest comment or count → 
    `extensions.showCommentThread`; Reply → `extensions.replyToComment`); the controller's
    `replyHandler` takes replies and threads started with `extensions.addComment` on a line its
    `commentingRangeProvider` allows.
  - `runtimeLm.ts`: `ide.lm.selectChatModels` / `sendRequest` (the user's model, streamed; only
    while `extensions.languageModelAccess` is on, default off, and after the extension's one-time
    consent, kept in `extensions.languageModelAllowed`) and `ide.chat.createChatParticipant`
    (`@name`s asked with `extensions.askChatParticipant`; the agent's chat doesn't route to them
    yet).
  - `hookCommands.ts`: those commands and `ide://extensions/hooks`.
- `viewers.ts` — file viewers (`contributes.viewers`): dock view `extviewer:<id>` + an entry in
  `services.viewers`; the page gets the file's text and saves with `fs.write`.
- `workerHost.ts` — `ExtensionWorker` over a transport (D255): the sandboxed worker
  (`webWorkerTransport`, `src/workers/extension.worker.ts`) or a Node process
  (`nodeTransport`: `"host": "node"` with the "node" permission in a trusted folder;
  `src/workers/extension.node.ts`, built to `workers/extension-node.cjs` and written to the data
  folder by `ext_node_host_script`, started on the stdio host with ndjson framing), the RPC
  (`src/core/extensions/rpc.ts`), activation timeout (the IDE's format only: a VS Code package
  is only called slow in its log), logs. An `activate` that throws rejects with
  `ActivationFailed` and the worker stays, with what it registered (D295).
- `sharedHost.ts` — `SharedNodeHost` (D295): every VS Code package's code runs in one Node
  process, as in VS Code; each extension keeps its own ExtensionRuntime / ExtensionWorker over its
  slice (`connect(id)`: messages tagged `x: <id>`, so requests are answered and checked as that
  extension's). It sends the process the installed VS Code packages (`setInstalled`, for
  `vscode.extensions`), unloads one extension (`unload` → deactivate, modules forgotten), ends
  the process with the last one, and reports a crash to every slice, then `onDidCrash`. Process
  side: `src/workers/extension.node.ts` (`require("vscode")` resolved per extension by the
  requiring file's folder, console output told apart by the files on its stack) and
  `core/extensions/vscode/extensionRegistry.ts` / `extensionsApi.ts` (live exports, `isActive`,
  `onDidChange`, the `vscode.git` and `vscode.ipynb` stand-ins). The IDE's own-format Node
  extensions keep a process each. Unloading one extension (disable, uninstall, update, reload)
  clears its timers (`core/extensions/vscode/hostResources.ts`, owners by the extension file on
  the stack); one that loaded native addons from its folder (`process.dlopen`; `unloaded` carries
  `native`) ends the process instead, as VS Code restarts its extension host: the others are told
  it ended (`onDidCrash(error, planned)`: restarted without a notice or the crash limit), and the
  stop resolves once the old process exited, so its folder can be deleted on Windows. The process
  runs in the host script's folder (VS Code's doesn't run in an extension's either; before the
  shared host, each VS Code package's own process ran in its folder): an extension spawning a
  program by a relative path joins it to `extensionPath`. Tested with a fake process
  (`sharedHost.test.ts`).
- Activation (D295, `core/extensions/activation.ts`, tested), as VS Code's: contributions are
  added for every extension first, then `*` / onStartup code starts in the background
  (`runtime.startIfDue`); `activationMemory` remembers the events that fired (onLanguage,
  onNotebook, onDebug, onFileSystem, onCommand; cleared when another folder opens) so an extension
  enabled, installed or let run (trust) later activates for them; `extensionDependencies`
  activate first and a missing or failed one refuses with VS Code's message (a notification, the
  extension marked failed, not retried until what's enabled changes); a failed `activate` keeps
  what it registered and isn't retried; the shared host restarts its extensions after a crash
  (at most 3 in 5 minutes). Disable and Uninstall ask about the extensions that depend on it
  (`askAboutDependents`).
- `contributions.ts` — declarative parts (ours and VS Code's): color themes (with `include`),
  languages (with `filenamePatterns`, `firstLine`), JSON grammars (any language's, injections),
  `semanticTokenScopes` / `semanticTokenTypes`, snippets, problem matchers and patterns (named, for tasks' `"$name"`,
  D229), file and product icon themes (fonts as data: URLs, D267) → `services.contributions`.
- `nodeRuntime.ts` — which Node runs extensions' code: PATH's, the downloaded pinned one, or
  (asked) a download now (D267); `extensions.downloadNode`.
- `treeView.ts`, `webview.ts` — tree views (rows' `view/item/context` menus and inline buttons
  from `core/extensions/treeMenus.ts`: `when` on `view` / `viewItem` = the item's `contextValue`;
  the command runs with `{ item }`) and webview pages (frames on the extension's own
  origin, CSP-restricted, messages relayed to the worker; a page moved into its own window
  takes its frame along and listens there). `webviewTheme` is what pages are sent (the IDE's
  tokens and VS Code's `--vscode-*` variables); `withInitialTheme` writes it into a VS Code page
  as it's served, so its first paint is already themed (D260). `runtimeCodePages.ts` serves
  pages code writes and moves the view's frames onto them, asking for the frames once the page
  is stored (a frame opened meanwhile isn't left on the empty page).
- `view.ts` — the Extensions sidebar view (filter, Installed / Development / Not loaded, rows with a gear menu).
- `details.ts`, `detailsTabs.ts` — an extension's page (dock tab `extension`): the README beside a
  side panel (facts, categories, links, marketplace placeholder), Features, Settings (live
  rows), Files (browse and preview), Changelog, Permissions, Log; Install permanently, Edit
  with agent.
- `moreCommands.ts` — `extensions.guide`, `listIcons`, `listFiles` / `readFile` (any loaded
  extension, read-only), `installPermanently`, `folderStatus` (the explorer's menu),
  `editWithAgent`, `copyForDevelopment` (an installed extension copied into the workspace folder
  to change, D189; `fork` gives it its own id) and `revertToBundled` (a customized bundled
  extension back to the IDE's version).
- `parts.ts` — avatar, badges, the actions menu shared by both.
- `authorsView.ts` — authors' pictures and list (D185); `newAuthors.ts` — who a new extension is by.

`template/` is what `extensions.create` writes (D105).

Commands: `extensions.show`, `extensions.list`, `extensions.create`, `extensions.showDetails`,
`extensions.remove` (unpacked: off the list), `extensions.revealFolder`, `extensions.installFromFolder`,
`extensions.installFromVsix {file?}` (`fromVsix.ts`, D200: Rust unpacks the .vsix into a scratch
folder, its `extension/` folder is installed like a folder, then the scratch folder goes; in the
view's ⋯ menu and right-click menu),
the extension store (`store.ts`, D254; Rust `extensions/store.rs`): `extensions.searchStore
{query, category?}` searches Open VSX (the view's search box does too, under "Open VSX", after a
pause; `@category:Themes` lists a category), `extensions.installFromStore {id, version?}` downloads
the .vsix (https from Open VSX's hosts only, checked against the SHA-256 it publishes) and installs
it through `extensions.installFromVsix`, `extensions.checkStoreUpdates` / `extensions.updateFromStore`
compare installed VS Code extensions with the latest there (the view's "Updates" section),
`extensions.browseThemes`; `extensions.store.enabled` (on) turns it off; parsing and version order
in `core/extensions/openVsx.ts` (tested). Results show their icons (fetched when a row is first
seen) and open a page of their own: `extensions.showStoreDetails {id}` (`storePage.ts`, dock tab
`extension-store`, like VS Code's extension editor: icon, publisher, downloads, rating, Install /
Update / Manage; Details with the README and a Marketplace side panel, Features read from its
package.json as an installed one's, Changelog). A pack's Details start with its members as
cards (`extensionPack.ts`, D298: open one's page, install it), on the store page and an
installed one's. Icons, README images and texts come through
`ext_store_file` (Rust: Open VSX's hosts only, 512 KB icons / 5 MB images / 2 MB texts, type
checked; `storeMedia.ts` caches them for the window's life); other https images in a README go
through the Markdown preview's remote images. The view's **Recommended** section (under
Installed, empty search only) lists what each folder's `.vscode/extensions.json` names and
well-known extensions for the workspace's kinds of files (`core/extensions/recommendations.ts`),
without installed ones; their Open VSX details are fetched only while the view is shown, with
`extensions.store.enabled` and `extensions.recommendations.enabled` (on) both on.
`extensions.ignoreRecommendation {id}` (the row's ×) adds it to
`extensions.recommendations.ignored`.

D284, as VS Code's: the search box takes VS Code's syntax (`core/extensions/extensionQuery.ts`:
`publisher:`, `@category:`, `@tag:`, `@id:`, `@sort:`, `@popular`, `@installed`, `@builtin`…;
`store.ts` `searchStoreQuery` asks Open VSX, a publisher by each of its namespaces) and has a
filter button. A pending update shows **Update** on the row, **Update to x.y.z** first on the page
and in the gear menu (`pendingUpdate`). Verified publishers carry a check (`storeVerified`, learned
from searches, pages and update checks; `parts.ts` `verifiedMark`). An installed extension's page
fetches its Open VSX facts once (downloads, stars opening `extensions.openStorePage {id,
reviews}`); the publisher, categories and tags search for themselves (`publisherLink`,
`filterChip`); Install has a ▾ (`installMore`: Install specific version…). While Live Server,
Live Preview or Five Server is installed and enabled, `actions.ts` sets the context key
`liveServerExtensionEnabled` (the browser's Go Live steps aside).

D285: `workerHost.ts` asks for the Node host script before each Node start (another IDE version
may have removed this one's copy; the backend keeps other versions' copies a week). In
`runtime.ts` a start waits for a stop still finishing, a start a stop overtook gives up and isn't
handed to a resume, and an old worker's exit leaves the current one alone.
`extensions.installFromRepo` / `extensions.updateFromRepo` / `extensions.browseOfficial` (`fromRepo.ts`, D185;
the list comes from `extensions.officialRepo`, empty until the IDE has one),
`extensions.loadUnpacked`, `extensions.loadFromWorkspace`, `extensions.uninstall`, `extensions.enable`, `extensions.disable`,
`extensions.reload`, `extensions.grantPermissions`, `extensions.showLog`, and the D176 ones
above; per panel or editor view `<view id>.show`. The editor's `editor.getText` /
`editor.replaceRange` (`editor/textCommands.ts`) serve extensions and agents alike.

State: `ide://extensions` (status, permissions asked/granted, what each adds, latest log lines;
`live`: what each running one has registered, with `decorationTypes` and `providerKinds`, D234; `notLoaded`: folders in the workspace folder's
`extensions` that aren't loaded and why); `ide://extensions/store` (the last Open VSX search,
the updates found, D254, what's being installed, and `recommendations`: each recommended id with
why, and its Open VSX details once the view has fetched them).

- View → Tools, the extension page's Open button and New tab list every extension's views and `menubar/view` commands (`ExtensionFeatures.allOpeners`, D182).
- Pictures (`media.ts`, D190): the icon (any image file or an icon name) and `screenshots` shown
  above the README; a development copy changes them with `extensions.setIcon`,
  `extensions.addScreenshot` (a picture of the IDE, or a file) and `extensions.removeScreenshot`,
  from its menu or the "Add screenshot" tile on its page.
- Authoring helpers (`authoring.ts`, `examples.ts`, D191): `extensions.validate`, `extensions.manifestSchema` (`core/extensions/manifestSchema.ts`; the editor uses it for extension.json), `extensions.try` and `extensions.examples`. `extensions.guide` takes a `section`. `ide://extensions` is brief past 8 extensions (`?id=`, `?brief=0`).

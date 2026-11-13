# core

Framework-free building blocks, unit-tested with `node --test`: DOM-free except `dom/`, and `ipc/`
is the only code that calls Tauri. One section per folder.

## acp/

`AcpClient`: the client side of the Agent Client Protocol (v1, newline-delimited JSON-RPC over
stdio): initialize, `session/new`, `session/prompt`, `session/cancel`, `session/update`
notifications (message/thought chunks, tool calls, plans). The host answers the agent's requests:
`session/request_permission`, `fs/read_text_file`, `fs/write_text_file`, `terminal/*`. D200:
`session/load` when the agent advertises `loadSession` (`canLoadSession`, `loadSession`), and
`parseAvailableCommands` for `available_commands_update`. DOM-free; `acp.test.ts` uses an
in-memory agent. Wiring into the panel: `src/extensions/agent/acp.ts`. D208: `display.ts` —
`prettyCommand` (a command title without its shell: PowerShell's full path and quoting →
`npm run check` + "PowerShell"), Guardian reviews (`isGuardianStep`, `parseReview`,
`reviewLine`), a turn's usage in the IDE's units (`promptUsage`, `client.lastUsage`;
`updateCost` for `usage_update`); `turnChanges.ts` — comparing a folder before and after a turn
(`compareSnaps`, `candidates`, path helpers; D233: `treeChanges` for a folder without git,
`baselineAfterSave`); `planLimits.ts` (D233) — plan limits parsed from an agent's `/status` text
(`parsePlanLimits`). All tested. D215: `registry.ts` — the ACP agent
registry's registry.json parsed strictly (`parseRegistry`: ids, versions, https links, npm / PyPI
package names, relative binary commands, no code-loading environment variables, SVG icons without
scripts / handlers / external references via `sanitizeSvg`; copyleft agents left out), how an
agent runs here (`chooseRun`, `packageLaunch`, `pathProgram`), its menu name
(`agentDisplayName`), search, version order, and the installed-agent records of the global state
(`sanitizeInstalledMap`). Tested (`registry.test.ts`, with the bundled snapshot). The IPC wrapper
is `ipc/acpAgents.ts`.

## agent/

DOM-free agent machinery, tested with fakes (`agent.test.ts`, `loop.test.ts`):

- `loop.ts` — `runTurn`: model ↔ tools until a plain answer, the step limit or cancel; falls back
  to the text protocol when the provider reports that the model has no tool support.
- `conversation.ts` — panel items → provider messages within a character budget (old tool outputs
  shortened first, then the oldest turns dropped).
- `textProtocol.ts` — `<tool_call>{json}</tool_call>` prompt and a forgiving parser.
- `edits.ts` — search/replace edits with a whitespace-tolerant fallback match.
- `displayCards.ts` — the cards the display tools describe (show_links, ask_user; D171).
- `workflow.ts` — workflow scripts (D338): the meta read as a literal, `parallel` / `pipeline`,
  `WorkflowRuntime` (the resume cache, agent and concurrency limits, schema answers checked), the
  end message, and the worker's messages (`src/workers/workflow.worker.ts` runs the script).
- `skillSuggest.ts` — suggest_skill (D342): keywords, ranking the skills to add, the card's data,
  the once-per-conversation rule (`oncePerConversation` in `extensionSuggest.ts`, D314's).
- `completionModels.ts` — suggestions as you type (D204): `fimStyle` (which FIM endpoint a
  provider has: Ollama, Mistral/Codestral, DeepSeek, any OpenAI-compatible one when forced),
  `suggestCompletionModel` (a small local FIM-trained code model among the installed ones).
- `repoMap.ts` — the repository map (D174): symbols per language, PageRank over references,
  rendering within a character budget.
- `compact.ts` — summaries near the context limit and the plan (D109); `memory.ts` — project and
  user memory notes (D110, D191); `title.ts` — chat titles from the first reply (D124).
- `verify.ts` — the verify step after a turn changed files (D127); `toolText.ts` — how tool
  results and errors read to a model (D191).
- `subagents.ts` — built-in and Markdown-file subagents, Claude Code's tool names mapped (D195).
- `isolatedHelpers.ts` — helpers in their own git worktree (D231): when to isolate, the cap and
  refusals, a helper's state from its worktree chat, its report and status lines, its first
  message, and the stop requests one window leaves for another.
- `groupChat.ts` — group chats and handoffs (D231): @mentions of members, who answers a message
  (`routeMessage`), which mentions in a reply hand over (`handoffMentions`: at a line's start or
  after →), the round's queue and its limit (`nextInChain`), what a member is told
  (`roomBrief`), the composer's `@query`, and the `handoffs:` front matter (`parseHandoffs`).
- `agentTemplates.ts` — the agent editor's model (D230): access levels (read / edit / full) to and
  from a file's header, the new-agent templates, the candidate faces.
- `applyCode.ts` (code block Apply, D122), `attachments.ts` (D131), `projectFolder.ts` (a new
  project's folder, D121), `webText.ts` (a web page as text, D130), `voice.ts` (voice input's
  choices, D180; `voiceRoute`, where a recording goes, D384), `webSearch.ts` (web search providers, the tool's text, `@web search`, D200; domains and
  extended mode, D320), `webQuestion.ts` (web_fetch with a question: parts, answers, D321),
  `toolSearch.ts` (deferred tools and tool_search: queries, ranking, what a chat loaded, D319).
- `workspaceFolders.ts` (D251): the agent's sandbox across a multi-root workspace's folders
  (`sandboxPath`), workspace-relative paths, each folder's ignore rules (`FolderIgnores`),
  auto-approve readings; `chatWorkspace.ts`: which workspace a chat belongs to (the folder, or
  the workspace file).
- `browserUpload.ts` (D339): browser_act upload's sources, MIME types, `accept` matching and the
  DataTransfer plan (`planTransfer`: set on a file input, or dropped); `browserRecording.ts`
  (D340): a recording's size, markers and captions from browser_act's arguments, its limits.
  `computerUse.ts` (D353): the computer tool's app tiers (`classifyApp`), what an action needs and
  `accessDecision`, the desktop screenshot's coordinate frame (`desktopFrame`, `toScreen`,
  `zoomCapture`), key chords as virtual-key codes, `looksLikeCardNumber`.

## cache/

`SizedCache`: a least-recently-used cache bounded by estimated bytes, not entry count, with a
per-entry cap (an entry over it isn't kept; D416). `stringBytes` estimates a string (UTF-16).
Used by chat search, @docs and the Markdown diagram / formula renders.

## context/

Context keys (`ContextKeyService`) and `when` clauses (`parseWhen`, `evaluateWhen`, `matchesWhen`).
Syntax: `!`, `&&`, `||`, parentheses, `==`/`!=`, `=~ /regex/flags`, `<`/`<=`/`>`/`>=`,
`key in container`, `key not in container`, `true`/`false`.

Keys the workbench sets (extensions add their own): `workspaceOpen`, `activeEditor`, `activeEditorDirty`, `activeEditorLanguage`,
`editorFocus`, `sideBarFocus`, `explorerFocus`, `panelFocus`, `auxiliaryBarFocus`, `focusedPart`, `terminalFocus`,
`inputFocus` (a text field outside editors and terminals), `quickInputVisible`, `sidebarVisible`, `panelVisible`, `auxiliaryBarVisible`, `isMac`, `isWindows`,
`isLinux`, `isDev`.

## dispatcher/

Every action is a command run through one pipeline (PLAN §6):
look up → `when` → validate input → caller checks (`permissions/commandGuards.ts`) →
`authorize(caller, effects)` → run → validate output (dev) → audit log → `command.executed`.

**Exports:** `Dispatcher` (`register`, `execute(id, input, caller)`, `list`, `info`,
`acceptsEmptyInput`), types `CommandSpec`, `Caller`, `Effect`, `CommandError` (codes `NotFound`,
`Disabled`, `InvalidInput`, `Denied`, `Failed`, `InvalidOutput`), `AuditEntry`.

Command ids are `namespace.verb`; descriptions are written for models as well as humans.
Nested `ctx.execute()` calls keep the caller. Audit entries go to Rust (`logs/audit.jsonl`).

## diagnostics/

Alpha support (D204), DOM-free and tested (`diagnostics.test.ts`): `redact.ts` (`redactText`:
keys, tokens, `key=value` secrets, URL passwords, home and user folders; `redactValue`: also
secrets by key name and file contents by key name or length), `logBuffer.ts` (`LogBuffer`:
batches, collapses repeats, caps a flood per minute, keeps the last errors; `describeError`),
`report.ts` (`reportBody`, `issueLink`: a new-issue URL cut to fit), `releaseNotes.ts`
(`parseReleaseNotes`, `shouldShowReleaseNotes`).

## diff/

Line diff (Myers) for quick-diff gutter bars and hunk staging; lines keep their terminators so a
change applies back byte for byte. Tested. `merge.ts` (D204): the merge editor's three-way model —
`computeMergeChanges` (each side's changes to the base grouped where they touch; conflicts where
both changed them differently) and `MergeModel` (the result as one segment per region: accept a
side / both / base per change, hand edits diffed back onto the segments, counts, navigation,
line mapping between panes). Tested. `words.ts` (D207): the words, spaces and punctuation a
changed line's text differs by (`wordChanges`, the same Myers diff over tokens), for the merge
editor's inner-line highlights. Tested.

## dock/

The dock as plain JSON (docs/dock.md §1): an n-ary split tree of tab groups. DOM-free and unit-tested.

- `types.ts` — `DockNode` (split | group), `TabRef`, `TabTarget` (insert / split a group / dock edge).
- `tree.ts` — immutable operations: add/remove/activate tabs, split, remove group, resize, set sizes,
  equalize, maximize, hide; `normalize` flattens same-direction splits and collapses single children.
- `moves.ts` — `moveTab` (what drag and drop does), unit-space geometry (`layoutRects`), directional
  neighbors, placement hints (`resolvePlacement`), bottom/right regions, (de)serialization with validation.
- `tabs.ts` (D279) — `tabsOverLimit` (which tabs workbench.editor.limit closes: least recently
  used, never pinned, unsaved or just opened) and `dropIndex` (where a dragged tab lands in rows or
  in a column). Pinned tabs (`TabRef.pinned`, `setTabPinned`) stay first in their group.

## navigation/

`NavigationHistory` (D279): Go back / Go forward's places (path, line, column). A move far away
(another file, or 10+ lines) adds an entry, a nearby one updates the current; a step's own arrival
isn't a move; 50 kept; a deleted file's places are dropped. DOM-free, tested.

## paths/ glob

`glob.ts`: VS Code-style globs (`**`, `*`, `?`, `{a,b}`, `[ab]`) and `isExcluded` for
`files.exclude`-style maps. Tested.

## history/

`OperationHistory` (D86): workspace undo/redo — operations with a label, kind, paths and
`undo()`/`redo()` closures, replayed one at a time (100 kept). A failed replay drops the entry and
rethrows. Explorer, search and agent push entries; `services.history` holds the instance. DOM-free,
tested. `timeline.ts` (D196): a file's local-history versions and git commits, merged and grouped
by day, for the Timeline.

## dom/

`h(tag, props, ...children)` builds elements (no event props — use `on()` so listeners are owned),
`on(target, type, handler) → Disposable`, `delegate(root, type, selector, handler)`,
`replaceChildren`, `classNames`. Tests can route `h()` to a fake document (`setDocumentForTests`).

## events/

`Emitter<T>` (one typed event stream; `event(listener) → Disposable`) and `EventBus<Events>`
(named events, e.g. `command.executed`, `files.didRename`). A throwing listener never blocks others.

## extensions/

Host for built-in extensions (tier 3). A built-in = `extension.json` manifest + `activate(ctx)`.
`ExtensionHost.activateAll()` validates manifests, activates in order, isolates failures, checks that
contributed commands were registered; `keybindings()` collects contributed keybindings.
Activation events: the built-ins all use `["*"]`. Third-party extensions (D102): `thirdParty.ts`
parses their manifests (ours, or a VS Code `package.json`: `vscodePackage.ts` turns one with code
into the IDE's commands, settings, keys, views and menus, D256; as VS Code reads them: keys for
commands it doesn't declare keep VS Code's id and `resolveVscodeKeybindings` maps them when it
loads — VS Code's own through `vscode/builtinCommands.ts`, others' declared ones, its code's
through its hidden command, "-command" removals; `configurationDefaults`; views in another
extension's container, `placeInContainer`; no reserved setting names, `machine-overridable` and
program paths `restricted`; `workspaceContains.ts` the index's quick-search terms for a glob) and maps commands to
the permissions they need; `rpc.ts` is the worker ↔ IDE protocol and builds the `ide` object the
worker gets (`src/workers/extension.worker.ts`, locked down by `src/workers/lockdown.ts`, which
workflow scripts' worker shares, D338); `rpcNotebooks.ts` is its `ide.notebooks` part
(serializers and kernel sources, D202) and `rpcOutput.ts` its `ide.ui.createOutputChannel` (lines
batched per turn); `rpcTerminals.ts`, `rpcScmDebug.ts` and `rpcAuthFs.ts` its terminals, task
providers, source controls, debug adapters, authentication, secrets and file systems (D233, through
"provider" calls), `rpcLanguages.ts` its `ide.languages` (problems and every language provider:
definition … semantic tokens, and D234's type definition, implementation, declaration,
highlights, folding, links, colors, on-type formatting, inline completions, workspace symbols;
`languages.execute`, every provider of a document asked at once, with `providerQuery.ts`'s
queries, answers and `checkProviderQuery`),
`rpcWebviewPanels.ts` its `ide.ui.createWebviewPanel` (a page set at run time, one request per turn),
`rpcQuickInput.ts` its live quick input sessions (`ide.ui.quickInput`: properties per turn, the
user's events back on `quickInput.<id>`), `tabModel.ts` the editor tabs extensions see (snapshots
and their differences, VS Code's tabGroups) and
`rpcTesting.ts` its `ide.tests` (test controllers: items as one snapshot per turn, run profiles
the host calls, runs' events batched), `rpcExtras.ts` D234's decoration types, active-editor events, file watchers and findFiles,
`workspaceState`, `settings.update` and `env`, `rpcWorkspace.ts` the workspace's folders (D251: the worker's mirror behind
`workspaceFolders` / `getWorkspaceFolder` / `asRelativePath` / `onDidChangeWorkspaceFolders`, `updateWorkspaceFolders`' checks,
the extension path gate, globs relative to each folder), and `manifestWorkbench.ts` the `taskDefinitions` / `debuggers` contributions; `treeMenus.ts` builds a tree row's `view/item/context` menu (`when` on `view` /
`viewItem`, VS Code's groups and order, inline buttons). `manifestSchema.ts` is extension.json's JSON
Schema (D191); `authors.ts` reads a manifest's authors (D185); `commandInput.ts` turns a
command's `input` JSON Schema into the dispatcher's schema and `settingsAccess.ts` decides which
settings an extension may read (`readsSettings`, D202). `openVsx.ts` reads Open VSX's search
and details JSON (D254: the store; its page's facts, which addresses the backend fetches, where a
store README's images and links go), `extensionQuery.ts` reads the Extensions view's search
syntax (D284: VS Code's `publisher:`, `@category:`, `@sort:`…) and `recommendations.ts` works out the Extensions view's
Recommended section (a folder's `.vscode/extensions.json`, and a map from kinds of files to
well-known Open VSX extensions). The host is `src/extensions/extensions/`.

`vscode/` is the `vscode` shim (D256): what a VS Code extension gets for `require("vscode")` in the
Node host, built on the worker API. Custom editors (`webviews.ts`, D419): a panel's `active` /
`visible` follow its tab, and a custom text editor keeps its document's earlier texts for the
`undo` / `redo` commands (`ShimCommands.customTextUndo`). `types.ts` and `languageTypes.ts` are VS Code's classes and
enums, `convert.ts` turns 0-based positions, Uris, edits and the rest into the IDE's shapes,
`document.ts` the text documents (open, changed, closed from the IDE's events), `commands.ts`
VS Code's command ids and arguments, `languages.ts` providers and diagnostic collections,
`editors.ts`, `window.ts` and `views.ts` the window, `workspace.ts` configuration (a section's name read as a key answers with an object of its
settings, D421) and files, and
`executeCommands.ts` VS Code's `vscode.execute…Provider` commands (`ide.languages.execute`'s
answers as VS Code's classes), `index.ts` puts the module and the ExtensionContext together and logs what isn't supported
(`ide://ext/<id>/vscode`). D257 added `webviews.ts` (webview views and custom editors on code
pages), `debug.ts`, `workbench.ts` (tasks, source control, sign-in), `testing.ts`, `comments.ts`,
`notebooks.ts`, `chat.ts` (chat and language models), `git.ts` (VS Code's Git extension API on the
IDE's git) and `workbenchTypes.ts` (their classes). DOM-free, tested against a fake host.
`types.ts` also has `eventOf` (an IDE subscription as VS Code's Event, with `thisArgs` and
`disposables`) and `snippetText` (a snippet's plain text); `extraTypes.ts` the rest of VS Code's
classes and the proposed names installed extensions use (docs/extensions.md lists the stubs).
`ipynbMetadata.ts`: Jupyter notebooks' metadata in VS Code's ipynb layout (dropCustomMetadata:
`cell.metadata.metadata`, `notebook.metadata.metadata`) both ways; `notebookEditors.ts` keeps one
TextDocument per cell for its life (in `workspace.textDocuments`, with its change events).

## ipc/

Typed wrappers over the Rust commands — the only place that calls Tauri (`invoke.ts` holds the one
`invoke`). Errors become `IpcError { code, message }`. One file per domain:

| File | Exports | Rust commands / plugins |
|---|---|---|
| `invoke.ts` | `call`, `Channel`, `IpcError`, `isTauri`, `onFailedCall` (D204: the session log hears every failed call) | — |
| `diagnostics.ts` | `sessionIpc`, `logIpc`, `reportIpc` | `session_info`, `app_relaunch`, `log_write` / `log_recent`, `report_save_zip` (D204) |
| `accounts.ts` | `accountsIpc` | `accounts_*` |
| `extensions.ts` | `extIpc` | `ext_*` (installed and unpacked extensions, files, storage, `ext_fetch`, an extension's own keychain secrets `ext_secret_get` / `ext_secret_set`, D233) |
| `fs.ts` | `fsIpc`, `encodingIpc` (D204), `historyIpc`, `watchIpc`, `docsWatchIpc`, `indexIpc`, `searchIpc`, `dragDropIpc` | `workspace_*`, `fs_*` (raw bytes; `fs_trash` / `fs_untrash`), `history_*`, `watch_*` (Channel), `index_*`, `search_run` / `search_replace` (Channel), `fs_import_dropped`, webview drag-drop events, `encoding_encode` / `encoding_guess` |
| `desktop.ts` | `desktopIpc` (D353) | `desktop_info`, `desktop_capture` (BGRA bytes), `desktop_window_at`, `desktop_input`, `desktop_banner`, `desktop_take_stop` |
| `browser.ts` | `browserIpc` | `browser_proxy`, `browser_window_*`, `browser_embed_*`, `browser_download*`, the `browser_subscribe` Channel (network, bridge, window closed, download) |
| `system.ts` | `appIpc`, `auditIpc`, `storeIpc`, `settingsIpc`, `windowIpc`, `dialogIpc`, `clipboardIpc`, `openerIpc`, `mcpIpc`, `mcpClientIpc`, `updateIpc`, `wslIpc` | `app_info`, `audit_append`, `state_load` / `state_save`, settings files, window controls, dialog / clipboard / opener plugins, `mcp_*` (the IDE's server and remote servers for the agent), `update_*`, `wsl_*` |
| `remote.ts` | `remoteIpc` (D252) | `remote_connect` (Channel of `RemoteEvent`: progress, ssh's `askpass` questions, `disconnected`), `remote_askpass_answer`, `remote_disconnect`, `remote_status`, `remote_browse`, `remote_log`, `remote_hosts`, `remote_forward_port` / `remote_unforward` / `remote_forwarded`, `remote_listening` |
| `instances.ts` | `instancesIpc` (D209) | `instances_*` (files other launches hand over — Channel, `--wait`'s done, the window with a folder, the last session's windows), `shell_command_*` |
| `process.ts` | `ptyIpc`, `execIpc`, `formatIpc`, `lspIpc`, `debugSocketIpc`, `startStdioProcess` | `pty_*` (Channel: raw bytes + exit), `exec_run` / `exec_cancel`, `lsp_start` (Channel: messages, stderr, exit; `framing: "lsp" \| "ndjson"`), `lsp_send`, `lsp_stop` |
| `virtualPty.ts` | `registerVirtualPty`, `spawnVirtualPty`, `isVirtualPty` (D233) | none: an extension's pseudoterminal, answered in the page; `ptyIpc` sends a spawn with `virtual: <key>` and every id from `VIRTUAL_PTY_BASE` here |
| `git.ts` | `gitIpc`, `githubIpc` | `git_*` (status, show, index writes, stage, commit, branches, log, remotes with progress) |
| `agent.ts` | `aiIpc`, `agentStoreIpc`, `attachIpc` | `ai_*` (models, chat Channel, cancel, keys), `agent_session_*`, `agent_checkpoint_*` |

## keybindings/

VS Code-style keybindings: `KeybindingResolver` (later rules win, `when` filtering, multi-chord
bindings like `ctrl+k ctrl+o`, `-command` removal rules; a key that is both a command and a chord
prefix runs the command and keeps the chord open for a key with a modifier, D172),
`chordFromEvent` (physical keys via
`KeyboardEvent.code`), `normalizeChord`, `parseKeybinding`, `keybindingLabel` ("Ctrl+Shift+P" / "⇧⌘P").
`edit.ts` (D204): per-binding edits of keybindings.json the way VS Code's shortcuts editor makes
them (`changeKey`, `changeWhen`, `removeBinding`, `addBinding`: a user entry changed in place, a
default replaced by a `-command` removal plus the new rule), applied with comments kept.

Rules come from extension manifests (`contributes.keybindings`, with optional `mac`), then the
user's `keybindings.json` (`extensions/keybindings`). `effective.ts` works out which rule wins for
the Keyboard shortcuts tab (conflicts); `keys.ts` normalizes chords. The DOM side lives in
`src/workbench/keyboard.ts`.

## layout/

`LayoutModel`: visibility and size signals for sidebar / panel / auxiliary bar, focused part,
`resize` (clamped), `snapshot()` / `restore()` (persisted per workspace). DOM-free.

## lifecycle/

Disposable lifecycle (VS Code pattern). Every listener, effect, timer, IPC subscription and child
component is registered to its owner's `DisposableStore` and released with it.

**Exports:** `Disposable`, `DisposableStore`, `MutableDisposable`, `toDisposable`, `disposeAll`,
`NONE`, `liveDisposableCount()` (dev builds), `LeakMonitor`.

**Dev leak tracking:** stores and `toDisposable` results are counted while alive (`__DEV__` only).
The dev extension samples the count every 10 s and warns when it grows steadily;
`dev.liveDisposables` shows it.

## mcp/

`McpClient`: a minimal Model Context Protocol client over a JSON-RPC connection — initialize, paged
`tools/list`, `tools/call`, `notifications/tools/list_changed`. D200: `prompts/list` / `get` and
`resources/list` / `read` (when the server has them), their list_changed (a burst re-lists once
more, not once each), and `elicitation/create` through the `onElicit` handler (the capability is
offered only with one). `elicitation.ts` turns a requested schema into fields and checks answers;
`prompts.ts` parses prompt arguments and turns prompts and resources into chat context. `agentToolName(server, tool)` makes
`mcp__<server>__<tool>` names. `config.ts` (D193, tested) merges the agent's servers from
every source (settings, the user's and the folder's mcp.json files, other tools' configs,
extensions) and fills in variables and inputs. The IDE's own MCP *server* is in
`src/extensions/mcp` (docs/mcp.md). DOM-free; `mcp.test.ts` uses an in-memory server.
D207: `sampling.ts` sends user images (PNG, JPEG) to models that read them and refuses other
content saying why, and `reviewedResult` applies the user's review; `registry.ts` reads the
official MCP registry's answers into gallery entries; `ideTools.ts` has Claude Code's
diagnostics ranges, executeCode's notebook choice, its answer with images (`executeCodeResult`,
D222; `core/notebook/nbformat.ts` `outputImages`) and `at_mentioned` (all tested). `icons.ts`
checks servers' icons (`serverInfo.icons`, server.json `icons`: data: pictures and https
addresses, SVG checked as the ACP registry's) and picks one for the theme and size; registry
named arguments with nothing to fill in, or `format: "boolean"`, are flags (passed by name, or
left out when "false").
D343: `suggest.ts` ranks gallery and registry servers for a need (`registryQueries`,
`rankServers`), builds suggest_mcp_server's card rows, plans Add (`planMcpAdd`: which typed values
are stored, which are asked at the start) and mcp_status's rows; `registrySample.ts` is a saved
registry answer its tests read.

## lsp/

The language-server client (D68): JSON-RPC (`jsonrpc.ts`), the initialize handshake, full-text
sync, diagnostics and the server requests a client must answer (`client.ts`), `file:` URIs
(`uri.ts`). DOM-free; tested with an in-memory server. Wired up by `src/extensions/lsp`.
D204: `semanticTokens.ts` applies `full/delta` edits to the kept tokens; `workspaceDiagnostics.ts`
keeps `workspace/diagnostic` reports and result ids; `client.requestWithPartialResults` routes
`$/progress` partial results; `client.onRefresh` (semantic tokens, diagnostics refresh requests).
`hierarchy.ts` (tested): call and type hierarchies — the request per direction, the server's items
as tree nodes (`rootNodes`, `childNodes`; call sites with each call), `HierarchySession` (lazy
levels, direction switch, `expand(depth, limit)`) and the rows as data (`treeData`). `colors.ts`
(tested): which of a server's languages get its color provider (not css/scss/less/json/jsonc,
which the editor's own services color) and its `documentColor` / `colorPresentation` answers.

## notebook/

Notebook data and who provides it (D202). `types.ts`: cells, outputs (nbformat 4 terms), kernel
events, kernel info and status. `providers.ts`: `NotebookProviders` (`services.notebooks`) —
notebook types (file extensions + `NotebookSerializer`) and `KernelSource`s that list
`KernelOption`s and create `NotebookKernel`s; sources for a type come before general ones.
DOM-free, tested. D295: a VS Code controller's kernel has `messaging`; `registerKernelPage` /
`postToKernelPages` carry its messages to its notebooks' output pages; `registerPreloadSource` /
`preloadsFor` give extensions' `notebookPreload` scripts (`preloads.ts` reads them from a
package.json); `rendererFor(…, { widgets: true })` lets an extension draw Jupyter widgets there.
Its `messaging` also gives the controller's `rendererScripts` and reads the files the page asks
for by VS Code's webview addresses (`readResource`). `registerCellLocator` / `cellIndex`: where
an open notebook's cell is (extensions' diagnostics for a cell document). `INTERACTIVE_NOTEBOOK`:
VS Code's Interactive Window type, built in. `contextKeys.ts`: VS Code's notebook context keys
(`notebookContextKeys`: notebookEditorFocused, notebookCellListFocused, notebookCellType,
notebookKernel…; `cellUriString` / `fileUriString` as the shim prints Uris). `cellUri.ts`:
`parseCellPath`, a `vscode-notebook-cell:` document's notebook and cell. Both tested.

D204 (tested in `cells.test.ts`): `concat.ts` — `ConcatDocument`, a notebook's code cells joined
into one document for a language server, with positions mapped both ways (`toConcat`,
`fromConcat`, `rangeFromConcat`), Jupyter magics masked in Python (`maskMagics`, same columns),
`cellDiagnostics` (per cell; magic lines and Pyright's unused-expression on a cell's last line
dropped), `concatPath`. `find.ts` — find across cells (`findInCells`, sources and outputs' text,
case / whole word / regex), `replaceAllIn`, `replacementFor` ($1 groups), `nearestMatch`.
`outline.ts` — `notebookOutline`: Markdown headings nested by level with the code cells under
them (`markdownHeadings`, `codeCellLabel`).

## paths/

Path helpers for OS paths from Rust (either separator): `basename`, `dirname`, `joinPath`,
`isWithin`, `relativePath`, `isAbsolute`, `resolveInRoot` (absolute, or relative to the workspace).

## permissions/

The `authorize` hook between input validation and execution.

- `createM2Policy` (in use; the name is historical): `user` → allow, `destructive` commands
  confirm (text from the command's `confirm(input)`); `test` → allow only during a
  `--run-test-script` run; `agent` / `acp` → reads allowed, anything else asks in the chat (once /
  this chat / deny; destructive every time); `ext` → the extension's granted permissions;
  `mcp` → read-only commands allowed, anything else asks the user; `agent: "hidden"` commands are
  denied to all but the user and tests.
- `ideControl.ts` (D176): commands that change the IDE itself (layout, views, settings,
  keybindings, extensions…) ask an agent's user even with full access.
- `createM1Policy`: the user part alone. `ALLOW_ALL` is for unit tests.
- `commandGuards.ts` (m7.12, tested): inputs only the user (or a test script) may give, checked by
  the dispatcher before `authorize` so the refusal names the reason: `editor.runAction` takes an
  allowlist of the engine's own actions (editing, cursor, folding, find; not `ext.*.run.N` /
  `lsp.*.run.N` / `ide.resolveConflict` / notebook cell edits, which run IDE commands or a
  server's as the user, not `_…` or `editor.action.openLink`; extensions also not the clipboard
  paste); `editor.openMultiDiff`'s `refresh` command (run on the user's click); extensions can't
  run `lsp.setServerSetting` / `lsp.setServerSettingsJson` (user settings that can name programs,
  which `settings.set` already keeps from them). `editor.runAction` itself refuses non-user
  callers on files outside the open folder, as `editor.insertText` does.

## reactive/

Tiny signal store: `signal`, `computed`, `effect`, `batch`, `untracked`.

- Reading `.value` inside `computed`/`effect` subscribes; `.peek()` doesn't.
- Writes mark computeds dirty (lazy) and queue effects; effects run once after the outermost `batch`.
- `effect(fn)` returns a `Disposable`; `fn` may return a cleanup function.

## schema/

The `s` builder: one definition → TS type (`Infer<typeof x>`), JSON Schema (`.json`, for agents/MCP)
and a validator (`.validate(v)`, used by the dispatcher).

`s.string/number/integer/boolean/enum/array/object/unknown/empty`, `.optional()`, `.describe()`.
Objects reject unknown keys so typos in agent calls fail loudly.

## search/

`searchEditor.ts` (D196, tested): search editor documents and VS Code's `.code-search` format,
both ways.

## settings/

DOM-free settings core (tested in `settings.test.ts`, `jsonc.test.ts`):

- `jsonc.ts` — JSONC parser (comments, trailing commas, BOM) with line/column errors:
  `parseJsonc(text)` / `parseJsoncOrThrow(text, label)`.
- `schema.ts` — `SettingSchema` (from manifests' `contributes.settings`), `SettingsRegistry`
  (categories and titles derived from keys, `jsonSchema(scope)` for settings.json), `isValid`.
  Extensions' default overrides (VS Code's `configurationDefaults`, `registerDefaults`): a later
  one wins, object settings merge, `[language]` blocks (`languageDefaults`) sit above the plain
  default and below every settings file; none for user-only or restricted settings
  (`acceptsDefaultOverride`), kept for keys registered later. `addOwner` / `owners`: the
  extensions sharing a setting declared twice.
- `model.ts` — `SettingsModel`: defaults < user < workspace, invalid values fall through to the next
  layer, syntax errors keep the previous values, `onDidChange(keys)`, `problems()`. Restricted
  settings (`restricted: true` in a manifest, D209: terminal profiles, the automation profile)
  come from a folder's layers only after `setTrusted(true)` (the workbench follows the folder's
  trust); extensions can't write them.
- `jsoncEdit.ts` — `setJsoncProperty(text, key, value | undefined)`: edits one top-level key and
  keeps comments and formatting; `setJsoncNestedProperty(text, outer, inner, value)` one key of a
  top-level object (a language block), making or removing the block as needed. Both throw
  `JsoncEditError` for text with no readable top-level object instead of replacing it;
  `assertEditableJsoncObject(text, label)` is the check every settings write makes first (D203).
- `languageOverrides.ts` (D201) — VS Code's language-specific settings: `"[python]": {…}` and
  `"[javascript][typescript]": {…}` keys, the languages they name (`typescriptreact` → `tsx`,
  `normalizeLanguageId`), `languageValues(layer, language)`, `changedOverrideKeys`, `validBlock`.
  `SettingsModel.getForLanguage` / `resolveForLanguage` / `inspectForLanguage`: workspace block >
  the other folder's block > user block > the plain value (VS Code's order); a change inside a
  block is reported as its own key (`editor.tabSize`). `jsonSchema` gives blocks the same keys.
- `vscode.ts` — a folder's `.vscode/settings.json` read as the IDE's keys (D95); `vscodeImport.ts`
  — Import from VS Code: keybindings, extensions and MCP configs mapped (D193); `profile.ts` —
  settings profiles in one file (D130).

The files, live reload and writes are `workbench/settings.ts` (`SettingsService`); the UI and
commands are the `settings` built-in extension.

## security/

Risky folders and protected agent config files (D213), DOM-free and tested.
`riskyFolders.ts`: `riskyFolderOf(path, folders, platform, extra)` — `downloads` (the Downloads
folder or one inside it, plus `security.riskyFolders`), `home`, `desktop`, `temp`, `root` (a drive
or file system root; those four only as themselves); `downloadsFolderOf`, `insideFolder`,
`cleanFolder` (`\\?\` prefixes, Windows case), `mentionsFolder` (a command line naming
`~/Downloads`, `%USERPROFILE%\Downloads`…), `riskyLabel` / `riskyReason` (plain-words caution).
`agentConfigFiles.ts`: `protectedConfig(path)` — other agents' configuration (`.codex/`,
`.claude/settings*.json`, `~/.claude.json`, MCP server lists), shell / login startup files, git
config and hooks, SSH — with the reason; `commandTouchesConfig(line)` (the same paths in a
command line, `codex mcp add`, `--dangerously-…` flags).

## state/

The state tree agents read (PLAN §7). `StateTree.register(path, { description, get })`,
`get(path, { budget })`, `getTree({ budget })`, `list()`. Values are fitted to a JSON-size budget by
`fitToBudget` (long arrays keep their first items, long strings are cut) and every cut is reported in
`notes`.

Each extension registers its own paths (listed in its README); `list()` gives them all, and an
unknown path's error names the close ones. A path takes a query (`ide://x?a=1`, D191).
`budget.ts` has `fitToBudget`.

## testing/

Command-script tests (`script.ts`, DOM-free, tested): JSONC `{ name?, steps: [...] }` where a step
runs a command (`run` + `input`), reads a state path (`state`), waits (`wait`) or retries until
`expect` matches (`timeoutMs`); `expect` is a partial match with `$gte/$lte/$contains/$exists/
$length/$not`; `expectError` expects a failure. `background: true` starts the command and goes on
(a picker the next steps answer, e.g. with `dev.type`); its failure is logged, and with `print` its
result. `save: "t"` keeps a step's result: later steps write `"${t.id}"` (the value itself) or
embed it ("ide://terminals/${t.id}/output") in `input`, `state` and `expect` (D217: ids a test
can't know in advance). `print` writes the value as JSON with strings over 2000 characters
shortened (`printable`, D396: an inline screenshot's base64 stalled CI's log). The app runs a script with
`--run-test-script <file>` (commands run as `caller: test`) and exits 0/1. Scripts live in
`tests/scripts/`.

## iconTheme/

VS Code file icon themes (D132): `IconTheme` resolves a file or folder to an icon definition
(file names, longest extension, language ids, folder names, root / expanded, light variants).
`productIcons.ts` (D267, tested): product icon themes' JSON, their glyphs, and `CODICON_FOR`,
the IDE's icons mapped to the codicons that do the same job.

## themes/

DOM-free color helpers and the VS Code theme importer (DESIGN.md §19).

- `color.ts` — parses computed CSS colors (hex, rgb/rgba, `color(srgb …)` as produced by
  `color-mix()`), `toHex` (Monaco needs `#rrggbb[aa]`), compositing.
- `importer.ts` — maps a VS Code theme's `colors` to semantic token overrides (+ terminal ANSI);
  `ThemeService.setOverrides` applies them at runtime. Surface colors the theme's text can't be
  read on (contrast under 4.5) and near-gray accents are left to the base theme; borders always
  are (D135).
- `webviewVars.ts` — VS Code's `--vscode-*` CSS variables for VS Code extensions' pages, each the
  IDE token that plays its part (`vscodeWebviewVars`), the body class for a theme kind, and the
  slot the IDE fills with the current theme when it serves a page (D260).

## workspace/
`workspaceFile.ts` (D251, tested): the `.code-workspace` file (folders relative to it, `file:`
URIs, settings, launch, tasks; edits keep comments), which folder holds a path, a path as the
workspace shows it (`api/src/x.ts`). `remoteLocation.ts` (D252, tested): `ssh://host/path`
locations, hosts that can't smuggle ssh options, "SSH: host" labels; `container:` ones (D266).
`devContainer.ts` (D266, tested): a folder's devcontainer.json (JSONC, `${…}` variables,
defaults) and the docker commands that bring its container up (find by label, build, run,
lifecycle commands), the devcontainers CLI's and docker's answers.

## image/
`gif.ts` (D340): animated GIF writing without a dependency, for the agent's browser recordings:
median-cut palettes per frame, LZW, frames cropped to what changed (`GifWriter`). Tested on a 2×2
image byte for byte and with an LZW decoder round trip.

## browser/
`cdp.ts` (D341): the DevTools protocol half of driving the user's own Chrome or Edge: picking the
page in `/json/list`, launch arguments, the bridge's install script and calls, binding messages,
and `CdpClient` (requests by id, events, timeouts). Tested.

## canvas/
Tests only: `canvas.test.ts` checks the model of the bundled Canvas extension
(`src-tauri/bundled-extensions/canvas/main.js`, D181): parsing JSON Canvas, `canvas.edit`'s ops,
placement and layout. It loads the worker script the way the extension host does.

## perf.ts, product.ts

`perf.ts`: startup and load marks (`ide://perf`, `workbench.startupTimings`); `whenMarked(name)`
resolves once a mark is reached (What's new waits for `workspaceRestored`, D204). `product.ts` is
generated from product.json by `scripts/gen.mjs`: the only source of the product's names.

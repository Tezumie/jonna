# workbench

The shell (DESIGN.md §10): `Workbench` (title bar, activity bar, the fixed left sidebar + sash, the
dock host, status bar, focus tracking), `TitleBar` (logo, menu bar collapsing into ☰ after the command field
has shrunk, workspace name, command field, sidebar/bottom/right toggles shown on hover, window
controls), `StatusBar` (items placed in the DOM by priority, fractional ones too, D393; an
item's `nodes(text)` draws colored text instead of `$(icon)` parsing,
D357; right-clicking it lists the items to hide one by one, the order and hidden list in
`statusItems.ts`, tested, D383), `ViewRegistry`/`ViewContainer`
(sidebar views only), `KeyboardService` (global keydown → resolver → dispatcher),
`browserDefaults.ts` (cancels webview accelerators such as Ctrl+P print / F5 reload and the native
context menu), `ThemeService` (`theme.ts`: data-theme / data-density / data-panels on `<html>`,
resolves tokens to colors for Monaco and the terminal), `WorkspaceService` (+ recent folders),
`PersistenceService`, `SettingsService` (`settings.ts`: registry + layered values, user and
workspace settings.json, live reload, writes that keep comments).

`dock/` is everything else on screen: see its README. `services.ts` defines `WorkbenchServices`,
what built-in extensions receive, plus the shared services that connect extensions: file
decorations, quick diff, language clients, viewers (`ViewerRegistry`) and open documents' live
text for previews (`DocumentTexts`). `permissionPrompts.ts` asks the user for MCP and agent
permissions; `auxWindow.ts` opens auxiliary windows and mirrors styles, theme, keys, menus and
tooltips into them (D101; each copied `<style>` is paired with its original, so later text
changes and removals follow it: extensions' decoration types reach detached editors); The activity bar's right-click menu hides icons (`ViewRegistry.hidden`, `view.setHidden`) and shows
a view's own `menu()` items; a hidden view with a home view (`sectionOf`) is then a collapsible,
resizable section at the bottom of it (`ViewRegistry.sections`, `view.toggleSection`, D129):
Outline and Timeline sit collapsed under the Explorer this way by default
(`workbench.activityBar.hidden` is `["outline.view", "timeline.view"]`, D199), ordered by the
descriptor's `sectionOrder` (Outline 10, Timeline 20). D210: `sectionOnly` keeps a view a section
whatever the hidden list says, with no activity bar icon (Source control's Graph);
`sectionDefault` is its state until the user changes it; the sash's drag runs
`view.resizeSection`. D233, movable views (VS Code's "Move view"): a descriptor with `movable`
can leave the sidebar for a dock tab and come back. `movableViews.ts` registers the
`sidebarView` dock view type (state `{ id }`: the view's own instance in the tab, waiting while
its extension isn't loaded), `view.moveView {id?, to?, placement?}` and `ide://views/moved`;
`movedViews.ts` (tested) is its DOM-free part. Where a view is follows the dock's tabs
(`ViewRegistry.inDock`), so it persists with the dock per workspace and closing the tab puts it
back. A moved view has no section or activity bar icon; `view.show` reveals its tab
(`ViewRegistry.dockHost`). Its section header or title drags onto the dock (`ViewContainer`'s
`dragView`), the tab back onto the sidebar; the header's menu has "Move to the dock", the tab
"Move back to the sidebar". Source control's Graph is the first such view. `activityOrder.ts` (tested)
keeps the icon order (`workbench.activityBar.order`), names of views that are off included.
Activity-bar badges (D134): `ViewRegistry.setBadge(id, count, tooltip)` puts a count on a view's
icon (the explorer's unsaved files, source control's changes; `badgeText`: up to four digits, then
"9999+", D210); work running in a view that isn't
shown (`progress()`) shows a spinning badge instead. `ProblemCollections` holds problems from
tasks' problem matchers (any file) beside the editors'; `taskTerminals` (filled in by the terminal
extension) runs a task's process in a terminal tab. `debugMarks.ts` (breakpoints and the stopped
line) and `gutterMarks.ts` (other extensions' margin marks, e.g. bookmarks) pass what to draw in
editors' margins and the lines edits moved them to (D143). `gitAccess.ts` (D208) is the slot
the git extension fills with read-only git (repositories, blame, line log, diffs between refs,
stashes, gh notifications) for third-party extensions' `ide.git` / `ide.github`. `SettingsService.registerChoices` gives a
string setting a runtime dropdown (themes); `getForLanguage` / `peekForLanguage` /
`updateForLanguage` read and write a language's own values (`"[python]": {…}`, D201). `trust.ts` is workspace trust (whether a folder's own tasks may run, D103; asked when a
folder opens, with "trust the parent folder", `askOnOpen`, D200), `trustModel.ts` (tested) which
decision applies (the folder's own, else a trusted parent's; a risky folder only its own, D213);
`riskyFolders.ts` (D213) knows where the user's Downloads, Desktop, temp and home folders are
(`trust.risky`, from Rust's app info) and shows the caution before one opens (`askRiskyOpen`;
`workspace.setOpenGuard` is the hook before every open); `contributions.ts`
holds what third-party extensions add declaratively (languages, grammars, snippets, color themes,
D102); `fileIcons.ts` draws file and folder icons from the active file icon theme (`icon("fi:file:…")`,
D132); `productIcons.ts` the active product icon theme's glyphs for the IDE's icons (D267);
`screenshot.ts` captures the IDE window, a region of it (a browser page) or a
browser window as PNG (D96); `testRun.ts` runs `--run-test-script`; `baseLayout.ts` is the
layout a window starts from when there's nothing to restore (D163), as `workbench.defaultLayout` says (default, agent, code; D424). Layout, appearance and window commands live in the `workbench`
built-in extension.

## Extension features and the workspace folder (D176, D177)
- `extensionFeatures.ts` — DOM-free registry of what third-party extensions add: hover and
  completion providers, decorations, menu items, agents, MCP servers, model providers
  (`services.extensionFeatures`); `applyRangeEdit`, `resourceContext` (menu `when` keys).
  Providers take an AbortSignal (the editor's cancellation); `formatterId` / `ownerName` name a
  formatter's owner for editor.defaultFormatter. A hover may answer `{ contents, range }`
  (`toHoverAnswer`): the range is what the editor highlights. Also `logChannels` / `logLevels`
  (extensions' log channels and the levels picked) and `restorablePanels`.
- `webviewPanelRestore.ts` — extensions' webview panels saved with the folder and waiting for
  their extension after a restart (VS Code's serializers; tested).
- `viewTitles.ts` — titles and descriptions views' code sets (VS Code's TreeView.title /
  description), read by the sidebar header, sections and dock tabs (`views.titles`; tested).
- `extensionDiagnostics.ts` — an extension's problems checked (tested): Hint kept, tags
  (unnecessary, deprecated), their own source, a code's web page, related places.
- `extensionRegistries.ts` — DOM-free registries on `ExtensionFeatures` for what extensions plug
  into the workbench (D233): their terminals, task providers (read by the tasks extension's list),
  source controls (git's badge, the view's sections, quick diff's fallback), debug adapters (the
  debug extension's `adapterOf`), authentication providers and file systems by URI scheme
  (`fileSystems`, read by the editor's file service), webview panels opened at run time (for
  state). Tested.
- `extensionTests.ts` — `ExtensionFeatures.tests`, extensions' test controllers (VS Code's test
  API): items, run profiles, results and output per controller, and the checks of what a worker
  sends (items, profiles, run events), the tree helpers the Testing view uses. Tested.
- `extensionHooks.ts` — `ExtensionFeatures.hooks`, DOM-free and tested: the extension that owns
  typing (the `type` override) and its cursor style, will-save participants (`runWillSave`, 1.5 s
  each), URI handlers (`parseIdeUri`, `openUri` waits for an `onUri` extension to register),
  comment threads (`threadSummary`, `threadMarkdown`, `lensesFor`) and commenting controllers,
  chat participants; `promptOf` (an `lm` request's messages as one prompt).
- `textEdits.ts` — `applyTextEdits` (several edits against one text, overlaps refused) and
  `planWorkspaceEdit` (an extension's WorkspaceEdit checked into ordered steps). Tested.
- `workspace.ts` — `WorkspaceService` (D251): the open workspace, one folder or a multi-root
  workspace (`folders`, `file`, `fileData`, `missing`, `location`, `remote`). `root` is the first
  folder. `onDidOpen` / `onDidClose` for the whole workspace, `onDidChangeFolders` for folders
  added or removed live; `contains` / `resolve` / `relative` replace `isWithin(root, …)` /
  `resolveInRoot(root, …)` / `relativePath(root, …)` (the folder's name first when there are
  several). `addFolders` (a single folder becomes an untitled workspace in place), `removeFolder`
  (the first folder: the workspace reopens), `renameFolder`, `saveAs`, `writeSetting`,
  `reloadFile`. Remote locations (`ssh://host/path`, D252) open in a window of their own.
- `workspaceFolder.ts` — the open folder's workspace folders (D189): writes always go to the IDE's
  own (product.json `workspaceFolderName`, `workspaceFolderName()` / `workspaceFolderPath()`); aliases the project already
  has (`.vscode`, then the legacy folder name) are read too, never created (`workspaceFolders()`,
  `workspaceFolderPaths()`, `findWorkspaceFile()`), the IDE's own winning. Known per workspace
  folder (D251): the functions taking a `root` use that folder's (`resolveWorkspaceFolderOf`).
- `workspaceMerge.ts` — combining a lower workspace folder's settings, tasks, launch
  configurations and memory notes into the IDE's own ("Merge into …" in the explorer, `workspace.mergeFolder`).
- `scrollMemory.ts` — every view's scroll offsets (D190): put back after a tab moves to another
  group or window, and after a view is closed and opened again or the app restarts (by view type
  and state, capped, saved in the workspace state as `scrollPositions`). Dock tabs and side bar
  views are tracked by the dock and the side bar; Monaco, terminals and iframes are skipped.
- `eventFeed.ts` — `ide://events?since=n` (D191): numbered changes (files, documents, tabs, the user's commands) for agents to poll.

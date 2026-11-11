---
name: build-extension
description: Build or change an extension of the IDE itself — a command, sidebar view, panel or page, status bar item, editor feature (hover, completion, decorations, diagnostics), theme, language support, file viewer, or anything the user calls a mod or plugin. The workflow, how VS Code's extension API maps to this IDE's, and the checks to run before saying it works.
---

# Building an extension of the IDE

The IDE is extended by extensions: a folder with `extension.json` (the manifest) and, for code,
a `main.js` that runs in a sandboxed worker with one global, `ide` (the API). Most of what a VS
Code extension does, an extension here can do; the names differ (the table below).

That sandboxed format is the default. Two others exist, for a reason only (the guide's
`choosing-a-format` section): the same format with `"host": "node"` when the code needs npm
packages, a server or files the sandbox doesn't allow, and a VS Code extension (`package.json`,
`require("vscode")`) when it must also run in VS Code or you are changing one that exists. A VS
Code extension's folder goes under `<workspace folder>/extensions/<name>` and loads with
`call_command extensions.loadFromWorkspace`; `ide://ext/<id>/vscode` lists the VS Code calls the
IDE doesn't support.

## Workflow

1. **Create it with `call_command extensions.create`** (`name`, `displayName`, `description`). Never write the folder
   or manifest by hand: the IDE wouldn't load it. It goes in `<workspace folder>/extensions/<name>`
   and loads at once as a development extension.
2. **Read what you need** with `call_command extensions.guide` (no input: its sections; then
   `{ "section": "..." }`). Start with `extension.json` and `code`; `api` is the full TypeScript
   types of `ide`. `call_command extensions.examples` lists small working extensions; copy the
   closest one (`{ "name": "..." }` returns its files).
3. **Edit the files** it made (`extension.json`, `main.js`, its README). Keep to the API in the
   guide: there's no `require`, no Node, no DOM in `main.js`.
4. **Check the manifest:** `call_command extensions.validate { "folder": "extensions/<name>" }`.
   Fix every error it lists.
5. **Permissions:** if you added any to `permissions` (`fs.read`, `fs.write`, `shell`,
   `network:<host>`, `git`, `terminal`…), `call_command extensions.grantPermissions { "id": … }` so
   the user can allow them. Without them the calls fail.
6. **Reload and look:** `call_command extensions.reload { "id": … }`, then read
   `ide://extensions?id=<id>`: `status` must be `active`, and its `log` must not show errors. A
   folder that didn't load is under `notLoaded` with the reason; fix it, then
   `call_command extensions.loadFromWorkspace`.
7. **Try every command it adds:** `call_command extensions.try { "id": "<extension id>",
   "command": "<command id>", "input": … }` returns the result and the log lines it wrote. A view, panel or status bar item: open or show it
   and read `ide://extensions?id=<id>` (`live` lists what it registered) or take a screenshot.
8. **Only then say it works**, and tell the user how to use it (the command's title in the
   command palette, the view's place, the key).

Repeat 3–7 until the checks pass. When a check fails, read the log and the guide's section for
that part before changing code again.

## VS Code's API here

Write it the way you would for VS Code, with these names. One difference to watch: lines and
columns here start at 1 (`{ startLine, startColumn, endLine, endColumn }`), where VS Code's start
at 0. Every `register…` / `on…` returns a disposable (`{ dispose() }`), and what an
extension registered is disposed when it stops, so there's no `context.subscriptions` to fill.

| VS Code | Here |
|---|---|
| `activate(context)` / `deactivate()` | `exports.activate = (ide) => { … }` / `exports.deactivate = () => { … }` in `main.js` |
| `contributes` in `package.json` | `contributes` in `extension.json` (commands, keybindings, views, settings, menus, themes, languages…) |
| `activationEvents` | `activation` (`*`, `onStartup`, `onStartupFinished`, `onLanguage:id`, `workspaceContains:glob`, `onFileSystem:scheme`; `onCommand` and `onView` are implicit) |
| `commands.registerCommand(id, fn)` | `ide.commands.register(id, (input, context) => …)`; its title, description and `input` schema go in `contributes.commands` (the agent can call it too) |
| `commands.executeCommand(id, …args)` | `ide.commands.execute(id, input)` |
| `window.showInformationMessage` / `showWarningMessage` / `showErrorMessage` | `ide.ui.notify(message, { kind: "info" \| "warning" \| "error", actions? })` (resolves with the clicked action) |
| `window.showQuickPick` / `showInputBox` | `ide.ui.showQuickPick(items, options)` / `ide.ui.showInput(options)` |
| `window.createStatusBarItem` | `ide.ui.createStatusBarItem(options)` |
| `window.createOutputChannel` | `ide.ui.createOutputChannel(name)` |
| `window.withProgress` | `ide.ui.withProgress(options, task)` |
| `window.registerTreeDataProvider` / `createTreeView` | a `views` contribution plus `ide.ui.registerTreeView(id, provider)` |
| `window.createWebviewPanel` | `ide.ui.createWebviewPanel(options)` (or a `views` contribution of type webview) |
| `window.activeTextEditor`, `onDidChangeActiveTextEditor` | `ide.editor.active()`, `ide.editor.onDidChangeActive` |
| `editor.edit` / `TextEditorEdit.insert` | `ide.editor.insert(text)` / `ide.editor.replace(range, text)` |
| `window.createTextEditorDecorationType` | `ide.editor.createDecorationType(options)` |
| `window.showTextDocument(uri)` | `ide.editor.open(path, { line?, column?, preview? })` |
| `languages.registerHoverProvider` and the other `register…Provider`s | `ide.languages.register…Provider(selector, provider)` (same names) |
| `languages.createDiagnosticCollection` | `ide.languages.setDiagnostics(path, diagnostics)` / `clearDiagnostics` |
| `workspace.getConfiguration(section).get(key)` | `ide.settings.get(key)`; `onChange`, `update` |
| `workspace.fs` / `findFiles` / `createFileSystemWatcher` | `ide.workspace.fs`, `ide.workspace.findFiles`, `ide.workspace.createFileSystemWatcher` |
| `workspace.workspaceFolders` | `ide.workspace.folders()` |
| `workspace.applyEdit(WorkspaceEdit)` | `ide.workspace.applyEdit(ide.workspace.createWorkspaceEdit()…)` |
| `context.globalState` / `workspaceState` | `ide.storage` / `ide.workspaceState` |
| `context.secrets` | `ide.secrets` |
| `env.openExternal`, `env.clipboard` | `ide.env.openExternal`, `ide.env.clipboard` |
| `window.createTerminal` | `ide.terminals.create(options)` |
| `tasks.registerTaskProvider` | `ide.tasks.registerTaskProvider(type, provider)` |
| `scm.createSourceControl` | `ide.scm.createSourceControl(…)` |
| `tests.createTestController` | `ide.tests.createTestController(…)` |
| `debug.registerDebugAdapterDescriptorFactory` | `ide.debug.registerDebugAdapterDescriptorFactory(…)` |
| `authentication.getSession` | `ide.authentication.getSession(…)` |
| `child_process.spawn` (a language server, a CLI) | `ide.process.spawn({ command, args?, cwd?, env?, framing? })` (the `shell` permission; `node` with a script in the extension's folder runs Node code) |
| `fetch` / `https` | `ide.net.fetch(url, init)` (the `network:<host>` permission) |
| a language server through `vscode-languageclient` | a `languageServers` contribution in `extension.json` (no code) |
| `setContext` | `ide.context.set(key, value)` |

Not here: Node modules (`fs`, `path`, `child_process`), `require` of npm packages, and the DOM in
`main.js`. Use the API above; for anything else, read `extensions.guide { "section": "api" }`.

## Things that go wrong

- A folder written by hand, or a manifest copied from VS Code's `package.json`: start from
  `extensions.create` and its manifest.
- A command that does nothing: its `id` in `contributes.commands` and in
  `ide.commands.register` differ, or `activation` never fires (add `onCommand:<id>`).
- Text meant for the editor shown in a notification: put it in with `ide.editor.insert`.
- A call that fails with "permission": add it to `permissions` and ask with
  `extensions.grantPermissions`.
- Changing an installed extension: `call_command extensions.copyForDevelopment`, change the
  copy, then `extensions.installPermanently` puts it back. To make a development extension
  available in every folder: `extensions.installPermanently`.
- Installed extensions' files are outside the folder but readable (`extensions.listFiles`,
  `extensions.readFile`): read a similar one to learn from it.

# __TITLE__

__DESCRIPTION__

An extension for the IDE, loaded unpacked from this folder: save any file here and it reloads.
Its log (console output, errors, denied requests) is in the Extensions view.

## Files
- `extension.json` — what it adds: `commands`, `keybindings`, `settings`, `views` (`"location"`:
  `sidebar`, `panel` or `editor`; `"type": "tree"` or `"webview"` with an HTML `path`), `viewers`
  (pages that open files: `{ id, title, extensions: [".csv"], path, default }`), `menus`
  (`{ location, command, when, icon }` in `explorer/context`, `editor/context`, `editor/title`,
  `view/title`), `themes`, `languages`, `grammars`, `snippets`, `mcpServers` and `agents`
  (`{ name, command, args }`; need `shell` + `agent`), `modelProviders` (`{ id, name, baseUrl }`,
  https; needs `agent`), and the `permissions` it needs. `icon` is an image file or an icon
  name from the list below; `author`, `repository`, `homepage`, `license`, `categories` and
  `keywords` show on its page. `activation`: `*` (at startup), `onStartupFinished`, `onLanguage:<id>`,
  `workspaceContains:<glob>`; without one that matches, it starts when one of its commands,
  views or viewers is first used.
- `main.js` — its code. `exports.activate = (ide) => { … }`; types in `ide.d.ts`.

## Rules
- Commands, views and settings start with `__PREFIX__.`; command ids are camelCase segments.
- Every command lists its `effects` (`read`, `write`, `exec`, `network`, `destructive`; `[]` for
  one that changes nothing). Running IDE commands with `read` effects needs `fs.read`.
- Permissions: `fs.read`, `fs.write`, `shell`, `terminal`, `network` or `network:<domain>`, `git`,
  `browser`, `agent`, `clipboard`. The user is asked again when you add one (a dialog opens; an
  agent can open it with the `extensions.grantPermissions` command).
- The code has no network, storage or DOM of its own: everything goes through `ide`
  (types in `ide.d.ts`).

## API at a glance
- `ide.commands.register(id, handler)` for each command in extension.json; `ide.commands.execute(id, input)` runs any IDE command.
- `ide.editor.active()` → `{ path, language, cursor, selectedText }` or null (needs `fs.read`);
  `ide.editor.insert(text)` types at the cursor, replacing the selection (needs `fs.write`).
  To change text in the editor use these — `ide.ui.notify` only shows a message.
- `ide.workspace.fs.read/write/list/stat(path)` (relative to the open folder; `fs.read` / `fs.write`).
  In a multi-root workspace: absolute in any folder, or relative with the folder's name first;
  `ide.workspace.workspaceFolders` lists the folders, `getWorkspaceFolder(path)` and
  `asRelativePath(path)` place a file, `onDidChangeWorkspaceFolders` tells when they change.
- `ide.workspace.findText(query, { isRegex, matchCase, include, exclude, maxResults })` →
  `{ matches: [{ path, rel, line, text }], truncated }` (respects .gitignore; `fs.read`).
- `ide.ui.notify(message, { actions })`, `ide.ui.showQuickPick(items)`, `ide.ui.showInput({ prompt })`,
  `ide.ui.registerTreeView(viewId, { getChildren })`, `ide.ui.webview(viewId)`.
- `ide.editor.open(path)`, `ide.editor.text(path?)`, `ide.editor.replace(range, text, path?)`,
  `ide.editor.select(range)`, `ide.editor.decorate(key, { style, ranges, after })` (styles:
  highlight, underline, error, warning, info, faded, strong); ranges are 1-based.
- `ide.languages.setDiagnostics(path, [{ line, message, severity }])`,
  `ide.languages.registerHoverProvider(langs, ctx => markdown)`,
  `ide.languages.registerCompletionProvider(langs, ctx => [{ label, insertText, kind }])`.
- `ide.ui.createStatusBarItem({ id, text: "$(icon) text", command })` → `{ update, dispose }`;
  `ide.ui.webview(viewId).openInWindow()` moves a panel or editor page into its own window.
- `ide.settings.get(key)`, `ide.storage.get/set(key, value)`, `ide.net.fetch(url)` (`network`),
  `ide.state.get("ide://…")`, `ide.events.on("files.didSave", …)`.

## Icons
The extension, views, tree rows, menu items and `$(name)` in status bar text take an icon of the
IDE's set (the `extensions.listIcons` command lists all of them; anything else shows a dot). Some: box, blocks, star,
zap, tag, bookmark, clock, calendar, bell, globe, search, settings, file, file-text, file-code,
folder, code, braces, hash, variable, list-tree, pencil, check, circle-check, circle-dot,
circle-alert, info, triangle-alert, bot, camera, history, git-branch, square-terminal, keyboard,
shield, eye, book-open, image, sun, moon, radio-tower, layout-dashboard.

## Pages
- A file viewer's page gets `{ ns: "ide-webview", file: { path, name, text, canSave } }` after
  it loads (and again when the file changes; `error` instead of `text` if it can't be read), and
  saves with `parent.postMessage({ ns: "ide-webview", save: text }, "*")` (needs `fs.write`).
- A webview page talks to the code with `parent.postMessage({ ns: "ide-webview", message }, "*")`
  and listens for `{ ns: "ide-webview", message }` (and `theme`) messages.

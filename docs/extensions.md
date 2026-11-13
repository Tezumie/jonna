# Writing extensions

An extension is a folder with an `extension.json`. It can add commands, keybindings, settings,
sidebar tree views, webview pages (in the panel, the editor area or a window of their own), file
viewers, context-menu items, status bar items, editor hovers, completions, decorations and
problems, color themes, languages with TextMate grammars and snippets — and for the agent, MCP
servers, whole agents (Agent Client Protocol, like Claude Code) and model providers (D176).
Code (optional) runs in a sandboxed worker (or in Node.js, with the `node` permission) and reaches
the IDE only through the `ide` object; the user grants the permissions it asks for when it's
added. Extensions written for VS Code run too (see "VS Code extensions (D256, D257)"). Design
notes: `docs/decisions.md` D102.

A complete example is `tests/fixtures/extensions/hello` (the UI test `tests/scripts/extensions.jsonc`
runs it). Types for the `ide` object: `src/api/index.d.ts`.

## Trying it

- **Create extension…** (Extensions view, or ask the agent: "make an extension that…") writes a
  working template into the open folder (`<workspace folder>/extensions/<name>`, the IDE's own
  workspace folder; extensions in the project's own `.vscode/extensions` are found too) and loads
  it; edit and save.
- **Extensions view** (activity bar, `Ctrl+Shift+X`): **Load unpacked…** runs a folder in place and
  reloads it whenever its files change: edit, save, and it restarts. **Install from folder…** copies
  it into the installed extensions.
- Each row shows status and badges; click it for details (permissions, what it adds, warnings).
  The buttons enable/disable, reload, show the log (`console.log` output, errors, denied requests)
  and remove it.
- An extension's page (click its row) has its README beside a side panel (version, source,
  location, categories, links, the marketplace's place), and tabs for Features, Settings (live
  controls), Files (browse and preview, open in the editor), Changelog, Permissions and Log.
  **Install permanently** copies a development extension into the installed ones; **Edit with
  agent…** starts a message about it.
- In the explorer, right-click an extension's folder: **Run as development extension**,
  **Install extension permanently**, **Extension details**.
- Agents and scripts: `extensions.list` / `ide://extensions` (brief past 8 extensions; `?id=` or
  `?brief=0` for the full form), `extensions.guide` (this file and the API types: `{}` gives the
  contents, `{ section }` one part, `"api"` the types), `extensions.listFiles` /
  `extensions.readFile` (any loaded extension's files, installed ones too, read-only),
  `extensions.installPermanently`.
- Checking your work (D191): `extensions.validate` (the manifest's errors, unknown fields and
  missing files), `extensions.manifestSchema` (the editor validates and completes extension.json
  with it), `extensions.try { id, command, input }` (runs a command and returns its result and
  the log lines it wrote) and `extensions.examples` (six small complete extensions to copy).

## Choosing a format

There are three ways to write an extension. Start with the first and move down only for a reason
(D419).

| | The IDE's own format | The same, in Node | A VS Code extension |
|---|---|---|---|
| Files | `extension.json`, `main.js` | `extension.json` with `"host": "node"`, `main.js` | `package.json`, `require("vscode")` |
| Code runs | In a sandboxed worker: no files, network or programs except through `ide` | In a Node.js process: `require`, npm packages, `fs`, `child_process`, sockets | In the shared Node.js process, behind the IDE's `vscode` module |
| What it may do | Only what its `permissions` list and the user grants | What any program may (the `node` permission; a trusted folder) | The same as Node |
| For agents | Commands with descriptions and input schemas, `ide://ext/<id>/…` state | The same | Its commands by title; no input schemas |
| Also runs in VS Code | No | No | Yes |

- **The IDE's own format** is the default: for commands, views, pages, file viewers, editor
  features, themes, languages. The user sees exactly what it may do, and the agent can drive it.
- **In Node** when the sandbox is the obstacle: an npm package or a native module, a server on a
  port, files outside the open folder, a tool to start. Everything else is the same `ide` API
  ("Node, and the rest of VS Code's API").
- **A VS Code extension** when it must also run in VS Code, or when you are changing one that
  exists. Most of VS Code's API works ("VS Code extensions (D256, D257)" and "Coverage versus VS
  Code"); what doesn't is logged once in its log and listed at `ide://ext/<id>/vscode`.

Looking like VS Code isn't a reason to write a VS Code extension: the IDE's own format is
smaller, sandboxed and visible to agents.

## extension.json

```jsonc
{
  "id": "acme.todo",              // publisher.name, lowercase
  "version": "1.0.0",
  "displayName": "TODO finder",
  "description": "Lists TODO comments.",
  "main": "main.js",              // optional: declarative-only extensions have no code
  "activation": ["*"],            // "*", "onStartupFinished", "onLanguage:<id>", "workspaceContains:<glob>", "onFileSystem:<scheme>", "onUri", "onNotebook:<type>", "onDebug" (VS Code's name "activationEvents" works too)
  "icon": "list-tree",            // an image in the folder (icon.svg, PNG…), or an icon name of the IDE's set
  "screenshots": ["screenshots/1.png", { "path": "screenshots/2.png", "caption": "The board" }],
  "authors": [                    // like a repository's contributors (D185); or npm's "author"
    { "name": "Ada", "github": "ada" },             // picture and link from GitHub
    { "name": "Claude", "avatar": "brand:anthropic" } // one of the IDE's brand marks
  ],
  "repository": "https://github.com/acme/todo", "license": "MIT",
  "categories": ["Other"], "keywords": ["todo"],
  "permissions": ["fs.read", "shell", "agent"],   // see below (shell + agent: for mcpServers / agents)
  "readsSettings": ["debug.pythonPath", "markdown.*"],  // other settings its code reads (D202)
  "contributes": {
    "commands": [
      { "id": "todo.scan", "title": "Scan for TODOs", "effects": ["read"] },
      // `input`: a small JSON Schema; agents see it and the input is checked before the handler runs
      { "id": "todo.find", "title": "Find a tag", "input": {
          "type": "object",
          "properties": { "tag": { "type": "string", "description": "The tag", "enum": ["TODO", "FIXME"] } },
          "required": ["tag"] } }
    ],
    // State paths its code fills (ide.state.register): under ide://ext/<id>/, with a description.
    "state": [{ "path": "ide://ext/acme.todo/summary", "description": "Counts per tag." }],
    "keybindings": [{ "key": "ctrl+alt+t", "command": "todo.scan" }],
    "settings": {
      "todo.tags": { "type": "array", "default": ["TODO", "FIXME"], "description": "Tags to find." }
    },
    "views": [
      { "id": "todo.list", "title": "TODOs", "location": "sidebar", "type": "tree", "icon": "list-tree" },
      { "id": "todo.board", "title": "TODO board", "location": "panel", "type": "webview", "path": "board.html" },
      // "editor": a page in the editor area, like a file (it can move into its own window)
      { "id": "todo.dashboard", "title": "TODO dashboard", "location": "editor", "type": "webview", "path": "dash.html" }
    ],
    // Pages that open files (custom editors): default opens .todo files in it directly, otherwise
    // it's "Open preview" / "Reopen with…".
    "viewers": [{ "id": "todo.viewer", "title": "TODO board", "extensions": [".todo"], "path": "viewer.html", "default": true }],
    // Its own commands in menus: explorer/context, editor/context, editor/title, view/title,
    // view/item/context (a tree row's menu, see Tree views), menubar/view (View → Tools: for a
    // tool that opens with a command rather than a view), and notebook/toolbar,
    // notebook/cell/title, notebook/kernelSource (see Notebooks).
    "menus": [
      { "location": "explorer/context", "command": "todo.scan", "when": "explorerResourceIsFolder" },
      { "location": "editor/title", "command": "todo.scan", "icon": "list-tree", "when": "resourceExtname == .ts" },
      { "location": "view/title", "command": "todo.scan", "icon": "refresh-cw", "when": "view == todo.list" }
    ],
    // For the agent (need "shell" and "agent"): MCP servers whose tools it gets, and whole agents
    // in its model menu (ACP over stdio). The user's own settings of the same name win.
    "mcpServers": [{ "name": "todo-db", "command": "node", "args": ["server.js"] }],
    "agents": [{ "name": "Todo agent", "command": "npx", "args": ["-y", "todo-acp"], "description": "…" }],
    // A provider tile on the AI models page (needs "agent"; https, or http on localhost); the
    // user still adds it with their key.
    "modelProviders": [{ "id": "acme", "name": "Acme AI", "baseUrl": "https://api.acme.ai/v1", "needsKey": true }],
    "themes": [{ "label": "Todo Dark", "uiTheme": "vs-dark", "path": "themes/dark.json" }],
    "languages": [{ "id": "todofile", "extensions": [".todo"] }],
    "grammars": [{ "language": "todofile", "scopeName": "source.todo", "path": "syntaxes/todo.tmLanguage.json" }],
    "snippets": [{ "language": "todofile", "path": "snippets.json" }]
  }
}
```

**Finding a tool:** every view an extension adds (sidebar, panel or editor page) is listed under
**View → Tools**, in **New tab** (the group's ⋯ menu, and `layout.newTab`'s picker), and behind
the **Open** button on the extension's page, with no extra work. A tool that opens with a command
instead (a file viewer's "open my board", say) adds that command to `menubar/view` to be listed
the same way. A sidebar view also gets its own icon in the activity bar. D260: a view can be
`"location": "secondary"` (VS Code's secondary side bar: a tab on the right, beside the agent),
show only while a `"when"` clause holds (it comes and goes as context keys change), and use an
image of its own as its activity bar icon (`"iconPath": "media/logo.svg"`, drawn in the icon color
as VS Code does).

Names: commands, views and settings start with the extension's name (`todo.`) or its full id
(`acme.todo.`); a dashed name uses camelCase (`acme.todo-list` → `todoList.`). Names of built-in
areas (`git`, `editor`, `terminal`…) need the full id. (Extensions that come with the IDE may claim
built-in namespaces with `"namespaces": ["git"]`, D208, so the Git tools extension keeps
`git.lineHistory`; any other manifest with `namespaces` is refused.) Command ids are camelCase segments.
Keybindings, menu items and status bar items may only run the extension's own commands. A panel
or editor view also gets a `<view id>.show` command. Menu `when` clauses see the IDE's context
keys plus `resourceFilename`, `resourceExtname`, `resourceLangId`, `resourcePath` and
`explorerResourceIsFolder` (explorer and editor menus), or `view` (view titles). Explorer and
editor items run their command with `{ path }`; view title buttons with no input.

`effects` say what a command does (`read`, `write`, `exec`, `network`, `destructive`); agents and
the permission checks use them, as for built-in commands.

Pictures (D190): `icon` can be an SVG you draw (square, 128×128 viewBox, no scripts) or a PNG,
JPEG, GIF or WebP file; `screenshots` (at most 12) are shown above the README on the extension's
page. For a development extension, `extensions.setIcon { id, file | name }` and
`extensions.addScreenshot { id, caption? }` do it for you: the second takes a picture of the IDE as
it is, so open the extension's view first (or pass `from: "file", file`). Users get the same from
the extension's menu and the "Add screenshot" tile on its page.

## Permissions

| Permission | Allows |
|---|---|
| `fs.read` | Read files in the open folder (every folder of a multi-root workspace); the folders themselves (`workspaceFolders`…); IDE commands with `read` effects; `ide://editors`, `ide://workspace`…; file events; editor decorations, problems, hover and completion providers |
| `fs.write` | Change files in the open folder (or the workspace's folders); `updateWorkspaceFolders`; commands with `write` effects |
| `shell` | Commands with `exec` effects (tasks, terminals); `ide.process.spawn` (also needs a trusted folder) |
| `terminal` | Terminal commands |
| `network` / `network:<domain>` | `ide.net.fetch` (any host / that host; `*.example.com` works) |
| `git`, `browser`, `agent` | Those areas' commands and state; `git` also `ide.git` (read-only, D208) |
| `github` | `ide.github` (notifications through the user's `gh`) and `github.*` commands (D208) |
| `clipboard` | Clipboard commands |
| `web.embed` | Its pages may show https web pages in frames (`frame-src https:`; sandbox them) |
| `node` | Run its code in Node.js (`"host": "node"`, D255): files and programs like any program; only in a trusted folder |

A newer version asking for more is stopped until the user allows the new list. Commands the
extension runs with `destructive` effects also ask the user each time.

## Code

`main` is a plain script (CommonJS style). It runs in a worker without network, storage or DOM
APIs; everything goes through `ide`:

```js
exports.activate = (ide) => {
  ide.commands.register("todo.scan", async () => {
    const text = await ide.workspace.fs.read("src/main.ts");
    const count = (text.match(/TODO/g) ?? []).length;
    await ide.ui.notify(`${count} TODOs`);
    return { count };            // the command's result (agents see it too)
  });
  ide.ui.registerTreeView("todo.list", {
    getChildren: (parent) => parent ? [] : [{ id: "a", label: "First TODO", icon: "circle-dot" }],
  });
};
exports.deactivate = () => {};
```

- `ide.commands.execute(id, input)` runs any IDE command, checked against the permissions.
- `ide.state.get("ide://…")`, `ide.events.on("files.didSave", …)`.
- `ide.workspace.fs.readBase64(path)` / `writeBase64(path, data)`: binary files (an image for a
  page's `data:` URL, a pasted image or an exported PNG; `fs.read` / `fs.write`).
- `ide.commands.execute("editor.renderFile", { path, maxLines, iconOnly })`: a file's first lines
  colored as the editor colors them and its file icon, as markup a page can show (`fs.read`).
- `ide.commands.execute("editor.renderMarkdown", { text | path, base?, css? })`: Markdown as the
  IDE's preview renders it — `{ html, css }`. Put `html` in an element with the classes
  `md md-document ide-md` and `css` in a `<style>`: the page then reads like the user's Markdown
  preview in their theme (code colored, the folder's images inlined; ask again when the theme
  changes). Only pictures are read for images (`fs.read`).
- `ide.commands.execute("quickOpen.pickFile", { placeholder, extensions })`: the user picks a
  project file with quick open's search; returns `{ path }` (null if dismissed), relative to its
  folder — with several folders (a multi-root workspace) the folder's name first
  (`"api/src/x.ts"`), as `ide.workspace.asRelativePath` writes it. The `fs` calls take that path
  as it is; to tell which folder it is in, `ide.workspace.folderOf(path)`.
- `ide.editor.active()` (path, language, cursor, selected text; `fs.read`) and
  `ide.editor.insert(text)` (types at the cursor, replacing the selection; `fs.write`).
- `ide.workspace.findText(query, options)`: matching lines in the open folder (every folder of a
  multi-root workspace; respects .gitignore, `fs.read`); runs beside the search view's search
  rather than replacing it.
- `ide.ui.notify / showQuickPick / showInput`.
- `ide.ui.createOutputChannel(name)`: the extension's own channel in the Output tab (VS Code's
  `window.createOutputChannel`): `append`, `appendLine`, `replace`, `clear`, `show`, and the log
  channel's `trace` / `debug` / `info` / `warn` / `error` (lines below `log.level` aren't kept).
  Its id is `ext.<extension id>.<name in lower case>` (`output.show { channel }`, `ide://output`),
  its file is in the session's logs folder, and its lines stay after the extension stops. At most
  10 per extension; `console.log` still goes to Extension host.
- `ide.settings.get(key)` (own, `editor.*`, `workbench.*`, `files.*`, and what `readsSettings`
  lists), `ide.settings.onChange` (own and `readsSettings` keys).
- `ide.storage.get/set` (a small JSON store per extension).
- `ide.net.fetch(url, init)` (needs `network`).

### Processes, trust, state and more (D202)

For an extension that runs a program — a notebook kernel, a linter's server, a tool it ships:

```js
// Needs "shell", and the folder must be trusted (the user is asked once if they haven't decided).
const kernel = await ide.process.spawn({
  command: "python",
  args: [`${ide.extension.path}/kernel.py`],   // its own folder on disk
  cwd: "notebooks",                            // default: the open folder; or inside its own folder
  env: { PYTHONUNBUFFERED: "1" },
  framing: "ndjson",                           // or "lines" (default): each stdout line a string
});
kernel.onMessage((msg) => …);                  // ndjson: parsed JSON (a non-JSON line: its text)
kernel.onStderr((line) => …);
kernel.onExit((code, signal) => …);            // signal "SIGKILL": kill() or the IDE ended it
await kernel.send({ execute: "1 + 1" });       // ndjson: one JSON line; lines: text, a line each
await kernel.interrupt();                       // Ctrl+C (SIGINT; a console Ctrl+C on Windows)
await kernel.closeStdin();                      // it reads end-of-file
await kernel.kill();
```

At most 8 at a time per extension. They are killed when the extension stops (disabled, reloaded,
uninstalled), its worker dies, the folder closes or the folder is put in restricted mode. A folder
must be open. Output written before `onMessage` is called isn't lost (up to 1000 lines). Empty
stdout lines are skipped.

- `ide.extension.path`: the extension's folder (absolute); `ide.env.platform`: `"windows"`,
  `"macos"` or `"linux"` (pick `python` or `python3`, `\` or `/`).
- `ide.workspace.isTrusted()`, `ide.workspace.requireTrust(reason)` (asks if undecided; resolves
  `true` / `false`), `ide.workspace.onDidChangeTrust((trusted) => …)`.
- Folder events through `ide.events.on`: `workspace.didOpen`, `workspace.willClose` (no veto;
  `reason` "folder" or "window"), `workspace.didClose`, `workspace.didChangeTrust`, and
  `workspace.didChangeFolders` (`{ added, removed }`: folders added to or taken out of a
  multi-root workspace). No permission; the payload's `path` (the first folder's) and the
  folders are there with `fs.read`.
- `ide.context.set("acme.todo.busy", true)`: context keys its keybindings' and menus' `when` can
  test (`"when": "acme.todo.busy"`). Keys start with the extension's id and a dot; strings,
  numbers, booleans; `null` removes one; all go when it stops.
- `ide.state.register("ide://ext/acme.todo/summary", ({ params }) => ({ … }))`: a state path
  agents and scripts read (`ide://ext/acme.todo/summary?brief=1` gives `params.brief`). It must
  answer within 2 seconds (readers get `{ error }` otherwise); at most 20 paths; gone when it
  stops. Extensions that come with the IDE may also fill paths they declare in
  `contributes.state` (`"ide://notebook"`) if nothing else has them.
- `ide.ui.showDialog({ title, message, actions: [{ label, variant: "primary" | "danger" }],
  cancel })`: a modal question; resolves with the chosen label, `undefined` if cancelled. The
  dialog says which extension asks. One at a time per extension.
- `ide.ui.showQuickPick` items may have `icon` (an icon of the IDE's set) and `detail` (shown as
  the row's tooltip).
- A command runs as long as it takes (no time limit, as in VS Code); tree, hover, completion and
  state calls must answer within their limits.
- A command's handler gets `(input, { caller })`: `"user"`, `"agent"` (the agent, MCP or ACP
  clients), `"extension"` or `"other"`. With an `input` schema in the manifest the dispatcher
  checks the input first (unknown properties are refused unless `"additionalProperties": true`;
  `path`, which explorer and editor menus pass, is always allowed). An invalid schema shows as a warning
  and the command takes any input.
- `readsSettings`: setting keys or `"prefix.*"`. Never `agent.*`, `ai.*`, `mcp.*`, `accounts.*`, `lsp.*`,
  `http.*` or keys named like secrets (`token`, `secret`, `password`, `apiKey`, `key`…): the
  manifest is refused. They're listed on the extension's Permissions tab.

### The editor (D176)

```js
// 1-based lines and columns; a range without columns covers whole lines.
await ide.editor.open("src/main.ts", { line: 10 });
const text = await ide.editor.text();                       // the active file, unsaved edits too
await ide.editor.replace({ startLine: 3 }, "// new line 3\n");  // undoable when open (fs.write)
await ide.editor.decorate("todos", {                        // theme styles only (fs.read)
  style: "warning",
  ranges: [{ startLine: 3, hover: "**TODO** here" }],
  after: "1 TODO",
});
await ide.languages.setDiagnostics("src/main.ts", [{ line: 3, message: "Old TODO", severity: "info" }]);
ide.languages.registerHoverProvider("typescript", (ctx) => ctx.word === "TODO" ? "Finish me" : null);
ide.languages.registerCompletionProvider(["markdown"], (ctx) => [{ label: "TODO", kind: "keyword" }]);
const item = ide.ui.createStatusBarItem({ id: "count", name: "TODO count", text: "$(list-tree) 3", command: "todo.scan" });
await item.update({ text: "$(list-tree) 4" });
```

Hovers' Markdown can't run commands or HTML. At most 10 status bar items, 20 providers and 5000
decorated ranges per set. A status bar item's `name` (VS Code's `StatusBarItem.name`) is its
screen reader label and its entry in the status bar's right-click menu, where the user can hide
it (D383); an item without one is listed under the extension's name. `tone` ("warning", "error",
or "warning-text" / "error-text" for the text alone) marks one that needs attention.

As in VS Code there are no time limits on language providers: every provider gets a `CallToken`
after its context (`(ctx, token) => …`), which fires when the editor no longer needs the answer
(the user typed on or moved away); stop the work then. Providers are asked about the folder's
files and any document open in the editor (untitled ones, files elsewhere on disk, notebook
cells: `ctx.cell` is `{ notebook, id, text }`). Completions may be a `{ items, isIncomplete }`
list (asked again as the user types), with `labelDetail` / `labelDescription`, `snippet`, `range`
and `replaceRange` (insert / replace), `commitCharacters`, `additionalTextEdits`, a `command` to
run after, any of VS Code's kinds, and `resolveId` with `options.resolve` (filled in when
selected); the context says how they were asked (`triggerKind`, `triggerCharacter`). Problems keep
`severity: "hint"`, `tags` ("unnecessary", "deprecated"), `source`, `codeTarget` and
`relatedInformation`. `ide.languages.getLanguages()` lists every language the editor knows.
`ide.languages.execute({ kind, path, line, column, … })` ("fs.read") asks every provider the editor
has for a document (language servers, the editor's own services, every extension's) and merges
their answers, as VS Code's `vscode.execute…Provider` commands do: `kind` is one of
`core/extensions/providerQuery.ts`'s (definition, references, hover, documentSymbols,
codeActions, formatDocument, completion…), the answers are in the 1-based shapes there.

The other providers (VS Code's `languages.register…Provider`) take the same 1-based ranges. Paths
are in the open folder (relative or absolute); a code lens's or code action's `command` must be one
of the extension's own commands. Formatting, code actions and rename change files: they need
`fs.write`; the places providers answer with (definitions, references, links) may be anywhere on
disk, edits stay in the folder. Inlay hints may have label parts (a location, a command, a
tooltip), `textEdits`, and `resolveId` with `options.resolve`; a semantic tokens provider
registered with `range: true` is asked about the visible range only;
`registerInlineValuesProvider` gives the values the debugger shows at the end of lines while
paused (`{ kind: "text" | "variable" | "expression", range, … }`).

```js
const L = ide.languages;
L.registerDefinitionProvider("mylang", (ctx) => ({ path: "src/defs.my", startLine: 12 }));   // F12
L.registerReferenceProvider("mylang", (ctx) => [{ path: ctx.path, startLine: 3, startColumn: 5, endColumn: 9 }]);
L.registerDocumentFormattingProvider("mylang", (ctx) => [{ startLine: 2, text: "fixed\n" }]); // ctx.tabSize, insertSpaces
L.registerRangeFormattingProvider("mylang", (ctx) => []);                 // ctx.range
L.registerCodeActionProvider("mylang", (ctx) => [                         // ctx.range, ctx.diagnostics
  { title: "Fix it", kind: "quickfix", isPreferred: true, edits: [{ startLine: 1, text: "ok\n" }] },
  { title: "Explain", command: "mylang.explain", input: { line: ctx.range.startLine } },
]);
L.registerRenameProvider("mylang", (ctx) => {                             // ctx.newName; throw to refuse
  if (!ctx.word) throw new Error("Nothing to rename here.");
  return [{ path: ctx.path, startLine: 4, startColumn: 1, endColumn: 4, text: ctx.newName }];
});
L.registerSignatureHelpProvider("mylang", () => ({
  signatures: [{ label: "add(a, b)", parameters: ["a", "b"] }], activeParameter: 0,
}), { triggerCharacters: ["("], retriggerCharacters: [","] });
L.registerDocumentSymbolProvider("mylang", (ctx) => [                    // Outline, breadcrumbs
  { name: "main", kind: "function", startLine: 1, endLine: 9, children: [] },
]);
L.registerCodeLensProvider("mylang", () => [{ startLine: 1, title: "Run", command: "mylang.run" }]);
L.registerInlayHintsProvider("mylang", (ctx) => [{ line: 2, column: 8, label: ": int", kind: "type" }]);
L.registerSemanticTokensProvider("mylang", () => [{ line: 1, column: 1, length: 3, type: "keyword" }],
  { tokenTypes: ["keyword", "function"], tokenModifiers: ["declaration"] });
```

A code lens keeps its whole range (it shows above the range's first line). Three providers take
a second callback, as VS Code's do:

```js
// Rename's prepare step (prepareRename), before the rename box opens: the range renamed (it must
// contain the position) and the box's starting text; null for the word there; throw to refuse
// (the message shows at the symbol).
L.registerRenameProvider("mylang", provideEdits, {
  prepare: (ctx) => ({ startLine: ctx.line, startColumn: 5, endColumn: 9, placeholder: "name" }),
});
// Code actions resolved when chosen (resolveCodeAction): offer them without `edits`; `resolve`
// gets the action you returned and fills in its `edits` (only those are taken from it).
L.registerCodeActionProvider("mylang", (ctx) => [{ title: "Extract", kind: "refactor", at: ctx.range }], {
  resolve: async (action) => ({ ...action, edits: await computeEdits(action.at) }),
});
// Semantic tokens' refresh (onDidChangeSemanticTokens): the editor asks again.
const tokens = L.registerSemanticTokensProvider("mylang", provideTokens, legend, {
  onDidChange: (listener) => myEmitter.on(listener),                     // optional
});
tokens.refresh();
```

Work that takes a while shows with `ide.ui.withProgress` (VS Code's `window.withProgress`): a toast
(`location: "notification"`, the default; `cancellable` adds Cancel) or the status bar
(`"window"`), until the task settles:

```js
const result = await ide.ui.withProgress({ title: "Indexing", cancellable: true }, async (progress, token) => {
  progress.report({ message: "first half", increment: 50 });   // increments add up to 100
  if (token.isCancellationRequested) return null;
  return index();
});
```

### Git, GitHub and line annotations (D208)

The bundled Git tools extension (`src-tauri/bundled-extensions/gittools`: file blame, line
history, compare, stashes, GitHub notifications) is built only on this, so a git extension of your
own can do the same.

```js
// "git": read-only, through the IDE's git and its repositories. Each call may name
// { repository } (root, folder-relative path or folder name); else the one the path is in, else
// the one Source control shows.
const repos = await ide.git.repositories();          // [{ root, name, kind, selected, branch }]
const hunks = await ide.git.blame("src/a.ts");       // [{ start, end, commit: { hash, author, time, summary, uncommitted… } }]
const log = await ide.git.lineLog("src/a.ts", 10, 20, { limit: 50 });  // git log -L: [{ hash, parents, author, time, subject, path, diff, added, removed }]
const files = await ide.git.diffNames("main", "HEAD", { mergeBase: true }); // [{ status, path, origPath }]
const hash = await ide.git.revParse("v1.2");
const fork = await ide.git.mergeBase("main", "feature");
const { branches, tags } = await ide.git.refs();
const stashes = await ide.git.stashes();             // [{ index, message, time }]
const old = await ide.git.show("src/a.ts", "HEAD");  // "" the index, "HEAD" or a hash; null if absent
ide.git.onDidChange(({ root }) => …);                // a commit, checkout, stash, fetch… ("" : the list or selection changed)

// Changing a repository goes through the IDE's commands (they ask, refresh and route the same way):
await ide.commands.execute("git.stashApply", { index: 0 });   // "git" + "fs.write"
// Diffs of commits: editor.openDiff with the IDE's git contents, "git:<hash>@<repository path>".
await ide.commands.execute("editor.openDiff", {
  path: "/abs/repo/src/a.ts", base: `git:${parent}@src/a.ts`, head: `git:${hash}@src/a.ts`,
});

// "github": the user's own gh sign-in (no accounts of the IDE).
const notes = await ide.github.notifications({ all: false });
await ide.github.markNotificationRead(notes[0].id);
await ide.github.markAllNotificationsRead();

// "fs.read": text before each line of a file (a blame gutter). The cursor skips it, `hover`
// shows on it; tone 0 (accent) to 4 (faint). The same file again replaces them; null removes them.
await ide.editor.setLineAnnotations("src/a.ts", [{ line: 1, text: "Ann       3 d", tone: 0, hover: "…" }]);
ide.events.on("documents.didChange", ({ path }) => …);  // an open file was edited (unsaved; ≤ every 250 ms)
```

`lineLog` (its diffs) and `show` return file text, so they need "fs.read" as well as "git".
Give every line's `text` the same width (pad with spaces) so the code stays aligned; at most 80
characters, 20000 lines and 50 files per extension, one extension's annotations per file. They go
when the extension stops. `ide.editor.active()` also has `selection` (`startLine`… of the first
selection; the cursor when nothing is selected).

Tree views for this kind of tool (also D208):

- A sidebar view with `"sectionOf": "scm.view"` (or `"explorer.view"`) and a `sectionOrder` is a
  section at the bottom of Source control (the Explorer) while it's hidden from the activity bar —
  like Outline under the Explorer. The activity bar's menu moves it between the two. A view of
  yours starts with its own icon; the user hides it there to dock it (the IDE's own extensions'
  views are hidden by default through `workbench.activityBar.hidden`).
- Tree items may have `actions` (up to 4 buttons shown on hover, each `{ icon, title, command }`,
  run as the extension) and `strong` (the label in bold).
- `registerTreeView(…)` returns `setMessage(text)`: a line above the rows (what's shown, or why
  nothing is), VS Code's `TreeView.message`.
- A row's context menu (right-click, Shift+F10) comes from `menus["view/item/context"]`, as in
  VS Code: give tree items a `contextValue` and test it in `when` as `viewItem` (`view` is the
  view's id). `group` orders them ("navigation" first, then by name, `@n` within a group;
  separators between groups); `"group": "inline"` makes it a button on the row instead (with
  `icon`; 4 at most, before the item's own `actions`). The command runs as the extension with
  `{ item: { id, label, view, contextValue?, description? } }`, which its `input` schema accepts
  without declaring it.

  ```jsonc
  "menus": {
    "view/item/context": [
      { "command": "todo.done", "group": "inline", "icon": "check", "when": "view == todo.list && viewItem == task" },
      { "command": "todo.open", "group": "navigation", "when": "viewItem == task" },
      { "command": "todo.delete", "group": "9_danger", "when": "viewItem == task" }
    ]
  }
  ```
- A command can have `"when"` (a context-key clause such as `"gitRepo"`): it is unavailable, and
  off the palette, while the clause is false.

## Terminals, tasks, source control, debuggers, sign-ins and file systems (D233)

These plug an extension into the IDE's own features. `tests/fixtures/extensions/providers` uses
every one of them.

**Terminals** (`ide.terminals.create`). A terminal appears as an ordinary terminal tab.
- A pseudoterminal needs `"terminal"`. Your code is the terminal's program: `open(dimensions, io)`
  starts it, `io.write(text)` draws (ANSI allowed, `"\r\n"` for a new line) and `io.exit(code)`
  ends it. `input(data)` gets what the user types, `resize` the size, and `close` runs when the tab
  closes.
- A shell (`shellPath`, `shellArgs`, `cwd`, `env`, `name`) needs `"shell"` and a trusted folder.
- Where it shows: `focus: true` takes the focus; `background: true` opens the tab behind the
  active one, not shown until `show()`; `hidden: true` gives it no tab at all (VS Code's
  `hideFromUser`): it runs among the hidden terminals until `show()` gives it one (D388).
- `onEvent` hears what happens to it from the moment it's created: `started` (its process id),
  `closed` (exit code and VS Code's exit reason), `active`, `interacted`, and with shell
  integration its folder and each command's start and end (D296).
- The handle has `sendText`, `show`, `write` and `dispose`.
- Neither kind comes back after a restart: the tab becomes an ordinary shell. With
  `transient: true` (VS Code's `isTransient`), or `hidden`, it isn't saved with the folder at
  all (D388).

```js
const term = await ide.terminals.create({
  name: "Echo",
  pty: {
    open: (dims, io) => io.write(`ready (${dims.columns}x${dims.rows})\r\n`),
    input: (data) => term.write(data === "\r" ? "\r\n" : data),
  },
});
```

**Task providers** (`ide.tasks.registerTaskProvider(type, { provideTasks, resolveTask? })`).
- Declare the type in `contributes.taskDefinitions`: `[{ "type": "memo", "properties": {…} }]`.
  `shell`, `process` and `npm` are taken.
- Your tasks appear in Run task and `tasks.run` as `"<type>: <name>"`, after the folder's own.
- Each task has an `execution`:
  - `{ kind: "shell", commandLine }` or `{ kind: "process", process, args }` needs `"shell"`.
  - `{ kind: "custom", start(definition) }` returns a pseudoterminal the task runs in and needs
    `"terminal"`.
- `group`, `isBackground`, `problemMatchers` and `presentation` work as in tasks.json.
- `resolveTask` gets the tasks.json entries of your type.

**Source control** (`ide.scm.createSourceControl({ id, label, rootPath? })`). It shows as a section
of the Source control view, below git.
- `createResourceGroup(id, label)` gives a group. Set its `resourceStates`:
  `{ path, decorations: { letter, tone, tooltip, strikeThrough, faded }, command? }`, where `path`
  is a folder file or one of your file system's URIs.
- `inputBox` has `value`, `placeholder`, `visible` and `onDidChange`.
- `acceptInputCommand` is one of your commands. It runs with `{ value }` when the user presses the
  button or Ctrl+Enter.
- `count` sets the badge (default: every resource), and it adds to git's on the activity bar.
- `quickDiffProvider.provideOriginal(path)` gives the editor's change bars their original text.
- The sections run `extensions.scmSetInput`, `extensions.scmAccept` and
  `extensions.scmOpenResource`, which agents can run too.

**Debug adapters** (`ide.debug.registerDebugAdapterDescriptorFactory(type, factory)`).
- Declare the type in `contributes.debuggers`:
  `[{ "type": "memo-dbg", "label": "…", "configurationSnippets": [{ "label", "description", "body" }] }]`.
  The snippets join Add configuration…. A type the IDE debugs itself (`python`, `node`…) may be
  declared too: your adapter runs it, and the IDE's built-in adapter is the fallback when you
  supply none (D295).
- A launch of the type starts your extension if it isn't running yet.
- `createDebugAdapterDescriptor(session)` answers with one of:
  - `{ kind: "executable", command, args, cwd?, env? }`: needs `"shell"` and a trusted folder.
  - `{ kind: "server", port, host? }`: a port on this computer.
  - `{ kind: "inline", start(send) }`: returns `{ handleMessage(message), dispose? }`, an adapter in
    your code that exchanges DAP messages as objects.

**Authentication** (`ide.authentication`).
- `registerAuthenticationProvider(id, label, { getSessions?, createSession, removeSession? })`
  signs the user in to your service.
  - Without `getSessions`, the IDE keeps the sessions `createSession` returns in the OS keychain
    and drops them on sign-out.
  - Call `fireDidChangeSessions()` when yours change.
- `getSession(providerId, scopes, { createIfNone, forceNewSession, silent })` returns a session:
  - Your own provider's: given without a question.
  - Another extension's: only after the user allows it, once per account until the IDE restarts.
    Signing in through another extension's provider is asked first too.
  - `silent` never asks.
- `onDidChangeSessions` follows changes.
- The commands `extensions.authSignIn` and `extensions.authSignOut` sign in and out.

**Secrets** (`ide.secrets.get / store / delete`). Your own values, in the OS keychain the IDE uses
for its keys. The backend builds the key from your id, so no extension reaches another's secrets or
the IDE's.

**File systems** (`ide.workspace.registerFileSystemProvider(scheme, provider, { label?, isReadonly? })`).
- Implements `stat`, `readDirectory`, `readFile`, and optionally `writeFile`, `createDirectory`,
  `delete`, `rename` and `watch`. Report changes with `fireDidChange`.
- `"<scheme>:/…"` files open in the editor (`editor.openFile { path: "memfs:/a.txt" }`), which reads
  and saves them through you.
- Your files show in a section of the Explorer. Its buttons and each row's menu make new files
  and folders, rename and delete through your provider (`extensions.fsNewFile`, `fsNewFolder`,
  `fsRename`, `fsDelete`; agents can run them too; Delete asks first).
- `fireDidChange` reloads an open editor of that file when it has no unsaved changes, and shows
  "changed on disk" when it has (D234).
- `ide.editor.text / replace / open` and the `editor.getText` / `editor.replaceRange` commands take
  your URIs (any registered scheme's, with the same permissions as folder files).
- A tab of one of your files restored at startup waits (15 s at most) for your provider; add
  `"onFileSystem:<scheme>"` to `activation` so the IDE starts you for it.
- Built-in schemes (`file`, `untitled`, `git`…) and another extension's are refused.
- It's read-only without `writeFile`.

Your authentication providers' accounts are in the Accounts menu (Sign out, or Sign in with… when
there's none), and in `ide://accounts` as last read (D234).

`ide://extensions/providers` lists what every extension has registered.

## More of VS Code's API (D234)

`tests/fixtures/extensions/apiextras` uses each of these.

**Decoration types** (VS Code's `createTextEditorDecorationType` and `setDecorations`), for Error
Lens, Better Comments, TODO highlighters, indent and bracket colorizers:

```js
const todo = ide.editor.createDecorationType({
  color: "warning",                 // a theme name, { id: "editorWarning.foreground" }, or "#e5534b"
  backgroundColor: "warningBackground",
  fontStyle: "italic", fontWeight: "bold", textDecoration: "underline wavy", opacity: 0.8,
  borderColor: "accent", borderStyle: "dashed", borderWidth: "1px", borderRadius: "3px",
  isWholeLine: true,
  after: { contentText: "← to do", color: "subtle", margin: "2em" },   // also `before`
  overviewRulerColor: "warning", overviewRulerLane: "right",
  gutterColor: "label3",            // a bar beside the line numbers
  dark: { backgroundColor: "#ffcc0011" }, light: { … },
});
await todo.set("src/a.ts", [{ startLine: 3, hover: "**Do it**", after: "← this one" }]);
await todo.clear(); todo.dispose();
```

Theme names (`error`, `warning`, `info`, `success`, `accent`, `muted`, `subtle`, `foreground`,
`border`, `label1`…`label6`, and `errorBackground`, `warningBackground`, `infoBackground`,
`successBackground`, `accentBackground`) follow the user's theme; literal colors (hex digits or
the CSS color functions, numbers only) are for colors your user chose. Every value is checked
before it reaches a stylesheet. At most 50 types; their ranges count with `decorate`'s sets.
Needs "fs.read".

**More language providers** (same rules as the others: 1-based, files of the folder):

```js
L.registerTypeDefinitionProvider(lang, (ctx) => ({ path: "types.my", startLine: 4 }));
L.registerImplementationProvider(lang, (ctx) => [/* locations */]);   // Ctrl+F12
L.registerDeclarationProvider(lang, (ctx) => null);
L.registerDocumentHighlightProvider(lang, (ctx) => [{ startLine: 3, startColumn: 5, endColumn: 9, kind: "write" }]);
L.registerFoldingRangeProvider(lang, () => [{ startLine: 1, endLine: 9, kind: "region" }]);
L.registerDocumentLinkProvider(lang, () => [
  { startLine: 2, startColumn: 5, endColumn: 30, target: "https://example.com" },   // the browser
  { startLine: 3, startColumn: 5, endColumn: 12, target: "docs/a.md", line: 4 },   // a file
]);
L.registerColorProvider("css", () => [{ startLine: 1, startColumn: 8, endColumn: 15,
  color: { red: 1, green: 0, blue: 0, alpha: 1 } }], { presentations: ({ color }) => ["red"] });
L.registerOnTypeFormattingProvider(lang, (ctx) => [/* edits */], [";", "}"]);   // "fs.write"
L.registerInlineCompletionProvider(lang, (ctx) => [{ insertText: "ting()", command: "my.accepted" }]);
L.registerWorkspaceSymbolProvider(({ query }) => [{ name: "main", kind: "function", path: "a.my", startLine: 3 }]);
```

Links open only web pages (https, http, mailto) or files of the folder. A color pick without
`presentations` is written as hex. Inline completions (ghost text, Tab accepts) are the
extension's own: the IDE's AI completions setting doesn't apply to them; they get 5 s. Workspace
symbols join Go to symbol in workspace (Ctrl+T, `quickOpen.findSymbols`) within 1.5 s. On-type
formatting changes text by itself, so it needs "fs.write"; the others "fs.read".

**The active editor's events** ("fs.read"): `ide.editor.onDidChangeActive((e) => …)` (`{ path,
language }` or null), `onDidChangeSelection` (`{ path, selections }`), `onDidChangeVisibleRange`
(`{ path, startLine, endLine }`); also as `ide.events.on("editor.didChangeActive" …)`. They fire
on changes only (at most every 100 ms); read the current state with `ide.editor.active()`.

**Files** ("fs.read"):

```js
const docs = await ide.workspace.findFiles("**/*.md", "**/node_modules/**", 100);   // absolute paths
const watcher = ide.workspace.createFileSystemWatcher("src/**/*.ts", { ignoreChange: false });
watcher.onDidCreate((path) => …); watcher.onDidChange((path) => …); watcher.onDidDelete((path) => …);
```

findFiles lists the file index (`.gitignore`d files aren't in it), 10000 at most. A watcher hears
the IDE's file events (saves, writes, creates, deletes, renames as a delete and a create) for
files of the folder. In a multi-root workspace both cover every folder: a glob is matched against
the path relative to the file's folder; VS Code's RelativePattern, written as a plain object,
narrows it to one folder (`{ base: ide.workspace.workspaceFolders[1], pattern: "**/*.rs" }`, or
`base` as an absolute path).

**Workspace folders** (D251, VS Code's multi-root workspaces; "fs.read"). A window can hold
several folders (a `.code-workspace` file). With one folder everything is as before: `root()` is
that folder and relative paths are relative to it.

```js
const folders = ide.workspace.workspaceFolders;        // [{ path, name, index }] or undefined
ide.workspace.getWorkspaceFolder("/work/api/src/main.rs");   // { path: "/work/api", name: "api", index: 1 }
ide.workspace.asRelativePath("/work/api/src/main.rs");       // "api/src/main.rs" (the name only with several)
ide.workspace.onDidChangeWorkspaceFolders(({ added, removed }) => …);
ide.workspace.updateWorkspaceFolders(folders.length, 0, { path: "/work/docs" });   // true: asked for
```

- `workspaceFolders`, `rootPath` (deprecated: the first folder), `name` ("api" or "Shop
  (Workspace)") and `workspaceFile` (the `.code-workspace` file, undefined for a single folder)
  are kept current; they are undefined with nothing open, and without `fs.read`.
- `ide.workspace.folders()`, `folderOf(path)` and `onDidChangeFolders` are the same, the IDE's way
  (`folders()` asks the IDE).
- Paths: the fs, editor, terminal and debug calls take a path in any folder: absolute, or relative
  with the folder's name first (`"api/src/main.rs"`); a relative path without one is the first
  folder's. Nothing outside the workspace's folders.
- `updateWorkspaceFolders(start, deleteCount, ...folders)` ("fs.write" too) checks its input as VS
  Code does and returns false for a bad one, for nothing to change, or while an earlier update is
  under way. The user is asked before folders are added; they go at the end with their folder's
  name (the IDE doesn't reorder or rename folders this way); taking out the first folder reopens
  the workspace with the next one first; the last can't be taken out.
- `workspaceState` is per folder, and for a multi-root workspace per workspace file (a folder
  turned into an untitled workspace starts a new one, as in VS Code).
- `workspaceContains:` activation looks in every folder, and again in folders added later.

**Settings, state and env:**
- `ide.settings.update(key, value, "user" | "workspace")` writes your own settings (or others a
  folder's settings could set: never user-only ones or credentials'); "fs.write".
- `ide.workspaceState.get / set`: like `ide.storage`, but per folder (per workspace file for a
  multi-root workspace).
- `ide.env.appName`, `ide.env.language`, `ide.env.openExternal(url)` (https, http, mailto, in the
  system's browser), `ide.env.clipboard.readText / writeText` ("clipboard").
- `ide.ui.showQuickPick(items, { matchOnDescription })`; an item's `separator` starts a group.
  `ide.ui.showInput({ password: true })` masks what's typed.

**Debug configurations:** `ide.debug.registerDebugConfigurationProvider(type, {
resolveDebugConfiguration(config) })` fills in or changes a configuration of your type before it
starts (null cancels); the launch / attach request carries the result (its `type` and `request`
stay, and `program`, `args`, `cwd`, `stopOnEntry` as launch.json gave them win). Its
`provideDebugConfigurations(folder)` (VS Code's) offers configurations in "Add configuration…":
each needs a `name`; its `type` is forced to yours, `request` is "launch" unless it says
"attach"; 20 at most, 5 s to answer. Either method may be left out. A third argument, `"initial"`
(default) or `"dynamic"` (VS Code's DebugConfigurationProviderTriggerKind), is accepted; both are
offered there (the IDE has no separate picker of dynamic configurations yet). Add
`"onDebugInitialConfigurations"` to `activation` to be started for it.

**Tests** (VS Code's test controllers): your tests show in the Testing view, a group of their own
after the built-in frameworks'; Run and Debug on its rows (and Run all tests) call your run
profiles.

```js
const ctrl = ide.tests.createTestController("memo", "Memo tests");
const file = ctrl.createTestItem("a.spec", "a.spec", "tests/a.spec");   // id, label, file
const t = ctrl.createTestItem("adds", "adds numbers", "tests/a.spec");
t.range = { startLine: 3 };                                             // 1-based
file.children.add(t);
ctrl.items.add(file);
ctrl.resolveHandler = async (item) => { /* item.canResolveChildren: add its children now */ };
ctrl.createRunProfile("Run", "run", async (request, token) => {        // or VS Code's 1 / 2
  const run = ctrl.createTestRun(request);
  for (const test of request.include ?? allTests()) {
    if (token.isCancellationRequested) break;
    run.started(test);
    run.appendOutput("…\r\n", undefined, test);
    ok ? run.passed(test, ms) : run.failed(test, { message, expectedOutput, actualOutput }, ms);
  }
  run.end();
}, true);
ctrl.createRunProfile("Debug", "debug", debugHandler, true);
```

A failure's message shows on the test's row; `tests.runExtension {controller?, item?, profile?}`
runs them for agents (counts and failures), `ide://tests/extensions` lists them with their last
results. Coverage profiles report with `run.addCoverage` (see "Tests" under "Node, and the rest
of VS Code's API"). Test items' files are paths of the open folder (VS Code's Uris); 20 000
items, 10 controllers at most.

**Typing, links, edits across files, saves** (VS Code's `type` override, `registerUriHandler`,
`applyEdit`, `onWillSave…`):

```js
// A Vim-style keymap ("fs.write"): every character typed in the editor comes here. One extension
// at a time; the user is told, and can turn it off (extensions.turnOffTypeOverride).
ide.commands.register("type", ({ text }) => {
  if (mode === "insert") return ide.commands.execute("default:type", { text });   // the editor types it
  handleNormalModeKey(text);
});
await ide.editor.setOptions({ cursorStyle: "block" });   // "line", "underline", "block-outline"…; null resets

// Links to the IDE: `${ide.env.uriScheme}://<your extension id>/path?query` (activation "onUri").
ide.ui.registerUriHandler({ handleUri(uri) { /* uri.path, uri.query (encoded), uri.fragment */ } });

// Several files at once ("fs.write"), in order; resolves false when something can't be applied.
const edit = ide.workspace.createWorkspaceEdit();
edit.replace("src/a.ts", { startLine: 3, startColumn: 7, endColumn: 10 }, "next");
edit.createFile("src/b.ts", { contents: "export {};\n", ignoreIfExists: true });
edit.renameFile("src/old.ts", "src/lib/new.ts");
edit.deleteFile("src/gone.ts", { ignoreIfNotExists: true });   // the user confirms; to the trash
await ide.workspace.applyEdit(edit);

// Before a save ("fs.read"; edits need "fs.write"): 1.5 s for everything passed to waitUntil.
ide.workspace.onWillSaveTextDocument((e) =>
  e.waitUntil(format(e.path).then((text) => [{ startLine: 1, endLine: 99999, text }])));
ide.workspace.onWillSaveNotebookDocument((e) => e.waitUntil(cleanOutputs(e.path)));

// Several items: resolves with the checked ones.
const picked = await ide.ui.showQuickPick(items, { canPickMany: true });
```

The link reaches the extension through `extensions.openUri {uri}`. On Windows the IDE registers
its scheme for the user at start (installed builds), so a link clicked in a browser opens it;
macOS and Linux don't declare it in their bundles yet. A text edit to an open
file changes it in its editor (unsaved, one undo step); a closed file is written. A rename to
another folder moves the file first; open editors follow both.

**Tree views: drag and drop, checkboxes.** A provider with `handleDrop(target, sources)` (or VS
Code's `dragAndDropController: { handleDrop }`) lets the user drag rows onto other rows of the
view (`target` undefined: below the rows). A row with `checkboxState` (`"checked"` /
`"unchecked"`, or VS Code's 1 / 0) shows a checkbox; clicks reach the provider's
`onDidChangeCheckboxState(changes)` and the view's `onDidChangeCheckboxState(listener)`.

**Comments** ("fs.read", VS Code's comments API):

```js
const notes = ide.comments.createCommentController("acme.notes", "Notes");
notes.commentingRangeProvider = { provideCommentingRanges: (doc) => [{ startLine: 1, endLine: 9999 }] };
// Replies, and the first comment of a thread the user starts (Add comment on a line).
notes.replyHandler = ({ thread, text }) => {
  thread.comments = [...thread.comments, { body: text, author: { name: "You" } }];
};
const thread = notes.createCommentThread("docs/a.md", { startLine: 4 }, [
  { body: "Is this still true?", author: { name: "Ann" } },
]);
thread.collapsibleState = "expanded";   // or VS Code's 1; "collapsed" (0) shows only the count
```

A thread shows as a mark beside its lines (the thread on hover) and a line above them: its latest
comment (or the count, collapsed) and Reply. VS Code takes replies through commands in a
`comments/commentThread/context` menu; here the controller's `replyHandler` gets them.

**The language model and chat participants.** Off unless the user turns on
`extensions.languageModelAccess`; then each extension is asked about once.

```js
const [model] = await ide.lm.selectChatModels();   // [] while access is off
if (model) {
  const res = await model.sendRequest([ide.lm.LanguageModelChatMessage.User("Explain this")], {
    justification: "To explain the selected code",
  });
  for await (const part of res.text) out += part;
}
// "@helper": asked with extensions.askChatParticipant { name, prompt }; it writes Markdown.
ide.chat.createChatParticipant("acme.helper", async (request, context, stream) => {
  stream.markdown(`You asked: ${request.prompt}`);
}, { name: "helper" });
```

The model is the user's own (the inline edit's model setting, else the agent's); messages reach
it as one prompt. A message in the agent's chat that starts with a participant's `@name` goes to
it (`@name /command rest` passes its slash command) and its answer shows in the chat (D255); one
of the user's own agents by that name wins.

## Node, and the rest of VS Code's API (D255)

**Code that runs in Node.** `"host": "node"` in the manifest (with the `node` permission) runs
`main` in a Node.js process of its own instead of the sandboxed worker: `require` works (its own
modules, npm packages in its folder, Node's built-ins), and so do `fs`, `child_process` and
sockets. `ide` is the same object as in the worker. What it prints (`console`, `process.stdout`)
goes to its log. It needs Node.js 18 or newer on PATH, starts only in a trusted folder, and ends
with the window. Use it for what the worker can't do; the worker stays the default.

```json
{ "id": "acme.tool", "main": "main.js", "host": "node", "permissions": ["node", "fs.read"] }
```

**More language providers** (VS Code's names; lines and columns from 1, like the rest of `ide`):

```js
ide.languages.registerLinkedEditingRangeProvider("html", (c) => ({ ranges: [open, close] }));
ide.languages.registerSelectionRangeProvider("toml", (c) => c.positions.map(() => [inner, outer]));
ide.languages.registerCallHierarchyProvider("cobol", {
  prepareCallHierarchy: (c) => ({ name, kind: "function", path: c.path, range, data: { id } }),
  provideCallHierarchyIncomingCalls: ({ item }) => [{ from: caller, fromRanges: [site] }],
  provideCallHierarchyOutgoingCalls: ({ item }) => [{ to: callee, fromRanges: [site] }],
});
ide.languages.registerTypeHierarchyProvider("cobol", { prepareTypeHierarchy, provideTypeHierarchySupertypes, provideTypeHierarchySubtypes });
ide.languages.registerEvaluatableExpressionProvider("cobol", (c) => ({ range, expression }));
```

A call or type hierarchy from an extension answers Show call hierarchy (Shift+Alt+H) where no
language server does; an evaluatable expression is what the debugger's hover shows the value of.

**The debugger.** `ide.debug.breakpoints()`, `addBreakpoints([{ path, line, condition?,
enabled? }])`, `removeBreakpoints(ids)`, function breakpoints (`functionBreakpoints()`,
`addFunctionBreakpoints`, `removeFunctionBreakpoints(names)`), `protocolBreakpoint(session, id)`,
`activeDebugSession()`, `debugSessions()` (sessions carry their resolved `configuration`,
`parentSession` and `workspaceFolder`), `startDebugging(name or configuration, options?)` (VS
Code's DebugSessionOptions: `parentSession`, `lifecycleManagedByParent`, `consoleMode`, `noDebug`,
`folder`), `stopDebugging(id?)`, `customRequest(command, args?, sessionId?)`,
`appendToConsole(text)`, and `onDidStartDebugSession`, `onDidTerminateDebugSession`,
`onDidChangeActiveDebugSession`, `onDidChangeBreakpoints`, `onDidReceiveCustomEvent` (an
adapter's own events), `onDidChangeActiveStackItem` ("fs.read"; starting, stopping and requests
need "shell"). A configuration provider's `resolveDebugConfiguration(config, folder)` runs
first, `resolveDebugConfigurationWithSubstitutedVariables` after the variables are filled in
and the preLaunchTask ran (VS Code's order).

**Tests.** A coverage profile's run reports each file with `run.addCoverage({ path, lines:
[[line, count], …], branches?, functions? })`; the Testing view shows it as it shows a built-in
framework's (gutter, coverage view). Items have `tags` (`[{ id }]`) and a profile a `tag`: a
profile with a tag runs only items that have it.

**Comments.** A comment's `reactions` (`[{ label, count, authorHasReacted }]`) with the
controller's `reactionHandler(comment, reaction)`, and its `editHandler({ thread, comment, text
})` for editing a comment in place; the thread's quick pick offers both. Add comment is in the
editor's menu while an extension takes comments.

**Also:** `ide.editor.open(path, { selection, preserveFocus, toSide })` (VS Code's
showTextDocument options); `ide.env.machineId` / `sessionId` (random ids, the installation's and
the window's; never derived from the machine); `activationEvents` (VS Code's name) works for
`activation`, and `onNotebook:<type>` and `onDebug` activate; links to the IDE
(`<scheme>://<extension id>/…`) from other programs reach `registerUriHandler` (Windows registers
the scheme for the user; macOS and Linux will declare it in their bundles).

## Coverage versus VS Code

What the most-installed VS Code extensions use, and whether an extension here can do the same
(D234). ✓ there, ◐ partly, ✗ not yet.

| Extension (kind) | What it needs | Here |
|---|---|---|
| Prettier, Black, other formatters | formatting providers, configuration, `onWillSave` formatting | ✓ |
| ESLint, Pylint, linters | diagnostics, code actions, a server process, watchers | ✓ (`ide.process.spawn`) |
| GitLens, Git Graph | blame, line annotations, hovers, CodeLens, SCM, webviews, tree views | ✓ (Git tools is built on it) |
| Error Lens, Better Comments, TODO Highlight, indent-rainbow, bracket colorizers | decoration types (colors, before/after text, ruler, gutter) | ✓ (gutter icons are a color bar) |
| Todo Tree, Project Manager | tree views with `when` menus, findFiles, watchers, workspace / global state | ✓ (drag and drop within a view) |
| Path IntelliSense, snippets packs | completion providers, snippets | ✓ |
| Live Server, Live Preview, REST Client | webviews, status bar, CodeLens, `openExternal`, net | ✓ (`createWebviewPanel` at run time; pages reach only the extension's files and `ide.net.fetch` through messages) |
| Code Runner, Docker, Remote explorers | terminals, tasks, tree views | ✓ (Remote's own connection model: ✗) |
| Python, C#, Go, Java | language servers, debug adapters and configuration resolve, test controllers, notebooks | ✓ (`provideDebugConfigurations` in Add configuration…) |
| Jupyter, notebook formats | notebook serializers, kernels, renderers | ✓ |
| Themes, icon themes | color themes, file icon themes, product icon themes | ✓ (installable from Open VSX, D254; product icon themes redraw the IDE's icons that have a codicon counterpart, D267) |
| Markdown All in One | commands, keybindings with `when`, completion, document symbols, folding, links | ✓ |
| Copilot-style assistants | inline completions, chat participants, language model API | ✓ (opt-in; a message to the agent that starts with a participant's `@name` goes to it, D255; the agent has its own extension points) |
| Vim, Emacs keymaps | `type` command override, cursor style, keybindings with `when` | ✓ (`type` and `default:type`, `editor.setOptions({ cursorStyle })`) |
| Draw.io, CSV / Excel viewers | custom editors | ✓ (`viewers`) |
| Peacock | workbench color customizations | ✓ (title, activity and status bars; `settings.update("workbench.colorCustomizations", …, "workspace")`) |
| Settings Sync | settings, keybindings, extensions lists | ◐ (`settings.update`, the IDE's profile commands) |
| Live Share, Remote - SSH / WSL / Containers | remote file systems and extension hosts | ✗ (out of scope; file system providers cover simple remote files) |

By namespace (D255: phase 1 of `docs/vscode-extensions-plan.md`; what the `vscode` shim maps
onto). ✓ there, ◐ partly, ✗ not there.

| VS Code namespace | Here | What's left |
|---|---|---|
| `commands` | ✓ `ide.commands` (and the `type` override) | Commands take one input object (JSON), not argument lists |
| `window` | ✓ `ide.ui`, `ide.editor`, `ide.terminals` (status bar, quick pick with `canPickMany`, input, dialogs, progress, output channels, tree views with drag and drop and checkboxes, webview panels, decorations, editor events, URI handlers, `showTextDocument`'s selection / preserveFocus / to the side) | — |
| `workspace` | ✓ `ide.workspace` (fs, findFiles, watchers, configuration, trust, file system providers, `applyEdit` across files, `onWillSave…`, workspace folders) | `textDocuments` as objects (a file's text is `ide.editor.text`) |
| `languages` | ✓ every provider of the table above, plus linked editing, selection ranges, call and type hierarchies and evaluatable expressions (D255), inline values, diagnostics | Document drop / paste edits |
| `debug` | ✓ adapters, configuration providers and resolve, breakpoints (list, add, remove, events), sessions (active, all, start, stop, events) and `customRequest` (D255), adapter trackers (D258) | — |
| `tasks` | ✓ | — |
| `scm` | ✓ | — |
| `tests` | ✓ controllers, items, run / debug / coverage profiles, `addCoverage`, tags (D255) | Per-test coverage detail |
| `comments` | ✓ threads, replies, new threads, reactions and editing a comment (D255); Add comment in the editor's menu | A "+" in the gutter; comment menus by `contextValue` |
| `authentication` | ✓ | — |
| `env` | ✓ `appName`, `language`, `uriScheme`, `machineId` / `sessionId` (random, D255), `themeKind` ("light" / "dark"; the "theme.didChange" event has its changes), `openExternal`, clipboard | `remoteName`, `shell` |
| `notebooks` | ✓ (`ide.notebooks`) | The renderer extras in `docs/feature-gaps.md` ("Extensions and their API") |
| `chat` / `lm` | ✓ opt-in (`extensions.languageModelAccess`) | Participant follow-ups and references |
| `extensions` (other extensions' APIs) | ✗ in the IDE's own format | VS Code packages call each other's (`extensions.getExtension`, live `exports` in the shared host, D296); the IDE's own format has no `ide.extensions` |
| Where code runs | ✓ the sandboxed worker, or Node (`"host": "node"` with the "node" permission, D255); VS Code extensions' own code in Node behind the `vscode` module (D256) | See "VS Code extensions" below |

## VS Code extensions (D256, D257)

An extension written for VS Code (its `package.json` with a `main`, from Open VSX or a `.vsix`)
runs its code in the Node host (above), where `require("vscode")` is the IDE's shim
(`src/core/extensions/vscode/`) over the same `ide` API. Its themes, grammars, languages,
snippets and settings work as soon as it's installed; its code runs once you allow it (asked at
install: it gets what any program you install gets, `node` with files, programs, the network,
git and the clipboard). Until then it stays as it was before the shim: declarative parts only.

What its `package.json` becomes:

- `contributes.commands`: the IDE's commands (palette, keys, menus, agents). An id the
  dispatcher can't take is camelCased (`markdown-preview.open` is `markdownPreview.open`); its
  code still uses VS Code's. `menus.commandPalette` with `"when": "false"` keeps one off the
  palette; `enablement` is the command's `when` (keybindings included). A command whose id is
  already an IDE command is skipped (agents and the UI run IDE ids under permission checks), but
  the extension's own keybindings for it still run its code (D296).
- `contributes.configuration`: settings, under its title, with VS Code's types, enums, defaults
  and scopes: `application` and `machine` ones in the user's settings only; `machine-overridable`
  ones, those in its `restrictedConfigurations` and ones that name a program to run may be set by
  a folder once it's trusted (D296). A key declared twice is shared (the first declaration wins,
  with a warning); only the IDE's credential areas are refused. `configurationDefaults` apply,
  `[language]` blocks too, and a folder's `.vscode` values for its settings apply once it
  registers them (D379).
- `keybindings` (to its own commands), `views` (the Explorer's and Source control's become their
  sections; a container of its own an activity bar icon per view; a `"type": "webview"` view's
  page comes from its code), `menus` (`editor/context`, `editor/title`, `explorer/context`,
  `view/title`, `view/item/context`).
- `customEditors` (by their `filenamePattern`s; `"priority": "option"` only in Reopen with…),
  `notebooks`, `notebookRenderers`, `debuggers` (a `program` with a `runtime` is started as the
  adapter when its code registers no factory) and `taskDefinitions` (D257).
- `activationEvents`, plus VS Code's implicit ones: its languages (`onLanguage:`), its commands
  and views; `%key%` strings from `package.nls.json`.
- Context keys its code sets with `setContext` may start with its commands', settings' or views'
  first segment (`gitlens:enabled`), not only its id.

What the shim maps (VS Code's 0-based positions become the IDE's 1-based ones):

| `vscode` | Here |
|---|---|
| `commands` | `registerCommand` (VS Code's ids; arguments from menus are a `Uri` or the tree row's element), `executeCommand` (every VS Code package's commands in one registry, as in VS Code, then `setContext`, `vscode.open`, `editor.action.showReferences`, settings and save-all, `vscode.execute…Provider` (below), `cursorMove` / `editorScroll` in the active editor, then the IDE's commands), `registerTextEditorCommand` |
| `window` | messages (modal ones as dialogs), quick pick and input (`createQuickPick` / `createInputBox` stay live while open: items, busy, buttons, checkboxes, validation; D296), `tabGroups` (D296), status bar items, output and log channels, `withProgress`, `activeTextEditor` (selections, `edit`, `insertSnippet`, `setDecorations`, `revealRange`), `showTextDocument`, decoration types, tree views (`createTreeView`, `registerTreeDataProvider`), webview panels (the page gets `acquireVsCodeApi()` and VS Code's message events and CSS variables), terminals and pseudoterminals (`hideFromUser` and `isTransient` honored, D388), URI handlers |
| `workspace` | configuration (read before activation, so `get` is synchronous; `update`, `onDidChangeConfiguration`), `textDocuments` and their open, change, save and close events (a change is one replaced range), `openTextDocument`, `fs` (files on disk, its own files too), `findFiles`, watchers, `applyEdit`, trust, folders, `registerTextDocumentContentProvider`, `registerFileSystemProvider` |
| `languages` | every provider of the namespace table above, `createDiagnosticCollection` (all of them merged per file), `match`, `getDiagnostics` |
| `env`, `extensions`, `l10n`, ExtensionContext | `env`'s ids, `shell`, clipboard, `openExternal`; `getExtension` and `all` for itself, `vscode.git` and every installed VS Code package (D265); `l10n.t`; `globalState` / `workspaceState` (Mementos), `secrets`, storage and log folders, `subscriptions`, `asAbsolutePath` |
| `window` (D257) | `registerWebviewViewProvider` (resolved when it registers; the page stays while the view is closed), `registerCustomEditorProvider` (text editors, and read-only custom documents; one page per tab), `showOpenDialog` / `showSaveDialog` (the system's dialogs) |
| `debug` (D257) | adapter descriptor factories (executables, servers, adapters in its code), configuration providers (initial and dynamic, resolve with substituted variables), sessions (`activeDebugSession`, start, stop, events, `customRequest`), `breakpoints` (kept for synchronous reads) with add, remove and their change event |
| `tasks` (D257) | task providers (shell, process and custom executions, groups, presentation, problem matchers), `fetchTasks`, `executeTask` (by its label) |
| `scm` (D257) | source controls: input box, count, the accept command, resource groups and states (with commands), quick diff (an original from its file or the extension's own content provider) |
| `tests` (D257) | controllers, items (Uris and Ranges both ways), run profiles and requests, runs with TestMessages, coverage (a FileCoverage's statements, from its details or `loadDetailedCoverage`) |
| `comments` (D257) | controllers, threads, comments, commenting ranges, reactions; replies and edits run the commands of its `comments/commentThread/context` and `comments/comment/context` menus, as in VS Code |
| `authentication` (D257) | `getSession`, providers with their change events |
| `notebooks` (D257) | serializers (bytes ↔ cells with outputs), controllers (as kernel sources: a cell runs through `executeHandler`, its execution's outputs stream in), cell status bar items, renderer messaging, the open notebooks and their events |
| `chat`, `lm` (D257) | chat participants (named from `chatParticipants`), models (`selectChatModels`, `sendRequest` with text parts, `countTokens`) while language model access is on |
| `vscode.git` (D257) | VS Code's Git extension API on the IDE's git: repositories, HEAD, branches, tags, remotes, index and working tree changes (kept current), `show`, `getCommit`, `diffBetween`, `toGitUri` (readable through `openTextDocument`); changing a repository is the IDE's `git.*` commands |

D258 added: tree rows' own icons (`iconPath` as a file, light and dark), `TreeView.reveal`
(through the provider's `getParent`) and `selection`; Explorer badges
(`registerFileDecorationProvider`: badge, color, tooltip); `setLanguageConfiguration` (merged over
the language's, with `onEnterRules`, which language-configuration.json files get too); debug
adapter trackers (every DAP message both ways); editable custom editors (Ctrl+S calls
`saveCustomDocument`, Ctrl+Z / Ctrl+Y their edits' undo / redo, the tab shows unsaved changes);
language model tools (`contributes.languageModelTools` are commands the agent calls, answered by
`lm.registerTool`); `setTextDocumentLanguage`; language status items; and VS Code's own command
ids extensions run (`workbench.action.files.save`, `revealInExplorer`, `vscode.diff`,
`workbench.action.tasks.runTask` and about forty more) as the IDE's.

D260 (Claude Code for VS Code): views and view containers honour their `when` clauses (with the
context keys the package's views test counted as its own to set); `viewsContainers.secondarySidebar`
is the dock's right side; container and view icon files are the activity bar's icons; a view
without a name takes its container's title; `<view id>.focus` reveals one of its views; URI schemes
may contain `_` (`_claude_fs_left`); the shim reports VS Code 1.146 (the latest
stable when set, D423). Pages get VS Code's
`--vscode-*` colors (about 190, from the IDE's tokens), `color-scheme`, the body's `vscode-dark` /
`vscode-light` class and VS Code's default page styles from their first paint, not only after
loading. A VS Code package's file systems get no Explorer section (VS Code shows none). Open VSX
installs this platform's build of an extension published per platform (`win32-x64`…), else the
one for all platforms. `ide://ext/<id>/vscode` lists its webview views (resolved, page set,
errors) and `ide://extensions?id=<id>` what each view's frames show.

D261 (the audit): code running in Node stops when the folder stops being trusted (and asks again
when next used); installs keep `node_modules` for code that runs in Node; a setting another
extension registered is never "its own" by name; `extensions.*` commands from an extension need
the user's yes. In the shim: documents show an edit once `edit` / `applyEdit` resolve,
`isDirty`, completions' ranges, sort / filter text and additional edits, code actions get the
extension's own Diagnostics, `Uri` ports, `editor.selections =`, QuickPicks that load their items,
untitled documents with content, `NotebookEdit`, breakpoint identity, and ShellExecution quoted
for PowerShell or cmd (with `executable` / `shellArgs`). `sendText` sends line breaks as Enter;
`env.shell` is the IDE's terminal shell.

D264 (the terminal): `context.environmentVariableCollection` (replace, append, prepend; new
terminals and task terminals get them, "shell"; they go when its code stops),
`window.registerTerminalLinkProvider` (the line pointed at goes to it, answered within half a
second; Ctrl+click calls `handleTerminalLink` with its own link object), and
`window.registerTerminalProfileProvider` for the profiles `contributes.terminal.profiles`
declares (in the terminal's ＋ ▾ menu and profile picker before its code runs; picking one starts
it). The IDE's API has them as `ide.terminals.setEnvironment`, `registerLinkProvider` and
`registerProfileProvider` (a manifest's `terminalProfiles`). A test failure's
`TestMessage.location` is where its row opens and what the results report (`failedAt`).

D265 (extensions together): `extensions.getExtension(id)` and `extensions.all` find any
installed VS Code package. `activate()` starts the other extension first, as in VS Code;
`exports` is there once it has activated (the live object since D296, below). The notebook
editor: a NotebookDocument has its cells (text, kind, language,
metadata, outputs, execution order) and fires content and cell changes;
`window.activeNotebookEditor` (its `selections`, `revealRange`), `visibleNotebookEditors`,
`showNotebookDocument`, `openNotebookDocument(uri)`, and `NotebookEdit`s in `applyEdit` (insert,
delete, replace cells, cell and notebook metadata). VS Code's "jupyter-notebook" is the IDE's
Jupyter type, so a controller for it runs .ipynb cells. Extension webviews are served on
`localhost`, previews on `127.0.0.1`: their cookies stay apart.

D267: `workspace.openNotebookDocument(type, data)` opens an untitled notebook (in a tab: the
IDE has no hidden documents; saving it asks where), cells a NotebookEdit inserts keep their
outputs, metadata and execution order, `contributes.productIconThemes` work (Preferences: Product
icon theme…), and on a computer without Node.js the IDE offers to download a pinned Node.js
(24.22.2 from nodejs.org, checked against its SHA-256, kept in its data folder for extensions
only; also Extensions: Download Node.js for extensions).

D295–D297 (VS Code extensions as in VS Code; the audit is `docs/extension-compat-audit.md`):
every VS Code package runs in **one shared Node process**, as in VS Code, so another extension's
`exports` is the live object its `activate` returned (synchronous calls, getters, events,
`instanceof`). Each package still has its own `vscode` module and its requests are still checked
per extension; the IDE's own-format extensions keep a process each. The process runs in
the IDE's host folder, not the extension's (VS Code's extension host doesn't run in an
extension's folder either): spawn programs by `context.extensionPath`-based paths. Disabling,
updating or uninstalling one extension unloads it there (its `deactivate`, its modules, its
timers); one that loaded native addons (`.node` files) can't be unloaded, so the process
restarts and the others start again, as VS Code restarts its extension host. A crash restarts
them too, at most 3 times in 5 minutes. Activation follows VS Code's: `*` and startup ones in the
background, `extensionDependencies` first, a failed `activate` keeps what it registered and isn't
retried. Language providers have no time limits (VS Code's cancellation instead), completions
are uncapped with `isIncomplete` and `resolveCompletionItem`; quick picks and input boxes are live
(`createQuickPick` items filled while open, `busy`, item buttons, typed text accepted);
`window.tabGroups` is real; terminals report their close, exit status, shell integration and
command executions; Format document with… lists every formatter (`editor.defaultFormatter`
per language). A grammar's `embeddedLanguages` and `tokenTypes` apply, and injection grammars
join grammars in use without a restart. Webview panels come back after a restart
(`registerWebviewPanelSerializer`, the page's `setState` kept per folder) and their
`localResourceRoots` are served; terminals the user opened are listed and
`TerminalShellExecution.read()` gives a command's output. Notebooks whose kernel is a VS Code
controller get one output page with the packages' `notebookPreload` scripts and controller
messaging (Jupyter's widgets), one TextDocument per cell, the extension's diagnostics in cells,
`rendererScripts`, VS Code's notebook context keys and a basic Interactive Window (no input box
yet). Its keybindings see VS Code's editor context keys (`editorTextFocus`, `editorLangId`…).

D419 (custom editors, from a game editor built as a VS Code extension): the context key
`activeCustomEditorId` is the view type of the custom editor in the active tab ("" elsewhere), so
keybindings and `editor/title` buttons that test it work, and a custom editor's tabs show
`editor/title` buttons at all (they were the text editor's only). `vscode.openWith(uri, viewType,
column)` opens the text editor for `"default"` and the named custom editor otherwise, and it and
`vscode.open` honor `ViewColumn.Beside`. A custom editor's `WebviewPanel.active` / `visible`
follow its tab and `onDidChangeViewState` fires. A custom *text* editor keeps its document's
earlier texts (100): the `undo` / `redo` commands, which its page's buttons and keys run, put
them back while its tab is the active one (its file has no text editor tab for the IDE's undo;
each edit is written to the file). `contributes.jsonValidation` gives the JSON files its
`fileMatch` names validation, completion and hovers from a schema file of the extension (a
schema behind a web address is skipped: nothing is loaded from the network); the IDE's own
format takes the same contribution.

D386: once an extension starts stopping (before its `deactivate()` runs: disabled, updated, a
host restart, a folder switch), `window.showInformationMessage` / `Warning` / `Error` show
nothing and resolve to `undefined`; the text goes to its log ("(while stopping, not shown)").
VS Code drops them too, since its extension host is going away.

D388: a terminal made with `hideFromUser: true` runs with no tab until the extension calls
`show()` (terminal tools still reach it by id); it, and one made with `isTransient`, isn't saved
with the folder, so it doesn't come back after a restart.

**API surface (checked against VS Code 1.106's `vscode.d.ts`).** Every stable namespace member
and every stable class and enum is there (`new vscode.X` and `vscode.X.Member` never read
`undefined`), plus the proposed names installed extensions use (ports, debug visualizations,
verbose hovers, notebook variables, test results, timeline, MCP). What can't really work in the
IDE is a well-behaved stub (a registration returns a Disposable, an event never fires, a result is
empty, as VS Code gives when nothing answers):

- `window.state` is always focused; `onDidChangeTextEditorViewColumn`, `onDidWriteTerminalData`
  and `onDidExecuteTerminalCommand` never fire. `window.activeColorTheme` is the IDE's theme's
  kind (Light or Dark: a high-contrast theme is one of them) and `onDidChangeActiveColorTheme`
  fires when it changes (the worker API's `env.themeKind` and "theme.didChange" event).
- `workspace.onWillCreateFiles` / `onWillDeleteFiles` / `onWillRenameFiles` never fire (the
  Explorer has no hook before its file operations); the `onDid…` ones do.
- `onWillSaveNotebookDocument` never fires; `registerTimelineProvider` and
  `registerPortAttributesProvider` register nothing.
- `languages.registerDocumentDropEditProvider` / `registerDocumentPasteEditProvider`,
  `lm.registerLanguageModelChatProvider` / `registerMcpServerDefinitionProvider` and the debug
  visualization providers register nothing; `tests.testResults` is empty.
- `env.asExternalUri` returns the Uri as it is; telemetry is off.

Behaviors to know: `workspace.fs` reaches the extension's own `registerFileSystemProvider`
schemes too (a file it has no copy for is read and written through it; a missing write, delete
or rename is refused as a read-only file system); a `SnippetTextEdit` in a `WorkspaceEdit` applies
as its plain text (tab stops dropped, placeholders kept); the same listener added twice to an
event is two subscriptions; every event takes VS Code's `disposables` array; a change event never
splits a surrogate pair; ranges given to providers are within the document; a Memento value with
functions in it is kept as JSON keeps it; an answer the extension returns that can't be sent (a
cycle) fails the call instead of leaving the IDE waiting.

VS Code's language commands (`vscode.executeDefinitionProvider`, `…TypeDefinition…`,
`…Declaration…`, `…Implementation…`, `…Reference…`, `…Hover…`, `executeDocumentHighlights`,
`…DocumentSymbol…`, `…WorkspaceSymbol…`, `…CodeAction…`, `…CodeLens…`, `…CompletionItem…`,
`…SignatureHelp…`, `…FormatDocument…` / `…FormatRange…` / `…FormatOnType…`, `…FoldingRange…`,
`…Link…`, `…InlayHint…`, `…DocumentColor…`, `…SelectionRange…`, `vscode.prepareRename`,
`…DocumentRename…`) ask every provider the editor has for the document, as VS Code does: its
language servers, its own language services, every extension's (this one's too); the answers are
VS Code's classes (`Location` or a LocationLink, `DocumentSymbol`s that are also
`SymbolInformation`, `Hover`, `CodeAction`, `CompletionList`…). Workspace symbols come from the
IDE's symbol search (language servers, extensions' providers, declarations in files). They need
"fs.read" and a document in the folder (or one open in the editor); a file that isn't open is
read for the question. A command on an answer (a code lens's, a code action's) is there for its
title: it belongs to another provider and can't be run from the extension. No answer is `[]`
(D261), `undefined` for signature help and rename. Call and type hierarchies, semantic tokens,
inline values and color presentations answer as VS Code does with no provider. `cursorMove` and
`editorScroll` run in the active editor with VS Code's arguments.

Not yet (each logged once in its log, and listed at `ide://ext/<id>/vscode`): a few rarely used
calls (`editorScroll` by half pages when the editor refuses `editorScroll` itself).

**The IDE's own API gained** (D257): `"codePage": true` on a `"type": "webview"` view or a viewer
(its code writes the page with `ide.ui.webview(id).setHtml(html)`; a viewer's tabs are told
`{ ide: "viewerOpened", path, instance }` and messages carry `instance`), and the system's file
dialogs, `ide.ui.showOpenDialog({ folders, many, filters })` and `ide.ui.showSaveDialog()`.
D258: a tree row's `iconPath` / `iconPathDark` (files of the extension), a tree handle's
`reveal(path, { select, focus, expand })` and `onDidChangeSelection`,
`ide.ui.registerFileDecorationProvider`, `ide.languages.setLanguageConfiguration`,
`ide.debug.registerDebugAdapterTrackerFactory`, and `ide.ui.webview(id).setDirty(dirty, instance)`
for a code-page viewer's tab. D295–D296: live quick input, `ide.ui.quickInput.open("pick" | "input",
props, listener)` (send changed props with `update`; the listener hears `value`, `active`,
`selection`, `accept`, `button`, `itemButton` and, once, `hide`), `showQuickPick`'s
`activeIndex`, `showInput`'s `error`; `ide.ui.closeTabs(ids)` (ids from the `tabs.didChange`
event); `ide.ui.watchView(viewId, listener)` (whether a view shows); a tree handle's
`onDidChangeExpansion` and `setBadge`; a status bar item's `name` and `tone` ("warning",
"error", or "-text" for the text alone); `ide.terminals.create({ background, onEvent })` (the
terminal's `started`, `closed` with VS Code's exit reason, `active`, `interacted`, shell
integration and command start / end), and since D388 `hidden` and `transient`; a task's
`shell: { executable, args }`; a webview
panel's `viewColumn`; notebook kernel sources with `messaging` (`message` on the kernel,
`ide.notebooks.postKernelMessage`); and the debugger and language additions above. The types
are in `src/api/index.d.ts`.

## Webview panels

The theme message carries the IDE's design tokens (`--bg-*`, `--fg-*`, `--border-*`, `--accent*`,
`--font-*`, `--text-xs` to `--text-lg`, `--radius-sm/md`, `--shadow-1/2`, and `--label-1` to
`--label-6` for user-chosen colors), so a page can look native with `var(--bg-surface-raised)`
and the like. The bundled Canvas extension (`src-tauri/bundled-extensions/canvas`) is a complete
file viewer to learn from.

A `"type": "webview"` view shows an HTML file of the extension, served from its own local origin
with a Content-Security-Policy that only allows the extension's own files (no network, no inline
frames). The page talks to the extension's code by messages:

```js
// In the page
const NS = "ide-webview";
const post = (message) => parent.postMessage({ ns: NS, message }, "*");
addEventListener("message", (e) => {
  if (e.data?.ns !== NS) return;
  if (e.data.theme) {                // the IDE's colors, on load and when the theme changes
    for (const [k, v] of Object.entries(e.data.theme.vars)) document.documentElement.style.setProperty(k, v);
    return;
  }
  handle(e.data.message);
});
```

```js
// In main.js
const panel = ide.ui.webview("todo.board");
panel.onMessage((m) => …);
panel.postMessage({ items });       // queued until the page has loaded
panel.reveal();
panel.openInWindow({ width: 900, height: 700 });   // a panel or editor page, in its own window
```

### Panels made at run time

`ide.ui.createWebviewPanel` (VS Code's `window.createWebviewPanel`) opens a page your code writes,
in a tab of its own: a preview, a report, a REST response. No manifest entry is needed.

```js
const panel = ide.ui.createWebviewPanel("acme.preview", "Preview", "beside");   // or -2, "bottom", { viewColumn, preserveFocus }
panel.webview.html = `<link rel="stylesheet" href="${panel.webview.asWebviewUri("media/page.css")}">
  <h1>Hello</h1><script src="media/page.js"></script>`;
panel.webview.onDidReceiveMessage((m) => …);       // the page posts as above
await panel.webview.postMessage({ items });        // false once it's closed
panel.title = "Preview: a.md";                     // the tab follows; iconPath takes an icon name
panel.onDidChangeViewState(({ webviewPanel }) => webviewPanel.visible);   // .active: its group has the focus
panel.onDidDispose(() => …);                        // the user closed it, or panel.dispose()
panel.reveal();
```

The page is served from your folder's origin with the same Content-Security-Policy and theme message
as a declared view, so relative URLs (`media/page.js`) load your files; `asWebviewUri` turns a path
of your folder into that form and `cspSource` is `'self'` for a page's own CSP meta tag. Setting
`html` loads the page again (messages sent meanwhile wait for it); changes made in one turn go
together. `enableScripts` and `retainContextWhenHidden` are accepted: scripts always run and a
hidden tab keeps its page. At most 50 panels; they close when your extension stops and don't come
back after a restart. `ide://extensions/providers` lists them.

### File viewers

A viewer's page is a webview page that gets the file it opens:

```js
// In viewer.html
addEventListener("message", (e) => {
  if (e.data?.ns !== "ide-webview") return;
  if (e.data.file) render(e.data.file.text ?? e.data.file.error);   // { path, name, text, canSave }; again on change
  if ("saved" in e.data) showSaved(e.data.saved, e.data.error);
});
const save = (text) => parent.postMessage({ ns: "ide-webview", save: text }, "*");   // fs.write
```

Reading the file the user opened in the viewer needs no permission; saving needs `fs.write`.
Files reach the page in order (a slower read never lands after a newer one). main.js also hears
from the IDE when a viewer's tab opens and closes: `{ ide: "viewerOpened", path }` and
`{ ide: "viewerClosed", path }` (a page reloads when its tab moves to another window, and its
own last messages may not make it out).
Messages to and from main.js use the viewer's id (`ide.ui.webview("todo.viewer")`, postMessage
and onMessage only: the user opens a viewer on a file).

## Notebooks (D202, D204)

The IDE has one notebook editor (cells, outputs, the run queue, Variables, widgets, find, the
outline, the cell-by-cell diff), as VS Code does, and reads Jupyter's `.ipynb` itself (D204, like
VS Code's built-in ipynb support): a notebook opens, edits and saves with no extension. What an
extension brings is a **file format**, **kernels**, **output renderers** and **buttons**. The
built-in Jupyter extension (`bundled.jupyter`, off until turned on) is one such extension: a
kernel source for Jupyter notebooks, built on this API.

### Building a notebook extension

A Deepnote-, Databricks-, Kestra- or Jupyter-server-style extension usually needs some of:

| Need | Use |
| --- | --- |
| Open your own files as notebooks (`.deepnote`, `.dib`, `.nb.py`) | `contributes.notebooks` + `ide.notebooks.registerSerializer` |
| Run Jupyter notebooks (or yours) on your runtime (a cluster, a remote server) | `ide.notebooks.registerKernelSource` (`notebookTypes: ["jupyter.notebook"]`) |
| "Connect to…" rows in the kernel picker | the kernel source's `actions`, or `menus` `notebook/kernelSource` |
| Draw your own output types (charts, tables, maps) | `contributes.notebookRenderers` + `ide.notebooks.createRendererMessaging` |
| Buttons on the notebook's toolbar or a cell's toolbar / "…" menu | `menus` `notebook/toolbar`, `notebook/cell/title` |
| Something in a cell's status row ("Ran on cluster x") | `ide.notebooks.registerCellStatusBarItemProvider` ("fs.read": it's told the cells' text) |
| Follow notebooks (opened, edited, saved, a cell ran) | `ide.events.on("notebook.didOpen" …)` ("fs.read") |
| Read and change cells and metadata | `notebook.read`, `notebook.editCell`, `notebook.insertCell`, `notebook.setMetadata` … through `ide.commands.execute` |

```json
"contributes": {
  "notebooks": [{ "type": "acme.book.notebook", "displayName": "Acme book", "extensions": [".acmenb"], "default": true }],
  "notebookRenderers": [{ "id": "acme.book.chart", "displayName": "Acme charts", "entrypoint": "renderer.js", "mimeTypes": ["application/vnd.acme.chart+json"] }],
  "commands": [{ "id": "acme.book.deploy", "title": "Deploy this notebook" }, { "id": "acme.book.explain", "title": "Explain this cell" }],
  "menus": {
    "notebook/toolbar": [{ "command": "acme.book.deploy", "icon": "cloud-upload", "when": "notebookType == acme.book.notebook" }],
    "notebook/cell/title": [{ "command": "acme.book.explain", "when": "notebookCellType == code" }]
  }
}
```

```js
// main.js: the format (needed for each contributes.notebooks type).
ide.notebooks.registerSerializer("acme.book.notebook", {
  deserialize: (text) => ({ cells: text.split("\n%%\n").map((source) => ({ kind: "code", source })) }),
  serialize: (nb) => nb.cells.map((c) => c.source).join("\n%%\n"),
});

// Kernels: listed in the kernel picker of the notebook types they name (default: every type,
// so a kernel source can run the IDE's own Jupyter notebooks too, e.g. on a remote server).
ide.notebooks.registerKernelSource({
  id: "calc",
  label: "Calculator",
  notebookTypes: ["acme.book.notebook"],
  find: (context) => [{ id: "calc", label: "Calculator", detail: "in the extension", languages: ["python", "sql"] }],
  // Rows under the kernels in the picker; run() asks what it needs and returns a kernel.
  actions: [{
    id: "server",
    label: "Existing server…",
    run: async () => {
      const url = await ide.ui.showInput({ prompt: "Server address" });
      return url ? { id: url, label: "Server", detail: url, data: { url } } : undefined;
    },
  }],
  start(option, context, host) {
    host.setStatus("idle");
    return {
      async execute(code, run) {
        // run.cell: { id, index, language, metadata } of the cell that runs.
        run.emit({ type: "stream", name: "stdout", text: "working\n" });
        run.emit({ type: "display", data: { "application/vnd.acme.chart+json": { points: [1, 2, 3] } } });
        return { status: "ok" };
      },
      // optional: interrupt, restart, shutdown, complete, inspect, variables, comm
    };
  },
});

// Its status row items, for every cell of a type ("*": every notebook).
ide.notebooks.registerCellStatusBarItemProvider("acme.book.notebook", ({ cell }) =>
  cell.kind === "code" ? [{ text: "on cluster a", command: "acme.book.deploy", alignment: "right" }] : [],
);

// Talking with the renderer's frames.
const charts = ide.notebooks.createRendererMessaging("acme.book.chart");
charts.onDidReceiveMessage(({ message, path }) => {
  if (message.clicked) void charts.postMessage({ highlight: message.clicked }, { path });
});
```

```js
// renderer.js: runs inside the notebook's sandboxed output frame, one per output (an ES module,
// or a script setting module.exports; one self-contained file: bundle what it imports).
export function activate(context) {
  return {
    renderOutputItem(item, element) {
      const { points } = item.json(); // also item.text(), item.data() (bytes), item.blob(), item.mime
      element.textContent = points.join(" · ");
      element.onclick = () => context.postMessage({ clicked: points[0] });
      context.onDidReceiveMessage((m) => (element.title = `highlight ${m.highlight}`));
    },
  };
}
```

- **Formats:** `"default": true` opens those files as notebooks (and git diffs of them cell by
  cell); without it the notebook editor is offered in Reopen with… only (no preview button), which
  suits files that are usually text: a `.py` notebook format. `extensions` are file endings: the
  longest one wins, so a type for `.nb.py` takes those files while other `.py` files stay text. A
  file ending belongs to one notebook type: `.ipynb` is the IDE's (`jupyter.notebook`, refused in
  `contributes.notebooks`); extensions run Jupyter notebooks with a kernel source instead.
- **Kernels:** kernel sources exist once the worker has run: an extension whose kernels are for
  other notebook types (Jupyter's) should activate at `onStartupFinished`. A kernel made for a type
  is picked by itself for its notebooks; one that runs every type is listed in the picker (with
  the extension's id) and used only when the user picks it. `languages` lists the languages a
  kernel runs: they come first when the user changes a cell's language (a cell's own language is
  kept in its metadata, `vscode.languageId`, as VS Code does). A cell runs as long as it runs (no
  time limit); Interrupt calls yours; Restart calls yours, or shuts the kernel down and starts it
  again when it has none. `run.emit` streams outputs into the cell as they come; `run.clear()`
  clears them (`{ wait: true }`: when the next output arrives); `run.input` shows an input box
  under the cell and resolves with what the user typed. A kernel that runs a program (a Python, a
  REPL) starts it with `ide.process.spawn` ("shell", in a trusted folder). Cells only run in a
  trusted folder.
- **Outputs:** cells and outputs use Jupyter's nbformat terms (`output_type`, mime bundles), so
  the IDE draws text, HTML, Markdown, images, LaTeX, ANSI colors, Plotly and widgets itself. A
  **renderer** draws its mime types (an output's first mime type a renderer claims; `text/plain`
  is never an extension's) in a frame of the output page's own origin, sandboxed without
  same-origin (it can't reach the IDE). Before its code runs, a content security policy limits the
  frame to the network the extension was allowed: none without `network`, its
  `network:<domain>` hosts, or any https host with `network`. Renderers run only in trusted
  folders (other outputs are drawn as text there). Messages go both ways as JSON (8 MB at most);
  a frame's message starts the extension's worker.
- **Menus:** `notebook/toolbar` buttons run with `{ path }`, `notebook/cell/title` items with
  `{ path, cellId }` (with an `icon`: a button on the cell's toolbar, at most three; without: an
  item of its "…" menu), `notebook/kernelSource` items are picker rows run with `{ path }` (your
  command then picks a kernel with `notebook.selectKernel { path, kernel }`). Their `when` sees
  `notebookType`, and for cells `notebookCellType` (code, markdown, raw) and
  `notebookCellLanguage`.
- **Status items:** at most four per provider and cell, text up to 80 characters; a `command`
  must be one of the extension's own; asked again (300 ms after) when a cell changes, 2 s at most.
- **Events** ("fs.read"): `notebook.didOpen`, `notebook.didChange` (at most every 300 ms, with
  `cells`), `notebook.didSave`, `notebook.didClose` — each with `{ path, notebookType }` — and
  `notebook.didRunCell` (`{ path, notebookType, cellId, status, executionCount }`).
- **Edits and metadata:** the notebook commands agents use work for extensions too, through
  `ide.commands.execute` (`read` effects need "fs.read", `write` ones "fs.write"):
  `notebook.read { path, metadata: true }` (cells with their metadata and language),
  `notebook.insertCell`, `editCell`, `deleteCell`, `moveCell`, `changeCellType`,
  `changeCellLanguage`, `joinCells`, `duplicateCell`, `clearOutputs`, `setMetadata { path,
  metadata, cellId? }` (merges keys, null removes one), `runCell`, `save`. Each is one undo step
  for the user.
- When the extension stops, its kernels stop (an open notebook asks for another), its renderers'
  outputs are drawn as text, its buttons and status items go.
- Not yet (VS Code has them): `notebookPreload` scripts in the IDE's own format (a VS Code
  package's run, D296), a renderer extending another renderer, per-output `disposeOutputItem`,
  and a cancellation token per cell run.

## Making the IDE do something new (for agents)

When the user asks the agent to change or extend the IDE itself, the agent builds an extension:
`extensions.guide` → `extensions.create` (in `<workspace folder>/extensions/<name>`, loaded for
development) → edit its files (it reloads on save) → `extensions.validate` and `extensions.try`,
or check `ide://extensions` and `extensions.showLog` →
`extensions.grantPermissions` if it added permissions. Users may call these mods or plugins: the
IDE calls them extensions. `extensions.installPermanently` makes a finished one available in
every folder.

**Changing an installed extension** (the canvas, say; D189): its files are read-only.
`extensions.copyForDevelopment {id}` copies it into `<workspace folder>/extensions` and loads the copy, which
replaces the installed one while it's loaded (`replaces` in `ide://extensions`); `fork: true`
gives the copy its own id so both run. Change the copy, check it, then
`extensions.installPermanently {id, mode}`: `replace` updates the installed one (raise `version`
first; a bundled extension becomes customized and the IDE's updates skip it until
`extensions.revertToBundled`), `new` installs it beside the original under its own id. Without
`mode` the user is asked.

**Reading what it did (D419).** After every change, before saying it works:

- `ide://extensions?id=<id>`: `status` (`active`, `failed`, `needsPermission`…), `log` (its last
  lines: `console.log` output, errors, refused requests) and `live` (what it registered). A
  folder that didn't load is under `notLoaded` with the reason.
- `extensions.try {id, command, input}` runs one command and returns its result and the log lines
  it wrote.
- A VS Code extension: `ide://ext/<id>/vscode` lists the VS Code calls the IDE doesn't support
  (each logged once) and its webview pages' errors.
- For the user: `extensions.showLog {id}` opens the whole log; the Output tab's Extension host
  channel has every extension's.

**A VS Code extension, from an agent (D419).** Write its folder under
`<workspace folder>/extensions/<name>` (a `package.json` with `publisher`, `name` and `main`) and
load it with `extensions.loadFromWorkspace {folder}`; a folder anywhere else loads with
`extensions.loadUnpacked {folder}`. Either runs it in place and reloads it on every save.
`extensions.installFromFolder {folder}` copies a folder into the installed extensions; run on the
same folder again after a change (raise `version`), it replaces the installed copy. That is how
an extension installed from a folder is updated: nothing watches the folder. These commands ask
the user (changing the IDE, then the extension's permissions), and an agent has to name the
folder. Extensions and MCP clients outside a chat can't run them.

**External agents (D419).** An agent that isn't the IDE's own (Claude Code, Codex… in a chat) has
none of the IDE's prompt. It finds this through `help.agentGuide` (listed among its tools; the
`extensions` topic is a short form of this section) and the MCP server's instructions, and it
runs the same commands as the IDE's agent, with the questions in its chat.

## VS Code extensions

A folder with a VS Code extension's `package.json` (an unpacked `.vsix`, or a theme repository)
can be loaded too. Its color themes (`include` chains and JSON token color files), languages,
JSON TextMate grammars, snippets and problem matchers are used, and its code runs in the Node
host once allowed (see "VS Code extensions (D256, D257)" above; an unpacked one runs in VS
Code's Development mode).

Either format can bring problem matchers for tasks: `contributes.problemMatchers` (each with a
`name`, in VS Code's format) and `contributes.problemPatterns` (a matcher's `pattern` can be
`"$name"`); a task in tasks.json uses them as `"problemMatcher": "$name"` (or as a `base`).
`taskDefinitions` declare task types: a VS Code package's for its code's task provider (D257), an
extension of the IDE's own format's for `ide.tasks.registerTaskProvider` (D233).
Pick a theme with **Preferences: Color theme…** (`ui.selectColorTheme`); `workbench.colorTheme`
keeps the choice.

## Installing from a repository (D185)

**Extensions ⋯ → Install from GitHub…** (`extensions.installFromRepo {repo, ref?, path?}`) takes
`owner/name`, a git URL or a local repository. The IDE clones it shallowly into a scratch folder,
finds the extensions in it (at its top, or one per folder: a catalog), installs the one chosen and
deletes the download. It remembers where it came from: **Update from repository** on the
extension's ⋯ menu fetches it again. **Browse official extensions…** does the same over the
official repository (product.json `extensionsRepo`, or the `extensions.officialRepo` setting).

A repository of extensions can keep each one in its own folder (`hello/extension.json`,
`extensions/hello/extension.json`); nothing else is needed.

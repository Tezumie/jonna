# Editing

The editor is Monaco, the editor inside VS Code, with the same TextMate grammars VS Code uses for
syntax colors. Most of what you know from VS Code works the same way: the keys, multiple cursors,
IntelliSense, language servers, formatting, snippets and the settings names. This page covers
everyday editing, code intelligence and navigation, refactoring and formatting, file formats,
diffs and history, and the AI features you can turn on in the editor.

## Basic editing

Open a file from the Explorer, with Ctrl+P (see [Quick access](02-quick-access.md)) or with
**File → Open file…**. A single click opens a file in a preview tab (italic title) that the next
preview replaces; editing it or double-clicking keeps it (`workbench.editor.enablePreview`).

These keys come from the editor itself, as in VS Code. The **Edit** and **Selection** menus list
most of them, and you can rebind them in the keyboard shortcuts editor (Ctrl+K Ctrl+S).

| Keys | What it does |
|---|---|
| Ctrl+X / Ctrl+C | Cut or copy the selection, or the whole line when nothing is selected |
| Ctrl+/ | Toggle a line comment |
| Shift+Alt+A | Toggle a block comment |
| Alt+Up / Alt+Down | Move the line (or the selected lines) up or down |
| Shift+Alt+Up / Shift+Alt+Down | Copy the line up or down |
| Ctrl+Shift+K | Delete the line |
| Ctrl+Enter / Ctrl+Shift+Enter | Insert a line below / above |
| Ctrl+] / Ctrl+[ | Indent / outdent the line |
| Shift+Alt+Right / Shift+Alt+Left | Expand / shrink the selection (smart select) |
| Ctrl+Shift+\ | Go to the matching bracket |
| Ctrl+G | Go to a line (and `:column`) |
| Ctrl+Z / Ctrl+Y | Undo / redo |

More from the editor's right-click menu: **Cut**, **Copy**, **Paste**, and with text selected
**Copy as Markdown**, which copies the selection as a fenced code block with its language and a
`path:lines` header (handy for issues and chats). **Run selected text in terminal** sends the
selection, or the current line, to the most recent terminal.

**Paste from history** (Ctrl+K Ctrl+V, or **Paste from history…** in the right-click menu) lists
the last 30 texts you copied or cut in the editor, newest first, with what's on the clipboard
from other programs at the top. The selected entry shows below the cursor's line before you
paste it; type to filter, Enter pastes. The list is kept in memory for the window only (what you
copy can include passwords), and **Clear clipboard history** empties it.

File paths in any text are links when the file exists: Ctrl+click `src/a.ts:12:5`,
`"./logo.png"` or `C:\w\a.ts(3,7)` to open it at that spot.

### Multiple cursors

| Keys | What it does |
|---|---|
| Alt+click | Add a cursor (`editor.multiCursorModifier` swaps it with Ctrl+click) |
| Ctrl+Alt+Up / Ctrl+Alt+Down | Add a cursor above / below |
| Ctrl+D | Add the next occurrence of the selection |
| Ctrl+K Ctrl+D | Move the last selection to the next occurrence |
| Ctrl+Shift+L | Select every occurrence of the selection |
| Ctrl+F2 | Change all occurrences of the word |
| Shift+Alt+I | Add a cursor at the end of each selected line |
| Ctrl+U | Undo the last cursor operation |

With several cursors the status bar shows how many selections there are and how many characters
they cover, as VS Code does ("3 selections (40 characters selected)").

### Column selection

Hold Shift+Alt and drag to select a rectangle, or use Ctrl+Shift+Alt with the arrow keys. To make
a plain drag (and Shift+arrows) select columns, turn on **Selection → Column selection mode**
(**Toggle column selection mode**, `editor.columnSelection`). While it's on, the status bar says
**Column selection**; click it to turn the mode off.

### Indentation, whitespace and line display

- Click **Spaces: 4** (or **Tab size**) in the status bar to indent with spaces or tabs, change
  the size, or convert the file's indentation (**Change indentation…**). A file's own indentation
  is detected when it opens.
- **View** has toggles for **Word wrap**, **Minimap**, **Sticky scroll** and **Render
  whitespace** (also commands: **Toggle word wrap** and so on).
- `editor.rulers` draws vertical lines at columns, for example `[80, 120]`.

| Setting | Default | Description |
|---|---|---|
| `editor.fontSize` | `14` | Font size in pixels |
| `editor.fontFamily` | `""` | Editor font; empty uses the IDE's monospace font |
| `editor.fontLigatures` | `false` | Use the font's ligatures |
| `editor.lineHeight` | `0` | Line height; 0 is 1.35 × the font size (1.5 on macOS), as in VS Code |
| `editor.tabSize` | `4` | Spaces per tab (files may override it) |
| `editor.insertSpaces` | `true` | Insert spaces when you press Tab |
| `editor.wordWrap` | `"on"` | Wrap long lines at the editor's width |
| `editor.wrappingIndent` | `"same"` | Indentation of the continuation of wrapped lines |
| `editor.lineNumbers` | `"on"` | `on`, `off` or `relative` |
| `editor.renderWhitespace` | `"selection"` | When to draw whitespace characters |
| `editor.minimap.enabled` | `true` | Show the minimap |
| `editor.cursorStyle` | `"line"` | Cursor shape |
| `editor.mouseWheelZoom` | `false` | Ctrl+mouse wheel changes the font size |
| `editor.scrollBeyondLastLine` | `true` | Scroll past the last line |

## Save files

- **Ctrl+S** saves; **Ctrl+Alt+S** saves all; **File → Save as…** writes the file under a new
  name in the folder.
- **Auto save:** `files.autoSave` is `off` by default; set it to `afterDelay` (with
  `files.autoSaveDelay`, 1000 ms), `onFocusChange` or `onWindowChange`. Untitled editors are never
  auto saved. An auto save leaves the trailing whitespace on the cursors' lines and, after a
  delay, runs no code actions, as in VS Code.
- `files.trimTrailingWhitespace` and `files.insertFinalNewline` (both off) are applied on save, as
  one undoable edit.
- **File → Revert file** (**Reload from disk**) throws away unsaved changes.
- **File → Compare with saved** shows your unsaved changes against the file on disk.

### When a file changes on disk

An open file that something else rewrites reloads by itself when you have no unsaved changes. With
unsaved changes, a banner offers **Reload from disk** or **Keep my changes** (after which the
next save overwrites the file). A save never overwrites text the IDE hasn't seen: if the file
changed and the watcher hasn't reported it yet (a network drive, for example), the save stops and
the banner shows instead.

## Untitled files and hot exit

- **Ctrl+N** (**File → New text file**) opens an untitled editor. Saving it asks where, with a
  name taken from its first line, and the same tab becomes that file. With no folder open, the
  file's folder opens as the workspace first.
- **Hot exit** (`files.hotExit`, `onExit` by default): unsaved changes in files, untitled editors
  and notebooks are kept when the window closes (and after a crash) and come back, unsaved, the
  next time you open the folder. Files over 2 MB, or more than 10 MB in all, aren't kept; closing
  asks about those. Set it to `off` to be asked about every unsaved file.
- Opening a file that doesn't exist yet from the command line (`<cli> notes.md`) opens an
  unsaved editor with that name; saving writes it there without asking (and asks before
  replacing a file that appeared meanwhile). `<cli> --diff left right` compares two files, even
  with no folder open.

## Encodings and line endings

The status bar shows the active file's line endings and encoding. Click them to change them.

- **LF / CRLF** (**Change end of line sequence**) switches the file's line endings.
  `files.eol` sets the line endings of new files (`auto` by default).
- **UTF-8** (**Change file encoding…**) offers **Reopen with encoding…** and **Save with
  encoding…**: UTF-8 with or without BOM, UTF-16 LE / BE, Windows and ISO code pages, Cyrillic,
  Greek, Japanese (Shift JIS, EUC-JP, ISO-2022-JP), Chinese (GBK, GB 18030, Big5) and Korean
  (EUC-KR). Every one can be saved; a character the encoding can't hold stops the save and is
  named.
- A file that isn't valid UTF-8 opens **read-only**, with a **Reopen with encoding…** button
  whose list starts with the encoding guessed from its content. If something rewrites the file as
  UTF-8, it becomes editable by itself.
- The BOM and line endings a file has are kept when you save.

| Setting | Default | Description |
|---|---|---|
| `files.encoding` | `"utf8"` | How files that aren't valid UTF-8 are read and saved (for example `windows-1252` for old Windows text) |
| `files.autoGuessEncoding` | `false` | Guess the encoding of non-UTF-8 files from their content (Japanese, Chinese, Korean, Cyrillic, Greek, Western, UTF-16 without a BOM…); the guess wins over `files.encoding` |
| `files.eol` | `"auto"` | Line endings for new files |

## Language mode and per-language settings

The language of the active file is at the right of the status bar; click it (**Change language
mode…**) to pick another until the file is reopened. To map file names to languages for good,
use `files.associations`. It decides syntax colors, per-language settings and which language
server opens the file. A pattern with a `/` is matched against the path:

```json
{
  "files.associations": { "*.mdx": "markdown", "Dockerfile.*": "dockerfile" }
}
```

Settings can be set per language, as in VS Code. Editor options, tab size, format on save, code
actions on save and the `files.*` settings that act on one file are read for the file's language:

```json
{
  "[python]": { "editor.tabSize": 4, "editor.formatOnSave": true },
  "[markdown]": { "editor.wordWrap": "on" }
}
```

Languages that extensions add get comment toggling, bracket matching and auto-closing from their
`language-configuration.json`.

## IntelliSense

Suggestions appear as you type: words in the file, snippets, and what the language service or
language server knows. Press **Ctrl+Space** to ask for them, **Ctrl+Shift+Space** for the
parameters of the call you're in, and **Ctrl+K Ctrl+I** to show the hover at the cursor.

- JSON, CSS, SCSS, Less and HTML work out of the box, and so do TypeScript and JavaScript for the
  files you have open. `settings.json` and `keybindings.json` are checked against their schemas.
- Everything else, and TypeScript across a whole project, comes from language servers (next
  section).

| Setting | Default | Description |
|---|---|---|
| `editor.quickSuggestions` | `true` | Show suggestions as you type |
| `editor.suggestOnTriggerCharacters` | `true` | Show suggestions after characters like `.` |
| `editor.acceptSuggestionOnEnter` | `"on"` | Enter accepts a suggestion (`on`, `smart`, `off`) |
| `editor.tabCompletion` | `"off"` | Tab completes words and snippets |
| `editor.parameterHints.enabled` | `true` | Parameter info while typing a call |
| `editor.hover.enabled` | `true` | Show hovers (`editor.hover.delay`: 300 ms) |
| `editor.inlayHints.enabled` | `"on"` | Inline type and parameter hints |
| `editor.codeLens` | `true` | Show code lenses |
| `editor.semanticHighlighting.enabled` | `true` | Color code with the language server's semantic tokens |

## Language servers

A language server gives a language completions, hovers, go to definition, references, rename,
problems, quick fixes and refactorings, code lenses, inlay hints, semantic colors, document
colors, folding and smart selection. The IDE knows 17 servers. Nothing runs until you open a file
of that language.

| Server | Languages | Installed with |
|---|---|---|
| TypeScript (typescript-language-server) | TypeScript, JavaScript, TSX, JSX | npm |
| Pyright | Python | npm or pip |
| rust-analyzer | Rust | rustup (brew on macOS) |
| gopls | Go | go |
| clangd | C and C++ | winget (Windows), brew (macOS) |
| C# (csharp-ls) | C# (needs the .NET SDK) | dotnet |
| Eclipse JDT (Java) | Java (needs a JDK 21+) | brew (macOS, Linux) |
| Intelephense | PHP | npm |
| Ruby LSP | Ruby | gem |
| Lua | Lua | winget (Windows), brew (macOS, Linux) |
| Bash | Bash and sh | npm |
| YAML | YAML (schemas from SchemaStore) | npm |
| Taplo (TOML) | TOML | npm |
| Dockerfile | Dockerfile | npm |
| Svelte | Svelte | npm |
| ZLS (Zig) | Zig | winget (Windows), brew (macOS, Linux) |
| Kotlin | Kotlin (needs a JDK) | brew (macOS, Linux) |

### Install a server

The first time you open a file whose server isn't installed, a notification offers **Install**
or **Don't ask again** (`lsp.offerInstall`, `lsp.dontOfferInstall`). Install runs the first
package manager from the list above that's on your PATH, in a terminal you can watch, then starts
the server. On Windows the IDE reads PATH again after the install, so you don't need to restart.
You can also run **Install a language server…** from the Command Palette.

For TypeScript and JavaScript the offer is typescript-language-server, which sees the **whole
project**: `tsconfig.json`, imports, and F12 into files you haven't opened. While it runs, the
editor's own TypeScript service is turned off for those languages, so there's one source of
completions and problems.

### The server's status

The status bar shows the active file's server: running, starting (with what it reports, such as
"indexing"), **Install …** when it's missing, or failed. Click it to install the server, or to
pick **Show log**, **Settings…** or **Restart**. A server that crashes is started again after a
second, at most four times in three minutes; after that it stays failed and says so.

| Command | What it does |
|---|---|
| **List language servers** | The configured servers and their state |
| **Install a language server…** | Install a server with your package manager |
| **Restart language server** | Restart a running server |
| **Stop language server** | Stop a server |
| **Show language server log** | Open a server's log |
| **Language server settings** | Open the settings page of a server |
| **Select Python interpreter…** | Pick the Python that Pyright uses |

### Server settings

**Language server settings** (from the Command Palette, or the status bar item → **Settings…**)
shows the main settings of twelve common servers (Pyright, rust-analyzer, gopls, TypeScript,
clangd, YAML, Lua, Intelephense, Bash, Taplo, Ruby LSP and ZLS) as switches and lists, and any
server's `settings` and `initializationOptions` as JSON. A settings change reaches the running
server at once; a change to its initialization options restarts it.

[Open language server settings](command:lsp.openServerSettings)

### Add or change a server

Servers are configured in `lsp.servers`, in your user settings (not a folder's). Use a built-in
name to change that server, `{ "enabled": false }` to turn it off, or a new name to add a server.
`${workspaceFolder}` expands in `args`, and a relative `command` such as
`./node_modules/.bin/x` is looked up in the folder.

```json
{
  "lsp.servers": {
    "pyright": { "enabled": false },
    "pylsp": { "command": "pylsp", "languages": ["python"] },
    "clangd": { "args": ["--background-index"] }
  }
}
```

`lsp.enabled` (on) turns language servers off altogether.

### Python environments

In a trusted folder, Pyright uses the folder's virtual environment (`.venv`, `venv` or `env`) so
that its packages resolve. Click **Python** in the status bar (or run **Select Python
interpreter…**) to pick another; `python.defaultInterpreterPath` keeps the choice. In a workspace
with several folders, each folder's interpreter is used for its files.

### Problems in files you haven't opened

Servers that check the whole workspace (Pyright with `python.analysis.diagnosticMode` set to
`"workspace"`, for example) list problems of files you haven't opened in **Problems**. They're
asked again every couple of seconds, so problems from a build or another tool appear without
editing. Closing a file closes it for its server too; whatever the server still reports for it
stays in Problems.

## Code navigation

Right-click a symbol, or use the **Go** menu:

| Command | Keys | What it does |
|---|---|---|
| **Go to definition** | F12 | Open the definition |
| **Go to type definition** | | Open the definition of the symbol's type |
| **Go to implementations** | Ctrl+F12 | Open the implementations (a list when there are several) |
| **Go to references** | Shift+F12 | List the references |
| **Peek definition** | Alt+F12 | Show the definition inline, without leaving the file |
| **Peek implementations** | Ctrl+Shift+F12 | Show the implementations inline |
| **Go to symbol in editor…** | Ctrl+Shift+O | Jump to a symbol in the file |
| **Go to symbol in workspace…** | Ctrl+T | Jump to a symbol anywhere in the folder |
| **Go to bracket** | Ctrl+Shift+\ | Jump to the matching bracket |
| **Next problem** / **Previous problem** | F8 / Shift+F8 | Move through errors and warnings |

The right-click menu's **Peek** submenu also has **Peek references** and **Peek type
definition**. Ctrl+click a symbol goes to its definition too.

### Go back and forward

**Go back** (Alt+Left) and **Go forward** (Alt+Right; Ctrl+- and Ctrl+Shift+- on macOS) step
through the places your cursor was, across files, like a browser's back button. The mouse's back and forward buttons do the same, and
so do the ← → buttons beside the title bar's search box. `workbench.navigationControl.location`
moves those buttons to the start of each tab strip; `workbench.navigationControl.enabled` hides
them. **Clear editor history** empties the list. Each file also remembers its scroll position and
cursor, so it opens where you left it.

### Breadcrumbs, Outline and sticky scroll

- **Breadcrumbs** above the editor show the file's folders and the symbols around the cursor.
  Click a segment to open a searchable list of its siblings (`breadcrumbs.enabled`).
- **Outline** is a collapsed section at the bottom of the Explorer with the file's symbols. Its
  **…** menu sorts them by position, name or kind (`outline.sortOrder`) and turns **Follow
  cursor** on or off (`outline.followCursor`). Right-click a symbol to go to it, select it, or
  copy its name or path. Markdown files list their headings; languages without a language service
  list declarations found line by line.
- **Sticky scroll** keeps the enclosing function and class names pinned at the top while you
  scroll (`editor.stickyScroll.enabled`, up to `editor.stickyScroll.maxLineCount` lines).
- Under each editor, a small status bar shows the file's errors and warnings (click for a
  **Problems in this file** list), **Diff**, the line and column, and the language
  (`editor.fileStatusBar.enabled`).

### Call and type hierarchy

**Show call hierarchy** (Shift+Alt+H, or right-click a function) and **Show type hierarchy**
(right-click a type) open a tab with a tree that loads one level at a time. Both appear when the
file's language server offers them.

- The tab's toolbar switches direction (callers ↔ calls, supertypes ↔ subtypes) and refreshes.
- Click a row to open the call site, or the type.
- Right-click a row to show the hierarchy of that item, go to its definition, copy its path or
  refresh.
- After you edit or save a file in the tree, a "Results may be outdated." bar offers
  **Refresh**; the tree isn't rebuilt under you.

### Bookmarks

Bookmarks mark lines you want to come back to. They follow edits and renames and are kept per
workspace; they sit in the gutter beside breakpoints.

| Command | Keys |
|---|---|
| **Toggle bookmark** | Ctrl+Alt+K |
| **Toggle labeled bookmark…** | |
| **Next bookmark** / **Previous bookmark** | Ctrl+Alt+L / Ctrl+Alt+J |
| **List bookmarks…** | Ctrl+Alt+Shift+K |
| **Clear bookmarks in this file** / **Clear bookmarks** | |

## Refactoring

- **Rename symbol** (F2) renames across files, closed ones included, when a language server or
  language service knows the symbol.
- **Change all occurrences** (Ctrl+F2) edits every occurrence of the word in the file at once.
- The **lightbulb**, or **Ctrl+.**, offers the quick fixes and refactorings for the cursor's spot.
  **Refactor…** (Ctrl+Shift+R) and **Source action…** (organize imports, fix all…) are in the
  right-click menu.
- **Linked editing** (`editor.linkedEditing`, off) renames the matching HTML or XML tag as you
  edit one.
- Renaming or moving a JavaScript or TypeScript file in the Explorer asks to **update the
  imports** that point at it (`editor.updateImportsOnFileMove`: `prompt`, `always`, `never`).
  Undo reverts both.

## Problems and inline diagnostics

- **Problems** (Ctrl+Shift+M, **View → Problems**) lists the language services' and servers'
  problems, plus what a task's problem matcher found in any file. Right-click a problem to copy
  it or send it to the agent (**Fix problems with agent**).
- Errors and warnings are also written at the end of their line, like the Error Lens extension.
  `editor.inlineDiagnostics` chooses which (`off`, `errors`, `errorsAndWarnings`, `all`).
- Files with problems, and the folders holding them, are colored with their count in the
  Explorer and on tabs (`problems.decorations.enabled`).

## Formatting

**Format document** (Shift+Alt+F) and **Format selection** (Ctrl+K Ctrl+F) use your project's own
formatter when it has one, found from the file up to the folder, so nested packages use theirs:

- Biome (with `biome.json`) or Prettier, from `node_modules/.bin`;
- Ruff or Black, configured in `pyproject.toml` (or `ruff.toml`);
- rustfmt in a Cargo project, gofmt, clang-format with a `.clang-format`.

Otherwise the language service or language server formats. Project formatters run only in
trusted folders; turn them off with `editor.projectFormatters`. If the project's formatter fails,
the error is shown instead of formatting in a different style.

### Format on save and code actions on save

```json
{
  "editor.formatOnSave": true,
  "editor.formatOnSaveMode": "modificationsIfAvailable",
  "editor.codeActionsOnSave": {
    "source.organizeImports": "explicit",
    "source.fixAll": "explicit"
  }
}
```

| Setting | Default | Description |
|---|---|---|
| `editor.formatOnSave` | `false` | Format the file when saving |
| `editor.formatOnSaveMode` | `"file"` | `file`: the whole file; `modifications`: only the lines changed since the last commit; `modificationsIfAvailable`: changed lines, or the whole file when it isn't in git |
| `editor.codeActionsOnSave` | `{}` | Language server actions run before each save: `explicit` on Ctrl+S, `always` with auto save too, `never` off |
| `editor.formatOnPaste` | `false` | Format pasted text |
| `editor.formatOnType` | `false` | Format the line after typing |
| `editor.projectFormatters` | `true` | Use the project's own formatter when it has one |

## Snippets

Snippets appear in suggestions by their prefix. They come from three places, all in VS Code's
format:

- **Your own:** **File → Preferences → Snippets** (**Configure snippets**) opens or creates
  `<language>.json` or `<name>.code-snippets` in your user folder.
- **The project's:** `.code-snippets` files in the project's `.vscode` folder, or in the
  `snippets` folder inside the IDE's own project folder (where the IDE writes new project
  snippets). In a `.code-snippets` file, `scope` names the languages; without it a snippet
  applies everywhere.
- **Extensions'** snippets.

Snippet files reload when you save them.

```json
{
  "Log a value": {
    "scope": "javascript,typescript",
    "prefix": "logv",
    "body": ["console.log('$1', $1);$0"],
    "description": "console.log with a label"
  }
}
```

[Configure snippets](command:editor.configureSnippets)

## Emmet

Emmet expands abbreviations in HTML, CSS (SCSS, Less, Sass), JSX/TSX, Vue, Svelte, PHP and Astro.
Type an abbreviation such as `ul>li*3` or `div.card>ul>li*3` and pick it from the suggestions
(Tab or Enter). `emmet.enabled` turns it off; `emmet.excludeLanguages` turns it off for some
languages, by id (for example `["jsx"]`).

## Folding

Click the arrows in the gutter (shown on hover; `editor.showFoldingControls`) to fold regions.

| Keys | What it does |
|---|---|
| Ctrl+Shift+[ | Fold the region at the cursor |
| Ctrl+Shift+] | Unfold it |
| Ctrl+K Ctrl+0 | Fold all |
| Ctrl+K Ctrl+J | Unfold all |

`editor.folding` turns folding off.

## Brackets and tags

- Brackets are colored by nesting level (`editor.bracketPairColorization.enabled`);
  `editor.guides.bracketPairs` adds vertical guides, and `editor.matchBrackets` highlights the
  matching bracket.
- Typing an opening bracket or quote closes it (`editor.autoClosingBrackets`,
  `editor.autoClosingQuotes`), and typing one with text selected surrounds the selection
  (`editor.autoSurround`).
- Typing the `>` of an opening tag inserts its closing tag in HTML, XML, JSX/TSX, Vue and Svelte
  (`editor.autoClosingTags`).

## Markdown preview

**Ctrl+Shift+V** (or the eye in the tab bar) turns a Markdown, SVG or CSV file into its preview in
the same tab, and back. **Ctrl+K V** opens the preview beside the file; the preview's **Open
source** goes to the file.

- The preview shows your unsaved text as you type and follows the editor's scroll, both ways.
  Double-click a block to jump to its source line. Links to `.md` files open in the preview.
- ` ```mermaid ` blocks are drawn as diagrams (flowcharts, sequence, class, state, Gantt, pie, XY
  charts, mind maps…), and math as `$…$` inline or `$$…$$` and ` ```math ` blocks. A diagram that
  doesn't parse shows its source and the line at fault.
- **HTML in Markdown** works as on GitHub: centered logos (`<p align="center"><img …></p>`),
  images in headings, `<details>` sections (with Markdown inside after a blank line), `<kbd>`,
  `<sub>` / `<sup>` and tables. Scripts, event handlers, styles, frames, forms and SVG are left
  out, and links only open http(s), mailto, anchors and files.
- Images from the folder show, and so do https images from the web unless you turn off
  `markdown.preview.remoteImages`.
- **Find in the preview:** Ctrl+F with the preview focused; Enter / Shift+Enter (or F3 /
  Shift+F3) move between matches; the toggles match case, whole word and regular expressions;
  Escape closes it.
- Fonts: `markdown.preview.fontFamily`, `markdown.preview.fontSize` (14) and
  `markdown.preview.lineHeight` (1.6).

Images, audio and video, fonts, archives and binary files open in viewers of their own. **Reopen
editor with…** switches a file between the text editor and a viewer.

## Diff editor and compare

A diff opens in a tab of its own: your changes against git (see
[Source control](08-git.md)), unsaved changes against the saved file, two files, a local history
version, or an agent's proposal. The right side is editable when it's the file itself.

- **Compare with saved** (**File** menu): your unsaved changes.
- **Compare two files:** right-click one in the Explorer → **Select for compare**, then
  right-click the other → **Compare with …**.
- The **⋯** button in a diff's toolbar switches between side by side and inline, shows or hides
  whitespace changes, and folds long unchanged stretches.
- A diff of several files (a commit's changes, for example) is one scrollable page with a section
  per file. Ctrl+Alt+PageDown / Ctrl+Alt+PageUp go to the next or previous file.
- Notebooks are compared cell by cell (see [Notebooks](15-notebooks.md)).

The colored bars beside the line numbers mark lines changed since the last commit; staged lines
show dimmed. Click a bar to open the file's diff scrolled to that change.

| Setting | Default | Description |
|---|---|---|
| `diffEditor.renderSideBySide` | `true` | Side by side, else inline (a narrow diff goes inline anyway) |
| `diffEditor.ignoreTrimWhitespace` | `true` | Ignore changes of leading and trailing whitespace |
| `diffEditor.hideUnchangedRegions.enabled` | `false` | Fold long stretches of unchanged lines |

## Local history and Timeline

Every time the IDE writes a file (a save, an agent's edit, replace all, a git revert, a restore)
it keeps a copy, along with what was on disk before the first one and after a change made
elsewhere. Up to 50 versions are kept per file; files over 1 MB are skipped.

- The **Timeline** (a collapsed section at the bottom of the Explorer) lists the active file's
  versions and the git commits that changed it, grouped by day. Click one to compare it with the
  file now; right-click to restore a version or copy a commit's hash.
- **Open timeline** (Command Palette) picks a version from a list and opens it as a diff with
  **Restore**. **Restore version from local history** does the restore directly.

Local history is kept for local files only, not for files on a remote machine.

## Undo and redo

- In an editor, Ctrl+Z / Ctrl+Y undo and redo your typing. A file you close keeps its undo
  history (the 20 most recent files, each under 2 MB), so you can reopen it and undo.
- In the Explorer, or with no editor focused, they undo file operations: create, rename, move,
  copy, delete, replace all, and accepted agent edits. Deleted items go to the IDE's trash for 30
  days; **File → Restore deleted files…** brings one back.
- An undo never overwrites: if something is in the way or a file changed since, it says so and
  changes nothing; **Skip it** undoes the step before instead. Undoing something that deletes
  files asks first (`explorer.confirmUndo`).
- Right after a replace all (or a rename that updated imports), Ctrl+Z in one of the changed
  files asks whether to undo it in all files or only this one.

## Vim mode

Turn on Vim key bindings in **Settings → Editor → Vim mode** (`editor.vimMode`) or with **Toggle
Vim mode**. Normal, insert and visual modes, motions, registers, macros and `:` commands work;
`:w` saves, `:q` closes, `:wq` and `:x` save and close. The mode shows at the bottom left of the
editor. It's off by default and applies to full editors, not embedded ones such as notebook
cells.

## Read-only and large files

The lock in the status bar shows whether the active file can be edited; click it to switch the
file between read-only and editable for the rest of the session. The same as commands, as in
VS Code: **Set active editor read-only in session**, **Set active editor writeable in session**,
**Toggle active editor read-only in session** and **Reset active editor read-only in session**
(back to what the settings say). Settings that make files read-only:

- `files.readonlyInclude`: glob patterns of files that open read-only, such as
  `{ "**/generated/**": true }`; `files.readonlyExclude` makes some of them editable again.
- `files.readonlyFromPermissions`: files without write permission on disk open read-only.

Also:

- Files over 50 MB don't open in the text editor.
- A file that isn't valid UTF-8 opens read-only until you pick its encoding (see
  [Encodings and line endings](#encodings-and-line-endings)).
- Text the IDE generates (reports, logs) and staged versions in diffs open read-only.
- Hot exit and local history skip large files (over 2 MB and 1 MB respectively).

### Hide secret values

For screen sharing and streaming, `editor.hideSecrets` covers the values in `.env` files, keys
and certificates (`editor.secretFiles` lists which files) with a gray bar, except on the line
the cursor is on. Keys, comments and empty values stay readable. It's off by default, as in Zed
(VS Code has no such setting). Copying still copies the real text.

## AI in the editor

Outside the agent's chat, AI features in the editor are **off by default**. Turn them on in
**Settings → AI in the editor**, or under **AI features** on Customize → Agents, which also picks
each one's model; their commands, buttons and keys appear only once they're on. For
the agent itself, see [The agent](05-agent.md).

### Edit with AI (Ctrl+K)

With `editor.inlineEdit.enabled` on, select lines and press **Ctrl+K** (or right-click → **Edit
with AI…**), then describe the change. The model's rewrite is shown change by change: each
change's new lines highlighted and the old ones struck through above, with **Accept** /
**Reject** on each. **Ctrl+Enter** accepts the rest and **Esc** undoes it all. Ctrl+K chords
(Ctrl+K Ctrl+O and the others) still work. `editor.inlineEdit.model` picks the model (empty: the
agent's).

### Suggestions as you type

With `editor.inlineCompletions.enabled` on, suggestions appear as gray text after a pause in
typing.

| Keys | What it does |
|---|---|
| Tab | Accept the suggestion |
| Ctrl+Right | Accept the next word |
| Alt+\ | Ask for a suggestion now |
| Esc | Hide it |

- Code models get the code before and after the cursor (fill in the middle: Ollama, Codestral,
  DeepSeek), plus the most similar parts of your other open files, your recent edits and the
  declarations your file imports from the folder's files. When a language server runs for the
  file, it finds where the imported names are declared, so path aliases, packages and Python's
  installed libraries count too. Turn `editor.inlineCompletions.context` off to send only the
  file itself.
- While you type the characters a suggestion shows, the rest of it stays and no new request goes
  to the model; deleting or undoing back to a spot that had a suggestion shows it again.
  **Alt+\\** always asks the model again.
- A small local model is fastest: `ollama pull qwen2.5-coder:1.5b-base`. With the model setting
  empty, a small code model installed in Ollama is picked by itself, else the agent's model.

| Setting | Default | Description |
|---|---|---|
| `editor.inlineCompletions.enabled` | `false` | Suggest code as you type |
| `editor.inlineCompletions.model` | `""` | `provider/model`; empty picks a local code model, else the agent's |
| `editor.inlineCompletions.fim` | `"auto"` | Fill in the middle: `auto` (Ollama, Codestral, DeepSeek), `always`, `never` |
| `editor.inlineCompletions.maxTokens` | `128` | Longest suggestion, in tokens |
| `editor.inlineCompletions.maxLines` | `8` | Most lines a suggestion at the end of a line may have |
| `editor.inlineCompletions.contextTokens` | `1536` | About how many tokens of context each request sends (estimated for the model's tokenizer family) |
| `editor.inlineCompletions.context` | `true` | Include other open files, recent edits and imported declarations |
| `editor.inlineCompletions.debounceMs` | `350` | How long typing must pause before asking, in ms |

> **Note:** every pause in typing asks the model. With a hosted model, the context goes to its
> provider; with a local one it stays on your computer.

### Next edit suggestions

With `editor.nextEdit.enabled` on, after you change something and pause, the model suggests the
edit that should follow, such as the same rename further down. Its lines are tinted, with the new
text in a box below. **Tab** goes there, **Tab** again applies it, **Esc** dismisses it. It never
changes the file by itself. The same change in the same lines gets the same suggestion again
without asking the model; **Suggest the next edit** always asks. `editor.nextEdit.model` picks
the model (empty: the chat's default model; a fast one suits it).

## Next steps

- [Search](09-search.md): find and replace in a file and across the folder.
- [Source control](08-git.md): diffs, staging and change bars.
- [Notebooks](15-notebooks.md): Jupyter notebooks in the editor.
- [Settings, themes and profiles](16-settings-themes.md): every setting on this page, and more.

## Common questions

### Why don't I get completions or go to definition for my language?

Its language server isn't installed or didn't start. Look at the status bar item for the file's
language server: click **Install …**, or open its log to see why it failed. Servers from
`lsp.servers` aren't offered for install.

### Format document uses the wrong style. Why?

When the project has its own formatter (Prettier, Biome, Ruff, Black, rustfmt, gofmt,
clang-format), the IDE uses it, but only in a trusted folder. In a folder you haven't trusted, or
with `editor.projectFormatters` off, the language's own formatter runs.

### My file opened read-only. How do I edit it?

It isn't valid UTF-8. Click **Reopen with encoding…** and pick its encoding, or set
`files.autoGuessEncoding` to have the IDE guess.

### Why doesn't Ctrl+K do anything on its own?

Ctrl+K alone opens Edit with AI, which is off until you turn on `editor.inlineEdit.enabled`.
Ctrl+K chords such as Ctrl+K Ctrl+0 work either way.

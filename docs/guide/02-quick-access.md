# Quick access

Quick access is one box that finds files, commands, symbols, lines and more, as in VS Code. What
you type first decides what it searches: plain text finds files, `>` runs commands, `@` goes to
a symbol, `:` to a line. This page lists every prefix, the keys that open the box in each mode,
and how to open what you find beside the current editor.

## Open quick access

- **Ctrl+P** (or Ctrl+E) opens it for files. [Open quick access](command:quickOpen.show)
- **Ctrl+Shift+P** or **F1** opens it with `>`: the command palette.
  [Show all commands](command:palette.show)
- Click **Search files and commands** in the middle of the title bar.

Typing or deleting a prefix switches modes in place: in the file list, type `>` to see commands;
delete the `>` to go back to files. Type `?` to list the prefixes.

| Prefix | Searches | Keys | Command |
|---|---|---|---|
| (none) | Files in the folder, recently opened first | Ctrl+P, Ctrl+E | **Go: Go to file…** |
| `>` | Commands | Ctrl+Shift+P, F1 | **View: Show all commands** |
| `@` | Symbols in the active editor | Ctrl+Shift+O | **Go: Go to symbol in editor…** |
| `@:` | The same, grouped by kind | | |
| `#` | Symbols in the whole workspace | Ctrl+T | **Go: Go to symbol in workspace…** |
| `:` | A line (and column) in the active editor | Ctrl+G | **Go: Go to line…** |
| `%` | Text in the folder's files | | **Go: Quick search…** |
| `edt ` | Open editors, by group | | **Go: Show all editors…** |
| `view ` | Views and panels | | **Go: Open view…** |
| `task ` | Tasks | | |
| `debug ` | Launch configurations | | |
| `term ` | Terminals | | |
| `?` | What the prefixes do | | |

The word prefixes (`edt `, `view `, `task `, `debug `, `term `) end with a space.

## Go to a file

Press **Ctrl+P** and type part of a file's name or path. Matching is fuzzy: the letters only need
to come in order, so `exvw` finds `explorer/view.ts` and `uscmp` finds `UserComponent.tsx`.

- With nothing typed, the list shows the files you opened recently in this folder (and files from
  elsewhere you opened in this window). As you type, matching recent files stay at the top,
  marked "recently opened".
- **Go to a line:** add `:line` or `:line:column` to the name: `main.ts:42`, `main.ts:42:5`.
- Files your `.gitignore` leaves out (build output, `node_modules`) and the `.git` folder aren't
  listed. Open one from the Explorer or with **File → Open file…**.
- In a [multi-root workspace](20-workspaces.md#multi-root-workspaces), files from every folder
  are listed, each path starting with its folder's name: `api/src/main.ts`.

### Open to the side or in the background

In any list of files (files, `@`, `#`, `%` and `edt `):

| Keys | What it does |
|---|---|
| Enter | Opens the selected file and closes the box |
| Ctrl+Enter | Opens it in the editor group to the side |
| Right arrow, at the end of the text | Opens it in the background; the box stays open, so you can open several |
| Up / Down | Moves through the list |
| Escape | Closes the box |

## Run a command

The **command palette** (Ctrl+Shift+P, F1, or `>` in quick access) lists every command you can
run right now, with its key if it has one. Each command shows its category first:
**View: Toggle zen mode**, **Git: Commit**, **Preferences: Color theme…**.

- **Fuzzy matching:** `tgl sb` finds **View: Toggle sidebar**. Matches at the start of words
  rank first, then letters in a row, then scattered letters.
- **Recently used** commands come first and are marked "recently used"; the list is kept across
  restarts.
- Typing the start of "theme" puts **Color theme…** first.
- A command that needs more from you (a name, a choice) asks for it after you pick it.
- Commands that don't apply at the moment (no editor open, no folder) aren't listed.

Every menu item and button in the IDE is a command, so anything you can click you can also run
from here, or give a key in [Keyboard shortcuts](17-keyboard-shortcuts.md).

## Go to a symbol in the file

Press **Ctrl+Shift+O** (or type `@`) to list the active editor's symbols: functions, classes,
methods, variables, and a Markdown file's headings. Type to filter, Enter to jump.

Type `@:` instead to group them by kind ("classes (2)", "functions (5)"), as VS Code does.

Symbols come from the language's service or language server; for languages without one, the IDE
finds declarations itself. The **Outline** in the Explorer shows the same symbols as a tree
(see [User interface](03-user-interface.md#outline)).

## Go to a symbol in the workspace

Press **Ctrl+T** (or type `#`) and type part of a name to find functions, classes and types
across the whole folder. Results come from running language servers, and also from a search for
declarations, so they work in any folder, even with no language server. Enter opens the file at
the symbol; Ctrl+Enter opens it to the side.

## Go to a line

Press **Ctrl+G** (or type `:`) and type a line number: `:120`. Add a column as `:120:8` (or
`:120,8`). The editor moves there when you press Enter.

## Search text from quick access

Type `%` and some text to search the folder's files without opening the Search view: each row
is a matching line, and Enter opens the file at that line. It uses the search settings'
excludes and smart case, and shows the first 100 matches. For everything else (regular
expressions, replace, include and exclude patterns), use the **Search** view (Ctrl+Shift+F): see
[Search](09-search.md).

## Open a view, run a task, start debugging

- **`view `** lists the side bar's views, then the panels (Terminal, Problems, Debug console,
  Agent, Browser, Settings, Keyboard shortcuts, Documentation), then what extensions open. Pick
  one to show it. **Go: Open view…** opens quick access with `view `.
- **`task `** lists the folder's tasks, with the running ones and the default build and test
  tasks marked; pick one to run it. See [Tasks](12-tasks.md).
- **`debug `** lists the launch configurations, then a configuration for the active file, then
  **Add configuration…**, which opens `launch.json`. Pick one to start it. See
  [Debugging](13-debugging.md).
- **`term `** lists the open terminals with their folders; pick one to show it, or **Create new
  terminal**. See [Terminal](10-terminal.md).

## Switch between open editors

- **Ctrl+Tab** shows the open editors, most recently used first, with the previous one selected:
  hold Ctrl and press Tab to move down the list, then release Ctrl to open the selected one.
  **Ctrl+Shift+Tab** starts from the other end.
- **`edt `** (or **Go: Show all editors…**) lists the open editors grouped by editor group; type
  to filter.
- **Ctrl+PageDown** / **Ctrl+PageUp** go to the next or previous tab in the group.
- **Go → Switch editor** lists the open editors in a menu.

## Recent items

- **Files:** quick access with nothing typed lists the files you opened recently in this folder
  (each folder or workspace keeps its own list).
- **Folders and workspaces:** **File → Open recent** lists the last ten; **More…** (or **File:
  Open recent…** in the palette) searches them all. The Welcome page lists them too, where you
  can pin a folder to the top or remove it. On Windows, right-click the taskbar button for the
  same list (see [Workspaces and trust](20-workspaces.md#the-taskbar-and-dock-menu)).
- **Commands:** the ones you ran recently come first in the command palette.
- **Closed tabs:** **Ctrl+Shift+T** reopens the tab you closed last.

## Commands

| Command | Keys | What it does |
|---|---|---|
| **Go: Go to file…** | Ctrl+P, Ctrl+E | Quick access for files |
| **View: Show all commands** | Ctrl+Shift+P, F1 | Quick access with `>` |
| **Go: Go to symbol in editor…** | Ctrl+Shift+O | Quick access with `@` |
| **Go: Go to symbol in workspace…** | Ctrl+T | Quick access with `#` |
| **Go: Go to line…** | Ctrl+G | Moves the cursor to a line |
| **Go: Quick search…** | | Quick access with `%` |
| **Go: Show all editors…** | | Quick access with `edt ` |
| **Go: Open view…** | | Quick access with `view ` |
| **Go: Switch editor…** | Ctrl+Tab, Ctrl+Shift+Tab | Open editors, most recently used first |

[Go to symbol in workspace](command:quickOpen.goToWorkspaceSymbol) ·
[Quick search](command:quickOpen.quickTextSearch) · [Show all editors](command:quickOpen.showEditors)

## Common questions

### Why isn't my file listed?

Quick access lists the files git would see: files your `.gitignore` leaves out aren't listed,
even outside a git repository. A file created a moment ago shows once the folder's index has
caught up (it follows changes on disk by itself). To find text in ignored files, use the
**Search** view with its ignore files turned off: see [Search](09-search.md).

### How do I see what a key does?

Open **Keyboard shortcuts** (Ctrl+K Ctrl+S) and type the key in quotes (`"ctrl+t"`), or use the
keyboard button there to press it. See [Keyboard shortcuts](17-keyboard-shortcuts.md).

### Can I open quick access with some text already typed?

Yes: the commands above open it with their prefix. Extensions and keybindings can run
`quickOpen.show` with a `query`, such as `{ "query": "view " }`.

## Next steps

- [User interface](03-user-interface.md): tabs, groups and the views.
- [Search](09-search.md): search and replace across files.
- [Keyboard shortcuts](17-keyboard-shortcuts.md): change the keys above.

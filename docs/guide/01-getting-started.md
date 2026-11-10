# Getting started

{{product}} is a code editor with a built-in AI agent. It works like VS Code: the same layout,
the same keys, the same settings names and file formats (`settings.json`, `tasks.json`,
`launch.json`, `.code-workspace`), and it reads a project's `.vscode` folder. This page takes you
from installing the IDE to editing your first files, and points to the pages that go deeper.

> **Note:** keys in this guide are written for Windows and Linux. On macOS, Ctrl is Cmd and Alt
> is Option (Ctrl+P is Cmd+P, Alt+Left is Option+Left) unless a key says otherwise.

## Install

Installers are built for each system:

| System | Installer |
|---|---|
| Windows 10 and 11 | `.exe` (installs for your user, no administrator needed) or `.msi` |
| macOS | `.dmg` (a universal app for Intel and Apple silicon) |
| Linux | `.deb`, `.rpm` or `.AppImage` |

- **Windows** draws the IDE with WebView2, the engine of Microsoft Edge. Windows 11 and an
  up-to-date Windows 10 already have it; if yours doesn't, the installer downloads it, so install
  while you're online.
- **macOS** asks you to approve an app that isn't signed with an Apple Developer ID: open
  **System Settings → Privacy & security** and allow it there.
- **From source:** the repository's README lists what to install (Node.js and Rust) and the
  commands to build and run it.

Installed copies check for updates and ask before installing one: see
[Troubleshooting](21-troubleshooting.md#updates).

## The first start

The first window opens with the **Welcome** page and the agent panel on the right. The Welcome
page has:

- **Open folder**, **Clone repository**, **New file** and **Open file**, each with its key.
- **Coming from VS Code? Import your setup**: brings over your settings, keyboard shortcuts,
  snippets and MCP servers (see [Settings, themes and profiles](16-settings-themes.md)). Its ×
  hides the link for good; **Help → Import from VS Code…** still has it.
- **Recent projects**: the last folders and workspaces you opened, each with buttons to pin it
  to the top or remove it from the list; **View all** lists the rest.

The Welcome page comes back when the last editor closes, and from **Help → Welcome**.

The next time you start the IDE, it reopens the folders you had open, each in its window, with
its tabs and layout (`window.restoreWindows`; see
[Workspaces and trust](20-workspaces.md#restore-windows)).

## The screen at a glance

The window has five parts, as in VS Code:

- **Title bar** (top): the menus (**File**, **Edit**, **Selection**, **View**, **Go**, **Git**,
  **Terminal**, **Help**; in a narrow window they fold into ☰), the folder's name, the search box
  that opens [quick access](02-quick-access.md), the Go back / Go forward arrows, and three
  toggles for the side bar, the bottom panel and the right side.
- **Activity bar** (far left): one icon per side bar view: Explorer, Search, Source control, Run
  and debug, Testing (once tests are found), Extensions and Channels (the agent's chats). A
  number on an icon counts unsaved files (Explorer) or changes (Source control); a spinning mark
  means work is running there. The person icon has your accounts; the gear has settings, themes,
  keyboard shortcuts, snippets and tasks.
- **Side bar**: the view you picked on the activity bar. Ctrl+B shows or hides it.
- **The dock**: everything else. Editors, the terminal, Problems, Output, the browser and the
  agent are all tabs in groups that you can split, move and resize. By default the editors are
  in the middle, a terminal is at the bottom (once a folder is open) and the agent is on the
  right.
- **Status bar** (bottom): the git branch and sync, problems, a running task or debug session,
  and for the active editor its line and column, indentation, encoding, line endings and
  language. Click an item to act on it (switch branch, change the indentation…). The bell on the
  right holds your notifications.

[User interface](03-user-interface.md) covers each part in detail.

### The agent panel

The agent sits on the right (Ctrl+L focuses it). It needs an AI model: a local one through
Ollama (found by itself once installed), a hosted provider you have a key for, or, with nothing
set up, **Start free with OpenCode** in the empty chat. **Customize** (the agent panel's links)
sets up models, agents and their rules. Then type what you want done in the box at the bottom.
Each conversation is a channel or a direct message; the **Channels** view on the activity bar
lists them. [The agent](05-agent.md) explains how it works and what it may do on its own.

## Open a folder

The IDE works on a folder: your project. Its files show in the Explorer, quick access and search
look through it, and its terminals, tasks and git work in it.

- **File → Open folder…** (Ctrl+K Ctrl+O), or **Open folder** on the Welcome page.
  [Open folder](command:workspace.openFolder)
- **File → Open recent** lists the last folders; **Open recent…** searches them all.
- Drop a folder from your file manager onto the window.
- From a terminal, `<cli> .` opens the current folder (once the shell command is installed: see
  [Workspaces and trust](20-workspaces.md#the-command-line)).

When you open a folder for the first time:

- The IDE asks whether you **trust the authors** of its files. A trusted folder may run its
  tasks, debug configurations, tests and git; in restricted mode you can still read and edit
  everything. If you got the project from somewhere you don't know, choose restricted mode.
  [Workspace trust](20-workspaces.md#workspace-trust) explains what changes.
- Its README opens as a preview (`workbench.openReadme`).

A folder that's already open in another window brings that window forward instead of opening
twice. **File → New window** (Ctrl+Shift+N) opens another window. To work on several folders in
one window, see [multi-root workspaces](20-workspaces.md#multi-root-workspaces); for a folder on
another machine or in a container, see [Remote development](19-remote.md).

## Open files

- **Click** a file in the Explorer to open it in a *preview* tab (its title is in italics): the
  next file you click replaces it. **Double-click** it, or start editing, and it stays.
  `workbench.editor.enablePreview` turns previews off.
- **Ctrl+P** finds a file by name: type a few letters of it (`exvw` finds `explorer/view.ts`).
  Add `:42` to go to line 42. See [Quick access](02-quick-access.md).
- **File → Open file…** opens any file on your computer, inside the folder or not.
- Drop files from your file manager onto an editor group to open them there.
- Images, audio and video, fonts, archives and binary files open in viewers; Jupyter notebooks
  open as notebooks.

Tabs work as in VS Code: drag one to the side of the editor area to split it, Ctrl+Tab switches
between recent tabs, Ctrl+W closes one, and Ctrl+Shift+T reopens the last one you closed.

## Create and save files

| Command | Keys | What it does |
|---|---|---|
| **File → New text file** | Ctrl+N | An untitled file; pick its language from the status bar, or save it with a name |
| **File → New file…** | | A file in the folder, named in the Explorer |
| **File → Save** | Ctrl+S | Saves the active file |
| **File → Save as…** | | Saves it under another name |
| **File → Save all** | Ctrl+Alt+S | Saves every unsaved file |
| **File → Revert file** | | Throws away your changes and reloads the file from disk |

A dot on a tab marks unsaved changes, and the Explorer's icon counts unsaved files.

- **Unsaved changes survive closing.** Close the window with unsaved files and they come back,
  still unsaved, the next time the folder opens (`files.hotExit`, as in VS Code). Untitled files
  in a window without a folder come back too.
- **Auto save** is off by default. `files.autoSave` saves after a pause in typing
  (`afterDelay`, with `files.autoSaveDelay`), when the editor loses focus (`onFocusChange`) or
  when the window does (`onWindowChange`).
- If a file changes on disk while you have unsaved edits, the editor says so and lets you keep
  your version or load the one on disk; a save never overwrites changes it hasn't seen.

| Setting | Default | Description |
|---|---|---|
| `files.autoSave` | `off` | Save automatically: `afterDelay`, `onFocusChange`, `onWindowChange` |
| `files.autoSaveDelay` | `1000` | Milliseconds after the last edit before saving (with `afterDelay`) |
| `files.hotExit` | `onExit` | Keep unsaved changes when the window closes; `off` asks instead |
| `workbench.editor.enablePreview` | `true` | Single-click opens a preview tab that the next one replaces |
| `workbench.openReadme` | `true` | Show a folder's README the first time it opens |

## Make it yours

- **Settings** (Ctrl+,): every option has a setting, and the search box finds them.
  [Open settings](command:settings.open)
- **Color theme**: Claude Dark (the default), Dark+ and Light+ (VS Code's), Shiki's themes and
  VS Code themes from extensions. [Pick a color theme](command:ui.selectColorTheme)
- **Keyboard shortcuts** (Ctrl+K Ctrl+S): change any key; VS Code's keys work as they are.
  [Open keyboard shortcuts](command:keybindings.show)
- **Coming from VS Code?** **Help → Import from VS Code…** brings over settings, keyboard
  shortcuts, snippets and MCP servers, and says what each of your extensions becomes here.
  Nothing changes until you press Import. [Import from VS Code](command:settings.showImport)

See [Settings, themes and profiles](16-settings-themes.md) and
[Keyboard shortcuts](17-keyboard-shortcuts.md).

## Keys to learn first

| Keys | What it does |
|---|---|
| Ctrl+Shift+P or F1 | Command palette: every command by name |
| Ctrl+P | Go to a file |
| Ctrl+Shift+F | Search in the folder's files |
| Ctrl+B | Show or hide the side bar |
| Ctrl+J | Show or hide the bottom panel |
| Ctrl+\` | Show the terminal (Ctrl+Shift+\` opens a new one) |
| Ctrl+L | Focus the agent |
| Ctrl+\\ | Split the editor |
| Ctrl+W | Close the tab |
| Alt+Left / Alt+Right | Go back / go forward to where the cursor was |
| Ctrl+, | Settings |

**Help → Keyboard shortcuts reference** shows a printable sheet of the main keys for your
system.

## Where to go next

- [Quick access](02-quick-access.md): find files, commands, symbols and lines from one box.
- [User interface](03-user-interface.md): tabs, groups, panels and the views.
- [Editing](04-editing.md): multiple cursors, code intelligence, formatting.
- [The agent](05-agent.md): ask the AI to read, change and run your code.
- [Source control](08-git.md): stage, commit, branch and push.
- [Terminal](10-terminal.md) and [Debugging](13-debugging.md).

The whole guide is in the IDE: **Help → Documentation**. [Open the documentation](command:help.showDocs)

## Common questions

### Does the IDE send my code anywhere?

Not by itself: there's no telemetry. The agent sends what it reads to the AI provider you chose,
and nothing else calls a model unless you turn that feature on (see [The agent](05-agent.md)).

### Can I use my VS Code extensions?

Many VS Code extensions install from Open VSX, and VS Code themes, icon themes, snippets and
grammars work. See [Extensions](18-extensions.md).

### Where is my old project's `.vscode` folder?

It's read as it is: settings, tasks, launch configurations and snippets in it apply. The IDE
writes its own settings to a folder of its own in the project, and never creates `.vscode`.

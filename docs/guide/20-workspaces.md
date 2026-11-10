# Workspaces and trust

A *workspace* is what a window works on: one folder, or several folders saved together in a
`.code-workspace` file (VS Code's multi-root workspaces). This page covers working with several
folders in one window, workspace trust and restricted mode, the caution before opening risky
folders such as Downloads, and windows: several at once, what comes back when you restart, and
opening files and folders from the command line.

For folders on another machine, in a container or in WSL, see [Remote development](19-remote.md).

## Multi-root workspaces

A project split across folders (an app and its API, a monorepo's packages, a shared library
checked out elsewhere) can open in one window.

### Add a folder

1. Open the first folder (**File → Open folder…**).
2. Choose **File → Add folder to workspace…** and pick another folder.

The window becomes an *untitled workspace* at once, without reloading: your tabs and layout stay.
Add as many folders as you need. To keep the workspace, choose **File → Save workspace as…**: it
gets a name and a `.code-workspace` file, which VS Code reads too.
[Add folder to workspace](command:workspace.addFolder)

You can also drop a folder from your file manager onto a window that has a folder open and choose
**Add to workspace**, or run `<cli> --add <folder>` from a terminal.

### Open a workspace

- **File → Open workspace from file…** opens a `.code-workspace` file.
- **File → Open recent** and the Welcome page list workspaces with your folders, marked
  "(Workspace)".
- `<cli> app.code-workspace` opens one from the command line.

### Work across folders

- **Explorer:** each folder is a top row. Right-click one for **Rename in workspace…** (the name
  shown; the folder on disk keeps its own) or **Remove folder from workspace** (the folder stays
  on disk; its editors close, asking about unsaved ones). A folder row can't be renamed, moved
  or deleted from the Explorer.
- **Paths** are shown with the folder's name first: `api/src/main.ts`.
- **Quick access** lists every folder's files; `#` finds symbols in all of them.
- **Search** groups a folder's results under its name; each folder keeps its own
  `search.exclude`. **Find in folder…** searches one; an include pattern such as `api/**` too.
- **Source control** shows each folder's repository.
- **Tasks and launch configurations:** each folder's own, labelled with the folder's name
  ("build (api)"), plus the workspace file's `tasks` and `launch`. `${workspaceFolder}` is the
  task's own folder; `${workspaceFolder:api}` names one.
- **Terminals** start in the active editor's folder; **New terminal in folder…** picks one.
- **Language servers** get every folder.
- **The agent** works in every folder of the workspace and nowhere else, and reads each folder's
  rules, skills and MCP servers.

### Settings in a multi-root workspace

Settings come in layers, as in VS Code:

| Layer | Where it lives | Applies to |
|---|---|---|
| User | Your own `settings.json` | Every window |
| Workspace | The `.code-workspace` file's `settings` | The whole workspace |
| Folder | The folder's own settings file (and its `.vscode/settings.json`) | That folder's files |

In the settings editor, the **Workspace** tab edits the workspace file's settings and the
**Folder** tab one folder's (pick the folder when there are several). A setting a folder sets
itself is noted on its row. Settings that only make sense for you (such as the programs the IDE
starts) can't be set by a folder.

### The workspace file

A `.code-workspace` file is JSON with comments. Folder paths are relative to the file when the
folder is beside or under it, so a workspace file kept in a repository moves with it:

```json
{
  "folders": [
    { "path": "app" },
    { "path": "../shared-lib", "name": "lib" }
  ],
  "settings": {
    "editor.tabSize": 2
  },
  "tasks": {
    "version": "2.0.0",
    "tasks": [{ "label": "build all", "type": "shell", "command": "npm run build" }]
  },
  "launch": {
    "configurations": []
  }
}
```

- A folder the file lists that isn't there is shown as missing; it stays in the file, and you
  can remove it.
- If the file changes on disk and lists new folders (an edit, a `git pull`), the IDE asks before
  adding them, so a changed file can't widen what the window works on behind your back. Folders on
  another computer (network paths) are asked about too. **File: Reload workspace file** reads it
  again.
- **File → Close workspace** closes it and leaves an empty window.

## Workspace trust

A folder's files can run programs on your computer: its tasks, launch configurations, tests,
git settings and hooks, and the instruction files an agent reads. *Workspace trust* decides
whether they may. As in VS Code, the IDE asks the first time you open a folder you haven't decided
about:

- **Trust folder:** everything works.
- **Stay restricted:** *restricted mode*. You can still browse and edit every file.
- **Trust the authors of all files in the parent folder:** trusts every folder under that parent
  (handy for a projects folder).

### What restricted mode turns off

In restricted mode:

- tasks don't run, including tasks set to run when the folder opens;
- debugging and tests don't start;
- git is off (a repository's own settings can run programs);
- the agents don't load the folder's instruction files (AGENTS.md, CLAUDE.md, rules, skills) or
  its MCP servers, and the folder's agent hooks don't run;
- extensions that run code in Node.js stop until you trust the folder;
- the project's own formatters (Prettier, Biome, Ruff…), terminal profiles and Python
  environment aren't used.

The status bar shows **Restricted mode**; click it to change your mind.

### Change trust

**Workspace: Manage workspace trust** (or the status bar item) asks again. Your decision is kept
per folder. A folder inside a trusted parent is trusted through it, unless it's a risky folder
(below). [Manage workspace trust](command:workspace.manageTrust)

In a multi-root workspace, the workspace is trusted only when every folder is. Trusting it trusts
each folder; adding a folder you haven't trusted asks, with **Trust and add** or **Add
restricted** (restricted, the whole workspace is restricted until you trust it).

| Setting | Default | Description |
|---|---|---|
| `security.workspace.trust.startupPrompt` | `once` | `once`: ask when a folder you haven't decided about opens. `never`: ask only before its first task, debug session or test run |

## Risky folders

Your browser saves files in Downloads without asking, and a downloaded `AGENTS.md`, `CLAUDE.md`
or agent settings file can hold instructions written to trick an AI agent. So before one of
these opens as the workspace, the IDE explains the risk:

- your **Downloads** folder, or any folder inside it (an extracted zip);
- your **home folder**, the **Desktop**, the **temp** folder, or the **root of a drive** (`C:\`,
  `/`), as themselves; projects inside them are ordinary.

The dialog offers **Open in restricted mode** (the default), **Open and trust**, or **Cancel**,
with **Don't ask again for this folder**. It applies however the folder opens: Open folder, the
recent list, the command line, a drop, or a workspace file that lists it.

- A risky folder never takes its trust from a parent: trusting your home folder doesn't trust
  Downloads.
- Even when trusted, the agents don't load MCP server lists from a risky folder, and an agent
  asks before it works in one or touches a file in Downloads.
- **Workspace: Reset risky folder warnings** asks again for the folders you said not to.

| Setting | Default | Description |
|---|---|---|
| `security.warnRiskyFolders` | `true` | Explain the risk and offer restricted mode before a risky folder opens |
| `security.riskyFolders` | `[]` | More folders that count like Downloads (absolute paths), such as where another browser or a mail program saves files |

## Windows

### Several windows

- **File → New window** (Ctrl+Shift+N) opens another window. Each window is its own process.
- Opening a folder that's already open in another window brings that window forward instead of
  opening it twice; this holds for **Open folder…**, **Open recent**, the command line and the
  jump list.
- **File → Close window** closes the window, asking about unsaved files first.

### Restore windows

When the IDE starts without a folder to open, `window.restoreWindows` decides what comes back:

| Value | What comes back |
|---|---|
| `all` (default) | Every window that was open when you quit, each on its folder, where it was on the screen |
| `one` | The last folder, in one window |
| `none` | An empty window |

A window without a folder comes back too when it had unsaved untitled files, with that text still
unsaved (VS Code does the same): closing the last window keeps them without asking. Closing a
window without a folder while others stay open asks about its unsaved files, as VS Code does.

A folder or files given on the command line, and **New window**, open only what they were given.
Each folder's window remembers its own position and size.

## The command line

### Install the shell command

Run **Shell command: Install shell command in PATH** from the command palette. It shows what it
will do and asks first:

- **Windows:** adds a small `.cmd` file to a folder of the app's and puts that folder on your
  *user* PATH (never the system PATH). Open a new terminal afterwards.
- **macOS:** makes a link in `/usr/local/bin`, as VS Code does. macOS asks for your password when
  that folder needs it; if you cancel, the link goes in `~/.local/bin`.
- **Linux:** makes a link in `~/.local/bin`, and says so if that folder isn't on your PATH.

**Shell command: Uninstall shell command from PATH** removes it again.
[Install shell command in PATH](command:workbench.installShellCommand)

### Use it

Below, `<cli>` is the command the shell command installs (run it with `--help` to see its name).

| Command | What it does |
|---|---|
| `<cli> .` | Opens the current folder, or brings forward the window that has it |
| `<cli> app.code-workspace` | Opens a workspace |
| `<cli> src/app.ts:42:5` | Opens a file at a line and column, in the window whose folder holds it |
| `<cli> notes.md` | Opens a file; one that doesn't exist yet (even in folders that don't) opens as a new editor that saves there |
| `<cli> -d a.ts b.ts` | Compares two files side by side (works without a folder open) |
| `<cli> -w file` | Returns only when you close the file's tab |
| `<cli> -a <folder>` | Adds a folder to the last active window's workspace (repeatable) |
| `<cli> -n` | Opens a new window |

| Option | Description |
|---|---|
| `-a`, `--add <folder>` | Add a folder to the last active window (repeatable) |
| `-d`, `--diff <file> <file>` | Compare two files with each other |
| `-g`, `--goto <file:line[:column]>` | Open a file at the line and column, also for files that don't exist yet |
| `-n`, `--new-window` | Open a new window |
| `--remote <ssh:host>` | Open a folder on another machine over SSH (see [Remote development](19-remote.md)) |
| `-w`, `--wait` | Wait for the files to be closed before returning |
| `--disable-extensions` | Run this session without extensions (see [Troubleshooting](21-troubleshooting.md#start-with-extensions-off)) |
| `--user-data-dir <dir>` | Use this folder for settings and state: a separate profile |
| `--verbose` | Stay attached to the terminal |
| `-v`, `--version` | Print the version |
| `-h`, `--help` | Print the help |

Files open in the window whose folder holds them, else in the window you used last; a file
outside the folder opens there too.

**Write commit messages in the IDE:** make it git's editor, and git waits until you close the
message's tab:

```bash
git config --global core.editor "<cli> --wait"
```

> **Note:** on Windows, use the command the shell command installs (the `.cmd` file), not the
> program file itself. PowerShell doesn't wait for a windowed program, so `--help`, `--version`
> and `--wait` would return at once (VS Code's `Code.exe` behaves the same; its `code` command is
> a `.cmd` file too). Plain `<cli>` or `<cli> -n` gives you the prompt back right away.

## The taskbar and Dock menu

- **Windows:** right-click the IDE's taskbar button for **Recent folders** (pinned ones first,
  up to ten) and **New window**. A folder that's already open comes forward. A folder you remove
  from this list leaves the IDE's recent list too.
- **macOS:** right-click the Dock icon for the same recent folders and **New window**.
- **Linux:** the app's launcher has a **New window** action.

## Commands

| Command | Keys | What it does |
|---|---|---|
| **File: Open folder…** | Ctrl+K Ctrl+O | Opens a folder in this window |
| **File: Open recent…** | | Picks a recent folder or workspace |
| **File: New window** | Ctrl+Shift+N | Opens another window |
| **File: Add folder to workspace…** | | Adds a folder to this window |
| **File: Remove folder from workspace…** | | Removes one (it stays on disk) |
| **File: Rename folder in workspace…** | | Changes the name shown for a folder |
| **File: Save workspace as…** | | Saves the workspace as a `.code-workspace` file |
| **File: Open workspace from file…** | | Opens a `.code-workspace` file |
| **File: Reload workspace file** | | Reads the workspace file again |
| **File: Close folder** | | Closes the folder or workspace |
| **File: Pin folder in recent** | | Keeps a folder at the top of the recent list |
| **Workspace: Manage workspace trust** | | Trust or restrict the open folder |
| **Workspace: Reset risky folder warnings** | | Asks again before risky folders open |
| **Shell command: Install shell command in PATH** | | Adds `<cli>` to your PATH |
| **Shell command: Uninstall shell command from PATH** | | Removes it |

## Settings

| Setting | Default | Description |
|---|---|---|
| `window.restoreWindows` | `all` | Which windows come back: `all`, `one` or `none` |
| `security.workspace.trust.startupPrompt` | `once` | When to ask about trusting a folder |
| `security.warnRiskyFolders` | `true` | Warn before a risky folder opens |
| `security.riskyFolders` | `[]` | More folders that count like Downloads |

## Common questions

### Why don't my tasks, tests or git work?

The folder is probably in restricted mode: the status bar says **Restricted mode**. Click it and
trust the folder if you know where it comes from.

### Why was I warned about opening my home folder?

Your home folder holds Downloads and the Desktop, where files land without you choosing them. An
agent working there could read instructions someone else wrote. Open the project folder itself
instead, or choose **Open and trust** if you mean it.

### Does VS Code read my workspace file?

Yes. The IDE reads and writes VS Code's `.code-workspace` format and keeps the file's comments.

### Can a remote window have several folders?

Not yet: a window on another machine or in a container has one folder.

## Next steps

- [Remote development](19-remote.md): SSH, dev containers and WSL.
- [Settings, themes and profiles](16-settings-themes.md): user, workspace and folder settings.
- [Tasks](12-tasks.md) and [Debugging](13-debugging.md): tasks and launch configurations per
  folder.

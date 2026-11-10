# extensions/windows

Windows and the command line (D209). Each IDE window is its own process; Rust keeps a registry
of them (`src-tauri/src/instances`) so a launch can hand work to a running window.

- **Files from the command line**: `<cli> file`, `<cli> file:line[:column]` (`--goto` for a file
  that doesn't exist yet), `<cli> --diff left right`. They go to the window whose folder holds
  the file, else the one used last; a file outside the folder opens as the user's own (D190).
  They're opened once the window has restored its folder (`windowsStartupDone`, called by
  `main.ts`). `--wait` (git's `core.editor = "<cli> --wait"`): the launch returns when every tab
  it opened is closed (`instancesIpc.done`); with no window running it starts one first.
  A file that doesn't exist opens as an untitled editor named after it that saves there without
  asking, in or outside the folder (VS Code; Rust marks it `missing`, `workspace.newUntitledFile
  { path }`). `--diff` works without a folder open (absolute paths). `window.openFromCommandLine
  { files, diff }` does the same from inside.
- **A folder already open in another window** is focused instead of opened twice: `<cli> folder`,
  and the explorer's `workspace.openFolder`, `workspace.openRecent`, `workbench.newWindow`
  (`instancesIpc.focusFolder`; they return `focused`).
- **Restore windows** (`window.restoreWindows`: `all` — the default, as VS Code's —, `one`,
  `none`): the first window of a session reopens the last folder and starts a window for each
  other folder that was open when the IDE quit (`src/workbench/restoreWindows.ts`, tested). A
  folder or files on the command line, "New window" and test runs open only what they were
  given.
- **Empty windows come back with their untitled files** (m7.12, VS Code's): a window without a
  folder keeps its unsaved text (untitled editors, files from outside a folder) in a backup of
  its own, `<data>/windows/empty/<id>.json` (`editor/hotExit.ts`, `instancesIpc.emptyBackups*`;
  written a moment after edits, removed once a folder opens or nothing is unsaved). Closing the
  last window keeps it without asking; closing an empty window while others run asks, as VS Code
  does, and drops the backup. The next start (`all`) reopens each such window: this one becomes
  the most recent when no folder window is restored (`instancesIpc.adoptEmpty`), the others start
  with `--restore-empty <id>` (internal; only an id that start was handed). `one` takes the most
  recent only when there's no last folder; `none`, a folder from the command line and New window
  leave them for a later start. Notebooks in an empty window aren't kept.
- **Shell command**: `workbench.installShellCommand` ("Install shell command in PATH") shows what
  it will do and asks: Windows — a `.cmd` shim in the app's folder (or its data folder) and that
  folder on the *user* PATH (never the system PATH); macOS — a link in `/usr/local/bin` as VS
  Code does, through the system's administrator prompt (osascript) when that folder needs it,
  else (refused) in `~/.local/bin`; Linux — a link in `~/.local/bin` (it says when that folder
  isn't on PATH). `workbench.uninstallShellCommand` undoes it. `{ dryRun: true }` only reports
  the plan. *macOS is unverified (written on Windows).*
- **Waiting from PowerShell**: the release exe is a GUI program, which PowerShell doesn't wait
  for (VS Code's `Code.exe` is the same), so `--help`, `--version` and `--wait` need the shim:
  `cmd.exe` waits for whatever a `.cmd` file runs, so the shim blocks until the exe exits, its
  exit code passes through, and the exe attaches to that console for `--help` / `--version`.
  VS Code's `bin\code.cmd` does the same (it runs the exe as Node with `cli.js`). A plain
  `<cli>` / `<cli> -n` from the shim or a terminal starts a detached window and returns at once
  (`client.rs`, `should_detach`), as `code` does; `<cli> -w` keeps waiting.
- **Files in folders that don't exist** (`<cli> new/dir/file.txt`): the untitled editor saves
  there and the folders are created, inside or outside the open folder (`fs::canonical_file`
  resolves the path through its nearest existing folder; `fs::write` creates the rest).

- **Dock menu** (macOS, m7.12; Rust: `instances/dock_menu.rs`): the same recent folders and New
  window on the Dock icon's menu. Tauri and tao have no API for it: `applicationDockMenu:` is added
  at run time to the app delegate's class (plain Objective-C runtime calls, no new dependency).
  *Unverified: it compiles only on macOS, and this was written on Windows.*
- **Linux launcher action**: the desktop file (`src-tauri/linux/main.desktop`, the bundle's
  `desktopTemplate` for deb, rpm and AppImage) has `Actions=new-empty-window;` → `--new-window`,
  as VS Code's. Its folder list isn't dynamic (desktop files can't be). *Unverified (no Linux
  bundle built here).*
- **Taskbar jump list** (Windows, D229; Rust: `instances/jump_list.rs`): right-clicking the
  taskbar button shows "Recent folders" (pinned first, as File → Open recent; at most 10) and the
  "New window" task, as VS Code does. Each entry starts the IDE with the folder or
  `--new-window`, so a folder already open is focused. Rewritten 0.5 s after the recent list
  changes; a folder removed there leaves the recent list too. The process's AppUserModelID is the
  bundle identifier (the installer's shortcuts carry it; debug builds add `.dev`), so the list
  belongs to the pinned button. Test runs don't touch it.
- **Window bounds per folder** (D229, `window_bounds.rs`): each folder's last place and size is
  kept, so the last session's windows reopen each where it was (`--restored`, internal); sizes
  are written a moment after a move or resize, not only on a normal close.
- **`--help` / `--version`** print to the terminal (a release build attaches to its console).

**State:** `ide://windows` (requests waiting for their tabs, the restore setting, `jumpList`:
the folders shown on the jump list or Dock menu and whether it was written).
**Tests:** `src-tauri/src/instances`, `cli.rs` and `fs` (cargo), `src/workbench/restoreWindows.test.ts`,
`src/extensions/editor/hotExit.test.ts`, `tests/scripts/parA-m7-6.jsonc`, `tests/scripts/windows-m7-12.jsonc`.

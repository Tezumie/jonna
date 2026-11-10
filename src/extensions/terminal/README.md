# extensions/terminal

The `terminal` dock view: a tab holds one shell, or several side by side (`view.ts` the tab,
`pane.ts` one terminal; D209). `TerminalService` wires a pty to a
renderer with flow-control acks (sent in batches of 64 KiB or after 15 ms, D254: each ack is an
IPC round trip); `renderer.ts` defines `TerminalRenderer` and its xterm.js
implementation (lazy chunk, D48). Colors come from the design tokens (DESIGN.md §15.4) and switch
live. Resizes are coalesced per frame and reach the pty only when cols/rows change. Tab titles are
"shell · folder" (`title.ts`). `terminal.bell` (none/visual/sound) and `terminal.fontSize` are
settings. Moving a tab moves the terminal; the shell keeps running. Restored tabs start a fresh
shell (their profile) in the saved cwd, under the last session's output (D204). A tab's state may
carry `env` (extra variables for its shell, e.g. the JavaScript debug terminal's NODE_OPTIONS,
D204); it isn't saved with the tab.

Shell integration (D62): bash, zsh, fish and PowerShell load scripts that mark prompts and commands
(OSC 633); the renderer draws gutter dots, Rust keeps command records (`commands.ts` here exposes
them). Tabs can be renamed and split; restored tabs keep their name and last folder.

**Commands:** `terminal.toggle` (Ctrl+`), `terminal.create` (Ctrl+Shift+`), `terminal.focus`,
`terminal.sendText`, `terminal.kill`, `terminal.rename`, `terminal.split` (Ctrl+Shift+5),
`terminal.runCommand` (waits for exit code + output; it, tasks and Run recent command type
through `typeCommand`, which first cancels an Escape bash still holds, `typing.ts`, D271),
`terminal.commands`, `terminal.find`
(Ctrl+F in a terminal: a find bar over the output, `@xterm/addon-search`; returns "n of m", D111).
**Settings** (besides the look below): `terminal.shellIntegration.enabled`,
`terminal.notifyAfterSeconds` (a long command that ends while the window is in the background),
`terminal.minimumContrastRatio`, `terminal.rightClickBehavior`, `terminal.copyOnSelection`,
`terminal.multiLinePasteWarning`, `terminal.scrollbarSize`, `terminal.sendKeybindingsToShell`.
**State:** `ide://terminals`, `ide://terminals/<id>/commands`.

**Links, clipboard, commands** (D94, `features.ts`, tested): web addresses and file paths are
Ctrl/Cmd+click links with a tooltip (`~/…`, and `~\…` on Windows, is the home folder:
`expandHomePath`); Ctrl/Cmd+C copies a selection (else interrupts), Ctrl/Cmd+V
pastes; commands are colored with the editor theme's syntax colors (`terminal.highlightCommands`)
and the command whose output is on screen stays pinned at the top as a copy of its own line
(prompt and colors, on the terminal background — D99). The overview ruler beside the scrollbar
marks commands (red when they failed) and error / warning lines of their output. Context menu: copy, paste, select all, copy last
command / output, clear, split, new, rename, kill (`terminal.copySelection`, `terminal.paste`,
`terminal.selectAll`, `terminal.copyLastCommand`, `terminal.copyLastOutput`). A failed command offers "Fix with agent" (`terminal.fixWithAgent`, D124): a
small button at the right end of its line while the pointer is there (D150).
D253: a command whose line comes after it started (bash's and PowerShell's E mark arrives when
it's done; Windows 10's ConPTY draws the typed text after the marks) waits for E, then for D (the
typed line, only if the user typed it), instead of being dropped; the input start is confirmed at
the first key after B (the prompt can be drawn after its mark, on rows below). The tab shows a
spinner (`busy()`, the pane's `starting`) until the shell's first prompt, at most 10 s.
Output after a restart (D253) is this session's plain lines (`SavedOutput.lines`, `plainOutput`,
`logicalLines`), not the serialized screen, which only fits the width it was saved at; a restored
session where nothing ran keeps the last save, so separators don't pile up.

**Commands as objects** (D150): each command has a number (`seq`). Its dot opens a menu (rerun,
copy command, copy output, fix), and `terminal.copyLastCommand` / `copyLastOutput` /
`fixWithAgent` take `command` to act on any of them. `terminal.scrollToPreviousCommand` /
`scrollToNextCommand` (Ctrl+Up / Ctrl+Down) and `terminal.runRecentCommand` (Ctrl+Alt+R, history
kept per workspace by `index.ts`). A command whose line was trimmed off the scrollback stays known
while its output is there.

**Input and sizes** (D150): Rust writes input in order on a writer thread per session, and
`pty_write` / `pty_resize` are synchronous commands. `service.ts` resizes like VS Code: rows at
once, columns after 100 ms with a big buffer, never below 10×3. Unicode 11 widths. On Linux,
Ctrl+Shift+V pastes and Ctrl+V reaches the program. Multi-line paste is confirmed without
bracketed paste. OS file drops type quoted paths. The look (`terminal.fontFamily`, `lineHeight`,
`cursorStyle`, `cursorBlinking`, `scrollback`) applies live (`setLook`).

**Long-running commands and servers** (D91, D92): `terminal.start` runs a command in its own tab
and returns once its output settles (with server URLs); `servers.ts` (tested) finds addresses in
output, confirmed by a port probe; `terminal.servers` lists / opens them; status bar item and a
one-time toast. `ide://terminals` includes `servers`.

Tab color and icon (D120): `terminal.setColor`, `terminal.setIcon` (also in the terminal's
right-click menu), kept in the tab's state.

**Task terminals** (D134, `taskTerminals.ts`): `services.taskTerminals.run` starts a task's own
process in a terminal tab (no interactive shell): " *  Executing task" above, the exit code and
"press any key to close" below; reused per `presentation.panel` (shared / dedicated / new). The
output so far goes to whoever listens (the tasks extension's problem matchers). A task tab
restored after a restart is an ordinary shell.

**Profiles** (D204, `profiles.ts` tested, `profileCommands.ts`): Rust finds the shells
(`pty/profiles.rs`: PowerShell 7, Windows PowerShell, Git Bash from the registry / install folders
/ `git.exe` on PATH, Command Prompt, Cygwin, WSL distributions; `/etc/shells` elsewhere) and the
frontend merges them with `terminal.profiles.<windows|osx|linux>` (VS Code's shape: `path` or a
list, `source`, `args`, `env` with null to unset, `icon`, `color`, `overrideName`; null hides a
detected one). `terminal.defaultProfile.<platform>` names the default (empty: the IDE's own
choice). A profile's shell gets integration when its arguments are ones the scripts keep (none,
`-l`/`--login`/`-i`, PowerShell's `-NoLogo`/`-NoProfile`), else it starts exactly as configured.
Git Bash: `--init-file` with a forward-slash path, `CHERE_INVOKING`, `/c/…` folders read back as
`C:\…` (Rust and `service.ts`), dropped files typed as `/c/…`. The tab keeps its `profile`. The
"+ ▾" (a `dropdown` TabAction) opens `terminal.profileMenu`. Commands `terminal.newWithProfile
{ profile }`, `terminal.selectDefaultProfile`, `terminal.configureSettings`. Profiles and the default profile are restricted settings (D209,
VS Code's): a trusted folder's settings (and its `.vscode/settings.json`) may set them; an
untrusted folder's are ignored until it's trusted. **Automation profile** (D209):
`terminal.automationProfile.<platform>` (`{ path, args, env }`, also restricted; `env` null
removes a variable from the task's process, Rust's `RunSpec.env`) is the shell
shell tasks and debug launches run their command lines in when they name none
(`services.taskTerminals.automationShell()`; tasks and `runInTerminal` quote their arguments for
it; the run flags `-c` / `-Command` / `/d /c` are added). `ide://terminals` has
`profiles`, `defaultProfile`, `conpty` and each terminal's `profile`. The ▾ menu and the profile
picker also list the JavaScript debug terminal (`terminal.newWithProfile { profile: "JavaScript
debug terminal" }` runs `debug.createJavaScriptDebugTerminal`, D207).

**Split terminals** (D209, VS Code's terminal groups; `split.ts` tested, `splitCommands.ts`):
`terminal.split` (Ctrl+Shift+5, Cmd+\ on macOS, the toolbar's split button, the context menu)
starts a terminal after the focused one in the same tab (its folder and profile), sharing the
space equally; a sash between two resizes them (double-click: equal again;
`terminal.resizePane { change: grow | shrink }`). Side by side in a wide tab, stacked in a tall
one, unless `terminal.splitDirection` says `horizontal` (always side by side) or `vertical`
(always stacked); it applies live. `ide://terminals` has `splitDirection` and each split
terminal's `splitLayout` ("side by side" / "stacked"). `terminal.focusNextPane` / `focusPreviousPane` (Alt+Right / Alt+Left, also Up / Down; Cmd+Alt
on macOS) while `terminalSplitPaneActive`. `terminal.kill` closes only that terminal when others
share the tab; the last one closes the tab. `terminal.unsplit` moves one into a tab of its own,
its shell still running (the new tab's view adopts the pane). `terminal.splitToNewGroup` keeps
the old behaviour (a new dock group beside the tab). The tab's title is the group's ("bash · ide,
node"); its icon and color are the active terminal's. The tab state keeps one terminal in the old
shape and a group as `{ panes, active, sizes }`; each pane's output is saved under its own key
(`<tab>`, `<tab>#1`…), so a group comes back after a restart as it was. `ide://terminals` gives
each terminal's `pane`, `panes`, `activePane` and `tabTitle`. Task terminals that share a tab with
a split shell aren't reused or closed with the tab.

**Hidden terminals** (D217, VS Code's panel × / detach and "attach to session"; `hidden.ts`
tested, `hiddenCommands.ts`): `terminal.hide` (the × at the end of the terminal toolbar, "Hide
terminal" in the context menu) takes a terminal tab, split panes and all, out of the dock while
the shells keep running (`TerminalView.detachAll`; the panes wait in `HiddenTerminals` with their
sizes, active pane and the tab's place, reporting `hidden:<key>` as their tab). Every terminal
tool still works on them by id (`readOutput`, `sendText`, `runCommand`, `find`, `rename`,
`kill`, `ide://terminals/<id>/output`); `split` / `unsplit` ask to show it first; task reuse
skips them. `terminal.showHidden { id | all }` (the ▾ menu's "Hidden terminals (n)" submenu, a
picker in the palette) opens a tab where it was that adopts the same panes (`handOffPanes`, the
hand-off "Unsplit" uses); `terminal.focus { id }` on a hidden one shows it. `ide://terminals`
marks each terminal `hidden` (tab id null) and lists `hidden` tabs (`ids`, `title`, `hiddenAt`).
Hidden terminals end with the folder and come back hidden when it opens again (m7.12, below). The tab's own ×
still kills (the trash too). The split action has its own icon (`terminal-split`, in-repo in
`scripts/build-icons.mjs`), unlike the editor's split.

**D229.** `terminal.join { ids?, into? }` (VS Code's Join terminals; the context menu's "Join
terminals…", a picker of the other tabs' terminals or all of them) moves terminals from other tabs
into one tab as splits, shells running (`TerminalView.takePane` / `adoptPanes`); a tab left empty
closes. It is also how a terminal moves from one split tab to another (VS Code drags it in its
tabs list; no drag here). `terminal.hide { id, onlyThis: true }` (context menu "Hide only this
terminal" in a split tab) hides one pane, as VS Code's detach session acts on one terminal; shown
again it comes back in a tab of its own. Tasks without an automation profile run in the default
terminal profile's shell, arguments and env (VS Code's rule; `profileTaskShell`: a profile with
one path that isn't `wsl.exe`), else the IDE's default shell. In a WSL folder tasks run in Linux:
`terminal.automationProfile.linux` (or `options.shell`) is honored there (Rust `wsl_task_shell`),
else bash, and their arguments get bash quoting (`automationShell(folder)` says "bash"). Links a
WSL terminal prints: `~/…` is the distribution's home, `/…` a Linux path
(`wslPathToWindows`). `.bat` / `.cmd` process tasks (and `npm`, resolved to `npm.cmd`) run through
`cmd.exe /e:ON /v:OFF /d /c %IDE_BATCH_COMMAND_LINE%` with the line quoted the way Rust's std does
since BatBadBut (`batch_quote`); an argument with a line break is refused. Suggestions list the
user's aliases and functions (VS Code's terminal suggest: bash / zsh / fish `alias` and their
functions, PowerShell's `Get-Command` aliases and functions; `pty_shell_globals` asks the
terminal's shell once per program, `parseShellGlobals` reads it, tested), and the selected one's
detail (what an alias runs, a function's definition) shows in a details pane under the list.

**Output after a restart** (D204, `persist.ts` tested, `outputs.ts`): the last
`terminal.persistentSessionScrollback` lines (100) of each tab, serialized with
`@xterm/addon-serialize`, go into the workspace state (`terminal.outputs`, by tab id; saved a few
seconds behind output) and come back dim above the new shell under "Restored session · time"
(`terminal.enablePersistentSessions`). On Windows the old lines go to the scrollback so ConPTY's
first paint can't overwrite them.

**Process revival across a reload** (m7.12, VS Code's): Rust outlives the page. A pane's tab state
keeps its process as `pty: { id, key }` (`PtyInfo.key`; dropped from a duplicated tab,
`withoutPty`), and its saved screen keeps the output offset it reflects (`SavedOutput.offset`;
`TerminalService.outputOffset` counts the bytes the renderer has parsed). When the page reloads,
Rust detaches the old page's terminals (`page_loaded` with this page's token, `PAGE_TOKEN` in
`core/ipc/process.ts`) and keeps reading their output; the restored pane asks `host.startFor` with
its `pty`, and `TerminalService.create` takes the process back (`ptyIpc.attach`): the saved screen
drawn as it was, then Rust's replay of what came after it, then live output; a tab not on screen
draws at the console's size; a running program gets a resize nudge so ConPTY / full-screen
programs repaint. "AlreadyAttached" is retried for ~2 s (the dock may build a tab's view twice
while restoring: a view dropped before it's shown lets its process go, `TerminalService.release`
→ `ptyIpc.detach`, instead of killing it). A process that's gone ("Gone": it ended, or the IDE
restarted) falls back to a new shell under the dim saved output, as after a restart. Rust ends a
terminal nobody takes back within 60 s; a real quit ends them all, as before. Off with
`terminal.enablePersistentSessions`. `ide://terminals` says `reattached` per terminal. Task
terminals come back as their process and are re-linked to their task: the pane keeps the task's
name (`restoredTask`, saved with the tab while the process runs) and `taskTerminals.ts` hands it
to the tasks extension (`services.taskTerminals.onDidReattach`), which follows its exit, its
problem matchers (from then on) and the running list again. Hidden terminals are saved too
(`terminal.hidden` in the workspace state, `parseSavedHidden`; their screens under
`hidden-<n>#<i>`): after a reload they come back hidden with their processes, after a restart (or
the folder reopened) hidden with their output above a new shell.

**Suggestions** (D204, `suggest.ts` tested, `suggestWidget.ts`, `suggestCommands.ts`): VS Code's
terminal IntelliSense. The renderer keeps the prompt's input (from the B mark to the cursor);
while typing, a list under the cursor offers programs on PATH (Rust lists them once, cached),
builtins, history, files and folders (`pty_list_dir`, relative to the shell's folder), git
subcommands and branches. Tab accepts, Enter only after ↑/↓ (VS Code's "partial" mode), Escape
closes, Ctrl+Space opens (`terminal.triggerSuggest`, `acceptSuggestion`, `hideSuggestWidget`,
`selectNext/PreviousSuggestion`; context keys `terminalSuggestWidgetVisible`,
`terminalSuggestNavigated`, set from the focused terminal's widget, D207). `terminal.suggest.enabled` (on; not AI). Each terminal's list and
the line typed at its prompt are in `ide://terminals` (`suggest`).

**Renderer** (D204): `@xterm/addon-webgl` with the DOM renderer as the fallback
(`terminal.gpuAcceleration` auto / on / off, live); a lost context falls back at once, and "auto"
stays on the DOM renderer for the session. `ide://terminals` says which (`renderer`).

Hardening (D192): terminals set `TERM_PROGRAM` to the product's short name and the app drops the
variables of an editor that started it (`forget_parent_editor`, so Claude Code doesn't think it
runs in VS Code). The shell starts once its panel has a size; resizes are debounced while a
program runs (`busy()`). Shell marks carry a nonce (`IDE_SHELL_NONCE`). Killing a terminal on
Windows kills its process tree. While a program runs, Ctrl+letter goes to it rather than to IDE
shortcuts (`setShellKeys` in workbench/keyboard.ts; `terminal.sendKeybindingsToShell` makes it
always), and Shift+Enter sends ESC CR. OSC 8 links and URLs wrapped over rows open with
Ctrl+click. In a WSL folder the shell and tasks run inside the distribution (`wsl.exe`).

**Terminal output (D211):** `terminal.readOutput` and `ide://terminals/<id>/output` give the text a terminal shows (the last lines of scrollback and screen), for any program. `commandLine.ts` moves a command's dot and sticky line off a blank row that ConPTY left the mark on.

**Command line and sticky line (D217):** `correctedCommandLine` also moves a mark off a row the
command's output filled since (ConPTY marking the row below the command, then `npm run dev`
printing there) and checks a running command each time (a dev server never finishes); the dot is
placed again 0 / 150 / 600 / 2000 ms after the command starts. The sticky line stays for a
running command scrolled to the bottom (VS Code's sticky scroll; D192 hid it there), except in
the alternate buffer (`stickyApplies`, tested).

**Multi-root workspaces (D251).** `terminal.create` without `cwd` opens in the editor's folder
(the active or most recent editor's; else the first folder) and a relative `cwd` resolves with
`workspace.resolve` ("api/src"); `terminal.createInFolder {folder?}` asks which folder (VS Code's
multi-root New terminal), also in the ▾ menu when there are several. `terminal.start` keeps the
first folder as its default. Task terminals get the task's own folder as cwd. A link printed in a
terminal resolves against the terminal's cwd, then the workspace; a file in any folder opens
without `allowFile`.

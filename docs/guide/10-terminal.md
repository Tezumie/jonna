# Terminal

The IDE has an integrated terminal: real shells (PowerShell, Command Prompt, Git Bash, WSL, bash,
zsh, fish…) in tabs you can place anywhere in the dock. This page covers opening terminals,
profiles, splitting, shell integration (command marks, navigation, recent commands,
suggestions), links, find, keeping terminals across reloads and restarts, and the terminal's
settings.

## Open a terminal

- Press Ctrl+\` to show or hide the terminal (**Terminal → Toggle terminal**). With no terminal
  tab open, it brings back the most recently hidden terminal, and opens a new one only when none
  is running.
- Press Ctrl+Shift+\` (**Terminal → New terminal**) to open another, or click **+** in the
  terminal's toolbar. [New terminal](command:terminal.create)
- Ctrl+J shows or hides the panel the terminals sit in.

A terminal is a tab in the dock, like any other view: it opens at the bottom by default, and you
can drag its tab into the editor area, beside an editor, or into a group of its own. Moving the
tab moves the terminal; the shell keeps running.

A new terminal starts in the folder of the file you're editing (with several folders open, the
active editor's folder, else the first). **New terminal in folder…** asks which folder. The tab
is titled "shell · folder", and shows a spinner until the shell's first prompt.

### The toolbar

| Button | What it does |
|---|---|
| **+** | New terminal with the default profile |
| **▾** (Launch profile…) | The profiles, split, hidden terminals, the default profile and terminal settings |
| Split terminal | Opens a second terminal beside this one (Ctrl+Shift+5) |
| Clear terminal | Clears the output |
| Kill terminal (trash) | Ends the terminal and its shell |
| Hide terminal (×) | Puts the terminal away; the shell keeps running |

Double-click a terminal's tab to rename it.

## Choose a shell (profiles)

A profile is a shell with its arguments and environment. The **▾** beside **+** lists the shells
found on this computer and opens the one you pick:

- **Windows:** PowerShell 7, Windows PowerShell, Command Prompt, Git Bash, Cygwin and your WSL
  distributions.
- **macOS and Linux:** the shells in `/etc/shells` (bash, zsh, fish…).

The JavaScript debug terminal is in the same list (see [Debugging](13-debugging.md)).

### Set the default profile

**Select default profile…** (in the **▾** menu or the Command Palette) picks the shell new
terminals start with. It writes `terminal.defaultProfile.windows` (`.osx`, `.linux`). Empty, the
default is PowerShell 7 if it's installed, else Windows PowerShell, on Windows, and your login
shell elsewhere. [Select default profile](command:terminal.selectDefaultProfile)

### Add or change profiles

Add your own profiles in settings, in VS Code's format. An entry with the name of a detected
shell changes it; `null` hides one:

```json
"terminal.profiles.windows": {
  "Git Bash (login)": {
    "source": "Git Bash",
    "args": ["--login", "-i"],
    "env": { "CHERE_INVOKING": "1" }
  },
  "PowerShell (no profile)": { "source": "PowerShell", "args": ["-NoProfile"] },
  "Command Prompt": null
},
"terminal.defaultProfile.windows": "Git Bash (login)"
```

A profile takes `path` (or a list of paths: the first that exists), `source` (`"PowerShell"` or
`"Git Bash"`), `args`, `env` (`null` removes a variable), `icon`, `color` (such as
`"terminal.ansiGreen"`) and `overrideName`.

A folder's settings (and its `.vscode/settings.json`) can define profiles and the default profile
too, once you trust the folder: a profile starts a program, so an untrusted folder's profiles are
ignored. See [Workspaces and trust](20-workspaces.md).

> **Note:** Shell integration (below) is added when a profile's arguments are ones its scripts
> keep: none, `-l`, `--login` or `-i`, or PowerShell's `-NoLogo` and `-NoProfile`. With other
> arguments the shell starts exactly as configured, without it.

### Git Bash and WSL

- **Git Bash** starts in the terminal's folder, its `/c/…` folders read back as `C:\…`, and files
  you drop in are typed as `/c/…` paths.
- **WSL:** in a folder opened with **File → Open WSL folder…**, terminals and tasks run inside the
  distribution. Links it prints resolve there: `~/…` is the distribution's home and `/…` a Linux
  path. See [Remote development](19-remote.md).

## Split terminals

Run two shells side by side in one tab, as VS Code's terminal groups:

- Press Ctrl+Shift+5, click the split button in the toolbar, or choose **Split terminal** in the
  terminal's right-click menu. The new terminal starts in the same folder with the same profile.
- Drag the line between them to resize; double-click it to make them equal again.
- Alt+Right and Alt+Left (Alt+Down and Alt+Up when they're stacked) move between them.
- Killing one keeps the others; the last one closes the tab.
- **Unsplit terminal** moves one into a tab of its own, its shell still running. **Split terminal
  into a new group** opens the new terminal in a dock group beside the tab instead.
- **Join terminals…** (right-click menu) moves terminals from other tabs into this one as splits,
  their shells still running. It's also how you move a terminal from one split tab to another.

`terminal.splitDirection` chooses the layout: `auto` (side by side in a wide tab, stacked in a
tall one), `horizontal` (always side by side) or `vertical` (always stacked). A split tab is named
after its terminals and comes back split after a restart.

## Hide a terminal

The **×** at the right end of the terminal's toolbar (or **Hide terminal** in its right-click
menu) puts a terminal away without ending it: the tab goes, and the shell and whatever it runs
keep going, split terminals included. **Hide only this terminal** hides one terminal of a split
tab.

To bring one back, open the **▾** menu and pick it under **Hidden terminals** (or **Show all
hidden terminals**), or run **Show hidden terminal…**. Its tab comes back where it was, output
and all. The agent can still read and type into a hidden terminal.

The trash (**Kill terminal**) ends a terminal. Hidden terminals end when you close the folder or
the window, and come back hidden, with their output, when you open it again.

## Tab color, icon and name

Right-click in a terminal and choose **Change color…** or **Change icon…**; **Rename…** (or a
double-click on the tab) names it. Restored terminals keep their name, color, icon and folder.

## Shell integration

In bash, zsh, fish and PowerShell the IDE loads small scripts that mark each prompt and command
(`terminal.shellIntegration.enabled`, on by default; it applies to new terminals). With them:

- **Command marks:** a dot in the gutter beside each command, green when it succeeded and red
  when it failed. Click a dot for **Rerun command**, **Copy command**, **Copy output** and **Fix
  with agent**. The overview ruler beside the scrollbar marks commands (red when they failed) and
  the error and warning lines of their output.
- **Command navigation:** Ctrl+Up and Ctrl+Down jump to the previous and next command.
- **Sticky scroll:** the command whose output you're reading stays pinned at the top of the
  terminal; click it to go back to it.
- **Recent commands:** Ctrl+Alt+R (**Run recent command…**) picks one of the commands you ran in
  any terminal of this folder and runs it.
- **Fix with agent:** point at a failed command's line for a small **Fix** button that sends the
  command and its output to the agent (`terminal.fixWithAgent`).
- **Notifications:** a command that ran at least `terminal.notifyAfterSeconds` (30) seconds and
  ends while the window is in the background shows a notification.
- The tab title follows the shell's folder, and the commands you run are colored with the editor
  theme's colors (`terminal.highlightCommands`).

## Suggestions

While you type at the prompt, a list offers programs on your PATH, shell builtins, your aliases
and functions, commands you ran before, files and folders, and git subcommands and branches, as
VS Code's terminal suggest does. The details of the selected one (what an alias runs, a
function's definition) show under the list.

| Key | What it does |
|---|---|
| Tab | Accepts the highlighted suggestion |
| Up / Down | Moves through the list |
| Enter | Accepts, once you've moved with Up or Down |
| Escape | Closes the list |
| Ctrl+Space | Shows the suggestions |

Suggestions need shell integration. `terminal.suggest.enabled` turns them off. They are not an AI
feature.

## Links

- File paths and `file:line` positions are links: Ctrl+click opens the file in the editor at that
  line. A path is read against the terminal's folder, then the workspace. Paths in your home
  folder work too (`~/notes.md`, and `~\notes.md` on Windows).
- Web addresses open with Ctrl+click: a local dev server (`http://localhost:5173`) in the IDE's
  browser beside the terminal, other addresses in your system browser.
- Links a program prints with OSC 8, and addresses wrapped over two rows, work the same way.

### Servers

When a program prints a local server's address, the IDE checks the port and offers to open it in
the browser (once per server; `browser.notifyOnServer`). While servers run, the status bar shows
them; click it, or **View → Open running server…**, to open one. See
[Browser preview](11-browser.md).

## Find

Press Ctrl+F in a terminal to search its output and scrollback. Enter goes to the next match,
Shift+Enter to the previous one, and Escape closes the find bar. The bar shows "n of m".

## Copy, paste and keys

- Ctrl+C copies the selection; without a selection it interrupts the program. Ctrl+V pastes
  (Ctrl+Shift+V on Linux, where Ctrl+V reaches the program).
- Pasting several lines into a program that would run them one by one asks first
  (`terminal.multiLinePasteWarning`).
- `terminal.copyOnSelection` copies text as soon as you select it, and
  `terminal.rightClickBehavior` set to `copyPaste` makes right-click copy a selection or paste.
- Dropping files from your file manager onto a terminal types their quoted paths.
- **Keys for programs:** while a program runs in the terminal (an editor, Claude Code, tmux…),
  Ctrl+letter shortcuts go to it instead of the IDE; Ctrl+P still opens quick access. At the
  prompt the IDE's shortcuts work as usual; `terminal.sendKeybindingsToShell` sends them to the
  shell there too.
- Shift+Enter starts a new line in programs that support it.

The right-click menu also has **Select all**, **Copy last command**, **Copy last command output**,
**Run recent command…**, **Clear terminal** and **New terminal**.

## Run selected text

Select lines in the editor and choose **Terminal → Run selected text**: they are sent to the most
recent terminal and run. With no selection, the current line is sent.

## Terminals across reloads and restarts

- **After Developer: Reload window** the terminals keep running: each tab (and each hidden
  terminal, still hidden) takes its shell back with its output, a dev server or a build still
  going. A terminal no window takes back within a minute is ended.
- **After a restart** each terminal shows its last output again, dimmed, under a "Restored
  session" line, with a fresh shell below, in the folder it was in. Programs that were running end
  when the IDE quits. Hidden terminals come back hidden the same way.

`terminal.persistentSessionScrollback` sets how many lines come back (100), and
`terminal.enablePersistentSessions` turns both off.

## Terminal settings

**Configure terminal settings** (in the **▾** menu) opens the terminal's settings.
[Open settings](command:settings.open)

| Setting | Default | Description |
|---|---|---|
| `terminal.defaultProfile.windows` | `""` | The profile new terminals start with (also `.osx`, `.linux`) |
| `terminal.profiles.windows` | `{}` | Your own profiles; `null` hides a detected one (also `.osx`, `.linux`) |
| `terminal.automationProfile.windows` | `{}` | The shell tasks and debug launches run in (also `.osx`, `.linux`); see [Tasks](12-tasks.md#choose-the-shell-tasks-run-in) |
| `terminal.fontFamily` | `""` | Font family; empty: the editor's monospace font |
| `terminal.fontSize` | `13` | Font size in pixels |
| `terminal.lineHeight` | `1.25` | Line height, as a multiple of the font size |
| `terminal.cursorStyle` | `block` | `block`, `bar` or `underline` |
| `terminal.cursorBlinking` | `true` | Blink the cursor |
| `terminal.scrollback` | `10000` | Lines kept above the screen per terminal |
| `terminal.minimumContrastRatio` | `4.5` | Colored text is adjusted to stay readable; 1 shows colors as sent |
| `terminal.gpuAcceleration` | `auto` | Draw with WebGL (`on`), or the DOM renderer (`off`) |
| `terminal.splitDirection` | `auto` | How a split tab lays out its terminals |
| `terminal.bell` | `none` | What the bell does: `none`, `visual` or `sound` |
| `terminal.scrollbarSize` | `12` | Width of the scrollbar in pixels |
| `terminal.copyOnSelection` | `false` | Copy text as soon as it's selected |
| `terminal.rightClickBehavior` | `menu` | `menu`, or `copyPaste` |
| `terminal.multiLinePasteWarning` | `true` | Ask before pasting several lines that would each run |
| `terminal.sendKeybindingsToShell` | `false` | Ctrl+letter keys go to the shell even at the prompt |
| `terminal.shellIntegration.enabled` | `true` | Load shell integration in bash, zsh, fish and PowerShell |
| `terminal.highlightCommands` | `true` | Color the commands you run |
| `terminal.notifyAfterSeconds` | `30` | Notify when a long command ends in the background (0: never) |
| `terminal.suggest.enabled` | `true` | Suggestions while typing at the prompt |
| `terminal.fixWithAgent` | `true` | Offer Fix with agent on a failed command |
| `terminal.enablePersistentSessions` | `true` | Bring terminals back after a reload or restart |
| `terminal.persistentSessionScrollback` | `100` | Lines of output kept for the next session |

## Commands

| Command | Keys | What it does |
|---|---|---|
| Toggle terminal | Ctrl+\` | Shows or hides the terminal |
| New terminal | Ctrl+Shift+\` | Opens a terminal with the default profile |
| New terminal with profile… | | Picks a profile to open |
| New terminal in folder… | | Asks which folder (several folders open) |
| Split terminal | Ctrl+Shift+5 | Opens a terminal beside the focused one |
| Focus next / previous terminal in group | Alt+Right / Alt+Left | Moves between split terminals |
| Unsplit terminal | | Moves a split terminal into its own tab |
| Join terminals… | | Moves terminals from other tabs into one |
| Hide terminal | | Puts a terminal away, still running |
| Show hidden terminal… | | Brings a hidden terminal back |
| Find in terminal | Ctrl+F | Searches the output |
| Scroll to previous / next command | Ctrl+Up / Ctrl+Down | Jumps between commands |
| Run recent command… | Ctrl+Alt+R | Runs a command from your history |
| Show suggestions | Ctrl+Space | Shows the suggestion list |
| Clear terminal | | Clears the output |
| Rename terminal… | | Names the terminal |
| Change terminal color… / icon… | | The tab's color or icon |
| Kill terminal | | Ends the terminal |
| Select default profile… | | The profile new terminals start with |
| Running servers | | Lists the servers terminals started and opens one |

## Next steps

- [Tasks](12-tasks.md): run your build, tests and dev servers as tasks, with problem matchers.
- [Browser preview](11-browser.md): open the dev server a terminal started.
- [Debugging](13-debugging.md): the JavaScript debug terminal debugs every Node program started
  in it.
- [The agent](05-agent.md): the agent runs commands in terminals and can fix a failed one.

## Common questions

### Text in the terminal looks wrong. What can I try?

Set `terminal.gpuAcceleration` to `off` to use the slower DOM renderer instead of WebGL; some
graphics drivers draw WebGL text badly. If colored text is too faint or changed, lower
`terminal.minimumContrastRatio` (1 shows colors exactly as the program sends them).

### Why are there no command dots or suggestions?

They need shell integration: use bash, zsh, fish or PowerShell, keep
`terminal.shellIntegration.enabled` on, and check that your profile's arguments are ones the
integration keeps (see [Add or change profiles](#add-or-change-profiles)). Open a new terminal
after changing it.

### A program in the terminal doesn't get my Ctrl shortcut.

At the prompt, Ctrl+letter keys go to the IDE. Once a program runs they go to it. To send them to
the shell at the prompt too, turn on `terminal.sendKeybindingsToShell`.

### How do I run tasks in Git Bash on Windows?

Set the automation profile, for example
`"terminal.automationProfile.windows": { "path": "C:\\Program Files\\Git\\bin\\bash.exe" }`. See
[Tasks](12-tasks.md#choose-the-shell-tasks-run-in).

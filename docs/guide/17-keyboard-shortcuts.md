# Keyboard shortcuts

Every action in the IDE is a command, and any command can have a key. The defaults follow VS
Code's, so most of what your fingers know works here. This page covers the Keyboard shortcuts
editor, `keybindings.json`, chords and `when` clauses, how keys shared with the editor and the
terminal are resolved, a reference of the most useful default keys, and how keys map on macOS.

## The Keyboard shortcuts editor

Open it with **Ctrl+K Ctrl+S**, the gear → **Keyboard shortcuts**, or **File → Preferences →
Keyboard shortcuts**. It lists every command with its keys, in four columns: **Command**,
**Keybinding**, **When** and **Source**. The source is **Default** (the IDE's), **User** (yours),
or **Editor**: the code editor's own keys (Ctrl+D, Alt+Up, Ctrl+/, F12…), which you change like
any other.

[Open keyboard shortcuts](command:keybindings.show)

### Find a command or a key

- Type in the search box to filter by command name or id.
- Type a key in quotes, `"ctrl+d"`, to find what that key does (any spelling, or the label as
  shown).
- Turn on **Record keys** (the keyboard button beside the search box) and press keys: the list
  shows the commands bound to them.

### Change a key

1. Double-click a row, or select it and press Enter.
2. Press the new keys (one key, or two for a [chord](#chords)). Backspace clears what you
   pressed, Escape cancels.
3. Press Enter to save.

The change goes into your `keybindings.json`; the comments in the file are kept.

### Edit one binding

Right-click a row for:

| Menu item | What it does |
|---|---|
| **Change keybinding…** | Records new keys for this binding only (or **Add keybinding…** on a command without one) |
| **Add keybinding…** | Adds another key for the same command |
| **Change when expression…** | Edits the binding's [`when` clause](#when-clauses) in the row |
| **Show same keybindings** | Lists every command bound to the same key |
| **Remove keybinding** | Removes this binding |
| **Reset keybinding** | Takes your changes off: the default comes back |
| **Copy command ID**, **Copy command title**, **Copy keybinding** | Copies to the clipboard |

**Change when expression** turns the row's When column into a box: type the clause and press
Enter (Escape cancels; leaving the box saves). An empty clause means "always".

### Conflicts and shared keys

- **⚠** marks a key that two commands really fight over: both could run in the same place.
  Clauses that can't hold together (`explorerFocus` and the editor's, `isMac` and `!isMac`)
  aren't flagged.
- **ⓘ** marks a key the IDE and the editor share, such as Ctrl+PageDown (next tab, or the next
  page of suggestions). In an editor, the editor's key runs when its own clause holds (the
  suggestion list is open), the IDE's otherwise. Hover the mark to see which runs where.
- Your own keybindings always win over both.

## keybindings.json

Your keys are in `keybindings.json`, in your user configuration folder (beside `settings.json`).
The `{}` button in the Keyboard shortcuts editor, or **Preferences: Open keyboard shortcuts
(JSON)**, opens it. It's a JSON array with comments, in VS Code's format, and it's reloaded when
you save it; problems in it are reported.

```json
[
  // Ctrl+Shift+R runs the build task
  { "key": "ctrl+shift+r", "command": "tasks.runBuild" },

  // A different key on macOS
  { "key": "ctrl+alt+t", "mac": "cmd+alt+t", "command": "terminal.create" },

  // Only while the editor has the focus
  { "key": "ctrl+shift+alt+t", "command": "tests.runAtCursor", "when": "editorFocus" },

  // Remove a default binding
  { "key": "ctrl+e", "command": "-quickOpen.show" }
]
```

- `key` is the key for Windows and Linux, and for macOS unless `mac` gives another.
- `command` is a command id. The palette's commands, the editor's (`editor.action.*`,
  `cursorDown`… as in VS Code) and extensions' all work. **Copy command ID** in the row menu gives
  you the id.
- `when` limits where the key works.
- `args` passes input to the command, for example
  `{ "key": "ctrl+k ctrl+j", "command": "cursorMove", "args": { "to": "up", "value": 2 } }`.
- A `-` before the command removes a binding. With a `when`, it removes only the binding with that
  same clause; without one, it removes the command's binding everywhere.

[Open keybindings.json](command:keybindings.openJson)

### Chords

A chord is two key presses in a row, such as **Ctrl+K Ctrl+S**: write both, separated by a space
(`"ctrl+k ctrl+s"`). Keys are matched by their physical position, so bindings don't change with
your keyboard layout's shifted characters. Chords the IDE shares with the editor (Ctrl+K Ctrl+C)
go to the editor when its own clause holds there, as in VS Code; `args` work on a chord's second
key too.

### When clauses

A `when` clause is an expression over context keys, VS Code's syntax:

| Operator | Example |
|---|---|
| Key is true | `editorFocus` |
| Not | `!terminalFocus` |
| And, or | `editorFocus && !inputFocus`, `isMac \|\| isLinux` |
| Equals, not equals | `debugState == 'stopped'`, `debugState != 'inactive'` |
| Matches a regular expression | `debugState =~ /^(running\|stopped)$/` |
| In a list (another key's value) | `someKey in listKey`, `someKey not in listKey` |
| Grouping | `editorFocus && (inDebugMode \|\| isMac)` |

Some context keys the defaults use:

| Context key | True when |
|---|---|
| `editorFocus` / `editorTextFocus` | The code editor has the focus |
| `terminalFocus` | A terminal has the focus |
| `browserFocus` | The browser pane has the focus |
| `sideBarFocus` | The side bar has the focus |
| `inputFocus` | A text box has the focus |
| `inDebugMode` | A debug session is running |
| `debugState` | `'running'` or `'stopped'` (the focused session's) |
| `isMac`, `isWindows`, `isLinux` | The platform |

## Keys in the terminal

While a program runs in the terminal (an editor, Claude Code, nano, vim, tmux), Ctrl+letter keys
go to it instead of the IDE; Ctrl+P still opens quick access. `terminal.sendKeybindingsToShell`
sends them to the shell even at the prompt. See [Terminal](10-terminal.md).

## Keyboard shortcuts reference

**Help → Keyboard shortcuts reference** opens a sheet of the main keys for your platform, grouped
like VS Code's printable PDF: general, basic editing, navigation, search, multi-cursor, language
editing, editors, files, display, debug, terminal. It shows your own keys where you changed them.
**Print…** opens the print dialog (in light colors whatever the theme).

[Open the reference](command:keybindings.showReference)

## Default keys

The keys below are the defaults on Windows and Linux. Where a key only works in one place (the
editor, the terminal), the table says so.

### General

| Keys | Command |
|---|---|
| Ctrl+Shift+P, F1 | Show all commands |
| Ctrl+P, Ctrl+E | Go to file… |
| Ctrl+Shift+N | New window |
| Ctrl+, | Open settings |
| Ctrl+K Ctrl+S | Keyboard shortcuts |
| Ctrl+L | Focus agent |
| Ctrl+= / Ctrl+- | Zoom in / out (Ctrl+Numpad0 resets) |

### Basic editing (in the editor)

| Keys | Command |
|---|---|
| Ctrl+X / Ctrl+C | Cut / copy the line (with no selection) |
| Alt+Up / Alt+Down | Move line up / down |
| Shift+Alt+Up / Shift+Alt+Down | Copy line up / down |
| Ctrl+Shift+K | Delete line |
| Ctrl+Enter / Ctrl+Shift+Enter | Insert line below / above |
| Ctrl+Shift+\\ | Jump to matching bracket |
| Ctrl+] / Ctrl+[ | Indent / outdent line |
| Ctrl+Home / Ctrl+End | Go to beginning / end of file |
| Ctrl+Shift+[ / Ctrl+Shift+] | Fold / unfold region |
| Ctrl+K Ctrl+0 / Ctrl+K Ctrl+J | Fold / unfold all regions |
| Ctrl+/ | Toggle line comment |
| Shift+Alt+A | Toggle block comment |
| Ctrl+S | Save |
| Ctrl+Alt+S | Save all |
| Ctrl+N | New text file |

### Multi-cursor and selection (in the editor)

| Keys | Command |
|---|---|
| Ctrl+Alt+Up / Ctrl+Alt+Down | Insert cursor above / below |
| Ctrl+U | Undo last cursor operation |
| Shift+Alt+I | Insert cursor at end of each selected line |
| Ctrl+D | Add selection to next match |
| Ctrl+Shift+L | Select all occurrences of the selection |
| Ctrl+F2 | Select all occurrences of the word |
| Shift+Alt+Right / Shift+Alt+Left | Expand / shrink selection |

### Language editing (in the editor)

| Keys | Command |
|---|---|
| Ctrl+Space | Trigger suggestion |
| Ctrl+Shift+Space | Trigger parameter hints |
| Shift+Alt+F | Format document |
| Ctrl+K Ctrl+F | Format selection |
| F12 / Alt+F12 | Go to / peek definition |
| Shift+F12 | Show references |
| Shift+Alt+H | Show call hierarchy |
| F2 | Rename symbol |
| Ctrl+. | Quick fix |
| F8 / Shift+F8 | Go to next / previous problem |

### Navigation and search

| Keys | Command |
|---|---|
| Ctrl+Shift+O | Go to symbol in editor… |
| Ctrl+T | Go to symbol in workspace… |
| Ctrl+G | Go to line… |
| Ctrl+Tab, Ctrl+Shift+Tab | Switch editor… |
| Alt+Left / Alt+Right | Go back / go forward |
| Ctrl+Shift+M | Show problems |
| Ctrl+F / Ctrl+H | Find / replace (in the editor) |
| F3 / Shift+F3 | Find next / previous |
| Alt+Enter | Select all matches of Find |
| Ctrl+Shift+F, Ctrl+Shift+H | Search in files |

### Editors and layout

| Keys | Command |
|---|---|
| Ctrl+W | Close tab |
| Ctrl+Shift+T | Reopen closed tab |
| Ctrl+\\ | Split group |
| Ctrl+PageDown / Ctrl+PageUp | Next / previous tab |
| Ctrl+K Ctrl+Left / Right / Up / Down | Focus the group in that direction |
| Ctrl+Alt+Left / Right / Up / Down | Move tab to the group in that direction |
| Ctrl+K Shift+Enter | Pin / unpin tab |
| Ctrl+K Z | Zen mode |
| F11 | Full screen (Step Into while debugging is paused) |
| Ctrl+B | Toggle sidebar |
| Ctrl+J | Toggle panel |
| Ctrl+Shift+V | Toggle Markdown preview |
| Ctrl+K V | Open preview to the side |

### Files and views

| Keys | Command |
|---|---|
| Ctrl+K Ctrl+O | Open folder… |
| Ctrl+Shift+E | Show explorer |
| Ctrl+Shift+G | Show source control |
| Ctrl+Shift+D | Show run and debug |
| Ctrl+Shift+X | Show extensions |
| F2, Delete | Rename, delete (in the explorer) |
| Ctrl+Alt+F | Find in explorer (in the explorer) |
| Ctrl+Z / Ctrl+Y | Undo / redo a file operation (in the explorer) |

### Debug

| Keys | Command |
|---|---|
| F5 | Start debugging, or continue while paused |
| Ctrl+F5 | Run without debugging |
| Shift+F5 | Stop debugging |
| Ctrl+Shift+F5 | Restart debugging |
| F6 | Pause |
| F10 / F11 / Shift+F11 | Step over / into / out |
| Ctrl+F10 | Run to cursor |
| F9 | Toggle breakpoint |
| Ctrl+Shift+Y | Show debug console |

### Testing

| Keys | Command |
|---|---|
| Ctrl+; A | Run all tests |
| Ctrl+; F / Ctrl+; C | Run tests in current file / test at cursor |
| Ctrl+; E | Rerun failed tests |
| Ctrl+; Ctrl+F / Ctrl+; Ctrl+C | Debug tests in current file / test at cursor |

### Terminal and tasks

| Keys | Command |
|---|---|
| Ctrl+\` | Toggle terminal |
| Ctrl+Shift+\` | New terminal |
| Ctrl+Shift+5 | Split terminal (in the terminal) |
| Alt+arrows | Focus the next / previous split terminal (in the terminal) |
| Ctrl+Up / Ctrl+Down | Scroll to the previous / next command (in the terminal) |
| Ctrl+Alt+R | Run recent command… (in the terminal) |
| Ctrl+Space | Show suggestions (in the terminal) |
| Ctrl+F | Find (in the terminal) |
| Ctrl+Shift+B | Run build task |

### Source control and the agent

| Keys | Command |
|---|---|
| Ctrl+Enter | Commit (in the commit message box) |
| Ctrl+Alt+Y / Ctrl+Alt+N | Keep / undo this agent change (while reviewing the agent's changes) |
| Alt+F5 / Shift+Alt+F5 | Go to the next / previous agent change (while reviewing) |
| Ctrl+Shift+Alt+W | Close what the agent opened |

### Bookmarks

| Keys | Command |
|---|---|
| Ctrl+Alt+K | Toggle bookmark |
| Ctrl+Alt+L / Ctrl+Alt+J | Next / previous bookmark |
| Ctrl+Alt+Shift+K | List bookmarks… |

### Browser pane (while it has the focus)

| Keys | Command |
|---|---|
| F5, Ctrl+R | Reload page |
| Ctrl+L | Focus address bar |
| F12, Ctrl+Shift+I | Toggle browser DevTools |
| Ctrl+Shift+C | Select an element in the page |

AI features outside the agent's chat have keys only while they're turned on, for example
**Ctrl+K** for **Edit with AI…** in the editor. See [The agent](05-agent.md).

## Keys on macOS

On macOS, Ctrl in the keys above is usually Cmd and Alt is Option: Ctrl+Shift+P is Cmd+Shift+P.
Each binding can name its own macOS key (`mac` in `keybindings.json`), and some defaults differ
from a plain swap, as in VS Code:

| Windows and Linux | macOS |
|---|---|
| Ctrl+Shift+P | Cmd+Shift+P |
| Ctrl+K Ctrl+O (open folder) | Cmd+O |
| Ctrl+PageDown / Ctrl+PageUp (next / previous tab) | Cmd+Shift+] / Cmd+Shift+[ |
| Alt+Left / Alt+Right (go back / forward) | Ctrl+- / Ctrl+Shift+- |
| Ctrl+H (replace) | Option+Cmd+F |
| Ctrl+Y (redo, in the explorer) | Cmd+Shift+Z |
| Delete (in the explorer) | Cmd+Backspace |
| Ctrl+Shift+5 (split terminal) | Cmd+\\ |
| Ctrl+Shift+I (browser DevTools) | Option+Cmd+I |
| F3 / Shift+F3 (find next / previous) | Cmd+G / Cmd+Shift+G |

A binding without a macOS key keeps its key as written: Ctrl+G (go to line), Ctrl+Tab (switch
editor), Ctrl+\` (terminal), Ctrl+Shift+G (source control) and the function keys are the same on
macOS. The Keyboard shortcuts editor and the reference always show the keys for your platform.

## Vim mode

Turn on `editor.vimMode` for Vim key bindings in the editor: normal, insert and visual modes,
motions, registers, macros and `:` commands. See [Editing](04-editing.md). An extension that
handles what you type (a Vim keymap from Open VSX) can do the same; the IDE tells you when one
takes over typing.

## Common questions

### A key does nothing.

Search for it in quotes (`"ctrl+shift+r"`) in the Keyboard shortcuts editor: the list shows every
command bound to it and the `when` clause each needs. In a terminal running a program, Ctrl+letter
keys go to the program.

### How do I go back to the default keys?

Right-click a row and choose **Reset keybinding**, or delete your entries from
`keybindings.json`.

### Can I use my VS Code keybindings?

Yes. **Help → Import from VS Code…** brings your keyboard shortcuts, with VS Code's commands
matched to the IDE's. See
[Settings, themes and profiles](16-settings-themes.md#import-from-vs-code).

## Next steps

- [Quick access](02-quick-access.md): find commands and files from the keyboard.
- [Settings, themes and profiles](16-settings-themes.md): take your keys to another machine with a
  profile.
- [Editing](04-editing.md): the editor's own keys in context.

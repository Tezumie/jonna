# Troubleshooting

When something doesn't work as it should, the IDE has tools to find out why: a problem report you
can send, logs for each part of the IDE, a way to start without extensions, and commands that put
settings and the layout back. This page also covers updates and release notes, and lists common
problems with their fixes.

## Report a problem

**Help → Report a problem…** opens a tab that gathers what a bug report needs:

- **System:** the IDE's version, your system and its webview.
- **Recent errors**, and the error notifications you saw.
- **Session log (last lines):** the end of this session's log.
- **State:** how the IDE is set up (the workspace, the layout, open editors, extensions,
  language servers, updates, startup timings, safe mode), each as its own item.
- **Screenshot of the window**, taken when the tab opens.

Keys, tokens, your home folder and file contents are taken out before you see anything. Expand a
part to read exactly what it holds, and untick what you'd rather not share. Add a title and what
happened, then:

- **Open issue in browser:** opens a new issue with the report filled in (when the build has an
  issue tracker; a report too long for the link is shortened there and copied whole to the
  clipboard, to paste in).
- **Copy report:** puts it on the clipboard.
- **Save as zip…:** saves it as a file to attach.

The IDE uploads nothing itself. [Report a problem](command:help.reportProblem)

## Logs and the Output panel

### Session logs

Each run of the IDE writes a session log, and the last ten runs are kept.

- **Help → Open logs folder** shows this session's log in your file manager.
- **Help: Show session log** opens it in a tab.

Lines are cleaned of keys and tokens before they're written.

### Output channels

**View: Show output** opens the **Output** tab. Pick a channel to see its log as it's written:

| Channel | What it shows |
|---|---|
| Window | The IDE itself: the session log's records |
| Extension host | Extensions' messages |
| Git | Every git command the IDE ran, and how long it took |
| Tasks | Tasks the IDE ran |
| Agent | Commands that agents, external agents and MCP clients ran |
| One per language server | What the server reported |

Every channel but Window is also written to a file of its own in this session's logs folder,
next to the session log.

- **Filter:** the box shows only lines with one of its comma-separated words and none of the words
  starting with `!` (`error, !timeout`); Escape clears it.
- **Word wrap**, **Clear output** and the logs folder are buttons in the tab's header.

[Show output](command:output.show)

### Log levels

`log.level` decides how much every channel keeps, from least to most: `error`, `warn`, `info`
(the default), `debug` and `trace`. **Debug** adds every command that ran to the Window channel;
**trace** also adds git's queries (`git status`, `log`, `diff`) to the Git channel: git commands
that change something are logged at info, queries at trace, failures at warn.

To give one channel its own level, run **Developer: Set log level** and pick the channel, or use
the level picker in the Output tab's header. **Default** sends it back to `log.level`. The choices
are kept in `log.channelLevels`:

```json
"log.level": "info",
"log.channelLevels": { "git": "trace" }
```

| Setting | Default | Description |
|---|---|---|
| `log.level` | `info` | What the session log and the output channels keep |
| `log.channelLevels` | `{}` | Channels' own levels, by channel id (`"window"` is the session log's) |

Other logs: **Help → Show language server log** and **Help → MCP connection info**.

## Start with extensions off

If you suspect an extension, choose **Help → Restart with extensions off**. The IDE asks about
unsaved files, then restarts for one session without running any installed or bundled extension.
The status bar shows **Extensions off**; click it (or run **Help: Restart with extensions on**) to
restart normally.

You can also start the IDE with `--disable-extensions` from the command line.

If the problem goes away, **Help → Start extension bisect** finds which extension causes it: it
turns half of them off, restarts, asks whether the problem is still there, and repeats until one
is left. See [Extensions](18-extensions.md).

## Updates

Installed copies keep themselves up to date. When a newer version is out, a notification offers
**Install and restart** and **What's new**. Nothing is downloaded before you choose to install.
Installing downloads the new version, checks its signature, asks about unsaved files as closing
the window does, installs it and restarts (on Windows the installer runs with a progress bar).

**Help → Check for updates…** checks right away. [Check for updates](command:update.check)

| Setting | Default | Description |
|---|---|---|
| `update.mode` | `default` | `default`: check a minute after start and once a day. `manual`: only when you choose **Check for updates…**. `none`: never |
| `update.channel` | `stable` | `stable`: released versions. `beta`: previews of the next version, earlier and less tested (when the build has a beta channel; otherwise stable) |
| `update.showReleaseNotes` | `true` | Show What's new after an update |

A build made from source has no update server and never checks.

### What's new

After an update, the IDE opens **What's new** with the release notes once your folder is back.
**Help → Release notes** opens them any time. [Release notes](command:help.showReleaseNotes)

### Which version am I running?

**Help → About** shows the version, the update channel, your system, the webview's version and
the IDE's data folder; **Copy** puts them on the clipboard.

## Reset things

| To reset | Do this |
|---|---|
| One setting | Its row's reset button in Settings (Ctrl+,), or right-click the row |
| A section of settings | The reset button on the changed section |
| All settings | **Reset all** (↺ beside the page title in Settings, for the scope shown). The agent's settings (its models, agents and their choices) stay unless you tick **Also reset the agent's settings** |
| A keyboard shortcut | Right-click its row in Keyboard shortcuts → **Reset** |
| The layout of the window | **View: Reset layout** |
| The window's zoom | **Window: Reset zoom** (Ctrl+Numpad 0) |
| A folder's trust | **Workspace: Manage workspace trust** |
| Risky folder warnings you turned off | **Workspace: Reset risky folder warnings** |

Settings live in `settings.json`: **Preferences: Open settings (JSON)** opens your own. To try the
IDE with nothing of yours, start it with `--user-data-dir <folder>`: settings and state go to that
folder, and your own stay untouched.

## Common problems

### The side bar, status bar or panels are gone

- **Ctrl+B** brings back the side bar, **Ctrl+J** the bottom panel.
- In zen mode everything but the editors is hidden: press **Ctrl+K Z** again.
- **View: Toggle status bar** shows the status bar.
- **View: Reset layout** puts the whole window back to how it started.

### Everything is too big or too small

The window's zoom changed: **Ctrl+Numpad 0** resets it, or set `window.zoomLevel` to `0`. For the
editor's text alone, use `editor.fontSize`.

### Tasks, tests, debugging or git don't run

The folder is in restricted mode: the status bar says **Restricted mode**. Click it and trust the
folder if you know where its files come from. See [Workspace trust](20-workspaces.md#workspace-trust).

### The agent asks before working in my folder

You opened a risky folder (Downloads, your home folder, the Desktop, temp or a drive's root). Open
the project folder itself, or allow it for that chat. See
[Risky folders](20-workspaces.md#risky-folders).

### A file opened read-only

It isn't valid UTF-8. Use **Reopen with encoding…** in the editor's notice, or click the encoding
in the status bar, and pick the right one; the list starts with the encoding guessed from the
file. See [Editing](04-editing.md).

### "The file has changed on disk"

Something else changed a file you have unsaved edits in. Keep your changes (the next save
writes them) or reload the file from disk. A save never overwrites changes it hasn't seen.

### Pull requests and issues say you're not signed in to GitHub

The IDE uses the GitHub CLI (`gh`) for GitHub. Open the **Accounts** menu (the person icon above
the gear) and choose **Sign in to GitHub…**: it runs `gh auth login` in a terminal, where you
finish signing in through your browser. When `gh` isn't installed, the item says **(install the
GitHub CLI)**: install it first. See
[Source control](08-git.md).

### A language server doesn't start

Click its item in the status bar to install it or see its log, or run **Help → Show language
server log**.

### Ctrl+W, Ctrl+N or Ctrl+E do nothing in the terminal

On Windows and Linux, Ctrl+W, Ctrl+N, Ctrl+E, Ctrl+T and Ctrl+L go to the shell while the
terminal has focus (Ctrl+W deletes a word and Ctrl+L clears the screen in most shells), as in VS
Code. Click an editor first, or use the tab's ×. Ctrl+P and Ctrl+Shift+P work in the terminal
too.

### Windows: the command line returns at once

`<cli> --wait`, `--help` and `--version` return immediately in PowerShell when you run the program
file itself. Use the command that **Install shell command in PATH** adds (a `.cmd` file):
PowerShell waits for it. If `<cli>` isn't found right after installing it, open a new terminal so
it reads the new PATH. See [The command line](20-workspaces.md#the-command-line).

### Windows: PowerShell terminals don't mark commands

The terminal's shell integration (the dots that mark each command, the sticky command line,
**Fix** on failed commands, suggestions while typing) relies on a small script that PowerShell
loads when the terminal starts. Under a **Restricted** execution policy PowerShell won't load
scripts, so the terminal starts as a plain shell without them. Allow scripts for your user:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

then open a new terminal. Microsoft explains the policies in
[about_Execution_Policies](https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_execution_policies).

### The terminal draws wrongly

Terminals draw with WebGL when it works, and fall back by themselves when it fails. If text still
looks wrong, set `terminal.gpuAcceleration` to `off`.

### Windows: "Windows protected your PC" when installing

Windows SmartScreen shows this for an installer it hasn't seen signed often. If you got the
installer from the project's releases, choose **More info**, then **Run anyway**.

### Windows: the IDE doesn't start after installing

The IDE needs Microsoft's WebView2 runtime. Windows 11 and an up-to-date Windows 10 have it, and
the installer downloads it when it's missing, which fails offline or behind some proxies. Install
the runtime from
[Microsoft's WebView2 page](https://developer.microsoft.com/microsoft-edge/webview2/), then start
the IDE again.

### macOS: the app won't open

An app that isn't signed with an Apple Developer ID needs your approval: open **System Settings →
Privacy & security** and allow it there.

## Commands

| Command | What it does |
|---|---|
| **Help: Report a problem…** | Gathers a bug report to open, copy or save |
| **Help: Open logs folder** | Shows this session's log in your file manager |
| **Help: Show session log** | Opens the session log in a tab |
| **View: Show output** | Opens the Output tab |
| **View: Clear output** | Empties the channel shown |
| **Developer: Set log level** | Changes the log level, for all channels or one |
| **Help: Restart with extensions off** | One session without extensions |
| **Help: Restart with extensions on** | Back to normal |
| **Help: Start extension bisect** | Finds the extension that causes a problem |
| **Help: Check for updates…** | Checks for a newer version now |
| **Help: Install update and restart** | Installs a version found |
| **Help: Release notes** | Opens What's new |
| **Help: Show startup timings** | How long each phase of starting took |
| **Window: About** | Version, channel, system and data folder |

## Next steps

- [Workspaces and trust](20-workspaces.md): restricted mode, risky folders, the command line.
- [Extensions](18-extensions.md): managing, disabling and bisecting extensions.
- [Settings, themes and profiles](16-settings-themes.md): settings files and profiles.

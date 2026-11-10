# Debugging

The IDE has a debugger built in, configured the way VS Code's is: press F5 on a file, or describe
what to run in a `launch.json`. It debugs Node.js and TypeScript, Python, Go, .NET, C, C++ and
Rust, and pages in Chrome or Edge, and works with any program that speaks the Debug Adapter
Protocol. This page covers starting a session, breakpoints of every kind, stepping, the views you
inspect a paused program with, several sessions at once, attaching, and the launch.json options.

## Start debugging

The quickest start needs no setup:

1. Open a `.js`, `.ts` or `.py` file.
2. Press **F5**. The file runs with the debugger attached (Node.js for JavaScript and TypeScript,
   debugpy for Python), and stops at your breakpoints.

**Ctrl+F5** runs the same thing without the debugger. It still shows in the call stack with Stop
and Restart, and ends when the program ends.

For anything more (arguments, environment variables, a server, a test runner, a compiled
program), add a launch configuration.

### The Run and debug view

**Run and debug** in the activity bar (Ctrl+Shift+D) is where sessions start and where you
inspect them. At the top:

- **Run and debug** starts the configuration picked in the list beside it: your `launch.json`
  configurations and compounds, or the active file.
- The gear opens `launch.json`.
- The terminal icon in the header opens the debug console.

Below that are the [Variables, Watch, Call stack and Breakpoints
sections](#inspect-a-paused-program), and Loaded scripts. The sections share the view's height and each scrolls on its own; the view
scrolls when even that isn't enough.

[Show run and debug](command:debug.showView) · [Open launch.json](command:debug.openLaunchJson)

### Launch configurations

A launch configuration says what to run and which debugger runs it. They live in `launch.json`,
in VS Code's format:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Launch server",
      "type": "node",
      "request": "launch",
      "program": "${workspaceFolder}/src/server.js",
      "args": ["--port", "3000"],
      "env": { "NODE_ENV": "development" },
      "cwd": "${workspaceFolder}"
    }
  ]
}
```

- A project's `.vscode/launch.json` works as it is. When there's none, the gear (or **Debug:
  Open launch.json**) creates one in the IDE's own folder in the project.
- Variables are filled in as in tasks: `${workspaceFolder}`, `${file}` and the others, and
  `${command:pickProcess}` (see [Attach to a running program](#attach-to-a-running-program)).
- `preLaunchTask` and `postDebugTask` run a task before and after the session (see
  [Tasks before and after a session](#tasks-before-and-after-a-session)).
- `request` is `launch` (start the program) or `attach` (connect to one already running).

### Add a configuration

**Debug: Add configuration…** inserts a starter configuration into `launch.json` (creating the
file if needed) without disturbing what's there; comments and formatting are kept.

| Preset | What it does |
|---|---|
| Node.js: Launch program | Runs a script with Node; its child processes and workers are debugged too |
| Node.js: Launch via npm | Runs an npm script; every Node process it starts is debugged |
| Node.js: Attach | Attaches to a program started with `--inspect` |
| Node.js: Attach to process | Picks a running Node process and attaches to it |
| Node.js: Launch and open in Chrome | Starts a server and debugs the page once it's listening |
| Python: Current file | Runs the active file with debugpy |
| Python: Attach | Attaches to debugpy listening on a port |
| LLDB: Launch | C, C++, Rust or Swift with lldb-dap |
| GDB: Launch | C or C++ with GDB 14 or newer |
| Go: Launch package | Go with Delve (`dlv dap`) |
| .NET: Launch | .NET with netcoredbg |
| Chrome: Launch / Edge: Launch | Opens a page in Chrome or Edge with the debugger attached |
| Chrome: Attach | Attaches to Chrome started with `--remote-debugging-port` |
| Compound | Starts several configurations together |

Extensions that bring a debugger can add their own starter configurations to this list.

[Add configuration](command:debug.addConfiguration)

### Debuggers and what they need

`"type"` picks the debugger:

| `"type"` | Debugger | Needs |
|---|---|---|
| `node` | Node's inspector; the program runs in a terminal tab | Node.js |
| `debugpy` / `python` | debugpy | `pip install debugpy` |
| `lldb-dap` | LLDB (C, C++, Rust, Swift) | LLVM's `lldb-dap` |
| `gdb` | GDB | GDB 14 or newer |
| `go` | Delve (`dlv dap`) | `go install github.com/go-delve/delve/cmd/dlv@latest` |
| `coreclr` | netcoredbg (.NET) | netcoredbg on PATH or in `debug.netcoredbgPath` |
| `chrome` / `msedge` | The page in Chrome or Edge, over its DevTools protocol | Chrome or Edge |
| anything else | `"debugAdapter": { "command": "…", "args": [] }` | That debug adapter |

When a debugger is missing, starting a session says what to install. For Go the message has an
**Install** button that runs the install command in a terminal (also **Debug: Install debug
adapter…**). netcoredbg comes from Samsung/netcoredbg's releases on GitHub. Java isn't built in
yet.

Where the programs are is set by user settings (a folder can't choose the program the debugger
runs):

| Setting | Default | Description |
|---|---|---|
| `debug.pythonPath` | `""` | The Python that runs debugpy (python3, or python on Windows). A configuration's `"python"` wins. |
| `debug.lldbDapPath` | `""` | The lldb-dap program (default: on the PATH). |
| `debug.gdbPath` | `""` | GDB, version 14 or newer (default: on the PATH). |
| `debug.dlvPath` | `""` | Delve, for Go (default: on the PATH). |
| `debug.netcoredbgPath` | `""` | netcoredbg, for .NET (default: on the PATH). |

### TypeScript

With source maps, breakpoints in `.ts` files work. Run them through tsx
(`"runtimeArgs": ["--import", "tsx"]`) or ts-node, or debug `tsc` output built with
`"sourceMap": true`. Node 22.18 and newer also runs `.ts` files directly, with no map needed.

## Breakpoints

A breakpoint stops the program on a line. Click left of a line number, or press **F9** on the
line, to add or remove one.

- Breakpoints follow their lines as you edit, and follow files that are renamed. They're saved
  with the workspace.
- A hollow dot means the debugger couldn't place it: there's no code on that line, or the file
  isn't loaded yet.
- Right-click a breakpoint for **Remove breakpoint**, the edit commands below, and **Disable
  breakpoint** / **Enable breakpoint**.

Right-click the margin where there's no breakpoint for the other kinds:

| Menu item | What it adds |
|---|---|
| **Add breakpoint** | A plain breakpoint |
| **Add conditional breakpoint…** | A breakpoint that stops only when an expression is true |
| **Add logpoint…** | A message printed to the debug console instead of stopping |
| **Add triggered breakpoint…** | A breakpoint that waits until another one is hit |
| **Run to line** | (While paused) runs until that line |

### Conditions and hit counts

- **Conditional breakpoint:** an expression in the program's language, such as `i > 10`. The
  program stops only when it's true. **Edit condition…** on a breakpoint changes it.
- **Hit count:** **Edit hit count…** stops only on certain hits: `5` (the fifth), `>5` (after
  the fifth), `%3` (every third).

A breakpoint can have both. They're drawn with the conditional mark.

### Logpoints

A logpoint prints a message instead of stopping, like adding a `console.log` without changing the
code. Expressions in braces are evaluated: `total is {total}`. Logpoints are drawn as a diamond.
**Edit log message…** changes the message.

### Triggered breakpoints

A triggered breakpoint does nothing until another breakpoint is hit in the session, as VS Code's
"Wait for breakpoint" does. Use it to stop in shared code only on the path you care about.

1. Right-click the margin and choose **Add triggered breakpoint…**, or right-click an existing
   breakpoint and choose **Wait for breakpoint…**.
2. Pick the breakpoint that triggers it (or **None** to make it a plain breakpoint again).

While it waits, it's a dashed ring in the margin and in the Breakpoints section ("after
file:line"). Once the trigger is hit, it's active for that session only; a new session waits
again. Removing the trigger makes it a plain breakpoint.

### Function breakpoints

The **+** in the Breakpoints section adds a function breakpoint: the program stops when a function
by that name is called, wherever it is.

### Data breakpoints

While paused, right-click a variable and choose **Break on value change**: the program stops when
that value changes. This works with debuggers that support it, such as lldb-dap and GDB; Node's
inspector can't. Data breakpoints last for the session.

### Exceptions

- For Node and browser pages, the Breakpoints section has **Uncaught exceptions** (stop where an
  exception nothing catches is thrown) and **Caught exceptions** (stop on any).
- For Python, C, C++ and other debug adapters, it lists the adapter's own exception settings
  ("Raised exceptions", "Uncaught exceptions"…). Some take a condition: right-click, **Edit
  condition…**.

When the program stops on an exception, the editor shows what was thrown under the line: its type,
message and stack.

### Instruction breakpoints

In the [disassembly view](#disassembly), a click in the margin sets a breakpoint on one machine
instruction. Instruction breakpoints are listed in Breakpoints and kept while the IDE runs, not
saved.

### Manage breakpoints

The Breakpoints section lists every breakpoint with a check box to turn it off and on, and a
button to remove it. Right-click a row to edit it. From the command palette:

| Command | Keys | What it does |
|---|---|---|
| Debug: Toggle breakpoint | F9 | Adds or removes a breakpoint on the cursor's line |
| Debug: Add conditional breakpoint… | | Adds a breakpoint with a condition |
| Debug: Add logpoint… | | Adds a logpoint |
| Debug: Add triggered breakpoint… | | Adds a breakpoint that waits for another |
| Debug: Add function breakpoint… | | Stops when a function by that name is called |
| Debug: Edit breakpoint… | | Changes a breakpoint's condition, hit count, message or trigger |
| Debug: Enable or disable all breakpoints | | Turns every breakpoint off or on |
| Debug: Remove all breakpoints | | Removes every breakpoint |
| Debug: Toggle pausing on uncaught exceptions | | As the check box in Breakpoints |
| Debug: Toggle pausing on caught exceptions | | As the check box in Breakpoints |

## Step through code

When the program stops, the debug toolbar shows the step commands. It floats over the top of the
window (drag its grip to move it); `debug.toolBarLocation` docks it in Run and debug or hides it.

| Command | Keys | What it does |
|---|---|---|
| Continue | F5 | Runs until the next breakpoint |
| Step over | F10 | Runs the current line, stepping over calls |
| Step into | F11 | Steps into the call on the current line |
| Step out | Shift+F11 | Runs until the current function returns |
| Run to cursor | Ctrl+F10 | Runs until the cursor's line |
| Pause | F6 | Stops a running program where it is |
| Stop debugging | Shift+F5 | Ends the session |
| Restart debugging | Ctrl+Shift+F5 | Ends the session and starts it again |

The status bar shows the session's name while debugging (with a pause icon while stopped); click
it to open Run and debug.

### Step into target

When a line has several calls (`format(parse(input))`), **Step into target** in the editor's
right-click menu picks which one to step into: the call under the cursor, or one you choose from
a list. It's offered for debuggers that support it, such as Python's debugpy, lldb-dap and GDB;
Node's inspector has no such request.

### Restart frame

**Restart frame** runs a function again from its start without restarting the program: right-click
a frame in Call stack, or use the restart button on its row. It works with Node and browser
pages, and with other debuggers that support it. Frames that can't be restarted don't offer it.

## Inspect a paused program

### Hover

Hover a variable, or an expression such as `user.name`, to see its value; an object shows its
first properties. Hovering never runs code that changes anything.

### Inline values

While paused, the editor shows `name = value` after the lines of the stopped function, from the
start of each scope down to the stopped line. Values clear as soon as the program runs again.

| Setting | Default | Description |
|---|---|---|
| `debug.inlineValues` | `"auto"` | `"on"` always, `"off"` never, `"auto"` for the languages the built-in debuggers debug: JavaScript and TypeScript, Python, Go, Rust, C and C++, C# |

### Variables

**Variables** shows the selected frame's scopes (locals, closures, globals…). Expand an object to
see inside. Right-click a variable for:

- **Set value…** (or F2, or double-click): changes the value in the running program.
- **Copy value**, **Copy as expression**.
- **Add to watch**.
- **Break on value change** (a [data breakpoint](#data-breakpoints)), where the debugger supports
  it.

### Watch

**Watch** holds expressions evaluated at every stop. **+** adds one; right-click to **Edit
expression…** (F2) or **Remove expression**.

### Call stack

**Call stack** shows the stopped thread's frames; click one to see its variables and its line.
Runtime internals are folded. With several sessions, each is listed with its threads (see
[Several sessions](#debug-several-programs-at-once)).

### Loaded scripts

**Loaded scripts** (a section of Run and debug, or **Debug: Loaded scripts…**) lists what the
program has loaded: your files and the runtime's. The filter box narrows it; click one to open it.

### Disassembly

**Debug: Open disassembly view** opens a tab with the machine code at the paused instruction, for
native debuggers (lldb-dap, GDB): address, bytes, instruction, symbol and source line, the current
one marked. It follows the selected frame and loads more instructions as you scroll. While it has
the focus, F10, F11 and Shift+F11 step one instruction at a time (where the debugger supports
it). A click in its margin toggles an [instruction breakpoint](#instruction-breakpoints).

## Debug console

The **Debug console** (Ctrl+Shift+Y) evaluates expressions in the selected frame and shows the
session's messages: logpoints, a browser page's console, and the program's output when it's
captured (below). Results that are objects expand. Up and Down recall the expressions you typed
earlier; each console keeps its own history, also after you restart the configuration.

- **One console per session:** when several sessions run (a compound, a browser opened by
  serverReadyAction), each has its own console. A Node program's child processes and workers
  write into their parent's. The console follows the session you select in the call stack; the
  picker above it switches to another one (and focuses that session). Expressions run in the
  session whose console is shown, and **Clear debug console** clears that console only.
- **The program's own output:** in a Node configuration, `"console": "internalConsole"` (or
  `"outputCapture": "std"`) shows what the program prints (stdout and stderr, stderr colored) in
  the debug console instead of a terminal tab. As in VS Code's internal console, there's no input.
  This works for Run without debugging and npm scripts too.

| Setting | Default | Description |
|---|---|---|
| `debug.openDebugConsole` | `"openOnFirstOutput"` | When the console opens: `openOnSessionStart`, `openOnFirstOutput` or `neverOpen` |

## Debug several programs at once

You can debug more than one program at a time: start a configuration while another runs, or start
several together with a compound.

- The call stack shows each session, and under a Node program its child processes and worker
  threads. Click a session to focus it: the toolbar, Variables, Watch and the debug console then
  act on it. With several sessions the toolbar has a session picker.
- A program's threads are listed too, each with its own pause and continue.
- **Debug: Stop all debug sessions** ends everything.

### Compounds

A `compounds` entry in `launch.json` starts several configurations together. `"stopAll": true`
stops them all when you stop one.

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Server",
      "type": "node",
      "request": "launch",
      "program": "${workspaceFolder}/server.js"
    },
    { "name": "Client", "type": "chrome", "request": "launch", "url": "http://localhost:5173" }
  ],
  "compounds": [
    { "name": "Server and client", "configurations": ["Server", "Client"], "stopAll": true }
  ]
}
```

A compound can have its own `preLaunchTask`; each configuration's own `preLaunchTask` runs first,
then they start side by side.

### Order the configuration list

`presentation` orders the list as in VS Code: `group` groups configurations by name (with a line
between groups), `order` sorts within a group, and `hidden: true` leaves one out of the list (it
still starts by name).

### Child processes and the JavaScript debug terminal

Node programs you debug have their child processes (`child_process.fork`, `spawn` of node) and
worker threads debugged too, each as a child session. Python's debugpy subprocesses, and any
adapter's child targets, start child sessions the same way.

Run **Debug: JavaScript debug terminal** to open a terminal where every Node program you start
(`node app.js`, `npm run dev`, `npx jest`) is debugged automatically. A launch configuration with
`"runtimeExecutable": "npm"` and `"runtimeArgs": ["run-script", "dev"]` debugs an npm script the
same way.

| Setting | Default | Description |
|---|---|---|
| `debug.javascript.autoAttachFilter` | `"smart"` | `"smart"` skips scripts in node_modules (npm, yarn, bundlers' internals) except tools that run your code (Jest, Mocha, Vitest, ts-node, tsx, Vite, Next…); `"always"` attaches every Node process |

## Attach to a running program

- **Node:** start the program with `node --inspect`, then use a configuration with
  `"request": "attach"` (and `"port"` if it isn't 9229). Stop detaches and leaves the program
  running.
- **Pick a process:** `"processId": "${command:pickProcess}"` asks which process to attach to
  when the session starts. **Debug: Attach to Node process…** does the same without a
  configuration.
- **Python:** the **Python: Attach** preset connects to debugpy listening on a port
  (`"connect": { "host": "127.0.0.1", "port": 5678 }`).
- **Chrome:** see [Debug a page in a browser](#debug-a-page-in-a-browser).

## Debug a page in a browser

A `"type": "chrome"` (or `"msedge"`) configuration debugs code running in a web page:

```json
{
  "name": "Chrome: launch",
  "type": "chrome",
  "request": "launch",
  "url": "http://localhost:5173",
  "webRoot": "${workspaceFolder}"
}
```

F5 opens Chrome with a profile of its own (kept in the IDE's folder in the project, out of git;
`"userDataDir"` changes it, `false` drops it) and loads the page with your breakpoints already
set. The page's console shows in the debug console, navigating keeps the session, and closing the
browser ends it.

- Scripts are matched to your files by `"webRoot"` (default: the folder) or `"pathMapping"`
  (`{ "/static/": "${workspaceFolder}/public/" }`). Source maps from Vite, webpack and the like
  take bundles back to your TypeScript.
- `"runtimeExecutable"` picks another browser; `"runtimeArgs"` adds flags.
- `"request": "attach"` attaches to a browser you started with `--remote-debugging-port=9222`
  (`"port"`), to the page whose address starts with `"url"`.

### Open the page when the server is ready

`serverReadyAction` in a server's configuration waits until the program prints that it's
listening ("listening on port 3000", Vite's "Local: http://localhost:5173/"), then:

| `"action"` | What happens |
|---|---|
| `openExternally` (default) | Opens the address in your browser |
| `debugWithChrome` / `debugWithEdge` | Opens it in Chrome or Edge with the debugger attached |
| `startDebugging` | Starts another configuration (`"name"`) |

`"pattern"` is a regular expression whose first group is the port or the address (VS Code's
default: `listening on.* (https?://\S+|[0-9]+)`); `"uriFormat"` turns it into the address
(`"http://localhost:%s"`); `"killOnServerStop": true` ends the browser session with the server's.
The **Node.js: Launch and open in Chrome** preset sets this up.

### Debug the browser pane

On Windows you can debug the page open in the IDE's own browser pane:

1. Set `debug.browserPane.debuggingPort` (for example `9333`) and restart the IDE.
2. Open your page in the browser pane.
3. Run **Debug: Debug the browser pane**.

> **Note:** while the port is open, any program on this computer can control the IDE's webviews
> through it. Set it back to `0` when you're done. On Linux and macOS, debug the page in Chrome or
> Edge instead.

## Tasks before and after a session

- `preLaunchTask` runs a task (by its label) before the session starts, for example a build.
- `postDebugTask` runs a task after the session ends.

In a workspace with several folders, the task is looked up in the configuration's own folder
first. See [Tasks](12-tasks.md).

## Several folders

In a workspace with several folders, the IDE reads every folder's `launch.json` and the workspace
file's `launch` section. A folder's configurations are named with it ("Launch (api)"), and each
uses its own folder for `${workspaceFolder}`, its working directory and its tasks. A compound
names its members as `"Name"`, `"Name (folder)"` or `{ "name": …, "folder": … }`. **Open
launch.json** and **Add configuration…** ask which folder when it isn't clear. See
[Workspaces and trust](20-workspaces.md).

## Settings

| Setting | Default | Description |
|---|---|---|
| `debug.toolBarLocation` | `"floating"` | Where the debug toolbar is: `floating`, `docked` in Run and debug, or `hidden` |
| `debug.openDebugConsole` | `"openOnFirstOutput"` | When the debug console opens |
| `debug.inlineValues` | `"auto"` | Variable values inline in the editor while paused |
| `debug.javascript.autoAttachFilter` | `"smart"` | Which Node processes attach automatically |
| `debug.browserPane.debuggingPort` | `0` | Windows: opens the browser pane's DevTools port (after a restart) |
| `debug.pythonPath`, `debug.lldbDapPath`, `debug.gdbPath`, `debug.dlvPath`, `debug.netcoredbgPath` | `""` | The debugger programs (user settings only) |

[Open settings](command:settings.open)

## Common questions

### My breakpoint is a hollow dot. Why?

The debugger couldn't place it: there's no code on that line, the file isn't loaded yet, or (for
TypeScript and bundled code) there's no source map that leads to it. Check that your build writes
source maps, and for browser pages that `webRoot` or `pathMapping` points at your files.

### F5 says it can't debug this file.

F5 without a `launch.json` handles JavaScript, TypeScript and Python files. For other languages,
add a configuration with **Debug: Add configuration…**.

### Can I debug Vitest or Playwright tests from the Testing view?

Not yet: they run tests in worker threads or processes. The Testing view says what to run
instead. Node's test runner, Jest, Mocha, pytest and unittest can be debugged from there; see
[Testing](14-testing.md#debug-a-test).

### Does F5 still reload the browser pane?

Yes. While the browser pane has the focus, F5 reloads the page; the debug keys apply elsewhere.

## Next steps

- [Testing](14-testing.md): run and debug your tests.
- [Tasks](12-tasks.md): build steps for `preLaunchTask`.
- [Browser preview](11-browser.md): the browser pane.
- [Keyboard shortcuts](17-keyboard-shortcuts.md): change the debug keys.

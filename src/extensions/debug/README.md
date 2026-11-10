# extensions/debug

Run and debug (D143): VS Code's debugger workflow and keys.

- `launch.ts` (tested) — launch.json configurations (`.vscode/launch.json` and the IDE's own
  `<workspaceFolderName>/launch.json`; `debug.openLaunchJson` creates a new one in the IDE's own), variables as in tasks, the active file's default
  configuration, and which debugger runs a type (`adapterFor`).
- `session.ts` — the `DebugSession` interface every debugger implements, and the Debug Adapter
  Protocol client (`DapConnection`, `DapSession`) for adapters over stdio (debugpy, lldb-dap,
  GDB, custom). `runInTerminal` requests open a terminal tab.
- `cdp.ts` (helpers tested) — Node through its inspector: `node --inspect-brk` in a terminal tab
  (or attach to `--inspect`), the Chrome DevTools Protocol over a local WebSocket (Rust:
  `src-tauri/src/debug`, 127.0.0.1 only). Conditions, hit counts and logpoints compile into
  inspector conditions (`cdpCondition`); source maps through instrumentation pauses and
  first-line guards (D145).
- `sourcemap.ts` (tested) — Source Map v3 both ways (VLQ, sourceRoot, index maps, data: URLs).
- `breakpoints.ts` (tested) — breakpoints (condition, hit count, log message, enabled, placed or
  not) and caught / uncaught exceptions; they follow edits and renames and are saved per
  workspace. `breakpointCommands.ts` — their commands and the editor margin's menu.
- `watches.ts` — watch expressions, re-evaluated at each stop.
- `index.ts` wires the extension (the view, the status bar, hover values, persistence, the
  launch.json and console commands). Split by responsibility (D233): `configurations.ts` (launch.json
  in every workspace folder, compounds, the active file's configuration, the picker's entries,
  which configuration a start uses), `runCommands.ts` (`debug.start` / `runWithoutDebugging`, the
  step commands, Stop, Restart, pre/post tasks, opening the debug console), `inspectCommands.ts`
  (run to cursor, set variable, watches, frames, variables, evaluate), `debugState.ts`
  (`ide://debug`).
- `controller.ts` — the sessions: start, stops (call stack, the stopped line through
  `services.debugMarks`), stepping, evaluation, the console's lines. Split by responsibility
  (D229): `runningSession.ts` (one session's state), `breakpointSync.ts` (every kind of
  breakpoint kept in step with each session, verification across sessions), `childSessions.ts`
  (sessions started under another: auto-attached Node children, workers, serverReadyAction,
  DAP `startDebugging`).
- `view.ts` — the "Run and debug" sidebar: configuration picker, Variables and Watch
  (`valueTree.ts`: lazy trees, set value), Call stack, Breakpoints. `toolbar.ts` — the debug
  toolbar, floating or docked. `console.ts` — the debug console tab (expandable results; rows
  styled like the browser DevTools console), `consoleDiff.ts` — its DOM-free line diff.
- **Debug console per session** (D209, `consoleSessions.ts` tested, `consolePicker.ts`): every
  session — each of a compound's, a serverReadyAction's browser — has its own console; a Node
  program's child processes and workers write into their parent's (js-debug's "merge with
  parent"). The console shows one session's lines (and those of no session) and follows the
  focused session; a picker above it (with two or more) and `debug.selectConsole { session | x, y }`
  switch it (focusing that session while it runs). `debug.evaluate` runs in the shown console's
  session (or the focused one when the console is its own) and prints there; `debug.clearConsole
  { all? }` clears the shown one. `ide://debug` has `consoleSession`, `consoles` and the shown
  console's lines.
- **Each console its own input history** (`consoleHistory.ts`, tested): Up / Down walk the
  expressions typed in the console shown, kept under its session's name (a restarted session
  keeps them; 100 each, 50 consoles); a half-typed line comes back with Down past the newest.
- **A Node program's output in the debug console** (`programOutput.ts`, tested;
  `programProcess.ts`): with `"console": "internalConsole"` or `"outputCapture": "std"` the
  program runs with pipes instead of a terminal, as js-debug does (D229): stdout and stderr stay
  apart (stderr rows are colored), escape sequences out, `\r` redraws resolved, Node's inspector
  messages left out. As in VS Code's internal console there's no input. Rust: the stdio host's
  `"chunks"` framing (the output as it's written, line breaks kept; `${env:NAME}` filled into
  the environment). A line printed without its end (a prompt) shows within 100 ms
  (`PARTIAL_LINE_DELAY`), and what follows continues it: the console joins output to an
  unfinished line of the same session and stream (`continueOutput`, carriage returns redraw it)
  and the view redraws only that row (`consoleDiff`'s `redrawLast`). The inspector's address is
  read once it has ended (a chunk can stop inside it).
  The same goes for Run without debugging and a package manager's script
  (`runtimeExecutable: npm`): with internalConsole their output (npm's and its programs') goes
  to the debug console; otherwise it stays in their terminal tab.
- **Run without debugging** (Ctrl+F5, D229) is a session too, as in VS Code (kind `process`): it
  shows in the call stack with Stop and Restart and nothing to inspect, and ends with the program.
- **DAP `startDebugging`** (D229, `childSessions.ts`, `launch.ts` `childLaunchConfig`, tested):
  the client says it supports it; an adapter's request (debugpy's subprocesses, any adapter's
  child targets) starts a child session with the adapter's configuration as it is (the parent's
  type, so a new adapter process of the same debugger; its `debugAdapter`, `python`,
  `dlvToolPath` come along), under its parent in the call stack, with its own debug console,
  stopped with the parent (kind `adapterChild`). A failure goes back to the adapter as the
  request's error.
- **Disassembly view** (D229, `disassembly.ts`, `disassemblyModel.ts` tested): a dock tab
  (`disassembly`, `debug.openDisassembly`) on the paused frame's instruction that follows the
  focused session's selected frame: address, bytes, instruction, symbol and source line, the
  current one marked; more instructions load when it scrolls to either end (DAP `disassemble`
  from the first / last one loaded; placeholders and duplicates dropped, at most 4000 rows). A
  click in its margin toggles an instruction breakpoint (`debug.toggleInstructionBreakpoint`,
  DAP `setInstructionBreakpoints`; listed in Breakpoints; kept while the IDE runs, not saved).
  While it has the focus, F10 / F11 / Shift+F11 step one instruction (`granularity:
  "instruction"`, where the adapter reports `supportsSteppingGranularity`); the step commands
  take `granularity` too.

**Several sessions, child processes, more breakpoint kinds (D204):**
- `controller.ts` keeps every `RunningSession` (its state, threads, frames, scopes, exception,
  capabilities) and which one is focused; `state`, `frames`… are the focused session's, so the
  views and commands act on it. `sessionModel.ts` (tested) — the tree (children under parents),
  focus after an end, threads after stops and continues. `compounds.ts` (tested) — launch.json
  `compounds`, `stopAll`; `debug.restart` keeps a compound's stopAll after its last session ended
  (D207). `presentation.ts` (tested) — `presentation` (hidden / group / order) of configurations
  and compounds: the picker's order and separators, as VS Code's. `launchers.ts` — making each kind of session (Node, a package
  manager's script, browser, DAP over stdio or TCP, a registered child process, a worker).
- `autoAttach.ts` (tested) — NODE_OPTIONS=--require the bootloader (Rust:
  `src-tauri/src/debug/bootloader.js`, `autoattach.rs`): a debugged Node program's child
  processes and a JavaScript debug terminal's programs register and wait for the IDE. Workers
  come through the parent's inspector (`cdp.ts`, NodeWorker).
- `otherBreakpoints.ts` (tested) — function breakpoints (kept), data breakpoints (per session),
  exception-filter choices. `exceptionInfo.ts` (tested) — the exception widget's model, the
  adapter's filters. `cdp.ts` `findFunctionDeclarations` (tested) — Node's function breakpoints,
  placed in each script as it's parsed (D280: not by pausing before every script, which made V8
  end a program with worker threads).
- `callStack.ts` — sessions, threads and frames; `breakpointsView.ts` — Breakpoints with
  filters, function and data breakpoints; `loadedScripts.ts` — Loaded scripts.
- `serverReady.ts` (tested) — `serverReadyAction`; `processes.ts` (tested) — the process picker;
  `snippets.ts` (tested) — "Add configuration…". `sessionCommands.ts` — their commands.
- Presets: `go` (Delve, DAP over a local port), `coreclr` (netcoredbg); `java` explains what's
  needed. The browser pane (Windows, WebView2's port): `debug.attachToBrowserPane`.

The editor draws breakpoints and the stopped line (`editor/debugMarks.ts`, engine
`setBreakpoints` / `setExecutionLine`, glyph margin), reports margin clicks, right-clicks and
moved lines, and shows values on hover while paused (`setDebugHover`, `editor/hoverExpression.ts`).

**Commands:** `debug.start {name?, program?, configuration?}` (F5; `configuration` is a whole
launch.json-shaped configuration, e.g. Testing's Debug test, D204), `debug.runWithoutDebugging` (Ctrl+F5),
`debug.continue` (F5 while paused), `debug.pause` (F6), `debug.stepOver` (F10), `debug.stepInto`
(F11), `debug.stepOut` (Shift+F11), `debug.stop` (Shift+F5), `debug.restart` (Ctrl+Shift+F5),
`debug.toggleBreakpoint` (F9), `debug.setBreakpoint {condition, hitCondition, logMessage}`,
`debug.editBreakpoint`, `debug.editBreakpointCondition`, `debug.addConditionalBreakpoint`, `debug.addLogpoint`,
`debug.removeBreakpoint`, `debug.removeAllBreakpoints`, `debug.setBreakpointEnabled`,
`debug.toggleAllBreakpoints`, `debug.toggleUncaughtExceptions`, `debug.toggleCaughtExceptions`,
`debug.runToCursor` (Ctrl+F10), `debug.setVariable`, `debug.addWatch`, `debug.editWatch`,
`debug.removeWatch`, `debug.removeAllWatches`, `debug.selectFrame`, `debug.variables`,
`debug.evaluate`, `debug.listConfigurations`, `debug.openLaunchJson`,
`debug.showView` (Ctrl+Shift+D), `debug.showConsole` (Ctrl+Shift+Y), `debug.clearConsole`.
D204: `debug.start {compound}`, `{session, threadId}` on continue / pause / step / stop /
restart / selectFrame, `debug.focusSession`, `debug.selectThread`, `debug.stopAll`,
`debug.addFunctionBreakpoint`, `debug.removeFunctionBreakpoint`,
`debug.setFunctionBreakpointEnabled`, `debug.addDataBreakpoint` ("Break on value change"),
`debug.removeDataBreakpoint`, `debug.setDataBreakpointEnabled`, `debug.setExceptionFilter`,
`debug.exceptionInfo`, `debug.createJavaScriptDebugTerminal`, `debug.addConfiguration`,
`debug.listProcesses`, `debug.pickProcess`, `debug.installAdapter`, `debug.loadedScripts`,
`debug.openDisassembly`, `debug.attachToBrowserPane`. D229: `debug.toggleInstructionBreakpoint
{address?}`, `debug.setInstructionBreakpointEnabled {address, enabled}`, `granularity` on
`debug.stepOver` / `stepInto` / `stepOut`. m7-32: `debug.addTriggeredBreakpoint {path?, line?,
triggeredBy?}`, `triggeredBy` on `debug.setBreakpoint`, `what: "triggeredBy"` on
`debug.editBreakpoint`, `debug.stepIntoTarget {targetId?, list?, session?}`,
`debug.restartFrame {index?, session?, threadId?}`.
**Context keys:** `inDebugMode` (any session), `debugState` (the focused one's),
`stepIntoTargetsSupported`, `restartFrameSupported` (the focused one's debugger). **State:**
`ide://debug` (the focused session, plus `sessions` (with `canStepIntoTargets`,
`canRestartFrame`), `functionBreakpoints`, `dataBreakpoints`,
`instructionBreakpoints`, `disassembly` (the open view: current address, rows, the lines
around it), `exceptionFilters`, `exception`, `inlineValues` (`{ path, lines: [{ line, text }] }`
while shown); breakpoints have `triggeredBy`, `triggeredIn`, `waiting`; frames `canRestart:
false` where they can't). **Settings:** `debug.pythonPath`, `debug.lldbDapPath`,
`debug.gdbPath`, `debug.dlvPath`, `debug.netcoredbgPath`, `debug.openDebugConsole`,
`debug.toolBarLocation`, `debug.javascript.autoAttachFilter`, `debug.browserPane.debuggingPort`,
`debug.inlineValues`.
The program paths (`debug.pythonPath`, `lldbDapPath`, `gdbPath`, `dlvPath`, `netcoredbgPath`) are
user settings only (D207): a folder can't choose the program the debugger runs.
**Tests:** `debug.test.ts`, `editor/hoverExpression.test.ts`, `src-tauri/src/debug` (unit),
`tests/scripts/debug-m6-42.jsonc`, `tests/scripts/debug-m6-44.jsonc`, `sessions.test.ts` and `tests/scripts/debug-m7-5.jsonc` (D204, with `tests/fixtures/setup/mock-dap.mjs`, a scripted DAP adapter), `childLaunch.test.ts`, `disassemblyModel.test.ts`, `tests/scripts/debug-m7-8.jsonc` (D229),
`triggers.test.ts`, `inlineValues.test.ts`, `tests/scripts/debug-extras-m7-32.jsonc` (m7-32).

**Browser pages (D196):** `browser.ts` (tested) — launch.json `chrome` / `msedge` (and `pwa-*`)
configurations. Launch starts Chrome or Edge (`runtimeExecutable`, else where it usually is) in a
terminal tab with `--remote-debugging-port` and a profile in the IDE's folder
(`browser-profile`, git-ignored; `"userDataDir"` changes it, `false` drops it), attaches to its
page through `/json/list`, then navigates to `url` so breakpoints are set first. Attach takes
`port` (default 9222) and the page whose address starts with `url`. Script URLs map to files
through `webRoot`, `pathMapping`, Vite's `/@fs/` and `webpack://` sources; source maps served by
a local dev server are read through Rust (`debug_local_get`, local addresses only). The page's
console goes to the debug console; navigation keeps the session; closing the page ends it. The
same `CdpSession` as Node (`cdp.ts`, its `page` host part). Test:
`tests/scripts/debug-browser-m6-97.jsonc` (headless Chromium).

**Multi-root workspaces (D251).** `configurations.ts` reads every folder's launch.json and the
workspace file's `launch`; a folder's configurations and compounds are named with it
("Launch (api)", `plainName` keeps "Launch"; the workspace file's "All (workspace)") and carry
their `workspaceFolder` (their `${workspaceFolder}`, the default cwd, the browser's webRoot and
profile, the adapter's cwd, preLaunchTask / postDebugTask looked up in that folder first).
Compounds name configurations as `"Name"` (the compound's own folder first), `"Name (folder)"` or
`{ name, folder }` (`compoundMember`, `findCompound`, `findConfig` in `compounds.ts`; with one
folder the folder field is ignored, as before). `debug.openLaunchJson {folder?}` and
`debug.addConfiguration {snippet?, folder?}` take a folder (else the editor's, else asked);
extensions' `provideDebugConfigurations` get that folder. Loaded scripts in any folder are "own".
`debug.listConfigurations` adds `folder`. Configurations are named with their folder only with
several folders (as VS Code), so going from one folder to two and back renames them; nothing
stored keeps a configuration's name (the view's pick is its own, kept when the list reloads with
the same name only), and with one folder a compound's missing entry is named as written.
`debug.attachToBrowserPane {tab?, folder?}` maps the page to the named folder, else the active
editor's, else the first. Tests: `folders.test.ts`.

**Triggered breakpoints, step into target, restart frame, inline values** (VS Code's, m7-32):
- **Triggered breakpoints** (`triggers.ts`, tested): a breakpoint with `triggeredBy` (another
  breakpoint's id) waits until that one is hit in a session, as VS Code's "Add triggered
  breakpoint…" / "Wait for breakpoint": the IDE keeps it out of what it sends a session
  (`breakpointSync.ts` `enabledByPath(rs)`) until a stop there hits the trigger (the debugger's
  `hitBreakpointIds`, mapped back to the IDE's ids by `DapSession` and `CdpSession`; without
  them a "breakpoint" stop on the trigger's line), then sends it to that session only (before
  any resume: stepping waits for the sync). A session's end resets it (`triggeredIn` is per
  session, not saved); the link is saved as the trigger's place. Removing the trigger makes it a
  plain breakpoint; a loop can't be picked. Drawn with the conditional mark, hollow while it waits
  in a running session (a dedicated pending glyph needs a state in `workbench/debugMarks.ts`);
  Breakpoints shows "after file:line" and a dashed dot while it waits. Results line up with the
  ids sent to each session (`RunningSession.sentIds`), so a waiting breakpoint is neither placed
  nor not.
- **Step into target** (`stepTargets.ts`, tested): where the debugger reports
  `supportsStepInTargetsRequest` (context key `stepIntoTargetsSupported`; debugpy, lldb-dap,
  GDB), the editor's menu while paused has "Step into target": DAP `stepInTargets` for the top
  frame, the call under the cursor when the debugger gave ranges, else a quick pick, then `stepIn`
  with `targetId`. Node's inspector has no such request (not offered).
- **Restart frame**: where the debugger reports `supportsRestartFrame` (`restartFrameSupported`)
  and the frame doesn't say `canRestart: false`, a frame's menu and its row's button in the call
  stack. DAP `restartFrame`; Node and browsers through `Debugger.restartFrame` (mode
  "StepInto", V8 10.4+): it stops at the function's start, reason "restart".
- **Inline values** (`inlineValues.ts` tested, `inlineValuesView.ts`): setting
  `debug.inlineValues` ("on" | "off" | "auto", default "auto"). While paused, `name = value`
  after the lines of the selected frame's file from each scope's start to the stopped line, VS
  Code's generic matcher: the frame's most specific cheap scopes (by the scopes' lines where the
  debugger gives them), names matched against the words of the code (comments and strings
  skipped per language), the narrowest scope first, 100 names, 150 characters, lines over 500
  characters skipped; cleared 100 ms after running again. "auto" covers the languages the
  built-in debuggers debug (VS Code's needs an InlineValuesProvider, which nothing registers
  here). Up to 2000 lines above the stop (VS Code: the viewport). Drawn as a decoration set of
  the debugger's (`extensionFeatures.setDecorations`, type id 2000000: the text's class is
  `ext-dt-2000000-after`) in `--debug-inline-value-fg` / `-bg` (themes' `editor.inlineValues*`).

`extensionEvents.ts` (D255): what extensions see of the debugger: IDE events when a session
starts, ends or is focused (with its resolved configuration, parent and folder), when its adapter
sends an event the protocol doesn't define (`debug.didReceiveCustomEvent`, VS Code's custom
events; `session.ts` `DAP_EVENTS` lists the standard ones), when the focused thread or frame
changes (`debug.didChangeActiveStackItem`) and when line or function breakpoints change
(`ide.debug.onDid…`); and hidden commands: `debug.customRequest` (a DAP request to a running
session, waiting while it starts), `debug.protocolBreakpoint` (getDebugProtocolBreakpoint) and
`debug.appendToConsole` (activeDebugConsole). `debug.start` takes VS Code's DebugSessionOptions
(`parentSession`, `consoleMode`, `lifecycleManagedByParent`, `noDebug`, `folder`).

`resolution.ts` (D295): a configuration is resolved in VS Code's order before it starts, whatever
debugger runs it: every extension's `resolveDebugConfiguration` for its type, then for `*`
(again for a type a resolver changes it to, `onDebugResolve:<type>` activated first), on the
configuration as written (`LaunchConfig.unresolved`); then variables; the preLaunchTask;
`resolveDebugConfigurationWithSubstitutedVariables` (type, then `*`). null cancels quietly. An
extension's adapter is asked with the controller's own session id and gets the configuration
without the IDE's defaults (`args`, `stopOnEntry`, `console`); every DAP launch carries
`__sessionId`. `pythonDebug.ts`: the built-in Python debugger takes the interpreter as the
language server does (`python.defaultInterpreterPath`, else the folder's .venv / venv / env),
loads `envFile` (default `${workspaceFolder}/.env`) into `env`, and puts ms-python.debugpy's
bundled `debugpy` on the adapter's PYTHONPATH when that extension is installed.

# headless

The logic layer without a window: the dispatcher, the `ide://` state tree, settings, the
workspace, events and the built-in extensions' logic, started in a JavaScript runtime that has no
page (Node), and on top of it the agent as a brain a front end drives. `boot.ts`, `services.ts`
and `brain.ts` import no view code (`src/ui`, `core/dom`, an extension's views):
`node scripts/check-headless-imports.mjs` and a test walk their imports and fail if one does.
No command line here: that is built on `run.ts`.

| File | What |
|---|---|
| `boot.ts` | The screenless session: services, extensions, settings, the folder. |
| `services.ts` | The services a screen draws, for a session that has none; what it saves. |
| `extensions.ts` | The built-ins a brain activates, and why the others are left out. |
| `brain.ts` | The agent with no window: commands as a front end, state, chats, events, limits. |
| `run.ts` (Node) | The headless build's entry: `openBrain`, `runHeadless`. |
| `node/hostBackend.ts` (Node) | The host program as the backend. |
| `node/workers.ts` (Node) | Worker threads for workflow scripts. |
| `fakeBackend.ts`, `memoryHost.ts` | Tests' backends. |

## boot.ts

`bootHeadless(options) → Promise<HeadlessSession>` follows the window's boot (`src/main.ts`) and
leaves out what paints: connect the backend, build the services with
`workbench/createServices.ts` and the screenless implementations, register the extensions'
keybindings, settings and language servers, activate them, load the saved state and the settings,
open the folder.

- `HeadlessBootOptions`: `backend` (a `HeadlessBackend`: `connect()` makes the call layer reach a
  backend and returns a disposable that disconnects it), `extensions` (the built-ins to activate,
  from `src/extensions/builtins.ts`; the entry is handed the list so it doesn't import the views
  behind it), `folder`, `policy` (who answers questions; default: everything is declined),
  `backendPlatform` (default: the backend's app info).
- `beforeActivate(services)`: called once the services exist and before any extension
  activates (the brain sets the agent's host and the run's settings there).
- A connection may have `close()` (a host process shutting down in order): the session's
  `dispose` awaits it.
- `HeadlessSession`: `services` (the whole `WorkbenchServices`), `screenless` (the screenless
  services by their own types), `extensions` (each activation's outcome), `folder` /
  `folderError`, `dispose()`.
- An extension that fails to activate doesn't stop the others, as in the window.
- One session per JavaScript realm: the call layer and the reactive core are module-level state.

## services.ts

`screenlessImplementations(options)` gives `createServices` what a window would:

| Service | Without a screen |
|---|---|
| notifications (`HeadlessNotifications`) | Kept in `history` (what `ide://notifications` reads) and told through `onDidShow`; `activeProgress` lists work under way. A notice with buttons is answered by `NotificationPolicy.choose` or closed at once, so nothing waits on a click. |
| quick input (`HeadlessQuickInput`) | No picker. `QuickInputPolicy.pick` / `prompt` answer; without them the question rejects with a `NeedsScreenError` that names it. `asked` lists the questions. A session an extension opens is dismissed at once. |
| status bar (`HeadlessStatusBar`) | Holds the items (`ide://statusbar`); draws nothing. |
| theme (`HeadlessTheme`) | Holds the look the settings give; `token()` knows only overrides, `color()` is null. |
| trust (`policyTrustPrompts`) | `TrustPolicy` answers the three questions; default: declined, nothing remembered. |
| keyboard | The window's `KeyboardService`, never attached: rules and labels only. |
| settings | The window's `SettingsService` without a first-paint cache. |
| file decorations | No frames: each change counts at once. |
| saved state | See "What a session saves" below. |
| auxiliary windows, iframes, dragging | Inert: nothing to find, and making one throws a `NeedsScreenError`. |
| permissions | `HeadlessPolicy.confirm` / `askMcp` decide; an agent's requests go to the handler the agent extension sets (`workbench/agentPermission.ts`). Default: declined. |

Everything else (dispatcher, context, state, events, layout model, view registry, dock model,
persistence, workspace, the registries) is the same object the window gets. Views are registered
and never made; a command that needs one fails with a message that says a screen is needed.

## What a session saves

- **The open workspace's state** (the dock's tabs and layout, scroll positions, the review mode
  last chosen): read, never written. It is the window's.
- **The global state**: written as the window writes it, except the window's own keys
  (`WINDOW_GLOBAL_KEYS`: `lastFolder`, `recentFolders`, `pinnedFolders`, `recentCommands`,
  `hiddenNotices`, `hideImportLink`, `ui`), which stay as the file has them (`keepWindowKeys`):
  a run that opens a folder doesn't put it in the app's recent folders or make the app reopen
  it. Trust decisions, the external agents' remembered settings, hand-offs between agents and
  the like are shared with the app.
- **Chats**: saved where the app saves them (the backend's session store, per profile), so the
  app lists a run's chats and a run continues the app's.
- **Settings files**: only by commands that write settings (`settings.set`, an "always allow").
  What a run is told (its model, access mode, limits) is held above the files for the run only
  (`SettingsService.setOverrides`) and never written.
- **The audit log**: every command, as in the window (the caller reads `frontend:<name>`).

## extensions.ts

`headlessExtensions()`: workbench (its screenless form), explorer, editor, tasks, terminal,
settings, search, mcp, git, accounts, and the agent's setup without its views
(`agentCoreExtension`). Left out: palette, quickOpen, keybindings, bookmarks, viewers, help,
history (views and pickers), browser, debug, testing (panes of the window), windows (the window
registry, absent in the host), remote, extensions (web workers of a page), languageServers and
lsp (diagnostics come from a window's editor documents). The file's header says why for each.

## brain.ts

`startBrain(options) → Promise<Brain>` boots a session with the agent's host set for nobody at
a screen (`headlessAgentHost({ prompts, workers, permissions })`) and resolves once the agent
is there.

- `BrainOptions`: `backend`, `extensions`, `folder`, `frontend` (the caller's name, "cli"),
  `permissions` (an `UnattendedPolicy`, extensions/agent/unattended.ts; default
  `{ otherwise: "deny" }`), `settings` (for this run only), `workers`, `ideServer` (default
  false: `mcp.enabled` and `mcp.claudeCode.enabled` are held off for the run; an external agent
  of a chat still borrows the IDE's MCP server), `trustFolder`, `policy` (the services'
  own questions). `git.autofetch` is held off.
- `Brain`: `services`, `boot`, `caller` (`{ kind: "frontend", name }`), `agent` (sessions,
  providers), `prompts` (waiting host prompts), `execute(command, input)` (as the front end),
  `state(path)`, `override(settings)`, `chats()` (`SavedChat[]`, newest first), `open(options)`,
  `dispose()` (stops and saves every chat, then ends the backend).
- `open({ session?, continue?, model?, agentModel?, agentLevel?, chatMode? }) → BrainChat`:
  a saved chat, the folder's newest, or a new one; the model is this chat's only.
- `BrainChat`: `id`, `session`, `onEvent(listener)` (`SessionEvent`s,
  extensions/agent/sessionEvents.ts), `send(prompt, limits?) → RunResult`, `stop(reason?)`.
  `send` goes through `agent.send` and resolves when the chat is at rest (the turn, queued
  messages, background helpers and workflows, their reports).
- `RunLimits`: `maxSteps` (the app's `agent.maxSteps`, for the run), `maxCost` (dollars this
  run may spend), `timeoutMs`, `signal`. Each stops the turn as Stop does.
- `RunResult`: `session`, `text`, `reason` (`end`, `stopped`, `max_steps`, `error`,
  `timeout`, `max_cost`, `cancelled`), `error?`, `usage`, `steps`, `cost`, `denied`
  (`PermissionDecision[]`), `pending` (files waiting for review), `command?` (a slash
  command's own result).

## run.ts, node/ (Node only)

Excluded from `tsconfig.json` (no Node types there) and checked by `tsconfig.test.json`.

- `openBrain(options) → Promise<HostedBrain>`: starts the host program (`hostBinary`,
  `userDataDir`, `onHostLog`, `env`), installs its transport and starts a brain over it with
  worker threads for workflows (`workerDirectory`, default: the bundle's own folder).
  `HostedBrain` adds `host` (the handshake's answer) and `onHostExit(listener)`.
- `runHeadless(options) → Promise<RunResult>`: one prompt, start to finish (boot, open or
  continue a chat, send, events to `onEvent`), then everything is shut down: the host is asked
  to stop once no call is waiting, and Node exits by itself.
- `node/hostBackend.ts` `hostBackend({ binary, userDataDir, args, env, onLog, onExit })`.
- `node/workers.ts` `nodeWorkers(directory)`: a `WorkerFactory` over `<script>.worker.mjs`
  (src/workers/node/: the worker script with a web worker's globals over the thread's port,
  and the process, module loaders and buffers taken away; not an engine-level sandbox).

## The build and its test

`node build.mjs --headless [--prod]` writes `dist-headless/` (git-ignored): `brain.mjs` (ES
modules for Node, with the chunks that load lazily) and `workflow.worker.mjs`. It never touches
`dist/`. The extensions' view code is bundled where their modules import it and never runs;
stylesheets, fonts and images are left out.

`node scripts/headless-e2e.mjs [--host <ide-host>]` runs the bundle over the real host against
the fixtures' scripted model server (its own port, a scratch workspace and profile beside the
repository): a one-shot turn that writes a file and runs a command under an allow list, a
permission refused by policy and by the deny list, a saved chat continued in a second process,
a front end answering a question as the person, an external agent over ACP with the IDE's
tools, an MCP tool, a workflow script, a time limit, and a failure to start. Each scenario's
process must end by itself.

## fakeBackend.ts, memoryHost.ts (tests)

`fakeBackend(commands)` is a `HeadlessBackend` answered by handlers in this process: a transport
installed with `setTransport`, so no `window` or `document` exists and a test asserts the logic
layer never touched the screen by their absence. `memoryHost(options)` is a small backend kept in maps (app info, saved state, settings
files, a file tree) with the commands a session needs to start and open a folder.

`run.ts` also re-exports the types a command line needs (`SessionEvent`, `UnattendedPolicy`,
`AccessMode`, `RunResult`…) and `onFailedCall` (every backend call that failed: a `--verbose`).

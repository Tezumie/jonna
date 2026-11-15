# headless

The logic layer without a window: the dispatcher, the `ide://` state tree, settings, the
workspace, events and the built-in extensions' logic, started in a JavaScript runtime that has no
page (Node). Nothing here imports view code (`src/ui`, `core/dom`, an extension's views): a test
walks the entry's imports and fails if one does. No command line and no agent wiring yet: those
are built on the session `bootHeadless` returns.

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
| saved state | The open workspace's is read and never written (it holds the window's layout); global state (trust, recent folders) is saved as the window saves it. |
| auxiliary windows, iframes, dragging | Inert: nothing to find, and making one throws a `NeedsScreenError`. |
| permissions | `HeadlessPolicy.confirm` / `askMcp` decide; an agent's requests go to the handler the agent extension sets (`workbench/agentPermission.ts`). Default: declined. |

Everything else (dispatcher, context, state, events, layout model, view registry, dock model,
persistence, workspace, the registries) is the same object the window gets. Views are registered
and never made; a command that needs one fails with a message that says a screen is needed.

## fakeBackend.ts, memoryHost.ts (tests)

`fakeBackend(commands)` is a `HeadlessBackend` answered by handlers in this process: a transport
installed with `setTransport`, so no `window` or `document` exists and a test asserts the logic
layer never touched the screen by their absence. `memoryHost(options)` is a small backend kept in maps (app info, saved state, settings
files, a file tree) with the commands a session needs to start and open a folder.

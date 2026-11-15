# extensions/sync

Sync (D435): the account's settings, the user's own files (keybindings, snippets, the rules file,
agents, commands, output styles, skills), the chats of the projects that sync and snapshots of
their unfinished work, on every computer of the account. Everything is sealed on this computer
before it leaves (Rust `src-tauri/src/sync`, typed calls in `core/ipc/sync.ts`); the engine, the
merge rules, the layers and the history rules are `core/sync` (DOM-free, tested). Open only to
accounts whose profile says `sync: true`. Window only: a screenless session doesn't sync.

- `controller.ts` — `SyncController`: where sync stands (`status`), the loop's passes
  (`activity`; one window of a profile writes, the others read), the open project (`project`) and
  its snapshots (`snapshots`), what the account holds (`overview`, recomputed after each pass from
  the records' labels: no content), and what sync did lately (`log`, the last 30 events, in memory
  only; `note()` adds one). Also: the storage notifications (once per run at 80% and 95%), a last
  snapshot as the window or folder closes (`snapshotOnClose`: only when something changed, 4
  seconds at most), and the account's projects (`linkProject`, `separateProject`, `copiedFrom`,
  `deleteProjectFromAccount`). No view code.
- `session.ts` — `SyncSession`: the account as last read, the step the tab shows (the recovery
  key on show, or asked for), this computer's own name for the name field, and the two things
  that never go through a command's input or result, state or a log: the recovery key while
  shown, and what the person types back.
- `commands.ts` — the commands. The ones that handle keys, approve or remove a computer, or
  change the folder's files or the account's projects are hidden from agents and ask in a dialog
  themselves.
- `view.ts` — the Sync tab (`sync`, a singleton in the main area; styles in
  `src/styles/sync.css`): sign in / not open / turn on (the recovery key to keep and confirm) /
  join (waiting, then the code to compare once another computer checks this one; or the recovery
  key) / on. On, top to bottom: the state with when it last synced and Sync now (the reason and
  Retry after an error); In your account (settings, your files by kind, chats without a folder,
  and each project by name with its chats, snapshots, latest snapshot's size, last change and
  computer, whether it is on this computer, and a menu); This project (snapshots, how long they
  are kept, or Sync this project / This folder is one of my synced projects); Storage; Computers
  (a waiting one: Check code, then the code with Approve); Recovery key; What syncs; Recent
  activity; what the service can see, the account page and Turn off. Its buttons run commands;
  copying and saving the recovery key go straight to the clipboard and the save dialog, so the
  key stays out of the audit log.
- `model.ts` — DOM-free and tested: the words both share (sizes, the status line, the privacy
  line), `buildOverview` (the account's records as an overview), the user's files by kind, the
  storage notices, the retention sentence, the status bar's words, the activity log.
- `index.ts` — `syncExtension`: one controller; a pass after the workspace is restored, on window
  focus (at most every 2 minutes), after signing in or out, when sync comes on, and when the open
  folder changes; the status bar item; the last snapshot on close (`workspace.onWillClose`, never
  cancels closing).

**Exports:** `syncExtension` (`index.ts`), `SyncController` (`controller.ts`).

**Commands:** `sync.show`, `sync.turnOn {name?}`, `sync.join {name?}`, `sync.useRecoveryKey`,
`sync.closeStep`, `sync.reviewDevice {device}` (starts checking a waiting computer: both then show
the code), `sync.approveDevice {device}` (only after `sync.reviewDevice`), `sync.removeDevice
{device}`, `sync.turnOff`, `sync.newRecoveryKey`, `sync.syncNow`, `sync.project.enable` (a copied
folder is asked about first: the same project, or one of its own), `sync.project.disable`,
`sync.project.link {id?}` (the open folder becomes one of the account's projects that isn't on
this computer; without `id`, pick one), `sync.project.deleteFromAccount {id}` (the project's
snapshots and its chats' synced copies leave the account; nothing on a computer is deleted),
`sync.snapshot.create`, `sync.snapshot.continue`, `sync.snapshot.restore {id}`,
`sync.snapshot.restoreFile {id, path?}` (without `path`: pick one of the snapshot's files),
`sync.snapshot.pin {id, name?}` (`name` null unpins; without it, asks), `sync.snapshot.delete
{id}`, `sync.openAccountPage`. Each fails with one sentence when nobody is signed in or sync isn't
open to the account. None takes or returns a recovery key or a verification code.

**Status bar:** `sync.status` (right): Synced / Syncing… / Offline / Sync (another window is
syncing, or before the first pass) / Sync error (the reason is the tooltip; the only colored
state) / Waiting (for approval). Absent unless sync is open to the account and on or pending
here. Runs `sync.show`.

**Settings:** `sync.settings`, `sync.keybindings`, `sync.snippets`, `sync.rules`, `sync.agents`,
`sync.commands`, `sync.outputStyles`, `sync.skills`, `sync.chats`, `sync.snapshots` (what syncs,
all on), `sync.ignoredSettings`, `sync.historyDays` (30; days the project was worked on, 0 keeps
everything), `sync.snapshotScope` (`remote` | `everything`), `sync.projects` (managed by the IDE).

**State:** `ide://sync` — `available`, `state`, `device`, `devices` (a waiting one's
`codeChecked`, never its code), `recoveryKeySet`, `usageBytes`, `storageLimit`, `activity`,
`overview` (`settings {count, updatedAt}`, `files [{path, bytes, updatedAt}]`, `accountChats`,
`projects [{id, name, chats, snapshots, snapshotBytes (the latest snapshot's), lastChange,
lastComputer, here, folder}]`), `recent` (`[{at, text, error}]`), `project`, `snapshots`. Never
the recovery key, a verification code or any content.

**UI test:** `tests/scripts/sync-m7-129.jsonc` (nobody signed in); the backend flows:
`scripts/sync-e2e.mjs`.

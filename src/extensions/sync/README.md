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
  only; `note()` adds one). Also: the storage notifications (once per run at 80% and 95%; their button opens the Storage
  page), a notification when a computer asks to join (once per run and computer; its button
  opens Computers), a last
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
- `view.ts` — the Sync tab (`sync`, a singleton in the main area), laid out like the Settings
  tab and on its frame (`settings.css`: navigation on the left, an icon rail under 640px; cards;
  `src/styles/sync.css` has the inside of the pages). Before sync is on it is one focused pane
  without the navigation: sign in / not open / turn on (what sync brings, then the recovery key
  to keep and confirm) / join (waiting, then the code to compare once another computer checks
  this one; or the recovery key). Once on, the pages (`pages.ts`). The arrows, Home and End move
  along the navigation; the open page is kept in the tab's saved state. Its buttons run commands;
  moving between its own pages is the view's (as in Settings; `sync.show {page}` for everything
  else), and copying and saving the recovery key go straight to the clipboard and the save
  dialog, so the key stays out of the audit log.
- `pages.ts` — the pages while sync is on, each a few cards:
  - `overview`: the state with when it last synced and Sync now (the reason and Retry after an
    error); Continue from another computer when there is newer work; tiles (projects, chats,
    snapshots, computers, storage with its meter), each opening its page; Needs attention (a
    waiting computer, storage filling up, the open folder not synced), only when there is
    something; the last five things sync did.
  - `projects`: the open folder (Sync this project / Snapshot now, Stop syncing, This folder is
    one of my synced projects); every project of the account by name, and the picked one's
    detail beside the list (from 1000px; under that the detail takes the list's place, with a
    way back): its facts, the open project's snapshot history by day (Restore, Show files, Pin,
    Delete) with how long it is kept, how to get a project that isn't here, and Delete from the
    account in its menu.
  - `content`: what this computer syncs (the switches), with what the account holds of each
    beside it and a kind's file names on demand; the settings that stay on this computer.
  - `computers`: computers waiting to join (Check code, then the code with Approve), this
    computer and the others (Remove), how to add one, Turn off sync on this computer.
  - `security`: the recovery key, what the service can see and can't read, what a reset loses.
  - `storage`: used of the limit with the 80% / 95% lines, the latest snapshot's size per
    project, the history settings with their values, how to free space.
  - `activity`: everything the log holds, newest first.
- `model.ts` — DOM-free and tested: the words both share (sizes, the status line, the privacy
  line), `buildOverview` (the account's records as an overview), the user's files by kind, the
  storage notices, the retention sentence, the status bar's words, the activity log, and the
  pages' parts: their ids and titles, the overview's tiles, the attention list, what the account
  holds of a kind, sizes by project, snapshots grouped by day.
- `index.ts` — `syncExtension`: one controller; a pass after the workspace is restored, on window
  focus (at most every 2 minutes), after signing in or out, when sync comes on, and when the open
  folder changes; the status bar item; the last snapshot on close (`workspace.onWillClose`, never
  cancels closing).

**Exports:** `syncExtension` (`index.ts`), `SyncController` (`controller.ts`).

**Commands:** `sync.show {page?, project?}` (`page`: overview, projects, content, computers,
security, storage, activity; `project` shows that project's detail), `sync.turnOn {name?}`, `sync.join {name?}`, `sync.useRecoveryKey`,
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
here. Runs `sync.show {page: "overview"}`.

**Settings:** `sync.settings`, `sync.keybindings`, `sync.snippets`, `sync.rules`, `sync.agents`,
`sync.commands`, `sync.outputStyles`, `sync.skills`, `sync.chats`, `sync.snapshots` (what syncs,
all on), `sync.ignoredSettings`, `sync.historyDays` (30; days the project was worked on, 0 keeps
everything), `sync.snapshotScope` (`remote` | `everything`), `sync.projects` (managed by the IDE).

**State:** `ide://sync` — `available`, `state`, `device`, `devices` (a waiting one's
`codeChecked`, never its code), `recoveryKeySet`, `usageBytes`, `storageLimit`, `activity`, `page` (the page the tab shows while sync is on),
`overview` (`settings {count, updatedAt}`, `files [{path, bytes, updatedAt}]`, `accountChats`,
`projects [{id, name, chats, snapshots, snapshotBytes (the latest snapshot's), lastChange,
lastComputer, here, folder}]`), `recent` (`[{at, text, error}]`), `project`, `snapshots`. Never
the recovery key, a verification code or any content.

**UI test:** `tests/scripts/sync-m7-129.jsonc` (nobody signed in); the backend flows:
`scripts/sync-e2e.mjs`.

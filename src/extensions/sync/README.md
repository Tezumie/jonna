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
  opens Computers), the open project's name written to the account again when its entry has none the service can read (`nameProject`, after a pass; a failed write is noted in the log), a last
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
  - `overview`: three cards of one width: the state with when it last synced and Sync now (the
    reason and Retry after an error), the counts (projects, chats, snapshots, computers: one
    row of stats, two by two when narrow, each opening its page), and storage with its meter;
    Continue from another computer when there is newer work; Needs attention (a waiting
    computer, storage filling up, the open folder not synced), only when there is something;
    the last five things sync did.
  - `projects`: every project of the account by name (one tag, then chats, snapshots and when
    it changed on one line; the open folder's is marked Open here and shown first), and the
    picked one's detail beside the list (from 1000px; under that the detail takes the list's
    place, with a way back): its name, tag and folder with Snapshot now (the open folder's) and
    a menu (Stop syncing, Delete from the account), its numbers (chats, snapshots, last change
    and where: "on this computer" for this one), the open project's snapshot history by day
    (Restore, Show files, Pin, Delete) with how long it is kept, and how to get a project that
    isn't here. A card for the open folder shows only while it doesn't sync (Sync this project,
    This folder is one of my synced projects). A snapshot without files says "no changed
    files", never "0 B".
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

**How the loop keeps things safe** (the rules are `core/sync`'s; the controller wires them):

- Nothing is deleted on absence. Chats: only the ids `syncIpc.chatsDeleted()` names are deleted
  from the account (forgotten with `chatsDeletedClear` once told); with `sync.chats` off the
  chats layer doesn't run at all. Files: a name the scan lists as `kept` is left as it is, and a
  scan that isn't `complete` deletes nothing either way. Settings: a missing settings file has
  no opinion (the account's settings apply; nothing is told to the account).
- A record sealed with keys this computer doesn't hold yet stops the reading there
  (`engine.blocked`): the layers don't run and nothing is written over it. The controller reads
  the status at once (that fetches keys) and reads again; still blocked, the status line says
  "Waiting for this computer's keys to catch up".
- A chat is fetched only over the chat as the pass saw it (`ifStamp`); a conflict asks
  `chatSame` first, forks once (the forked version is kept in the base before the upload), and
  each finished transfer is saved at once.
- One window holds the loop: its claim is renewed every 30 s while a pass runs, and a renewal
  that fails ends the pass after the action under way. A window that takes the loop over reads
  the bases from disk again and keeps what it read of the account.
- No connection, or the service asking to slow down: the timer waits 1, 2, 5, then 10 minutes.
  Every way a pass ends leaves a final state (never "syncing").
- Snapshots: one call at a time; after a look that found nothing, the next is due after
  `max(3 min, 40 × how long the look took)`; history is pruned after a snapshot, on Snapshot
  now, and when storage is full; an earlier day keeps each computer's last snapshot.
- Settings that run programs or point at this computer's paths never sync
  (`core/sync/localSettings.ts`), besides `sync.ignoredSettings`.
- What is shown (names, counts, sizes, who changed what) comes from sealed text; a record's
  label stands in only when its text isn't here, and never marks anything deleted.
- The layers report conflicts (a chat forked, a file kept as `name.conflict.ext`) and items that
  couldn't sync; they show in the activity log.
- Folders in `sync.projects` that are gone are found every 10 minutes (`foldersExist`) and shown
  as "Folder not found on this computer", with Forget this folder.
- Before a folder without git syncs, `snapshotEstimate` is asked: a large one (2,000 files,
  200 MB, or more than a snapshot holds) is confirmed first, with Choose what to leave out.
- After Check code, the status is asked for every 2 s (3 minutes at most) until the waiting
  computer's code is there; Approve shows only then.
- The plan (`planSituation` in `model.ts`, from the profile and the status): "offered" (the
  profile's `syncOffered`: the setup pane is an offer, See plans / I already subscribed),
  "lapsed" (the status's `lapsedUntil`, or the profile's `syncState` before the status was
  read) and "on"; "none" is as it was before sync was sold. While lapsed the pass only reads
  (`readOnlyPass`: no claim on the loop, no layer, snapshot, name or pruning), the activity is
  "lapsed" and is said once in the log, the tab shows the callout (Renew / Check again) and
  disables what writes with the reason; restoring a snapshot stays. A write the service
  refuses with `SyncLapsed`, from any call, reads the status again (`onSyncFailure`).
- Payment is never in the IDE: `sync.managePlan` opens `<accounts server>/account#plan` in the
  browser. Coming back to the window while offered or lapsed runs `sync.checkPlan` (30 s apart
  at most, never while a pass runs), which asks the server for the profile and reads the status.

**Exports:** `syncExtension` (`index.ts`), `SyncController` (`controller.ts`).

**Commands:** `sync.show {page?, project?}` (`page`: overview, projects, content, computers,
security, storage, activity; `project` shows that project's detail), `sync.turnOn {name?}`, `sync.join {name?}`, `sync.useRecoveryKey`,
`sync.closeStep`, `sync.reviewDevice {device}` (starts checking a waiting computer: both then show
the code), `sync.approveDevice {device}` (only after `sync.reviewDevice`), `sync.removeDevice
{device}`, `sync.turnOff`, `sync.newRecoveryKey`, `sync.syncNow`, `sync.project.enable` (a copied
folder is asked about first: the same project, or one of its own), `sync.project.disable`,
`sync.project.editIgnore` (opens the folder's `.syncignore`: what snapshots leave out),
`sync.project.rename {id, name?}` (the project's name in the account; no folder is renamed),
`sync.renameDevice {name?}` (this computer's name in the account's list),
`sync.project.forgetFolder {folder}` (stops syncing a folder from this computer: one that is
gone, or a project no longer wanted here; the account is untouched),
`sync.project.link {id?}` (the open folder becomes one of the account's projects that isn't on
this computer; without `id`, pick one), `sync.project.deleteFromAccount {id}` (the project's
snapshots and its chats' synced copies leave the account; nothing on a computer is deleted),
`sync.snapshot.create`, `sync.snapshot.continue`, `sync.snapshot.restore {id}`,
`sync.snapshot.restoreFile {id, path?}` (without `path`: pick one of the snapshot's files),
`sync.snapshot.pin {id, name?}` (`name` null unpins; without it, asks), `sync.snapshot.delete
{id}`, `sync.openAccountPage`, `sync.managePlan` (opens the account page's plan section in the
browser: subscribing, renewing, cancelling, cards, invoices, storage), `sync.checkPlan` (reads the
profile from the server and the status again; returns `{plan, state, lapsedUntil}`, `plan`: on,
lapsed, offered, none). Each fails with one sentence when nobody is signed in or sync isn't
open to the account (the two plan commands need only an account). What writes to the account
fails with one sentence while the subscription is ended. None takes or returns a recovery key or
a verification code.

**Status bar:** `sync.status` (right): Synced / Syncing… / Offline / Sync (another window is
syncing, or before the first pass) / Sync error (the reason is the tooltip; the only colored
state) / Waiting (for approval) / Sync ended (the subscription ended; not colored). Absent
unless sync is open to the account and on or pending here. Runs `sync.show {page: "overview"}`.

**Settings:** `sync.settings`, `sync.keybindings`, `sync.snippets`, `sync.rules`, `sync.agents`,
`sync.commands`, `sync.outputStyles`, `sync.skills`, `sync.chats`, `sync.snapshots` (what syncs,
all on), `sync.ignoredSettings`, `sync.historyDays` (30; days the project was worked on, 0 keeps
everything), `sync.snapshotScope` (`remote` | `everything`), `sync.projects` (managed by the IDE).

**State:** `ide://sync` — `available`, `offered` (the account could subscribe), `lapsedUntil`
(null, or when what is synced is deleted once the subscription ended, in ms), `state`, `device`,
`devices` (a waiting one's `codeChecked`, never its code), `recoveryKeySet`, `usageBytes`,
`storageLimit`, `activity` (its `state` is "lapsed" while the subscription is ended), `page` (the page the tab shows while sync is on),
`overview` (`settings {count, updatedAt}`, `files [{path, bytes, updatedAt}]`, `accountChats`,
`projects [{id, name, chats, snapshots, snapshotBytes (the latest snapshot's), lastChange,
lastComputer, here, folder}]`), `recent` (`[{at, text, error}]`), `project`, `snapshots`. Never
the recovery key, a verification code or any content.

**UI test:** `tests/scripts/sync-m7-129.jsonc` (nobody signed in); the backend flows:
`scripts/sync-e2e.mjs`.

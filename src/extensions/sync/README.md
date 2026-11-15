# extensions/sync

Sync (D435): the account's settings, the user's own files (keybindings, snippets, the rules file,
agents, commands, output styles, skills), the chats of the projects that sync and snapshots of
their unfinished work, on every computer of the account. Everything is sealed on this computer
before it leaves (Rust `src-tauri/src/sync`, typed calls in `core/ipc/sync.ts`); the engine, the
merge rules, the layers and the history rules are `core/sync` (DOM-free, tested). Open only to
accounts whose profile says `sync: true`. Window only: a screenless session doesn't sync.

- `controller.ts` — `SyncController`: where sync stands (`status`), the loop's passes
  (`activity`; one window of a profile writes, the others read), the open project (`project`) and
  its snapshots (`snapshots`). No view code.
- `session.ts` — `SyncSession`: the account as last read, the step the tab shows (the recovery
  key on show, or asked for), and the two things that never go through a command's input or
  result, state or a log: the recovery key while shown, and what the person types back.
- `commands.ts` — the commands. The ones that handle keys, approve or remove a computer, or
  change the folder's files are hidden from agents and ask in a dialog themselves.
- `view.ts` — the Sync tab (`sync`, a singleton in the main area; styles in
  `src/styles/sync.css`): sign in / not open / turn on (the recovery key to keep and confirm) /
  join (the code to compare, or the recovery key) / on (status, storage, computers, recovery key,
  what syncs, this project's snapshots). Its buttons run commands; copying and saving the
  recovery key go straight to the clipboard and the save dialog, so the key stays out of the
  audit log.
- `model.ts` — the words both share (sizes, the status line), DOM-free and tested.
- `index.ts` — `syncExtension`: one controller; a pass after the workspace is restored, on window
  focus (at most every 2 minutes), after signing in or out, when sync comes on, and when the open
  folder changes.

**Exports:** `syncExtension` (`index.ts`), `SyncController` (`controller.ts`).

**Commands:** `sync.show`, `sync.turnOn {name?}`, `sync.join {name?}`, `sync.useRecoveryKey`,
`sync.closeStep`, `sync.approveDevice {device}`, `sync.removeDevice {device}`, `sync.turnOff`,
`sync.newRecoveryKey`, `sync.syncNow`, `sync.project.enable`, `sync.project.disable`,
`sync.snapshot.create`, `sync.snapshot.continue`, `sync.snapshot.restore {id}`,
`sync.snapshot.restoreFile {id, path?}` (without `path`: pick one of the snapshot's files),
`sync.snapshot.pin {id, name?}` (`name` null unpins; without it, asks), `sync.snapshot.delete
{id}`, `sync.openAccountPage`. Each fails with one sentence when nobody is signed in or sync isn't
open to the account.

**Settings:** `sync.settings`, `sync.keybindings`, `sync.snippets`, `sync.rules`, `sync.agents`,
`sync.commands`, `sync.outputStyles`, `sync.skills`, `sync.chats`, `sync.snapshots` (what syncs,
all on), `sync.ignoredSettings`, `sync.historyDays` (30; days the project was worked on, 0 keeps
everything), `sync.snapshotScope` (`remote` | `everything`), `sync.projects` (managed by the IDE).

**State:** `ide://sync` — `available`, `state`, `device`, `devices`, `recoveryKeySet`,
`usageBytes`, `storageLimit`, `activity`, `project`, `snapshots`. Never the recovery key or a
verification code.

**UI test:** `tests/scripts/sync-m7-129.jsonc` (nobody signed in); the backend flows:
`scripts/sync-e2e.mjs`.

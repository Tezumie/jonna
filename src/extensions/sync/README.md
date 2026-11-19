# extensions/sync

Sync (D435): the account's settings, the user's own files (keybindings, snippets, the rules file,
agents, commands, output styles, skills), the chats of the projects that sync and snapshots of
their unfinished work, on every computer of the account. Everything is sealed on this computer
before it leaves (Rust `src-tauri/src/sync`, typed calls in `core/ipc/sync.ts`); the engine, the
merge rules, the layers and the history rules are `core/sync` (DOM-free, tested). Open only to
accounts whose profile says `sync: true`. Window only: a screenless session doesn't sync.

Which server it talks to, the pages it opens in the browser (the account page, the plan page)
and whether a build has Sync at all are set in product.json and read through
`core/ownServices.ts`: `docs/own-services.md` (running the IDE with your own services, shipping
without Sync, and the files to delete to take Sync out). The extension is in the list of
built-ins only when `hasSync()` (`extensions/builtins.ts`).

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
  - `team` (`teamPage.ts`): below.
  - `computers`: computers waiting to join (Check code, then the code with Approve), this
    computer and the others (Remove), how to add one, Turn off sync on this computer.
  - `security`: the recovery key, what the service can see and can't read, what a reset loses.
  - `storage`: used of the limit with the 80% / 95% lines, the latest snapshot's size per
    project, the history settings with their values, how to free space.
  - `activity`: everything the log holds, newest first.
- `teamPage.ts` — the Team page, and `TeamLibraryReader` (the view's): `ide://team` as last
  read, and the texts of the previews that were opened. `teamPage.model.ts` (DOM-free, tested)
  has its words and rules; `teamCommands.ts` has `sync.team.publish`. See "The Team page".
- Sharing a project with the team (docs/sync.md; only in a build with teams): see "Sharing a
  project with the team".
  - `sharing.ts` — `ProjectSharing`, the controller's (`controller.sharing`): reads the team's
    members and shares into the share book (`core/team/shareBook.ts`), and writes a shared
    project to its share after each snapshot the loop takes of it. No view code.
  - `shareCommands.ts` — the commands of both sides, and the content source
    `teamShare:<share id>/<snapshot id>`.
  - `shareCard.ts` — "Share with team" on a project's page.
  - `shareView.ts` — the Team page's People and Shared projects, and a shared project opened in
    place of the page; `shareView.model.ts` (DOM-free, tested) has `ShareLook` and its words.
- `snapshotView.ts` — inside a snapshot: `drawSnapshot(kit, source, opened)` draws from a
  `SnapshotSource` (where the snapshot is from, what its buttons do). `snapshotPanel` is the
  source for a snapshot of the open project (the Projects page); `shareView.ts` has the one for
  a teammate's shared snapshot (read only; compared with the open folder only when the folder
  is that same project). `snapshotView.model.ts` (DOM-free, tested): the words, the order, the
  filter, the counts, and `SnapshotLook`; `snapshotView.commands.ts`: `sync.snapshot.view`,
  `.files`, `.openDiff` and the content source `syncSnapshot:<collection>/<id>`.
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
- Teams are never managed in the IDE either: `sync.manageTeam` opens `<accounts server>/account#team`.
  The profile's `team` (`teamOf` in `model.ts`: its name and the account's role; null in a build
  whose service has no teams, `teamPagePath` empty) is shown, nothing more. Overview: one muted
  line in the status card ("Your team: <name>" for the owner, "Through <name>" for a member)
  with Team library (the Team page, in a build with teams' libraries) and Manage team, and the storage card says "Storage, shared by your team". Storage: a note
  that the limit is what is left of the team's storage; a member has a team row with Manage
  team and no "Your plan" (the plan is the owner's), an owner has both, and a subscriber in no
  team has "Add people to your subscription". Lapsed as a member (`throughTeam`): the callout
  says the team's subscription ended and offers Manage team / Check again, never Renew; the
  status line, the status bar's tooltip and the reason on disabled buttons say the same. The
  log's sentence (`LAPSED_ACTIVITY`) names nobody's subscription: the loop doesn't know the team.

**The Team page** (in the navigation only in a build with teams' libraries: the team
extension's `team.refresh` is registered; `shownPages` in `model.ts`. `sync.show {page:
"team"}` is taken either way, and Overview shows without teams). The library is the team
extension's (`extensions/team`): this page imports nothing from it, reads `ide://team` and runs
its commands through the dispatcher.

- How it gets its data: the state tree isn't reactive, so `TeamLibraryReader` reads
  `ide://team` again after any `team.*` command ran (and `accounts.signIn`, `accounts.signOut`,
  `sync.checkPlan`), when the profile or the applied library (`activeTeam`, `core/team/source.ts`)
  changed, when the Team page is shown, and every 3 seconds while it is the page shown (a read
  of memory, no network: the team extension also refreshes by itself, which nothing announces).
  Its signals (`library`, `previews`) are among the ones the tab draws from; a read that says
  the same redraws nothing.
- Not in a team: what a team is for, and Manage team (`sync.manageTeam`); an account whose own
  subscription ended sees how to be invited instead. No library.
- In a team: a card with the team's name, "You own this team" / "Member" / "Member · Can
  publish", "Refreshed <when>", the state's `problem` as a plain muted line, and Publish…
  (publishers; `sync.team.publish`), Refresh (`team.refresh`), Manage team. Then the library by
  kind, in this order, empty kinds left out: Rules, Skills, Commands, Agents, Output styles,
  Snippets, MCP servers, Default settings, Recommended extensions (a line under Skills,
  Commands, MCP servers and Default settings says what holds for a team's). An empty library
  says so, and tells a publisher to choose Publish.
- A row: the name (a skill is one row: its folder, with its number of files), a "Default" tag,
  "Published by <who> · <when>", and a checkbox that reads On / Off. On for a default that was
  turned off runs `team.turnOnItem`, on for any other `team.addItem`, off `team.turnOffItem`
  (`toggleCommand`). "Preview" opens the item's text (`team.readItem`, read when first opened,
  kept per version) in a read-only monospace block with its own scroll; a skill previews its
  `SKILL.md` and lists its other files by name. A skill's files without a `SKILL.md` are one row
  without a switch. For a publisher a ⋯ menu: Make a default / Stop being a default
  (`team.setMode`: optional, a default, or required; the owner only), Remove from the library… (`team.unpublish`, which asks).
- Lapsed (the state's `state` is "lapsed", or the account's sync is ended): the library stays
  listed and what is on can still be chosen; Publish… and the ⋯ menu are gone, and one line in
  the card says why.
- `sync.team.publish {kind?}` (hidden from agents, needs the screen): picks, in the quick
  input, the kind (kinds the user has nothing of are disabled), then which of the user's own (a
  pick with checkboxes; the rules are one file and skip it), then "On for everyone from the
  start?" (Yes / No, and "Keep as it is" when it is in the library already). Where the choices
  come from: the user-files scan (`syncIpc.userFiles`; a skill whole, only with a `SKILL.md`),
  the settings the user changed that `teamMaySet` allows, the servers of the user's own
  `mcp.json`, and the installed extensions plus the ones the team recommends now (checked, since
  publishing replaces the list). It then runs `team.publish` once per file or skill (once for
  settings, servers, extensions) and says in a notification what was published and what wasn't,
  with why; returns `{published, notPublished: [{what, why}], message}` or `{cancelled: true}`.

**Sharing a project with the team.** What sharing is and its keys: docs/sync.md. Here:

- The share book (`core/team/shareBook.ts`: the members with where each one's key stands, the
  team's shares, when they were read, why a read failed) is read by `ProjectSharing.refresh`:
  once a pass at most every 5 minutes (`tend`), when the Team page or a project's page is
  shown (unless read in the last 30 seconds), and after a share command. The first read also
  makes and publishes this account's own member key (`share_me`), so a teammate can share with
  it without the Sync tab ever being opened. Nothing is asked while sync is off, signed out, or
  in no team (`ProjectSharing.inTeam`, set from the profile); the loop asks nothing while the
  subscription is ended.
- The sharer's loop: after each snapshot `takeSnapshot` stored for the account, inside the
  snapshots' own queue (so after it, and never beside another), `afterSnapshot` runs
  `share_sync` when the open project is shared. Once a pass, `tend` also runs it when no
  snapshot did for 10 minutes (2 when the service wants the share's keys renewed): a teammate
  who published a key since gets the share's keys. A failure is kept for the card
  (`failure`) and said once in the activity; it never fails the pass.
- Chosen people (D453): the card's "Share with" choice and a tick for each teammate
  (`readerChoices`, `toggledReaders`); each change runs `sync.project.shareWith`, which
  changes a share that exists (`ProjectSharing.change`: the keys are renewed when someone
  was taken off) or keeps the choice for when sharing is turned on
  (`ProjectSharing.intended`). A service that doesn't keep readers: `ShareNeedsService`,
  nothing changes.
- Chats (D454): "Share its chats too" runs `sync.project.shareChats`; after each share sync
  `ProjectSharing.chats` makes the share's chats the project's (`chatsToShare`: the chats of
  that folder, newest hundred, not ones being written), and takes them out when the switch
  is off. A teammate's side: `ShareLook.chats`, the "Chats" part of an opened share,
  `team.share.chats`, `team.share.readChat` (a read-only document made by
  `conversationMarkdown`), `team.share.continueChat` (a copy among one's own chats).
- After the audit (D457): `sync.project.share` reads the list first and never changes whom
  a share that exists is for; the chats pass hands the backend the busy chats (left as they
  are); the activity gets fixed words (`NEWS_LOG`, `ASK_LOG`), names only in the
  notification; the card says when this account has no record of whom a chosen share is for
  (`audienceUnknown`); a shared chat opens as `.txt`.
- Hand-off (D455): after each read of the book, `ProjectSharing.tell` asks `share_news`
  what this computer hasn't seen and announces it once (`SharingHost.announce`; the
  `team.shareNotices` setting), and the same for a new ask. `team.member.askToShare`,
  `team.asks.dismiss`; the Team page shows who asked above its lists.
- The card (`shareCard.ts`, under a project's head): a switch, off until turned on. On: who can
  read it and who waits for its keys and why (what the last share sync said; before one, worked
  out from the members' states), that key files are left out, when it was last shared and how
  many key files that left out, why the last try failed, and Share now. A project that isn't
  the open folder shows the card only when it is shared (to stop sharing it).
- The Team page (`shareView.ts`), above the library: Shared projects (name, whose, the newest
  snapshot, and why it can't be opened: waiting for keys, or the sharer's key changed), then
  People (a tag for where each key stands, the fingerprint on demand, Mark as verified…,
  Unmark, Accept the new key…; your own fingerprint with Copy). Opening a share shows its
  snapshots in place of the page; opening one shows its files in the snapshot panel. A file
  opens as a diff against the open folder when the folder is that project (the same sync
  project id), else by itself, read only (`editor.openReadOnly`).
- `team.shareOnlyVerified` (the team extension's setting; never synced) is passed to every
  share call that hands keys out.
- A snapshot pinned from the account page (`SnapshotRow.keep`, the service's "keep" mark on its
  record) is never pruned (`staysPinned`, `core/sync/history.ts`), shows as pinned ("Pinned
  from your account page"), and Unpin clears the mark (`sync_snapshot_keep`).

**Exports:** `syncExtension` (`index.ts`), `SyncController` (`controller.ts`).

**Commands:** `sync.show {page?, project?}` (`page`: overview, projects, content, team, computers,
security, storage, activity; `project` shows that project's detail), `sync.turnOn {name?}`, `sync.join {name?}`, `sync.useRecoveryKey`,
`sync.closeStep`, `sync.acceptIncoming {id?}` (hidden from agents: accepts on this computer what
another of the account's computers synced here, one item of `ide://sync` `incoming` or all of
it; until then a skill or command among it approves no tools and shortcuts that could run
something aren't in use; Overview lists it as "From your other computers", and it is said once
in a notification; `core/sync/incoming.ts`), `sync.reviewDevice {device}` (starts checking a waiting computer: both then show
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
`sync.snapshot.pin {id, name?}` (`name` null unpins, the account page's mark too; without it, asks), `sync.snapshot.delete
{id}`, `sync.openAccountPage`, `sync.managePlan` (opens the account page's plan section in the
browser: subscribing, renewing, cancelling, cards, invoices, storage), `sync.manageTeam` (opens
the account page's team section in the browser: inviting, removing, leaving, seats; fails in a
build whose service has no teams), `sync.team.publish {kind?}` (the Team page's picker, above), `sync.checkPlan` (reads the
profile from the server and the status again; returns `{plan, state, lapsedUntil}`, `plan`: on,
lapsed, offered, none). Each fails with one sentence when nobody is signed in or sync isn't
open to the account (the two plan commands and `sync.manageTeam` need only an account). What writes to the account
fails with one sentence while the subscription is ended. None takes or returns a recovery key or
a verification code.

Sharing with the team (only in a build with teams; all need sync on and an account in a team):
`sync.project.share` and `sync.project.unshare {id?}` (asks first; hidden from agents),
`sync.project.shareNow`; `team.members` (names, states, fingerprints; never a key),
`team.member.verify {uid, fingerprint, verified}` and `team.member.acceptKey {uid,
fingerprint}` (they show the fingerprint and ask; hidden from agents), `team.copyFingerprint`
(hidden), `team.shares.list` (labels only), `team.share.snapshots {id}`, `team.share.files {id,
snapshot, filter?}` (at most 2,000), `team.share.openFile {id, snapshot, path}`,
`team.share.view {id, snapshot?}` (the Sync tab on a share), `team.share.openCopy {id,
snapshot?, target?}` (hidden; asks for a folder, then offers to open it, untrusted).
D453: `sync.project.shareWith {team?, readers?}` (who it is for; hidden), and
`sync.project.share {readers?}`. D454: `sync.project.shareChats {on}` (asks first; hidden),
`team.share.chats {id}` (titles, marked as a teammate's text), `team.share.readChat {id, chat}`
and `team.share.continueChat {id, chat}` (hidden). D455: `team.member.askToShare {uid}` and
`team.asks.dismiss {uid?}` (hidden).

**Status bar:** `sync.status` (right): Synced / Syncing… / Offline / Sync (another window is
syncing, or before the first pass) / Sync error (the reason is the tooltip; the only colored
state) / Waiting (for approval) / Sync ended (the subscription ended; not colored). Absent
unless sync is open to the account and on or pending here. Runs `sync.show {page: "overview"}`.

**Settings:** `sync.settings`, `sync.keybindings`, `sync.snippets`, `sync.rules`, `sync.agents`,
`sync.commands`, `sync.outputStyles`, `sync.skills`, `sync.chats`, `sync.snapshots` (what syncs,
all on), `sync.ignoredSettings`, `sync.historyDays` (30; days the project was worked on, 0 keeps
everything), `sync.snapshotScope` (`remote` | `everything`), `sync.projects` (managed by the IDE).

**State:** `ide://sync` — `available`, `offered` (the account could subscribe), `lapsedUntil`
(null, or when what is synced is deleted once the subscription ended, in ms), `team` (null, or
`{name, role}`: the team the account is in, `role` "owner" or "member"; never its members),
`state`, `device`,
`devices` (a waiting one's `codeChecked`, never its code), `recoveryKeySet`, `usageBytes`,
`storageLimit`, `activity` (its `state` is "lapsed" while the subscription is ended), `page` (the page the tab shows while sync is on),
`overview` (`settings {count, updatedAt}`, `files [{path, bytes, updatedAt}]`, `accountChats`,
`projects [{id, name, chats, snapshots, snapshotBytes (the latest snapshot's), lastChange,
lastComputer, here, folder}]`), `recent` (`[{at, text, error}]`), `project`, `snapshots` (each
with `pinned`, the name, and `kept`, pinned from the account page), `share` (the open project's
share with the team: null, or `id`, `name`, `lastShared`, `keyFiles`, `waiting`, `problem`),
`viewing`. What the team
shares is in `ide://team` (`members`, `shares`). Never
the recovery key, a verification code or any content.

**UI test:** `tests/scripts/sync-m7-129.jsonc` (nobody signed in); the backend flows:
`scripts/sync-e2e.mjs`.

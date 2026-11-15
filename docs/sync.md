# Sync

How the IDE syncs an account's settings, chats and unfinished work between computers (D435).
The service's code is in the website's repository; this is the contract and the design both
sides follow. Sync is open only to accounts the service allows (`/api/me` says `"sync": true`).

## The promise

What is synced is encrypted on the computer before it leaves, with keys the service never has.
The service stores it, counts its bytes and deletes what nothing refers to. It can't read it.
The cost of that promise: without one of the account's computers or the recovery key, nobody
can read the synced copy, the user included.

## Keys

Rust: `src-tauri/src/sync/crypto.rs`. Every piece is a well-known construction from a
maintained library (RustCrypto).

| Thing | What it is |
|---|---|
| Device key | An X25519 key pair made on each computer. The private half stays in the OS keychain (the profile's `secrets.json` when there is none). |
| Keyring | The account's secret: one random 32-byte key per generation, and a key for naming chunks. A generation is added when a device is removed. |
| Wrap | The keyring sealed to a device's public key: a sealed box (libsodium's `crypto_box_seal`). The service stores one per device. |
| Recovery key | One more X25519 private key, shown once as 14 groups of four characters (Crockford base 32 with a checksum). The service stores the keyring sealed to its public half, so any device can re-wrap for it without knowing it. |
| Content | XChaCha20-Poly1305 with a random 24-byte nonce, under a key derived from a generation's key with HKDF-SHA256 (one per purpose: records, chunks). The item's name is the associated data, so one item can't be passed off as another. Deflated first when that is smaller. |
| Chunk id | HMAC-SHA256 of the content under the keyring's id key, first 16 bytes. The same content has the same id; the id says nothing about the content. |

A sealed item starts with a format byte and the generation it was sealed under, so older
content stays readable after new keys.

## Devices

- **The first device** makes its key pair, the keyring and a recovery key in memory
  (`sync_prepare`), shows the recovery key, and sends nothing until the key (or its last group)
  is typed back (`sync_setup`).
- **Another device** registers its public key and waits (`sync_join`). Both computers show six
  digits derived from that public key. A device that syncs approves it by sealing the keyring
  to the key it sees (`sync_approve`): the person compares the digits, which is what stops the
  service from swapping in a key of its own.
- **Or by recovery key** (`sync_join_recovery`): the device opens the recovery wrap and stores
  a wrap for itself.
- **The trusted list:** a sealed record (`sys/devices`) of the devices the account's own
  devices approved. New keys are wrapped only for devices on it; a device the service lists
  that isn't on it is removed instead.
- **Removing a device** deletes its wrap and its sessions, and asks for new keys: the next
  device to check in adds a generation and wraps the keyring for every remaining device and the
  recovery key. What is synced from then on can't be read with the removed device's copy.
- **A new recovery key** replaces the old one's wrap.
- **Reset** (the account page, right after signing in again, with the email typed): the
  service deletes the vault. Devices see it at their next check and turn sync off; a computer
  that still has the data turns sync on again and uploads afresh. Snapshot history is gone.

A device's state is `<data>/sync/local.json`; the sync loop's is `<data>/sync/front.json`. The
whole folder is removed when sync goes off on the device.

## The service

Every call carries the account session's access token (the website's calls carry its own
sign-in). All under `/api/sync/`, JSON unless said.

| Call | What it does |
|---|---|
| `GET state` | The vault: epoch, key version, devices (a device reads only its own wrap), recovery key's public half, bytes used and allowed. |
| `POST setup` | The first device makes the vault. |
| `POST devices` | A device asks to join, or says which device this session is. |
| `POST devices/{id}/approve` | An approved device stores the wrap for a waiting one. |
| `DELETE devices/{id}` | Removes a device and ends its sessions. |
| `GET recovery`, `PUT recovery` | The recovery wrap; a new recovery key. |
| `POST keyring` | New wraps for every device (new keys), or a device's own wrap (joining by recovery key). |
| `POST reset` | Deletes everything synced. The website only. |
| `GET records?since=N` | Records changed after change number `N`, oldest first. |
| `GET`, `PUT records/{collection}/{id}` | One record. A write names the version it was made from; another version there answers 409 with the current record. |
| `POST blobs/have` | Which of these chunks are stored. |
| `POST blobs`, `POST blobs/get` | Upload and download chunks, framed: a 22-byte id, a 4-byte length, the bytes. |
| `POST gc` | Removes chunks nothing refers to and recounts the bytes used. |

- **A record** is small (400 KB sealed at most), has a version the service counts, and may
  name the chunks it needs. The service keeps a chunk while a record names it. A deleted record
  stays as a marker.
- **Removing unneeded chunks** never overlaps a record being written: a sweep moves a counter
  (`gcEpoch`); a record that names chunks says which counter its chunks were checked under, and
  is refused when it moved, so the client checks its chunks again.
- **An epoch** is one life of the vault. A reset ends it; the next setup has a later one, and
  devices drop what they kept for the earlier one.
- **Storage full** refuses new chunks (507); records keep being written while they fit.

## What syncs

The sync loop (`src/core/sync/`, DOM-free and unit tested) runs in one window of a profile at
a time (`sync_lease`). Each pass reads the account's changes, then each layer compares what
this computer has, what it had at the last sync, and what the account has.

| Layer | Record | Rule |
|---|---|---|
| Settings | `settings/user`: each key with its value and when it changed | By key. Two different settings changed on two computers both survive; the same one changed on both takes the later. `accounts.serverUrl`, `sync.projects` and the keys in `sync.ignoredSettings` stay on the computer. |
| The user's files | `files/<name>`: keybindings, rules, snippets, subagents, commands, output styles, skills | Whole files. Changed on both: the later is the file, the other is kept beside it as `name.conflict.ext` (never synced). |
| Chats | `chats.<project>/<chat>` and `chats.account/<chat>`: a summary, and the chat's file and images as chunks | Changed on both: the other computer's version becomes a chat of its own. A chat is saved into this computer's folder for the project. |
| Projects | `projects/<project>`: a name | The account's list of projects that sync. |
| Snapshots | `snap.<project>/<time>-<device>` | Below. |

Keys (model providers, MCP tokens) don't sync. The list of installed extensions and a
project's layout don't sync yet.

## Projects

A project is the same project on every computer by its id (`sync_project`):

- **With a git remote:** derived from the remote's address under the keyring's id key, and
  nothing is written. The address is normalised first (lower-cased host; no scheme, user name,
  port or `.git`), so the SSH and HTTPS forms of one repository give one id. `origin` is used,
  else the first remote by name.
- **Without one:** a random id in `<project>/<workspace folder>/project.json`, written only
  when sync is turned on for the project. `.gitignore` is left alone.
- **The file wins** over a remote added later, so the project's chats don't split.

Which folders sync from a computer is the setting `sync.projects` (folder to id).

## Snapshots

Rust: `src-tauri/src/sync/snapshot.rs`. A snapshot is the project's files as they are; git is
asked, and nothing is written inside `.git` to make one.

- **A git project:** the commit checked out and its branch; the commits no remote has, as git
  bundles (each carries only what the bundles before it lack; with `sync.snapshotScope:
  "everything"`, or without a remote, the whole history); what is staged, as a patch; and every
  file that differs from the commit, new files included. Ignored files stay out.
- **A folder without git:** every file, minus well-known heavy folders and files over 100 MB.
- **Unchanged files aren't read again,** and unchanged content isn't uploaded again: files are
  chunks named by their content.
- **When:** every few minutes while something changed, and on demand.
- **Restore** checks out the commit (fetching bundles into `refs/synced/*`, and the remote when
  the commit isn't here), stages what was staged, and writes the changed files. Local changes
  refuse it unless they are stashed first; changes an earlier restore put there are replaced
  without asking. A branch that has other commits here is left alone and the commit is checked
  out on its own.
- **History** is counted in days the project was worked on: the last `sync.historyDays` such
  days are kept, every snapshot of the latest day and the last one of each earlier day. A
  pinned snapshot is never removed.

Not yet: older stashes (only the latest travels), symbolic links, submodules, the "also
include" list for ignored files.

## Tests

- `cargo test --lib sync::`: the cryptography, names, paths.
- `npm test -- sync`: the merge rules, the loop and its layers with two simulated computers.
- `node scripts/sync-e2e.mjs`: several windowless hosts against the service on the Firebase
  emulators (in the website's repository: `firebase emulators:exec --project demo-<name> "node
  ../<this repository>/scripts/sync-e2e.mjs"`). Devices, records, chats, snapshots, new keys,
  reset.

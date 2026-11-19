# Running the IDE with your own services

The IDE works without any online service. A few features use services that whoever ships a
build runs: an account to sign in to, Sync between computers, the pages of a website the app
opens in the browser, and updates. This page is for someone making their own build from this
code: where each of those is set, how to point it at your own service, and how to leave it out.

Everything is set in one file, `product.json` at the root of the repository (the same file that
holds the product's names). Nothing else in the code spells a server address or a page.
`scripts/gen.mjs` checks the file and writes `src/core/product.ts` from it (it runs before
`npm run dev`, `build`, `check` and on `npm install`); the code reads the services through
`src/core/ownServices.ts`.

## The names

The same file names the product. These are required, and nothing else in the code spells
them:

| Key | What it names |
|---|---|
| `nameShort`, `nameLong` | The product, as the app, its installer, its program file and its wording say it. The command-line launcher is `nameShort` in lower case. |
| `identifier` | The app's id to the system (`com.example.ide`): its data folder, its keychain entries, its installer's identity. Changing it later is a new app to the system: settings and sign-ins don't carry over. |
| `dataFolderName` | The folder in a person's home for what is theirs across projects (`.example`: rules, skills, commands). |
| `workspaceFolderName` | The folder in a project for its own settings (`.example`). |
| `workspaceFolderAliases` | Other names of that folder a project may already have, read when the one above isn't there (ours lists `.vscode` and the folder name of an earlier product of ours: drop that one). |
| `serverDataFolderName` | The folder in a remote machine's home that the remote server keeps itself in (`.example-server`). |
| `urlScheme` | The links the system hands to the app (`example://…`). |
| `extensionApiGlobal` | The name extensions call the API by. Keep `ide` unless you break with existing extensions on purpose. |

`npm run gen` refuses a file without them, and warns about a key nothing reads (a misspelt
key would otherwise build a product without what it was meant to set).

## The keys

| Key | What it does | Left out or empty |
|---|---|---|
| `accountsUrl` | The accounts server: sign-in, the profile, and the server Sync talks to. `https://…`, without a path (`npm run gen` refuses one with a path). | No account in the build: see "Without accounts". |
| `accountPagePath` | The account page the app opens in the browser (`sync.openAccountPage`: devices, storage, resetting sync). A path on the accounts server, or a whole URL when the page lives elsewhere. | `/account` |
| `planPagePath` | The page where a plan is bought, renewed or cancelled (`sync.managePlan`). A path on the accounts server, or a whole URL (a billing portal on another host). Set it to `""` when your service has no plans (sync that is free, or sold elsewhere): the IDE then shows no "Your plan" card, no "See plans" and no "Renew". | `/account#plan` |
| `webAppPath` | Where the front end is served as a website that connects to a host (`npm run web`; [web-app.md](web-app.md), "Running your own", is the guide). A whole URL (it needs no accounts server then), or a path on the accounts server. `scripts/web-host.mjs` allows that page and prints links to it. A page that shares its address with the account pages connects only to the computer it is shown on and runs no extension code; serve it from an address of its own to lift both. Any static web host serves it. | No such page. |
| `webAppSubdomainIsolated` | `true`: a web front end on another name of the accounts server's domain (`app.example.com` beside `example.com`) counts as an address of its own. Set it only when the accounts server sets no cookie for the whole domain. | Such a page is treated as sharing the account pages' address. |
| `teamPagePath` | The page where a subscriber's team is managed: inviting and removing people, seats, leaving (`sync.manageTeam`). A path on the accounts server, or a whole URL. Set it to `""` when your service has no teams: the IDE then shows nothing about teams, whatever the profile says, and has no team library (no `team.*` command or setting, no `ide://team`). | `/account#team` |
| `syncBuiltIn` | `false` leaves Sync out of the build, whatever the server offers. | `true` (Sync also needs `accountsUrl`). |
| `updates.endpoint` | Where installed copies look for a new version (a `latest.json`). | No updates: the build never checks and never connects. |
| `updates.betaEndpoint` | The same for the beta channel (`update.channel`). | No beta channel. |
| `updates.pubkey` | The public key update files are checked against. Needed with `endpoint`. | No updates. |
| `issuesUrl` | Where Help → Report a problem opens a new issue (a repository's `…/issues`). | The report is copied or saved instead. |
| `extensionsRepo` | A git repository of official extensions, offered in the Extensions view. | None offered. |

The update keys can also come from the environment when building (`IDE_UPDATE_ENDPOINT`,
`IDE_UPDATE_BETA_ENDPOINT`, `IDE_UPDATE_PUBKEY`), which is how the release workflow sets them:
[releasing.md](releasing.md).

The setting `accounts.serverUrl` overrides `accountsUrl` on one computer, for developing the
server. It is honoured only when it names this computer itself (`http://127.0.0.1:<port>`,
`localhost`), or in a development build: a released build talks to the server
`product.json` names, whatever a settings file says. It exists only in a build that has an
accounts server, and the pages above are then opened on the server it names.

## Your own accounts server

Set `accountsUrl` to your server. The app signs in with OAuth 2, authorization code with PKCE,
through the system browser and a loopback redirect (RFC 8252); the code is
`src-tauri/src/accounts/`. The server implements:

| Request | What the app sends | What it expects |
|---|---|---|
| `GET /oauth/authorize` | `response_type=code`, `client_id=desktop`, `redirect_uri=http://127.0.0.1:<port>/callback`, `code_challenge`, `code_challenge_method=S256`, `state`. Opened in the browser. | Your sign-in page; then a redirect to `redirect_uri` with `code` and the same `state` (or `error`). The port is a different one each time, so any port on `127.0.0.1` must be accepted. |
| `POST /oauth/token` | A form: `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `code_verifier`. | JSON `{ "access_token", "refresh_token"? }`. |
| `POST /oauth/token` | A form: `grant_type=refresh_token`, `refresh_token`, `client_id`. Sent when a request answers 401. | The same JSON; a new refresh token replaces the old one (rotation is supported). 400 or 401 ends the session: the app signs out. |
| `GET /api/me` | `Authorization: Bearer <access token>`. | The profile, below. 401 when the token has run out. |
| `POST /oauth/revoke` | A form: `token`, `client_id`. On sign-out, best effort. | Optional; the answer isn't read. |

The client id is `desktop` (`CLIENT_ID` in `src-tauri/src/accounts/mod.rs`); there is no client
secret. The id and the four paths are fixed in that file, not set in `product.json`: an
identity provider that assigns its own client ids or paths needs that constant changed, or
a small server of yours in front that answers these paths. The page the browser shows after the redirect is the app's own (served from the
loopback address, no network, no names).

The profile, `GET /api/me`:

| Field | | What the app does with it |
|---|---|---|
| `id` | string, required | Tells accounts apart. |
| `name` | string, required | The Accounts menu, "Signed in as…", the chat's greeting. |
| `email` | string, optional | Shown beside the name. |
| `avatarUrl` | string, optional | The picture on the Accounts icon. Must be an https URL on the accounts server (or on GitHub); at most 2 MB. |
| `plan` | string, optional | A label, shown as "Plan: …" in the Accounts menu. The app doesn't act on it. |
| `sync` | boolean, optional | Sync is open to this account. |
| `storageLimit` | number of bytes, optional | The account's sync storage. |
| `syncState` | `"on"`, `"lapsed"`, `"off"`, optional | Where the sync subscription stands; without it, read from `sync`. |
| `syncUntil` | ms, optional | While lapsed: when what is synced is deleted. |
| `syncOffered` | boolean, optional | Sync is on sale to this account and it doesn't have it: the Sync tab shows an offer. |
| `supporter` | boolean, optional | Read and kept; nothing shows it yet. |
| `team` | `null` or `{ id, name, role, publisher, libraryRev }`, optional | The team the account is in (`role`: `"owner"` or `"member"`): see "Teams". `publisher`: the account may change the team's library; `libraryRev`: a number that moves with every change of it (see "A team's library"). A shape the app can't read counts as no team. |

A server that sends only `id` and `name` is a complete accounts server: there is sign-in and a
profile, and Sync stays closed to everyone.

The profile is read at sign-in, when the app starts, at most hourly after that, and when
`sync.checkPlan` runs. The session is saved in the app's data folder (`account.json`) with the
tokens in the system's keychain; the tokens never reach the window's code.

## Sync

Sync is served by the accounts server, under `/api/sync/`, in the signed-in account's name
(the same bearer token). The contract, the keys and what the service can and can't see are in
[sync.md](sync.md). Sync is open to an account when its profile says `"sync": true`; the
service decides that, not the app.

## Plans and payment

There is no payment code in the app. When someone subscribes, renews or cancels, the app opens
`planPagePath` in the browser (`sync.managePlan`) and everything happens on that page, on your
server, with the payment provider you chose. Back in the app, `sync.checkPlan` (and coming back
to the window) reads `/api/me` again, and the profile's fields above say what the account now
has.

What the app shows about plans follows the profile: the offer ("See plans") only when
`syncOffered` is true, the "subscription ended" notice ("Renew") only when `syncState` is
`"lapsed"`. A service where Sync isn't sold never sends either. One place doesn't follow the
profile: the Sync tab's Storage page has a "Your plan" card with "Manage plan" for every
account that has Sync (`src/extensions/sync/pages.ts`). Point `planPagePath` at whatever page
fits, or set it to `""`: the card, "See plans" and "Renew" then never show, and
`sync.managePlan` says the build has no plan page.

## Teams

A service may let a subscriber invite people into a team: each member has Sync because they are
in it, the owner pays for them, and the team shares one pool of storage. Like payment, none of
that is in the app: `sync.manageTeam` opens `teamPagePath` in the browser, and the profile's
`team` says what the account is in. The app shows only the team's name and the account's role
(the Sync tab, and `team` in `ide://sync`), never the other members.

What the app expects of the service for an account in a team:

- A member's `sync` is true and its `syncState` `"on"` while the owner pays, and `"lapsed"`
  with `syncUntil` once the owner's subscription ended, as for an account whose own
  subscription ended. The app then says it was the team's subscription and offers "Manage team"
  in place of "Renew": the plan isn't the member's to renew.
- `syncOffered` is false for a member whose team pays.
- `storageLimit` (in the profile and in Sync's state) is what is left of the team's pool for
  this account; it may shrink as others store more. The Storage page says that the storage is
  shared.

A member sees no "Your plan" card (there is "Manage team" instead); an owner sees both; a
subscriber in no team sees one row, "Add people to your subscription". With `teamPagePath` set
to `""` none of this shows, and `sync.manageTeam` says the build has no team page.

## A team's library

A team may publish things on purpose so every member's IDE works the same way: rules, skills,
commands, agents, output styles, snippets, a list of MCP servers, default settings and
recommended extensions. The app fetches the library, keeps a copy
(`<data>/team/<team>/`), and makes the items that are on take effect as a read-only source of
its own, under the user's own files (`src/extensions/team/README.md`). A build has it when
`hasTeams()`: Sync is built in and `teamPagePath` isn't empty.

It is served by the accounts server under `/api/team/`, with the same bearer token as Sync:

| Request | What the app sends | What it expects |
|---|---|---|
| `GET /api/team/library` | | `{ team: { id, name }, state: "on" or "lapsed", items: [{ id, kind, path, isDefault, version, size, by, updatedAt }] }`, without any text. 404 `no_team` for an account in no team. |
| `GET /api/team/library/{id}` | | The item, with `text`. |
| `PUT /api/team/library/{id}` | `{ kind, path, text, isDefault, expect }` (`expect`: the version it was made from, null for a new item). Publishers. | `{ id, version }`. Refusals: 403 `not_publisher`, 402 `sync_lapsed`, 409 `conflict` (with `current`: the newer item and its text; the app reports it and overwrites nothing), 409 `name_taken`, 413 `too_large`, 507 `library_full`, 400 `invalid_request`. |
| `DELETE /api/team/library/{id}` | Publishers. | `{ removed }`. |

- `kind` is one of `rules`, `skills`, `commands`, `agents`, `outputStyles`, `snippets`, `mcp`,
  `settings`, `extensions`. The app leaves out any other kind a service lists.
- `path` is the item's name, the same names the user's own files sync under: `AGENTS.md`;
  `skills/<skill>/<file…>` (one item per file; a skill counts when it has a `SKILL.md`);
  `commands/<name>.md`; `agents/<name>.md`; `output-styles/<name>.md`;
  `snippets/<name>.json` or `.code-snippets`; `mcp.json` (VS Code's shape, secrets as
  `${input:…}`); `settings.json` (an object of setting keys); `extensions.json`
  (`{ "recommendations": ["publisher.name"] }`). The app checks every name again and takes
  nothing else.
- `id` is 1 to 64 characters of `[A-Za-z0-9_-]`. The app makes it from the kind and the name
  (base64url of the first 16 bytes of SHA-256 of `kind + "\0" + path`), so the same file always
  has the same id.
- The app takes at most 500 items, 256 KiB an item and 20 MiB in all, whatever is listed.
- The library is read at startup, when the profile's `team.libraryRev` differs from the one
  the copy was made at, when `team.refresh` runs, and (the profile only) at most every 10
  minutes while the window has the focus. While `state` is `"lapsed"` the copy keeps applying;
  it can be read, not changed.

What a team's item may do on a member's computer is the app's, not the service's: a team's
skill or command never pre-approves tools, its MCP servers ask before starting, its settings
are defaults under the user's own and never include one that stays on a computer, and
publishing refuses an MCP server with a secret written out.

## Without Sync

`"syncBuiltIn": false`. The Sync extension is then not activated
(`src/extensions/builtins.ts`), so the build has no Sync tab, no `sync.*` command or setting,
no status bar item and no `ide://sync`. Nor a team library: a team is a Sync subscriber and
the people they invited. The Accounts menu has no "Sync…" entry, and its
settings backup is called "Back up settings…" (export and import of a profile, which needs no
service).

## Without accounts

`"accountsUrl": ""`. The build then has:

- no "Sign in to your … account" entry in the Accounts menu, no `accounts.cancelSignIn`
  command, no `accounts.serverUrl` setting, and `accounts.signIn` / `accounts.signOut` take
  only `"github"`;
- no Sync (as above), whatever `syncBuiltIn` says;
- `ide://accounts` with `ide.available: false`.

The Accounts menu itself stays: GitHub through the GitHub CLI, extensions' own sign-ins, the
model providers and settings backup use none of these services.

## Taking the Sync code out

Switching Sync off is enough to ship without it. To remove its code as well, delete:

- `src/extensions/sync/` (the tab, the commands, the controller)
- `src/core/sync/` (the engine, merge rules, layers)
- `src/core/ipc/sync.ts` (the typed calls)
- `src/styles/sync.css`
- `src-tauri/src/sync/` and `src-tauri/src/ipc/sync.rs`
- `tests/scripts/sync-m7-129.jsonc`, `scripts/sync-e2e.mjs`, `docs/sync.md`

and edit the places that name it:

- `src/extensions/builtins.ts`: the import of `syncExtension` and its line in the list.
- `src/styles/index.css`: the `@import "./sync.css";` line.
- `src-tauri/src/lib.rs`: `mod sync;` and the `ipc::sync::…` lines of `all_commands!`.
- `src-tauri/src/ipc/mod.rs`: `pub mod sync;`.
- `src-tauri/build.rs`: the `"sync_…"` names in `COMMANDS`.
- `src-tauri/capabilities/default.json`: the `"allow-sync-…"` entries.
- `src-tauri/src/error.rs`: the `Sync` variant (only Sync makes it).
- `src-tauri/Cargo.toml`: the crates under the "Sync (D435)" comment, which nothing else uses.
- The `sync/` sections of `src/core/README.md` and `src-tauri/src/README.md`.

`npm run check` (which compares the three Rust lists) and `cargo clippy` say what was missed.
Nothing outside these folders imports them, except the team library, which goes with Sync: the
Accounts menu reaches Sync only by asking whether the command `sync.show` exists.

The team library uses three things of Sync's (the client for the accounts server in
`src-tauri/src/sync/api.rs`, the calls that read the user's own files in `core/ipc/sync.ts`,
and `core/sync/localSettings.ts`). Taking Sync's code out takes it out too: also delete
`src/extensions/team/`, `src/core/team/`, `src/core/ipc/team.ts`, `src-tauri/src/team/` and
`src-tauri/src/ipc/team.rs`, with their lines in the same places (`teamExtension` in
`builtins.ts`, `mod team;` and the `ipc::team::…` lines, `"team_…"`, `"allow-team-…"`, the
`team/` sections of the two READMEs), and the places that read `core/team/source.ts` (the
compiler lists them: each appends the team's folder after the user's own).

The accounts code is `src/extensions/accounts/`, `src/core/ipc/accounts.ts`,
`src-tauri/src/accounts/` and `src-tauri/src/ipc/accounts.rs`. It is meant to stay (the
Accounts menu serves GitHub and extensions too); an empty `accountsUrl` is how a build goes
without an account.

## Taking only the team library out

`"teamPagePath": ""` is enough to ship without teams: no Team page, no `team.*` command, no
`sync.manageTeam` or `sync.team.publish`, no `ide://team`. To remove the code and keep Sync,
delete the team folders named above, and also:

- in `src/extensions/sync/`: `teamCommands.ts`, `teamPage.ts`, `teamPage.model.ts` (and
  their tests), with their uses in `index.ts` (`registerTeamPageCommands`), `pages.ts` and
  `view.ts` (the Team page), and the `sync.team.publish` entry of `extension.json`;
- `src/workbench/settings.ts` and `src/core/settings/model.ts`: the settings layer `team`
  (and `src/extensions/settings/controls.ts`, which marks a value as the team's);
- `src-tauri/src/ipc/settings.rs`: the call to `crate::ipc::team::read_path`;
- the readers of `core/team/source.ts`, each of which adds the team's folder after the
  user's own: in `src/extensions/agent/` `agentEditor.ts`, `commandsPage.ts`, `mcp.ts`,
  `outputStyles.ts`, `rules.ts`, `rulesPage.ts`, `skills.ts`, `slashCommands.ts`,
  `subagents.ts`; `src/extensions/editor/userSnippets.ts`;
  `src/extensions/extensions/store.ts`; and the "team" source kind in
  `src/core/agent/{rules,skills,slash,subagents,outputStyles}.ts`. The shortest way is to keep
  `core/team/source.ts` as a stub whose `activeTeam` is always null: nothing else then changes.

With Sync's code gone, `src-tauri/src/agent/mod.rs`'s log of deleted chats
(`note_deleted_session`, `deleted_sessions`, `forget_deleted_sessions`) has no reader left and
goes too, as do the `sync.show` and `sync.checkPlan` lines of `src/extensions/accounts/index.ts`.

## The rest of a build that isn't ours

Not services, but the same checklist. A build of your own also replaces:

- `product.json`: the names, the identifier, `issuesUrl`, `extensionsRepo`, the folder names.
- `src-tauri/icons/` and the logo (`TRADEMARKS.md` doesn't let a fork use ours), and
  `docs/images/`.
- `.github/FUNDING.yml` (our sponsors link) and the addresses in `SECURITY.md`,
  `COMMERCIAL-LICENSING.md`, `TRADEMARKS.md` and `CONTRIBUTING.md`, and the root
  `README.md`.
- `THIRD_PARTY_NOTICES.md`: written with the product's name by `npm run notices`; run it
  after renaming.
- The author of the four bundled extensions (`src-tauri/bundled-extensions/*/extension.json`,
  `author`): our name and picture show in the Extensions view. Change them if you take the
  extensions over; keep them if you ship ours as they are.
- The workflows build what the repository they run in names (`release.yml` takes the update
  address from it, signing from your own secrets). They build the installers only: neither
  the host program nor the web page. `npm run build:web` is the app window's bundle, not
  the web front end (that is `npm run web`).
- `docs/release-notes.md`: it is bundled and shown after an update, and speaks of our Sync,
  our plans and our account page.
- `docs/guide/23-sync.md`: the guide's page on Sync and teams, bundled into the
  Documentation tab. Rewrite it for your service, or remove it (its line in
  `src/extensions/help/pages.ts`) when the build has no Sync.
- Wording that assumes Sync is a subscription with seats and pooled storage: the offer and the
  lapsed texts in `src/extensions/sync/view.ts` and `model.ts` (`SYNC_BENEFITS`,
  `LAPSED_*`, the team sentences), "Your plan" in `pages.ts`, and the descriptions of
  `sync.managePlan` and `sync.manageTeam`; also the sentences about a subscription that
  ended or is renewed in `shareCard.ts`, `teamCommands.ts`, `teamPage.model.ts`,
  `commands.ts` and `index.ts` of the same folder, and in
  `src/extensions/team/commands.ts` (search them for "subscription", "renew" and "seat").
  They only show when your server says `syncOffered`, a lapsed `syncState` or a `team`.
- Pictures of people: the IDE loads an account's picture only from GitHub's avatar hosts or
  from the accounts server itself (`src-tauri/src/ipc/accounts.rs`); serve yours from there.

Tests that read `product.json` or assume our service, and fail in a build that changes them:

- `scripts/sync-e2e.mjs` tests **our** server (Firebase emulators, its Firestore layout, a
  sign-in shortcut `POST /oauth/issue-code` that isn't part of the protocol). Treat it as an
  example of what to test against your own.
- `tests/scripts/sync-m7-129.jsonc`, `features-m6-39.jsonc` and `features-m6-41.jsonc` expect
  an account, Sync, a plan page and teams to be there.
- The command scripts that name the workspace folder (`.` and the product's short name) follow
  `workspaceFolderName`: change them with it. Search `tests/scripts/` for the name; today
  `m6-90`, `m6-91`, `m6-92`, `extensions`, `agent`, `canvas-m6-80`, `debug-m6-42`,
  `features-m6-17` and `workspace-config` have it.
- `docs/sync.md` says the service's code is in "the website's repository": ours, which isn't
  part of this one. The contract in that document and in "What a Sync server must answer"
  below is what a service of yours implements.

## What a Sync server must answer

[sync.md](sync.md) lists every call under `/api/sync/` with its purpose. The exact bodies are
in the Rust client, which is the specification: `src-tauri/src/sync/api.rs` (the calls and the
error codes), `vault.rs` (the state, devices, pairing and keys), `records.rs` and
`chunks.rs` (records and their content). What the client depends on, in short:

- Errors are `{ "error": code, "error_description": text }`. Codes the client knows:
  403 `sync_unavailable` (not open to the account), 402 `sync_lapsed` (read-only: the
  subscription ended), 403 `not_approved` and `not_a_device`, 409 `no_vault`, 409 `gc` (a
  clean-up is running: try again), 403 `proof_failed`, 409 `conflict` with the `current`
  record, 413 (too large), 429 (slow down) and 507 (storage full).
- `GET state` always has `exists` (boolean), `devices` (array) and `epoch` (number); the
  client also reads `keyVersion`, `usageBytes`, `storageLimit`, `lapsedUntil`,
  `rotationNeeded`, `self`, `recovery`, and for each device `id`, `status`, `publicKey`,
  `owner`, `commit`, `reveal`, `createdAt`, `lastSeenAt`.
- `GET records?since=` answers `{ epoch, records, more }`, and each page moves the cursor on;
  a record has `version`, `seq`, `blob`, `refs`, `deleted`, `device`, `info`. A reply
  without a numeric `epoch` and a `records` array is refused, not read as an empty account.

## Sharing, proofs and the page's pin (since 0.1.9)

A server of your own that offers teams also answers, as [sync.md](sync.md) lists them:

- `PUT /api/team/key`, and `memberKey` on each member in `GET /api/team`;
- `GET /api/team/shares` answering `features` (`readers` when it keeps a share to the
  people its sharer chose; without it the app offers the whole team only) and `asks`;
  `POST` and `DELETE /api/team/shares/{uid}/ask` (optional: without them "Ask to share"
  says it isn't available);
- `POST /api/sync/challenge` taking `purpose` and answering `v: 2` (optional: without
  `v: 2` the app gives the proof's first form), and `POST shares/{id}/keys` taking
  `audience: 1` (a service that keeps readers should refuse a chosen share's wraps
  without it);
- `/api/team/shares` and everything under it: a share is stored and answered like a vault
  (the same record and chunk calls), with one writer and the team's members as readers.

And for any Sync server:

- `POST /api/sync/keep { collection, id, keep }` and `keep` on a record, for a snapshot
  pinned from a page (optional: without it nothing is ever kept from a page);
- a `challenge: { id, proof }` in the body of approving a device, a new recovery key, new
  keys and removing a device (also the header `X-Sync-Challenge` on the DELETE): check it,
  or ignore it;
- no redirects: the app follows none on `/oauth/token`, `/api/me`, `/api/sync/**` or
  `/api/team/**`, so the server answers those itself;
- app sessions only for an address the person confirmed.

`accounts.serverUrl` (the setting) is honoured only for a local address, or in a development
build: a release build talks to the server `product.json` names.

## Where it is in the code

- `product.json` → `scripts/gen.mjs` → `src/core/product.ts` (generated).
- `src/core/ownServices.ts`: `hasAccounts`, `hasSync`, `accountsServer`, `isLoopbackServer`,
  `accountPageUrl`, `planPageUrl`, `hasPlanPage`, `teamPageUrl`, `hasTeamPage`, `hasTeams`,
  `webAppUrl`, `webAppSharesAccounts`. DOM-free, tested.
- `scripts/web-host.mjs` reads `webAppPath`, `accountsUrl` and `webAppSubdomainIsolated`
  straight from `product.json` (it is plain Node), by the same rules.
- `src/extensions/builtins.ts`: Sync is in the list only when `hasSync()`, the team library
  only when `hasTeams()`.
- `src/extensions/accounts/index.ts` with `model.ts` (`accountsManifest`, `signInProviders`):
  what of the Accounts extension depends on `hasAccounts()`.
- Rust takes the server from the front end with each call (`base`); it reads no address of its
  own.

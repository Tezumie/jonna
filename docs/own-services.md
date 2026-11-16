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

## The keys

| Key | What it does | Left out or empty |
|---|---|---|
| `accountsUrl` | The accounts server: sign-in, the profile, and the server Sync talks to. `https://…`, without a path. | No account in the build: see "Without accounts". |
| `accountPagePath` | The account page the app opens in the browser (`sync.openAccountPage`: devices, storage, resetting sync). A path on the accounts server, or a whole URL when the page lives elsewhere. | `/account` |
| `planPagePath` | The page where a plan is bought, renewed or cancelled (`sync.managePlan`). A path on the accounts server, or a whole URL (a billing portal on another host). Set it to `""` when your service has no plans (sync that is free, or sold elsewhere): the IDE then shows no "Your plan" card, no "See plans" and no "Renew". | `/account#plan` |
| `teamPagePath` | The page where a subscriber's team is managed: inviting and removing people, seats, leaving (`sync.manageTeam`). A path on the accounts server, or a whole URL. Set it to `""` when your service has no teams: the IDE then shows nothing about teams, whatever the profile says. | `/account#team` |
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
server (`http://127.0.0.1:<port>` is accepted; any other server must be https). It exists only
in a build that has an accounts server, and the pages above are then opened on the server it
names.

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
secret. The page the browser shows after the redirect is the app's own (served from the
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
| `team` | `null` or `{ id, name, role, publisher }`, optional | The team the account is in (`role`: `"owner"` or `"member"`): see "Teams". A shape the app can't read counts as no team. |

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

## Without Sync

`"syncBuiltIn": false`. The Sync extension is then not activated
(`src/extensions/builtins.ts`), so the build has no Sync tab, no `sync.*` command or setting,
no status bar item and no `ide://sync`. The Accounts menu has no "Sync…" entry, and its
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
Nothing outside these folders imports them: the Accounts menu reaches Sync only by asking
whether the command `sync.show` exists.

The accounts code is `src/extensions/accounts/`, `src/core/ipc/accounts.ts`,
`src-tauri/src/accounts/` and `src-tauri/src/ipc/accounts.rs`. It is meant to stay (the
Accounts menu serves GitHub and extensions too); an empty `accountsUrl` is how a build goes
without an account.

## Where it is in the code

- `product.json` → `scripts/gen.mjs` → `src/core/product.ts` (generated).
- `src/core/ownServices.ts`: `hasAccounts`, `hasSync`, `accountsServer`, `accountPageUrl`,
  `planPageUrl`, `hasPlanPage`, `teamPageUrl`, `hasTeamPage`. DOM-free, tested.
- `src/extensions/builtins.ts`: Sync is in the list only when `hasSync()`.
- `src/extensions/accounts/index.ts` with `model.ts` (`accountsManifest`, `signInProviders`):
  what of the Accounts extension depends on `hasAccounts()`.
- Rust takes the server from the front end with each call (`base`); it reads no address of its
  own.

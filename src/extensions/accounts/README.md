# extensions/accounts

The Accounts menu (the person icon above the gear, D140): the IDE account (browser sign-in to
product.json's `accountsUrl`, or `accounts.serverUrl` while developing the service; the profile
is re-read from the server at startup and at most hourly, D414; Rust `src-tauri/src/accounts`,
what a server must implement in `docs/own-services.md`), GitHub through the
GitHub CLI (`gh auth status` / `gh auth login` in a terminal), a model provider shortcut and
settings backup (profile export / import; "Sync…" opens the Sync tab, `extensions/sync`, when the
profile says `sync: true`, D435, or `syncOffered: true`: sync is on sale to the account; after
`sync.checkPlan` asked the server, the saved profile is read again), and extensions' authentication
providers' accounts (D234: Sign out, or Sign in with… when none; `extensions.authSignIn` /
`authSignOut`). `model.ts` is DOM-free and tested.

**A build's own services** (`docs/own-services.md`): the server and whether Sync is built in come
from product.json through `core/ownServices.ts`. A build without an accounts server
(`accountsUrl: ""`) has no IDE account entry in the menu, no `accounts.cancelSignIn`, no
`accounts.serverUrl`, and `signIn` / `signOut` take only `github` (`accountsManifest`,
`signInProviders` in `model.ts`); a build without Sync calls the backup command "Back up
settings…" (`backupTitle`).

**Commands:** `accounts.showMenu`, `accounts.signIn {provider: ide|github}`,
`accounts.cancelSignIn`, `accounts.signOut {provider}`, `accounts.syncSettings`.
**Settings:** `accounts.serverUrl`.
**State:** `ide://accounts` (`extensions`: providers and accounts as of the menu's last opening).

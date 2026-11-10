# extensions/accounts

The Accounts menu (the person icon above the gear, D140): the IDE account (browser sign-in to
product.json's `accountsUrl`, or `accounts.serverUrl` while developing the service; the profile
is re-read from the server at startup and at most hourly, D414; Rust `src-tauri/src/accounts`, endpoints in docs/accounts.md), GitHub through the
GitHub CLI (`gh auth status` / `gh auth login` in a terminal), a model provider shortcut and
settings backup (profile export / import until sync exists), and extensions' authentication
providers' accounts (D234: Sign out, or Sign in with… when none; `extensions.authSignIn` /
`authSignOut`). `model.ts` is DOM-free and tested.

**Commands:** `accounts.showMenu`, `accounts.signIn {provider: ide|github}`,
`accounts.cancelSignIn`, `accounts.signOut {provider}`, `accounts.syncSettings`.
**Settings:** `accounts.serverUrl`.
**State:** `ide://accounts` (`extensions`: providers and accounts as of the menu's last opening).

# src/web

The front end as a website: the same workbench, with a **host** somewhere else in place of the
app's own backend. A proof of concept (D456): it runs against the windowless host on the same
computer. `docs/web-app.md` has the design, what works and what doesn't yet.

- `entry.ts`: the page's entry. Reads the link's fragment (`#h=<address>&t=<code>`) and takes
  it out of the address bar, or shows the form that asks for both; connects (by itself only
  to this computer); on an address shared with the account pages trusts less
  (`sharesAccountOrigin`: this computer only, no extension code, the code in memory only);
  installs the
  transport (`setTransport`) and the browser's shell (`setShell`); then imports `main.ts`, whose
  boot runs as in the app's window. A connection that ends under a running IDE is said over
  it, with Reconnect. The link is kept for the tab (`sessionStorage`), so a reload reconnects;
  a failed try forgets the code.
- `address.ts` (DOM-free, tested): the link's fragment, and the WebSocket address for what was
  typed. This computer plainly (`ws://127.0.0.1:…`), any other host only encrypted (`wss://`).
- `socketDuplex.ts`: a WebSocket as the `ByteDuplex` that `core/ipc/streamTransport.ts` runs
  the host's wire on (`docs/headless.md`). The host's side is `--listen-ws`
  (`src-tauri/src/host/ws.rs`).
- `shell.ts`: `createWebShell()`: the IDE's own dialogs for confirmations, a picker of its
  own where the desktop opens a native one (the host's folders, `fsIpc.pickerBrowse`), the
  browser's clipboard, full screen. Window controls do nothing.
- `policy.json`: the two content policies (the page's, the workers'). The build writes the
  page's into `index.html`; `scripts/web-host.mjs` serves with both; a site that serves the
  build sends them as headers (`docs/web-app.md`).
- `index.html`: the page (`noindex`; `<base>` is filled in by the build's `--base`).
- Styles: `src/styles/web.css`.

Build: `node build.mjs --web [--prod] [--base=/app/]` writes `dist-web/`. Try it:
`node scripts/web-host.mjs --serve` starts a host and serves the build on
`http://localhost:4173`, and prints the link to open.

No commands and no state of its own: everything after the connection is the window's.

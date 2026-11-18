# The front end as a website

A proof of concept (D456): the IDE's own front end, served as a web page, working on a
**host** it connects to. Nothing in the app's window changes. The page is not linked from
anywhere and asks not to be indexed.

## The pieces

```
browser tab                              a computer
+---------------------------+            +--------------------------------+
| the web build (src/web)   |  WebSocket | the windowless host (ide-host)  |
|  entry.ts: connect        | <--------> |  --listen-ws 127.0.0.1:<port>  |
|  StreamTransport          |  the wire  |  the same commands as the app  |
|  main.ts (unchanged boot) |  (v1)      |  files, terminals, git, models |
+---------------------------+            +--------------------------------+
```

- **The host** is the program the command-line agent already uses (D428): the backend with
  no window, answering the app's commands over a byte stream. New here is a third carrier
  beside its pipes and its TCP socket: `--listen-ws`, the same wire inside WebSocket binary
  messages (`src-tauri/src/host/ws.rs`, `docs/headless.md`). A browser can open nothing else.
- **The page** is `node build.mjs --web`: the window's bundle with another entry
  (`src/web/entry.ts`). It connects, installs the connection as the transport
  (`core/ipc/invoke.ts` `setTransport`) and a browser's shell (`createWebShell`), then loads
  `main.ts`. From there on it is the window's code: the workbench, the editor, terminals,
  the agent (which runs in the tab, as it runs in the window).
- **Nothing is stored by the site.** It serves static files. The connection goes from the
  tab straight to the host; the code that opens it is in the link's fragment, which a
  browser never sends to a server.

## Trying it

On the computer to work on:

```
cd src-tauri && cargo build --no-default-features --features host --bin ide-host
node scripts/web-host.mjs
```

It starts the host with a new code and prints a link to the page named by product.json
(`accountsUrl` + `webAppPath`). Open the link in a browser **on the same computer**. The
host uses the app's own settings, keys, chats and recent folders (`--user-data-dir` for a
separate profile), so it is the installed app's data seen from a browser.

The first time, the browser asks whether the site may reach programs on this computer (in
Chromium: "apps on this device" / local network access). Without it the page can't reach
`127.0.0.1`; the page says so when that is why a connection failed.

A local build instead of the deployed page: `node build.mjs --web`, then
`node scripts/web-host.mjs --serve` (serves `dist-web/` on `http://localhost:4173` with the
headers below).

`node scripts/web-e2e.mjs <host program>` checks the carrier against the real host.

## Who may connect

Three checks, each for a different attacker:

| Check | Where | Against |
|---|---|---|
| The page's origin is on the host's list (`--allow-origin`) | the WebSocket upgrade | any other website open in the browser |
| The `Host` header names this computer | the upgrade | a name pointed at 127.0.0.1 (DNS rebinding) |
| The code (`$/hello`'s token, 192 random bits, compared in constant time) | the wire | other tabs of an allowed site, other programs on the computer |

The host listens on loopback only and serves one client at a time. The code is handed to it
in its environment, never on its command line.

## What the page does with a link

- The fragment (`#h=<address>&t=<code>`) is read and taken out of the address bar at once.
  The browser's own history may still have recorded the address it was opened with; the code
  is good only while that host runs, and only from this computer.
- It is kept for the tab (`sessionStorage`) so a reload reconnects, and forgotten after a
  failed try. **Not on an address shared with the account pages** (below): there it is held in
  memory only, and a reload asks for the link again.
- A link that arrives while a connection is up is not followed.
- **A link connects by itself only to this computer.** A link is something anyone can send,
  and a host is trusted with the page. A link naming another machine only fills the form.
- This computer is reached with `ws://` (nothing leaves it); any other host only with
  `wss://`.

## Sharing an address with the account pages

The deployed page is at a path of the accounts server's own address. That origin's storage
holds a signed-in session of the account pages, and anything that runs in the page can read
it. It cuts the other way too: any page of that address can reach what this page stores, and
the host's origin check lets every one of them in. So where the page's address is the
accounts server's, or a name under or above it (`sharesAccountOrigin` in `entry.ts`; a
subdomain is another origin but the same site, with the same cookies):

- it connects **only to this computer**: no other host, typed or linked;
- it runs **no extension code and no script a model wrote** (`core/extensions/codePolicy.ts`):
  an extension's worker and the agent's workflow worker have the page's origin. `web-host.mjs`
  starts the host with `--disable-extensions` to match;
- it **keeps the code in memory only**.

A copy served from **another domain** has none of these limits. **That is where the page
belongs before it is offered to anyone:** hosts on other machines, and extensions, both need
it. Until then a bug in any page of the account site is a way to this computer while a host
runs, and the other way round.

The page still writes the first-paint cache of its theme into the address's `localStorage`
(`settings-first-paint`), as the window does into its own.

## What the site must send

For a fork that serves the build (`docs/own-services.md`, `webAppPath`). Two policies,
because a worker follows the policy its own script was served with, not the page's. Both are
in `src/web/policy.json`:

- `page`: the app window's own policy, plus `connect-src` for a WebSocket to a host and
  `base-uri 'self'` for the page's `<base>`. The build writes it into the page as a meta
  tag, so it holds where a site forgets the header; the header adds `headerOnly`
  (`frame-ancestors`). On an address shared with account pages, send it **without `wss:`**:
  the page connects to this computer only there, and the policy should say the same.
- `worker`, for `workers/**`: an extension's code is evaluated inside its worker, and
  nothing may be fetched from it.

And `X-Robots-Tag: noindex, nofollow` and `Referrer-Policy: no-referrer` while it is not
meant to be found.

## What works, and what doesn't yet

Tried in a browser against a host on the same computer (Windows): opening a folder, the
explorer and its watcher, the editor with saving, the Markdown preview, a PowerShell
terminal with shell integration, a chat with a local model, workspace trust, a reload that
comes back to the same folder, tabs and terminal.

Not there, or not tried:

- **Pickers** are the page's own (`src/web/shell.ts`, the `picker_browse` command): the
  host's folders to walk through, its drives, and a field for a typed or pasted path. Plain:
  no search, no new folder, one path at a time.
- **The browser pane, screenshots, native menus, auxiliary windows, the updater, drag and
  drop from the OS, dictation**: desktop-only commands. Their buttons are still drawn and
  answer "unknown command".
- **Previews and extension pages** are frames on `127.0.0.1` ports of the host: they work
  only because the browser is on the same computer. Elsewhere they need forwarded ports.
- **Extensions**: off on the accounts' address (above); untested otherwise.
- **One client at a time**, and the host exits a while after the tab is gone (`--linger`).
  A second tab is refused.
- **The agent stops when the tab closes**: it runs in the page.
- **The installers don't carry the host program.** It is built from the repository.
- **macOS** has never run the host. Safari refuses `ws://127.0.0.1` from an `https` page.

## Where this goes

The page doesn't care where a host is; only `src/web/address.ts` decides what an address may
be. What each kind of host still needs:

| Host | Needs |
|---|---|
| This computer (built) | The host program in the installers, and a command in the app that starts it and shows the link |
| A machine with a public address (your own server or VM) | TLS in front of the host (`wss://`), the host listening beyond loopback behind it, the page on an address of its own |
| A computer behind a home router | A relay both sides connect out to; the page and the host seal what crosses it |
| A machine we run | The above plus a VM per person, started and stopped by the service |
| Someone else's computer | Device keys in place of a shared code, and a way to say what they may do |

For all but the first, the code in a link is not enough: a browser's device key on the
host's allow list is the plan, with pairing by a short code shown on the host.

# The front end as a website

A proof of concept (D459, D460): the IDE's own front end, served as a web page, working on a
**host** it connects to. Nothing in the app's window changes. The page asks not to be indexed.

Making your own from this code (your page, your hosts, your names) is
["Running your own"](#running-your-own) below; everything is set in `product.json` or by a
flag, and nothing assumes a particular web host.

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
npm run web:host:build      # cargo build ... --features host --bin ide-host --release
npm run web:host            # node scripts/web-host.mjs  (--help lists its options)
```

It starts the host with a new code and prints a link to the page named by product.json
(`webAppPath`: a whole URL, or a path on `accountsUrl`; `--site <url>` for another page).
Open the link in a browser **on the same computer**. The
host uses the app's own settings, keys, chats and recent folders (`--user-data-dir` for a
separate profile), so it is the installed app's data seen from a browser.

The first time, the browser asks whether the site may reach programs on this computer (in
Chromium: "apps on this device" / local network access). Without it the page can't reach
`127.0.0.1`; the page says so when that is why a connection failed.

A local build instead of a deployed page: `node build.mjs --web`, then
`node scripts/web-host.mjs --serve` (serves `dist-web/` on `http://localhost:4173` with the
headers below).

`node scripts/web-e2e.mjs <host program>` checks the carrier against the real host.

## Who may connect

Three checks, each for a different attacker:

| Check | Where | Against |
|---|---|---|
| The page's origin is on the host's list (`--allow-origin`) | the WebSocket upgrade | any other website open in the browser |
| The `Host` header names this computer, or a name the host was given (`--allow-host`) | the upgrade | a name pointed at 127.0.0.1 (DNS rebinding) |
| The code (`$/hello`'s token, 192 random bits, compared in constant time) | the wire | other tabs of an allowed site, other programs on the computer |

The host listens on loopback only and serves one client at a time. The code is handed to it
in its environment, never on its command line. A connection takes the host's one place only
once its upgrade was accepted: sockets that say nothing, or are refused, keep nobody out
(eight are read at a time).

## What the page does with a link

- The fragment (`#h=<address>&t=<code>`) is read and taken out of the address bar at once.
  The browser's own history may still have recorded the address it was opened with; the code
  is good only while that host runs, and only from this computer.
- It is kept for the tab (`sessionStorage`) so a reload reconnects, and forgotten after a
  failed try. **Not on an address shared with the account pages** (below): there it is held in
  memory only, and a reload asks for the link again.
- A kept code is used only with the address it was kept with: a link that names another
  address never has the tab send the code there.
- A try that never reached the host (the browser refused, nothing listening) leaves the code
  in the form: nothing was sent.
- A link that arrives while a connection is up is not followed.
- **A link connects by itself only to this computer.** A link is something anyone can send,
  and a host is trusted with the page. A link naming another machine only fills the form.
- This computer is reached with `ws://` (nothing leaves it); any other host only with
  `wss://`.

## Sharing an address with the account pages

A page may be served at a path of the accounts server's own address (`webAppPath: "/app/"`:
the simplest thing to deploy, and how this proof of concept began). That origin's storage
holds a signed-in session of the account pages, and anything that runs in the page can read
it. It cuts the other way too: any page of that address can reach what this page stores, and
the host's origin check lets every one of them in. So where the page shares its address with
the account pages (`webAppSharesAccounts` in `core/ownServices.ts`, which
`scripts/web-host.mjs` follows too):

- it connects **only to this computer**: no other host, typed or linked;
- it runs **no extension code and no script a model wrote** (`core/extensions/codePolicy.ts`):
  an extension's worker and the agent's workflow worker have the page's origin. `web-host.mjs`
  starts the host with `--disable-extensions` to match;
- it **keeps the code in memory only**.

What counts as sharing:

| The page is on | Shares? |
|---|---|
| The accounts server's own name (`example.com/app/`) | Always: one origin. |
| Another name of the same domain (`app.example.com` beside `example.com` or `www.example.com`) | Yes, unless product.json says `"webAppSubdomainIsolated": true`. It is another origin with storage of its own, but the same site: a cookie set for the whole domain reaches both. Set the key only when the accounts server sets no such cookie (it signs in with tokens kept in the browser's storage, or sets cookies for its exact host only), and keep it that way. |
| Another domain | No. |
| A build without `accountsUrl` | No: there is nothing to share with. |

"The same domain" is the last two labels of the names, since the code carries no list of
public suffixes: two names under `co.uk`, `web.app` or `github.io` count as one domain.
That errs on the careful side; the key lifts it.

A page that doesn't share has none of these limits. **That is where the page belongs before
it is offered to anyone:** hosts on other machines, and extensions, both need it. Until then
a bug in any page of the account site is a way to this computer while a host runs, and the
other way round.

The page still writes the first-paint cache of its theme into the address's `localStorage`
(`settings-first-paint`), as the window does into its own.

## What the site must send

For whoever serves the build (`docs/own-services.md`, `webAppPath`). The page works with no
header at all: its own policy is written into it, and a worker served without a policy runs
unrestricted, as in the app's window. The headers make it tighter. Two policies,
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
meant to be found. One mistake breaks extensions: a site-wide `Content-Security-Policy`
header that also lands on `workers/**` (an extension's code needs `'unsafe-eval'` there).
`.wasm` files must be served as `application/wasm`.

## Running your own

What someone who builds their own product from this code does to have their own page and
their own hosts. Nothing here needs our services, and nothing assumes a particular web host.

### 1. Name things (`product.json`)

| Key | For the web front end |
|---|---|
| `nameLong` | The tab's title and the wording of the connect form. |
| `webAppPath` | Where your page is served: a whole URL (`https://ide.example.com/`), or a path on `accountsUrl` (`/app/`). `scripts/web-host.mjs` allows that page and prints links to it. Empty: no page (give `--site` each time). |
| `accountsUrl` | Only matters here for the rule above: a page that shares its address with your account pages trusts less. A build without accounts has no such limit. |
| `webAppSubdomainIsolated` | `true` when the page is on another name of your accounts server's domain and that server sets no cookie for the whole domain. |

`npm run gen` (run by every build) checks the file and warns about a key nothing reads.

### 2. Build and serve the page

```
npm run web                       # the page at the root of its address: dist-web/
npm run web -- --base=/app/       # the page under a path (the path must end in a slash)
```

`dist-web/` is static files: any web host serves it. It stores nothing and calls nothing but
the host a person connects to. Serve `index.html` for the folder itself (with the trailing
slash when it is under a path), and optionally the headers of "What the site must send".
In Git Bash on Windows a path argument is rewritten unless `MSYS_NO_PATHCONV=1` is set.

The headers, as two common hosts take them (replace the two policies with
`src/web/policy.json`'s `page` + `headerOnly` joined by `; `, and `worker`):

```
# Caddy
ide.example.com {
	root * /srv/ide/dist-web
	file_server
	header Content-Security-Policy "<page policy>"
	header /workers/* Content-Security-Policy "<worker policy>"
	header X-Content-Type-Options nosniff
	header Referrer-Policy no-referrer
}
```

```
# nginx
server {
	server_name ide.example.com;
	root /srv/ide/dist-web;
	add_header X-Content-Type-Options nosniff always;
	add_header Referrer-Policy no-referrer always;
	location /workers/ { add_header Content-Security-Policy "<worker policy>" always; }
	location /         { add_header Content-Security-Policy "<page policy>" always; }
}
```

Hosts configured by a file of header rules (Firebase Hosting, Netlify, Cloudflare Pages)
take the same two rules: one for the page's folder, a more specific one for `workers/**`.

### 3. Build the host

```
npm run web:host:build            # src-tauri/target/release/ide-host
```

One program, no window, the same backend as the app; it builds on Windows, Linux and macOS
(macOS has never been run). `ide-host --help` lists its flags; `docs/headless.md` is its
wire. It reads the product's names from `product.json` when it is built, and keeps its
settings where the app does (`--user-data-dir` for another place).

### 4a. A host on the computer the browser is on

```
npm run web:host                  # prints https://<your page>#h=127.0.0.1:<port>&t=<code>
```

The link connects by itself. This is the whole setup for "my own computer, from a browser".

### 4b. A host on a server

The host never listens beyond loopback and never speaks TLS. A proxy on the same machine
does both, and the host is told the name it is reached by:

```
npm run web:host -- --port 4000 --public dev.example.com
```

```
# Caddy: TLS for dev.example.com, WebSocket passed through to the host
dev.example.com {
	reverse_proxy 127.0.0.1:4000
}
```

```
# nginx
location / {
	proxy_pass http://127.0.0.1:4000;
	proxy_http_version 1.1;
	proxy_set_header Upgrade $http_upgrade;
	proxy_set_header Connection "upgrade";
	proxy_set_header Host $host;
	proxy_read_timeout 1d;
}
```

The link it prints (`#h=wss://dev.example.com&t=<code>`) fills the page's form; the person
presses Connect (a link never connects by itself to another machine). What to know:

- The proxy must pass the `Host` and `Origin` headers as they came. The host checks both:
  `--allow-host` is the proxy's public name, `--allow-origin` your page's origin
  (`web-host.mjs` passes both).
- Without the launcher (no Node on the server):
  `IDE_HOST_TOKEN=<a long random code> ide-host --listen-ws 127.0.0.1:4000 --allow-origin https://ide.example.com --allow-host dev.example.com --linger 86400`,
  and the link is `https://ide.example.com/#h=wss://dev.example.com&t=<that code>`.
- The code is the only key, and whoever has it is the account the host runs under, with its
  files and a terminal. Run the host as a user made for it, one person a host.
- `IDE_HOST_TOKEN` set beforehand keeps the same code across restarts (a service manager
  restarting the host); otherwise each start makes a new one.
- The host exits when nobody has come back for `--linger` seconds; a service manager
  (systemd, a container's restart policy) starts it again.
- The page must not share its address with account pages (above), or it refuses any host
  but its own computer.
- Not there yet for a remote host: previews and extension pages (frames on the host's own
  `127.0.0.1` ports), more than one tab or person a host, and keys per device in place of
  the one code.

### 5. Check it

`node scripts/web-e2e.mjs <host program>` drives the real host over a WebSocket: the origin
and name checks, the code, a command, a file written and read back.

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
- **Extensions**: off on an address shared with the account pages (above); untested otherwise.
- **One client at a time**, and the host exits a while after the tab is gone (`--linger`).
  A second tab is refused.
- **The agent stops when the tab closes**: it runs in the page.
- **The installers don't carry the host program.** It is built from the repository
  (`npm run web:host:build`), and no command in the app starts it or opens the page yet.
- **A host on `[::1]`** can't be reached by a page (its policy names `127.0.0.1` and
  `localhost`), so `--listen-ws` takes `127.0.0.1` only.
- **macOS** has never run the host. Safari refuses `ws://127.0.0.1` from an `https` page.

## Where this goes

The page doesn't care where a host is; only `src/web/address.ts` decides what an address may
be. What each kind of host still needs:

| Host | Needs |
|---|---|
| This computer (built) | The host program in the installers, and a command in the app that starts it and shows the link |
| A machine with a public address: your own server or VM (built, see "Running your own"; not yet tried with real TLS) | A proxy with TLS in front of the host, the page on an address that doesn't share with account pages. Still missing there: forwarded ports for previews, more than one person a host |
| A computer behind a home router | A relay both sides connect out to; the page and the host seal what crosses it |
| Machines a service runs for its users | The above plus a machine per person, started and stopped by the service, each with its own name and code |
| Someone else's computer | Device keys in place of a shared code, and a way to say what they may do |

For all but the first, the code in a link is not enough: a browser's device key on the
host's allow list is the plan, with pairing by a short code shown on the host.

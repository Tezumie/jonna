# Workspace machines: a machine per person, opened in the browser

How to give each of your users a machine of their own with the IDE's host on it, which they
open in the web front end (`docs/web-app.md`). This is the "run it for other people" step
after "Running your own": the web page is the same, and the host is the same program. What is
added is a machine image, and a small service of yours that starts and stops machines and says
who may open which.

The image and its scripts are in `scripts/workspace/`. The service is yours to write: it is
tied to your accounts and your cloud. This page says what it must do, and why.

## The pieces

```
your account page ──start / open──▶ your service ──create / start / stop──▶ the cloud's API
        │                                  │
        │   { url: page#h=wss://name&t=code }   the code, in the machine's metadata
        ▼                                  ▼
the web front end ───────wss────▶ proxy (Caddy, TLS) ──ws──▶ the host, as the user `dev`
(its own address)                 on the person's machine     on 127.0.0.1 only
```

- **One machine a person.** A real virtual machine, not a container shared with others: what
  one person runs can never reach another's files.
- **The host takes one code.** Your service makes a new one at every start, gives it to the
  machine (its metadata, or a file) and to the signed-in owner, and to nobody else.
- **The page is opened with the address and the code in the URL's fragment**
  (`#h=wss://name&t=code`). A browser never sends a fragment to a server, and the page takes
  it out of the address when it has read it.
- **The host lets one page in:** the web front end's origin (`--allow-origin`), reached by the
  machine's own name (`--allow-host`). Any other website's page is refused, with or without
  the code, and so is a program that names no origin. A connection is given the host's one
  place only once its first message has arrived: one that says nothing holds nothing.

## The image

`scripts/workspace/setup.sh` turns a fresh Ubuntu 24.04 machine into the image:

```
sudo sh setup.sh ./ide-host
```

It installs the proxy (Caddy), the host as a service of the user `dev` (with `sudo`: the
machine is the person's own), git, Node.js (checked against its published SHA-256), Python and
build tools, a swap file, and three units:

| Unit | What it does |
|---|---|
| `ide-boot.service` | At every boot, before the others: reads the three values below and writes the code's file, the host's arguments and the proxy's configuration. Refuses values that aren't what they should be. |
| `ide-host.service` | The host on `127.0.0.1:7700`, in `/home/dev/projects`, restarted if it stops. |
| `ide-idle.timer` | Every two minutes: no page connected for `IDE_IDLE_MINUTES` (30) switches the machine off. "Connected" is the host's own word (`--active-file`): a connection that never shows the code doesn't count. |

Then stop the machine and make an image of its disk. Before you do, remove the user you set it
up as and its SSH keys, or every machine made from the image carries them.

The host must be built for Linux first (`docs/web-app.md`, "Build the host"); it needs
`build-essential pkg-config libdbus-1-dev`, and can't be cross-built from Windows without a C
compiler for Linux (WSL works).

### What a machine is told at start

| Value | Meaning |
|---|---|
| `IDE_TOKEN` | The code a page must send. 32 to 128 letters, digits, `-` or `_`. New at every start. |
| `IDE_ORIGIN` | The page that may connect: `https://app.example.com`. |
| `IDE_NAME` | The name the machine is reached by; the proxy gets its certificate for it. Left out, it is the public address under `IDE_NAME_SUFFIX` (`sslip.io`: a name service that answers `203-0-113-7.sslip.io` with that address, so no DNS record is needed). |
| `IDE_IDLE_MINUTES` | Minutes with no page connected before the machine switches itself off (0: never). |

On Google Compute Engine they are the instance's metadata (`ide-token`, `ide-origin`,
`ide-name`, `ide-name-suffix`, `ide-idle-minutes`). On another cloud, have its first-boot
mechanism write them to `/etc/ide/workspace.env` in that form; `boot.sh` reads the file when it
is there.

For real use give machines names under a domain of yours (`IDE_NAME`, with a DNS record your
service makes): the name then stays the same when the address changes, the certificate is kept
on the disk between starts, and you don't depend on someone else's name service or share its
certificate limits.

## What your service must do

1. **Know who is asking**, with your own sign-in, and hand a machine's code only to its owner.
2. **Make a code at every start** (32 random bytes), keep it where no browser can read it, and
   forget it when the machine stops.
3. **Start, stop and delete machines** through the cloud's API, from a credential that can do
   nothing else.
4. **Count the running time itself**, from the cloud's own word on what runs, and stop a
   machine from outside when its owner's allowance is used. The switch-off on the machine is a
   convenience: its owner has root and can turn it off.
5. **Answer "open"** with the page's address, the machine's `wss://` name and the code in the
   fragment, once the machine answers through its proxy.

## What keeps people apart

- **A network of their own for the machines**, where the only thing let in is ports 80 and
  443, and machines are not let through to each other. A development server someone starts on
  their machine is then not reachable by the neighbours.
- **No cloud credentials on a machine** (no service account, no instance role): the metadata
  service has nothing to give but the machine's own three values.
- **Your own access kept out.** Project-wide SSH keys are blocked on these machines; nobody at
  the service has a shell on a customer's machine.
- **The code is as good as a key to the machine** until the machine next stops. It is sent
  over TLS only, lives in the page's memory, and a new start makes the old one worthless.
- **An address can pass to another machine.** With names made from addresses, a stopped
  machine's address may be given to someone else's machine later, and a tab left open on the
  old machine would then reconnect to the new one. The old code doesn't open it, but the
  person there has root: a program of theirs that pretends to be a host could answer that tab.
  Give machines names of your own (below) before strangers share a pool of addresses: a name
  then never points at someone else's machine.

## What it doesn't do yet

- **Ports a program listens on** aren't forwarded to the browser: a preview of a development
  server needs that (planned).
- **A project's files live on the machine.** Deleting the machine deletes them; git, or the
  IDE's sync, is what makes them outlast it.
- **Signing in to the IDE's own account from inside a workspace** doesn't work: that sign-in
  opens a browser on the machine it runs on.

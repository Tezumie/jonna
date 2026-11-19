// Starts the windowless host for a page in a browser and prints the link that connects to it.
// What a computer runs to be worked on from the web build (src/web, docs/web-app.md): this
// computer for its own browser, or a server behind a proxy that carries TLS (--public).
//
//   node scripts/web-host.mjs [options]        (--help prints the list below)
//
// Plain Node, no dependencies. The code is made here, handed to the host in its environment
// (never on its command line, where other programs could read it) and printed once in the link.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `Starts the host for the web front end and prints the link that connects to it.

  node scripts/web-host.mjs [options]

  --host <path>          The host program (else IDE_HOST_PATH, else this checkout's build).
  --site <url>           The page that may connect (default: product.json's webAppPath,
                         on its accountsUrl when it is a path).
  --serve [port]         Also serve dist-web/ on http://localhost:<port> (default 4173) and
                         allow that page: for trying a local build (node build.mjs --web).
  --port <n>             The loopback port the host listens on (default: any free one).
                         A proxy in front of the host needs one that stays the same.
  --public <address>     The address the host is reached by from other computers, when a
                         proxy that carries TLS forwards to it (dev.example.com, or
                         dev.example.com:8443). The link then names it, and the host
                         answers to that name. Without it: this computer only.
  --user-data-dir <dir>  A separate profile (default: the app's own settings and chats).
  --linger <seconds>     How long the host waits for the page to come back (default 3600).
  --disable-extensions   Run the session without extensions.
  -h, --help             Print this.

The code in the link is new each time, unless IDE_HOST_TOKEN is set (a service that restarts
the host keeps its links working that way). Anyone with the link can use the computer as the
account the host runs under.`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const product = JSON.parse(readFileSync(join(root, "product.json"), "utf8"));

function option(name) {
  const at = process.argv.indexOf(name);
  if (at < 0) return undefined;
  const value = process.argv[at + 1];
  return value && !value.startsWith("--") ? value : "";
}

function fail(message) {
  console.error(`web-host: ${message}`);
  process.exit(2);
}

function findHost() {
  const exe = process.platform === "win32" ? "ide-host.exe" : "ide-host";
  const named = option("--host") || process.env.IDE_HOST_PATH;
  if (named) return resolve(named);
  const folders = [
    process.env.CARGO_TARGET_DIR,
    join(root, "src-tauri", "target-host"),
    join(root, "src-tauri", "target"),
    join(root, "src-tauri", "target-uitest"),
  ].filter(Boolean);
  for (const folder of folders)
    for (const profile of ["release", "debug"]) {
      const candidate = join(folder, profile, exe);
      if (existsSync(candidate)) return candidate;
    }
  return null;
}

/** A page's address, or null when it isn't one. */
function pageUrl(text) {
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * The page product.json names (src/core/ownServices.ts `webAppUrl`): `webAppPath` when it is a
 * whole URL, else that path on the accounts server; null when the build names none.
 */
function productPage() {
  const page = (product.webAppPath ?? "").trim();
  if (!page) return null;
  if (/^https?:\/\//i.test(page)) return pageUrl(page);
  const accounts = (product.accountsUrl ?? "").trim();
  if (!accounts || !pageUrl(accounts)) return null;
  return new URL(page, accounts);
}

/**
 * Whether a page shares its address with the account pages: the same name, or another name of
 * the same domain unless product.json says the accounts server keeps nothing there. The rule
 * is src/core/ownServices.ts `webAppSharesAccounts`, which the page itself follows: keep the
 * two alike. Such a page runs no extension code, so the host is started without extensions.
 */
function sharesAccounts(page) {
  const accounts = pageUrl((product.accountsUrl ?? "").trim());
  if (!(product.accountsUrl ?? "").trim()) return false;
  if (!accounts) return true;
  const here = page.hostname.toLowerCase();
  const there = accounts.hostname.toLowerCase();
  if (here === "localhost" || here === "127.0.0.1") return false;
  if (here === there) return true;
  if (product.webAppSubdomainIsolated === true) return false;
  if (/^[\d.]+$/.test(here) || here.includes(":") || !here.includes(".")) return false;
  const domain = (name) => name.split(".").slice(-2).join(".");
  return domain(here) === domain(there);
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * The content policy the page is served with (docs/web-app.md, "What the site must send"): the
 * app window's own, with the one thing a page here needs added, a WebSocket to a host. The site
 * that serves the build sends the same header; this copy is for trying a build locally. The
 * text is src/web/policy.json's, which the build also writes into the page itself.
 */
const policy = JSON.parse(readFileSync(join(root, "src/web/policy.json"), "utf8"));
export const CONTENT_POLICY = [...policy.page, ...policy.headerOnly].join("; ");

/**
 * The policy for the worker scripts (`workers/`). A worker follows the policy its own script
 * was served with, not the page's. In the app's window they are served with none; here they get
 * what they need and no more: an extension's code is evaluated inside its worker (which has
 * taken its own network and loaders away, src/workers/lockdown.ts), so `unsafe-eval` there,
 * and nothing may be fetched from anywhere.
 */
export const WORKER_POLICY = policy.worker;

/** Serves dist-web/ as a site would serve it. Loopback only. */
function serveBuild(port) {
  const folder = join(root, "dist-web");
  if (!existsSync(join(folder, "index.html")))
    fail("no dist-web/ here. Build it first: node build.mjs --web");
  const server = createServer((request, response) => {
    let path;
    try {
      path = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }
    let file = normalize(join(folder, path));
    if (file !== folder && !file.startsWith(folder + sep)) {
      response.writeHead(403).end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "Content-Security-Policy": path.startsWith("/workers/") ? WORKER_POLICY : CONTENT_POLICY,
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
    });
    const stream = createReadStream(file);
    // A file that went away between the check and the read ends the answer, not the server.
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  });
  return new Promise((done) => {
    server.on("error", (e) => fail(`couldn't serve on port ${port}: ${e.message}`));
    server.listen(port, "127.0.0.1", () => done(server));
  });
}

const binary = findHost();
if (!binary || !existsSync(binary))
  fail(
    "no host program found. Build it (in src-tauri/): cargo build --no-default-features --features host --bin ide-host",
  );

// Windows: the newer ConPTY the app installs beside its program (scripts/fetch-conpty.mjs puts
// it in src-tauri/conpty/<arch>/). A host built from the repository has none beside it, and
// with the system's own a terminal may show nothing when the host has no console of its own.
if (process.platform === "win32") {
  const from = join(root, "src-tauri", "conpty", process.arch);
  for (const file of ["conpty.dll", "OpenConsole.exe"]) {
    const beside = join(dirname(binary), file);
    if (existsSync(beside) || !existsSync(join(from, file))) continue;
    try {
      copyFileSync(join(from, file), beside);
    } catch {
      // Read-only place: the system's ConPTY is used.
    }
  }
}

const sites = [];
const site = option("--site");
if (site !== undefined) {
  const named = pageUrl(site);
  if (!named) fail(`--site needs a page's address (https://ide.example.com/), not "${site}"`);
  sites.push(named);
} else {
  const named = productPage();
  if (named) sites.push(named);
}
const servePort = option("--serve");
if (servePort !== undefined) {
  const port = Number(servePort) || 4173;
  await serveBuild(port);
  const local = new URL(`http://localhost:${port}/`);
  // Named with --site as well: one link, not two.
  if (!sites.some((page) => page.href === local.href)) sites.unshift(local);
}
if (!sites.length)
  fail(
    "no page to allow. Give one with --site <url>, set webAppPath in product.json, or use --serve.",
  );

const port = option("--port");
if (port !== undefined && !/^\d{1,5}$/.test(port)) fail("--port needs a port number");

// Where other computers reach the host: a name (and maybe a port) a proxy with TLS answers on.
const publicAddress = option("--public");
let publicHost = null;
if (publicAddress !== undefined) {
  const text = publicAddress.replace(/^wss:\/\//i, "");
  let parsed = null;
  try {
    parsed = new URL(`wss://${text}`);
  } catch {
    // Said below.
  }
  if (!text || !parsed || parsed.username || parsed.pathname !== "/" || parsed.search)
    fail(`--public needs a host name like dev.example.com, not "${publicAddress}"`);
  publicHost = parsed;
}

const guarded = sites.some(sharesAccounts);
if (guarded && publicHost)
  console.error(
    "web-host: a page on the account pages' address connects to its own computer only: --public needs the page on an address of its own (docs/web-app.md).",
  );

const token = process.env.IDE_HOST_TOKEN?.trim() || randomBytes(24).toString("base64url");
const args = ["--listen-ws", `127.0.0.1:${port || 0}`, "--linger", option("--linger") || "3600"];
const origins = new Set(sites.map((page) => page.origin));
// The local server answers under both of this computer's names: either may be typed.
for (const origin of [...origins])
  if (origin.startsWith("http://localhost:"))
    origins.add(origin.replace("http://localhost:", "http://127.0.0.1:"));
for (const origin of origins) args.push("--allow-origin", origin);
if (publicHost) args.push("--allow-host", publicHost.hostname);
const noExtensions = guarded || process.argv.includes("--disable-extensions");
if (noExtensions) args.push("--disable-extensions");
const profile = option("--user-data-dir");
if (profile) args.push("--user-data-dir", resolve(profile));

const host = spawn(binary, args, {
  stdio: ["ignore", "inherit", "pipe"],
  env: { ...process.env, IDE_HOST_TOKEN: token },
});
host.on("error", (e) => fail(`couldn't start ${binary}: ${e.message}`));
let printed = false;
let pending = "";
host.stderr.on("data", (chunk) => {
  pending += chunk.toString("utf8");
  let end = pending.indexOf("\n");
  while (end >= 0) {
    const line = pending.slice(0, end).trimEnd();
    pending = pending.slice(end + 1);
    const listening = /^host: listening on ws:\/\/(\S+)$/.exec(line);
    if (listening && !printed) {
      printed = true;
      const address = publicHost ? `wss://${publicHost.host}` : listening[1];
      const fragment = new URLSearchParams({ h: address, t: token }).toString();
      if (publicHost) {
        console.log(`The host is running on ${listening[1]}, reached as ${address}.`);
        console.log("Open one of these, then press Connect:\n");
      } else console.log("The host is running. Open one of these on this computer:\n");
      for (const page of sites) console.log(`  ${page}#${fragment}\n`);
      console.log("Anyone with a link can use this computer as you: don't share it.");
      if (guarded)
        console.log("Extensions are off in this session (the page is on the accounts' address).");
      else if (noExtensions) console.log("Extensions are off in this session.");
      console.log("Ctrl+C stops the host.");
    } else if (line) console.error(line);
    end = pending.indexOf("\n");
  }
});
let exited = false;
host.on("exit", (code) => {
  exited = true;
  process.exit(code ?? 0);
});
// However this script ends, the host (and its code) doesn't outlive it.
process.on("exit", () => {
  if (!exited) host.kill();
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    // Ctrl+C in a Windows console reaches the host too, and there kill() ends a program at
    // once: let the host finish its own shutdown (terminals, files it must remove) first.
    if (process.platform === "win32" && signal === "SIGINT") {
      setTimeout(() => host.kill(), 5000).unref();
      return;
    }
    host.kill();
  });

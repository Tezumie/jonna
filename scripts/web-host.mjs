// Starts the windowless host for a page in a browser and prints the link that connects to it.
// What a computer runs to be worked on from the web build (src/web); the desktop app does the
// same from its "Open in the browser" command.
//
//   node scripts/web-host.mjs [options]
//     --host <path>          the host program (else IDE_HOST_PATH, else a checkout's build)
//     --site <url>           the page that may connect (default: product.json's site and path)
//     --serve [port]         also serve dist-web/ on http://localhost:<port> (default 4173) and
//                            allow that page: for trying a local build (`node build.mjs --web`)
//     --user-data-dir <dir>  a separate profile (default: the app's own settings and chats)
//     --linger <seconds>     how long the host waits for the page to come back (default 3600)
//
// Plain Node, no dependencies. The code is made here, handed to the host in its environment
// (never on its command line, where other programs could read it) and printed once in the link.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const product = JSON.parse(readFileSync(join(root, "product.json"), "utf8"));

function option(name) {
  const at = process.argv.indexOf(name);
  if (at < 0) return undefined;
  const value = process.argv[at + 1];
  return value && !value.startsWith("--") ? value : "";
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

/** Serves dist-web/ as a site would serve it. Loopback only. */
function serveBuild(port) {
  const folder = join(root, "dist-web");
  if (!existsSync(join(folder, "index.html"))) {
    console.error("web-host: no dist-web/ here. Build it first: node build.mjs --web");
    process.exit(2);
  }
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname);
    let file = normalize(join(folder, path));
    if (file !== folder && !file.startsWith(folder + sep)) {
      response.writeHead(403).end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    createReadStream(file).pipe(response);
  });
  return new Promise((done) => server.listen(port, "127.0.0.1", () => done(server)));
}

const binary = findHost();
if (!binary || !existsSync(binary)) {
  console.error(
    "web-host: no host program found. Build it (in src-tauri/): cargo build --no-default-features --features host --bin ide-host",
  );
  process.exit(2);
}

const sites = [];
const site = option("--site");
if (site) sites.push(site);
else if (product.accountsUrl && product.webAppPath)
  sites.push(new URL(product.webAppPath, product.accountsUrl).toString());
const servePort = option("--serve");
if (servePort !== undefined) {
  const port = Number(servePort) || 4173;
  await serveBuild(port);
  sites.unshift(`http://localhost:${port}/`);
}
if (!sites.length) {
  console.error("web-host: no page to allow. Give one with --site <url>, or use --serve.");
  process.exit(2);
}

const token = randomBytes(24).toString("base64url");
const args = ["--listen-ws", "127.0.0.1:0", "--linger", option("--linger") || "3600"];
for (const page of sites) args.push("--allow-origin", new URL(page).origin);
const profile = option("--user-data-dir");
if (profile) args.push("--user-data-dir", resolve(profile));

const host = spawn(binary, args, {
  stdio: ["ignore", "inherit", "pipe"],
  env: { ...process.env, IDE_HOST_TOKEN: token },
});
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
      const fragment = new URLSearchParams({ h: listening[1], t: token }).toString();
      console.log(`The host is running. Open one of these on this computer:\n`);
      for (const page of sites) console.log(`  ${page}#${fragment}\n`);
      console.log("Anyone with a link can use this computer as you: don't share it.");
      console.log("Ctrl+C stops the host.");
    } else if (line) console.error(line);
    end = pending.indexOf("\n");
  }
});
host.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => host.kill());

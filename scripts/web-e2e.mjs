// End-to-end check of the host's WebSocket carrier (src-tauri/src/host/ws.rs), the way the web
// build (src/web) uses it: starts the real host program with --listen-ws, then
//   - a page of an origin that isn't allowed gets 403 and no stream,
//   - a request for a name that isn't this computer's is refused, unless the host was told
//     that name is its own (--allow-host: a proxy in front of it),
//   - an allowed one is upgraded, also while a silent socket is open; a wrong code is refused,
//   - the right code gets the handshake's answer, a command's answer, and a file written and
//     read back through raw bodies.
// Plain Node (22 or later, for its WebSocket), no dependencies.
//
//   node scripts/web-e2e.mjs [path to the host program]
//
// Everything it writes goes to a folder beside the repository, removed at the end.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exe = process.platform === "win32" ? "ide-host.exe" : "ide-host";
const binary = resolve(
  process.argv[2] ??
    join(process.env.CARGO_TARGET_DIR ?? join(root, "src-tauri", "target"), "debug", exe),
);
if (!existsSync(binary)) {
  console.error(`web-e2e: no host program at ${binary}`);
  process.exit(2);
}
if (typeof WebSocket === "undefined") {
  console.error("web-e2e: this Node has no WebSocket (22 or later is needed)");
  process.exit(2);
}
const scratch = resolve(root, "..", `.web-e2e-${process.pid}`);
const workspace = join(scratch, "workspace");
const ALLOWED = "https://app.example";
/** The name a proxy in front of the host would be reached by. */
const PROXY_NAME = "dev.example";
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const token = randomBytes(18).toString("base64url");

function encodeFrame(header, body = new Uint8Array(0)) {
  const head = new TextEncoder().encode(JSON.stringify(header));
  const frame = new Uint8Array(8 + head.length + body.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, head.length, true);
  view.setUint32(4, body.length, true);
  frame.set(head, 8);
  frame.set(body, 8 + head.length);
  return frame;
}

/** A client on the wire over a WebSocket: `request()` resolves with `{ header, body }`. */
function client(address, origin) {
  // Node's WebSocket takes headers as an option (a browser sets Origin itself).
  const socket = new WebSocket(`ws://${address}`, origin ? { headers: { Origin: origin } } : []);
  socket.binaryType = "arraybuffer";
  let buffered = new Uint8Array(0);
  const waiting = new Map();
  let nextId = 1;
  const opened = new Promise((done, failed) => {
    socket.addEventListener("open", () => done());
    socket.addEventListener("error", () => failed(new Error("the socket didn't open")));
  });
  const closed = new Promise((done) => socket.addEventListener("close", () => done()));
  socket.addEventListener("message", (event) => {
    const chunk = new Uint8Array(event.data);
    const joined = new Uint8Array(buffered.length + chunk.length);
    joined.set(buffered);
    joined.set(chunk, buffered.length);
    buffered = joined;
    for (;;) {
      if (buffered.length < 8) return;
      const view = new DataView(buffered.buffer, buffered.byteOffset);
      const headLength = view.getUint32(0, true);
      const bodyLength = view.getUint32(4, true);
      if (buffered.length < 8 + headLength + bodyLength) return;
      const header = JSON.parse(new TextDecoder().decode(buffered.subarray(8, 8 + headLength)));
      const body = buffered.slice(8 + headLength, 8 + headLength + bodyLength);
      buffered = buffered.slice(8 + headLength + bodyLength);
      waiting.get(header.id)?.({ header, body });
      waiting.delete(header.id);
    }
  });
  return {
    opened,
    closed,
    request(method, params, raw) {
      const id = nextId++;
      const answer = new Promise((done) => waiting.set(id, done));
      socket.send(
        raw
          ? encodeFrame({ id, method, raw: true, headers: raw.headers }, raw.body)
          : encodeFrame({ id, method, params }),
      );
      return answer;
    },
    close: () => socket.close(),
  };
}

/** The status line a plain upgrade request gets (for an origin a WebSocket can't be given). */
function upgradeStatus(address, origin, named = address) {
  const [host, port] = address.split(":");
  return new Promise((done, failed) => {
    const socket = net.connect(Number(port), host, () => {
      socket.write(
        `GET / HTTP/1.1\r\nHost: ${named}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    let got = "";
    socket.on("data", (chunk) => {
      got += chunk.toString("latin1");
      if (got.includes("\r\n")) {
        socket.destroy();
        done(got.split("\r\n")[0]);
      }
    });
    socket.on("error", failed);
    socket.on("close", () => done(got.split("\r\n")[0] ?? ""));
  });
}

function within(ms, promise, what) {
  return Promise.race([
    promise,
    new Promise((_, failed) => setTimeout(() => failed(new Error(`timed out: ${what}`)), ms)),
  ]);
}

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`);
}

await mkdir(workspace, { recursive: true });
const host = spawn(
  binary,
  [
    "--listen-ws",
    "127.0.0.1:0",
    "--allow-origin",
    ALLOWED,
    "--allow-host",
    PROXY_NAME,
    "--user-data-dir",
    join(scratch, "profile"),
    "--linger",
    "2",
  ],
  { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, IDE_HOST_TOKEN: token } },
);
try {
  const address = await within(
    30_000,
    new Promise((done) => {
      let text = "";
      host.stderr.on("data", (chunk) => {
        text += chunk.toString("utf8");
        const found = /host: listening on ws:\/\/(\S+)\r?\n/.exec(text);
        if (found) done(found[1]);
      });
    }),
    "the host's listening line",
  );

  const refused = await within(10_000, upgradeStatus(address, "https://evil.example"), "refusal");
  check("a page of another origin is refused", refused.startsWith("HTTP/1.1 403"), refused);

  const rebound = await within(
    10_000,
    upgradeStatus(address, ALLOWED, "evil.example"),
    "a name that isn't the host's",
  );
  check("a name pointed at this computer is refused", rebound.startsWith("HTTP/1.1 403"), rebound);
  const proxied = await within(
    10_000,
    upgradeStatus(address, ALLOWED, `${PROXY_NAME}:443`),
    "the proxy's name",
  );
  check("the name the host was given is upgraded", proxied.startsWith("HTTP/1.1 101"), proxied);
  // That connection was dropped without a hello: the host's one place is free a moment later.
  await pause(500);

  // A socket that says nothing (any website can open one) doesn't keep a page out: the
  // host's one place is taken only by a connection that was let in.
  const silent = net.connect(Number(address.split(":")[1]), "127.0.0.1");
  await new Promise((done) => silent.once("connect", done));

  const stranger = client(address, ALLOWED);
  await within(10_000, stranger.opened, "open");
  const wrong = await within(
    10_000,
    stranger.request("$/hello", { protocol: 1, client: "web-e2e", token: "not-it" }),
    "hello with a wrong code",
  );
  check("a wrong code is refused", wrong.header.error !== undefined, JSON.stringify(wrong.header));
  await within(10_000, stranger.closed, "the refused connection closing");

  const page = client(address, ALLOWED);
  await within(10_000, page.opened, "open");
  const hello = await within(
    10_000,
    page.request("$/hello", { protocol: 1, client: "web-e2e", token }),
    "hello",
  );
  check(
    "the handshake answers with the host's commands",
    hello.header.result?.protocol === 1 && hello.header.result.commands?.includes("fs_read"),
    JSON.stringify(hello.header).slice(0, 200),
  );
  const opened = await within(
    20_000,
    page.request("workspace_open", { path: workspace }),
    "workspace_open",
  );
  check("a folder opens", typeof opened.header.result === "string", JSON.stringify(opened.header));
  // 300 KiB: several WebSocket messages each way, a raw body in and out.
  const bytes = randomBytes(300 * 1024);
  const file = join(opened.header.result, "big.bin");
  const wrote = await within(
    20_000,
    page.request("fs_write", undefined, {
      headers: { "x-path": encodeURIComponent(file), "x-source": "save" },
      body: bytes,
    }),
    "fs_write",
  );
  check(
    "a file is written from a raw body",
    wrote.header.error === undefined,
    JSON.stringify(wrote.header),
  );
  const read = await within(20_000, page.request("fs_read", { path: file }), "fs_read");
  check(
    "it reads back the same, as a raw body",
    read.header.raw === true && Buffer.compare(Buffer.from(read.body), bytes) === 0,
    `${read.body.length} bytes`,
  );
  const bye = await within(10_000, page.request("$/shutdown", {}), "shutdown");
  check("the host shuts down when asked", bye.header.error === undefined);
  page.close();
  silent.destroy();
} catch (err) {
  check("the run", false, err instanceof Error ? err.message : String(err));
} finally {
  host.kill();
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);

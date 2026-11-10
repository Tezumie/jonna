// End-to-end test of the remote development server (docs/remote.md): starts the built x86_64
// binary inside WSL with `--stdio`, speaks the framed protocol to it, and checks the methods the
// app relies on against a temporary workspace under WSL's /tmp. Build first:
//   node scripts/build-server.mjs x86_64 && node scripts/test-server.mjs [distro]
// The distro (default Ubuntu) needs git and python3.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DISTRO = process.argv[2] ?? "Ubuntu";
const binary = join(
  root,
  "src-tauri",
  "resources",
  "server",
  "x86_64-unknown-linux-musl",
  "ide-server",
);
const version = /^version\s*=\s*"([^"]+)"/m.exec(
  readFileSync(join(root, "src-tauri", "remote-server", "Cargo.toml"), "utf8"),
)?.[1];

if (!existsSync(binary)) {
  console.error(`No server at ${binary}: run node scripts/build-server.mjs x86_64 first.`);
  process.exit(2);
}

/** `C:\x\y` as WSL sees it (`/mnt/c/x/y`). */
const wslPath = (p) =>
  p.replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`).replaceAll("\\", "/");

/** Runs `script` in the distro's sh; its standard output, trimmed. */
function sh(script) {
  const r = spawnSync("wsl.exe", ["-d", DISTRO, "-e", "sh", "-c", script], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`sh failed (${r.status}): ${script}\n${r.stderr}`);
  return r.stdout.trim();
}

const b64 = (s) => Buffer.from(s).toString("base64");
const unb64 = (s) => Buffer.from(s, "base64").toString("utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The protocol's client side: 4-byte big-endian length, then JSON. */
class Client {
  constructor(child) {
    this.child = child;
    this.buf = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.notes = [];
    this.waiters = [];
    this.stderr = "";
    this.closed = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
    child.stdout.on("data", (d) => this.onData(d));
    child.stderr.on("data", (d) => {
      this.stderr += d;
    });
  }

  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len).toString("utf8");
      this.buf = this.buf.subarray(4 + len);
      this.onMessage(JSON.parse(body));
    }
  }

  onMessage(m) {
    if ("id" in m) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) {
        const e = new Error(`${m.error.code}: ${m.error.message}`);
        e.code = m.error.code;
        p.reject(e);
      } else {
        p.resolve(m.result);
      }
      return;
    }
    this.notes.push(m);
    for (const w of [...this.waiters]) {
      if (w.pred(m)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  }

  send(message) {
    const body = Buffer.from(JSON.stringify(message));
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    this.child.stdin.write(Buffer.concat([head, body]));
  }

  request(method, params = {}, ms = 20000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, ms);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send({ id, method, params });
    });
  }

  notify(method, params) {
    this.send({ notify: method, params });
  }

  /** The first notification (already received or coming) that `pred` accepts. */
  waitFor(pred, what, ms = 10000) {
    const seen = this.notes.find(pred);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const w = {
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`timed out waiting for ${what}`));
      }, ms);
      this.waiters.push(w);
    });
  }

  output(stream, fd) {
    return this.notes
      .filter((n) => n.notify === "stream.data" && n.params.stream === stream)
      .filter((n) => fd === undefined || n.params.fd === fd)
      .map((n) => unb64(n.params.data))
      .join("");
  }

  exitOf(stream, ms = 10000) {
    return this.waitFor(
      (n) => n.notify === "stream.exit" && n.params.stream === stream,
      `stream ${stream} to exit`,
      ms,
    ).then((n) => n.params);
  }

  /** Waits until `stream`'s output passes `test`. */
  async outputUntil(stream, test, what, ms = 10000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const text = this.output(stream);
      if (test(text)) return text;
      await sleep(50);
    }
    throw new Error(`timed out waiting for ${what}; got ${JSON.stringify(this.output(stream))}`);
  }
}

function check(cond, message) {
  if (!cond) throw new Error(message);
}

async function refused(promise, code) {
  try {
    await promise;
  } catch (e) {
    check(e.code === code, `expected ${code}, got ${e.message}`);
    return;
  }
  throw new Error(`expected ${code}, but it succeeded`);
}

// --- Setup ---------------------------------------------------------------------------------

const tmp = sh("mktemp -d /tmp/remote-server-test.XXXXXX");
const ws = `${tmp}/ws`;
sh(
  [
    `mkdir -p ${ws}/src ${ws}/build ${tmp}/outside`,
    `printf 'secret\\n' > ${tmp}/outside/secret.txt`,
    `ln -s ${tmp}/outside ${ws}/escape`,
    `printf 'build/\\n' > ${ws}/.gitignore`,
    `printf 'hello needle\\n' > ${ws}/src/main.ts`,
    `printf 'needle\\n' > ${ws}/build/ignored-needle.js`,
  ].join(" && "),
);

const child = spawn("wsl.exe", ["-d", DISTRO, "-e", wslPath(binary), "--stdio"], {
  stdio: ["pipe", "pipe", "pipe"],
});
const client = new Client(child);
const results = [];
const started = []; // pids to check after the server ends

async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok    ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  FAIL  ${name}: ${e.message}`);
  }
}

console.log(`Testing ${wslPath(binary)} in ${DISTRO}, workspace ${ws}`);

// --- Session -------------------------------------------------------------------------------

await test("hello", async () => {
  const h = await client.request("hello", { version });
  check(h.version === version, `version ${h.version}`);
  check(h.os === "linux" && h.arch === "x86_64", `os/arch ${h.os}/${h.arch}`);
  check(typeof h.home === "string" && h.home.startsWith("/"), `home ${h.home}`);
  check(typeof h.shell === "string" && h.shell.length > 0, `shell ${h.shell}`);
  check(typeof h.user === "string" && Number.isInteger(h.pid), "user/pid");
  await refused(client.request("hello", { version: "0.0.0-other" }), "Invalid");
  await refused(client.request("no.such.method"), "Protocol");
});

// --- Workspace scope -----------------------------------------------------------------------

await test("ws.open and scope refusals", async () => {
  const opened = await client.request("ws.open", { path: ws });
  check(opened === ws, `opened ${opened}`);
  await refused(client.request("fs.read", { path: `${ws}/../outside/secret.txt` }), "OutsideScope");
  await refused(client.request("fs.read", { path: "/etc/passwd" }), "OutsideScope");
  await refused(client.request("fs.read", { path: `${ws}/escape/secret.txt` }), "OutsideScope");
  await refused(client.request("fs.listDir", { path: `${ws}/escape` }), "OutsideScope");
  await refused(
    client.request("fs.write", { path: `${ws}/escape/planted.txt`, data: b64("x") }),
    "OutsideScope",
  );
  await refused(client.request("fs.read", { path: "relative.txt" }), "Invalid");
});

// --- Files ---------------------------------------------------------------------------------

await test("fs.listDir sorts, dims ignored, flags links", async () => {
  const entries = await client.request("fs.listDir", { path: ws });
  const names = entries.map((e) => e.name);
  check(
    JSON.stringify(names) === JSON.stringify(["build", "escape", "src", ".gitignore"]),
    `names ${names}`,
  );
  const by = Object.fromEntries(entries.map((e) => [e.name, e]));
  check(by.build.ignored === true && by.src.ignored === false, "ignored flags");
  check(by.escape.isSymlink === true && by.escape.kind === "dir", "symlink entry");
  check(by.src.path === `${ws}/src`, `path ${by.src.path}`);
});

await test("fs.stat / exists / read / write / canonical", async () => {
  const stat = await client.request("fs.stat", { path: `${ws}/src/main.ts` });
  check(stat.kind === "file" && stat.size === 13 && stat.mtimeMs > 0, JSON.stringify(stat));
  check((await client.request("fs.exists", { path: `${ws}/src/main.ts` })) === true, "exists");
  check((await client.request("fs.exists", { path: `${ws}/nope.txt` })) === false, "missing");
  const read = await client.request("fs.read", { path: `${ws}/src/main.ts` });
  check(unb64(read.data) === "hello needle\n" && read.truncated === false, "read");
  const part = await client.request("fs.read", { path: `${ws}/src/main.ts`, maxBytes: 5 });
  check(unb64(part.data) === "hello" && part.truncated === true, "read maxBytes");
  await refused(client.request("fs.read", { path: `${ws}/src` }), "Invalid");
  await client.request("fs.write", { path: `${ws}/src/new/deep.txt`, data: b64("written") });
  const back = await client.request("fs.read", { path: `${ws}/src/new/deep.txt` });
  check(unb64(back.data) === "written", "write round trip");
  const canonical = await client.request("fs.canonical", { path: `${ws}/src/../src/main.ts` });
  check(canonical === `${ws}/src/main.ts`, `canonical ${canonical}`);
});

await test("fs create / rename / move / copy / delete", async () => {
  const file = await client.request("fs.createFile", { parent: `${ws}/src`, name: "a.txt" });
  check(file === `${ws}/src/a.txt`, `created ${file}`);
  await refused(
    client.request("fs.createFile", { parent: `${ws}/src`, name: "a.txt" }),
    "AlreadyExists",
  );
  await refused(client.request("fs.createFile", { parent: ws, name: "../x" }), "Invalid");
  const dir = await client.request("fs.createDir", { parent: ws, name: "dir1" });
  check(dir === `${ws}/dir1`, `dir ${dir}`);
  const renamed = await client.request("fs.rename", { path: file, newName: "b.txt" });
  check(renamed === `${ws}/src/b.txt`, `renamed ${renamed}`);
  const moved = await client.request("fs.move", { path: renamed, dest: dir });
  check(moved === `${ws}/dir1/b.txt`, `moved ${moved}`);
  const copied = await client.request("fs.copy", { path: moved, dest: dir });
  check(copied === `${ws}/dir1/b copy.txt`, `copied ${copied}`);
  const again = await client.request("fs.copy", { path: moved, dest: dir });
  check(again === `${ws}/dir1/b copy 2.txt`, `copied again ${again}`);
  await client.request("fs.delete", { path: dir });
  check((await client.request("fs.exists", { path: dir })) === false, "deleted");
  await refused(client.request("fs.delete", { path: ws }), "OutsideScope");
  await refused(client.request("fs.rename", { path: ws, newName: "x" }), "OutsideScope");
  // Deleting a link removes the link, never what it points at.
  await client.request("fs.delete", { path: `${ws}/escape` });
  const outside = await client.request("browse.stat", { path: `${tmp}/outside/secret.txt` });
  check(outside?.kind === "file", "the link's target survived");
});

await test("ws.setFolders lets another folder in, and out again", async () => {
  const [ok, missing] = await client.request("ws.setFolders", {
    paths: [`${tmp}/outside`, `${tmp}/missing`],
  });
  check(ok.canonical === `${tmp}/outside` && ok.error === null, JSON.stringify(ok));
  check(missing.canonical === null && typeof missing.error === "string", JSON.stringify(missing));
  const read = await client.request("fs.read", { path: `${tmp}/outside/secret.txt` });
  check(unb64(read.data) === "secret\n", "read in the other folder");
  await refused(client.request("fs.delete", { path: `${tmp}/outside` }), "OutsideScope");
  let item;
  for (let i = 0; i < 50 && !item; i++) {
    const r = await client.request("index.query", { query: "secret", limit: 5 });
    item = r.items.find((it) => it.path === "secret.txt");
    if (!item) await sleep(50);
  }
  check(item?.root === `${tmp}/outside`, `item ${JSON.stringify(item)}`);
  await client.request("ws.setFolders", { paths: [] });
  await refused(client.request("fs.read", { path: `${tmp}/outside/secret.txt` }), "OutsideScope");
});

await test("browse.listDir ~ and browse.stat", async () => {
  const home = await client.request("browse.listDir", { path: "~" });
  check(Array.isArray(home), "home listing");
  const passwd = await client.request("browse.stat", { path: "/etc/passwd" });
  check(passwd?.kind === "file", "browse.stat");
  check((await client.request("browse.stat", { path: "/no/such/file" })) === null, "missing");
  const etc = await client.request("browse.listDir", { path: "/etc" });
  check(
    etc.some((e) => e.name === "passwd"),
    "listing outside the workspace",
  );
});

// --- Index and search ----------------------------------------------------------------------

await test("index.query honors .gitignore; index.changes after a write", async () => {
  check((await client.request("index.listen")) === true, "index.listen watches");
  for (let i = 0; i < 100; i++) {
    const r = await client.request("index.query", { query: "", limit: 10 });
    if (!r.indexing && r.total > 0) break;
    await sleep(50);
  }
  const ignored = await client.request("index.query", { query: "ignored", limit: 10 });
  check(ignored.items.length === 0, `ignored file listed: ${JSON.stringify(ignored.items)}`);
  const main = await client.request("index.query", { query: "main", limit: 10 });
  check(main.items[0]?.path === "src/main.ts", `main → ${JSON.stringify(main.items)}`);
  check(main.items[0].positions.length === 4 && main.items[0].root === undefined, "item shape");
  const all = await client.request("index.query", { query: "", limit: 100 });
  check(!all.items.some((i) => i.path.startsWith("build/")), "empty query skips ignored");
  await client.request("fs.write", { path: `${ws}/src/fresh-needle.ts`, data: b64("x") });
  await client.waitFor(
    (n) => n.notify === "index.changes" && n.params.paths.includes(`${ws}/src/fresh-needle.ts`),
    "index.changes",
  );
  let found = false;
  for (let i = 0; i < 60 && !found; i++) {
    const r = await client.request("index.query", { query: "fresh", limit: 5 });
    found = r.items.some((it) => it.path === "src/fresh-needle.ts");
    if (!found) await sleep(100);
  }
  check(found, "the new file is in the index");
});

await test("search.start events and done", async () => {
  await client.request("search.start", { search: "s1", options: { query: "needle" } });
  const done = await client.waitFor(
    (n) =>
      n.notify === "search.event" && n.params.search === "s1" && n.params.event.kind === "done",
    "search done",
  );
  const files = client.notes
    .filter((n) => n.notify === "search.event" && n.params.search === "s1")
    .map((n) => n.params.event)
    .filter((e) => e.kind === "file");
  const main = files.find((f) => f.rel === "src/main.ts");
  check(main && main.path === `${ws}/src/main.ts`, `files ${JSON.stringify(files)}`);
  check(main.matches[0].line === 1 && main.matches[0].text === "hello needle", "match line");
  check(JSON.stringify(main.matches[0].ranges) === "[[6,12]]", "match range");
  check(!files.some((f) => f.rel.startsWith("build/")), "ignored file searched");
  const d = done.params.event;
  check(
    d.files === files.length && d.cancelled === false && Number.isInteger(d.durationMs),
    "done",
  );
  await refused(
    client.request("search.start", { search: "s2", options: { query: "" } }),
    "Invalid",
  );
  await client.request("search.cancel", { search: "s1" });
});

await test("watch.batch after a change", async () => {
  await client.request("watch.setDirs", { dirs: [`${ws}/src`], watcher: "explorer" });
  await sleep(200);
  await client.request("fs.write", { path: `${ws}/src/watched.txt`, data: b64("w") });
  const batch = await client.waitFor(
    (n) => n.notify === "watch.batch" && n.params.paths.includes(`${ws}/src/watched.txt`),
    "watch.batch",
  );
  check(batch.params.watcher === "explorer", `watcher ${batch.params.watcher}`);
  check(batch.params.dirs.includes(`${ws}/src`), `dirs ${batch.params.dirs}`);
  await client.request("watch.setDirs", { dirs: [], watcher: "explorer" });
});

// --- Processes -----------------------------------------------------------------------------

await test("proc.spawn git --version", async () => {
  const { stream, pid } = await client.request("proc.spawn", {
    cwd: ws,
    program: "git",
    args: ["--version"],
    env: { GIT_TERMINAL_PROMPT: "0" },
  });
  check(Number.isInteger(stream) && Number.isInteger(pid), "stream and pid");
  const exit = await client.exitOf(stream);
  check(exit.code === 0 && exit.signal === null, `exit ${JSON.stringify(exit)}`);
  check(client.output(stream, 1).startsWith("git version"), `output ${client.output(stream)}`);
  await refused(client.request("proc.spawn", { cwd: ws, program: "no-such-program-x" }), "Exec");
  await refused(client.request("proc.spawn", { cwd: "/no/such/dir", program: "git" }), "Exec");
});

await test("proc.spawn env, stderr and exit codes", async () => {
  const { stream } = await client.request("proc.spawn", {
    cwd: ws,
    program: "sh",
    args: ["-c", 'echo "$GREETING"; echo oops >&2; test -z "$HOME" && echo nohome; exit 3'],
    env: { GREETING: "hey", HOME: null },
  });
  const exit = await client.exitOf(stream);
  check(exit.code === 3, `exit ${JSON.stringify(exit)}`);
  check(client.output(stream, 1) === "hey\nnohome\n", `stdout ${client.output(stream, 1)}`);
  check(client.output(stream, 2) === "oops\n", `stderr ${client.output(stream, 2)}`);
});

await test("stdin piping (cat)", async () => {
  const { stream } = await client.request("proc.spawn", { cwd: ws, program: "cat" });
  client.notify("stream.write", { stream, data: b64("ping\n") });
  client.notify("stream.write", { stream, data: b64("pong\n") });
  client.notify("stream.closeStdin", { stream });
  const exit = await client.exitOf(stream);
  check(exit.code === 0, `exit ${JSON.stringify(exit)}`);
  check(client.output(stream) === "ping\npong\n", `output ${client.output(stream)}`);
});

await test("stream.kill ends the process group", async () => {
  const { stream } = await client.request("proc.spawn", {
    cwd: ws,
    program: "sh",
    args: ["-c", "sleep 300 & sleep 300; wait"],
  });
  await sleep(300);
  client.notify("stream.kill", { stream });
  const exit = await client.exitOf(stream);
  check(exit.signal === 15, `exit ${JSON.stringify(exit)}`);
  await sleep(100);
  const left = sh("pgrep -x -f 'sleep 300' || true");
  check(left === "", `the backgrounded child survived: ${left}`);
});

await test("pty login shell: echo, resize, kill", async () => {
  const { stream, pid } = await client.request("proc.spawn", {
    cwd: ws,
    program: "",
    pty: { rows: 24, cols: 80 },
    env: {},
  });
  started.push(pid);
  client.notify("stream.write", { stream, data: b64("echo hi\n") });
  // The output, not the echoed command line: "hi" alone on its line.
  await client.outputUntil(stream, (t) => /(^|[\r\n])hi\r?\n/.test(t), "hi");
  client.notify("stream.resize", { stream, rows: 40, cols: 100 });
  client.notify("stream.write", { stream, data: b64("stty size; tty\n") });
  await client.outputUntil(stream, (t) => /40 100\r?\n/.test(t), "the new size");
  await client.outputUntil(stream, (t) => /\/dev\/pts\/\d+/.test(t), "a terminal");
  client.notify("stream.write", { stream, data: b64("echo $TERM\n") });
  await client.outputUntil(stream, (t) => /xterm-256color\r?\n/.test(t), "TERM");
  client.notify("stream.kill", { stream, signal: "KILL" });
  const exit = await client.exitOf(stream);
  check(exit.signal === 9, `exit ${JSON.stringify(exit)}`);
});

// --- Ports ---------------------------------------------------------------------------------

let server = null;
await test("tcp.connect to an http.server, tcp.listening lists it", async () => {
  let port = 0;
  for (let attempt = 0; attempt < 5 && !server; attempt++) {
    port = 20000 + Math.floor(Math.random() * 20000);
    const spawned = await client.request("proc.spawn", {
      cwd: ws,
      program: "python3",
      args: ["-m", "http.server", String(port), "--bind", "127.0.0.1"],
    });
    for (let i = 0; i < 50; i++) {
      const listening = await client.request("tcp.listening");
      const entry = listening.find((l) => l.port === port);
      if (entry) {
        server = { ...spawned, port, entry };
        break;
      }
      if (
        client.notes.some((n) => n.notify === "stream.exit" && n.params.stream === spawned.stream)
      ) {
        break; // the port was taken: another one
      }
      await sleep(100);
    }
  }
  check(server, "python3 http.server never listened");
  started.push(server.pid);
  check(server.entry.host === "127.0.0.1", `host ${server.entry.host}`);
  check(server.entry.pid === server.pid, `pid ${server.entry.pid} (want ${server.pid})`);
  check(server.entry.process === "python3", `process ${server.entry.process}`);
  const { stream } = await client.request("tcp.connect", { host: "127.0.0.1", port });
  client.notify("stream.write", { stream, data: b64("GET /src/main.ts HTTP/1.0\r\n\r\n") });
  const exit = await client.exitOf(stream);
  const response = client.output(stream);
  check(exit.code === 0, `exit ${JSON.stringify(exit)}`);
  check(response.startsWith("HTTP/1.0 200") && response.includes("hello needle"), response);
  await refused(client.request("tcp.connect", { host: "127.0.0.1", port: 1 }), "Exec");
});

// --- The end -------------------------------------------------------------------------------

await test("closing stdin ends the server and its children", async () => {
  const { pid } = await client.request("proc.spawn", { cwd: ws, program: "sleep", args: ["600"] });
  started.push(pid);
  const pids = started.join(" ");
  check(sh(`for p in ${pids}; do kill -0 $p 2>/dev/null && echo $p; done`).length > 0, "running");
  client.child.stdin.end();
  const code = await Promise.race([client.closed, sleep(10000).then(() => "timeout")]);
  check(code !== "timeout", "the server didn't exit");
  check(code === 0, `exit code ${code}`);
  await sleep(300);
  const alive = sh(`for p in ${pids}; do kill -0 $p 2>/dev/null && echo $p; done; true`);
  check(alive === "", `still running: ${alive}`);
});

await test("shutdown answers, then the server exits", async () => {
  const second = new Client(
    spawn("wsl.exe", ["-d", DISTRO, "-e", wslPath(binary), "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
  check((await second.request("shutdown")) === null, "shutdown's answer");
  const code = await Promise.race([second.closed, sleep(10000).then(() => "timeout")]);
  check(code === 0, `exit code ${code}`);
});

// --- Summary -------------------------------------------------------------------------------

try {
  sh(`rm -rf ${tmp}`);
} catch {
  // Left in WSL's /tmp; cleared on its next restart.
}
if (child.exitCode === null) child.kill();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
for (const f of failed) console.log(`  FAIL  ${f.name}: ${f.error}`);
if (failed.length && client.stderr) console.log(`\nServer's standard error:\n${client.stderr}`);
process.exit(failed.length ? 1 : 0);

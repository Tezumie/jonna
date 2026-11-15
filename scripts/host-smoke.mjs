// Smoke test of the windowless host (src-tauri/src/host): starts the program, talks the wire
// protocol to it and checks the answers. Plain Node, no dependencies.
//
//   node scripts/host-smoke.mjs [path to the host program]
//
// Without a path: `ide-host` in $CARGO_TARGET_DIR/debug, else src-tauri/target/debug. Build it
// with `cargo build --no-default-features --features host --bin ide-host` (in src-tauri/).
// Everything it writes goes to a folder beside the repository, removed at the end: the workspace
// it opens and the profile (`--user-data-dir`), never the user's own settings.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  console.error(`host-smoke: no host program at ${binary}`);
  process.exit(2);
}
const scratch = resolve(root, "..", `.host-smoke-${process.pid}`);
const workspace = join(scratch, "workspace");
const profile = join(scratch, "profile");
const TIMEOUT_MS = 30_000;

function encodeFrame(header, body = Buffer.alloc(0)) {
  const head = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32LE(head.length, 0);
  prefix.writeUInt32LE(body.length, 4);
  return Buffer.concat([prefix, head, body]);
}

/** One connection to a host: requests by id, channel messages by channel id. */
class Client {
  constructor(readable, writable) {
    this.writable = writable;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.nextChannel = 1;
    this.pending = new Map();
    this.channels = new Map();
    this.endedChannels = new Set();
    this.ended = new Promise((done) => {
      readable.on("end", done);
      readable.on("close", done);
      readable.on("error", done);
    });
    this.ended.then(() => {
      for (const { reject } of this.pending.values()) reject(new Error("the host closed the stream"));
      this.pending.clear();
    });
    readable.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
  }

  drain() {
    for (;;) {
      if (this.buffer.length < 8) return;
      const headLength = this.buffer.readUInt32LE(0);
      const bodyLength = this.buffer.readUInt32LE(4);
      if (headLength > 64 * 1024 * 1024) throw new Error("not a frame: something else is on the stream");
      if (this.buffer.length < 8 + headLength + bodyLength) return;
      const header = JSON.parse(this.buffer.subarray(8, 8 + headLength).toString("utf8"));
      const body = Buffer.from(this.buffer.subarray(8 + headLength, 8 + headLength + bodyLength));
      this.buffer = this.buffer.subarray(8 + headLength + bodyLength);
      if (header.channel !== undefined) {
        if (header.end) {
          // The host holds the channel no more.
          this.channels.delete(header.channel);
          this.endedChannels.add(header.channel);
        } else this.channels.get(header.channel)?.(header.raw ? body : header.data, header);
      } else if (header.id !== undefined) {
        const waiting = this.pending.get(header.id);
        this.pending.delete(header.id);
        if (!waiting) throw new Error(`an answer nobody asked for: ${JSON.stringify(header)}`);
        if (header.error !== undefined) {
          const error = new Error(`${header.error.code}: ${header.error.message}`);
          error.detail = header.error;
          waiting.reject(error);
        } else waiting.resolve(header.raw ? body : header.result);
      } else throw new Error(`an unexpected frame: ${JSON.stringify(header)}`);
    }
  }

  send(header, body) {
    this.writable.write(encodeFrame(header, body));
  }

  request(header, body) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no answer to ${header.method} in ${TIMEOUT_MS} ms`)),
        TIMEOUT_MS,
      );
      this.pending.set(id, {
        resolve: (value) => (clearTimeout(timer), resolve(value)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      });
      this.send({ id, ...header }, body);
    });
  }

  call(method, params = {}) {
    return this.request({ method, params });
  }

  callRaw(method, headers, body) {
    return this.request({ method, raw: true, headers }, body);
  }

  /** A channel argument; `onMessage` gets each message. */
  channel(onMessage) {
    const id = this.nextChannel++;
    this.channels.set(id, onMessage);
    return { __channel: id };
  }

  closeChannel(channel) {
    this.send({ method: "$/channelClose", params: { channel: channel.__channel } });
  }
}

let failures = 0;
async function step(name, run) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}\n     ${error?.stack ?? error}`);
  }
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function fails(promise, code, what) {
  try {
    await promise;
  } catch (error) {
    check(error.detail, `${what}: not an error answer (${error.message})`);
    check(error.detail.code === code, `${what}: code ${error.detail.code}, expected ${code}`);
    check(typeof error.detail.message === "string", `${what}: no message`);
    return error.detail;
  }
  throw new Error(`${what}: expected the error ${code}`);
}

const waitFor = async (condition, what, ms = TIMEOUT_MS) => {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

function start(args) {
  const child = spawn(binary, ["--user-data-dir", profile, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((done) => child.on("exit", (code, signal) => done(code ?? signal)));
  return { child, exited, stderr: () => stderr };
}

const exitsWith = async (host, expected, what) => {
  const code = await Promise.race([
    host.exited,
    new Promise((r) => setTimeout(() => r("still running"), TIMEOUT_MS)),
  ]);
  if (code !== expected) host.child.kill();
  check(code === expected, `${what}: exit ${code}, expected ${expected}\n${host.stderr()}`);
};

const hello = (client, extra = {}) =>
  client.call("$/hello", { protocol: 1, client: "smoke", ...extra });

async function overStdio() {
  const host = start([]);
  const client = new Client(host.child.stdout, host.child.stdin);
  let commands = [];

  await step("hello: protocol, version, the commands", async () => {
    const result = await hello(client);
    check(result.protocol === 1, `protocol ${result.protocol}`);
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    check(result.version === pkg.version, `version ${result.version}, package.json ${pkg.version}`);
    check(["windows", "macos", "linux"].includes(result.os), `os ${result.os}`);
    check(result.pid === host.child.pid, `pid ${result.pid}, started ${host.child.pid}`);
    commands = result.commands;
    check(Array.isArray(commands) && commands.length > 200, `commands: ${commands?.length}`);
    for (const name of ["fs_read", "fs_write", "git_status", "pty_spawn", "exec_run", "ai_chat"])
      check(commands.includes(name), `the commands lack ${name}`);
    for (const name of ["screenshot_window", "browser_window_open", "update_check", "fs_start_drag"])
      check(!commands.includes(name), `the commands list the desktop-only ${name}`);
  });

  let folder = workspace;
  await step("a command with arguments and a JSON result", async () => {
    folder = await client.call("workspace_open", { path: workspace });
    check(typeof folder === "string" && folder.length > 0, `workspace_open: ${folder}`);
    const info = await client.call("app_info");
    check(info && typeof info === "object", "app_info: not an object");
    const entries = await client.call("fs_list_dir", { path: folder });
    check(
      entries.some((e) => e.name === "hello.txt"),
      `fs_list_dir: ${JSON.stringify(entries)}`,
    );
    const stat = await client.call("fs_stat", { path: join(folder, "hello.txt") });
    check(stat.size === 11, `fs_stat: ${JSON.stringify(stat)}`);
  });

  await step("a raw result (fs_read)", async () => {
    const bytes = await client.call("fs_read", { path: join(folder, "hello.txt") });
    check(Buffer.isBuffer(bytes), "fs_read: not a raw result");
    check(bytes.toString("utf8") === "hello world", `fs_read: ${bytes}`);
  });

  await step("an error: NotFound, with a message", async () => {
    const error = await fails(
      client.call("fs_read", { path: join(folder, "missing.txt") }),
      "NotFound",
      "fs_read of a missing file",
    );
    check(Object.keys(error).sort().join() === "code,message", `shape: ${JSON.stringify(error)}`);
  });

  await step("arguments that don't fit, and an unknown command", async () => {
    const invalid = await fails(client.call("fs_read", {}), "Invalid", "fs_read without a path");
    check(invalid.message.includes("path"), `the message doesn't name the argument: ${invalid.message}`);
    const unknown = await fails(client.call("no_such_command"), "Invalid", "an unknown command");
    check(unknown.message === "unknown command: no_such_command", unknown.message);
    const desktop = await fails(client.call("screenshot_window", { label: "main" }), "Invalid", "a desktop-only command");
    check(desktop.message === "unknown command: screenshot_window", desktop.message);
  });

  await step("a raw body (fs_write), read back", async () => {
    const path = join(folder, "written é.bin");
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 10, 13]);
    const result = await client.callRaw("fs_write", { "x-path": encodeURIComponent(path) }, bytes);
    check(result === null, `fs_write: ${JSON.stringify(result)}`);
    const back = await client.call("fs_read", { path });
    check(Buffer.compare(back, bytes) === 0, `read back ${[...back]}`);
    check(Buffer.compare(await readFile(path), bytes) === 0, "the file on disk differs");
    const guess = await client.callRaw("encoding_guess", {}, Buffer.from("plain text", "utf8"));
    check(guess === null || typeof guess === "string", `encoding_guess: ${JSON.stringify(guess)}`);
  });

  await step("a channel: a command's output (exec_run)", async () => {
    let output = "";
    const onOutput = client.channel((chunk) => {
      output += chunk;
    });
    const result = await client.call("exec_run", {
      id: "smoke-1",
      command: "echo hello-from-the-host",
      cwd: folder,
      timeoutMs: 20_000,
      onOutput,
    });
    check(result.exitCode === 0, `exec_run: ${JSON.stringify(result)}\n${output}`);
    await waitFor(() => output.includes("hello-from-the-host"), "the command's output", 5000);
    // The command is over and nothing holds its channel: the host says so, once.
    await waitFor(() => client.endedChannels.has(onOutput.__channel), "the channel's end", 5000);
  });

  await step("a channel: a terminal's output, raw (pty_spawn)", async () => {
    let seen = Buffer.alloc(0);
    let exited = false;
    const onOutput = client.channel((message) => {
      if (Buffer.isBuffer(message)) seen = Buffer.concat([seen, message]);
      else if (message && message.exit !== undefined) exited = true;
    });
    const terminal = await client.call("pty_spawn", {
      cols: 80,
      rows: 24,
      cwd: folder,
      shellIntegration: false,
      onOutput,
    });
    check(typeof terminal.id === "number", `pty_spawn: ${JSON.stringify(terminal)}`);
    await client.call("pty_write", { id: terminal.id, data: "echo smoke-pty-marker\r" });
    await waitFor(() => seen.toString("utf8").includes("smoke-pty-marker"), "the terminal's output");
    await client.call("pty_write", { id: terminal.id, data: "exit\r" });
    await waitFor(() => exited, "the terminal's exit message", 10_000).catch(() =>
      client.call("pty_kill", { id: terminal.id }),
    );
  });

  await step("a channel: file changes (watch_start), then $/channelClose", async () => {
    const batches = [];
    const onBatch = client.channel((batch) => batches.push(batch));
    await client.call("watch_start", { onBatch });
    await client.call("watch_set_dirs", { dirs: [folder] });
    await new Promise((r) => setTimeout(r, 300));
    await writeFile(join(folder, "watched.txt"), "one");
    await waitFor(
      () => batches.some((b) => b.paths.some((p) => p.endsWith("watched.txt"))),
      "the change to watched.txt",
    );
    client.closeChannel(onBatch);
    // A request after it: the host has read the close by the time this is answered.
    await client.call("fs_stat", { path: folder });
    await new Promise((r) => setTimeout(r, 400));
    const before = batches.length;
    await writeFile(join(folder, "watched.txt"), "two");
    await writeFile(join(folder, "watched-2.txt"), "three");
    await new Promise((r) => setTimeout(r, 1200));
    check(batches.length === before, `${batches.length - before} batch(es) after the channel was closed`);
    await client.call("watch_stop").catch(() => {});
  });

  await step("many requests in flight", async () => {
    const count = 200;
    const writes = [];
    for (let i = 0; i < count; i++) {
      const path = join(folder, "many", `file-${i}.txt`);
      writes.push(client.callRaw("fs_write", { "x-path": encodeURIComponent(path) }, Buffer.from(`content ${i}`)));
    }
    await Promise.all(writes);
    const reads = [];
    for (let i = 0; i < count; i++)
      reads.push(client.call("fs_read", { path: join(folder, "many", `file-${i}.txt`) }));
    const results = await Promise.all([
      ...reads,
      client.call("git_discover", { path: folder }).catch((e) => e),
      client.call("fs_list_dir", { path: join(folder, "many") }),
    ]);
    for (let i = 0; i < count; i++)
      check(results[i].toString("utf8") === `content ${i}`, `file-${i}: ${results[i]}`);
    check(results[count + 1].length === count, `listed ${results[count + 1].length} of ${count}`);
  });

  await step("$/shutdown: answered, then exit 0", async () => {
    const result = await client.call("$/shutdown");
    check(result === null, `$/shutdown: ${JSON.stringify(result)}`);
    await exitsWith(host, 0, "after $/shutdown");
  });
  if (host.child.exitCode === null) host.child.kill();
}

async function endOfInput() {
  const host = start([]);
  const client = new Client(host.child.stdout, host.child.stdin);
  await step("the end of stdin: exit 0", async () => {
    await hello(client);
    host.child.stdin.end();
    await exitsWith(host, 0, "after the end of stdin");
  });
  if (host.child.exitCode === null) host.child.kill();
}

async function overTcp() {
  const tokenFile = join(scratch, "token.txt");
  await writeFile(tokenFile, "smoke-token-1234\n");
  const host = start(["--listen", "127.0.0.1:0", "--token-file", tokenFile, "--linger", "20"]);
  const connect = (port) =>
    new Promise((done, failed) => {
      const socket = net.connect({ host: "127.0.0.1", port }, () => done(socket));
      socket.on("error", failed);
    });
  await step("TCP: the port on stderr, the token, one client at a time, shutdown", async () => {
    await waitFor(() => /host: listening on 127\.0\.0\.1:\d+/.test(host.stderr()), "the port line on stderr");
    const port = Number(/host: listening on 127\.0\.0\.1:(\d+)/.exec(host.stderr())[1]);

    const wrong = await connect(port);
    await fails(hello(new Client(wrong, wrong), { token: "a guess" }), "Invalid", "a wrong token");
    await new Promise((r) => setTimeout(r, 200));

    const socket = await connect(port);
    const client = new Client(socket, socket);
    const result = await hello(client, { token: "smoke-token-1234" });
    check(result.protocol === 1, "hello over TCP");
    const stat = await client.call("fs_stat", { path: join(workspace, "hello.txt") }).catch((e) => e.detail);
    // No folder is open in this host: the answer is the scope error, over the same stream.
    check(stat && (typeof stat.size === "number" || typeof stat.code === "string"), "a command over TCP");

    // A second client while the first is connected: closed at once, nothing answered.
    const second = await connect(port);
    const secondClient = new Client(second, second);
    let refused = false;
    await Promise.race([
      hello(secondClient, { token: "smoke-token-1234" }).then(
        () => {},
        () => {
          refused = true;
        },
      ),
      secondClient.ended.then(() => {
        refused = true;
      }),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    check(refused, "a second connection was served while one was open");

    check((await client.call("$/shutdown")) === null, "$/shutdown over TCP");
    await exitsWith(host, 0, "after $/shutdown over TCP");
  });
  if (host.child.exitCode === null) host.child.kill();
}

async function information() {
  const run = (args) =>
    new Promise((done) => {
      const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.on("exit", (code) => done({ code, out }));
    });
  await step("--version, --help, an unknown argument", async () => {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const version = await run(["--version"]);
    check(version.code === 0 && version.out.split(/\r?\n/)[0] === pkg.version, `--version: ${JSON.stringify(version)}`);
    const help = await run(["--help"]);
    check(help.code === 0 && help.out.includes("--user-data-dir") && help.out.includes("--listen"), `--help: ${help.out}`);
    const bad = await run(["--no-such-flag"]);
    check(bad.code === 2 && bad.out === "", `an unknown argument: ${JSON.stringify(bad)}`);
  });
}

try {
  await rm(scratch, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "hello.txt"), "hello world");
  await information();
  await overStdio();
  await endOfInput();
  await overTcp();
} catch (error) {
  failures++;
  console.error(`host-smoke: ${error?.stack ?? error}`);
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}
if (failures) {
  console.error(`host-smoke: ${failures} step(s) failed`);
  process.exit(1);
}
console.log("host-smoke: all steps passed");
process.exit(0);

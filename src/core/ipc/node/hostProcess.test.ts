// The Node adapter against real processes and a real socket: a tiny host written in plain
// JavaScript (run by this Node with `-e`) on the other end of real pipes.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { afterEach, test } from "node:test";
import { Channel, call, IpcError, setTransport } from "../invoke";
import { encodeFrame, FrameParser } from "../streamTransport";
import { connectHostSocket, spawnHost } from "./hostProcess";

/** argv[1]: the protocol it claims to speak. */
const HOST_SCRIPT = `
const protocol = Number(process.argv[1] || 1);
function out(header, body) {
  body = body || Buffer.alloc(0);
  const json = Buffer.from(JSON.stringify(header));
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32LE(json.length, 0);
  prefix.writeUInt32LE(body.length, 4);
  process.stdout.write(Buffer.concat([prefix, json, body]));
}
function handle(m, body) {
  if (m.method === "$/hello")
    return out({ id: m.id, result: { protocol, version: "0.0.1", os: "test", pid: process.pid, commands: ["echo"] } });
  if (m.method === "$/shutdown") {
    out({ id: m.id, result: null });
    return process.stdout.write("", () => process.exit(0));
  }
  if (m.method === "echo") return out({ id: m.id, result: m.params });
  if (m.method === "upper")
    return out({ id: m.id, raw: true }, Buffer.from(m.headers["x-prefix"] + body.toString("utf8").toUpperCase()));
  if (m.method === "count") {
    const channel = m.params.onTick.__channel;
    for (let n = 1; n <= 3; n++) out({ channel, data: n });
    out({ channel, raw: true }, Buffer.from("bytes"));
    return out({ id: m.id, result: "counted" });
  }
  if (m.method === "log") {
    process.stderr.write("host: " + m.params.line + "\\n");
    return out({ id: m.id, result: null });
  }
  if (m.method === "die") return process.exit(3);
  if (m.method === "ignore") return;
  if (m.id !== undefined) out({ id: m.id, error: { code: "Invalid", message: "unknown command: " + m.method } });
}
let buffered = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  for (;;) {
    if (buffered.length < 8) return;
    const h = buffered.readUInt32LE(0);
    const b = buffered.readUInt32LE(4);
    if (buffered.length < 8 + h + b) return;
    const header = JSON.parse(buffered.subarray(8, 8 + h).toString("utf8"));
    const body = buffered.subarray(8 + h, 8 + h + b);
    buffered = buffered.subarray(8 + h + b);
    handle(header, body);
  }
});
// End of stdin: shut down without an answer.
process.stdin.on("end", () => process.exit(0));
`;

const node = process.execPath;

/** Waits (2 s at most) for something another pipe brings. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(done(), "timed out waiting");
}
const hostArgs = (protocol = 1) => ["-e", HOST_SCRIPT, String(protocol)];

afterEach(() => setTransport(null));

test("spawns a host over pipes: calls, raw bodies, channels, its log, a clean stop", async () => {
  let log = "";
  const exits: [number | null, string | null][] = [];
  const host = await spawnHost(node, {
    args: hostArgs(),
    client: "test",
    onStderr: (text) => {
      log += text;
    },
    onExit: (code, signal) => exits.push([code, signal]),
  });
  assert.equal(host.info.protocol, 1);
  assert.equal(host.info.pid, host.pid);
  assert.deepEqual(host.info.commands, ["echo"]);
  assert.equal(host.transport.state, "open");
  setTransport(host.transport);

  assert.deepEqual(await call("echo", { path: "a", list: [1, 2] }), { path: "a", list: [1, 2] });
  const upper = await call<ArrayBuffer>("upper", new TextEncoder().encode("héllo"), {
    headers: { "x-prefix": ">" },
  });
  assert.equal(new TextDecoder().decode(upper), ">HÉLLO");
  // Larger than a pipe's buffer, both ways.
  const big = new Uint8Array(3 * 1024 * 1024).fill(97);
  const bigUpper = new Uint8Array(
    await call<ArrayBuffer>("upper", big, { headers: { "x-prefix": "" } }),
  );
  assert.equal(bigUpper.length, big.length);
  assert.ok(bigUpper.every((byte) => byte === 65));

  const ticks: unknown[] = [];
  const channel = new Channel<number | ArrayBuffer>((tick) =>
    ticks.push(tick instanceof ArrayBuffer ? new TextDecoder().decode(tick) : tick),
  );
  assert.equal(await call<string>("count", { onTick: channel }), "counted");
  assert.deepEqual(ticks, [1, 2, 3, "bytes"]);

  await assert.rejects(
    call("app_new_window"),
    (err: unknown) => err instanceof IpcError && err.message === "unknown command: app_new_window",
  );

  await call("log", { line: "hello from the host" });
  await host.stop();
  assert.deepEqual(await host.exited, { code: 0, signal: null });
  assert.deepEqual(exits, [[0, null]]);
  // The log is its own pipe: its last bytes may come after the exit.
  await until(() => log.includes("host: hello from the host"));
  assert.equal(host.transport.state, "closed");
  await assert.rejects(
    call("echo", {}),
    (err: unknown) => err instanceof IpcError && err.code === "Io",
  );
});

test("a host that dies fails the calls in flight and reports its exit", async () => {
  const host = await spawnHost(node, { args: hostArgs() });
  setTransport(host.transport);
  let ended = false;
  const channel = new Channel<number>();
  channel.onclose = () => {
    ended = true;
  };
  const waiting = assert.rejects(
    call("ignore", { onTick: channel }),
    (err: unknown) => err instanceof IpcError && err.code === "Io",
  );
  await assert.rejects(call("die"), (err: unknown) => err instanceof IpcError && err.code === "Io");
  await waiting;
  assert.equal(ended, true);
  assert.deepEqual(await host.exited, { code: 3, signal: null });
  // Stopping what's already gone is fine.
  await host.stop();
});

test("closing the connection ends the host's stdin, and it exits on its own", async () => {
  const host = await spawnHost(node, { args: hostArgs() });
  host.transport.close();
  assert.deepEqual(await host.exited, { code: 0, signal: null });
});

test("stop kills a host that doesn't exit when asked", async () => {
  // Ignores its stdin entirely once it has said hello.
  const stubborn = `
const json = Buffer.from(JSON.stringify({ id: 1, result: { protocol: 1, version: "", os: "", pid: 1, commands: [] } }));
const prefix = Buffer.alloc(8);
prefix.writeUInt32LE(json.length, 0);
process.stdout.write(Buffer.concat([prefix, json]));
setInterval(() => {}, 1000);
`;
  const host = await spawnHost(node, { args: ["-e", stubborn] });
  await host.stop(150);
  const { code, signal } = await host.exited;
  assert.ok(code !== 0 || signal !== null);
});

test("a binary that can't be started, or exits at once, rejects with why", async () => {
  await assert.rejects(
    spawnHost("no-such-host-binary-anywhere", {}),
    /Couldn't start the host \(no-such-host-binary-anywhere\)/,
  );
  let stderr = "";
  await assert.rejects(
    spawnHost(node, {
      args: ["-e", "process.stderr.write('cannot start'); process.exit(2)"],
      onStderr: (text) => {
        stderr += text;
      },
    }),
    /Couldn't start the host/,
  );
  await until(() => stderr === "cannot start");
});

test("a host speaking another protocol is refused and its process ended", async () => {
  let ended = () => {};
  const exited = new Promise<void>((resolve) => {
    ended = resolve;
  });
  await assert.rejects(
    spawnHost(node, { args: hostArgs(2), onExit: () => ended() }),
    /protocol 2, not 1/,
  );
  await exited;
});

test("dials a host on a loopback socket, with its token", async () => {
  // A host for one connection, built from the same frame code.
  const server = createServer((socket) => {
    const parser = new FrameParser((header, body) => {
      const id = header.id as number;
      if (header.method === "$/hello") {
        const params = header.params as { token?: string };
        if (params.token !== "let-me-in") {
          socket.end(encodeFrame({ id, error: { code: "Invalid", message: "bad token" } }));
          return;
        }
        socket.write(
          encodeFrame({
            id,
            result: { protocol: 1, version: "1", os: "test", pid: 1, commands: [] },
          }),
        );
      } else if (header.method === "size") {
        socket.write(encodeFrame({ id, result: body.length }));
      } else {
        socket.write(encodeFrame({ id, result: header.params ?? null }));
      }
    });
    socket.on("data", (chunk) => parser.push(chunk as Uint8Array));
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  try {
    await assert.rejects(connectHostSocket({ port, token: "wrong" }), /bad token/);
    const transport = await connectHostSocket({ port, token: "let-me-in" });
    setTransport(transport);
    assert.deepEqual(await call("echo", { a: 1 }), { a: 1 });
    assert.equal(await call<number>("size", new Uint8Array(200_000)), 200_000);
    transport.close();
    assert.equal(transport.state, "closed");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

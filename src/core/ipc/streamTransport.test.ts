import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Channel, call, IpcError, setTransport } from "./invoke";
import {
  type ByteDuplex,
  connectStream,
  encodeFrame,
  type FrameHeader,
  FrameParser,
  MAX_FRAME_BODY,
  MAX_FRAME_HEADER,
  StreamTransport,
} from "./streamTransport";

// ---- An in-memory duplex and a fake host on its other end --------------------------------------

/** The client's end as the transport sees it, and the far end as a test drives it. */
function memoryDuplex() {
  let toClient: (chunk: Uint8Array) => void = () => {};
  let closeClient: (error?: Error) => void = () => {};
  let fromClient: (chunk: Uint8Array) => void = () => {};
  const state = { clientClosed: false, written: [] as Uint8Array[] };
  const client: ByteDuplex = {
    write: (bytes) => {
      if (state.clientClosed) throw new Error("closed");
      const copy = bytes.slice();
      state.written.push(copy);
      fromClient(copy);
    },
    onData: (listener) => {
      toClient = listener;
    },
    onClose: (listener) => {
      closeClient = listener;
    },
    close: () => {
      state.clientClosed = true;
    },
  };
  return {
    client,
    state,
    /** Bytes from the host to the client, as one chunk. */
    feed: (bytes: Uint8Array) => toClient(bytes),
    /** The stream ends (the host died, the socket dropped). */
    drop: (error?: Error) => closeClient(error),
    onClientBytes: (listener: (chunk: Uint8Array) => void) => {
      fromClient = listener;
    },
  };
}

interface HostRequest {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
  raw?: boolean;
  headers?: Record<string, string>;
  body: Uint8Array;
}

/** What a handler may do: answer later, push channel messages, misbehave. */
interface HostContext {
  send(header: FrameHeader, body?: Uint8Array): void;
}

type HostHandler = (request: HostRequest, host: HostContext) => unknown;

const HELLO = {
  protocol: 1,
  version: "9.9.9",
  os: "linux",
  pid: 4242,
  commands: ["echo", "fs_read"],
};

/**
 * A host written for the tests: speaks the contract on the far end of a memory duplex. A handler
 * returns the result (a Uint8Array answers raw), throws an error object, or returns `LATER` and
 * answers through `host.send`.
 */
const LATER = Symbol("later");
function fakeHost(handlers: Record<string, HostHandler> = {}, hello: unknown = HELLO) {
  const link = memoryDuplex();
  const requests: HostRequest[] = [];
  const host: HostContext = {
    send: (header, body) => link.feed(encodeFrame(header, body)),
  };
  const parser = new FrameParser((header, body) => {
    const request = { ...(header as unknown as Omit<HostRequest, "body">), body };
    requests.push(request);
    if (request.id === undefined) return; // a notification
    if (request.method === "$/hello") {
      if (hello instanceof Error)
        host.send({ id: request.id, error: { code: "Invalid", message: hello.message } });
      else host.send({ id: request.id, result: hello });
      return;
    }
    if (request.method === "$/shutdown") {
      host.send({ id: request.id, result: null });
      link.drop();
      return;
    }
    const handler = handlers[request.method];
    if (!handler) {
      host.send({
        id: request.id,
        error: { code: "Invalid", message: `unknown command: ${request.method}` },
      });
      return;
    }
    let result: unknown;
    try {
      result = handler(request, host);
    } catch (error) {
      host.send({ id: request.id, error });
      return;
    }
    if (result === LATER) return;
    if (result instanceof Uint8Array) host.send({ id: request.id, raw: true }, result);
    else host.send({ id: request.id, result: result ?? null });
  });
  link.onClientBytes((chunk) => parser.push(chunk));
  return { link, requests, host };
}

/** The channel id inside a request's params (`{ __channel: id }`). */
const channelOf = (value: unknown): number => (value as { __channel: number }).__channel;
const text = (bytes: Uint8Array | ArrayBuffer) => new TextDecoder().decode(bytes);
const bytesOf = (value: string) => new TextEncoder().encode(value);
/** Lets promise continuations run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => setTransport(null));

// ---- Frames ----------------------------------------------------------------------------------

test("a frame is two little-endian lengths, the header's JSON, the body", () => {
  const frame = encodeFrame({ id: 7, method: "é" }, new Uint8Array([1, 2, 3]));
  const json = bytesOf('{"id":7,"method":"é"}');
  const view = new DataView(frame.buffer);
  assert.equal(view.getUint32(0, true), json.length);
  assert.equal(view.getUint32(4, true), 3);
  assert.deepEqual([...frame.subarray(8, 8 + json.length)], [...json]);
  assert.deepEqual([...frame.subarray(8 + json.length)], [1, 2, 3]);
  assert.equal(encodeFrame({ a: 1 }).length, 8 + 7);
});

test("the parser finds the same frames however the bytes are cut", () => {
  const frames: [FrameHeader, Uint8Array][] = [
    [{ id: 1, result: { nested: ["é", 1] } }, new Uint8Array(0)],
    [{ id: 2, raw: true }, new Uint8Array([0, 255, 7, 8])],
    [{ channel: 3, data: "x" }, new Uint8Array(0)],
    [{ channel: 3, raw: true }, new Uint8Array(300).fill(9)],
  ];
  const stream = concat(frames.map(([header, body]) => encodeFrame(header, body)));
  const expected = frames.map(([header, body]) => [header, [...body]]);
  const parse = (chunks: Uint8Array[]) => {
    const seen: unknown[] = [];
    const parser = new FrameParser((header, body) => seen.push([header, [...body]]));
    for (const chunk of chunks) parser.push(chunk);
    return seen;
  };
  assert.deepEqual(parse([stream]), expected);
  // One byte at a time.
  assert.deepEqual(parse([...stream].map((byte) => new Uint8Array([byte]))), expected);
  // Cut in two at every offset, and in three around every offset.
  for (let cut = 0; cut <= stream.length; cut++) {
    assert.deepEqual(parse([stream.subarray(0, cut), stream.subarray(cut)]), expected);
    const next = Math.min(stream.length, cut + 5);
    assert.deepEqual(
      parse([stream.subarray(0, cut), stream.subarray(cut, next), stream.subarray(next)]),
      expected,
    );
  }
});

test("the parser refuses frames past the limits and headers that aren't JSON objects", () => {
  const prefix = (headerLength: number, bodyLength: number) => {
    const bytes = new Uint8Array(8);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, headerLength, true);
    view.setUint32(4, bodyLength, true);
    return bytes;
  };
  const parser = () => new FrameParser(() => assert.fail("no frame"));
  assert.throws(() => parser().push(prefix(MAX_FRAME_HEADER + 1, 0)), /isn't allowed/);
  assert.throws(() => parser().push(prefix(10, MAX_FRAME_BODY + 1)), /isn't allowed/);
  assert.throws(() => parser().push(prefix(0, 0)), /isn't allowed/);
  // Text where a frame should start: the lengths it reads are absurd.
  assert.throws(() => parser().push(bytesOf("HTTP/1.1 400 Bad Request\r\n")), /isn't allowed/);
  const garbled = (header: Uint8Array) => concat([prefix(header.length, 0), header]);
  assert.throws(() => parser().push(garbled(bytesOf("{nope"))), /isn't JSON/);
  assert.throws(() => parser().push(garbled(new Uint8Array([0xff, 0xfe, 0x7b]))), /isn't JSON/);
  assert.throws(() => parser().push(garbled(bytesOf("[1,2]"))), /JSON object/);
  assert.throws(() => parser().push(garbled(bytesOf("null"))), /JSON object/);
});

// ---- The handshake -----------------------------------------------------------------------------

test("hello goes first, with the protocol, the client kind and the token", async () => {
  const host = fakeHost();
  const transport = new StreamTransport(host.link.client, { client: "cli", token: "secret" });
  const info = await transport.ready;
  assert.deepEqual(info, HELLO);
  assert.equal(transport.state, "open");
  assert.deepEqual(transport.host, HELLO);
  assert.equal(transport.hasCommand("echo"), true);
  assert.equal(transport.hasCommand("app_new_window"), false);
  assert.deepEqual(host.requests[0], {
    id: 1,
    method: "$/hello",
    params: { protocol: 1, client: "cli", token: "secret" },
    body: new Uint8Array(0),
  });
  // No token unless given (a child's pipes need none).
  const plain = fakeHost();
  await connectStream(plain.link.client);
  assert.deepEqual(plain.requests[0]?.params, { protocol: 1, client: "brain" });
});

test("calls made before the handshake is answered wait for it, in order", async () => {
  const link = memoryDuplex();
  const transport = new StreamTransport(link.client);
  assert.equal(transport.state, "connecting");
  assert.equal(transport.host, null);
  const seen: FrameHeader[] = [];
  const parser = new FrameParser((header) => seen.push(header));
  const first = transport.request("a", { n: 1 });
  const channel = transport.openChannel(() => {});
  const second = transport.request("b", { onEvent: channel.wire() });
  channel.close();
  for (const chunk of link.state.written) parser.push(chunk);
  assert.deepEqual(
    seen.map((h) => h.method),
    ["$/hello"],
  );
  link.feed(encodeFrame({ id: 1, result: HELLO }));
  for (const chunk of link.state.written.slice(1)) parser.push(chunk);
  assert.deepEqual(seen.slice(1), [
    { id: 2, method: "a", params: { n: 1 } },
    { id: 3, method: "b", params: { onEvent: { __channel: 1 } } },
    { method: "$/channelClose", params: { channel: 1 } },
  ]);
  link.feed(encodeFrame({ id: 3, result: "B" }));
  link.feed(encodeFrame({ id: 2, result: "A" }));
  assert.deepEqual(await Promise.all([first, second]), ["A", "B"]);
});

test("a host that speaks another protocol is refused and the connection closed", async () => {
  const link = memoryDuplex();
  const transport = new StreamTransport(link.client);
  const early = assert.rejects(transport.request("echo", {}), { code: "Invalid" });
  const ready = assert.rejects(transport.ready, /protocol 2, not 1/);
  let closedWith: Error | undefined;
  transport.onClose((error) => {
    closedWith = error;
  });
  link.feed(encodeFrame({ id: 1, result: { ...HELLO, protocol: 2 } }));
  await Promise.all([early, ready]);
  assert.equal(transport.state, "closed");
  assert.equal(link.state.clientClosed, true);
  assert.match(closedWith?.message ?? "", /protocol 2/);
  // The early call was never sent: only the hello was written.
  assert.equal(link.state.written.length, 1);
  await assert.rejects(connectStream(fakeHost({}, { ...HELLO, protocol: 2 }).link.client));
  await assert.rejects(connectStream(fakeHost({}, null).link.client), /protocol undefined/);
});

test("a host that refuses the hello (a wrong token) fails the connection with its reason", async () => {
  const host = fakeHost({}, new Error("bad token"));
  const transport = new StreamTransport(host.link.client, { token: "wrong" });
  await assert.rejects(transport.ready, /refused the connection: bad token/);
  assert.equal(transport.state, "closed");
  await assert.rejects(transport.request("echo"), (err: unknown) => {
    assert.deepEqual(err, {
      code: "Invalid",
      message: "The host refused the connection: bad token",
    });
    return true;
  });
});

// ---- Requests ----------------------------------------------------------------------------------

test("through call(): a result, the app's error, an unknown command", async () => {
  const host = fakeHost({
    echo: (request) => request.params,
    fs_stat: () => {
      throw { code: "NotFound", message: "no such file: a.txt" };
    },
    odd: () => {
      throw "just text";
    },
    nothing: () => undefined,
  });
  setTransport(await connectStream(host.link.client));
  assert.deepEqual(await call("echo", { path: "a", deep: { list: [1, null, "é"] } }), {
    path: "a",
    deep: { list: [1, null, "é"] },
  });
  assert.equal(await call("nothing"), null);
  // No args: `params` is left out of the frame.
  assert.equal("params" in (host.requests.at(-1) ?? {}), false);
  await assert.rejects(call("fs_stat", { path: "a.txt" }), (err: unknown) => {
    assert.ok(err instanceof IpcError);
    assert.deepEqual(
      [err.code, err.message, err.command],
      ["NotFound", "no such file: a.txt", "fs_stat"],
    );
    return true;
  });
  await assert.rejects(call("odd"), (err: unknown) => {
    assert.ok(err instanceof IpcError);
    assert.deepEqual([err.code, err.message], ["Unknown", "just text"]);
    return true;
  });
  await assert.rejects(call("app_new_window"), (err: unknown) => {
    assert.ok(err instanceof IpcError);
    assert.deepEqual([err.code, err.message], ["Invalid", "unknown command: app_new_window"]);
    return true;
  });
});

test("a raw body goes out as the frame's body with its headers; a raw result comes back as bytes", async () => {
  const host = fakeHost({
    fs_write: (request) => `${request.headers?.["x-path"]}:${text(request.body)}`,
    encoding_guess: (request) => request.body.length,
    fs_read: () => new Uint8Array([0, 1, 2, 250, 255]),
    empty: () => new Uint8Array(0),
  });
  setTransport(await connectStream(host.link.client));
  assert.equal(
    await call<string>("fs_write", bytesOf("héllo"), {
      headers: { "x-path": "a%2Fb", "x-source": "save" },
    }),
    "a%2Fb:héllo",
  );
  const sent = host.requests.at(-1);
  assert.equal(sent?.raw, true);
  assert.deepEqual(sent?.headers, { "x-path": "a%2Fb", "x-source": "save" });
  assert.equal("params" in (sent ?? {}), false);
  // An ArrayBuffer, a view into a larger buffer, and no headers at all.
  assert.equal(await call<number>("encoding_guess", new Uint8Array([1, 2, 3]).buffer), 3);
  assert.equal(
    await call<number>("encoding_guess", new Uint8Array([9, 1, 2, 9]).subarray(1, 3)),
    2,
  );
  assert.deepEqual([...(host.requests.at(-1)?.body ?? [])], [1, 2]);
  assert.deepEqual(host.requests.at(-1)?.headers, {});

  const read = await call<ArrayBuffer>("fs_read", { path: "a" });
  assert.ok(read instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(read)], [0, 1, 2, 250, 255]);
  const empty = await call<ArrayBuffer>("empty");
  assert.ok(empty instanceof ArrayBuffer);
  assert.equal(empty.byteLength, 0);
});

test("many requests at once, answered out of order, each get their own answer", async () => {
  const waiting: { id: number; n: number }[] = [];
  const host = fakeHost({
    slow: (request) => {
      waiting.push({ id: request.id ?? 0, n: Number(request.params?.n) });
      return LATER;
    },
  });
  const transport = await connectStream(host.link.client);
  setTransport(transport);
  const count = 200;
  const calls = Array.from({ length: count }, (_, n) => call<number>("slow", { n }));
  assert.equal(waiting.length, count);
  assert.equal(new Set(waiting.map((w) => w.id)).size, count);
  // Answer in a scrambled order, every third one with an error.
  const order = [...waiting].sort((a, b) => ((a.n * 7919) % count) - ((b.n * 7919) % count));
  for (const { id, n } of order) {
    if (n % 3 === 0) host.host.send({ id, error: { code: "Exec", message: `failed ${n}` } });
    else host.host.send({ id, result: n * 2 });
  }
  const results = await Promise.allSettled(calls);
  results.forEach((result, n) => {
    if (n % 3 === 0) {
      assert.equal(result.status, "rejected");
      const reason = (result as PromiseRejectedResult).reason as IpcError;
      assert.deepEqual([reason.code, reason.message], ["Exec", `failed ${n}`]);
    } else {
      assert.deepEqual(result, { status: "fulfilled", value: n * 2 });
    }
  });
  // An answer to an id nobody waits for (answered twice) is ignored.
  host.host.send({ id: order[0]?.id ?? 0, result: "again" });
  assert.equal(transport.state, "open");
});

test("bytes and maps inside JSON args are written as the desktop writes them", async () => {
  const host = fakeHost({ echo: (request) => request.params });
  setTransport(await connectStream(host.link.client));
  assert.deepEqual(
    await call("echo", {
      data: new Uint8Array([1, 2, 255]),
      buffer: new Uint8Array([7]).buffer,
      env: new Map([["PORT", "3000"]]),
      missing: undefined,
      none: null,
    }),
    { data: [1, 2, 255], buffer: [7], env: { PORT: "3000" }, none: null },
  );
});

test("args that can't be JSON fail that call, not the connection", async () => {
  const host = fakeHost({ echo: (request) => request.params });
  const transport = await connectStream(host.link.client);
  setTransport(transport);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  await assert.rejects(
    call("echo", cycle),
    (err: unknown) => err instanceof IpcError && err.code === "Invalid",
  );
  assert.deepEqual(await call("echo", { fine: true }), { fine: true });
});

// ---- Channels ----------------------------------------------------------------------------------

test("a channel's messages arrive in order, JSON and raw, also after the call returned", async () => {
  let channelId = 0;
  const host = fakeHost({
    pty_spawn: (request, h) => {
      channelId = channelOf(request.params?.onData);
      h.send({ channel: channelId, raw: true }, bytesOf("first"));
      h.send({ channel: channelId, data: { n: 2 } });
      return 77;
    },
  });
  setTransport(await connectStream(host.link.client));
  const got: unknown[] = [];
  const channel = new Channel<ArrayBuffer | { n?: number; exit?: number }>((message) =>
    got.push(message instanceof ArrayBuffer ? text(message) : message),
  );
  // Nested in the args, as the wrappers pass it.
  assert.equal(await call<number>("pty_spawn", { options: { cols: 80 }, onData: channel }), 77);
  assert.equal(channelId, channel.id);
  assert.deepEqual(host.requests.at(-1)?.params, {
    options: { cols: 80 },
    onData: { __channel: channel.id },
  });
  for (let n = 3; n <= 50; n++) host.host.send({ channel: channelId, data: { n } });
  host.host.send({ channel: channelId, raw: true }, bytesOf("last"));
  host.host.send({ channel: channelId, data: { exit: 0 } });
  assert.deepEqual(got, [
    "first",
    ...Array.from({ length: 49 }, (_, i) => ({ n: i + 2 })),
    "last",
    { exit: 0 },
  ]);
});

test("two channels in one call keep their own messages; ids are never reused", async () => {
  const host = fakeHost({
    both: (request, h) => {
      const a = channelOf(request.params?.a);
      const b = channelOf((request.params?.list as unknown[] | undefined)?.[0]);
      h.send({ channel: b, data: "to b" });
      h.send({ channel: a, data: "to a" });
      return null;
    },
  });
  setTransport(await connectStream(host.link.client));
  const got: string[] = [];
  const a = new Channel<string>((m) => got.push(`a:${m}`));
  const b = new Channel<string>((m) => got.push(`b:${m}`));
  await call("both", { a, list: [b] });
  assert.deepEqual(got, ["b:to b", "a:to a"]);
  a.close();
  const c = new Channel<string>();
  assert.equal(new Set([a.id, b.id, c.id]).size, 3);
  assert.ok(c.id > b.id);
});

test("closing a channel tells the host once and drops what still arrives", async () => {
  const host = fakeHost({ watch_start: () => null });
  setTransport(await connectStream(host.link.client));
  const got: string[] = [];
  const channel = new Channel<string>((m) => got.push(m));
  await call("watch_start", { onBatch: channel });
  host.host.send({ channel: channel.id, data: "one" });
  channel.close();
  channel.close();
  // The host hadn't heard yet: these are dropped here.
  host.host.send({ channel: channel.id, data: "two" });
  host.host.send({ channel: channel.id, raw: true }, bytesOf("three"));
  assert.deepEqual(got, ["one"]);
  const closes = host.requests.filter((r) => r.method === "$/channelClose");
  assert.deepEqual(closes, [
    { method: "$/channelClose", params: { channel: channel.id }, body: new Uint8Array(0) },
  ]);
  // A message for a channel that never existed is ignored too.
  host.host.send({ channel: 9999, data: "?" });
});

test("a channel handler that throws doesn't stall the channel or the stream", async () => {
  const host = fakeHost({ start: () => null, echo: (r) => r.params });
  const errors: unknown[] = [];
  const transport = await connectStream(host.link.client, {
    onHandlerError: (error) => errors.push(error),
  });
  setTransport(transport);
  const got: number[] = [];
  const channel = new Channel<number>((n) => {
    if (n === 2) throw new Error("handler");
    got.push(n);
  });
  await call("start", { onEvent: channel });
  // All in one chunk: the frames behind the throwing one must still be read.
  host.link.feed(concat([1, 2, 3].map((n) => encodeFrame({ channel: channel.id, data: n }))));
  assert.deepEqual(got, [1, 3]);
  assert.equal(errors.length, 1);
  assert.deepEqual(await call("echo", { ok: 1 }), { ok: 1 });
});

// ---- Chunking ----------------------------------------------------------------------------------

test("a whole exchange survives being cut at every byte offset", async () => {
  // What the host says in the exchange below, in order, as one byte stream. The ids are the
  // client's: 1 for hello, then 2, 3, 4; the channel is the client's first.
  const stream = concat([
    encodeFrame({ id: 1, result: HELLO }),
    encodeFrame({ channel: 1, data: "progress 1" }),
    encodeFrame({ id: 3, raw: true }, new Uint8Array([1, 2, 3, 4, 5])),
    encodeFrame({ channel: 1, raw: true }, bytesOf("bytes")),
    encodeFrame({ id: 2, result: { done: true } }),
    encodeFrame({ id: 4, error: { code: "Git", message: "not a repository" } }),
    encodeFrame({ channel: 1, data: "progress 2" }),
  ]);
  const exchange = async (chunks: Uint8Array[]) => {
    const link = memoryDuplex();
    const transport = new StreamTransport(link.client);
    const messages: unknown[] = [];
    const channel = transport.openChannel((m) =>
      messages.push(m instanceof ArrayBuffer ? text(m) : m),
    );
    const calls = Promise.allSettled([
      transport.request("work", { onProgress: channel.wire() }),
      transport.request("fs_read", { path: "a" }),
      transport.request("git_status"),
    ]);
    for (const chunk of chunks) link.feed(chunk);
    const [work, read, git] = await calls;
    assert.equal(transport.state, "open");
    assert.deepEqual(work, { status: "fulfilled", value: { done: true } });
    assert.equal(read.status, "fulfilled");
    assert.deepEqual(
      [...new Uint8Array((read as PromiseFulfilledResult<ArrayBuffer>).value)],
      [1, 2, 3, 4, 5],
    );
    assert.deepEqual(git, {
      status: "rejected",
      reason: { code: "Git", message: "not a repository" },
    });
    assert.deepEqual(messages, ["progress 1", "bytes", "progress 2"]);
  };
  await exchange([stream]);
  await exchange([...stream].map((byte) => new Uint8Array([byte])));
  for (let cut = 1; cut < stream.length; cut++)
    await exchange([stream.slice(0, cut), stream.slice(cut)]);
});

// ---- The connection ending ---------------------------------------------------------------------

test("when the connection is lost, pending calls fail, channels end, later calls fail at once", async () => {
  const host = fakeHost({ hang: () => LATER, start: () => null });
  const transport = await connectStream(host.link.client);
  setTransport(transport);
  let ended = 0;
  const open = new Channel<string>(() => {});
  open.onclose = () => ended++;
  const closedEarlier = new Channel<string>(() => {});
  closedEarlier.onclose = () => assert.fail("a closed channel doesn't hear the end");
  await call("start", { a: open, b: closedEarlier });
  closedEarlier.close();
  const heard: (Error | undefined)[] = [];
  transport.onClose((error) => heard.push(error));
  const stop = transport.onClose(() => assert.fail("stopped listening"));
  stop();

  const pending = [call("hang"), call("hang"), call("hang")];
  host.link.drop(new Error("read ECONNRESET"));

  for (const result of await Promise.allSettled(pending)) {
    assert.equal(result.status, "rejected");
    const reason = (result as PromiseRejectedResult).reason as IpcError;
    assert.ok(reason instanceof IpcError);
    assert.equal(reason.code, "Io");
    assert.match(reason.message, /connection broke: read ECONNRESET/);
  }
  assert.equal(ended, 1);
  assert.equal(transport.state, "closed");
  assert.equal(heard.length, 1);
  assert.match(heard[0]?.message ?? "", /ECONNRESET/);
  assert.equal(host.link.state.clientClosed, true);

  await assert.rejects(
    call("hang"),
    (err: unknown) => err instanceof IpcError && err.code === "Io",
  );
  // A channel made after the end is inert; closing it sends nothing.
  const written = host.link.state.written.length;
  const late = new Channel<string>();
  assert.equal(late.id, 0);
  late.close();
  open.close();
  assert.equal(host.link.state.written.length, written);
  // Listening after the end: told at once.
  let told = false;
  transport.onClose(() => {
    told = true;
  });
  assert.equal(told, true);
  // A second end changes nothing.
  host.link.drop();
  assert.equal(heard.length, 1);
});

test("a clean end of the stream (the host exited) fails pending calls too", async () => {
  const host = fakeHost({ hang: () => LATER });
  const transport = await connectStream(host.link.client);
  const pending = transport.request("hang");
  host.link.drop();
  await assert.rejects(pending, { code: "Io", message: "The host connection closed." });
});

test("the stream ending before the handshake is answered rejects ready and every queued call", async () => {
  const link = memoryDuplex();
  const transport = new StreamTransport(link.client);
  const queued = assert.rejects(transport.request("a"), {
    code: "Io",
    message: "The host connection broke: spawn ENOENT",
  });
  link.drop(new Error("spawn ENOENT"));
  await assert.rejects(transport.ready, /spawn ENOENT/);
  await queued;
  assert.equal(transport.state, "closed");
});

test("a garbled or oversized frame closes the connection and fails what was pending", async () => {
  for (const poison of [
    bytesOf("this is not a frame at all"),
    // A header length past the limit.
    new Uint8Array([0xff, 0xff, 0xff, 0x7f, 0, 0, 0, 0]),
    // A well-formed prefix whose header isn't JSON.
    concat([new Uint8Array([3, 0, 0, 0, 0, 0, 0, 0]), bytesOf("{x}")]),
  ]) {
    const host = fakeHost({ hang: () => LATER });
    const transport = await connectStream(host.link.client);
    const pending = transport.request("hang");
    let closedWith: Error | undefined;
    transport.onClose((error) => {
      closedWith = error;
    });
    host.link.feed(poison);
    await assert.rejects(pending, (err: unknown) => {
      const error = err as { code: string; message: string };
      assert.equal(error.code, "Io");
      assert.match(error.message, /isn't the protocol/);
      return true;
    });
    assert.equal(transport.state, "closed");
    assert.equal(host.link.state.clientClosed, true);
    assert.match(closedWith?.message ?? "", /isn't the protocol/);
    // Whatever arrives afterwards is not read.
    host.link.feed(encodeFrame({ id: 2, result: 1 }));
  }
});

test("a write that throws (the pipe is gone) ends the connection", async () => {
  const host = fakeHost({ echo: (r) => r.params });
  const transport = await connectStream(host.link.client);
  host.link.state.clientClosed = true; // the duplex now throws on write
  await assert.rejects(transport.request("echo", {}), { code: "Io" });
  assert.equal(transport.state, "closed");
});

test("shutdown asks the host, waits for its answer, and closes", async () => {
  const host = fakeHost({ hang: () => LATER });
  const transport = await connectStream(host.link.client);
  const pending = assert.rejects(transport.request("hang"), { code: "Io" });
  await transport.shutdown();
  assert.equal(host.requests.at(-1)?.method, "$/shutdown");
  assert.equal(transport.state, "closed");
  assert.equal(host.link.state.clientClosed, true);
  await pending;
  // Again: nothing to do.
  await transport.shutdown();
});

test("shutdown gives up on a host that never answers", async () => {
  const link = memoryDuplex();
  const transport = new StreamTransport(link.client);
  link.feed(encodeFrame({ id: 1, result: HELLO }));
  await transport.ready;
  const started = Date.now();
  await transport.shutdown(30);
  assert.ok(Date.now() - started < 2000);
  assert.equal(transport.state, "closed");
  assert.equal(link.state.clientClosed, true);
});

test("close() from this side: no error for the listeners, pending calls fail", async () => {
  const host = fakeHost({ hang: () => LATER });
  const transport = await connectStream(host.link.client);
  const heard: (Error | undefined)[] = [];
  transport.onClose((error) => heard.push(error));
  const pending = transport.request("hang");
  transport.close();
  await assert.rejects(pending, { code: "Io", message: "The host connection was closed." });
  assert.deepEqual(heard, [undefined]);
  await settle();
});

function concat(parts: Uint8Array[]): Uint8Array {
  const all = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return all;
}

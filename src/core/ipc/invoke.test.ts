import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  Channel,
  call,
  getTransport,
  hasBackend,
  IpcError,
  isDesktopShell,
  onCall,
  onFailedCall,
  setTransport,
  type Transport,
} from "./invoke";

/** A transport whose answers the test decides; it records what it was asked. */
function fakeTransport(answer: (command: string) => Promise<unknown>) {
  const requests: { command: string; args: unknown; headers?: Record<string, string> }[] = [];
  const channels: { deliver: (message: unknown) => void; end?: () => void; closed: boolean }[] = [];
  const transport: Transport = {
    kind: "fake",
    state: "open",
    request: (command, args) => {
      requests.push({ command, args });
      return answer(command);
    },
    requestRaw: (command, body, headers) => {
      requests.push({ command, args: body, headers });
      return answer(command);
    },
    openChannel: (deliver, end) => {
      const entry = { deliver, end, closed: false };
      channels.push(entry);
      const id = channels.length;
      return {
        id,
        wire: () => ({ __channel: id }),
        close: () => {
          entry.closed = true;
        },
      };
    },
    onClose: () => () => {},
  };
  return { transport, requests, channels };
}

afterEach(() => {
  setTransport(null);
  onCall(null);
  onFailedCall(null);
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  delete (globalThis as Record<string, unknown>).window;
});

test("with nothing connected a call fails as an IpcError and a channel is inert", async () => {
  assert.equal(hasBackend(), false);
  assert.equal(isDesktopShell(), false);
  assert.equal(getTransport().kind, "none");
  const channel = new Channel<string>(() => assert.fail("no message can arrive"));
  assert.equal(channel.id, 0);
  channel.close();
  await assert.rejects(call("fs_read", { path: "a" }), (err: unknown) => {
    assert.ok(err instanceof IpcError);
    assert.equal(err.code, "Unknown");
    assert.equal(err.command, "fs_read");
    return true;
  });
});

test("a call resolves with the transport's result and passes the args on", async () => {
  const fake = fakeTransport(async () => ({ ok: 1 }));
  setTransport(fake.transport);
  assert.equal(hasBackend(), true);
  assert.equal(isDesktopShell(), false);
  assert.deepEqual(await call<{ ok: number }>("git_status", { repo: "r" }), { ok: 1 });
  assert.deepEqual(await call("app_info"), { ok: 1 });
  assert.deepEqual(fake.requests, [
    { command: "git_status", args: { repo: "r" } },
    { command: "app_info", args: undefined },
  ]);
});

test("bytes as args are a raw body with the headers beside it", async () => {
  const fake = fakeTransport(async () => null);
  setTransport(fake.transport);
  const bytes = new Uint8Array([1, 2, 3]);
  const headers = { "x-path": "a%20b", "x-source": "save" };
  await call<void>("fs_write", bytes, { headers });
  await call<void>("encoding_guess", bytes);
  await call<void>("x", bytes.buffer, { headers: [["x-a", "1"]] });
  await call<void>("y", [1, 2], { headers: new Headers({ "x-b": "2" }) });
  assert.equal(fake.requests[0]?.args, bytes);
  // The caller's own record, not a copy: the desktop framework gets exactly what it got before.
  assert.equal(fake.requests[0]?.headers, headers);
  assert.deepEqual(fake.requests[1]?.headers, {});
  assert.equal(fake.requests[2]?.args, bytes.buffer);
  assert.deepEqual(fake.requests[2]?.headers, { "x-a": "1" });
  assert.deepEqual(fake.requests[3]?.args, [1, 2]);
  assert.deepEqual(fake.requests[3]?.headers, { "x-b": "2" });
});

test("a binary result comes back as it is", async () => {
  const buffer = new Uint8Array([9, 8, 7]).buffer;
  setTransport(fakeTransport(async () => buffer).transport);
  assert.equal(await call<ArrayBuffer>("fs_read", { path: "a" }), buffer);
});

test("errors become IpcError: {code, message}, a string, anything else", async () => {
  const errors: unknown[] = [
    { code: "NotFound", message: "no such file" },
    "plain text",
    42,
    new Error("boom"),
    { code: "Io" }, // no message: not the app's error shape
    null,
  ];
  let next = 0;
  setTransport(fakeTransport(() => Promise.reject(errors[next++])).transport);
  const caught: IpcError[] = [];
  for (let i = 0; i < errors.length; i++) {
    try {
      await call("fs_stat", { path: "a" });
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof IpcError);
      assert.equal(err.name, "IpcError");
      assert.equal(err.command, "fs_stat");
      caught.push(err);
    }
  }
  assert.deepEqual(
    caught.map((e) => [e.code, e.message]),
    [
      ["NotFound", "no such file"],
      ["Unknown", "plain text"],
      ["Unknown", "42"],
      ["Unknown", "Error: boom"],
      ["Unknown", "[object Object]"],
      ["Unknown", "null"],
    ],
  );
});

test("a transport that throws instead of rejecting is an IpcError too", async () => {
  const fake = fakeTransport(async () => null);
  fake.transport.request = () => {
    throw new Error("sync");
  };
  setTransport(fake.transport);
  await assert.rejects(
    call("a"),
    (err: unknown) => err instanceof IpcError && err.code === "Unknown",
  );
});

test("onCall hears every call when it settles; onFailedCall hears the failures", async () => {
  let fail = false;
  setTransport(
    fakeTransport(() =>
      fail ? Promise.reject({ code: "Git", message: "no" }) : Promise.resolve(1),
    ).transport,
  );
  const calls: [string, boolean, string | undefined][] = [];
  const failed: IpcError[] = [];
  onCall((command, ms, error) => {
    assert.ok(ms >= 0);
    calls.push([command, typeof ms === "number", error?.code]);
  });
  onFailedCall((error) => failed.push(error));
  await call("git_status");
  fail = true;
  await assert.rejects(call("git_commit"));
  assert.deepEqual(calls, [
    ["git_status", true, undefined],
    ["git_commit", true, "Git"],
  ]);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.command, "git_commit");
  // The same error object reaches both listeners and the caller.
  onCall(null);
  onFailedCall(null);
  await assert.rejects(call("git_commit"));
  assert.equal(calls.length, 2);
  assert.equal(failed.length, 1);
});

test("a listener that throws never changes the call's outcome", async () => {
  let fail = false;
  setTransport(
    fakeTransport(() =>
      fail ? Promise.reject({ code: "Io", message: "disk" }) : Promise.resolve("fine"),
    ).transport,
  );
  onCall(() => {
    throw new Error("listener");
  });
  onFailedCall(() => {
    throw new Error("listener");
  });
  assert.equal(await call<string>("a"), "fine");
  fail = true;
  await assert.rejects(call("b"), (err: unknown) => {
    assert.ok(err instanceof IpcError);
    assert.equal(err.code, "Io");
    assert.equal(err.message, "disk");
    return true;
  });
});

test("a channel: handler in the constructor or assigned, the marker in args, close", () => {
  const fake = fakeTransport(async () => null);
  setTransport(fake.transport);
  const got: string[] = [];
  const first = new Channel<string>((m) => got.push(`first:${m}`));
  const second = new Channel<string>();
  fake.channels[1]?.deliver("dropped: no handler yet");
  second.onmessage = (m) => got.push(`second:${m}`);
  fake.channels[0]?.deliver("a");
  fake.channels[1]?.deliver("b");
  // Replacing the handler: later messages go to the new one.
  first.onmessage = (m) => got.push(`again:${m}`);
  fake.channels[0]?.deliver("c");
  assert.deepEqual(got, ["first:a", "second:b", "again:c"]);
  assert.deepEqual([first.id, second.id], [1, 2]);

  // Inside args at any depth, as JSON puts it there.
  const args = { onEvent: first, nested: { list: [second] }, n: 1 };
  assert.deepEqual(JSON.parse(JSON.stringify(args)), {
    onEvent: { __channel: 1 },
    nested: { list: [{ __channel: 2 }] },
    n: 1,
  });

  let ended = 0;
  second.onclose = () => ended++;
  fake.channels[1]?.end?.();
  assert.equal(ended, 1);

  first.close();
  first.close();
  assert.equal(fake.channels[0]?.closed, true);
  fake.channels[0]?.deliver("after close");
  assert.deepEqual(got, ["first:a", "second:b", "again:c"]);
});

// ---- The desktop framework's transport, against its own internals faked ------------------------

interface FakeFramework {
  invoked: { cmd: string; args: unknown; options: unknown }[];
  callbacks: Map<number, (message: unknown) => void>;
  result: unknown;
  /** Set: every call rejects with it. */
  failure?: unknown;
}

/** Stands in for what the framework injects into the app's window. */
function installFramework(): FakeFramework {
  const fake: FakeFramework = { invoked: [], callbacks: new Map(), result: null };
  let nextCallback = 100;
  const scope = globalThis as Record<string, unknown>;
  scope.window = globalThis;
  scope.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args: unknown, options: unknown) => {
      fake.invoked.push({ cmd, args, options });
      return fake.failure === undefined
        ? Promise.resolve(fake.result)
        : Promise.reject(fake.failure);
    },
    transformCallback: (callback: (message: unknown) => void) => {
      const id = nextCallback++;
      fake.callbacks.set(id, callback);
      return id;
    },
    unregisterCallback: (id: number) => {
      fake.callbacks.delete(id);
    },
  };
  return fake;
}

test("in the app's window calls go to the framework unchanged", async () => {
  const framework = installFramework();
  assert.equal(isDesktopShell(), true);
  assert.equal(hasBackend(), true);
  assert.equal(getTransport().kind, "desktop");

  framework.result = { branch: "main" };
  const args = { repo: "r" };
  assert.deepEqual(await call("git_status", args), { branch: "main" });
  assert.equal(framework.invoked[0]?.cmd, "git_status");
  assert.equal(framework.invoked[0]?.args, args);
  assert.equal(framework.invoked[0]?.options, undefined);

  // A raw body: the same bytes object and the same headers record.
  const bytes = new Uint8Array([1, 2]);
  const headers = { "x-path": "p", "x-source": "save" };
  await call<void>("fs_write", bytes, { headers });
  assert.equal(framework.invoked[1]?.args, bytes);
  assert.deepEqual(framework.invoked[1]?.options, { headers });
  const options = framework.invoked[1]?.options as { headers: unknown } | undefined;
  assert.equal(options?.headers, headers);

  // A binary answer is the framework's ArrayBuffer itself.
  const buffer = new Uint8Array([5]).buffer;
  framework.result = buffer;
  assert.equal(await call<ArrayBuffer>("fs_read", { path: "a" }), buffer);

  // The framework rejects with the command's serialized error.
  framework.failure = { code: "NoWorkspace", message: "open a folder" };
  await assert.rejects(
    call("fs_list", { path: "a" }),
    (err: unknown) => err instanceof IpcError && err.code === "NoWorkspace",
  );
});

test("in the app's window a channel is the framework's: its marker, its ordering, close", () => {
  const framework = installFramework();
  const got: unknown[] = [];
  const channel = new Channel<unknown>((m) => got.push(m));
  const id = channel.id;
  assert.equal(framework.callbacks.size, 1);
  assert.ok(framework.callbacks.has(id));

  // The framework serializes args with JSON.stringify: its marker string, at any depth.
  const args = { onEvent: channel, deep: { also: [channel] } };
  assert.equal(
    JSON.stringify(args),
    `{"onEvent":"__CHANNEL__:${id}","deep":{"also":["__CHANNEL__:${id}"]}}`,
  );

  // Messages arrive indexed and may arrive out of order: the framework's channel reorders.
  const deliver = framework.callbacks.get(id);
  assert.ok(deliver);
  const raw = new Uint8Array([1, 2, 3]).buffer;
  deliver({ index: 1, message: "second" });
  assert.equal(got.length, 0);
  deliver({ index: 0, message: { first: true } });
  deliver({ index: 2, message: raw });
  assert.deepEqual(got, [{ first: true }, "second", raw]);
  assert.equal(got[2], raw);

  // Replacing the handler works as on the framework's own class.
  const later: unknown[] = [];
  channel.onmessage = (m) => later.push(m);
  deliver({ index: 3, message: "x" });
  assert.equal(got.length, 3);
  assert.equal(later.length, 1);
  assert.equal(later[0], "x");

  // Closing only silences it: the framework's callback stays until Rust drops its end.
  channel.close();
  deliver({ index: 4, message: "late" });
  assert.equal(later.length, 1);
  assert.ok(framework.callbacks.has(id));
  deliver({ index: 5, end: true });
  assert.equal(framework.callbacks.has(id), false);
});

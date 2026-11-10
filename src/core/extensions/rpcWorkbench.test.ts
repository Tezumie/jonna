// The worker side of D233's providers: terminals and pseudoterminals, task providers (custom
// executions), source control snapshots, inline debug adapters, authentication, secrets and file
// system providers, all through createWorkerApi with a fake host.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerApi, type FromWorker, type RequestMessage, type ToWorker } from "./rpc";
import { fromBase64, toBase64 } from "./rpcAuthFs";

function fakeHost(
  answer: (method: string, params: Record<string, unknown>) => unknown = () => null,
) {
  const sent: FromWorker[] = [];
  let deliver: (m: ToWorker) => void = () => {};
  let callId = 1000;
  const { api } = createWorkerApi(
    {
      post: (m) => {
        sent.push(m);
        if (m.t === "req")
          queueMicrotask(() =>
            deliver({
              t: "res",
              id: m.id,
              ok: true,
              value: answer(m.method, m.params as Record<string, unknown>),
            }),
          );
      },
      onMessage: (h) => (deliver = h),
    },
    { id: "acme.wb", version: "1.0.0" },
  );
  const requests = (method?: string) =>
    sent
      .filter((m): m is RequestMessage => m.t === "req")
      .filter((m) => !method || m.method === method);
  const tick = () => new Promise((r) => setTimeout(r, 0));
  /** Calls the worker's "provider" callback `target`; resolves with its answer. */
  const call = async (target: string, args: unknown) => {
    const id = ++callId;
    deliver({ t: "call", id, kind: "provider", target, args });
    for (let i = 0; i < 20; i++) {
      await tick();
      const res = sent.find((m) => m.t === "res" && m.id === id);
      if (res && res.t === "res") {
        if (!res.ok) throw new Error(res.error);
        return res.value;
      }
    }
    throw new Error(`no answer to ${target}`);
  };
  return { api, requests, tick, call };
}

test("terminals: a pseudoterminal opens, writes (early text kept), gets input and closes", async () => {
  const h = fakeHost();
  const seen: string[] = [];
  const terminal = await h.api.terminals.create({
    name: "Echo",
    pty: {
      open: (dims, io) => {
        seen.push(`open ${dims.columns}x${dims.rows}`);
        io.write("hello\r\n");
      },
      input: (data) => seen.push(`in ${data}`),
      resize: (dims) => seen.push(`size ${dims.columns}`),
      close: () => seen.push("close"),
    },
  });
  const create = h.requests("terminals.create")[0]?.params as Record<string, unknown>;
  assert.equal(create.pseudo, true);
  assert.equal(create.name, "Echo");
  terminal.write("early");
  await h.call("pty.open", { ptyId: "x1", terminal: terminal.id, columns: 100, rows: 30 });
  await h.call("pty.input", { ptyId: "x1", data: "a" });
  await h.call("pty.resize", { ptyId: "x1", columns: 90, rows: 20 });
  const writes = h.requests("terminals.write").map((r) => (r.params as { text: string }).text);
  assert.deepEqual(writes, ["hello\r\n", "early"]);
  // A second tab can't show the same pseudoterminal.
  await assert.rejects(h.call("pty.open", { ptyId: "x2", terminal: terminal.id }));
  await h.call("pty.close", { ptyId: "x1" });
  assert.deepEqual(seen, ["open 100x30", "in a", "size 90", "close"]);
  // Closed: nothing more is written.
  terminal.write("late");
  await h.tick();
  assert.equal(h.requests("terminals.write").length, 2);
});

test("terminals: a shell terminal's sendText adds Enter unless asked not to", async () => {
  const h = fakeHost();
  const t = await h.api.terminals.create({ shellPath: "bash", shellArgs: ["-l"], cwd: "src" });
  const create = h.requests("terminals.create")[0]?.params as Record<string, unknown>;
  assert.equal(create.pseudo, false);
  assert.equal(create.shellPath, "bash");
  await t.sendText("ls");
  await t.sendText("x", false);
  const sends = h.requests("terminals.sendText").map((r) => r.params);
  assert.deepEqual(sends, [
    { id: t.id, text: "ls", addNewLine: true },
    { id: t.id, text: "x", addNewLine: false },
  ]);
});

test("tasks: provided tasks cross with their type; a custom one runs its pseudoterminal", async () => {
  const h = fakeHost();
  let started: Record<string, unknown> | null = null;
  h.api.tasks.registerTaskProvider("demo", {
    provideTasks: () => [
      { name: "lint", execution: { kind: "shell", commandLine: "eslint ." } },
      {
        name: "custom",
        definition: { flavor: "x" },
        execution: {
          kind: "custom",
          start: (definition) => {
            started = definition;
            return { open: (_d, io) => io.exit(3) };
          },
        },
      },
    ],
  });
  await h.tick();
  const reg = h.requests("tasks.register")[0]?.params as { id: string; type: string };
  assert.equal(reg.type, "demo");
  const tasks = (await h.call(reg.id, {})) as {
    name: string;
    definition: Record<string, unknown>;
    execution: { kind: string; key?: string };
  }[];
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks[0]?.definition, { type: "demo" });
  const key = tasks[1]?.execution.key;
  assert.equal(tasks[1]?.execution.kind, "custom");
  assert.ok(key);
  await h.call("pty.open", { ptyId: "x9", task: key, columns: 80, rows: 24 });
  assert.deepEqual(started, { flavor: "x", type: "demo" });
  const exit = h.requests("terminals.exit")[0]?.params;
  assert.deepEqual(exit, { ptyId: "x9", code: 3 });
});

test("scm: one update per tick with groups, input, count and accept command", async () => {
  const h = fakeHost();
  const sc = h.api.scm.createSourceControl({ id: "notes", label: "Notes", rootPath: "." });
  await h.tick();
  const first = h.requests("scm.update").length;
  const group = sc.createResourceGroup("changes", "Changes");
  group.resourceStates = [{ path: "a.txt", decorations: { letter: "M", tone: "modified" } }];
  sc.inputBox.placeholder = "Message";
  sc.count = 7;
  sc.acceptInputCommand = { command: "demo.commit", title: "Commit" };
  await h.tick();
  const updates = h.requests("scm.update");
  assert.equal(updates.length, first + 1);
  const last = updates.at(-1)?.params as {
    count: number;
    accept: { command: string };
    groups: { id: string; resources: { path: string }[] }[];
    input: { placeholder: string };
  };
  assert.equal(last.count, 7);
  assert.equal(last.accept.command, "demo.commit");
  assert.equal(last.groups[0]?.resources[0]?.path, "a.txt");
  assert.equal(last.input.placeholder, "Message");
  // The user's typing reaches inputBox.value and its listeners.
  const typed: string[] = [];
  sc.inputBox.onDidChange((v) => typed.push(v));
  const firstUpdate = updates[0];
  assert.ok(firstUpdate);
  const id = (firstUpdate.params as { id: string }).id;
  await h.call(`${id}.input`, { value: "fix" });
  assert.equal(sc.inputBox.value, "fix");
  assert.deepEqual(typed, ["fix"]);
  sc.quickDiffProvider = { provideOriginal: (path) => `original of ${path}` };
  assert.equal(await h.call(`${id}.original`, { path: "a.txt" }), "original of a.txt");
  sc.dispose();
  assert.equal(h.requests("scm.dispose").length, 1);
});

test("debug: an inline adapter gets messages and sends its own, until disposed", async () => {
  const h = fakeHost();
  const got: unknown[] = [];
  h.api.debug.registerDebugAdapterDescriptorFactory("demo", {
    createDebugAdapterDescriptor: () => ({
      kind: "inline",
      start: (send) => {
        // Sending at once (an "initialized" event) reaches the IDE.
        send({ type: "event", event: "output" });
        return {
          handleMessage: (m) => {
            got.push(m);
            send({ type: "response", request_seq: m.seq, success: true });
          },
        };
      },
    }),
  });
  await h.tick();
  const reg = h.requests("debug.register")[0]?.params as { id: string; type: string };
  assert.equal(reg.type, "demo");
  assert.deepEqual(await h.call(reg.id, { sessionId: "d1", session: { type: "demo" } }), {
    kind: "inline",
  });
  await h.call("debug.message", { sessionId: "d1", message: { seq: 1, command: "initialize" } });
  assert.deepEqual(got, [{ seq: 1, command: "initialize" }]);
  assert.equal(h.requests("debug.send").length, 2);
  await h.call("debug.dispose", { sessionId: "d1" });
  await h.call("debug.message", { sessionId: "d1", message: { seq: 2 } });
  assert.equal(got.length, 1);
});

test("debug: an executable descriptor crosses as data", async () => {
  const h = fakeHost();
  h.api.debug.registerDebugAdapterDescriptorFactory("demo", {
    createDebugAdapterDescriptor: (session) => ({
      kind: "executable",
      command: "node",
      args: ["adapter.js", session.name],
    }),
  });
  await h.tick();
  const reg = h.requests("debug.register")[0]?.params as { id: string };
  assert.deepEqual(await h.call(reg.id, { sessionId: "d1", session: { name: "Run" } }), {
    kind: "executable",
    command: "node",
    args: ["adapter.js", "Run"],
  });
});

test("authentication: provider callbacks, getSession's options and change events", async () => {
  const h = fakeHost((method) =>
    method === "auth.getSession"
      ? { id: "s1", accessToken: "t", account: { id: "a", label: "Ann" }, scopes: [] }
      : null,
  );
  const handle = h.api.authentication.registerAuthenticationProvider("demo-auth", "Demo", {
    createSession: (scopes) => ({
      id: "s1",
      accessToken: "token",
      account: { id: "a", label: "Ann" },
      scopes,
    }),
  });
  await h.tick();
  const reg = h.requests("auth.register")[0]?.params as Record<string, unknown>;
  assert.equal(reg.storesSessions, true, "no getSessions: the IDE keeps the sessions");
  const created = (await h.call("auth.demo-auth.createSession", { scopes: ["repo"] })) as {
    scopes: string[];
  };
  assert.deepEqual(created.scopes, ["repo"]);
  const session = await h.api.authentication.getSession("other", ["x"], { createIfNone: true });
  assert.equal(session?.account.label, "Ann");
  assert.deepEqual(h.requests("auth.getSession")[0]?.params, {
    providerId: "other",
    scopes: ["x"],
    createIfNone: true,
    forceNewSession: false,
    silent: false,
  });
  const events: string[] = [];
  h.api.authentication.onDidChangeSessions((e) => events.push(e.providerId));
  await h.call("auth.didChange", { providerId: "demo-auth" });
  assert.deepEqual(events, ["demo-auth"]);
  assert.equal(h.requests("auth.listen").length, 1);
  handle.fireDidChangeSessions();
  assert.equal(h.requests("auth.changed").length, 1);
});

test("secrets: get answers undefined for none", async () => {
  const h = fakeHost((method) => (method === "secrets.get" ? null : undefined));
  assert.equal(await h.api.secrets.get("token"), undefined);
  await h.api.secrets.store("token", "abc");
  assert.deepEqual(h.requests("secrets.store")[0]?.params, { key: "token", value: "abc" });
});

test("file systems: reads cross as base64, directories as pairs, writes decoded", async () => {
  const h = fakeHost();
  const files = new Map<string, Uint8Array>();
  const changes: string[] = [];
  const fs = h.api.workspace.registerFileSystemProvider(
    "MemFS",
    {
      stat: (path) => ({ type: path.endsWith("/") ? "directory" : "file", size: 3 }),
      readDirectory: () => [
        ["a.txt", "file"],
        ["dir", "directory"],
      ],
      readFile: () => "héllo",
      writeFile: (path, content) => {
        files.set(path, content);
      },
      watch: (path) => {
        changes.push(path);
        return { dispose: () => {} };
      },
    },
    { label: "Memory" },
  );
  await h.tick();
  await h.tick();
  const reg = h.requests("fs.registerProvider")[0]?.params as Record<string, unknown>;
  assert.equal(reg.scheme, "memfs");
  assert.equal(reg.readonly, false);
  assert.deepEqual(changes, ["memfs:/"]);
  const id = reg.id as string;
  const data = (await h.call(`${id}.readFile`, { path: "memfs:/a.txt" })) as string;
  assert.equal(new TextDecoder().decode(fromBase64(data)), "héllo");
  assert.deepEqual(await h.call(`${id}.readDirectory`, { path: "memfs:/" }), [
    ["a.txt", "file"],
    ["dir", "directory"],
  ]);
  await h.call(`${id}.writeFile`, {
    path: "memfs:/b.txt",
    data: toBase64(new Uint8Array([1, 2, 250])),
  });
  assert.deepEqual([...(files.get("memfs:/b.txt") ?? [])], [1, 2, 250]);
  await assert.rejects(h.call(`${id}.delete`, { path: "memfs:/b.txt" }), /can't delete/);
  fs.fireDidChange([{ path: "memfs:/a.txt", kind: "changed" }]);
  assert.equal(h.requests("fs.changed").length, 1);
});

test("base64 round-trips every length", () => {
  for (let n = 0; n < 10; n++) {
    const bytes = new Uint8Array(n).map((_, i) => (i * 97 + 13) % 256);
    assert.deepEqual([...fromBase64(toBase64(bytes))], [...bytes]);
    assert.equal(toBase64(bytes), Buffer.from(bytes).toString("base64"));
  }
});

test("debug: a configuration provider provides starters and resolves; either part optional", async () => {
  const h = fakeHost();
  h.api.debug.registerDebugConfigurationProvider(
    "memo-dbg",
    {
      provideDebugConfigurations: (folder) => [
        { name: `Run in ${folder ?? "?"}`, type: "memo-dbg", request: "launch" },
      ],
    },
    "dynamic",
  );
  h.api.debug.registerDebugConfigurationProvider("memo-dbg", {
    resolveDebugConfiguration: (c) => ({ ...c, filled: true }),
  });
  await h.tick();
  const [first, second] = h
    .requests("debug.registerConfigurationProvider")
    .map((r) => r.params as Record<string, unknown>);
  assert.equal(first?.provides, true);
  assert.equal(first?.resolves, false);
  assert.equal(first?.trigger, "dynamic");
  assert.equal(second?.provides, false);
  assert.equal(second?.trigger, "initial");
  assert.deepEqual(await h.call(String(first?.id), { op: "provide", folder: "/ws" }), [
    { name: "Run in /ws", type: "memo-dbg", request: "launch" },
  ]);
  // Without a resolve step the configuration starts as written.
  assert.deepEqual(await h.call(String(first?.id), { configuration: { a: 1 } }), { a: 1 });
  assert.deepEqual(await h.call(String(second?.id), { op: "provide" }), []);
  assert.deepEqual(await h.call(String(second?.id), { configuration: { a: 1 } }), {
    a: 1,
    filled: true,
  });
});

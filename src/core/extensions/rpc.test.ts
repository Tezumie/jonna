// The D202 parts of the worker API: processes, state paths, context keys, trust, dialogs, the
// command handler's context, and the manifest fields they use.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerApi, type FromWorker, type RequestMessage, type ToWorker } from "./rpc";
import { ownsStatePath, parseManifest } from "./thirdParty";

/** A fake host: records requests, answers each with `answer(method, params)`. */
function fakeHost(
  answer: (method: string, params: Record<string, unknown>) => unknown = () => null,
) {
  const sent: FromWorker[] = [];
  let deliver: (m: ToWorker) => void = () => {};
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
    { id: "acme.kernel", version: "1.0.0", path: "/ext/acme.kernel", platform: "windows" },
  );
  const requests = () => sent.filter((m): m is RequestMessage => m.t === "req");
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { api, sent, requests, deliver: (m: ToWorker) => deliver(m), tick };
}

test("worker api: extension path and platform from init", () => {
  const { api } = fakeHost();
  assert.equal(api.extension.path, "/ext/acme.kernel");
  assert.equal(api.env.platform, "windows");
});

test("process.spawn: request, buffered early output, ndjson parsing, exit, send and kill", async () => {
  const h = fakeHost();
  const spawning = h.api.process.spawn({ command: "python", args: ["k.py"], framing: "ndjson" });
  const req = h.requests().find((r) => r.method === "process.spawn");
  assert.ok(req);
  const params = req.params as { id: string; command: string; framing: string };
  assert.equal(params.command, "python");
  assert.equal(params.framing, "ndjson");
  // Output before the spawn's answer arrives (and before any listener) is kept.
  h.deliver({
    t: "call",
    id: 90,
    kind: "process",
    target: params.id,
    args: {
      events: [
        { kind: "message", body: '{"ready":true}' },
        { kind: "message", body: "not json" },
        { kind: "stderr", line: "warming up" },
      ],
    },
  });
  const proc = await spawning;
  assert.equal(proc.id, params.id);
  const messages: unknown[] = [];
  const stderr: string[] = [];
  const exits: [number | null, string | undefined][] = [];
  proc.onMessage((m) => messages.push(m));
  proc.onStderr((l) => stderr.push(l));
  proc.onExit((code, signal) => exits.push([code, signal]));
  await h.tick();
  assert.deepEqual(messages, [{ ready: true }, "not json"]);
  assert.deepEqual(stderr, ["warming up"]);
  await proc.send({ execute: "1+1" });
  const sendReq = h.requests().find((r) => r.method === "process.send");
  assert.deepEqual(sendReq?.params, { id: params.id, data: { execute: "1+1" } });
  await proc.kill();
  assert.ok(h.requests().some((r) => r.method === "process.kill"));
  h.deliver({
    t: "call",
    id: 91,
    kind: "process",
    target: params.id,
    args: { events: [{ kind: "exit", code: null, signal: "SIGKILL" }] },
  });
  await h.tick();
  assert.deepEqual(exits, [[null, "SIGKILL"]]);
  // A late exit listener still hears it; sending after exit fails.
  const late: (number | null)[] = [];
  proc.onExit((code) => late.push(code));
  await h.tick();
  assert.deepEqual(late, [null]);
  await assert.rejects(proc.send("x"), /exited/);
});

test("process.spawn: lines framing keeps text; a refused spawn rejects", async () => {
  const sent: FromWorker[] = [];
  let deliver: (m: ToWorker) => void = () => {};
  const { api } = createWorkerApi(
    { post: (m) => sent.push(m), onMessage: (fn) => (deliver = fn) },
    { id: "a.b", version: "1" },
  );
  const p = api.process.spawn({ command: "node" });
  const req = sent.find((m): m is RequestMessage => m.t === "req");
  assert.equal((req?.params as { framing: string } | undefined)?.framing, "lines");
  deliver({ t: "res", id: req?.id ?? 0, ok: false, error: "needs shell" });
  await assert.rejects(p, /needs shell/);
  assert.equal(api.env.platform, "linux");
  assert.equal(api.extension.path, "");
});

test("state.register: the host calls the getter with params; dispose unregisters", async () => {
  const h = fakeHost();
  const off = h.api.state.register("ide://ext/acme.kernel/sessions", ({ params }) => ({
    sessions: 2,
    params,
  }));
  assert.ok(h.requests().some((r) => r.method === "state.register"));
  h.deliver({
    t: "call",
    id: 5,
    kind: "state",
    target: "ide://ext/acme.kernel/sessions",
    args: { params: { brief: "1" } },
  });
  await h.tick();
  const reply = h.sent.find((m) => m.t === "res" && m.id === 5);
  assert.deepEqual(reply, {
    t: "res",
    id: 5,
    ok: true,
    value: { sessions: 2, params: { brief: "1" } },
  });
  off.dispose();
  assert.ok(h.requests().some((r) => r.method === "state.unregister"));
  h.deliver({ t: "call", id: 6, kind: "state", target: "ide://ext/acme.kernel/sessions" });
  await h.tick();
  const gone = h.sent.find((m) => m.t === "res" && m.id === 6);
  assert.equal(gone?.t === "res" && gone.ok, false);
});

test("commands get { caller }; context, trust, dialog and quick pick requests", async () => {
  const h = fakeHost((method) => {
    if (method === "workspace.isTrusted") return true;
    if (method === "workspace.requireTrust") return false;
    if (method === "ui.showDialog") return null;
    if (method === "ui.showQuickPick") return 1;
    return null;
  });
  h.api.commands.register("kernel.run", (_input, context) => context.caller);
  h.deliver({
    t: "call",
    id: 8,
    kind: "command",
    target: "kernel.run",
    args: {},
    context: { caller: "agent" },
  });
  h.deliver({ t: "call", id: 9, kind: "command", target: "kernel.run", args: {} });
  await h.tick();
  const value = (id: number) => {
    const m = h.sent.find((x) => x.t === "res" && x.id === id);
    return m?.t === "res" ? m.value : undefined;
  };
  assert.equal(value(8), "agent");
  assert.equal(value(9), "other");
  await h.api.context.set("acme.kernel.busy", true);
  const ctx = h.requests().find((r) => r.method === "context.set");
  assert.deepEqual(ctx?.params, { key: "acme.kernel.busy", value: true });
  assert.equal(await h.api.workspace.isTrusted(), true);
  assert.equal(await h.api.workspace.requireTrust("start a kernel"), false);
  assert.equal(
    await h.api.ui.showDialog({ title: "Restart?", message: "m", actions: [{ label: "Restart" }] }),
    undefined,
  );
  const picked = await h.api.ui.showQuickPick([
    { label: "a" },
    { label: "b", icon: "zap", detail: "more", extra: 1 },
  ]);
  assert.equal(picked?.extra, 1);
  const pick = h.requests().find((r) => r.method === "ui.showQuickPick");
  assert.deepEqual((pick?.params as { items: unknown[] } | undefined)?.items[1], {
    label: "b",
    description: undefined,
    icon: "zap",
    detail: "more",
  });
  // Trust changes come through the events channel.
  const seen: boolean[] = [];
  h.api.workspace.onDidChangeTrust((t) => seen.push(t));
  const sub = h.requests().find((r) => r.method === "events.subscribe");
  assert.equal((sub?.params as { type: string } | undefined)?.type, "workspace.didChangeTrust");
  h.deliver({
    t: "call",
    id: 12,
    kind: "event",
    target: (sub?.params as { sub: string } | undefined)?.sub ?? "",
    args: { trusted: true },
  });
  await h.tick();
  assert.deepEqual(seen, [true]);
});

test("parseManifest: readsSettings, contributes.state and command input schemas (D202)", () => {
  const m = parseManifest(
    {
      id: "acme.kernel",
      version: "1.0.0",
      readsSettings: ["debug.pythonPath", "markdown.*"],
      contributes: {
        commands: [
          {
            id: "kernel.run",
            title: "Run",
            input: { type: "object", properties: { code: { type: "string" } } },
          },
        ],
        state: [
          "ide://ext/acme.kernel/sessions",
          { path: "ide://ext/acme.kernel", description: "All" },
        ],
      },
    },
    "extension.json",
  );
  assert.deepEqual(m.readsSettings, ["debug.pythonPath", "markdown.*"]);
  assert.equal(m.contributes.state.length, 2);
  assert.equal(m.contributes.state[1]?.description, "All");
  assert.equal(m.contributes.commands[0]?.input?.type, "object");
  assert.throws(
    () =>
      parseManifest(
        { id: "acme.kernel", version: "1", readsSettings: ["agent.model"] },
        "extension.json",
      ),
    /readsSettings/,
  );
  // Only an extension that comes with the IDE may name paths outside ide://ext/<id>.
  assert.throws(
    () =>
      parseManifest(
        { id: "acme.kernel", version: "1", contributes: { state: ["ide://notebook"] } },
        "extension.json",
      ),
    /ide:\/\/ext\/acme\.kernel/,
  );
  const bundled = parseManifest(
    { id: "bundled.notebooks", version: "1", contributes: { state: ["ide://notebook"] } },
    "extension.json",
  );
  assert.equal(bundled.contributes.state[0]?.path, "ide://notebook");
  assert.ok(ownsStatePath("acme.kernel", "ide://ext/acme.kernel/a"));
  assert.ok(!ownsStatePath("acme.kernel", "ide://ext/acme.kernelx"));
});

test("git, github, line annotations and tree messages are requests (D208)", async () => {
  const h = fakeHost((method) =>
    method === "github.notifications" ? [{ id: "1" }] : method === "git.revParse" ? "abc" : null,
  );
  assert.equal(await h.api.git.revParse("main", { repository: "inner" }), "abc");
  await h.api.git.lineLog("a.txt", 2, 4, { limit: 5 });
  await h.api.git.diffNames("main", undefined, { mergeBase: true });
  await h.api.git.blame("a.txt", { useEditorText: false });
  assert.deepEqual(await h.api.github.notifications(), [{ id: "1" }]);
  await h.api.github.markAllNotificationsRead();
  await h.api.editor.setLineAnnotations("a.txt", [{ line: 1, text: "Ann  3 d", tone: 0 }]);
  await h.api.editor.setLineAnnotations("a.txt", null);
  const tree = h.api.ui.registerTreeView("x.view", { getChildren: () => [] });
  tree.setMessage("Nothing yet");
  let changed = "";
  h.api.git.onDidChange((e) => {
    changed = e.root;
  });
  await h.tick();
  const reqs = h.requests();
  const of = (method: string) =>
    reqs.filter((r) => r.method === method).map((r) => r.params as Record<string, unknown>);
  assert.deepEqual(of("git.revParse")[0], { rev: "main", repository: "inner" });
  assert.deepEqual(of("git.lineLog")[0], { path: "a.txt", startLine: 2, endLine: 4, limit: 5 });
  assert.deepEqual(of("git.diffNames")[0], { left: "main", mergeBase: true });
  assert.deepEqual(of("git.blame")[0], { path: "a.txt", useEditorText: false });
  assert.deepEqual(of("github.markNotificationRead")[0], { all: true });
  assert.deepEqual(of("editor.setLineAnnotations")[1], { path: "a.txt", annotations: [] });
  assert.deepEqual(of("tree.message")[0], { viewId: "x.view", message: "Nothing yet" });
  const sub = of("events.subscribe").find((p) => p.type === "git.didChange");
  assert.ok(sub);
  h.deliver({ t: "call", id: 7, kind: "event", target: String(sub.sub), args: { root: "/r" } });
  await h.tick();
  assert.equal(changed, "/r");
});

test("language providers beyond hover: registered with their feature, called as providers", async () => {
  const h = fakeHost();
  const off = h.api.languages.registerDefinitionProvider(["plaintext"], (ctx) =>
    ctx.word === "x" ? { path: "a.txt", startLine: 2 } : undefined,
  );
  h.api.languages.registerSemanticTokensProvider("*", () => [], { tokenTypes: ["keyword"] });
  const regs = h.requests().filter((r) => r.method === "languages.register");
  const [definition, tokens] = regs.map((r) => r.params as Record<string, unknown>);
  assert.equal(definition?.feature, "definition");
  assert.deepEqual(definition?.languages, ["plaintext"]);
  assert.equal(tokens?.feature, "semanticTokens");
  assert.deepEqual(tokens?.legend, { tokenTypes: ["keyword"], tokenModifiers: [] });
  const id = String(definition?.id);
  const answers: FromWorker[] = [];
  const call = (callId: number, word: string) =>
    h.deliver({ t: "call", id: callId, kind: "provider", target: id, args: { word } });
  call(1, "x");
  call(2, "y");
  await h.tick();
  answers.push(...h.sent.filter((m) => m.t === "res"));
  assert.deepEqual(
    answers.map((a) => (a.t === "res" ? [a.id, a.value] : null)),
    [
      [1, { path: "a.txt", startLine: 2 }],
      // undefined crosses as null (JSON).
      [2, null],
    ],
  );
  off.dispose();
  assert.ok(h.requests().some((r) => r.method === "languages.unregister"));
  call(3, "x");
  await h.tick();
  const last = h.sent.at(-1);
  assert.ok(last?.t === "res" && last.id === 3 && last.value === null);
});

test("provider parts: rename's prepare, code actions resolved when chosen, token refresh", async () => {
  const h = fakeHost();
  let callId = 100;
  const ask = async (target: string, args: unknown) => {
    const id = ++callId;
    h.deliver({ t: "call", id, kind: "provider", target, args });
    await h.tick();
    const res = h.sent.find((m) => m.t === "res" && m.id === id);
    assert.ok(res && res.t === "res");
    return res;
  };
  const regOf = (feature: string) =>
    h
      .requests()
      .filter((r) => r.method === "languages.register")
      .map((r) => r.params as Record<string, unknown>)
      .filter((p) => p.feature === feature)
      .at(-1);

  // Rename: `prepare: true` on the registration; `<id>.prepare` answers or refuses.
  const offRename = h.api.languages.registerRenameProvider("*", () => [], {
    prepare: (ctx) => {
      if (!ctx.word) throw new Error("Only words.");
      return { startLine: ctx.line, startColumn: 1, endColumn: 4, placeholder: "abc" };
    },
  });
  const rename = regOf("rename");
  assert.equal(rename?.prepare, true);
  const renameId = String(rename?.id);
  assert.deepEqual((await ask(`${renameId}.prepare`, { word: "x", line: 2 })).value, {
    startLine: 2,
    startColumn: 1,
    endColumn: 4,
    placeholder: "abc",
  });
  const refused = await ask(`${renameId}.prepare`, { word: "", line: 2 });
  assert.equal(refused.t === "res" && refused.ok, false);
  assert.equal(refused.t === "res" && refused.error, "Only words.");
  offRename.dispose();
  assert.equal((await ask(`${renameId}.prepare`, { word: "x", line: 2 })).value, null);
  // Without prepare, nothing is flagged.
  h.api.languages.registerRenameProvider("*", () => []);
  assert.equal(regOf("rename")?.prepare, undefined);

  // Code actions with resolve: offered with ids, resolved with the extension's own object.
  const seen: unknown[] = [];
  h.api.languages.registerCodeActionProvider(
    "*",
    () => [{ title: "Fix", kind: "quickfix" }, { title: "Other" }],
    {
      resolve: (action) => {
        seen.push(action);
        action.edits = [{ startLine: 1, text: `${action.title}!` }];
        return undefined;
      },
    },
  );
  const actions = regOf("codeActions");
  assert.equal(actions?.resolve, true);
  const actionsId = String(actions?.id);
  const offered = (await ask(actionsId, { path: "a.txt" })).value as {
    title: string;
    resolveId: string;
  }[];
  assert.deepEqual(
    offered.map((a) => a.title),
    ["Fix", "Other"],
  );
  const [fix, other] = offered;
  assert.ok(fix?.resolveId && other?.resolveId && fix.resolveId !== other.resolveId);
  const resolved = (await ask(`${actionsId}.resolve`, { resolveId: fix.resolveId })).value as {
    title: string;
    edits: unknown[];
  };
  assert.equal(resolved.title, "Fix");
  assert.deepEqual(resolved.edits, [{ startLine: 1, text: "Fix!" }]);
  // resolve got the object the provider returned (not the copy that crossed).
  assert.ok(seen[0] && !("resolveId" in (seen[0] as object)));
  // Released ids resolve to nothing.
  await ask(`${actionsId}.release`, { resolveIds: [other.resolveId] });
  assert.equal((await ask(`${actionsId}.resolve`, { resolveId: other.resolveId })).value, null);

  // Semantic tokens: refresh() and the provider's own event ask the host to re-request.
  let fire: () => void = () => {};
  const tokens = h.api.languages.registerSemanticTokensProvider(
    "*",
    () => [],
    { tokenTypes: ["keyword"] },
    {
      onDidChange: (listener) => {
        fire = listener;
        return { dispose: () => (fire = () => {}) };
      },
    },
  );
  const tokensId = String(regOf("semanticTokens")?.id);
  const refreshes = () =>
    h
      .requests()
      .filter(
        (r) => r.method === "languages.refresh" && (r.params as { id: string }).id === tokensId,
      ).length;
  tokens.refresh();
  fire();
  assert.equal(refreshes(), 2);
  tokens.dispose();
  tokens.refresh();
  fire();
  assert.equal(refreshes(), 2);
});

test("ui.withProgress: start, reports, cancel from the host, end even when the task throws", async () => {
  const h = fakeHost();
  let cancelledSeen = false;
  const running = h.api.ui.withProgress(
    { title: "Indexing", cancellable: true },
    (progress, token) =>
      new Promise<string>((resolve) => {
        progress.report({ message: "half", increment: 50 });
        token.onCancellationRequested(() => {
          cancelledSeen = token.isCancellationRequested;
          resolve("stopped");
        });
      }),
  );
  await h.tick();
  const start = h.requests().find((r) => r.method === "ui.progressStart");
  const params = start?.params as { id: string; location: string; cancellable: boolean };
  assert.equal(params.location, "notification");
  assert.equal(params.cancellable, true);
  const report = h.requests().find((r) => r.method === "ui.progressReport");
  assert.deepEqual(report?.params, { id: params.id, message: "half", increment: 50 });
  h.deliver({ t: "call", id: 50, kind: "progress", target: params.id });
  assert.equal(await running, "stopped");
  assert.ok(cancelledSeen);
  await h.tick();
  assert.ok(h.requests().some((r) => r.method === "ui.progressEnd"));
  const failing = h.api.ui.withProgress({ location: "window" }, () => {
    throw new Error("boom");
  });
  await assert.rejects(failing, /boom/);
  await h.tick();
  assert.equal(h.requests().filter((r) => r.method === "ui.progressEnd").length, 2);
});

test("audit: an answer or a request that can't be serialized fails instead of hanging", async () => {
  const sent: unknown[] = [];
  let deliver: (m: ToWorker) => void = () => {};
  const { api } = createWorkerApi(
    {
      // As the Node host and a worker do: the message is serialized now, or it throws.
      post: (m) => sent.push(JSON.parse(JSON.stringify(m))),
      onMessage: (h) => (deliver = h),
    },
    { id: "acme.cycle", version: "1.0.0" },
  );
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  api.commands.register("acme.cycle.run", () => cyclic);
  deliver({ t: "call", id: 7, kind: "command", target: "acme.cycle.run" });
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  const answer = sent.find(
    (m): m is { t: string; id: number; ok: boolean; error?: string } =>
      (m as { t?: unknown }).t === "res" && (m as { id?: unknown }).id === 7,
  );
  assert.ok(answer, "the host gets an answer");
  assert.equal(answer.ok, false);
  assert.match(answer.error ?? "", /couldn't be sent/);
  // A request with such params rejects at once.
  await assert.rejects(api.commands.execute("other.command", cyclic));
});

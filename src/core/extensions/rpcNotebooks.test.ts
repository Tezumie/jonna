import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerApi, type FromWorker, type ToWorker } from "./rpc";
import { fromNotebookData, toNotebookData } from "./rpcNotebooks";

const tick = () => new Promise((r) => setTimeout(r, 0));

function harness() {
  const sent: FromWorker[] = [];
  let deliver: (m: ToWorker) => void = () => {};
  const { api } = createWorkerApi(
    { post: (m) => sent.push(m), onMessage: (h) => (deliver = h) },
    { id: "acme.toy", version: "1" },
  );
  let callId = 100;
  const call = async (target: string, args: unknown) => {
    const id = ++callId;
    deliver({ t: "call", id, kind: "notebook", target, args });
    for (let i = 0; i < 10; i++) await tick();
    const r = sent.find((m) => m.t === "res" && m.id === id);
    assert.ok(r && r.t === "res", `no reply to ${target}`);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  const requests = (method: string) =>
    sent.filter(
      (m): m is Extract<FromWorker, { t: "req" }> => m.t === "req" && m.method === method,
    );
  return { api, call, requests, deliver };
}

test("ide.notebooks: a serializer and a kernel source answer the editor's calls (D202)", async () => {
  const { api, call, requests, deliver } = harness();
  api.notebooks.registerSerializer("acme.toy.book", {
    deserialize: (text) => ({
      cells: text.split("\n---\n").map((source) => ({ kind: "code", source })),
    }),
    serialize: (nb) => nb.cells.map((c) => c.source).join("\n---\n"),
  });
  assert.deepEqual(requests("notebooks.registerSerializer")[0]?.params, { type: "acme.toy.book" });
  const data = (await call("deserialize", { type: "acme.toy.book", text: "1+1\n---\n2" })) as {
    cells: { source: string }[];
  };
  assert.deepEqual(
    data.cells.map((c) => c.source),
    ["1+1", "2"],
  );
  assert.equal(await call("serialize", { type: "acme.toy.book", notebook: data }), "1+1\n---\n2");

  let shut = false;
  api.notebooks.registerKernelSource({
    id: "calc",
    label: "Calculator",
    notebookTypes: ["acme.toy.book"],
    find: () => [{ id: "js", label: "JavaScript math" }],
    start: (_option, _context, host) => {
      host.setStatus("idle");
      return {
        async execute(code, run) {
          const name = await run.input("Name?");
          run.emit({ type: "stream", name: "stdout", text: `hi ${name}\n` });
          run.emit({ type: "result", data: { "text/plain": String(code.length) }, count: 1 });
          return { count: 1 };
        },
        shutdown: () => {
          shut = true;
        },
      };
    },
  });
  assert.deepEqual(requests("notebooks.registerKernelSource")[0]?.params, {
    id: "calc",
    label: "Calculator",
    notebookTypes: ["acme.toy.book"],
  });
  assert.deepEqual(await call("find", { source: "calc", context: {} }), [
    { id: "js", label: "JavaScript math" },
  ]);
  assert.equal(await call("start", { source: "calc", kernel: "k1", option: { id: "js" } }), true);

  // The cell asks for input: the host answers the request, then the outputs stream.
  const done = call("execute", { kernel: "k1", exec: "x1", code: "abc" });
  await tick();
  const ask = requests("notebooks.input")[0];
  assert.ok(ask);
  assert.deepEqual(ask.params, { kernel: "k1", exec: "x1", prompt: "Name?", password: false });
  deliver({ t: "res", id: ask.id, ok: true, value: "Ada" });
  assert.deepEqual(await done, { status: "ok", count: 1 });
  const outputs = requests("notebooks.output").map((r) => (r.params as { event: unknown }).event);
  assert.deepEqual(outputs, [
    { type: "stream", name: "stdout", text: "hi Ada\n" },
    { type: "result", data: { "text/plain": "3" }, count: 1 },
  ]);
  assert.equal(await call("complete", { kernel: "k1", code: "", cursor: 0 }), null);
  await call("shutdown", { kernel: "k1" });
  assert.equal(shut, true);
  await assert.rejects(call("execute", { kernel: "k1", exec: "x2", code: "" }), /No kernel/);
});

test("notebook data from extensions is checked and filled in", () => {
  const nb = fromNotebookData({
    cells: [
      { kind: "markdown", source: "# Hi", outputs: [{ output_type: "stream" }] },
      {
        id: "a",
        kind: "code",
        source: "x",
        outputs: [{ output_type: "stream", text: ["1", "\n"] }, 5],
      },
      { id: "a", kind: "weird", source: 7 },
    ],
    metadata: { k: 1 },
  });
  assert.deepEqual(
    nb.cells.map((c) => [c.id, c.kind, c.source, c.outputs.length]),
    [
      ["cell-1", "markdown", "# Hi", 0],
      ["a", "code", "x", 1],
      ["cell-2", "code", "", 0],
    ],
  );
  assert.deepEqual(nb.metadata, { k: 1 });
  assert.throws(() => fromNotebookData({}), /no cells/);
  assert.deepEqual(toNotebookData(nb).cells[1], {
    id: "a",
    kind: "code",
    source: "x",
    metadata: {},
    outputs: [{ output_type: "stream", text: "1\n" }],
    executionCount: null,
    extra: {},
  });
});

test("ide.notebooks D204: picker actions, the running cell, status items, renderer messages", async () => {
  const { api, call, requests, deliver } = harness();
  let seenCell: unknown = null;
  api.notebooks.registerKernelSource({
    id: "remote",
    label: "Remote",
    find: () => [],
    actions: [
      {
        id: "connect",
        label: "Existing server…",
        detail: "a URL",
        run: (context) => ({
          id: `srv:${context.path}`,
          label: "Server",
          languages: ["python", "sql"],
        }),
      },
    ],
    start: () => ({
      async execute(_code, run) {
        seenCell = run.cell ?? null;
        run.clear({ wait: true });
        return { count: 1 };
      },
    }),
  });
  assert.deepEqual(requests("notebooks.registerKernelSource")[0]?.params, {
    id: "remote",
    label: "Remote",
    actions: [{ id: "connect", label: "Existing server…", detail: "a URL" }],
  });
  assert.deepEqual(
    await call("action", { source: "remote", action: "connect", context: { path: "/r/a.ipynb" } }),
    { id: "srv:/r/a.ipynb", label: "Server", languages: ["python", "sql"] },
  );
  await call("start", {
    source: "remote",
    kernel: "k1",
    option: { id: "x", label: "x" },
    context: {},
  });
  const cell = { id: "c1", index: 2, language: "sql", metadata: { tags: ["t"] } };
  await call("execute", { kernel: "k1", exec: "x1", code: "select 1", cell });
  assert.deepEqual(seenCell, cell);
  const last = requests("notebooks.output").at(-1)?.params as { event: unknown } | undefined;
  assert.deepEqual(last?.event, {
    type: "clear",
    wait: true,
  });

  const status = api.notebooks.registerCellStatusBarItemProvider("*", (ctx) => [
    { text: `cell ${ctx.cell.index}`, alignment: "right" },
  ]);
  const reg = requests("notebooks.registerStatusProvider")[0]?.params as { id: string };
  assert.equal((reg as { notebookType?: string }).notebookType, "*");
  assert.deepEqual(await call("status", { provider: reg.id, context: { cell: { index: 4 } } }), [
    { text: "cell 4", alignment: "right" },
  ]);
  status.dispose();
  assert.equal(requests("notebooks.unregisterStatusProvider").length, 1);
  assert.deepEqual(await call("status", { provider: reg.id, context: {} }), []);

  const messaging = api.notebooks.createRendererMessaging("acme.toy.chart");
  const heard: unknown[] = [];
  const listening = messaging.onDidReceiveMessage((e) => heard.push(e));
  await call("rendererMessage", {
    renderer: "acme.toy.chart",
    message: { clicked: 3 },
    path: "/r/a",
  });
  assert.deepEqual(heard, [{ message: { clicked: 3 }, path: "/r/a" }]);
  listening.dispose();
  void messaging.postMessage({ draw: true }, { path: "/r/a" });
  await tick();
  assert.deepEqual(requests("notebooks.rendererPost")[0]?.params, {
    renderer: "acme.toy.chart",
    message: { draw: true },
    path: "/r/a",
  });
  void deliver;
});

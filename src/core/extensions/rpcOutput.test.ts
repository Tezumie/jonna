// `ide.ui.createOutputChannel`: lines batched per turn, partial lines kept until their end,
// clear / show after what was written, the log methods' levels, and the channel ids.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerApi, type FromWorker, type RequestMessage, type ToWorker } from "./rpc";
import { channelsOf, extensionChannelId } from "./rpcOutput";

function fakeHost() {
  const sent: FromWorker[] = [];
  let deliver: (m: ToWorker) => void = () => {};
  const { api } = createWorkerApi(
    {
      post: (m) => {
        sent.push(m);
        if (m.t === "req")
          queueMicrotask(() => deliver({ t: "res", id: m.id, ok: true, value: null }));
      },
      onMessage: (h) => (deliver = h),
    },
    { id: "acme.todo", version: "1.0.0" },
  );
  const requests = () =>
    sent
      .filter((m): m is RequestMessage => m.t === "req")
      .map((m) => ({ method: m.method, params: m.params as Record<string, unknown> }));
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { api, requests, settle };
}

test("output channel: one batch per turn, partial lines wait, clear and show in order", async () => {
  const { api, requests, settle } = fakeHost();
  const channel = api.ui.createOutputChannel("Todo scan");
  assert.equal(channel.name, "Todo scan");
  channel.appendLine("first");
  channel.append("sec");
  channel.append("ond\nthi");
  channel.warn("careful", { n: 1 });
  await settle();
  await settle();
  assert.deepEqual(requests(), [
    { method: "output.create", params: { name: "Todo scan" } },
    {
      method: "output.append",
      params: {
        name: "Todo scan",
        lines: [
          { level: "info", text: "first" },
          { level: "info", text: "second" },
          // A log call ends the partial line first.
          { level: "info", text: "thi" },
          { level: "warn", text: 'careful {"n":1}' },
        ],
      },
    },
  ]);
  channel.appendLine("gone");
  channel.clear();
  channel.appendLine("after clear");
  channel.show();
  await settle();
  await settle();
  assert.deepEqual(
    requests()
      .slice(2)
      .map((r) => [r.method, r.params.lines ?? r.params.preserveFocus ?? null]),
    [
      ["output.clear", null],
      ["output.append", [{ level: "info", text: "after clear" }]],
      ["output.show", false],
    ],
  );
  channel.dispose();
  channel.appendLine("ignored");
  await settle();
  assert.equal(requests().length, 5);
  assert.throws(() => api.ui.createOutputChannel("  "), /needs a name/);
});

test("output channel ids", () => {
  assert.equal(extensionChannelId("acme.todo", "Todo scan"), "ext.acme.todo~todo-scan");
  assert.equal(extensionChannelId("acme.todo", "!!!"), "ext.acme.todo~output");
  assert.deepEqual(
    channelsOf("acme.todo", [
      "exthost",
      "ext.acme.todo~a",
      "ext.acme.todos~b",
      "ext.acme.todo.x~c",
    ]),
    ["ext.acme.todo~a"],
  );
});

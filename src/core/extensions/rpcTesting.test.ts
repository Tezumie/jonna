// The worker side of ide.tests (VS Code's test controllers): the items' snapshot, run profiles
// called by the host, a run's events in batches, cancellation and the resolve handler, through
// createWorkerApi with a fake host.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerApi, type FromWorker, type RequestMessage, type ToWorker } from "./rpc";

function fakeHost() {
  const sent: FromWorker[] = [];
  let deliver: (m: ToWorker) => void = () => {};
  let callId = 1000;
  const { api } = createWorkerApi(
    {
      post: (m) => {
        sent.push(m);
        if (m.t === "req") queueMicrotask(() => deliver({ t: "res", id: m.id, ok: true }));
      },
      onMessage: (h) => (deliver = h),
    },
    { id: "acme.tests", version: "1.0.0" },
  );
  const requests = (method: string) =>
    sent
      .filter((m): m is RequestMessage => m.t === "req" && m.method === method)
      .map((m) => m.params as Record<string, unknown>);
  const tick = () => new Promise((r) => setTimeout(r, 0));
  /** Calls the worker's "provider" callback; resolves with its reply once it comes. */
  const call = async (target: string, args: unknown) => {
    const id = ++callId;
    deliver({ t: "call", id, kind: "provider", target, args });
    for (let i = 0; i < 50; i++) {
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

type Item = Record<string, unknown>;
const last = <T>(list: T[]): T | undefined => list[list.length - 1];
/** The last items snapshot the host got. */
const snapshotOf = (h: ReturnType<typeof fakeHost>) =>
  (last(h.requests("tests.update")) ?? { items: [], profiles: [] }) as {
    items: Item[];
    profiles: Item[];
    resolvable?: unknown;
  };

test("tests: items nest, change once per turn, and carry their file and line", async () => {
  const h = fakeHost();
  const ctrl = h.api.tests.createTestController("memo", "Memo tests");
  const file = ctrl.createTestItem("a.memo", "a.memo", "tests/a.memo");
  const one = ctrl.createTestItem("one", "adds one", "tests/a.memo");
  one.range = { startLine: 3 };
  file.children.add(one);
  ctrl.items.add(file);
  ctrl.createRunProfile("Run", 1, () => {}, true);
  await h.tick();
  await h.tick();
  const created = h.requests("tests.createController")[0];
  assert.equal(created?.id, "memo");
  const update = snapshotOf(h);
  const items = update.items;
  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map((i) => [i.label, i.parent === null ? null : "child", i.path, i.line ?? null]),
    [
      ["a.memo", null, "tests/a.memo", null],
      ["adds one", "child", "tests/a.memo", 3],
    ],
  );
  assert.equal(items[1]?.parent, items[0]?.wid);
  assert.deepEqual(
    update.profiles.map((p) => [p.kind, p.isDefault]),
    [["run", true]],
  );
  assert.equal(one.parent, file);
  assert.equal(ctrl.items.size, 1);
  assert.equal(ctrl.items.get("a.memo"), file);
  // One change → one more snapshot.
  const before = h.requests("tests.update").length;
  one.label = "adds 1";
  one.busy = true;
  await h.tick();
  assert.equal(h.requests("tests.update").length, before + 1);
  file.children.delete("one");
  await h.tick();
  assert.equal(snapshotOf(h).items.length, 1);
});

test("tests: the host runs a profile; the run reports in batches and ends", async () => {
  const h = fakeHost();
  const ctrl = h.api.tests.createTestController("memo", "Memo");
  const a = ctrl.createTestItem("a", "a");
  const b = ctrl.createTestItem("b", "b");
  ctrl.items.replace([a, b]);
  let request: { include?: readonly unknown[] } | undefined;
  ctrl.createRunProfile("Run", "run", async (req) => {
    request = req;
    const run = ctrl.createTestRun(req, "memo run");
    run.started(a);
    run.passed(a, 12);
    run.failed(b, { message: "nope", expectedOutput: "1", actualOutput: "2" });
    run.appendOutput("done\r\n");
    run.end();
    run.passed(a); // after end: ignored
  });
  await h.tick();
  await h.tick();
  const update = snapshotOf(h);
  const [wa, wb] = update.items.map((i) => String(i.wid));
  const profile = String(update.profiles[0]?.id);
  const cid = String(h.requests("tests.createController")[0]?.controller);
  await h.call(`tests.${cid}.run`, { profile, include: [wb], key: "h1" });
  assert.deepEqual(request?.include, [b]);
  const runs = h.requests("tests.run");
  const events = runs
    .flatMap((r) => r.events as Item[])
    .filter((e) => e.kind !== "output" || e.text);
  assert.deepEqual(events, [
    { kind: "started", test: wa },
    { kind: "passed", test: wa, durationMs: 12 },
    { kind: "failed", test: wb, message: "nope", expected: "1", actual: "2" },
    { kind: "output", text: "done\r\n" },
  ]);
  assert.equal(last(runs)?.ended, true);
  assert.equal(last(runs)?.name, "memo run");
  await assert.rejects(h.call(`tests.${cid}.run`, { profile: "gone" }), /profile is gone/);
});

test("tests: Stop cancels the run's token; resolveHandler finds children on demand", async () => {
  const h = fakeHost();
  const ctrl = h.api.tests.createTestController("memo", "Memo");
  const file = ctrl.createTestItem("f", "f.memo");
  file.canResolveChildren = true;
  ctrl.items.add(file);
  const asked: (string | undefined)[] = [];
  ctrl.resolveHandler = (item) => {
    asked.push(item?.id);
    if (item) item.children.add(ctrl.createTestItem("t1", "t1"));
  };
  let cancelled = false;
  let release: () => void = () => {};
  ctrl.createRunProfile("Run", "run", (req, token) => {
    const run = ctrl.createTestRun(req);
    run.token.onCancellationRequested(() => {
      cancelled = true;
      run.end();
      release();
    });
    return new Promise<void>((r) => {
      release = r;
      if (token.isCancellationRequested) r();
    });
  });
  await h.tick();
  await h.tick();
  const cid = String(h.requests("tests.createController")[0]?.controller);
  const update = snapshotOf(h);
  assert.equal(update.resolvable, true);
  const wid = String(update.items[0]?.wid);
  await h.call(`tests.${cid}.resolve`, { item: wid });
  await h.call(`tests.${cid}.resolve`, {});
  assert.deepEqual(asked, ["f", undefined]);
  assert.equal(snapshotOf(h).items.length, 2);
  const profile = String(snapshotOf(h).profiles[0]?.id);
  const running = h.call(`tests.${cid}.run`, { profile, key: "h9" });
  await h.tick();
  await h.call(`tests.${cid}.cancel`, {});
  await running;
  assert.equal(cancelled, true);
  ctrl.dispose();
  await h.tick();
  assert.equal(h.requests("tests.dispose").length, 1);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBatch, runBatch, type StepOutcome } from "./browserBatch";

const TOOLS = ["browser_act", "screenshot", "browser_snapshot"];

test("D316: batch steps are checked: known tools, objects, not nested", () => {
  assert.deepEqual(parseBatch([{ name: "browser_act", input: { action: "back" } }], TOOLS), [
    { name: "browser_act", input: { action: "back" } },
  ]);
  assert.deepEqual(parseBatch('[{"name":"screenshot"}]', TOOLS), [
    { name: "screenshot", input: {} },
  ]);
  assert.throws(() => parseBatch([{ name: "browser_batch", input: {} }], TOOLS), /can't be nested/);
  assert.throws(() => parseBatch([{ name: "rm", input: {} }], TOOLS), /unknown tool "rm"/);
  assert.throws(() => parseBatch([], TOOLS), /at least one/);
  assert.throws(() => parseBatch([{ name: "screenshot", input: [1] }], TOOLS), /an object/);
});

test("D316: steps run in order and the batch stops at the first error", async () => {
  const order: number[] = [];
  const outcomes: StepOutcome[] = [
    { result: "clicked" },
    { result: "shot", images: ["png1"] },
    { result: "No element e9", isError: true },
    { result: "never" },
  ];
  const steps = outcomes.map((_, i) => ({ name: "browser_act", input: { i } }));
  const r = await runBatch(steps, async (_s, i) => {
    order.push(i);
    return outcomes[i] as StepOutcome;
  });
  assert.deepEqual(order, [0, 1, 2]);
  assert.equal(r.isError, true);
  assert.equal(r.ran, 3);
  assert.deepEqual(r.images, ["png1"]);
  assert.match(r.result, /\[2\] browser_act \(image 1 attached\):\nshot/);
  assert.match(r.result, /\[3\] browser_act — error:\nNo element e9/);
  assert.match(r.result, /Stopped at step 3 of 4; step 4 didn't run\./);
});

test("D316: a thrown error, a refusal and Stop end the batch too", async () => {
  const thrown = await runBatch([{ name: "screenshot", input: {} }], async () => {
    throw new Error("boom");
  });
  assert.equal(thrown.isError, true);
  assert.match(thrown.result, /boom/);
  const refused = await runBatch(
    [
      { name: "browser_act", input: {} },
      { name: "browser_act", input: {} },
    ],
    async () => ({ result: "The user said no.", denied: true }),
  );
  assert.equal(refused.denied, true);
  assert.equal(refused.isError, false);
  let calls = 0;
  const stopped = await runBatch(
    [
      { name: "browser_act", input: {} },
      { name: "browser_act", input: {} },
    ],
    async () => {
      calls++;
      return { result: "ok" };
    },
    (s) => s.name,
    () => calls > 0,
  );
  assert.equal(calls, 1);
  assert.match(stopped.result, /Stopped by the user before step 2/);
  const fine = await runBatch([{ name: "screenshot", input: {} }], async () => ({ result: "ok" }));
  assert.equal(fine.isError, false);
  assert.equal(fine.summary, "1 step");
});

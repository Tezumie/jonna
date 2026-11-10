import assert from "node:assert/strict";
import { test } from "node:test";
import { MergeModel } from "../../core/diff/merge";
import {
  hasSavedLayout,
  MergeLayoutMemory,
  readMergeLayout,
  saveMergeLayout,
  splitAfterDrag,
} from "./mergeLayout";

test("a merge tab's layout is read back, odd values ignored (D209)", () => {
  assert.deepEqual(readMergeLayout(null), {
    weights: { incoming: 1, base: 1, current: 1 },
    split: 0.5,
  });
  const layout = readMergeLayout({
    path: "a.ts",
    weights: { incoming: 2, base: -1, current: "x" },
    split: 0.99,
  });
  assert.deepEqual(layout, { weights: { incoming: 2, base: 1, current: 1 }, split: 0.9 });
  assert.deepEqual(saveMergeLayout(readMergeLayout({})), {});
  assert.deepEqual(saveMergeLayout(layout), {
    weights: { incoming: 2, base: 1, current: 1 },
    split: 0.9,
  });
});

test("dragging the sash above the result", () => {
  assert.equal(splitAfterDrag(300, 300, 60), 0.6);
  assert.equal(splitAfterDrag(300, 300, -1000), 80 / 600, "the inputs keep 80 px");
  assert.equal(splitAfterDrag(100, 100, 500), 0.6, "the result keeps 80 px");
  assert.equal(splitAfterDrag(0, 0, 10), 0.5);
});

test("the result's lines of a change, for its word highlights (D209)", () => {
  const m = new MergeModel("a\nb\nc\n", "a\nB1\nc\n", "a\nb\nc2\n");
  const [first, second] = m.changes;
  assert.ok(first && second);
  assert.deepEqual(m.resultLinesOf(first.id), ["B1"]);
  assert.deepEqual(m.resultLinesOf(second.id), ["c2"]);
  assert.deepEqual(m.resultLinesOf(99), []);
});

test("each file's last merge layout is remembered for its next tab (D219)", () => {
  const memory = new MergeLayoutMemory((p) => p.toLowerCase());
  assert.deepEqual(memory.recall("/a.ts"), readMergeLayout(null));
  memory.remember("/A.ts", { weights: { incoming: 2, base: 1, current: 1 }, split: 0.3 });
  assert.equal(memory.recall("/a.ts").split, 0.3);
  assert.equal(memory.recall("/a.ts").weights.incoming, 2);
  // Back to the default: forgotten.
  memory.remember("/a.ts", readMergeLayout(null));
  assert.deepEqual(memory.toJSON(), {});
  // Saved and read back; odd entries dropped; at most 100 kept (the newest).
  for (let i = 0; i < 105; i++)
    memory.remember(`/f${i}`, { weights: { incoming: 1, base: 1, current: 1 }, split: 0.4 });
  const copy = new MergeLayoutMemory();
  copy.restore({ ...memory.toJSON(), "/odd": 3 });
  assert.equal(Object.keys(copy.toJSON()).length, 100);
  assert.equal(copy.recall("/f104").split, 0.4);
  assert.equal(copy.recall("/f0").split, 0.5);
  assert.equal(hasSavedLayout({ path: "x" }), false);
  assert.equal(hasSavedLayout({ path: "x", split: 0.3 }), true);
});

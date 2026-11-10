import assert from "node:assert/strict";
import { test } from "node:test";
import { compose, hunkPositions, hunkStat, hunks, segmentsOf } from "./hunks";

test("an inline edit's rewrite as hunks, each accepted or rejected on its own (D172)", () => {
  const original = "a\nb\nc\nd\ne";
  const next = "a\nB\nc\nd\nE\nF";
  const segs = segmentsOf(original, next);
  assert.deepEqual(
    hunks(segs).map((h) => [h.removed, h.added]),
    [
      [["b"], ["B"]],
      [["e"], ["E", "F"]],
    ],
  );
  assert.equal(compose(segs), next);
  assert.deepEqual(hunkPositions(segs), [
    { start: 1, count: 1 },
    { start: 4, count: 2 },
  ]);
  assert.deepEqual(hunkStat(segs), { added: 3, removed: 2 });
  // Rejecting the first puts "b" back; the second keeps its new lines.
  const first = hunks(segs)[0];
  if (first) first.state = "rejected";
  assert.equal(compose(segs), "a\nb\nc\nd\nE\nF");
  assert.deepEqual(hunkStat(segs), { added: 2, removed: 1 });
  // Rejecting everything is the original again.
  for (const h of hunks(segs)) h.state = "rejected";
  assert.equal(compose(segs), original);
});

test("pure insertions and deletions, an empty selection, no change", () => {
  const ins = segmentsOf("a\nc", "a\nb\nc");
  assert.deepEqual(
    hunks(ins).map((h) => [h.removed, h.added]),
    [[[], ["b"]]],
  );
  assert.deepEqual(hunkPositions(ins), [{ start: 1, count: 1 }]);
  const del = segmentsOf("a\nb\nc", "a\nc");
  assert.deepEqual(
    hunks(del).map((h) => [h.removed, h.added]),
    [[["b"], []]],
  );
  const deleted = hunks(del)[0];
  if (deleted) deleted.state = "rejected";
  assert.equal(compose(del), "a\nb\nc");
  assert.deepEqual(hunkPositions(del), [{ start: 1, count: 1 }]);
  assert.deepEqual(
    hunks(segmentsOf("", "x\ny")).map((h) => h.added),
    [["x", "y"]],
  );
  assert.equal(hunks(segmentsOf("same\ntext", "same\ntext")).length, 0);
});

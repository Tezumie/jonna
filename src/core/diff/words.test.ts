import assert from "node:assert/strict";
import { test } from "node:test";
import { wordChanges } from "./words";

test("wordChanges: the changed words of a line, merged per line (D207)", () => {
  assert.deepEqual(wordChanges(["const port = 3000;"], ["const port = 8080;"]), [
    { line: 0, start: 13, end: 17 },
  ]);
  // Two words next to each other (with the space between) are one range.
  assert.deepEqual(wordChanges(["let a = b;"], ["let x y = b;"]), [{ line: 0, start: 4, end: 7 }]);
  // Lines added inside a changed block: the new line is changed as a whole.
  assert.deepEqual(wordChanges(["a();", "c();"], ["a();", "b();", "c();"]), [
    { line: 1, start: 0, end: 4 },
  ]);
  assert.deepEqual(wordChanges(["same"], ["same"]), []);
});

test("wordChanges: nothing for a pure insertion, deletion or a huge block", () => {
  assert.deepEqual(wordChanges([], ["new"]), []);
  assert.deepEqual(wordChanges(["old"], []), []);
  const big = ["x".repeat(30_000)];
  assert.deepEqual(wordChanges(big, ["y"]), []);
});

test("wordChanges: non-ASCII words stay whole", () => {
  assert.deepEqual(wordChanges(["grüße welt"], ["grüße wörld"]), [{ line: 0, start: 6, end: 11 }]);
});

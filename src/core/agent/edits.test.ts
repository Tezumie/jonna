import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEdits, withLineEndingsOf } from "./edits";

test("write_file keeps a CRLF file's line endings", () => {
  assert.equal(withLineEndingsOf("a\r\nb\r\n", "x\ny\n"), "x\r\ny\r\n");
  assert.equal(withLineEndingsOf("a\nb\n", "x\ny\n"), "x\ny\n");
  // A new file, or text that brings its own CRLFs, is written as given.
  assert.equal(withLineEndingsOf(null, "x\ny"), "x\ny");
  assert.equal(withLineEndingsOf("a\r\n", "x\r\ny\n"), "x\r\ny\n");
  assert.equal(withLineEndingsOf("one line", "x\ny"), "x\ny");
});

test("near match: a typo'd block in a big file of near-identical lines stays fast", () => {
  // Thousands of blocks sharing trivial lines ("}", "") used to each get a full edit-distance
  // score on every variant of the edit.
  const blocks: string[] = [];
  for (let i = 0; i < 3000; i++)
    blocks.push(`function f${i}(value) {\n  return value + ${i};\n}\n`);
  const text = blocks.join("\n");
  const started = Date.now();
  const near = applyEdits(text, [
    {
      old: "function f1234(value)  {\n  return value + 1234\n}",
      new: "function f1234(value) {\n  return value * 2;\n}",
    },
  ]);
  assert.equal(near.ok && near.text.includes("return value * 2;"), true);
  assert.equal(near.ok && near.text.includes("return value + 1235;"), true);
  // Approximate, so the result says where (D163).
  assert.ok(near.ok && near.approximate?.length === 1);
  // Only trivial lines in common: no near match, and no time spent looking.
  const miss = applyEdits(text, [{ old: "}\n\n}\nzzzzzzzzzzzzzzzzzz", new: "x" }]);
  assert.equal(miss.ok, false);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
});

test("near match: two equally close blocks are ambiguous", () => {
  const text = "if (a) {\n  doThing(alpha);\n}\n\nif (a) {\n  doThing(alpha);\n}\n";
  const r = applyEdits(text, [{ old: "if (a) {\n  doThing(alpha)\n}", new: "x" }]);
  assert.equal(r.ok, false);
});

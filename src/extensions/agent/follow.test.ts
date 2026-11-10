import assert from "node:assert/strict";
import { test } from "node:test";
import { firstChangedLine } from "./follow";

test("firstChangedLine: the line where the edit starts", () => {
  assert.equal(firstChangedLine("a\nb\nc\n", "a\nB\nc\n"), 2);
  assert.equal(firstChangedLine("a\nb\nc", "a\nb\nc!"), 3);
  assert.equal(firstChangedLine("x", "y"), 1);
});

test("firstChangedLine: new files and unchanged text start at line 1", () => {
  assert.equal(firstChangedLine(null, "hello\nworld"), 1);
  assert.equal(firstChangedLine("same", "same"), 1);
});

test("firstChangedLine: lines added at the end start on the new line", () => {
  assert.equal(firstChangedLine("a\nb", "a\nb\nc"), 3);
  assert.equal(firstChangedLine("a\nb\n", "a\nb\nc\n"), 3);
});

test("firstChangedLine: text removed at the end lands on the last line left", () => {
  assert.equal(firstChangedLine("a\nb\nc\nd", "a\nb"), 2);
  assert.equal(firstChangedLine("a\nb\n", "a\nb"), 2);
  assert.equal(firstChangedLine("abc", ""), 1);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { conflictAt, findConflicts, resolveConflicts } from "./conflicts";

const text = [
  "a",
  "<<<<<<< HEAD",
  "mine",
  "=======",
  "theirs",
  ">>>>>>> feature",
  "b",
  "<<<<<<< HEAD",
  "x",
  "||||||| base",
  "orig",
  "=======",
  "y",
  ">>>>>>> feature",
].join("\n");

test("finds two-way and diff3 conflicts", () => {
  const c = findConflicts(text);
  assert.equal(c.length, 2);
  assert.deepEqual(c[0], {
    start: 2,
    separator: 4,
    end: 6,
    currentLabel: "HEAD",
    incomingLabel: "feature",
  });
  assert.equal(c[1]?.base, 10);
  assert.equal(conflictAt(c, 9), c[1]);
  assert.equal(conflictAt(c, 1), c[0]);
  assert.deepEqual(findConflicts("no markers"), []);
});

test("resolves one or all, keeping line endings", () => {
  const [first] = findConflicts(text);
  assert.ok(first);
  assert.equal(
    resolveConflicts(text, "incoming", first).text.split("\n").slice(0, 3).join("|"),
    "a|theirs|b",
  );
  assert.equal(resolveConflicts(text, "current", "all").text, "a\nmine\nb\nx");
  assert.equal(resolveConflicts(text, "both", "all").text, "a\nmine\ntheirs\nb\nx\ny");
  const crlf = text.replace(/\n/g, "\r\n");
  assert.equal(resolveConflicts(crlf, "current", "all").text, "a\r\nmine\r\nb\r\nx");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { editMayReturnToSuggestion, GhostTextCache, LruMap } from "./cache";

test("LruMap forgets the least recently used and the expired (D224)", () => {
  const m = new LruMap<string, number>(2, 1000);
  m.set("a", 1, 0);
  m.set("b", 2, 0);
  assert.equal(m.get("a", 10), 1); // a is now newest
  m.set("c", 3, 10);
  assert.equal(m.get("b", 10), undefined);
  assert.deepEqual(m.values(10), [3, 1]);
  assert.equal(m.get("a", 2000), undefined); // expired
  assert.equal(m.size, 1);
  m.clear();
  assert.equal(m.size, 0);
});

const key = (prefix: string, suffix = "\n}\n") => ({
  path: "/w/a.ts",
  model: "ollama/coder",
  prefix,
  suffix,
});

test("ghost text: typing through a suggestion shows its rest without asking", () => {
  const c = new GhostTextCache();
  const before = "function twice(n: number) {\n  return ";
  c.put(key(before), "n * 2;\n  // done", 0);
  assert.deepEqual(c.get(key(before), 1), { text: "n * 2;\n  // done", typed: 0 });
  assert.deepEqual(c.get(key(`${before}n `), 1), { text: "* 2;\n  // done", typed: 2 });
  assert.deepEqual(c.get(key(`${before}n * 2;\n`), 1), { text: "  // done", typed: 7 });
  // Typed something else, the whole of it, or the code after the cursor changed: ask.
  assert.equal(c.get(key(`${before}m`), 1), undefined);
  assert.equal(c.get(key(`${before}n * 2;\n  // done`), 1), undefined);
  assert.equal(c.get(key(`${before}n`, ")\n}\n"), 1), undefined);
  // Another file or model: its own suggestions.
  assert.equal(c.get({ ...key(before), path: "/w/b.ts" }, 1), undefined);
  assert.equal(c.get({ ...key(before), model: "ollama/other" }, 1), undefined);
  assert.equal(c.hits, 3);
  assert.equal(c.misses, 5);
});

test("ghost text: a spot with no suggestion is remembered, only there", () => {
  const c = new GhostTextCache();
  c.put(key("x = "), null, 0);
  assert.deepEqual(c.get(key("x = "), 1), { text: null, typed: 0 });
  assert.equal(c.get(key("x = 1"), 1), undefined);
});

test("ghost text: long prefixes match by their end; the file's start by all of it", () => {
  const c = new GhostTextCache();
  const long = `${"const a = 1;\n".repeat(500)}const b = `;
  c.put(key(long), "a + 1;", 0);
  // The editor sends a window of the text before the cursor: its start moves as the user types.
  assert.deepEqual(c.get(key(`${long.slice(5)}a +`), 1), { text: " 1;", typed: 3 });
  // Near the file's start the anchor is the whole prefix: the same text later in a file isn't it.
  c.put(key("let "), "x = 1;", 0);
  assert.equal(c.get(key("// let\nlet x"), 1), undefined);
  assert.deepEqual(c.get(key("let x"), 1), { text: " = 1;", typed: 1 });
});

test("ghost text: expired entries and the LRU bound", () => {
  const c = new GhostTextCache(2, 1000);
  c.put(key("a"), "1", 0);
  c.put(key("b"), "2", 0);
  c.put(key("c"), "3", 0);
  assert.equal(c.size, 2);
  assert.equal(c.get(key("a"), 1), undefined);
  assert.equal(c.get(key("c"), 2000), undefined);
  c.clear();
  assert.equal(c.size, 0);
  assert.equal(c.hits + c.misses, 0);
});

test("ghost text: a bracket the editor closed doesn't ask again (D229)", () => {
  const c = new GhostTextCache();
  const before = "const total = sum";
  c.put(key(before, ";\n"), "(a, b)", 0);
  // Typing `(` made the editor add `)` after the cursor: the rest without its own `)`.
  assert.deepEqual(c.get(key(`${before}(`, ");\n"), 1), { text: "a, b", typed: 1 });
  assert.deepEqual(c.get(key(`${before}(a`, ");\n"), 1), { text: ", b", typed: 2 });
  // Not closers, or a rest that doesn't end with them: ask.
  assert.equal(c.get(key(`${before}(`, "x;\n"), 1), undefined);
  const q = new GhostTextCache();
  q.put(key("print(", ")\n"), '"hi" + name)', 0);
  assert.equal(q.get(key('print("', '")\n'), 1), undefined);
});

test("ghost text: peek finds a suggestion without counting it (m7.12)", () => {
  const c = new GhostTextCache();
  const before = "const a = ";
  c.put(key(before), "1;", 0);
  assert.deepEqual(c.peek(key(before), 1), { text: "1;", typed: 0 });
  assert.equal(c.peek(key("other"), 1), undefined);
  assert.equal(c.hits, 0);
  assert.equal(c.misses, 0);
});

test("ghost text: deletions, undo and redo ask the provider again; typing doesn't (m7.12)", () => {
  assert.equal(editMayReturnToSuggestion([{ rangeLength: 1, text: "" }], false), true);
  assert.equal(
    editMayReturnToSuggestion(
      [
        { rangeLength: 4, text: "" },
        { rangeLength: 2, text: "" },
      ],
      false,
    ),
    true,
  );
  assert.equal(editMayReturnToSuggestion([{ rangeLength: 0, text: "x" }], false), false);
  assert.equal(editMayReturnToSuggestion([{ rangeLength: 1, text: "y" }], false), false);
  assert.equal(editMayReturnToSuggestion([{ rangeLength: 0, text: "x" }], true), true);
  assert.equal(editMayReturnToSuggestion([], false), false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { ConsoleHistory } from "./consoleHistory";

test("each console walks its own history", () => {
  const h = new ConsoleHistory();
  h.add("server", "req.url");
  h.add("server", "res.statusCode");
  h.add("client", "window.location");
  assert.equal(h.move("server", -1, ""), "res.statusCode");
  assert.equal(h.move("server", -1, ""), "req.url");
  // At the oldest: nothing further up.
  assert.equal(h.move("server", -1, ""), null);
  assert.equal(h.move("client", -1, ""), "window.location");
  assert.equal(h.move("other", -1, ""), null);
  assert.deepEqual(h.entries("server"), ["req.url", "res.statusCode"]);
});

test("Down past the newest brings back the line being typed", () => {
  const h = new ConsoleHistory();
  h.add("a", "one");
  h.add("a", "two");
  assert.equal(h.move("a", 1, "draft"), null);
  assert.equal(h.move("a", -1, "dra"), "two");
  assert.equal(h.move("a", -1, "two"), "one");
  assert.equal(h.move("a", 1, "one"), "two");
  assert.equal(h.move("a", 1, "two"), "dra");
  assert.equal(h.move("a", 1, "dra"), null);
});

test("running an expression resets the walk; repeats aren't added twice", () => {
  const h = new ConsoleHistory();
  h.add("a", "x");
  h.add("a", "x");
  h.add("a", "y");
  assert.equal(h.move("a", -1, ""), "y");
  h.add("a", "x");
  assert.deepEqual(h.entries("a"), ["x", "y", "x"]);
  assert.equal(h.move("a", -1, ""), "x");
  // Empty input isn't kept.
  h.add("a", "");
  assert.equal(h.entries("a").length, 3);
});

test("histories are capped", () => {
  const h = new ConsoleHistory();
  for (let i = 0; i < 150; i++) h.add("a", `e${i}`);
  assert.equal(h.entries("a").length, 100);
  assert.equal(h.entries("a")[0], "e50");
  for (let i = 0; i < 60; i++) h.add(`c${i}`, "x");
  // The least recently used consoles go first.
  assert.equal(h.entries("a").length, 0);
  assert.equal(h.entries("c59").length, 1);
});

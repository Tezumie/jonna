import assert from "node:assert/strict";
import { test } from "node:test";
import { findMatches, nextMatch, TYPE_AHEAD_MS, TypeAhead, typeAheadIndex } from "./treeFind";

test("type-ahead: a prefix, refined, repeated letters cycle", () => {
  const labels = ["apps", "docs", "scripts", "src", "Settings.json", "README.md"];
  assert.equal(typeAheadIndex(labels, -1, "s"), 2);
  // Typed on: "sr" stays from the current row and finds src.
  assert.equal(typeAheadIndex(labels, 2, "sr"), 3);
  // "s" again from src: the next one starting with s.
  assert.equal(typeAheadIndex(labels, 3, "ss"), 4);
  // Wraps around.
  assert.equal(typeAheadIndex(labels, 4, "a"), 0);
  assert.equal(typeAheadIndex(labels, 0, "R"), 5);
  assert.equal(typeAheadIndex(labels, 0, "zz"), -1);
  const t = new TypeAhead();
  assert.equal(t.push("s", 1000), "s");
  assert.equal(t.push("r", 1100), "sr");
  assert.equal(t.push("d", 1100 + TYPE_AHEAD_MS + 1), "d");
});

test("find: substring matches, next and previous wrap", () => {
  const labels = ["index.ts", "view.ts", "README.md", "viewer.css"];
  assert.equal(findMatches("View.ts", "view"), true);
  assert.equal(findMatches("x", ""), false);
  assert.equal(nextMatch(labels, 1, "view"), 3);
  assert.equal(nextMatch(labels, 3, "view"), 1);
  assert.equal(nextMatch(labels, 1, "view", true), 3);
  assert.equal(nextMatch(labels, 0, "nope"), -1);
});

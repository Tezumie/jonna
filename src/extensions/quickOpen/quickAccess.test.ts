import assert from "node:assert/strict";
import { test } from "node:test";
import { groupByKind, parseAccess, parseLine } from "./quickAccess";

test("quick access: word prefixes and @:", () => {
  assert.deepEqual(parseAccess("view expl"), { mode: "views", query: "expl" });
  assert.deepEqual(parseAccess("task build"), { mode: "tasks", query: "build" });
  assert.deepEqual(parseAccess("debug "), { mode: "debug", query: "" });
  assert.deepEqual(parseAccess("term 2"), { mode: "terminals", query: "2" });
  assert.deepEqual(parseAccess("edt main"), { mode: "editors", query: "main" });
  assert.deepEqual(parseAccess("%todo later"), { mode: "text", query: "todo later" });
  assert.deepEqual(parseAccess("@:ren"), { mode: "symbols", query: "ren", byKind: true });
  // Without the space it's a file name.
  assert.deepEqual(parseAccess("views.ts"), { mode: "files", query: "views.ts" });
  assert.deepEqual(parseAccess("task"), { mode: "files", query: "task" });
});

test("quick access: symbols grouped by kind", () => {
  const grouped = groupByKind([
    { name: "a", kind: "function" },
    { name: "B", kind: "class" },
    { name: "c", kind: "variable" },
    { name: "d", kind: "function" },
    { name: "e", kind: "widget" },
  ]);
  assert.deepEqual(
    grouped.map((s) => [s.name, s.separator]),
    [
      ["B", "classes (1)"],
      ["a", "functions (2)"],
      ["d", undefined],
      ["c", "variables (1)"],
      ["e", "widget (1)"],
    ],
  );
});

test("quick access: the first character picks the mode", () => {
  assert.deepEqual(parseAccess("main.ts"), { mode: "files", query: "main.ts" });
  assert.deepEqual(parseAccess(">  toggle"), { mode: "commands", query: "toggle" });
  assert.deepEqual(parseAccess("@render"), { mode: "symbols", query: "render" });
  assert.deepEqual(parseAccess(":12"), { mode: "line", query: "12" });
  assert.deepEqual(parseAccess("?"), { mode: "help", query: "" });
  assert.deepEqual(parseAccess("# dock"), { mode: "workspaceSymbols", query: "dock" });
  assert.deepEqual(parseAccess(""), { mode: "files", query: "" });
});

test("quick access: line and column", () => {
  assert.deepEqual(parseLine("12"), { line: 12 });
  assert.deepEqual(parseLine("12:5"), { line: 12, column: 5 });
  assert.deepEqual(parseLine("12,5"), { line: 12, column: 5 });
  assert.equal(parseLine("x"), null);
  assert.equal(parseLine("0"), null);
});

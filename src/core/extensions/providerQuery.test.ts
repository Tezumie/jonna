import assert from "node:assert/strict";
import { test } from "node:test";
import { checkProviderQuery } from "./providerQuery";

test("a position query keeps its position and drops what it doesn't take", () => {
  assert.deepEqual(
    checkProviderQuery({
      kind: "definition",
      path: "/ws/a.ts",
      line: 3,
      column: 5,
      newName: "x",
      range: { nope: 1 },
    }),
    { kind: "definition", path: "/ws/a.ts", line: 3, column: 5 },
  );
  assert.deepEqual(
    checkProviderQuery({
      kind: "completion",
      path: "/ws/a.ts",
      line: 1,
      column: 1,
      triggerCharacter: ".",
      resolveCount: 3,
    }),
    {
      kind: "completion",
      path: "/ws/a.ts",
      line: 1,
      column: 1,
      triggerCharacter: ".",
      resolveCount: 3,
    },
  );
});

test("wrong queries are refused with the reason", () => {
  assert.throws(() => checkProviderQuery({ kind: "eval", path: "/a" }), /Unknown provider query/);
  assert.throws(() => checkProviderQuery({ kind: "hover", path: "" }), /path/);
  assert.throws(
    () => checkProviderQuery({ kind: "hover", path: "/a", line: 0, column: 1 }),
    /line/,
  );
  assert.throws(
    () => checkProviderQuery({ kind: "hover", path: "/a", line: 1.5, column: 1 }),
    /line/,
  );
  assert.throws(
    () => checkProviderQuery({ kind: "rename", path: "/a", line: 1, column: 1 }),
    /newName/,
  );
  assert.throws(
    () =>
      checkProviderQuery({
        kind: "codeActions",
        path: "/a",
        range: { startLine: 2, startColumn: 1, endLine: 1, endColumn: 1 },
      }),
    /ends before it starts/,
  );
  assert.throws(
    () => checkProviderQuery({ kind: "selectionRanges", path: "/a", positions: "x" }),
    /positions/,
  );
  assert.throws(
    () => checkProviderQuery({ kind: "formatDocument", path: "/a", tabSize: 99 }),
    /tabSize/,
  );
});

test("range, document and selection queries", () => {
  const range = { startLine: 1, startColumn: 1, endLine: 2, endColumn: 4 };
  assert.deepEqual(
    checkProviderQuery({ kind: "codeActions", path: "/a", range, only: "quickfix" }),
    { kind: "codeActions", path: "/a", range, only: "quickfix" },
  );
  assert.deepEqual(
    checkProviderQuery({ kind: "formatDocument", path: "/a", tabSize: 4, insertSpaces: false }),
    { kind: "formatDocument", path: "/a", tabSize: 4, insertSpaces: false },
  );
  assert.deepEqual(
    checkProviderQuery({
      kind: "selectionRanges",
      path: "/a",
      positions: [{ line: 2, column: 3 }],
    }),
    { kind: "selectionRanges", path: "/a", positions: [{ line: 2, column: 3 }] },
  );
});

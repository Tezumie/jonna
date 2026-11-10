import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeEvaluatable,
  normalizeHierarchyCalls,
  normalizeHierarchyItems,
  normalizeLinkedEditing,
  normalizeSelectionRanges,
} from "./extensionProviders";

const resolve = (p: unknown) => {
  if (typeof p !== "string" || p.includes("..")) throw new Error("outside");
  return `/w/${p}`;
};

test("linked editing needs two ranges; a bad word pattern is dropped", () => {
  const two = [
    { startLine: 1, startColumn: 2, endLine: 1, endColumn: 5 },
    { startLine: 3, startColumn: 3, endLine: 3, endColumn: 6 },
  ];
  assert.equal(normalizeLinkedEditing([two[0]]), null);
  assert.deepEqual(normalizeLinkedEditing(two)?.ranges.length, 2);
  assert.equal(
    normalizeLinkedEditing({ ranges: two, wordPattern: "[a-z]+" })?.wordPattern,
    "[a-z]+",
  );
  assert.equal(normalizeLinkedEditing({ ranges: two, wordPattern: "([" })?.wordPattern, undefined);
});

test("selection ranges: VS Code's parent chain or a list, one per position asked", () => {
  const chain = {
    range: { startLine: 2, startColumn: 5, endLine: 2, endColumn: 8 },
    parent: {
      range: { startLine: 1, endLine: 4 },
      parent: { range: { startLine: 1, endLine: 9 } },
    },
  };
  const out = normalizeSelectionRanges(
    [chain, [{ startLine: 7 }, { startLine: 6, endLine: 8 }]],
    1,
  );
  assert.equal(out.length, 1);
  assert.deepEqual(
    out[0]?.map((r) => r.endLine),
    [2, 4, 9],
  );
  assert.equal(normalizeSelectionRanges([chain, [{ startLine: 7 }]], 2)[1]?.length, 1);
});

test("hierarchy items: inside the folder only, a known kind, the extension's data kept", () => {
  const items = normalizeHierarchyItems(
    [
      { name: "run", kind: "method", path: "a.ts", range: { startLine: 3 }, data: { id: 7 } },
      { name: "evil", path: "../x.ts", range: { startLine: 1 } },
      { name: "odd", kind: "gizmo", path: "b.ts", range: { startLine: 2 } },
      { path: "c.ts", range: { startLine: 1 } },
    ],
    resolve,
  );
  assert.deepEqual(
    items.map((i) => [i.name, i.kind, i.path]),
    [
      ["run", "method", "/w/a.ts"],
      ["odd", "function", "/w/b.ts"],
    ],
  );
  assert.deepEqual(items[0]?.data, { id: 7 });
  assert.deepEqual(items[0]?.selectionRange, items[0]?.range);
  const calls = normalizeHierarchyCalls(
    [
      {
        from: { name: "main", path: "m.ts", range: { startLine: 9 } },
        fromRanges: [{ startLine: 10 }],
      },
    ],
    resolve,
    "from",
  );
  assert.equal(calls[0]?.item.name, "main");
  assert.equal(calls[0]?.fromRanges.length, 1);
});

test("an evaluatable expression: a range, and the expression when it isn't the range's text", () => {
  assert.equal(normalizeEvaluatable(null), null);
  assert.deepEqual(
    normalizeEvaluatable({ range: { startLine: 4, startColumn: 2, endColumn: 9 } }),
    {
      range: { startLine: 4, startColumn: 2, endColumn: 9 },
    },
  );
  assert.equal(
    normalizeEvaluatable({ range: { startLine: 4 }, expression: "this.items.length" })?.expression,
    "this.items.length",
  );
});

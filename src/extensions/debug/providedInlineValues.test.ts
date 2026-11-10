// Inline values from an extension's provider (VS Code's InlineValuesProvider). DOM-free.
import assert from "node:assert/strict";
import { test } from "node:test";
import { providedValueLines } from "./providedInlineValues";

test("text as given, variables looked up, expressions evaluated; joined per line", async () => {
  const lines = ["count = 0", "for item in items:", "    total += item"];
  const evaluated: string[] = [];
  const out = await providedValueLines(
    [
      { kind: "expression", range: { startLine: 3, startColumn: 5, endColumn: 10 } },
      { kind: "text", range: { startLine: 1 }, text: "count: 0" },
      {
        kind: "variable",
        range: { startLine: 2, startColumn: 5, endColumn: 9 },
        caseSensitive: true,
      },
      {
        kind: "variable",
        range: { startLine: 2, startColumn: 13, endColumn: 18 },
        name: "ITEMS",
        caseSensitive: false,
      },
      { kind: "variable", range: { startLine: 3 }, name: "missing", caseSensitive: true },
      { kind: "expression", range: { startLine: 3 }, expression: "boom" },
    ],
    {
      lines,
      lookup: (name, caseSensitive) => {
        const vars: Record<string, string> = { item: "3", items: "[1, 2, 3]" };
        const key = caseSensitive ? name : name.toLowerCase();
        return vars[key];
      },
      evaluate: async (expression) => {
        evaluated.push(expression);
        if (expression === "boom") throw new Error("no");
        return "6";
      },
    },
  );
  assert.deepEqual(out, [
    { line: 1, text: "count: 0" },
    { line: 2, text: "item = 3, ITEMS = [1, 2, 3]" },
    { line: 3, text: "total = 6" },
  ]);
  assert.deepEqual(evaluated.sort(), ["boom", "total"]);
});

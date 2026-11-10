import assert from "node:assert/strict";
import { test } from "node:test";
import type { FeatureContext } from "../../workbench/extensionFeatures";
import type { HierarchyItemEntry } from "../../workbench/extensionProviders";
import { extensionSource, fromLspItem, toLspItem, toLspRange } from "./hierarchySource";

const item = (name: string, line: number): HierarchyItemEntry => ({
  name,
  kind: "method",
  path: "/w/src/a.ts",
  range: { startLine: line, startColumn: 3, endLine: line + 2, endColumn: 4 },
  selectionRange: { startLine: line, startColumn: 10, endLine: line, endColumn: 14 },
  data: { mine: name },
});

const at: FeatureContext = {
  path: "/w/src/a.ts",
  languageId: "typescript",
  line: 5,
  column: 12,
  word: "run",
  linePrefix: "  function ru",
};

test("ranges become LSP's 0-based ones; a range without columns keeps its start column", () => {
  assert.deepEqual(toLspRange({ startLine: 5, startColumn: 3, endLine: 7, endColumn: 4 }), {
    start: { line: 4, character: 2 },
    end: { line: 6, character: 3 },
  });
  assert.deepEqual(toLspRange({ startLine: 2 }), {
    start: { line: 1, character: 0 },
    end: { line: 1, character: 0 },
  });
});

test("an extension's item round-trips through the LSP shape the view keeps", () => {
  const lsp = toLspItem(item("run", 5));
  assert.equal(lsp.kind, 6); // LSP's Method
  assert.match(lsp.uri, /^file:\/\/.*a\.ts$/);
  assert.deepEqual(lsp.selectionRange.start, { line: 4, character: 9 });
  assert.deepEqual(fromLspItem(lsp), item("run", 5));
  assert.equal(fromLspItem({ name: "x", data: { other: 1 } }), null);
});

test("the source routes prepare and the children to the extension, with its own items", async () => {
  const asked: string[] = [];
  const source = extensionSource(
    "acme.calls",
    "call",
    {
      prepare: async (c) => {
        asked.push(`prepare ${c.word}`);
        return [item("run", 5)];
      },
      incoming: async (c) => {
        asked.push(`incoming ${c.item.name} ${JSON.stringify(c.item.data)}`);
        return [{ item: item("main", 20), fromRanges: [{ startLine: 21, startColumn: 3 }] }];
      },
      outgoing: async () => [],
    },
    at,
  );
  const roots = await source.request<ReturnType<typeof toLspItem>[]>(
    "textDocument/prepareCallHierarchy",
    {},
  );
  assert.equal(roots[0]?.name, "run");
  const calls = await source.request<{ from: { name: string }; fromRanges: unknown[] }[]>(
    "callHierarchy/incomingCalls",
    { item: roots[0] },
  );
  assert.equal(calls[0]?.from.name, "main");
  assert.deepEqual(calls[0]?.fromRanges, [
    { start: { line: 20, character: 2 }, end: { line: 20, character: 2 } },
  ]);
  assert.deepEqual(asked, ["prepare run", 'incoming run {"mine":"run"}']);
  await assert.rejects(source.request("typeHierarchy/supertypes", { item: roots[0] }));
  await assert.rejects(source.request("callHierarchy/incomingCalls", { item: { name: "x" } }));
});

// D234: the checks on the language providers added for VS Code's rest (highlights, folding,
// links, colors, inline completions, workspace symbols).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  colorHexDigits,
  EDITING_FEATURES,
  normalizeColorPresentations,
  normalizeColors,
  normalizeDocumentLinks,
  normalizeFoldingRanges,
  normalizeHighlights,
  normalizeInlineCompletions,
  normalizeWorkspaceSymbols,
  PROVIDER_FEATURES,
  toColor,
} from "./extensionProviders";

const resolve = (p: unknown) => {
  if (typeof p !== "string" || p.startsWith("..")) throw new Error("outside");
  return `/ws/${p}`;
};
const own = (id: string) => id.startsWith("demo.");

test("the new features are known; only on-type formatting needs fs.write", () => {
  for (const f of ["typeDefinition", "documentLinks", "colors", "inlineCompletions"] as const)
    assert.ok(PROVIDER_FEATURES.includes(f));
  assert.ok(EDITING_FEATURES.includes("onTypeFormatting"));
  assert.ok(!EDITING_FEATURES.includes("inlineCompletions"));
  assert.ok(!EDITING_FEATURES.includes("colors"));
});

test("highlights and folding ranges", () => {
  assert.deepEqual(
    normalizeHighlights([
      { startLine: 2, startColumn: 1, endColumn: 4, kind: "write" },
      { line: 0 },
      { startLine: 5, kind: "bogus" },
    ]),
    [
      { range: { startLine: 2, startColumn: 1, endColumn: 4 }, kind: "write" },
      { range: { startLine: 5 }, kind: "text" },
    ],
  );
  assert.deepEqual(
    normalizeFoldingRanges([
      { startLine: 1, endLine: 4, kind: "region" },
      { startLine: 3, endLine: 3 },
      { start: 5, end: 9, kind: "nope" },
    ]),
    [
      { startLine: 1, endLine: 4, kind: "region" },
      { startLine: 5, endLine: 9 },
    ],
  );
});

test("document links: web addresses or files of the folder, nothing else", () => {
  const links = normalizeDocumentLinks(
    [
      { startLine: 1, target: "https://example.com/x", tooltip: "Docs" },
      { startLine: 2, target: "mailto:a@b.c" },
      { startLine: 3, target: "javascript:alert(1)" },
      { startLine: 4, target: "file:///etc/passwd" },
      { startLine: 5, target: "src/a.ts", line: 3, column: 2 },
      { startLine: 6, target: "../outside.txt" },
      { startLine: 7, target: "command:workbench.action.quit" },
    ],
    resolve,
  );
  assert.deepEqual(
    links.map((l) => l.target),
    [
      { url: "https://example.com/x" },
      { url: "mailto:a@b.c" },
      { path: "/ws/javascript:alert(1)" },
      { path: "/ws/file:///etc/passwd" },
      { path: "/ws/src/a.ts", line: 3, column: 2 },
      { path: "/ws/command:workbench.action.quit" },
    ],
    "non-web targets are only ever folder paths (the host's resolver refuses what's outside)",
  );
  assert.equal(links[0]?.tooltip, "Docs");
});

test("colors: clamped parts, presentations, the hex fallback", () => {
  assert.deepEqual(toColor({ red: 2, green: -1, blue: 0.5 }), {
    red: 1,
    green: 0,
    blue: 0.5,
    alpha: 1,
  });
  assert.equal(toColor({ red: "1" }), null);
  assert.equal(
    normalizeColors([{ startLine: 1, color: { red: 1, green: 0, blue: 0 } }, { startLine: 2 }])
      .length,
    1,
  );
  assert.deepEqual(
    normalizeColorPresentations(["x", { label: "y", edit: { startLine: 1, text: "z" } }, {}]),
    [{ label: "x" }, { label: "y", edit: { startLine: 1, text: "z" } }],
  );
  assert.equal(colorHexDigits({ red: 1, green: 0, blue: 0.5, alpha: 1 }), "ff0080");
  assert.equal(colorHexDigits({ red: 0, green: 0, blue: 0, alpha: 0.5 }), "00000080");
});

test("inline completions: strings, items, { items }; only own commands", () => {
  assert.deepEqual(normalizeInlineCompletions(["abc", { insertText: "" }], own), [
    { insertText: "abc" },
  ]);
  assert.deepEqual(
    normalizeInlineCompletions(
      {
        items: [
          { insertText: "x", range: { startLine: 2, startColumn: 1 }, command: "other.cmd" },
          { text: "y", command: "demo.log", input: 1 },
        ],
      },
      own,
    ),
    [
      { insertText: "x", range: { startLine: 2, startColumn: 1 } },
      { insertText: "y", command: { id: "demo.log", input: 1 } },
    ],
  );
});

test("workspace symbols: in the folder, known kinds", () => {
  assert.deepEqual(
    normalizeWorkspaceSymbols(
      [
        {
          name: "main",
          kind: "function",
          path: "a.ts",
          startLine: 3,
          startColumn: 5,
          containerName: "app",
        },
        { name: "x", kind: "weird", path: "b.ts", line: 1 },
        { name: "y", path: "../c.ts", line: 1 },
        { name: "", path: "d.ts", line: 1 },
      ],
      resolve,
    ),
    [
      { name: "main", kind: "function", path: "/ws/a.ts", line: 3, column: 5, container: "app" },
      { name: "x", kind: "variable", path: "/ws/b.ts", line: 1, column: 1 },
    ],
  );
});

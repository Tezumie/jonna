import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encodeSemanticTokens,
  normalizeCodeActions,
  normalizeCodeLenses,
  normalizeFileEdits,
  normalizeInlayHints,
  normalizeLegend,
  normalizeLocations,
  normalizeRenameLocation,
  normalizeResolvedEdits,
  normalizeSignatureHelp,
  normalizeSymbols,
  normalizeTextEdits,
  resolveRange,
  toTextRange,
} from "./extensionProviders";

const resolve = (p: unknown) => {
  if (typeof p !== "string" || p.startsWith("..")) throw new Error("outside");
  return `/ws/${p}`;
};
const own = (id: string) => id.startsWith("demo.");

test("text ranges: line aliases, bad fields dropped", () => {
  assert.deepEqual(toTextRange({ line: 3, column: 2 }), { startLine: 3, startColumn: 2 });
  assert.deepEqual(toTextRange({ startLine: 2, endLine: 1, endColumn: 0 }), { startLine: 2 });
  assert.equal(toTextRange({ startLine: 0 }), null);
  assert.equal(toTextRange("x"), null);
});

test("locations: one or many, paths outside the folder dropped", () => {
  assert.deepEqual(normalizeLocations({ path: "a.txt", startLine: 4 }, resolve), [
    { path: "/ws/a.txt", startLine: 4 },
  ]);
  assert.deepEqual(
    normalizeLocations(
      [
        { path: "../b", startLine: 1 },
        { path: "c", startLine: 2, startColumn: 3, endColumn: 6 },
        { path: "d" },
      ],
      resolve,
    ),
    [{ path: "/ws/c", startLine: 2, startColumn: 3, endColumn: 6 }],
  );
  assert.deepEqual(normalizeLocations(null, resolve), []);
});

test("edits: text required; file edits default to the document", () => {
  assert.deepEqual(normalizeTextEdits([{ startLine: 1, text: "x" }, { startLine: 2 }]), [
    { startLine: 1, text: "x" },
  ]);
  assert.deepEqual(
    normalizeFileEdits(
      [
        { startLine: 1, text: "a" },
        { path: "o.txt", startLine: 2, text: "b" },
        { path: "../evil", startLine: 1, text: "c" },
      ],
      resolve,
      "/ws/doc.txt",
    ),
    [
      { startLine: 1, text: "a", path: "/ws/doc.txt" },
      { startLine: 2, text: "b", path: "/ws/o.txt" },
    ],
  );
});

test("code actions: only the extension's commands; empty actions dropped", () => {
  const actions = normalizeCodeActions(
    [
      { title: "Fix", kind: "quickfix", isPreferred: true, edits: [{ startLine: 1, text: "y" }] },
      { title: "Run", command: "demo.run", input: { a: 1 } },
      { title: "Steal", command: "fs.delete" },
      { title: "Nothing" },
      { title: "Bad kind", kind: "a b", command: "demo.x" },
    ],
    resolve,
    "/ws/doc.txt",
    own,
  );
  assert.deepEqual(actions, [
    {
      title: "Fix",
      kind: "quickfix",
      isPreferred: true,
      edits: [{ startLine: 1, text: "y", path: "/ws/doc.txt" }],
    },
    { title: "Run", command: { id: "demo.run", input: { a: 1 } } },
    { title: "Bad kind", command: { id: "demo.x" } },
  ]);
});

test("code actions resolved later: kept without edits, resolved edits checked", () => {
  assert.deepEqual(
    normalizeCodeActions(
      [
        { title: "Later", kind: "refactor", resolveId: "a1" },
        { title: "Nothing" },
        { title: "Now", edits: [{ startLine: 1, text: "x" }], resolveId: "a2" },
      ],
      resolve,
      "/ws/doc.txt",
      own,
    ),
    [
      { title: "Later", kind: "refactor", resolveId: "a1" },
      {
        title: "Now",
        edits: [{ startLine: 1, text: "x", path: "/ws/doc.txt" }],
        resolveId: "a2",
      },
    ],
  );
  assert.deepEqual(
    normalizeResolvedEdits(
      {
        title: "Later",
        edits: [
          { startLine: 2, text: "y" },
          { path: "../out", startLine: 1, text: "z" },
        ],
      },
      resolve,
      "/ws/doc.txt",
    ),
    [{ startLine: 2, text: "y", path: "/ws/doc.txt" }],
  );
  assert.deepEqual(normalizeResolvedEdits(null, resolve, "/ws/doc.txt"), []);
  assert.deepEqual(normalizeResolvedEdits({ title: "No edits" }, resolve, "/ws/doc.txt"), []);
});

test("rename locations: a range or { range, placeholder }; nothing means the word", () => {
  assert.deepEqual(normalizeRenameLocation({ startLine: 2, startColumn: 3, endColumn: 7 }), {
    range: { startLine: 2, startColumn: 3, endColumn: 7 },
  });
  assert.deepEqual(
    normalizeRenameLocation({
      range: { startLine: 4, startColumn: 1, endColumn: 2 },
      placeholder: "n",
    }),
    { range: { startLine: 4, startColumn: 1, endColumn: 2 }, placeholder: "n" },
  );
  assert.equal(normalizeRenameLocation(null), null);
  assert.equal(normalizeRenameLocation({ placeholder: "x" }), null);
  assert.equal(normalizeRenameLocation({ range: { startLine: 0 } }), null);
});

test("signature help: labels, offsets, clamped active indexes", () => {
  assert.equal(normalizeSignatureHelp({ signatures: [] }), null);
  assert.deepEqual(
    normalizeSignatureHelp({
      signatures: [
        { label: "f(a, b)", parameters: ["a", { label: [5, 99], documentation: "B" }, {}] },
      ],
      activeSignature: 7,
      activeParameter: -1,
    }),
    {
      signatures: [
        { label: "f(a, b)", parameters: [{ label: "a" }, { label: [5, 7], documentation: "B" }] },
      ],
      activeSignature: 0,
      activeParameter: 0,
    },
  );
});

test("symbols: nested, unknown kinds become variables, selection defaults", () => {
  assert.deepEqual(
    normalizeSymbols([
      {
        name: "Box",
        kind: "class",
        startLine: 1,
        endLine: 9,
        children: [{ name: "open", kind: "nope", range: { startLine: 2 } }, { kind: "x" }],
      },
    ]),
    [
      {
        name: "Box",
        detail: "",
        kind: "class",
        range: { startLine: 1, endLine: 9 },
        selectionRange: { startLine: 1 },
        children: [
          {
            name: "open",
            detail: "",
            kind: "variable",
            range: { startLine: 2 },
            selectionRange: { startLine: 2 },
            children: [],
          },
        ],
      },
    ],
  );
});

test("code lenses and inlay hints", () => {
  assert.deepEqual(
    normalizeCodeLenses(
      [
        { startLine: 3, title: "2 refs", command: "demo.refs" },
        { startLine: 4, title: "x", command: "editor.save" },
        { startLine: 5 },
        // The whole range is kept (flat or as `range`), not just its first line.
        { startLine: 6, startColumn: 3, endLine: 9, endColumn: 2, title: "span" },
        { range: { startLine: 10, startColumn: 1, endLine: 12 }, title: "nested" },
      ],
      own,
    ),
    [
      { range: { startLine: 3 }, title: "2 refs", command: { id: "demo.refs" } },
      { range: { startLine: 4 }, title: "x" },
      { range: { startLine: 6, startColumn: 3, endLine: 9, endColumn: 2 }, title: "span" },
      { range: { startLine: 10, startColumn: 1, endLine: 12 }, title: "nested" },
    ],
  );
  assert.deepEqual(
    normalizeInlayHints([
      { line: 1, column: 5, label: ": number", kind: "type", paddingLeft: true },
      { line: 1, column: 0, label: "x" },
      { line: 2, column: 1, label: "" },
    ]),
    [{ line: 1, column: 5, label: ": number", kind: "type", paddingLeft: true }],
  );
});

test("semantic tokens: legend checked, tokens sorted, relative encoding, overlaps dropped", () => {
  const legend = normalizeLegend({
    tokenTypes: ["keyword", "function", "keyword", "bad name"],
    tokenModifiers: ["declaration", "readonly"],
  });
  assert.deepEqual(legend, {
    tokenTypes: ["keyword", "function"],
    tokenModifiers: ["declaration", "readonly"],
  });
  const data = encodeSemanticTokens(
    [
      { line: 3, column: 5, length: 3, type: "function", modifiers: ["readonly", "declaration"] },
      { line: 1, column: 1, length: 4, type: "keyword" },
      { line: 1, column: 3, length: 2, type: "keyword" },
      { line: 1, column: 10, length: 2, type: "unknown" },
      { line: 3, column: 9, length: 1, type: "keyword" },
    ],
    legend,
  );
  assert.deepEqual(data, [0, 0, 4, 0, 0, 2, 4, 3, 1, 3, 0, 4, 1, 0, 0]);
});

test("ranges resolve against the document: whole lines, clamping", () => {
  const lines = ["alpha", "be", "gamma"];
  const len = (n: number) => lines[n - 1]?.length ?? 0;
  assert.deepEqual(resolveRange({ startLine: 2 }, 3, len), {
    startLine: 2,
    startColumn: 1,
    endLine: 2,
    endColumn: 3,
  });
  assert.deepEqual(resolveRange({ startLine: 1, startColumn: 9, endLine: 7 }, 3, len), {
    startLine: 1,
    startColumn: 6,
    endLine: 3,
    endColumn: 6,
  });
  assert.deepEqual(resolveRange({ startLine: 1, startColumn: 4, endColumn: 2 }, 3, len), {
    startLine: 1,
    startColumn: 4,
    endLine: 1,
    endColumn: 4,
  });
});

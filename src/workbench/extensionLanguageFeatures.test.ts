// VS Code's language features as extensions give them: completions (VS Code's shape kept, no
// 200 cap), inlay hint parts, problems with their hint severity, tags and source, notebook cell
// paths. DOM-free.
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeDiagnostics } from "./extensionDiagnostics";
import {
  cellOfPath,
  MAX_COMPLETIONS,
  normalizeCompletionItem,
  normalizeCompletions,
  normalizeInlayHints,
  normalizeInlineValues,
} from "./extensionProviders";

const own = (id: string) => id.startsWith("demo.");

test("completions: every item (no 200 cap), isIncomplete, ranges, commit characters, commands", () => {
  const many = Array.from({ length: 1500 }, (_, i) => ({ label: `item${i}` }));
  assert.equal(normalizeCompletions(many, own).items.length, 1500);
  assert.equal(
    normalizeCompletions(
      Array.from({ length: MAX_COMPLETIONS + 5 }, () => ({ label: "x" })),
      own,
    ).items.length,
    MAX_COMPLETIONS,
  );
  const list = normalizeCompletions(
    {
      isIncomplete: true,
      items: [
        {
          label: "print",
          labelDetail: "(x)",
          insertText: "print(${1})",
          snippet: true,
          kind: "function",
          range: { startLine: 1, startColumn: 1, endColumn: 3 },
          replaceRange: { startLine: 1, startColumn: 1, endColumn: 6 },
          commitCharacters: ["(", "too long", 3],
          command: "editor.action.triggerParameterHints",
          resolveId: "c1",
          deprecated: true,
        },
        { label: "other", kind: "notAKind", command: "someone.else" },
        { kind: "text" },
      ],
    },
    own,
  );
  assert.equal(list.isIncomplete, true);
  assert.equal(list.items.length, 2);
  const [first, second] = list.items;
  assert.equal(first?.snippet, true);
  assert.equal(first?.labelDetail, "(x)");
  assert.deepEqual(first?.commitCharacters, ["("]);
  assert.deepEqual(first?.command, { id: "editor.action.triggerParameterHints" });
  assert.deepEqual(first?.replaceRange, { startLine: 1, startColumn: 1, endColumn: 6 });
  assert.equal(first?.deprecated, true);
  assert.equal(first?.resolveId, "c1");
  assert.equal(second?.kind, undefined);
  assert.equal(second?.command, undefined);
  // A resolved item may come without a label.
  assert.deepEqual(normalizeCompletionItem({ documentation: "Doc." }, own, true), {
    documentation: "Doc.",
  });
  // A bare list is never incomplete.
  assert.equal(normalizeCompletions([{ label: "a" }], own).isIncomplete, undefined);
});

test("inlay hints: label parts keep places anywhere and own commands; edits; resolve ids", () => {
  const anywhere = (p: unknown) => {
    if (typeof p !== "string" || !p.startsWith("/")) throw new Error("bad");
    return p;
  };
  const [hint, bare] = normalizeInlayHints(
    [
      {
        line: 1,
        column: 8,
        label: [
          { value: ": " },
          {
            value: "int",
            tooltip: "A number.",
            location: { path: "/usr/lib/python3/builtins.pyi", startLine: 10 },
          },
          { value: "!", command: "demo.explain", input: { a: 1 } },
          { value: "?", command: "other.run" },
        ],
        textEdits: [{ startLine: 1, startColumn: 8, text: ": int" }],
        resolveId: "h1",
      },
      { line: 2, column: 1, label: "x" },
      { line: 3, column: 1, label: [] },
    ],
    anywhere,
    own,
  );
  assert.deepEqual(hint?.label, [
    { value: ": " },
    {
      value: "int",
      tooltip: "A number.",
      location: { startLine: 10, path: "/usr/lib/python3/builtins.pyi" },
    },
    { value: "!", command: { id: "demo.explain", input: { a: 1 } } },
    { value: "?" },
  ]);
  assert.deepEqual(hint?.textEdits, [{ startLine: 1, startColumn: 8, text: ": int" }]);
  assert.equal(hint?.resolveId, "h1");
  assert.equal(bare?.label, "x");
});

test("inline values: text, variable lookups and expressions", () => {
  assert.deepEqual(
    normalizeInlineValues([
      { kind: "text", range: { startLine: 1 }, text: "x = 1" },
      { kind: "variable", range: { startLine: 2 }, name: "y", caseSensitive: false },
      { kind: "expression", range: { startLine: 3, startColumn: 1, endColumn: 4 } },
      { kind: "text", range: { startLine: 4 } },
      { kind: "other", range: { startLine: 5 } },
    ]),
    [
      { kind: "text", range: { startLine: 1 }, text: "x = 1" },
      { kind: "variable", range: { startLine: 2 }, name: "y", caseSensitive: false },
      { kind: "expression", range: { startLine: 3, startColumn: 1, endColumn: 4 } },
    ],
  );
});

test("problems keep Hint, tags, their own source, a code's web page and related places", () => {
  const resolve = (p: unknown) => {
    if (typeof p !== "string" || !p.startsWith("/")) throw new Error("bad");
    return p;
  };
  const [hint, plain, error] = normalizeDiagnostics(
    [
      {
        line: 1,
        column: 8,
        endColumn: 10,
        message: '"os" is not accessed',
        severity: "hint",
        source: "Pylance",
        code: "reportUnusedImport",
        codeTarget: "https://example.com/rules",
        tags: ["unnecessary", "unnecessary", "bold"],
        relatedInformation: [
          { path: "/ws/b.py", startLine: 3, startColumn: 1, message: "Defined here" },
          { path: "relative", startLine: 1, message: "dropped" },
        ],
      },
      { line: 2, message: "plain", severity: "weird" },
      { line: 3, message: "bad", severity: "error", code: "E1", codeTarget: "javascript:alert(1)" },
      { line: 0, message: "no line" },
    ],
    "/ws/a.py",
    "Python",
    resolve,
  );
  assert.equal(hint?.severity, "hint");
  assert.equal(hint?.source, "Pylance");
  assert.equal(hint?.message, '"os" is not accessed');
  assert.deepEqual(hint?.tags, ["unnecessary"]);
  assert.equal(hint?.codeTarget, "https://example.com/rules");
  assert.deepEqual(hint?.related, [
    { path: "/ws/b.py", message: "Defined here", line: 3, column: 1, endLine: 3, endColumn: 2 },
  ]);
  // No source of its own: the extension's name; an unknown severity is info.
  assert.equal(plain?.source, "Python");
  assert.equal(plain?.severity, "info");
  // Only web pages are links.
  assert.equal(error?.codeTarget, undefined);
});

test("a notebook cell's editor path names its notebook and cell", () => {
  assert.deepEqual(cellOfPath("C:\\w\\nb.ipynb.cell-a1_B-2.py"), {
    notebook: "C:\\w\\nb.ipynb",
    id: "a1_B-2",
  });
  assert.equal(cellOfPath("/w/main.py"), null);
});

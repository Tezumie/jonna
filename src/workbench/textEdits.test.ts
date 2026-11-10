import assert from "node:assert/strict";
import { test } from "node:test";
import { applyRangeEdit } from "./extensionFeatures";
import { applyTextEdits, lineCount, planWorkspaceEdit, rangeOffsets } from "./textEdits";

test("rangeOffsets: columns, whole lines, clamped, CRLF", () => {
  const text = "ab\ncde\nf";
  assert.deepEqual(rangeOffsets(text, { startLine: 2, startColumn: 2, endColumn: 4 }), [4, 6]);
  assert.deepEqual(rangeOffsets(text, { startLine: 1, endLine: 2 }), [0, 6]);
  assert.deepEqual(rangeOffsets(text, { startLine: 9, startColumn: 9, endColumn: 9 }), [8, 8]);
  assert.deepEqual(rangeOffsets("a\r\nb", { startLine: 1, startColumn: 1, endColumn: 9 }), [0, 1]);
});

test("applyTextEdits: against the original text, in any order; same as one replace", () => {
  const text = "let a = 1;\nlet b = 2;\n";
  const out = applyTextEdits(text, [
    { startLine: 2, startColumn: 5, endColumn: 6, text: "bee" },
    { startLine: 1, startColumn: 5, endColumn: 6, text: "ay" },
    { startLine: 3, startColumn: 1, text: "// end\n" },
  ]);
  assert.equal(out, "let ay = 1;\nlet bee = 2;\n// end\n");
  const one = { startLine: 1, startColumn: 1, endLine: 2, endColumn: 4, text: "x" };
  assert.equal(applyTextEdits(text, [one]), applyRangeEdit(text, one, "x"));
  // Two insertions at one place keep their order.
  assert.equal(
    applyTextEdits("ab", [
      { startLine: 1, startColumn: 2, endColumn: 2, text: "1" },
      { startLine: 1, startColumn: 2, endColumn: 2, text: "2" },
    ]),
    "a12b",
  );
});

test("applyTextEdits: overlapping edits are refused", () => {
  assert.throws(
    () =>
      applyTextEdits("abcdef", [
        { startLine: 1, startColumn: 1, endColumn: 4, text: "x" },
        { startLine: 1, startColumn: 3, endColumn: 5, text: "y" },
      ]),
    /overlap/,
  );
});

test("lineCount", () => {
  assert.equal(lineCount(""), 1);
  assert.equal(lineCount("a\nb\n"), 3);
});

test("planWorkspaceEdit: in order, a file's consecutive text edits as one step, paths checked", () => {
  const resolve = (p: unknown) => {
    if (typeof p !== "string" || p.startsWith("..")) throw new Error(`${String(p)} is outside`);
    return `/ws/${p}`;
  };
  const steps = planWorkspaceEdit(
    [
      { kind: "text", path: "a.ts", startLine: 1, startColumn: 1, endColumn: 2, text: "x" },
      { kind: "text", path: "a.ts", startLine: 2, text: "y" },
      { kind: "create", path: "b.ts", contents: "hi", ignoreIfExists: true },
      { kind: "text", path: "a.ts", startLine: 3, text: "z" },
      { kind: "rename", from: "b.ts", to: "c.ts" },
      { kind: "delete", path: "d", recursive: true },
    ],
    resolve,
  );
  assert.deepEqual(
    steps.map((s) => s.kind),
    ["text", "create", "text", "rename", "delete"],
  );
  const first = steps[0];
  assert.ok(first?.kind === "text" && first.edits.length === 2 && first.path === "/ws/a.ts");
  assert.deepEqual(steps[1], {
    kind: "create",
    path: "/ws/b.ts",
    contents: "hi",
    overwrite: false,
    ignoreIfExists: true,
  });
  assert.throws(() => planWorkspaceEdit([{ kind: "delete", path: "../x" }], resolve), /outside/);
  assert.throws(
    () => planWorkspaceEdit([{ kind: "text", path: "a", text: "x" }], resolve),
    /startLine/,
  );
  assert.throws(() => planWorkspaceEdit([{ kind: "format" }], resolve), /Unknown/);
  assert.deepEqual(planWorkspaceEdit("nope", resolve), []);
});

test("D261: a range past the last line ends at the end of the text", () => {
  // VS Code's Range(0, 0, doc.lineCount, 0): 1-based, one line past the end.
  assert.equal(
    applyTextEdits("a\nb", [{ startLine: 1, startColumn: 1, endLine: 3, endColumn: 1, text: "X" }]),
    "X",
  );
  assert.equal(
    applyTextEdits("a\nb", [{ startLine: 9, startColumn: 1, endLine: 9, endColumn: 1, text: "!" }]),
    "a\nb!",
  );
});

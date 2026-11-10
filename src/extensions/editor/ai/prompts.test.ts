import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanCompletion, cleanEdit, editPrompt } from "./prompts";

test("editPrompt marks the selected lines", () => {
  const p = editPrompt({
    path: "a.ts",
    languageId: "typescript",
    text: "one\ntwo\nthree\nfour",
    startLine: 2,
    endLine: 3,
    instruction: "uppercase",
  });
  assert.match(p, /one\n<selection>\ntwo\nthree\n<\/selection>\nfour/);
  assert.match(p, /Instruction: uppercase/);
});

test("cleanEdit strips fences, tags and thinking", () => {
  assert.equal(cleanEdit("```ts\nconst a = 1;\n```", "let a = 1;"), "const a = 1;");
  assert.equal(cleanEdit("Here you go:\n```\nx\n```\nDone", "y"), "x");
  assert.equal(cleanEdit("<think>hmm</think><selection>\nx\n</selection>", "y"), "x");
  assert.equal(cleanEdit("x\n\n", "y\n"), "x\n");
});

test("cleanCompletion drops repeats of the line start and of what follows", () => {
  assert.equal(cleanCompletion("const total = add(a, b);", "  const total = ", ";\n"), "add(a, b)");
  assert.equal(cleanCompletion("```js\nreturn x;\n```", "function f() {\n  ", "\n}"), "return x;");
  assert.equal(cleanCompletion("   ", "a", "b"), null);
  assert.equal(cleanCompletion(")", "f(", ")"), null);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { applySaveTransforms, codeActionsOnSave } from "./settings";

const both = { trimTrailingWhitespace: true, insertFinalNewline: true };

test("trims trailing whitespace on every line and keeps CRLF", () => {
  assert.equal(applySaveTransforms("a  \r\nb\t\r\nc ", "\r\n", both), "a\r\nb\r\nc\r\n");
});

test("leaves text alone when both options are off", () => {
  const off = { trimTrailingWhitespace: false, insertFinalNewline: false };
  assert.equal(applySaveTransforms("a  \nb", "\n", off), "a  \nb");
});

test("doesn't add a newline to an empty file or one that already ends with one", () => {
  assert.equal(applySaveTransforms("", "\n", both), "");
  assert.equal(applySaveTransforms("x\n", "\n", both), "x\n");
});

test("an auto save leaves the cursor lines alone", () => {
  const keep = new Set([2]);
  assert.equal(applySaveTransforms("a  \r\nb \r\nc ", "\r\n", both, keep), "a\r\nb \r\nc\r\n");
  // The cursor on the last line: no final newline yet.
  assert.equal(applySaveTransforms("a \nb ", "\n", both, new Set([2])), "a\nb ");
});

test("editor.codeActionsOnSave: modes and the list form (D200)", () => {
  const v = {
    "source.organizeImports": "explicit",
    "source.fixAll": "always",
    "source.fixAll.eslint": true,
    quickfix: "always",
  };
  assert.deepEqual(codeActionsOnSave(v, true), [
    "source.organizeImports",
    "source.fixAll",
    "source.fixAll.eslint",
  ]);
  assert.deepEqual(codeActionsOnSave(v, false), ["source.fixAll", "source.fixAll.eslint"]);
  assert.deepEqual(codeActionsOnSave({ "source.fixAll": "never" }, true), []);
  assert.deepEqual(codeActionsOnSave({ "source.fixAll": false }, true), []);
  assert.deepEqual(codeActionsOnSave(["source.organizeImports"], true), ["source.organizeImports"]);
  assert.deepEqual(codeActionsOnSave(["source.organizeImports"], false), []);
  assert.deepEqual(codeActionsOnSave(undefined, true), []);
});

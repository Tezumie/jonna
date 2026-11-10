import assert from "node:assert/strict";
import { test } from "node:test";
import { folderLayerValue } from "./folderScope";

test("a folder layer's value, plain or in a language block", () => {
  const layer = { "editor.tabSize": 2, "[python]": { "editor.tabSize": 4 }, "[go]": "bad" };
  assert.equal(folderLayerValue(layer, "editor.tabSize"), 2);
  assert.equal(folderLayerValue(layer, "editor.tabSize", "python"), 4);
  assert.equal(folderLayerValue(layer, "editor.tabSize", "rust"), undefined);
  assert.equal(folderLayerValue(layer, "editor.tabSize", "go"), undefined);
  assert.equal(folderLayerValue({}, "editor.wordWrap"), undefined);
});

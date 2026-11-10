import assert from "node:assert/strict";
import { test } from "node:test";
import { presentInOrder } from "./workspaceFolder";

test("presentInOrder: the folders that exist, the IDE's own first, then aliases in order (D189)", () => {
  const names = [".jonna", ".vscode", ".codevre"];
  assert.deepEqual(presentInOrder(new Set(), names), []);
  assert.deepEqual(presentInOrder(new Set([".vscode"]), names), [".vscode"]);
  assert.deepEqual(presentInOrder(new Set([".codevre", ".vscode", ".jonna"]), names), [
    ".jonna",
    ".vscode",
    ".codevre",
  ]);
  assert.deepEqual(presentInOrder(new Set([".git", ".codevre"]), names), [".codevre"]);
});

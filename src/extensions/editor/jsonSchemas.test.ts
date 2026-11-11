import assert from "node:assert/strict";
import { test } from "node:test";
import { fileMatchPattern } from "./jsonSchemas";

test("jsonValidation's fileMatch as a pattern over file URIs (D419)", () => {
  assert.equal(fileMatchPattern("*.scene.json"), "**/*.scene.json");
  assert.equal(fileMatchPattern("package.json"), "**/package.json");
  assert.equal(fileMatchPattern("/.toolrc"), "**/.toolrc");
  assert.equal(fileMatchPattern("**/conf/*.json"), "**/conf/*.json");
  assert.equal(fileMatchPattern("conf/*.json"), "**/conf/*.json");
  assert.equal(fileMatchPattern("!*.min.json"), "!**/*.min.json");
});

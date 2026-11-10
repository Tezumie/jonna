import assert from "node:assert/strict";
import { test } from "node:test";
import { fileIconTint } from "./fileTint";

test("file tints by extension and well-known names", () => {
  assert.equal(fileIconTint("main.TS"), "ts");
  assert.equal(fileIconTint("Cargo.toml"), "config");
  assert.equal(fileIconTint("Dockerfile"), "config");
  assert.equal(fileIconTint("notes"), "default");
});

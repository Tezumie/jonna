import assert from "node:assert/strict";
import { test } from "node:test";
import { engineSatisfied } from "./engine";

test("engineSatisfied: VS Code's engines.vscode ranges against the shim's version", () => {
  assert.equal(engineSatisfied("*", "1.106.0"), true);
  assert.equal(engineSatisfied(undefined, "1.106.0"), true);
  assert.equal(engineSatisfied("^1.80.0", "1.106.0"), true);
  assert.equal(engineSatisfied("^1.106.0", "1.106.0"), true);
  assert.equal(engineSatisfied("^1.110.0-20260204", "1.106.0"), false);
  assert.equal(engineSatisfied(">=1.107.0", "1.106.0"), false);
  assert.equal(engineSatisfied("^2.0.0", "1.106.0"), false);
  assert.equal(engineSatisfied("1.90.x", "1.106.0"), true);
  assert.equal(engineSatisfied("nonsense", "1.106.0"), true);
});

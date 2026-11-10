import assert from "node:assert/strict";
import { test } from "node:test";
import { kernelSourceId } from "./notebooks";

test("a controller's kernel source id is short and valid; notebook types don't collide", () => {
  // Jupyter's ids hold an interpreter's path (the IDE's kernel sources allow [A-Za-z0-9._-]{1,64}).
  const jupyter =
    ".jvsc74a57bd0" +
    "a".repeat(64) +
    ".c:Python311python.exe.c:Python311python.exe.-m#ipykernel_launcher";
  const nb = kernelSourceId(jupyter, "jupyter-notebook");
  const iw = kernelSourceId(jupyter, "interactive");
  assert.match(nb, /^[A-Za-z0-9._-]{1,64}$/);
  assert.notEqual(nb, iw);
  assert.equal(nb, kernelSourceId(jupyter, "jupyter-notebook"));
  assert.notEqual(nb, kernelSourceId(`${jupyter}x`, "jupyter-notebook"));
});

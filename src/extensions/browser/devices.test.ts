import assert from "node:assert/strict";
import { test } from "node:test";
import { viewportFor } from "./devices";

test("device sizes", () => {
  assert.deepEqual(viewportFor({ device: "iPhone SE" }), {
    width: 375,
    height: 667,
    device: "iphone-se",
  });
  assert.deepEqual(viewportFor({ device: "ipad-air", landscape: true }), {
    width: 1180,
    height: 820,
    device: "ipad-air",
  });
  assert.deepEqual(viewportFor({ width: 500 }), { width: 500, height: 800, device: null });
  assert.deepEqual(viewportFor({ device: "responsive" }), {
    width: null,
    height: null,
    device: null,
  });
  assert.throws(() => viewportFor({ device: "toaster" }));
});

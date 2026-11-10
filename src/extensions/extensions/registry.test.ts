// D258: the registry keeps workspace-only disables and each extension's Auto update choice.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRegistry } from "./registry";

test("workspace disables and auto update choices are read, junk dropped", () => {
  const r = parseRegistry(
    JSON.stringify({
      disabled: ["a.b"],
      disabledIn: { "C:\\work": ["c.d", 3], "/empty": [] },
      autoUpdate: { "e.f": true, "g.h": "yes" },
    }),
  );
  assert.deepEqual(r.disabled, ["a.b"]);
  assert.deepEqual(r.disabledIn, { "C:\\work": ["c.d"] });
  assert.deepEqual(r.autoUpdate, { "e.f": true });
  assert.deepEqual(parseRegistry("{").disabledIn, {});
});

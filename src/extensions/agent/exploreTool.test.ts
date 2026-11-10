import assert from "node:assert/strict";
import { test } from "node:test";
import { exploreResult } from "./exploreTool";

test("exploreResult: the report, capped; what was looked at when there's none", () => {
  assert.equal(
    exploreResult("  Auth is checked in src/mw.ts:12  ", []),
    "Auth is checked in src/mw.ts:12",
  );
  assert.ok(exploreResult("x".repeat(5000), []).endsWith("… (cut)"));
  assert.match(
    exploreResult("", ["read_file src/a.ts", "search auth"]),
    /ran out of steps[\s\S]*- search auth/,
  );
  assert.equal(exploreResult("", []), "The explorer found nothing to report.");
});

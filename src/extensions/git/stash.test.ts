import assert from "node:assert/strict";
import { test } from "node:test";
import { stashLabel } from "./stash";

test("stashLabel: drops git's branch prefix and adds the age", () => {
  const now = 1_000_000;
  assert.equal(
    stashLabel({ index: 0, message: "On main: wip parser", time: now - 120 }, now),
    "wip parser · 2 minutes ago",
  );
  assert.equal(
    stashLabel({ index: 1, message: "WIP on main: abc123 subject", time: now - 3 * 86400 }, now),
    "abc123 subject · 3 days ago",
  );
});

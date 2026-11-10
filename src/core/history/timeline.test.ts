import assert from "node:assert/strict";
import { test } from "node:test";
import { groupTimeline, mergeTimeline } from "./timeline";

test("local versions and commits merge newest first and group by day", () => {
  const now = new Date(2026, 9, 24, 12, 0);
  const t = (daysAgo: number, h = 10) => new Date(2026, 9, 24 - daysAgo, h).getTime();
  const items = mergeTimeline(
    [
      { id: "a", timestamp: t(0), source: "save" },
      { id: "b", timestamp: t(1), source: "agent" },
    ],
    [
      { hash: "c1", author: "Me", time: t(0) / 1000, subject: "Fix" },
      { hash: "c2", author: "Me", time: t(40) / 1000, subject: "Start" },
    ],
  );
  assert.deepEqual(
    items.map((i) => i.id),
    ["a", "c1", "b", "c2"],
  );
  const groups = groupTimeline(items, now);
  assert.deepEqual(
    groups.map((g) => [g.label, g.items.length]),
    [
      ["Today", 2],
      ["Yesterday", 1],
      ["September 2026", 1],
    ],
  );
});

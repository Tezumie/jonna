import assert from "node:assert/strict";
import { test } from "node:test";
import { fuzzyFilter, fuzzyMatch } from "./fuzzy";

test("matches in order, case-insensitively, and reports positions", () => {
  assert.deepEqual(fuzzyMatch("tt", "Toggle Terminal")?.positions, [0, 7]);
  assert.equal(fuzzyMatch("xyz", "Toggle Terminal"), null);
  assert.equal(fuzzyMatch("lat", "Toggle Terminal"), null, "order matters");
  assert.deepEqual(fuzzyMatch("", "anything"), { score: 0, positions: [] });
});

test("word starts and consecutive runs rank higher", () => {
  const items = [
    "View: Toggle Panel",
    "File: Open Folder…",
    "Terminal: Create New Terminal",
    "Editor: Save",
  ];
  const top = (q: string) => fuzzyFilter(q, items, (s) => s)[0]?.item;
  assert.equal(top("save"), "Editor: Save");
  assert.equal(top("open f"), "File: Open Folder…");
  assert.equal(top("tp"), "View: Toggle Panel");
  assert.equal(top("term"), "Terminal: Create New Terminal");
});

test("camelCase boundaries count as word starts", () => {
  const a = fuzzyMatch("of", "workspace.openFolder");
  const b = fuzzyMatch("of", "workspace.profile");
  assert.ok(a && b && a.score > b.score);
});

test("finds a match even when greedy word starts would skip it", () => {
  assert.ok(fuzzyMatch("startup", "Help: Show startup timings"));
  assert.ok(fuzzyMatch("startup timings", "Help: Show startup timings"));
  const m = fuzzyMatch("startup", "Help: Show startup timings");
  assert.deepEqual(m?.positions, [11, 12, 13, 14, 15, 16, 17]);
  // Word-start matching still wins where it fits.
  assert.deepEqual(fuzzyMatch("ts", "Toggle sidebar")?.positions, [0, 7]);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readHiddenItems,
  type StatusEntry,
  statusMenuEntries,
  withItemHidden,
} from "./statusItems";

const entry = (
  id: string,
  alignment: "left" | "right",
  priority: number,
  extra: Partial<StatusEntry> = {},
): StatusEntry => ({ id, alignment, priority, name: id.toUpperCase(), ...extra });

test("statusMenuEntries: the bar's order, left from the edge in, then right towards the edge", () => {
  const list = statusMenuEntries([
    entry("cursor", "right", 100),
    entry("branch", "left", 90),
    entry("folder", "left", 100),
    entry("language", "right", 60),
    entry("problems", "left", 80),
    entry("notifications", "right", 1000),
  ]);
  assert.deepEqual(
    list.map((e) => e.id),
    ["folder", "branch", "problems", "language", "cursor", "notifications"],
  );
  assert.equal(list[0]?.label, "FOLDER");
});

test("statusMenuEntries: one row per id, not hideable items left out, a nameless item by id", () => {
  const list = statusMenuEntries([
    entry("download", "left", 10, { showing: false }),
    entry("download", "left", 10),
    entry("chord", "left", 50, { hideable: false }),
    entry("ext:acme.tool:x", "right", 5, { name: "  " }),
  ]);
  assert.deepEqual(list, [
    { id: "download", label: "DOWNLOAD", alignment: "left", showing: true },
    { id: "ext:acme.tool:x", label: "ext:acme.tool:x", alignment: "right", showing: true },
  ]);
});

test("statusMenuEntries: the menu lists what's on the bar and what the user hid", () => {
  const entries = [
    entry("branch", "left", 90),
    entry("progress", "left", 50, { showing: false }),
    entry("live", "right", 30, { showing: false }),
    entry("cursor", "right", 100, { showing: false }),
  ];
  // Hidden by the user (so it shows nothing): still listed, to bring it back.
  assert.deepEqual(
    statusMenuEntries(entries, new Set(["cursor"])).map((e) => e.id),
    ["branch", "cursor"],
  );
  // Without a hidden set (ide://statusbar): everything.
  assert.equal(statusMenuEntries(entries).length, 4);
});

test("statusMenuEntries: equal priorities keep their registration order", () => {
  const list = statusMenuEntries([
    entry("a", "right", 5),
    entry("b", "right", 5),
    entry("c", "left", 5),
    entry("d", "left", 5),
  ]);
  assert.deepEqual(
    list.map((e) => e.id),
    ["c", "d", "a", "b"],
  );
});

test("readHiddenItems: strings only", () => {
  assert.deepEqual([...readHiddenItems(["a", 3, "", null, "b"])], ["a", "b"]);
  assert.equal(readHiddenItems("a").size, 0);
  assert.equal(readHiddenItems(undefined).size, 0);
});

test("withItemHidden: hides, shows, never duplicates, shows all", () => {
  assert.deepEqual(withItemHidden(["a"], "b", true), ["a", "b"]);
  assert.deepEqual(withItemHidden(["a", "b"], "b", true), ["a", "b"]);
  assert.deepEqual(withItemHidden(["a", "b"], "a", false), ["b"]);
  assert.deepEqual(withItemHidden(["a"], "zzz", false), ["a"]);
  assert.deepEqual(withItemHidden(["a", "b"], null, false), []);
});

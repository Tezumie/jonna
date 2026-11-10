import assert from "node:assert/strict";
import { test } from "node:test";
import { dropIndex, type LimitTab, type TabLimit, tabsOverLimit } from "./tabs";
import { addTab, setTabPinned } from "./tree";
import type { GroupNode } from "./types";

const limit = (value: number, more: Partial<TabLimit> = {}): TabLimit => ({
  enabled: true,
  value,
  perEditorGroup: false,
  excludeDirty: false,
  ...more,
});
const tab = (id: string, more: Partial<LimitTab> = {}): LimitTab => ({
  id,
  groupId: "g1",
  pinned: false,
  dirty: false,
  ...more,
});

test("the limit closes the least recently used tabs, never the new, pinned or dirty ones", () => {
  const tabs = [
    tab("a"),
    tab("b", { pinned: true }),
    tab("c", { dirty: true }),
    tab("d"),
    tab("e"),
  ];
  // e just opened; d used most recently before it; a never shown.
  assert.deepEqual(tabsOverLimit(tabs, ["e", "d", "b", "c"], limit(3), "e"), ["a", "d"]);
  assert.deepEqual(tabsOverLimit(tabs, [], { ...limit(3), enabled: false }, "e"), []);
  // Unsaved tabs don't count.
  assert.deepEqual(tabsOverLimit(tabs, ["e", "d", "a"], limit(3, { excludeDirty: true }), "e"), [
    "a",
  ]);
});

test("the limit can count each group on its own", () => {
  const tabs = [tab("a"), tab("b"), tab("c", { groupId: "g2" }), tab("d", { groupId: "g2" })];
  assert.deepEqual(tabsOverLimit(tabs, ["b", "a", "d", "c"], limit(2), null), ["c", "d"]);
  assert.deepEqual(
    tabsOverLimit(tabs, ["b", "a", "d", "c"], limit(1, { perEditorGroup: true }), null),
    ["a", "c"],
  );
});

test("a drop lands by rows, or by the column for tabs on the side", () => {
  // Two rows: pinned p1 p2 on top, a b below.
  const rows = [
    { left: 0, top: 0, width: 100, height: 30 },
    { left: 100, top: 0, width: 100, height: 30 },
    { left: 0, top: 30, width: 100, height: 30 },
    { left: 100, top: 30, width: 100, height: 30 },
  ];
  assert.equal(dropIndex(rows, 120, 10, false), 1);
  assert.equal(dropIndex(rows, 190, 10, false), 2);
  assert.equal(dropIndex(rows, 20, 40, false), 2);
  assert.equal(dropIndex(rows, 190, 40, false), 4);
  const column = [
    { left: 0, top: 0, width: 200, height: 30 },
    { left: 0, top: 30, width: 200, height: 30 },
  ];
  assert.equal(dropIndex(column, 150, 10, true), 0);
  assert.equal(dropIndex(column, 150, 20, true), 1);
  assert.equal(dropIndex(column, 150, 50, true), 2);
});

test("pinned tabs stay ahead of the others", () => {
  const group: GroupNode = {
    kind: "group",
    id: "g",
    activeTabId: "a",
    tabs: ["a", "b", "c"].map((id) => ({ id, viewType: "editor", viewState: null })),
  };
  let root = setTabPinned(group, "c", true);
  assert.deepEqual(
    (root as GroupNode).tabs.map((t) => t.id),
    ["c", "a", "b"],
  );
  root = setTabPinned(root, "b", true);
  assert.deepEqual(
    (root as GroupNode).tabs.map((t) => t.id),
    ["c", "b", "a"],
  );
  // A new tab asked to go first still goes after the pinned ones.
  root = addTab(root, "g", { id: "d", viewType: "editor", viewState: null }, 0);
  assert.deepEqual(
    (root as GroupNode).tabs.map((t) => t.id),
    ["c", "b", "d", "a"],
  );
  root = setTabPinned(root, "c", false);
  assert.deepEqual(
    (root as GroupNode).tabs.map((t) => `${t.id}${t.pinned ? "*" : ""}`),
    ["b*", "c", "d", "a"],
  );
});

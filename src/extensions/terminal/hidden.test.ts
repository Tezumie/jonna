import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HiddenTerminals,
  hiddenRestoreKey,
  hiddenTabId,
  isHiddenTabId,
  parseSavedHidden,
} from "./hidden";

test("hidden groups keep their panes, sizes, active pane and place; newest first", () => {
  const h = new HiddenTerminals<string>();
  const a = h.add(["a"], [1], 0, { groupId: "g1", index: 2 }, 100);
  const b = h.add(["b1", "b2"], [0.25, 0.75], 1, null, 200);
  assert.equal(h.size, 2);
  assert.deepEqual(
    h.list().map((g) => g.key),
    [b.key, a.key],
  );
  assert.deepEqual(b.sizes, [0.25, 0.75]);
  assert.equal(b.active, 1);
  assert.deepEqual(a.place, { groupId: "g1", index: 2 });
  assert.equal(h.groupOf("b2"), b);
  assert.equal(h.groupOf("zzz"), undefined);
  assert.notEqual(a.key, b.key);
});

test("bad sizes and an out-of-range active pane are corrected; an empty tab isn't kept", () => {
  const h = new HiddenTerminals<string>();
  const g = h.add(["x", "y"], [0, Number.NaN], 7, null);
  assert.deepEqual(g.sizes, [0.5, 0.5]);
  assert.equal(g.active, 1);
  h.add([], [], 0, null);
  assert.equal(h.size, 1);
});

test("take removes a group; restore puts it back with the same key", () => {
  const h = new HiddenTerminals<string>();
  const g = h.add(["a"], [1], 0, null);
  const taken = h.take(g.key);
  assert.equal(taken, g);
  assert.equal(h.size, 0);
  assert.equal(h.take(g.key), undefined);
  if (taken) h.restore(taken);
  h.restore(g); // twice: still one
  assert.equal(h.size, 1);
  assert.equal(h.get(g.key), g);
});

test("removePane drops a killed pane; the last one drops the group", () => {
  const h = new HiddenTerminals<string>();
  const g = h.add(["a", "b", "c"], [0.5, 0.25, 0.25], 2, null);
  assert.equal(h.removePane("b"), true);
  assert.deepEqual(g.panes, ["a", "c"]);
  assert.deepEqual(
    g.sizes.map((s) => Math.round(s * 1000) / 1000),
    [0.667, 0.333],
  );
  assert.equal(g.active, 1);
  assert.equal(h.removePane("nope"), false);
  h.removePane("a");
  assert.equal(g.active, 0);
  h.removePane("c");
  assert.equal(h.size, 0);
});

test("clear hands back every pane", () => {
  const h = new HiddenTerminals<string>();
  h.add(["a"], [1], 0, null);
  h.add(["b", "c"], [1, 1], 0, null);
  assert.deepEqual(h.clear().sort(), ["a", "b", "c"]);
  assert.equal(h.size, 0);
});

test("hidden panes report a tab id no dock tab has", () => {
  assert.equal(hiddenTabId("h3"), "hidden:h3");
  assert.equal(isHiddenTabId("hidden:h3"), true);
  assert.equal(isHiddenTabId("tab-12"), false);
});

test("hidden tabs saved with the folder come back as they were; malformed ones are dropped", () => {
  const groups = parseSavedHidden([
    {
      panes: [{ cwd: "/a", pty: { id: 3, key: "k" } }, { cwd: "/b" }],
      sizes: [0.25, 0.75, "x"],
      active: 1,
      hiddenAt: 42,
      place: { groupId: "g1", index: 2 },
    },
    { panes: [] },
    { panes: [{}], place: { groupId: 5 } },
    "nope",
    null,
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], {
    panes: [{ cwd: "/a", pty: { id: 3, key: "k" } }, { cwd: "/b" }],
    sizes: [0.25, 0.75],
    active: 1,
    hiddenAt: 42,
    place: { groupId: "g1", index: 2 },
  });
  assert.equal(groups[1]?.place, null);
  assert.deepEqual(parseSavedHidden({}), []);
  // Each pane's screen is saved under its own key, apart from the tabs' keys.
  assert.equal(hiddenRestoreKey(0, 0), "hidden-0");
  assert.equal(hiddenRestoreKey(1, 2), "hidden-1#2");
});

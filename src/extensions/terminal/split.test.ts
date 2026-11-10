import assert from "node:assert/strict";
import { test } from "node:test";
import {
  groupTitle,
  isRestoreKeyOf,
  neighbourPane,
  normalizeSizes,
  orientationFor,
  paneRestoreKey,
  parseGroupState,
  parsePtyRef,
  resizeAtSash,
  serializeGroup,
  sizesAfterAdd,
  sizesAfterRemove,
  splitDirectionOf,
  withoutPty,
} from "./split";

const close = (a: readonly number[], b: readonly number[]) =>
  assert.deepEqual(
    a.map((x) => Math.round(x * 1000) / 1000),
    b.map((x) => Math.round(x * 1000) / 1000),
  );

test("panes sit side by side in a wide tab, stacked in a tall one", () => {
  assert.equal(orientationFor(900, 240), "row");
  assert.equal(orientationFor(300, 800), "column");
  assert.equal(orientationFor(300, 800, "auto"), "column");
});

test("terminal.splitDirection fixes the orientation whatever the tab's shape", () => {
  assert.equal(orientationFor(300, 800, "horizontal"), "row");
  assert.equal(orientationFor(900, 240, "vertical"), "column");
  assert.equal(splitDirectionOf("vertical"), "vertical");
  assert.equal(splitDirectionOf("horizontal"), "horizontal");
  assert.equal(splitDirectionOf("down"), "auto");
  assert.equal(splitDirectionOf(undefined), "auto");
});

test("sizes are fractions; bad ones become equal shares", () => {
  close(normalizeSizes([2, 2], 2), [0.5, 0.5]);
  close(normalizeSizes([1, "x", 1], 3), [1 / 3, 1 / 3, 1 / 3]);
  close(normalizeSizes([1], 2), [0.5, 0.5]);
  assert.deepEqual(normalizeSizes([], 0), []);
});

test("a new pane shares equally; a closed one's space goes to the rest", () => {
  close(sizesAfterAdd(1), [0.5, 0.5]);
  close(sizesAfterAdd(2), [1 / 3, 1 / 3, 1 / 3]);
  close(sizesAfterRemove([0.5, 0.25, 0.25], 0), [0.5, 0.5]);
  close(sizesAfterRemove([0.6, 0.4], 1), [1]);
});

test("dragging a sash moves only its two panes, never below the minimum", () => {
  close(resizeAtSash([0.5, 0.5], 0, 100, 1000), [0.6, 0.4]);
  close(resizeAtSash([0.5, 0.5], 0, -1000, 1000, 80), [0.08, 0.92]);
  close(resizeAtSash([1 / 3, 1 / 3, 1 / 3], 1, 50, 900), [1 / 3, 0.3889, 0.2778]);
  // No sash there: unchanged.
  close(resizeAtSash([0.5, 0.5], 3, 10, 1000), [0.5, 0.5]);
});

test("focus moves to the next or previous pane, wrapping", () => {
  assert.equal(neighbourPane(3, 2, 1), 0);
  assert.equal(neighbourPane(3, 0, -1), 2);
  assert.equal(neighbourPane(1, 0, 1), 0);
});

test("a group's title joins its panes' titles", () => {
  assert.equal(groupTitle(["bash · ide", "node"]), "bash · ide, node");
  assert.equal(groupTitle([]), "Terminal");
});

test("each pane's output has its own key, the first one the tab's", () => {
  assert.equal(paneRestoreKey("t1", 0), "t1");
  assert.equal(paneRestoreKey("t1", 2), "t1#2");
  assert.ok(isRestoreKeyOf("t1#2", "t1"));
  assert.ok(isRestoreKeyOf("t1", "t1"));
  assert.ok(!isRestoreKeyOf("t10", "t1"));
});

test("one pane keeps the old tab state; several carry panes, active and sizes", () => {
  const old = { cwd: "/w", name: "dev", color: "red" };
  const one = parseGroupState(old);
  assert.equal(one.panes.length, 1);
  assert.deepEqual(one.panes[0], old);
  assert.deepEqual(serializeGroup(one.panes, 0, one.sizes), old);
  assert.deepEqual(parseGroupState(null), { panes: [null], active: 0, sizes: [1] });

  const state = serializeGroup([{ cwd: "/a" }, { cwd: "/b", icon: "globe" }], 1, [0.3, 0.7]);
  assert.deepEqual(state, {
    icon: "globe",
    panes: [{ cwd: "/a" }, { cwd: "/b", icon: "globe" }],
    active: 1,
    sizes: [0.3, 0.7],
  });
  const back = parseGroupState(state);
  assert.equal(back.panes.length, 2);
  assert.equal(back.active, 1);
  close(back.sizes, [0.3, 0.7]);
  // An active index out of range is clamped.
  assert.equal(parseGroupState({ panes: [{}, {}], active: 9 }).active, 1);
});

test("a pane's running process is kept in its state, but not in a duplicated tab's", () => {
  assert.deepEqual(parsePtyRef({ id: 4, key: "ab" }), { id: 4, key: "ab" });
  assert.equal(parsePtyRef({ id: 0, key: "ab" }), null);
  assert.equal(parsePtyRef({ id: 1.5, key: "ab" }), null);
  assert.equal(parsePtyRef({ id: 4, key: "" }), null);
  assert.equal(parsePtyRef("4"), null);
  assert.equal(parsePtyRef(null), null);
  // The group shape keeps `pty` per pane (parseGroupState) and a duplicate drops them all.
  const group = parseGroupState({
    panes: [
      { cwd: "/a", pty: { id: 1, key: "x" } },
      { cwd: "/b", pty: { id: 2, key: "y" } },
    ],
    active: 0,
    sizes: [0.5, 0.5],
  });
  assert.deepEqual(group.panes[1], { cwd: "/b", pty: { id: 2, key: "y" } });
  assert.deepEqual(withoutPty({ cwd: "/a", pty: { id: 1, key: "x" } }), { cwd: "/a" });
  assert.deepEqual(
    withoutPty({ panes: [{ cwd: "/a", pty: { id: 1, key: "x" } }, { cwd: "/b" }], active: 1 }),
    { panes: [{ cwd: "/a" }, { cwd: "/b" }], active: 1 },
  );
  assert.equal(withoutPty(null), null);
});

test("parseGroupState keeps an extension terminal's transient mark (D388)", () => {
  const one = parseGroupState({ name: "Python", cwd: "/w", transient: true });
  assert.deepEqual(one.panes, [{ cwd: "/w", name: "Python", transient: true }]);
  const split = parseGroupState({ panes: [{ cwd: "/w", transient: true }, { cwd: "/w" }] });
  assert.deepEqual(split.panes, [{ cwd: "/w", transient: true }, { cwd: "/w" }]);
});

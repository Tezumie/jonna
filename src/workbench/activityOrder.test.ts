import assert from "node:assert/strict";
import { test } from "node:test";
import {
  badgeText,
  dropIndex,
  mergeOrder,
  moveInOrder,
  orderViews,
  parseOrder,
} from "./activityOrder";

const views = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (list: readonly { id: string }[]) => list.map((v) => v.id);

test("orderViews: stored order first, unknown and new views appended as registered", () => {
  const all = views("explorer", "search", "scm", "debug", "agent");
  assert.deepEqual(ids(orderViews(all, [])), ["explorer", "search", "scm", "debug", "agent"]);
  assert.deepEqual(ids(orderViews(all, ["scm", "gone", "explorer"])), [
    "scm",
    "explorer",
    "search",
    "debug",
    "agent",
  ]);
  // Duplicates in the stored list: the first place wins.
  assert.deepEqual(ids(orderViews(views("a", "b"), ["b", "a", "b"])), ["b", "a"]);
});

test("mergeOrder: keeps stored ids (even unregistered) and appends the rest", () => {
  assert.deepEqual(mergeOrder(["c", "gone", "a"], ["a", "b", "c"]), ["c", "gone", "a", "b"]);
  assert.deepEqual(mergeOrder([], ["a", "b"]), ["a", "b"]);
});

test("moveInOrder: before another id, to the end, and onto itself", () => {
  const order = ["a", "b", "c", "d"];
  assert.deepEqual(moveInOrder(order, "d", "a"), ["d", "a", "b", "c"]);
  assert.deepEqual(moveInOrder(order, "a", "c"), ["b", "a", "c", "d"]);
  assert.deepEqual(moveInOrder(order, "b", null), ["a", "c", "d", "b"]);
  assert.deepEqual(moveInOrder(order, "b", "missing"), ["a", "c", "d", "b"]);
  assert.deepEqual(moveInOrder(order, "b", "b"), ["a", "c", "d", "b"]);
  assert.deepEqual(moveInOrder(order, "new", "c"), ["a", "b", "new", "c", "d"]);
});

test("parseOrder: only strings survive", () => {
  assert.deepEqual(parseOrder(["a", 1, null, "b"]), ["a", "b"]);
  assert.deepEqual(parseOrder("a"), []);
  assert.deepEqual(parseOrder(undefined), []);
});

test("dropIndex: the item the pointer is above, or the end", () => {
  const mids = [10, 50, 90];
  assert.equal(dropIndex(mids, 0), 0);
  assert.equal(dropIndex(mids, 30), 1);
  assert.equal(dropIndex(mids, 89), 2);
  assert.equal(dropIndex(mids, 200), 3);
  assert.equal(dropIndex([], 5), 0);
});

test("badgeText: up to four digits, then 9999+", () => {
  assert.equal(badgeText(7), "7");
  assert.equal(badgeText(99), "99");
  assert.equal(badgeText(100), "100");
  assert.equal(badgeText(9999), "9999");
  assert.equal(badgeText(10000), "9999+");
  assert.equal(badgeText(123456), "9999+");
});

// Tests of treeParts.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { computeSticky, TreeSelection } from "./treeParts";

const order = ["a", "b", "c", "d", "e"];

test("plain click selects one; toggle adds and removes", () => {
  const s = new TreeSelection();
  s.select("b", order);
  assert.deepEqual([...s.selected], ["b"]);
  s.select("d", order, { toggle: true });
  assert.deepEqual([...s.selected].sort(), ["b", "d"]);
  s.select("b", order, { toggle: true });
  assert.deepEqual([...s.selected], ["d"]);
  assert.equal(s.focused, "b");
});

test("shift extends from the anchor in either direction", () => {
  const s = new TreeSelection();
  s.select("c", order);
  s.select("e", order, { range: true });
  assert.deepEqual([...s.selected], ["c", "d", "e"]);
  s.select("a", order, { range: true });
  assert.deepEqual([...s.selected], ["a", "b", "c"]);
});

test("retain forgets deleted rows", () => {
  const s = new TreeSelection();
  s.select("a", order);
  s.select("b", order, { toggle: true });
  s.retain((id) => id !== "a");
  assert.deepEqual([...s.selected], ["b"]);
});

// a/ (0) ├ b/ (1) │ ├ x (2) … 10 files … └ c (1) ; d/ (0) collapsed
const rows = [
  { depth: 0, hasChildren: true, expanded: true }, // 0 a
  { depth: 1, hasChildren: true, expanded: true }, // 1 b
  ...Array.from({ length: 10 }, () => ({ depth: 2, hasChildren: false, expanded: false })), // 2..11
  { depth: 1, hasChildren: false, expanded: false }, // 12 c
  { depth: 0, hasChildren: true, expanded: false }, // 13 d
];

test("pins expanded ancestors of the rows scrolled under", () => {
  assert.deepEqual(computeSticky(rows, 0, 20, 5), []);
  assert.deepEqual(computeSticky(rows, 100, 20, 5), [
    { index: 0, top: 0 },
    { index: 1, top: 20 },
  ]);
});

test("the deepest pinned folder is pushed up as its contents end", () => {
  // b's contents end at row 12; at scrollTop 200, row 12 starts at 240 - 200 = 40 px.
  assert.deepEqual(computeSticky(rows, 200, 20, 5), [
    { index: 0, top: 0 },
    { index: 1, top: 20 },
  ]);
  assert.deepEqual(computeSticky(rows, 210, 20, 5), [
    { index: 0, top: 0 },
    { index: 1, top: 10 },
  ]);
  // Past a's contents (row 13 = d at 260): a is pushed up too.
  assert.deepEqual(computeSticky(rows, 250, 20, 5), [{ index: 0, top: -10 }]);
  assert.deepEqual(computeSticky(rows, 100, 20, 1), [{ index: 0, top: 0 }]);
});

test("computeSticky reads only rows near the top of a long expanded folder", () => {
  // A commit (depth 0) with 5000 files under it; scrolled into the middle of them.
  const total = 5001;
  const read = new Set<number>();
  const rows = {
    length: total,
    at: (i: number) => {
      read.add(i);
      return i === 0
        ? { depth: 0, hasChildren: true, expanded: true }
        : i < total
          ? { depth: 1, hasChildren: false, expanded: false }
          : undefined;
    },
  };
  const placed = computeSticky(rows, 2500 * 20, 20, 5);
  assert.deepEqual(placed, [{ index: 0, top: 0 }]);
  // The walk back to the commit reads the rows above; nothing after the next slot.
  assert.ok(
    [...read].every((i) => i <= 2502),
    `read past the view: ${Math.max(...read)}`,
  );
  // The same result as from a full array.
  const array = Array.from({ length: total }, (_, i) => rows.at(i) ?? rows.at(1));
  assert.deepEqual(computeSticky(array as never, 2500 * 20, 20, 5), placed);
});

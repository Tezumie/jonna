import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampSelection,
  collapsed,
  dropGapAt,
  dropSelected,
  extendTo,
  joinSelected,
  moveSelected,
  selectAll,
  toggle,
} from "./selection";

test("Shift extends from the anchor, both ways", () => {
  let sel = collapsed(2, 6);
  sel = extendTo(sel, 4, 6);
  assert.deepEqual(sel, { focus: 4, anchor: 2, selected: [2, 3, 4] });
  sel = extendTo(sel, 0, 6);
  assert.deepEqual(sel, { focus: 0, anchor: 2, selected: [0, 1, 2] });
  // Past the ends: clamped.
  assert.deepEqual(extendTo(sel, 99, 6).selected, [2, 3, 4, 5]);
  assert.deepEqual(extendTo(sel, -3, 6).selected, [0, 1, 2]);
});

test("Ctrl+click adds and removes, never leaving nothing", () => {
  let sel = collapsed(1, 5);
  sel = toggle(sel, 3, 5);
  assert.deepEqual(sel, { focus: 3, anchor: 3, selected: [1, 3] });
  sel = toggle(sel, 0, 5);
  assert.deepEqual(sel.selected, [0, 1, 3]);
  sel = toggle(sel, 1, 5);
  assert.deepEqual(sel.selected, [0, 3]);
  assert.equal(sel.focus, 3);
  const one = collapsed(2, 5);
  assert.equal(toggle(one, 2, 5), one);
  // A Shift range after a Ctrl+click starts from the clicked cell.
  assert.deepEqual(extendTo(toggle(collapsed(0, 6), 3, 6), 5, 6).selected, [3, 4, 5]);
});

test("select all and clamping after deletes", () => {
  assert.deepEqual(selectAll(collapsed(1, 3), 3), { focus: 1, anchor: 0, selected: [0, 1, 2] });
  const sel = clampSelection({ focus: 4, anchor: 1, selected: [1, 3, 4] }, 3);
  assert.deepEqual(sel, { focus: 2, anchor: 1, selected: [1, 2] });
  assert.deepEqual(clampSelection(sel, 0), collapsed(0, 1));
});

test("moving several cells", () => {
  // A block moves past its neighbour.
  assert.deepEqual(moveSelected(5, [2, 3], -1), { order: [0, 2, 3, 1, 4], selected: [1, 2] });
  assert.deepEqual(moveSelected(5, [1, 2], 1), { order: [0, 3, 1, 2, 4], selected: [2, 3] });
  // Apart: each moves by one.
  assert.deepEqual(moveSelected(4, [1, 3], -1), { order: [1, 0, 3, 2], selected: [0, 2] });
  // At the edge: nothing moves.
  assert.equal(moveSelected(4, [0, 2], -1), null);
  assert.equal(moveSelected(4, [3], 1), null);
  assert.equal(moveSelected(4, [], 1), null);
});

test("joining selected cells", () => {
  const cells = [
    { kind: "code", source: "a = 1" },
    { kind: "markdown", source: "# T" },
    { kind: "code", source: "b = 2" },
    { kind: "code", source: "c = 3" },
  ];
  assert.deepEqual(joinSelected(cells, [3, 0, 2]), {
    into: 0,
    source: "a = 1\nb = 2\nc = 3",
    remove: [2, 3],
  });
  assert.deepEqual(joinSelected(cells, [0, 1]), {
    error: "Cells of different kinds can't be joined.",
  });
  assert.ok("error" in joinSelected(cells, [2]));
});

test("dropping several cells moves them as a block, in their order", () => {
  // Cells 1 and 3 of 0..5 dropped before cell 5.
  assert.deepEqual(dropSelected(6, [3, 1], 5), { order: [0, 2, 4, 1, 3, 5], selected: [3, 4] });
  // To the top, and to the end.
  assert.deepEqual(dropSelected(6, [2, 4], 0), { order: [2, 4, 0, 1, 3, 5], selected: [0, 1] });
  assert.deepEqual(dropSelected(6, [0, 2], 6), { order: [1, 3, 4, 5, 0, 2], selected: [4, 5] });
  // Dropped into a gap between them: they close up around it.
  assert.deepEqual(dropSelected(5, [1, 3], 2), { order: [0, 1, 3, 2, 4], selected: [1, 2] });
  // One cell, as a single drag.
  assert.deepEqual(dropSelected(4, [0], 3), { order: [1, 2, 0, 3], selected: [2] });
});

test("a drop that changes nothing is null", () => {
  // A block dropped onto its own edges.
  assert.equal(dropSelected(5, [1, 2], 1), null);
  assert.equal(dropSelected(5, [1, 2], 2), null);
  assert.equal(dropSelected(5, [1, 2], 3), null);
  assert.equal(dropSelected(3, [2], 3), null);
  assert.equal(dropSelected(3, [], 0), null);
  assert.equal(dropSelected(3, [7], 0), null);
  // Out of range gaps are clamped.
  assert.deepEqual(dropSelected(3, [0], 99)?.order, [1, 2, 0]);
});

test("the gap under the pointer is before the first cell whose middle is below it", () => {
  const mids = [50, 150, 250];
  assert.equal(dropGapAt(mids, 0), 0);
  assert.equal(dropGapAt(mids, 49), 0);
  assert.equal(dropGapAt(mids, 51), 1);
  assert.equal(dropGapAt(mids, 249), 2);
  assert.equal(dropGapAt(mids, 400), 3);
  assert.equal(dropGapAt([], 10), 0);
});

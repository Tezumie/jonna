import assert from "node:assert/strict";
import { test } from "node:test";
import { overlaps, physicalBounds, placement, samePlacement } from "./embedGeometry";

test("the page area in physical pixels, without gaps", () => {
  assert.deepEqual(physicalBounds({ left: 10, top: 20, width: 300, height: 200 }, 1.5), {
    x: 15,
    y: 30,
    width: 450,
    height: 300,
  });
  // Fractional CSS edges: rounded per edge.
  assert.deepEqual(physicalBounds({ left: 0.4, top: 0, width: 100.3, height: 10 }, 1.25), {
    x: 1,
    y: 0,
    width: 125,
    height: 13,
  });
  assert.deepEqual(physicalBounds({ left: 1, top: 1, width: 2, height: 2 }, Number.NaN), {
    x: 1,
    y: 1,
    width: 2,
    height: 2,
  });
});

test("overlap: shared area only", () => {
  const a = { left: 0, top: 0, width: 100, height: 100 };
  assert.equal(overlaps(a, { left: 50, top: 50, width: 10, height: 10 }), true);
  assert.equal(overlaps(a, { left: 100, top: 0, width: 10, height: 10 }), false);
  assert.equal(overlaps(a, { left: 10, top: 10, width: 0, height: 10 }), false);
});

test("placement: hidden without area or while covered", () => {
  const area = { left: 0, top: 40, width: 800, height: 600 };
  assert.equal(placement(null, [], 1, 1).visible, false);
  assert.equal(placement({ ...area, width: 0 }, [], 1, 1).visible, false);
  const shown = placement(area, [{ left: 900, top: 0, width: 100, height: 100 }], 2, 1);
  assert.deepEqual(shown, {
    visible: true,
    bounds: { x: 0, y: 80, width: 1600, height: 1200 },
    zoom: 1,
  });
  const menu = { left: 700, top: 30, width: 200, height: 300 };
  assert.equal(placement(area, [menu], 1, 1).visible, false);
  assert.equal(samePlacement(shown, placement(area, [], 2, 1)), true);
  assert.equal(samePlacement(shown, placement(area, [], 2, 0.5)), false);
  assert.equal(samePlacement(null, shown), false);
  // Two hidden placements are the same whatever their bounds.
  assert.equal(samePlacement(placement(null, [], 1, 1), placement(area, [menu], 1, 1)), true);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  frameAt,
  frameSpans,
  type PerfRecording,
  packRows,
  rangeStats,
  sampleAt,
  tickLabel,
  tickStep,
  ticks,
} from "./perfModel";

test("ruler steps are 1, 2 or 5 × 10ⁿ", () => {
  assert.equal(tickStep(1000, 10), 100);
  assert.equal(tickStep(3000, 10), 500);
  assert.equal(tickStep(1500, 10), 200);
  assert.equal(tickStep(12, 6), 2);
  assert.deepEqual(ticks(0, 1000, 5), [0, 200, 400, 600, 800, 1000]);
  assert.deepEqual(ticks(150, 600, 5), [200, 300, 400, 500, 600]);
  assert.equal(tickLabel(0, 200), "0");
  assert.equal(tickLabel(400, 200), "400 ms");
  assert.equal(tickLabel(1500, 500), "1.5 s");
  assert.equal(tickLabel(2000, 1000), "2 s");
});

test("frames rate by how long they stayed", () => {
  assert.deepEqual(frameSpans([0, 16, 50, 110]), [
    [0, 16, "good"],
    [16, 34, "ok"],
    [50, 60, "poor"],
  ]);
  assert.deepEqual(frameAt([0, 16, 50, 110], 20), [16, 34]);
  assert.equal(frameAt([0, 16], 30), null);
});

test("requests pack into rows that don't overlap", () => {
  const rows = packRows(
    [
      { start: 0, end: 10 },
      { start: 5, end: 20 },
      { start: 12, end: 30 },
      { start: 6, end: 9 },
    ],
    2,
  ).map((r) => r.row);
  assert.deepEqual(rows, [0, 1, 1, 0]);
});

test("the sample under the pointer", () => {
  const samples = [{ t: 250 }, { t: 500 }, { t: 750 }];
  assert.equal(sampleAt(samples, 600)?.t, 500);
  assert.equal(sampleAt(samples, 10)?.t, 250);
  assert.equal(sampleAt([], 10), null);
});

test("statistics of a selected range", () => {
  const r: PerfRecording = {
    duration: 1000,
    samples: [
      { t: 250, fps: 60, heap: 100 },
      { t: 500, fps: 30, heap: 300 },
      { t: 750, fps: 60, heap: 200 },
    ],
    frames: [0, 16, 33, 100, 116],
    longTasks: [
      { start: 40, duration: 120 },
      { start: 800, duration: 60 },
    ],
    requests: [{ url: "a", type: "script", start: 10, end: 90, size: 500 }],
    interactions: [
      { name: "click", start: 50, duration: 80 },
      { name: "keydown", start: 60, duration: 300 },
    ],
    shifts: [{ t: 70, value: 0.05 }],
    supported: {},
  };
  const all = rangeStats(r, 0, 1000);
  assert.equal(all.longTasks, 2);
  assert.equal(all.blocking, 80);
  assert.equal(all.dropped, 1);
  assert.equal(all.frames, 4);
  assert.equal(all.slowestInteraction?.name, "keydown");
  assert.deepEqual(all.heap, { min: 100, max: 300 });
  const start = rangeStats(r, 0, 200);
  assert.equal(start.longTasks, 1);
  assert.equal(start.requests, 1);
  assert.equal(start.layoutShift, 0.05);
  const late = rangeStats(r, 600, 1000);
  assert.equal(late.requests, 0);
  assert.equal(late.interactions, 0);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { type DatedSnapshot, planPrune } from "./history";

/** A snapshot on day `day` at hour `hour` (days are numbers here: no time zones). */
const at = (day: number, hour: number, pinned = false): DatedSnapshot => ({
  id: `d${day}h${hour}`,
  time: day * 24 + hour,
  pinned,
});
const day = (time: number) => String(Math.floor(time / 24));

test("planPrune: the latest day keeps everything, earlier days their last snapshot", () => {
  const all = [at(1, 9), at(1, 17), at(2, 8), at(2, 12), at(2, 20), at(3, 10), at(3, 11)];
  assert.deepEqual(planPrune(all, 30, day).sort(), ["d1h9", "d2h12", "d2h8"]);
});

test("planPrune: days are days with work, however far apart", () => {
  // Three days of work a year apart each: all within "the last 3 days worked".
  const all = [at(1, 9), at(400, 9), at(800, 9)];
  assert.deepEqual(planPrune(all, 3, day), []);
  assert.deepEqual(planPrune(all, 2, day), ["d1h9"]);
  assert.deepEqual(planPrune(all, 1, day).sort(), ["d1h9", "d400h9"]);
});

test("planPrune: a pinned snapshot stays and doesn't count toward the days", () => {
  const all = [at(1, 9, true), at(2, 9), at(3, 9), at(4, 9)];
  assert.deepEqual(planPrune(all, 2, day), ["d2h9"]);
  // A pinned one on a day with others doesn't save the others.
  const mixed = [at(1, 8), at(1, 9, true), at(1, 10), at(2, 9)];
  assert.deepEqual(planPrune(mixed, 30, day), ["d1h8"]);
});

test("planPrune: keep everything, and nothing to do", () => {
  const all = [at(1, 9), at(1, 10), at(2, 9)];
  assert.deepEqual(planPrune(all, 0, day), []);
  assert.deepEqual(planPrune([], 30, day), []);
  assert.deepEqual(planPrune([at(5, 1), at(5, 2), at(5, 3)], 1, day), []);
});

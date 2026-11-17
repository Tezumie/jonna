import assert from "node:assert/strict";
import { test } from "node:test";
import { type DatedSnapshot, planPrune, staysPinned } from "./history";

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

test("planPrune: an earlier day keeps each computer's last snapshot", () => {
  const on = (d: number, hour: number, device: string): DatedSnapshot => ({
    ...at(d, hour),
    id: `d${d}h${hour}${device}`,
    device,
  });
  // Day 1: the laptop at 9 and 10, the desk at 12 and 15. Day 2: the desk only.
  const all = [
    on(1, 9, "lap"),
    on(1, 10, "lap"),
    on(1, 12, "desk"),
    on(1, 15, "desk"),
    on(2, 9, "desk"),
  ];
  // The laptop's last of day 1 stays though the desk made snapshots later that day.
  assert.deepEqual(planPrune(all, 30, day).sort(), ["d1h12desk", "d1h9lap"]);
  // Past the days kept, everything of that day goes, whoever made it.
  assert.deepEqual(planPrune(all, 1, day).sort(), [
    "d1h10lap",
    "d1h12desk",
    "d1h15desk",
    "d1h9lap",
  ]);
});

test("planPrune: keep everything, and nothing to do", () => {
  const all = [at(1, 9), at(1, 10), at(2, 9)];
  assert.deepEqual(planPrune(all, 0, day), []);
  assert.deepEqual(planPrune([], 30, day), []);
  assert.deepEqual(planPrune([at(5, 1), at(5, 2), at(5, 3)], 1, day), []);
});

test("staysPinned: a name, or the account page's mark, either one", () => {
  assert.equal(staysPinned("before the rewrite", false), true);
  assert.equal(staysPinned(undefined, true), true);
  assert.equal(staysPinned("both", true), true);
  assert.equal(staysPinned(undefined, undefined), false);
  assert.equal(staysPinned(null, false), false);
  // An empty name is no pin.
  assert.equal(staysPinned("", false), false);
});

test("planPrune: a snapshot kept from the account page is never removed", () => {
  // As the controller hands them over: `pinned` is the name or the service's mark.
  const row = (onDay: number, hour: number, keep: boolean): DatedSnapshot => ({
    ...at(onDay, hour),
    pinned: staysPinned(undefined, keep),
  });
  const all = [
    row(1, 9, true),
    row(1, 12, false),
    row(2, 9, false),
    row(3, 9, false),
    row(4, 9, false),
  ];
  // Two days kept: days 1 and 2 are older, and only the unmarked ones go.
  assert.deepEqual(planPrune(all, 2, day).sort(), ["d1h12", "d2h9"]);
  // Unmarked again, it goes like any other.
  const unmarked = [row(1, 9, false), ...all.slice(1)];
  assert.deepEqual(planPrune(unmarked, 2, day).sort(), ["d1h12", "d1h9", "d2h9"]);
  // The mark doesn't save the day's other snapshots, nor count toward the days kept.
  const sameDay = [row(1, 8, false), row(1, 9, true), row(2, 9, false)];
  assert.deepEqual(planPrune(sameDay, 1, day), ["d1h8"]);
});

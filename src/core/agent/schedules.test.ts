import assert from "node:assert/strict";
import { test } from "node:test";
import {
  afterRun,
  DAY,
  describeNext,
  describeRepeat,
  dueSchedules,
  HOUR,
  labelFor,
  MINUTE,
  nextAt,
  parseClock,
  parseDuration,
  parseWhen,
  type Schedule,
  untilNext,
  validSchedules,
  whenProblem,
} from "./schedules";

// Local times, so the tests hold in any time zone: Tuesday 3 November 2026, 10:00.
const NOW = new Date(2026, 10, 3, 10, 0, 0, 0).getTime();
const local = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m, 0, 0).getTime();

test("durations and clock times", () => {
  assert.equal(parseDuration("20m"), 20 * MINUTE);
  assert.equal(parseDuration("1h 30m"), 90 * MINUTE);
  assert.equal(parseDuration("an hour and 15 minutes"), 75 * MINUTE);
  assert.equal(parseDuration("2 days"), 2 * DAY);
  assert.equal(parseDuration("soon"), null);
  assert.equal(parseDuration(""), null);
  assert.equal(parseClock("9:30"), 9 * 60 + 30);
  assert.equal(parseClock("9am"), 9 * 60);
  assert.equal(parseClock("12am"), 0);
  assert.equal(parseClock("12:15 pm"), 12 * 60 + 15);
  assert.equal(parseClock("3.45 p.m."), 15 * 60 + 45);
  assert.equal(parseClock("15h30"), 15 * 60 + 30);
  // A bare number isn't a time; impossible ones aren't either.
  assert.equal(parseClock("9"), null);
  assert.equal(parseClock("25:00"), null);
  assert.equal(parseClock("13pm"), null);
});

test("one-off times: in, at, tomorrow, dates", () => {
  assert.deepEqual(parseWhen("in 20 minutes", NOW), { at: NOW + 20 * MINUTE });
  assert.deepEqual(parseWhen("45m", NOW), { at: NOW + 45 * MINUTE });
  // A time already past today is tomorrow's.
  assert.deepEqual(parseWhen("at 15:30", NOW), { at: local(3, 15, 30) });
  assert.deepEqual(parseWhen("9am", NOW), { at: local(4, 9) });
  assert.deepEqual(parseWhen("tomorrow at 8:15", NOW), { at: local(4, 8, 15) });
  assert.deepEqual(parseWhen("2026-11-05 09:00", NOW), { at: local(5, 9) });
  assert.deepEqual(parseWhen("2026-11-05T09:00:00Z", NOW), {
    at: Date.parse("2026-11-05T09:00:00Z"),
  });
  assert.ok("error" in parseWhen("whenever", NOW));
  assert.ok("error" in parseWhen("", NOW));
});

test("repeats: every, hourly, daily, weekdays, named days", () => {
  assert.deepEqual(parseWhen("every 30 minutes", NOW), {
    repeat: { every: 30 * MINUTE },
    first: NOW + 30 * MINUTE,
  });
  assert.deepEqual(parseWhen("every hour", NOW), { repeat: { every: HOUR }, first: NOW + HOUR });
  assert.deepEqual(parseWhen("hourly", NOW), { repeat: { every: HOUR }, first: NOW + HOUR });
  assert.deepEqual(parseWhen("daily at 9:00", NOW), {
    repeat: { at: "09:00" },
    first: local(4, 9),
  });
  assert.deepEqual(parseWhen("every day at 11am", NOW), {
    repeat: { at: "11:00" },
    first: local(3, 11),
  });
  // Tuesday 10:00 now: the next weekday 9am is Wednesday; Friday's next is the following Monday.
  assert.deepEqual(parseWhen("every weekday at 9am", NOW), {
    repeat: { at: "09:00", days: [1, 2, 3, 4, 5] },
    first: local(4, 9),
  });
  assert.equal(nextAt("09:00", [1, 2, 3, 4, 5], local(6, 10)), local(9, 9));
  assert.deepEqual(parseWhen("every monday and thursday at 17:00", NOW), {
    repeat: { at: "17:00", days: [1, 4] },
    first: local(5, 17),
  });
  assert.ok("error" in parseWhen("every blue moon", NOW));
});

test("limits: too soon, too often, too far, already past", () => {
  const w = (t: string) => {
    const r = parseWhen(t, NOW);
    assert.ok(!("error" in r));
    return r;
  };
  assert.equal(whenProblem(w("in 20 minutes"), NOW), null);
  assert.match(whenProblem(w("in 20 seconds"), NOW) ?? "", /less than a minute/);
  assert.match(whenProblem(w("every 2 minutes"), NOW) ?? "", /every 5 minutes/);
  assert.match(whenProblem(w("in 40 days"), NOW) ?? "", /30 days/);
  assert.match(whenProblem({ at: NOW - MINUTE }, NOW) ?? "", /passed/);
});

const base: Schedule = {
  id: "s1",
  label: "Check",
  prompt: "Check the deploy",
  target: { kind: "chat", session: "c1" },
  next: NOW,
  created: NOW - HOUR,
  createdBy: "agent",
  runs: 0,
};

test("after a run: a one-off is done, a repeat moves on and skips what was missed", () => {
  assert.equal(afterRun(base, NOW), null);
  const hourly = { ...base, repeat: { every: HOUR } };
  assert.equal(afterRun(hourly, NOW)?.next, NOW + HOUR);
  assert.equal(afterRun(hourly, NOW)?.runs, 1);
  // Closed for 5 h 20 min: one run now, the next keeps the rhythm (on the hour).
  const late = afterRun(hourly, NOW + 5 * HOUR + 20 * MINUTE);
  assert.equal(late?.next, NOW + 6 * HOUR);
  const daily = { ...base, repeat: { at: "09:00" }, next: local(3, 9) };
  assert.equal(afterRun(daily, local(3, 9))?.next, local(4, 9));
  // Past its expiry: it ends.
  assert.equal(afterRun({ ...hourly, expires: NOW + 30 * MINUTE }, NOW), null);
});

test("due, next, descriptions and labels", () => {
  const list = [
    { ...base, id: "a", next: NOW + HOUR },
    { ...base, id: "b", next: NOW - MINUTE },
    { ...base, id: "c", next: NOW - HOUR },
  ];
  assert.deepEqual(
    dueSchedules(list, NOW).map((s) => s.id),
    ["c", "b"],
  );
  assert.equal(untilNext(list, NOW), 0);
  assert.equal(untilNext([list[0] as Schedule], NOW), HOUR);
  assert.equal(untilNext([], NOW), null);
  assert.equal(describeRepeat(undefined), "once");
  assert.equal(describeRepeat({ every: 90 * MINUTE }), "every 1 h 30 min");
  assert.equal(describeRepeat({ at: "09:00", days: [1, 2, 3, 4, 5] }), "weekdays at 09:00");
  assert.equal(describeRepeat({ at: "17:00", days: [1, 4] }), "Mon, Thu at 17:00");
  assert.equal(describeNext(NOW + 20 * MINUTE, NOW), "in 20 min (10:20)");
  assert.equal(describeNext(local(4, 9), NOW), "tomorrow at 09:00");
  assert.equal(labelFor("  Check CI\nthen report"), "Check CI");
  assert.equal(labelFor("x".repeat(80)).length, 58);
});

test("stored schedules: malformed ones are dropped", () => {
  const kept = validSchedules([
    base,
    { ...base, id: "r", repeat: { at: "nine" } },
    { ...base, id: "t", target: { kind: "chat" } },
    { ...base, id: "n", next: Number.NaN },
    { ...base, id: "ok2", target: { kind: "channel", channel: "#general" }, label: undefined },
    null,
    "x",
  ]);
  assert.deepEqual(
    kept.map((s) => s.id),
    ["s1", "ok2"],
  );
  assert.equal(kept[1]?.label, "Check the deploy");
  assert.deepEqual(validSchedules({}), []);
});

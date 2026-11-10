import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampDelay,
  collapseQuietTicks,
  LOOP_DAYS,
  loopPace,
  loopStartContext,
  newLoop,
  parseLoopArgs,
  readTick,
  tickPrompt,
  tickPromptText,
  validLoops,
} from "./chatLoop";
import type { Item } from "./conversation";
import { DAY, MINUTE } from "./schedules";

test("parseLoopArgs: an interval first or last, else self-paced", () => {
  assert.deepEqual(parseLoopArgs("5m check the build"), {
    prompt: "check the build",
    every: 5 * MINUTE,
  });
  assert.deepEqual(parseLoopArgs("10 min check it"), { prompt: "check it", every: 10 * MINUTE });
  assert.deepEqual(parseLoopArgs("check the build every 2 hours"), {
    prompt: "check the build",
    every: 2 * 60 * MINUTE,
  });
  assert.deepEqual(parseLoopArgs("check the build every hour"), {
    prompt: "check the build",
    every: 60 * MINUTE,
  });
  assert.deepEqual(parseLoopArgs("check the build"), { prompt: "check the build" });
  // A number that isn't an interval stays in the prompt.
  assert.deepEqual(parseLoopArgs("3 tests are failing, watch them"), {
    prompt: "3 tests are failing, watch them",
  });
  assert.ok("error" in parseLoopArgs(""));
  assert.ok("error" in parseLoopArgs("5m"));
  assert.ok("error" in parseLoopArgs("30s check"));
  assert.ok("error" in parseLoopArgs("2d check"));
});

test("clampDelay keeps 60 to 3600 seconds", () => {
  assert.equal(clampDelay(5), 60);
  assert.equal(clampDelay(90.4), 90);
  assert.equal(clampDelay(99999), 3600);
  assert.equal(clampDelay("x"), 60);
});

test("a check's message reads back", () => {
  const now = Date.UTC(2026, 10, 6);
  const loop = newLoop("s1", "check the build", undefined, now);
  assert.equal(loop.expires, now + LOOP_DAYS * DAY);
  assert.equal(loopPace(loop), "self-paced");
  assert.equal(loopPace({ every: 5 * MINUTE }), "every 5 min");
  const text = `Scheduled message (once; schedule id s9):\n\n${tickPrompt(loop, 3)}`;
  assert.equal(readTick(text), 3);
  assert.equal(tickPromptText(text), "check the build");
  assert.equal(readTick("Scheduled message (once):\n\nhello"), null);
  assert.match(loopStartContext(loop), /schedule_wakeup/);
});

const tick = (n: number, noop: boolean | null, extra: Partial<Item> = {}): Item[] => [
  {
    type: "user",
    id: `u${n}`,
    text: `Scheduled message (once):\n\nLoop check ${n} (/loop, self-paced, until x). How\n\ncheck`,
    auto: "schedule",
  },
  { type: "assistant", id: `a${n}`, text: "Nothing new.", thinking: "", streaming: false },
  ...(noop === null
    ? []
    : [
        {
          type: "tool",
          id: `t${n}`,
          name: "schedule_wakeup",
          args: { noop, delay_seconds: 60 },
          status: "done",
          ...extra,
        } as unknown as Item,
      ]),
];

test("collapseQuietTicks folds runs of quiet checks into one line", () => {
  const items: Item[] = [
    { type: "user", id: "u0", text: "/loop check" },
    { type: "assistant", id: "a0", text: "Started.", thinking: "", streaming: false },
    ...tick(1, true),
    ...tick(2, true),
    ...tick(3, false),
    ...tick(4, true),
    ...tick(5, null),
  ];
  const out = collapseQuietTicks(items);
  assert.deepEqual(
    out.map((i) => (i.type === "notice" ? i.text : i.id)),
    ["u0", "a0", "2 quiet checks", "u3", "a3", "t3", "1 quiet check", "u5", "a5"],
  );
  // Nothing to fold: the same array.
  const plain: Item[] = [{ type: "user", id: "u", text: "hi" }];
  assert.equal(collapseQuietTicks(plain), plain);
  // A check that changed a file isn't quiet, nor one still running.
  assert.equal(collapseQuietTicks(tick(7, true, { status: "running" })).length, 3);
  const edited: Item[] = [
    ...tick(8, true).slice(0, 1),
    {
      type: "tool",
      id: "e8",
      callId: "c8",
      name: "edit_file",
      args: {},
      status: "done",
      changes: ["a.ts"],
    },
    ...tick(8, true).slice(2),
  ];
  assert.equal(collapseQuietTicks(edited).length, 3);
});

test("validLoops keeps well-formed loops that haven't expired", () => {
  const now = 1000;
  const ok = newLoop("s1", "p", 5 * MINUTE, now);
  assert.deepEqual(validLoops([ok, { session: "x" }, { ...ok, expires: 10 }, null], now + 1), [ok]);
  assert.deepEqual(validLoops("nope", now), []);
});

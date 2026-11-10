import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type BackgroundTask,
  blockedHostsLine,
  capItems,
  chipLines,
  commandStatus,
  splitTasks,
  stepsLabel,
  subagentTitle,
  taskCounts,
  taskTime,
} from "./backgroundTasks";

const task = (over: Partial<BackgroundTask>): BackgroundTask => ({
  kind: "command",
  id: "bg1",
  title: "npm run dev",
  status: "running",
  startedAt: 0,
  endedAt: null,
  canStop: true,
  transcript: false,
  ...over,
});

test("running oldest first, finished newest first; cleared ones left out", () => {
  const tasks = [
    task({ id: "a", startedAt: 20 }),
    task({ id: "b", startedAt: 10 }),
    task({ id: "c", status: "done", startedAt: 1, endedAt: 30 }),
    task({ id: "d", status: "failed", startedAt: 2, endedAt: 50 }),
    task({ id: "e", status: "stopped", startedAt: 3, endedAt: 5 }),
  ];
  const all = splitTasks(tasks);
  assert.deepEqual(
    all.running.map((t) => t.id),
    ["b", "a"],
  );
  assert.deepEqual(
    all.finished.map((t) => t.id),
    ["d", "c", "e"],
  );
  // The trash button at 30: what ended by then goes, what runs stays.
  const cleared = splitTasks(tasks, 30);
  assert.deepEqual(
    cleared.finished.map((t) => t.id),
    ["d"],
  );
  assert.equal(cleared.running.length, 2);
});

test("the chip: what the rows are and how they stand", () => {
  assert.equal(chipLines([]), null);
  const commands = [
    ...Array.from({ length: 12 }, (_, i) => task({ id: `d${i}`, status: "done", endedAt: 1 })),
    task({ id: "f", status: "failed", endedAt: 1 }),
    task({ id: "r1" }),
    task({ id: "r2", kind: "monitor" }),
    task({ id: "r3" }),
  ];
  assert.deepEqual(chipLines(commands), {
    title: "16 background commands",
    detail: "12 completed, 1 failed, 3 running",
  });
  assert.deepEqual(chipLines([task({ kind: "subagent" })]), {
    title: "1 subagent",
    detail: "1 running",
  });
  assert.deepEqual(chipLines([task({ kind: "subagent" }), task({ status: "stopped" })]), {
    title: "2 background tasks",
    detail: "1 stopped, 1 running",
  });
  assert.deepEqual(taskCounts(commands), {
    running: 3,
    serving: 0,
    done: 12,
    failed: 1,
    stopped: 0,
    total: 16,
  });
});

test("servers that are up count as servers, not as running work (D367)", () => {
  const tasks = [
    task({ status: "done" }),
    task({ id: "s1", serving: true }),
    task({ id: "s2", serving: true }),
  ];
  assert.deepEqual(chipLines(tasks), {
    title: "3 background commands",
    detail: "1 completed, 2 servers running",
  });
  assert.deepEqual(chipLines([task({ serving: true }), task({ id: "b" })]), {
    title: "2 background commands",
    detail: "1 running, 1 server running",
  });
});

test("times: live while running, how long once finished, Stopped", () => {
  assert.equal(taskTime(task({ startedAt: 0 }), 65_000), "1m 05s");
  assert.equal(taskTime(task({ status: "done", startedAt: 0, endedAt: 8_000 }), 99_000), "8s");
  assert.equal(taskTime(task({ status: "stopped", endedAt: 8_000 }), 99_000), "Stopped");
});

test("a subagent's steps and title", () => {
  assert.equal(stepsLabel(undefined), null);
  assert.equal(stepsLabel({ total: 0, failed: 0 }), null);
  assert.deepEqual(stepsLabel({ total: 1, failed: 0 }), { text: "1 task", failed: "" });
  assert.deepEqual(stepsLabel({ total: 7, failed: 1 }), { text: "7 tasks", failed: "1 failed" });
  assert.equal(subagentTitle("  Find the  parser ", "long task"), "Find the parser");
  assert.equal(subagentTitle(undefined, "Look at src/a.ts\nand more"), "Look at src/a.ts");
  assert.equal(subagentTitle("", "x".repeat(100)).length, 60);
  assert.equal(subagentTitle(null, "  "), "Subagent");
});

test("a command's status from how it ended", () => {
  assert.equal(commandStatus("running", null), "running");
  assert.equal(commandStatus("exited", 0), "done");
  assert.equal(commandStatus("exited", 2), "failed");
  assert.equal(commandStatus("killed", null), "stopped");
  assert.equal(commandStatus("failed", null), "failed");
});

test("a finished transcript keeps its brief and its end", () => {
  assert.deepEqual(capItems([1, 2, 3], 5), [1, 2, 3]);
  assert.deepEqual(capItems([1, 2, 3, 4, 5, 6], 3), [1, 5, 6]);
  assert.deepEqual(capItems([], 3), []);
});

test("blockedHostsLine: up to three hosts, then how many more (D372)", () => {
  assert.equal(blockedHostsLine(["a.com"]), "Refused by the sandbox: a.com");
  assert.equal(
    blockedHostsLine(["a", "b", "c", "d", "e"]),
    "Refused by the sandbox: a, b, c and 2 more",
  );
});

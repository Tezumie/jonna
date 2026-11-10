import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlanStep } from "./compact";
import type { Item } from "./conversation";
import { applyPlanUpdate, finishPlan, planBeforeLastMessage, planFromItems } from "./plan";

const plan = (...s: PlanStep["status"][]): PlanStep[] =>
  s.map((status, i) => ({ text: `Step ${i + 1}`, status }));
const statuses = (r: ReturnType<typeof applyPlanUpdate>) =>
  "steps" in r ? r.steps.map((s) => s.status) : r.error;

test("D300: the whole list replaces the plan, with one step in progress", () => {
  const r = applyPlanUpdate(plan("done"), {
    steps: [
      { text: "A", status: "in_progress" },
      { text: "B", status: "in_progress" },
      { text: "C", status: "completed" },
    ],
  });
  assert.deepEqual(statuses(r), ["in_progress", "pending", "done"]);
  assert.match(String(statuses(applyPlanUpdate([], { steps: [] }))), /no steps/);
});

test("D300: advance finishes the step in progress and starts the next", () => {
  assert.deepEqual(
    statuses(applyPlanUpdate(plan("done", "in_progress", "pending", "pending"), { advance: true })),
    ["done", "done", "in_progress", "pending"],
  );
  // Nothing in progress: the first step left starts.
  assert.deepEqual(statuses(applyPlanUpdate(plan("done", "pending"), { advance: true })), [
    "done",
    "in_progress",
  ]);
  // The last step: all done.
  assert.deepEqual(statuses(applyPlanUpdate(plan("done", "in_progress"), { advance: "true" })), [
    "done",
    "done",
  ]);
  // A step skipped earlier is picked up once the later ones are done.
  assert.deepEqual(
    statuses(applyPlanUpdate(plan("pending", "done", "in_progress"), { advance: true })),
    ["in_progress", "done", "done"],
  );
});

test("D300: done and start by step number (1-based), out of order", () => {
  assert.deepEqual(
    statuses(
      applyPlanUpdate(plan("in_progress", "pending", "pending", "pending"), {
        done: [1, 2],
        start: 4,
      }),
    ),
    ["done", "done", "pending", "in_progress"],
  );
  assert.deepEqual(statuses(applyPlanUpdate(plan("in_progress", "pending"), { start: "2" })), [
    "pending",
    "in_progress",
  ]);
  assert.match(String(statuses(applyPlanUpdate(plan("pending"), { done: [3] }))), /no step 3/);
  assert.match(String(statuses(applyPlanUpdate([], { advance: true }))), /no plan yet/);
  assert.match(String(statuses(applyPlanUpdate(plan("pending"), {}))), /advance: true/);
});

test("D300: a turn that ends normally finishes the step it was on", () => {
  assert.deepEqual(
    finishPlan(plan("done", "in_progress", "pending")).map((s) => s.status),
    ["done", "done", "pending"],
  );
});

const tool = (id: string, args: unknown, status: "done" | "error" = "done"): Item => ({
  type: "tool",
  id,
  callId: id,
  name: "update_plan",
  args,
  status,
});
const user = (id: string, auto?: "verify"): Item => ({
  type: "user",
  id,
  text: "go",
  ...(auto && { auto }),
});

test("D300: the plan from the conversation's calls, and whether it's from before the last message", () => {
  const items = [
    user("u1"),
    tool("t1", {
      steps: [
        { text: "A", status: "in_progress" },
        { text: "B", status: "pending" },
      ],
    }),
    tool("t2", { advance: true }),
    tool("t3", { done: [9] }, "error"),
  ];
  assert.deepEqual(
    planFromItems(items).map((s) => s.status),
    ["done", "in_progress"],
  );
  assert.equal(planBeforeLastMessage(items), false);
  assert.equal(planBeforeLastMessage([...items, user("u2", "verify")]), false);
  assert.equal(planBeforeLastMessage([...items, user("u2")]), true);
  assert.equal(planBeforeLastMessage([user("u1")]), false);
});

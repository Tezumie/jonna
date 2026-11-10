// The agent's plan updates (D300): the whole list, or a small change to the one it has: `advance`
// (the step in progress done, the next one started), `done` / `start` by step number. Small
// changes ride along with the call that starts the work, so keeping the list current costs no
// extra request. One step is in progress at a time; a turn that ends normally finishes it.
// DOM-free and tested.

import { type PlanStep, parsePlan } from "./compact";
import type { Item } from "./conversation";

export type PlanUpdate = { steps: PlanStep[] } | { error: string };

/** Step numbers from the model (1-based; a number, a string, or a list of either). */
function stepNumbers(v: unknown): number[] {
  const list = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  return list.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
}

/** At most one step in progress: the first one marked so stays, later ones wait. */
function oneInProgress(steps: PlanStep[]): PlanStep[] {
  let seen = false;
  return steps.map((s) => {
    if (s.status !== "in_progress") return s;
    if (!seen) {
      seen = true;
      return s;
    }
    return { ...s, status: "pending" };
  });
}

/** The plan after an update_plan call's arguments, or what was wrong with them. */
export function applyPlanUpdate(prev: readonly PlanStep[], args: unknown): PlanUpdate {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const whole = parsePlan(a);
  if (whole) {
    if (!whole.length) return { error: "The plan has no steps." };
    return { steps: oneInProgress(whole) };
  }
  const done = stepNumbers(a.done);
  const start = stepNumbers(a.start)[0];
  const advance = a.advance === true || a.advance === "true";
  if (!advance && !done.length && start === undefined)
    return {
      error:
        'Give the whole plan as steps: [{ "text": "…", "status": "pending" | "in_progress" | "done" }], or change the current one with advance: true, done: [n] or start: n.',
    };
  if (!prev.length) return { error: "There's no plan yet: send the whole list as steps first." };
  const bad = [...done, ...(start === undefined ? [] : [start])].find((n) => n > prev.length);
  if (bad !== undefined)
    return { error: `The plan has ${prev.length} steps; there's no step ${bad}.` };
  let steps = prev.map((s) => ({ ...s }));
  if (advance) {
    const at = steps.findIndex((s) => s.status === "in_progress");
    const current = steps[at];
    if (current) current.status = "done";
    // The next step not done yet, after the one just finished (else the first one left).
    const after = steps.findIndex((s, i) => i > at && s.status === "pending");
    const nextStep = steps[after >= 0 ? after : steps.findIndex((s) => s.status === "pending")];
    if (nextStep && start === undefined) nextStep.status = "in_progress";
  }
  for (const n of done) {
    const s = steps[n - 1];
    if (s) s.status = "done";
  }
  if (start !== undefined) {
    steps = steps.map((s) => (s.status === "in_progress" ? { ...s, status: "pending" } : s));
    const s = steps[start - 1];
    if (s) s.status = "in_progress";
  }
  return { steps: oneInProgress(steps) };
}

/** A turn that ended normally: the step it was on is done (the model needn't send that call). */
export function finishPlan(steps: readonly PlanStep[]): PlanStep[] {
  return steps.some((s) => s.status === "in_progress")
    ? steps.map((s) => (s.status === "in_progress" ? { ...s, status: "done" } : s))
    : [...steps];
}

/** The plan the conversation's update_plan calls left (all of them, in order). */
export function planFromItems(items: readonly Item[]): PlanStep[] {
  let steps: PlanStep[] = [];
  for (const it of items) {
    if (it.type !== "tool" || it.name !== "update_plan" || it.status !== "done") continue;
    const r = applyPlanUpdate(steps, it.args);
    if ("steps" in r) steps = r.steps;
  }
  return steps;
}

/**
 * Whether the plan was written before the user's latest message (sent since, or while it
 * worked): the panel says so over it, as a plan from before.
 */
export function planBeforeLastMessage(items: readonly Item[]): boolean {
  let lastPlan = -1;
  let lastMessage = -1;
  items.forEach((it, i) => {
    if (it.type === "tool" && it.name === "update_plan") lastPlan = i;
    else if (it.type === "user" && !it.auto) lastMessage = i;
  });
  return lastPlan >= 0 && lastMessage > lastPlan;
}

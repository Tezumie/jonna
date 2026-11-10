// Subagent runs for the Background tasks view (D326): every run of a subagent in this window
// (delegate, explore, a fork, a skill run in a subagent, a background one, the automatic review)
// with its brief, model, times, status and its own conversation, live while it works, so the
// view can show it as the chat shows a turn. Kept per chat: the last KEEP_FINISHED finished ones,
// each with at most KEEP_ITEMS items. Not saved: a restart forgets them (they're gone by then).

import { capItems, type TaskStatus } from "../../core/agent/backgroundTasks";
import type { Item } from "../../core/agent/conversation";
import { type ReadonlySignal, signal } from "../../core/reactive/index";

/** Finished runs a chat keeps. */
const KEEP_FINISHED = 30;
/** What a finished run keeps of its conversation (its brief and its end). */
const KEEP_ITEMS = 400;
/** Redraws while a run streams: at most this often. */
const CHANGE_MS = 150;

export interface SubagentRun {
  readonly id: string;
  /** The chat that started it. */
  readonly session: string;
  /** The agent that runs it (explore, general, a fork…). */
  readonly agent: string;
  readonly title: string;
  /** What it was given (its task). */
  readonly brief: string;
  /** Its model ("provider/model"), or null: the chat's. */
  readonly model: string | null;
  readonly background: boolean;
  readonly startedAt: number;
  endedAt: number | null;
  status: TaskStatus;
  /** Its conversation: the loop's own list while it runs (live), a capped copy once it ends. */
  items: Item[];
  /** Stops it (at its next step; its model request is cancelled when it has its own). */
  stop(): void;
}

export class SubagentRuns {
  private readonly runs = new Map<string, SubagentRun>();
  private readonly changes = signal(0);
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Bumps when a run starts, ends or its conversation grows (throttled). */
  readonly version: ReadonlySignal<number> = this.changes;

  private bump(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.changes.value = this.changes.peek() + 1;
  }

  begin(run: Omit<SubagentRun, "endedAt" | "status">): SubagentRun {
    const full: SubagentRun = { ...run, endedAt: null, status: "running" };
    this.runs.set(run.id, full);
    this.bump();
    return full;
  }

  /** Its conversation changed (a streamed reply, a tool call): redrawn shortly. */
  changed(): void {
    if (this.timer === undefined) this.timer = setTimeout(() => this.bump(), CHANGE_MS);
  }

  end(id: string, status: Exclude<TaskStatus, "running">): void {
    const run = this.runs.get(id);
    if (run?.status !== "running") return;
    run.status = status;
    run.endedAt = Date.now();
    run.items = capItems(run.items, KEEP_ITEMS);
    this.forgetOld(run.session);
    this.bump();
  }

  get(id: string): SubagentRun | undefined {
    return this.runs.get(id);
  }

  /** A chat's runs (or every chat's), oldest first. */
  list(session?: string): SubagentRun[] {
    return [...this.runs.values()].filter((r) => !session || r.session === session);
  }

  /** Forgets a chat's finished runs (the view's trash button). Returns how many. */
  clearFinished(session: string): number {
    let n = 0;
    for (const r of this.list(session))
      if (r.status !== "running") {
        this.runs.delete(r.id);
        n++;
      }
    if (n) this.bump();
    return n;
  }

  /** The chat was deleted: its runs go (running ones were stopped with it). */
  forgetSession(session: string): void {
    for (const r of this.list(session)) this.runs.delete(r.id);
    this.bump();
  }

  private forgetOld(session: string): void {
    const ended = this.list(session).filter((r) => r.status !== "running");
    for (const r of ended.slice(0, Math.max(0, ended.length - KEEP_FINISHED)))
      this.runs.delete(r.id);
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}

/** The window's subagent runs (one agent extension per window). */
export const subagentRuns = new SubagentRuns();

/** A run's own tool calls: how many, how many failed. */
export function runSteps(run: SubagentRun): { total: number; failed: number } {
  let total = 0;
  let failed = 0;
  for (const i of run.items)
    if (i.type === "tool") {
      total++;
      if (i.status === "error") failed++;
    }
  return { total, failed };
}

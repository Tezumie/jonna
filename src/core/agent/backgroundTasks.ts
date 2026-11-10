// The Background tasks view (D326, after Claude Code's app): everything a chat has working on
// its own, in one list. Subagents (delegate, explore, forks, helpers in worktrees), background
// commands and monitors, a watched pull request. The DOM-free part: the rows' shape, running and
// finished, the chip's two lines under the conversation, times and counts.

import { formatElapsed } from "./chatDetails";

export type TaskKind = "subagent" | "helper" | "command" | "monitor" | "pr";
export type TaskStatus = "running" | "done" | "failed" | "stopped";

export interface BackgroundTask {
  kind: TaskKind;
  /** The run's id: "s…"/"b…" (a subagent), a helper's chat id, "bg3" (a command). */
  id: string;
  /** What it is: a subagent's short description, a command's purpose or line. */
  title: string;
  /** The second line: the agent's name, the command line, the address. */
  detail?: string;
  status: TaskStatus;
  startedAt: number;
  endedAt: number | null;
  /** A subagent's own tool calls: how many, how many failed. */
  steps?: { total: number; failed: number };
  /** Stop is offered (it runs and the IDE can stop it). */
  canStop: boolean;
  /** Its work can be shown as a transcript (subagents, helpers working in this window). */
  transcript: boolean;
  /** D352: a watched pull request's auto-merge is on. */
  autoMerge?: boolean;
  /**
   * A running command that serves an address (a dev server, D367): it's up, not working toward
   * an end, so it shows a server icon, not a spinner, and counts as a server.
   */
  serving?: boolean;
  /** Hosts the command sandbox refused a background command (D372). */
  blockedHosts?: readonly string[];
}

/** "Refused by the sandbox: a.com, b.com and 3 more" (D372). */
export function blockedHostsLine(hosts: readonly string[]): string {
  const shown = hosts.slice(0, 3).join(", ");
  const more = hosts.length - 3;
  return `Refused by the sandbox: ${shown}${more > 0 ? ` and ${more} more` : ""}`;
}

/** Finished rows shown before "Show more". */
export const FINISHED_SHOWN = 10;

/**
 * The view's two sections: running ones oldest first (as they were started), finished ones
 * newest first. Finished before `clearedAt` (the trash button) are left out.
 */
export function splitTasks(
  tasks: readonly BackgroundTask[],
  clearedAt = 0,
): { running: BackgroundTask[]; finished: BackgroundTask[] } {
  const running = tasks
    .filter((t) => t.status === "running")
    .sort((a, b) => a.startedAt - b.startedAt);
  const finished = tasks
    .filter((t) => t.status !== "running" && (t.endedAt ?? t.startedAt) > clearedAt)
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
  return { running, finished };
}

export interface TaskCounts {
  /** Running and working (not a server that's up). */
  running: number;
  /** Servers up (D367). */
  serving: number;
  done: number;
  failed: number;
  stopped: number;
  total: number;
}

export function taskCounts(tasks: readonly BackgroundTask[]): TaskCounts {
  const count = (s: TaskStatus) => tasks.filter((t) => t.status === s).length;
  const serving = tasks.filter((t) => t.status === "running" && t.serving).length;
  return {
    running: count("running") - serving,
    serving,
    done: count("done"),
    failed: count("failed"),
    stopped: count("stopped"),
    total: tasks.length,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the rows are, in one word: commands, subagents, or tasks when they're mixed. */
function noun(tasks: readonly BackgroundTask[]): [string, string] {
  const commands = tasks.every((t) => t.kind === "command" || t.kind === "monitor");
  const agents = tasks.every((t) => t.kind === "subagent" || t.kind === "helper");
  return commands
    ? ["background command", "background commands"]
    : agents
      ? ["subagent", "subagents"]
      : ["background task", "background tasks"];
}

/**
 * The chip under the conversation (Claude Code's "12 background commands completed, 1 failed, 3
 * running"): its title and the counts. Null when there's nothing to show.
 */
export function chipLines(
  tasks: readonly BackgroundTask[],
): { title: string; detail: string } | null {
  if (!tasks.length) return null;
  const c = taskCounts(tasks);
  const [one, many] = noun(tasks);
  const title = plural(c.total, one, many);
  const parts = [
    ...(c.done ? [`${c.done} completed`] : []),
    ...(c.failed ? [`${c.failed} failed`] : []),
    ...(c.stopped ? [`${c.stopped} stopped`] : []),
    ...(c.running ? [`${c.running} running`] : []),
    ...(c.serving ? [`${plural(c.serving, "server")} running`] : []),
  ];
  return { title, detail: parts.join(", ") };
}

/** The time on a row: how long it has run (live), how long it ran, or "Stopped". */
export function taskTime(task: BackgroundTask, now: number): string {
  if (task.status === "running") return formatElapsed(now - task.startedAt);
  if (task.status === "stopped") return "Stopped";
  return formatElapsed((task.endedAt ?? now) - task.startedAt);
}

/** A subagent's "N tasks" line and its failures ("1 failed"), or null before its first call. */
export function stepsLabel(
  steps: BackgroundTask["steps"],
): { text: string; failed: string } | null {
  if (!steps || steps.total === 0) return null;
  return {
    text: plural(steps.total, "task"),
    failed: steps.failed ? `${steps.failed} failed` : "",
  };
}

/** A subagent's title: the short description it was given, else its task's first line. */
export function subagentTitle(description: unknown, task: string): string {
  const own = typeof description === "string" ? description.trim().replace(/\s+/g, " ") : "";
  if (own) return own.length > 80 ? `${own.slice(0, 79)}…` : own;
  const first = task.trim().split("\n")[0]?.trim() ?? "";
  const line = first.replace(/\s+/g, " ");
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || "Subagent";
}

/** A command's status from how it ended. */
export function commandStatus(
  status: "running" | "exited" | "killed" | "failed",
  exitCode: number | null,
): TaskStatus {
  if (status === "running") return "running";
  if (status === "killed") return "stopped";
  if (status === "failed") return "failed";
  return exitCode === 0 || exitCode === null ? "done" : "failed";
}

/**
 * What a finished subagent's transcript keeps: its brief (the first item) and its last `max - 1`
 * items. A running one keeps everything (its loop owns the list).
 */
export function capItems<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  const first = items[0];
  return first === undefined ? [] : [first, ...items.slice(items.length - (max - 1))];
}

// Helpers in their own git worktree (D231, like Claude Code's `isolation: worktree` subagents and
// Cursor's parallel agents): `delegate` with `isolated: true` (or an agent whose file says
// `isolation: worktree`) starts a worktree agent (D193) for that agent instead of running it in
// this chat. When it finishes, its report comes back to the chat that started it, and the user
// reviews and merges its changes. This is the DOM-free part: when to isolate, the cap, how a
// helper's state follows its worktree chat, the messages, and the stop requests one window
// leaves for another. The extension is extensions/agent/isolatedHelpers.ts.

import type { WorktreeProgress } from "./worktrees";

export type HelperState =
  | "starting"
  | "working"
  | "waiting"
  | "stopping"
  | "done"
  | "error"
  | "stopped";

export const FINISHED_STATES: ReadonlySet<HelperState> = new Set(["done", "error", "stopped"]);

export const DEFAULT_HELPER_CAP = 3;

/** `agent.isolatedHelpers.max`: how many may work at once (1–10, default 3). */
export function helperCap(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw)
    ? Math.max(1, Math.min(10, Math.floor(raw)))
    : DEFAULT_HELPER_CAP;
}

/**
 * Whether a delegated task runs in a worktree: the call's `isolated` when it gives one (false runs
 * it in this chat even for an agent that isolates), else the agent's `isolation: worktree`.
 */
export function wantsIsolation(arg: unknown, def: { isolation?: "worktree" }): boolean {
  if (typeof arg === "boolean") return arg;
  return def.isolation === "worktree";
}

/**
 * Why an isolated helper can't start now (a tool error the model can act on), or null. The model
 * can always delegate without `isolated` instead.
 */
export function isolationRefusal(input: {
  agent: string;
  readOnly: boolean;
  /** The chat delegating can't change files (Ask or Plan mode, a read-only agent). */
  parentReadOnly?: boolean;
  gitRepo: boolean;
  running: number;
  max: number;
  /** The chat delegating is itself a helper working in a worktree (headless). */
  nested?: boolean;
}): string | null {
  if (input.nested)
    return `Error: you're a helper in a worktree yourself, so you can't start helpers in worktrees of your own. Delegate without isolated, or do it yourself.`;
  if (input.parentReadOnly)
    return `Error: this chat can't change files (its mode only reads), so it can't start a helper that does. Delegate without isolated.`;
  if (!input.gitRepo)
    return `Error: this folder isn't a git repository, so ${input.agent} can't work in a worktree of its own. Delegate without isolated (it then works in this chat), or do the task yourself.`;
  if (input.readOnly)
    return `Error: ${input.agent} only reads, so a worktree of its own gains nothing. Delegate without isolated.`;
  if (input.running >= input.max)
    return `Error: ${input.running} helper${input.running === 1 ? " already works" : "s already work"} in worktrees (the limit, agent.isolatedHelpers.max, is ${input.max}). Wait for a report, or delegate without isolated.`;
  return null;
}

/** A helper's branch: "agent/<agent>-<first task words>" (agent.startInWorktree adds -2… when taken). */
export function helperBranch(agent: string, task: string): string {
  const slug = (text: string, words: number) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .split("-")
      .filter(Boolean)
      .slice(0, words)
      .join("-");
  return `agent/${[slug(agent, 3) || "helper", slug(task, 4)].filter(Boolean).join("-")}`;
}

/** What a saved chat says about its answer: the last reply after the last message the user sent. */
export function finalReply(saved: unknown): { replied: boolean; report: string; error: string } {
  const none = { replied: false, report: "", error: "" };
  if (!saved || typeof saved !== "object") return none;
  const items = (saved as { items?: unknown }).items;
  if (!Array.isArray(items)) return none;
  let lastUser = -1;
  let report = "";
  let reportAt = -1;
  let error = "";
  for (const [i, raw] of items.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const it = raw as { type?: unknown; text?: unknown; auto?: unknown; tone?: unknown };
    // Automatic messages (a "continue", a subagent's report) don't start a new task.
    if (it.type === "user" && it.auto === undefined) lastUser = i;
    if (it.type === "assistant" && typeof it.text === "string" && it.text.trim()) {
      report = it.text.trim();
      reportAt = i;
    }
    if (it.type === "notice" && it.tone === "error" && typeof it.text === "string") error = it.text;
  }
  return { replied: reportAt > lastUser && lastUser >= 0, report, error };
}

/** A helper whose chat is idle without a reply this long after it started has given up. */
export const NO_REPLY_MS = 3 * 60_000;

/**
 * A helper's state from its worktree agent's progress (core/agent/worktrees.ts) and, once that
 * says it ended, its saved chat. `finished` means its report (or why there is none) is due.
 */
export function helperOutcome(
  progress: WorktreeProgress | undefined,
  saved: unknown,
  ctx: { stopRequested: boolean; startedAt: number; now: number },
): { state: HelperState; finished: boolean; report: string } {
  const reply = finalReply(saved);
  const end = (state: HelperState, report: string) => ({ state, finished: true, report });
  switch (progress) {
    case undefined:
    case "gone":
    case "stopped":
      return end("stopped", reply.report);
    case "error":
      return end("error", reply.error || reply.report);
    case "starting":
    case "working":
    case "waiting":
      return {
        state: ctx.stopRequested ? "stopping" : progress === "starting" ? "starting" : progress,
        finished: false,
        report: "",
      };
    case "done":
      if (ctx.stopRequested) return end("stopped", reply.report);
      if (reply.replied) return end("done", reply.report);
      // Saved before its first turn ran: still starting, unless that never happens.
      if (ctx.now - ctx.startedAt > NO_REPLY_MS) return end("done", "");
      return { state: "starting", finished: false, report: "" };
  }
}

export interface HelperSummary {
  label: string;
  branch: string;
  state: HelperState;
  report: string;
  files?: number;
  added?: number;
  removed?: number;
  /** Runs in the window that started it (no window of its own). */
  headless?: boolean;
}

/** "3 files changed (+20 −4)", or "" when unknown. */
export function changesText(h: Pick<HelperSummary, "files" | "added" | "removed">): string {
  if (h.files === undefined) return "";
  if (h.files === 0) return "no files changed";
  return `${h.files} file${h.files === 1 ? "" : "s"} changed (+${h.added ?? 0} −${h.removed ?? 0})`;
}

const REPORT_LIMIT = 12_000;

/** The message the chat that started a helper gets when it ends. */
export function helperReport(h: HelperSummary): string {
  const changes = changesText(h);
  const where = `its own git worktree, branch ${h.branch}`;
  const merge = `Its changes are not in this folder: the user reviews and merges them (or, when the user asks, agent.applyWorktree with agent "${h.branch}" brings them in).`;
  const body = h.report.trim().slice(0, REPORT_LIMIT);
  const head =
    h.state === "error"
      ? `Helper ${h.label} stopped on an error (it worked in ${where}).`
      : h.state === "stopped"
        ? `Helper ${h.label} was stopped before it finished (it worked in ${where}).`
        : `Report from helper ${h.label} (it worked in ${where}).`;
  return [
    head,
    [changes && `${changes[0]?.toUpperCase()}${changes.slice(1)}.`, merge]
      .filter(Boolean)
      .join(" "),
    body || (h.state === "done" ? "(It wrote no report.)" : ""),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The chat's line for a helper: what it does now. */
export function helperStatusText(h: Omit<HelperSummary, "report">): string {
  const changes = changesText(h);
  const tail = changes ? ` · ${changes}` : "";
  switch (h.state) {
    case "starting":
      return `${h.label} is setting up a worktree (${h.branch})…`;
    case "working":
      return `${h.label} is working in a worktree (${h.branch})…${tail}`;
    case "waiting":
      return `${h.label} is waiting for you in its ${h.headless ? "chat" : "window"} (${h.branch})${tail}`;
    case "stopping":
      return `Stopping ${h.label} (${h.branch})…`;
    case "done":
      return `${h.label} finished in ${h.branch}${tail}`;
    case "error":
      return `${h.label} stopped on an error in ${h.branch}${tail}`;
    case "stopped":
      return `${h.label} was stopped (${h.branch})${tail}`;
  }
}

/** The first message a helper's window sends its chat. */
export function helperTask(opts: {
  from: string;
  branch: string;
  task: string;
  label?: string;
  instructions?: string;
}): string {
  const own = opts.instructions?.trim();
  return [
    `You're a helper: a chat in ${opts.from} handed you this task. You work in a git worktree of it: this folder, on branch ${opts.branch}. Commit your work on this branch when it's done; don't switch branches. End with a report for that chat (it sees only your last message): what you changed (files), how you checked it, and what's left or uncertain.`,
    own ? `Your instructions${opts.label ? ` as ${opts.label}` : ""}:\n\n${own}` : "",
    `The task:\n\n${opts.task}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ---- Stop requests: one window asks another to stop (windows share only files) ----------------

export interface StopRequest {
  /** The helper's chat id. */
  id: string;
  at: number;
}

/** A stop request older than this is dropped (its window has gone, or it was handled). */
export const STOP_TTL = 10 * 60_000;

export function sanitizeStops(raw: unknown): StopRequest[] {
  return Array.isArray(raw)
    ? raw.filter(
        (x): x is StopRequest =>
          !!x &&
          typeof x === "object" &&
          typeof (x as StopRequest).id === "string" &&
          typeof (x as StopRequest).at === "number",
      )
    : [];
}

/** The list with a request to stop `id` (old ones dropped). */
export function withStop(
  list: readonly StopRequest[] | undefined,
  id: string,
  now: number,
): StopRequest[] {
  return [...(list ?? []).filter((r) => r.id !== id && now - r.at < STOP_TTL), { id, at: now }];
}

/** The list without `id`'s request (old ones dropped). */
export function withoutStop(
  list: readonly StopRequest[] | undefined,
  id: string,
  now: number,
): StopRequest[] {
  return (list ?? []).filter((r) => r.id !== id && now - r.at < STOP_TTL);
}

export function stopRequested(
  list: readonly StopRequest[] | undefined,
  id: string,
  now: number,
): boolean {
  return (list ?? []).some((r) => r.id === id && now - r.at < STOP_TTL);
}

// ---- Headless helpers (D246): a helper's chat in the delegating window's process ----------------------

/**
 * `agent.isolatedHelpers.window`: true gives each helper a window of its own (D231's way); false
 * (the default) runs it headless, in this window, its tools working in its worktree.
 */
export function helpersInWindows(raw: unknown): boolean {
  return raw === true;
}

/** What a headless helper's progress is read from: its chat, here in this window. */
export interface HeadlessChat {
  status: "idle" | "running" | "waiting";
  /** Its last turn ended on an error. */
  error: boolean;
  /** Its items (the saved form's shape: type, text, tone, auto). */
  items: readonly unknown[];
}

/**
 * A headless helper's progress, as `progressFromChat` gives a window's: working while its turn
 * runs, waiting on a question, done (or stopped, or error) once idle. `gone`: its chat isn't
 * here any more (the window restarted, the chat was deleted).
 */
export function headlessProgress(chat: HeadlessChat | undefined): WorktreeProgress {
  if (!chat) return "gone";
  if (chat.status === "running") return "working";
  if (chat.status === "waiting") return "waiting";
  if (chat.error) return "error";
  // Stopped (its own Stop, the folder closing): its turn ends with a "Stopped" notice after the
  // last message it was given.
  for (let i = chat.items.length - 1; i >= 0; i--) {
    const it = chat.items[i] as { type?: unknown; text?: unknown; auto?: unknown } | null;
    if (!it || typeof it !== "object") continue;
    if (it.type === "user" && it.auto === undefined) break;
    if (it.type === "assistant") break;
    if (it.type === "notice" && typeof it.text === "string" && it.text.startsWith("Stopped"))
      return "stopped";
  }
  return "done";
}

/**
 * Where a headless helper's tool path lands: inside its worktree as given; a path in the main
 * folder (the system prompt names that one) on the same place in the worktree, so the helper
 * never touches the main folder. Null when it's in neither.
 */
export function helperPath(
  abs: string,
  worktree: string,
  main: string | null,
  paths: {
    isWithin(root: string, path: string): boolean;
    rebase(from: string, to: string, path: string): string;
  },
): string | null {
  if (paths.isWithin(worktree, abs)) return abs;
  if (main && paths.isWithin(main, abs)) return paths.rebase(main, worktree, abs);
  return null;
}

/**
 * IDE commands that act on the window's open folder (its files, editors, git, terminals, search):
 * a headless helper's call_command refuses them, since its work belongs in its worktree. Reading
 * the IDE's state, the web and the browser stay.
 */
const WINDOW_FOLDER_NAMESPACES = [
  "editor",
  "explorer",
  "fs",
  "git",
  "scm",
  "search",
  "quickOpen",
  "workspace",
  "terminal",
  "tasks",
  "debug",
  "testing",
  "test",
  "lsp",
  "notebook",
  "files",
];

export function actsOnWindowFolder(id: string): boolean {
  const ns = id.split(".")[0] ?? "";
  return WINDOW_FOLDER_NAMESPACES.includes(ns);
}

/** The first message a headless helper's chat gets (helperTask, plus where it is). */
export function headlessHelperTask(opts: {
  from: string;
  folder: string;
  branch: string;
  task: string;
  label?: string;
  instructions?: string;
}): string {
  const where = `Your folder is ${opts.folder} (a git worktree of ${opts.from}, on branch ${opts.branch}). Your file tools, searches and commands work there; give paths relative to it. You run inside the IDE window of ${opts.from}, so IDE commands through call_command that act on files, editors, git or terminals reach that folder instead and are refused: use read_file, edit_file, write_file, search and run_command.`;
  return `${helperTask(opts)}\n\n${where}`;
}

// ---- Follow-ups to a running helper ------------------------------------------------------------

/** A message for a window helper, left in the global state (windows share only files). */
export interface HelperMessage {
  /** The helper's chat id. */
  id: string;
  /** Its own id (delivered once). */
  msg: string;
  text: string;
  at: number;
}

/** A message older than this is dropped (its window has gone, or its turn ended). */
export const MESSAGE_TTL = 30 * 60_000;

export function sanitizeMessages(raw: unknown): HelperMessage[] {
  return Array.isArray(raw)
    ? raw.filter(
        (x): x is HelperMessage =>
          !!x &&
          typeof x === "object" &&
          typeof (x as HelperMessage).id === "string" &&
          typeof (x as HelperMessage).msg === "string" &&
          typeof (x as HelperMessage).text === "string" &&
          typeof (x as HelperMessage).at === "number",
      )
    : [];
}

/** The list with one more message (old ones dropped). */
export function withMessage(
  list: readonly HelperMessage[] | undefined,
  message: HelperMessage,
  now: number,
): HelperMessage[] {
  return [...(list ?? []).filter((m) => now - m.at < MESSAGE_TTL), message];
}

/** A helper's messages, oldest first (fresh ones only). */
export function messagesFor(
  list: readonly HelperMessage[] | undefined,
  id: string,
  now: number,
): HelperMessage[] {
  return (list ?? []).filter((m) => m.id === id && now - m.at < MESSAGE_TTL);
}

/** The list without the messages `taken` (old ones dropped). */
export function withoutMessages(
  list: readonly HelperMessage[] | undefined,
  taken: readonly string[],
  now: number,
): HelperMessage[] {
  return (list ?? []).filter((m) => !taken.includes(m.msg) && now - m.at < MESSAGE_TTL);
}

/** How a follow-up from the chat that started a helper reads in the helper's chat. */
export function followUpText(text: string): string {
  return `A message from the chat that started you (your report still goes to it when you finish):\n\n${text.trim()}`;
}

// The Background tasks view (D326, D327; after Claude Code's app): one list over everything a
// chat has working on its own — its subagents (delegate, explore, forks, skills run in a
// subagent, the automatic review; subagentRuns.ts), its helpers in worktrees (D231), its
// background commands and monitors (D201, D322, D328) and its watched pull request (D323).
// Running and finished, a stop button on each running one; a subagent opens as a transcript.
// agent.showBackgroundTasks opens it beside the chat; the chip under the conversation
// (view/backgroundChip.ts) opens it too. State: ide://agent/background.

import {
  type BackgroundTask,
  chipLines,
  commandStatus,
  splitTasks,
  subagentTitle,
  type TaskStatus,
} from "../../core/agent/backgroundTasks";
import type { HelperState } from "../../core/agent/isolatedHelpers";
import type { DisposableStore } from "../../core/lifecycle/index";
import { type ReadonlySignal, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { DockService } from "../../workbench/dock/service";
import { stateField } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { backgroundProcesses } from "./backgroundProcesses";
import type { IsolatedHelpers } from "./isolatedHelpers";
import { prWatches, prWatchOf } from "./prWatches";
import type { SessionManager } from "./sessions";
import { runSteps, subagentRuns } from "./subagentRuns";
import { THREAD_VIEW } from "./threadTabs";
import { BACKGROUND_TASKS_VIEW, backgroundTasksView, showTaskIn } from "./view/backgroundTasks";

/** When each chat's list was last cleared (the trash button): finished before then are hidden. */
const cleared = signal<ReadonlyMap<string, number>>(new Map());
/** When this window first saw a chat's pull request watch (it doesn't record its start). */
const prSeen = new Map<string, { number: number; at: number }>();

const helperStatus = (state: HelperState): TaskStatus =>
  state === "done"
    ? "done"
    : state === "error"
      ? "failed"
      : state === "stopped"
        ? "stopped"
        : "running";

/** What the view and the chip read: the tasks of one chat and how to act on them. */
export interface BackgroundTaskSource {
  /** Reactive: an effect reading it follows the chat's tasks. Cleared ones are left out. */
  tasks(session: string): BackgroundTask[];
  /** A helper's chat when it runs in this window (its transcript), else null. */
  helperSession(id: string): string | null;
}

/** The window's source (set by registerBackgroundTasks; the chat view's chip reads it). */
export const backgroundTaskSource = signal<BackgroundTaskSource | null>(null);

function tasksOf(
  session: string,
  helpers: ReadonlySignal<IsolatedHelpers | null>,
  sessions: SessionManager,
): BackgroundTask[] {
  subagentRuns.version.value;
  backgroundProcesses.version.value;
  prWatches.value;
  const clearedAt = cleared.value.get(session) ?? 0;
  const out: BackgroundTask[] = [];
  for (const run of subagentRuns.list(session))
    out.push({
      kind: "subagent",
      id: run.id,
      title: run.title,
      detail: run.agent,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      steps: runSteps(run),
      canStop: run.status === "running",
      transcript: true,
    });
  for (const h of helpers.value?.list.value ?? []) {
    if (h.parent !== session) continue;
    const chat = sessions.find(h.id);
    const status = helperStatus(h.state);
    let total = 0;
    let failed = 0;
    for (const i of chat?.items ?? [])
      if (i.type === "tool") {
        total++;
        if (i.status === "error") failed++;
      }
    out.push({
      kind: "helper",
      id: h.id,
      title: subagentTitle(null, h.task),
      detail: `${h.label} · ${h.branch}`,
      status,
      startedAt: h.startedAt,
      endedAt: status === "running" ? null : (h.finishedAt ?? h.startedAt),
      ...(chat && { steps: { total, failed } }),
      canStop: status === "running" && h.state !== "stopping",
      transcript: true,
    });
  }
  for (const p of backgroundProcesses.list(session))
    out.push({
      kind: p.monitor ? "monitor" : "command",
      id: p.id,
      title: p.monitor ? p.monitor.description : p.command,
      detail: p.monitor ? p.command : (p.urls[0] ?? (p.cwd !== "." ? `in ${p.cwd}` : undefined)),
      status: commandStatus(p.status, p.exitCode),
      startedAt: p.startedAt,
      endedAt: p.endedAt,
      canStop: p.status === "running",
      transcript: false,
      // Up and listening (D367): a server, not a spinner.
      ...(p.status === "running" && !p.monitor && p.urls.length > 0 && { serving: true }),
      ...(p.blockedHosts?.length && { blockedHosts: p.blockedHosts }),
    });
  const pr = prWatchOf(session);
  if (pr) {
    const seen = prSeen.get(session);
    const at = seen?.number === pr.number ? seen.at : Date.now();
    prSeen.set(session, { number: pr.number, at });
    out.push({
      kind: "pr",
      id: `pr${pr.number}`,
      title: `Watching pull request #${pr.number}${pr.autoMerge ? " · auto-merge" : ""}`,
      detail: pr.lastError ? `Last look failed: ${pr.lastError}` : (pr.status ?? pr.title),
      status: "running",
      startedAt: at,
      endedAt: null,
      canStop: true,
      transcript: false,
      autoMerge: !!pr.autoMerge,
    });
  } else prSeen.delete(session);
  return out.filter((t) => t.status === "running" || (t.endedAt ?? t.startedAt) > clearedAt);
}

/** Where the view opens: beside the chat (a group split to its right), else the right region. */
function besideChat(dock: DockService): { groupId: string; split: "right" } | "right" {
  const chat = dock.recentTab((t) => t.viewType === THREAD_VIEW);
  const group = chat ? dock.findTab(chat.id)?.group : undefined;
  return group ? { groupId: group.id, split: "right" } : "right";
}

export function registerBackgroundTasks(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
  helpers: IsolatedHelpers | null,
): void {
  const { dispatcher, dock, state } = services;
  const helperSignal = signal<IsolatedHelpers | null>(helpers);
  const source: BackgroundTaskSource = {
    tasks: (session) => tasksOf(session, helperSignal, sessions),
    helperSession: (id) => {
      const chat = sessions.find(id);
      return chat ? chat.id : null;
    },
  };
  backgroundTaskSource.value = source;
  sub.add({
    dispose: () => {
      backgroundTaskSource.value = null;
      subagentRuns.dispose();
    },
  });
  sub.add(dock.views.register(backgroundTasksView(services, sessions, source)));
  const register: typeof dispatcher.register = (c) =>
    sub.add(dispatcher.register({ category: "Agent", ...c }));
  const sessionInput = s.string().describe("Chat (session) id; default: the active one").optional();
  const chatOf = (id: string | undefined) => sessions.require(id).id;

  register({
    id: "agent.showBackgroundTasks",
    title: "Show background tasks",
    description:
      "Opens a chat's Background tasks view (D326) beside it: its subagents, worktree helpers, background commands and monitors, and its watched pull request, running and finished, each with Stop. `task` opens a subagent's (or helper's) transcript in it.",
    input: s.object({
      session: sessionInput,
      task: s.string().describe("A subagent run or helper id to open").optional(),
    }),
    effects: [],
    run: ({ session, task }) => {
      const id = chatOf(session);
      const viewState = { session: id, ...(task && { task }) };
      const open = dock
        .tabs(BACKGROUND_TASKS_VIEW)
        .find((t) => stateField(t.viewState, "session") === id);
      if (open) {
        dock.activateTab(open.id, true);
        showTaskIn(open.id, task ?? null);
        return { tab: open.id, session: id };
      }
      return {
        tab: dock.openView(BACKGROUND_TASKS_VIEW, viewState, besideChat(dock), true),
        session: id,
      };
    },
  });

  register({
    id: "agent.stopBackgroundTask",
    title: "Stop a background task",
    description:
      "Stops one of a chat's background tasks by its id (D326): a subagent run, a worktree helper, a background command or monitor (bg3), or the pull request watch (pr12).",
    input: s.object({ session: sessionInput, id: s.string() }),
    effects: ["exec"],
    run: async ({ session, id }) => {
      const chat = chatOf(session);
      const task = source.tasks(chat).find((t) => t.id === id);
      if (!task)
        throw new Error(
          `No background task "${id}" in this chat (ide://agent/background lists them).`,
        );
      if (task.status !== "running") return { id, stopped: false };
      switch (task.kind) {
        case "subagent":
          subagentRuns.get(id)?.stop();
          return { id, stopped: true };
        case "helper":
          return { id, stopped: (await helpers?.stop(id)) ?? false };
        case "command":
        case "monitor":
          return { id, stopped: await backgroundProcesses.kill(id) };
        case "pr":
          await dispatcher.execute("agent.unwatchPullRequest", { session: chat });
          return { id, stopped: true };
      }
    },
  });

  register({
    id: "agent.clearBackgroundTasks",
    title: "Clear finished background tasks",
    description:
      "Clears a chat's finished background tasks from its Background tasks view and chip (D326); running ones stay. Finished commands' output can still be read with process_output.",
    input: s.object({ session: sessionInput }),
    effects: ["write"],
    run: ({ session }) => {
      const chat = chatOf(session);
      const finished = splitTasks(source.tasks(chat)).finished.length;
      const next = new Map(cleared.peek());
      next.set(chat, Date.now());
      cleared.value = next;
      subagentRuns.clearFinished(chat);
      return { session: chat, cleared: finished };
    },
  });

  sub.add(
    state.register("ide://agent/background", {
      description:
        "A chat's background tasks (`?session=<id>`, default the active chat; D326): what its Background tasks view lists. Running and finished (newest first), each with kind (subagent, helper, command, monitor, pr), id, title, detail, status (running, done, failed, stopped), start and end, a subagent's tool calls (steps, failed), serving for a command that's up at an address (a server, D367), blockedHosts the command sandbox refused a command or monitor (D372); the chip's two lines. Stop one with agent.stopBackgroundTask, clear finished with agent.clearBackgroundTasks, open the view with agent.showBackgroundTasks.",
      get: ({ params }) => {
        const chat = sessions.find(params.session);
        if (!chat) return null;
        const tasks = source.tasks(chat.id);
        const { running, finished } = splitTasks(tasks);
        const describe = (t: BackgroundTask) => ({
          kind: t.kind,
          id: t.id,
          title: t.title,
          ...(t.detail && { detail: t.detail }),
          status: t.status,
          startedAt: new Date(t.startedAt).toISOString(),
          ...(t.endedAt !== null && { endedAt: new Date(t.endedAt).toISOString() }),
          ...(t.steps && { steps: t.steps.total, failedSteps: t.steps.failed }),
          ...(t.serving && { serving: true }),
          ...(t.blockedHosts && { blockedHosts: t.blockedHosts }),
        });
        return {
          session: chat.id,
          chip: chipLines(tasks),
          running: running.map(describe),
          finished: finished.map(describe),
          open: dock
            .tabs(BACKGROUND_TASKS_VIEW)
            .some((t) => stateField(t.viewState, "session") === chat.id),
        };
      },
    }),
  );
}

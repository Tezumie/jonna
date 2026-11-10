// Subagents of an agent session (D127, D195; split from session.ts in D221): a run in the turn
// (explore, general, the user's own), its model and requests, background runs whose reports come
// back as messages, and the automatic review after a turn that changed files.

import { subagentTitle } from "../../core/agent/backgroundTasks";
import { charsFor, type Item } from "../../core/agent/conversation";
import { isTransientError, type LoopDeps, retryDelayMs, runTurn } from "../../core/agent/loop";
import { resolveModelName } from "../../core/agent/subagents";
import { aiIpc, type ModelDetails } from "../../core/ipc/agent";
import { newId } from "./ids";
import type { ModelChoice } from "./providers";
import { rulesFor } from "./rules";
import type { AgentSession } from "./session";
import { sendNow } from "./sessionTurn";
import { RULE_TOOLS } from "./sessionTypes";
import { contextLengthFor, requestOptions, thinkFor } from "./sessionUsage";
import { subagentRuns } from "./subagentRuns";
import type { SubagentSpec } from "./tools";
import { priceOf } from "./usage";
import { recordUsage } from "./usageLog";

/**
 * A sub-agent run (explore, D127): its own conversation on the same model, only `spec.tools`,
 * then — if it used up its steps without answering — one more call without tools for the report.
 */
export async function runSubagent(
  session: AgentSession,
  spec: SubagentSpec,
  deps: LoopDeps,
  budgetChars: number,
  setSystem: (system: string | null) => void,
  fallback?: { choice: ModelChoice; details: ModelDetails },
  /** Follow-ups sent while it works (D245): taken before each of its model calls. */
  inbox?: Item[],
  /** Its own requests on the turn's model (another subagent is using the turn's, D253). */
  ownRequests = false,
): Promise<string> {
  // The tools it's given, deferred ones (D319) with their definitions: its list doesn't grow.
  const tools = session
    .callableTools()
    .filter((t) => spec.tools.includes(t.spec.name))
    .map((t) => t.spec);
  // Its own model (D195), or the turn's: a background one always has its own requests.
  const own =
    (spec.model ? await subModel(session, spec.model) : null) ??
    ((spec.cancelled || ownRequests) && fallback ? fallback : null);
  const turnCancelled = spec.cancelled ?? (() => session.cancelled);
  // Its own Stop in the Background tasks view (D326), besides the turn's.
  let stoppedHere = false;
  const cancelled = () => stoppedHere || turnCancelled();
  /** The rules this run's tool results carried (D207). */
  const subRules = new Set<string>();
  const state = {
    items: [{ type: "user" as const, id: newId("u"), text: spec.task }] as Item[],
    textProtocol: own ? own.details.tools === false : session.textProtocol,
  };
  // The Background tasks view shows it, its conversation live (D326).
  const runId = spec.runId ?? newId("s");
  subagentRuns.begin({
    id: runId,
    session: session.id,
    agent: spec.agentName ?? "subagent",
    title: subagentTitle(spec.title, spec.task),
    brief: spec.task,
    model: own?.choice.key ?? fallback?.choice.key ?? session.model.peek() ?? null,
    background: !!spec.cancelled,
    startedAt: Date.now(),
    items: state.items,
    stop: () => {
      stoppedHere = true;
      // A background run's own stop (its notice says so); its requests are its own to cancel.
      session.background.get(runId)?.stop();
      if (own) for (const r of spec.requests ?? []) void aiIpc.cancel(r).catch(() => {});
    },
  });
  const sub: LoopDeps = {
    system: () => "",
    tools: () => tools,
    chat: own
      ? subChat(
          session,
          own.choice,
          own.details,
          spec.system,
          cancelled,
          spec.requests,
          spec.onUsage,
        )
      : deps.chat,
    execute: async (call, item) => {
      if (!spec.tools.includes(call.name))
        return { result: `Error: ${call.name} isn't available here (read-only).`, isError: true };
      const a = (call.arguments ?? {}) as Record<string, unknown>;
      spec.progress(
        `${call.name} ${String(a.path ?? a.query ?? a.pattern ?? a.glob ?? "")}`.trim(),
      );
      const outcome = await deps.execute(call, item);
      // Folder and matching-files rules come with the subagent's reads and edits (D207), as
      // with the main agent's; each once per run.
      const needs = spec.ruleNeeds;
      if (!needs || outcome.isError || !RULE_TOOLS.has(call.name) || typeof a.path !== "string")
        return outcome;
      const extra = await rulesFor(session.services)
        .forSubagentFile(a.path, needs, subRules)
        .catch(() => "");
      return extra ? { ...outcome, result: `${outcome.result}${extra}` } : outcome;
    },
    update: () => subagentRuns.changed(),
    newId: () => newId("i"),
    cancelled,
    budgetChars: own
      ? charsFor(Math.floor(contextLengthFor(session, own.choice, own.details) * 0.7))
      : budgetChars,
    maxSteps: spec.maxSteps,
    stableMessages: true,
    vision: false,
    // Its reads and searches run together too, as the chat's own do.
    ...(deps.concurrent && { concurrent: deps.concurrent }),
    ...(inbox && {
      takeQueued: () => inbox.splice(0),
      hasQueued: () => inbox.length > 0 && !cancelled(),
    }),
  };
  const answer = () => {
    const last = [...state.items].reverse().find((i) => i.type === "assistant" && i.text.trim());
    return last?.type === "assistant" ? last.text : "";
  };
  if (!own) setSystem(spec.system);
  let failed = false;
  const agentType = spec.agentName ?? "subagent";
  try {
    // SubagentStart hooks (D371): what they print goes with its task.
    const start = await session.runHook("SubagentStart", { agentType, agentId: runId });
    const first = state.items[0];
    if (start?.context && first?.type === "user")
      first.text = `${first.text}

From the user's hooks:
${start.context}`;
    await runTurn(state, sub);
    const last = state.items[state.items.length - 1];
    if (!cancelled() && last?.type === "tool") {
      state.items.push({
        type: "user",
        id: newId("u"),
        text: "Your steps are used up: write the report now from what you found.",
      });
      // Same tools declared (some APIs refuse tool history without them); one step only.
      await runTurn(state, { ...sub, maxSteps: 1 });
    }
    // SubagentStop hooks (D371): one can send it back to work, once (stop_hook_active).
    if (!cancelled()) {
      const stop = await session.runHook("SubagentStop", {
        agentType,
        agentId: runId,
        stopHookActive: false,
      });
      if (stop?.block && !stop.halt && !cancelled()) {
        state.items.push({
          type: "user",
          id: newId("u"),
          text: `A SubagentStop hook says the work isn't finished:
${stop.reason}`,
        });
        await runTurn(state, sub);
      }
    }
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (!own) setSystem(null);
    subagentRuns.end(runId, cancelled() ? "stopped" : failed ? "failed" : "done");
  }
  if (stoppedHere && !turnCancelled())
    return `${answer()}\n\n(The user stopped this subagent before it finished.)`.trim();
  return answer();
}

/** A subagent's model (D195): a provider/model, a model name or a Claude alias; null: the turn's. */
export async function subModel(
  session: AgentSession,
  name: string,
): Promise<{ choice: ModelChoice; details: ModelDetails } | null> {
  const key = resolveModelName(
    name,
    session.providers.models.peek().map((m) => m.key),
  );
  const choice = key ? session.providers.find(key) : undefined;
  if (!choice) return null;
  return { choice, details: await session.providers.detailsFor(choice) };
}

export function subChat(
  session: AgentSession,
  choice: ModelChoice,
  details: ModelDetails,
  system: string,
  cancelled: () => boolean,
  requests: Set<string> = session.subRequests,
  /** Each request's tokens and cost (a workflow's agent, D338). */
  onUsage?: SubagentSpec["onUsage"],
): LoopDeps["chat"] {
  const contextLength = contextLengthFor(session, choice, details);
  const extra = requestOptions(session, choice, details);
  const think = thinkFor(session.services, details);
  return async (request, onEvent) => {
    if (cancelled()) throw new Error("Stopped.");
    const messages = [
      {
        ...request.messages[0],
        role: "system" as const,
        content: `${system}${request.messages[0]?.content ? `\n\n${request.messages[0].content}` : ""}`,
      },
      ...request.messages.slice(1),
    ];
    for (let attempt = 0; ; attempt++) {
      const id = newId("r");
      requests.add(id);
      let received = false;
      try {
        await aiIpc.chat(
          id,
          {
            provider: choice.provider,
            model: choice.model,
            messages,
            tools: request.tools,
            contextLength,
            ...extra,
            ...(think !== undefined && { think }),
          },
          (event) => {
            received = true;
            if (cancelled()) void aiIpc.cancel(id).catch(() => {});
            if (event.kind === "done") {
              const record = recordUsage(session.services, {
                source: "subagent",
                session: session.id,
                choice,
                event,
                price: priceOf(session.services, session.providers, choice.key),
              });
              onUsage?.({
                input: event.inputTokens ?? 0,
                output: event.outputTokens ?? 0,
                cost: record?.cost ?? event.cost ?? null,
              });
            }
            onEvent(event);
          },
        );
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (received || cancelled() || attempt >= 2 || !isTransientError(message)) throw err;
        await new Promise((r) => setTimeout(r, retryDelayMs(attempt + 1)));
      } finally {
        requests.delete(id);
      }
    }
  };
}

/**
 * Starts a subagent that works while the conversation goes on (D195, like Claude Code's
 * background subagents): read-only tools, its own requests; its report comes back as a message
 * (joining the turn that's running, or starting one).
 */
export function startBackground(
  session: AgentSession,
  spec: SubagentSpec & { name: string },
  deps: LoopDeps,
  budgetChars: number,
  fallback: { choice: ModelChoice; details: ModelDetails },
): string {
  const id = newId("b");
  let stopped = false;
  let done = false;
  const requests = new Set<string>();
  const inbox: Item[] = [];
  let failure: string | null = null;
  const notice: Extract<Item, { type: "notice" }> = {
    type: "notice",
    id: newId("n"),
    text: `Subagent ${spec.name} is working in the background…`,
    detail: spec.task.slice(0, 400),
    tone: "info",
  };
  // A workflow's agent (D338): the workflow's card shows it instead.
  if (!spec.onReport) session.items.push(notice);
  session.background.set(id, {
    name: spec.name,
    started: Date.now(),
    stop: () => {
      stopped = true;
      for (const r of requests) void aiIpc.cancel(r).catch(() => {});
    },
    // A follow-up (D245): it reads it before its next model call, as the chat's own turn does.
    message: (text, from) => {
      if (done || stopped) return false;
      inbox.push({ type: "user", id: newId("u"), text: `Follow-up from ${from}: ${text}` });
      return true;
    },
  });
  session.backgroundCount.value = session.background.size;
  session.bump();
  // In a group chat, its report goes back to the member that started it (D253).
  const speaker = session.turnSpeaker;
  void runSubagent(
    session,
    {
      ...spec,
      cancelled: () => stopped || session.deleted,
      requests,
      runId: id,
      agentName: spec.agentName ?? spec.name,
    },
    deps,
    budgetChars,
    () => {},
    fallback,
    inbox,
  )
    .then(
      (report) => (stopped ? null : report),
      (err: unknown) => {
        failure = err instanceof Error ? err.message : String(err);
        return stopped ? null : `(It failed: ${failure})`;
      },
    )
    .then(async (report) => {
      done = true;
      session.background.delete(id);
      session.backgroundCount.value = session.background.size;
      if (spec.onReport) {
        session.bump();
        if (failure !== null) spec.onReport(null, failure);
        else spec.onReport(report);
        return;
      }
      notice.text =
        report === null ? `Subagent ${spec.name} was stopped.` : `Subagent ${spec.name} finished.`;
      delete notice.detail;
      session.bump();
      if (report === null || session.deleted) return;
      await deliverReport(session, spec.name, report || "(It wrote no report.)", speaker);
    });
  return id;
}

/** A background subagent's report goes to the agent: into the running turn, or a new one. */
export async function deliverReport(
  session: AgentSession,
  name: string,
  report: string,
  /** The group member that started it (its turn takes the report). */
  speaker?: string | null,
): Promise<void> {
  const item: Item = {
    type: "user",
    id: newId("u"),
    text: `Report from subagent ${name} (it ran in the background):\n\n${report}`,
    auto: "subagent",
    ...(speaker && session.members.peek().length && { to: speaker }),
  };
  if (session.inTurn && !session.cancelled) {
    session.reports.push(item);
    return;
  }
  session.reports.push(item);
  flushReports(session);
}

/**
 * A message the agent gets without the user typing it (D253): a scheduled one, a background
 * command that ended; a monitor's events, a watched pull request's news, another chat's message
 * (D322–D325), a workflow's end (D338). Like a report: into the running turn, or a turn of its own. Returns the item.
 */
export function deliverAutoMessage(
  session: AgentSession,
  text: string,
  auto: "schedule" | "process" | "monitor" | "pr" | "chat" | "workflow",
): Item {
  const item: Item = { type: "user", id: newId("u"), text, auto };
  session.reports.push(item);
  if (!session.inTurn || session.cancelled) flushReports(session);
  return item;
}

/**
 * Reports waiting while no turn takes them: a turn of their own. Busy in another way (a
 * summary, a turn ending): tried again shortly.
 */
export function flushReports(session: AgentSession, delay = 0): void {
  clearTimeout(session.reportTimer);
  session.reportTimer = setTimeout(() => {
    if (session.deleted || session.disposed || !session.reports.length) return;
    // A running turn takes them at its next step (or flushes them as it ends).
    if (session.inTurn) return;
    let taken: Item[] = [];
    void session
      .exclusive(async () => {
        taken = session.reports.splice(0);
        session.items.push(...taken);
        session.reportTurn = true;
        try {
          await sendNow(session, "", [], { resume: true });
        } finally {
          session.reportTurn = false;
        }
      })
      .catch(() => {
        if (!taken.length) flushReports(session, 2000);
      });
  }, delay);
}

/** After a turn that changed files: the reviewer looks at them in the background (agent.autoReview). */
export function autoReview(
  session: AgentSession,
  deps: LoopDeps,
  budgetChars: number,
  fallback: { choice: ModelChoice; details: ModelDetails },
): void {
  const files = [
    ...new Set([
      ...session.changeset.writtenIn(session.turn),
      ...session.changeset.files
        .peek()
        .filter((f) => f.turn === session.turn)
        .map((f) => f.path),
    ]),
  ];
  if (!files.length) return;
  const spec = session.reviewSpec(
    files,
    session.tools().map((t) => t.spec.name),
  );
  // One review at a time: the review agent's earlier one may still be working.
  if (!spec || [...session.background.values()].some((b) => b.name === spec.name)) return;
  startBackground(session, spec, deps, budgetChars, fallback);
}

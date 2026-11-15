// The agent with no window: a screenless session (boot.ts) with the agent's host set for nobody
// at a screen, driven the way a front end drives it: commands through the dispatcher as a
// front-end caller, state through the state tree, and each chat as a stream of events. One brain
// per JavaScript realm (the call layer and the reactive core are module-level state).
//
// Node-free and DOM-free: the backend, and where workflow scripts run, are handed in (run.ts
// gives the host process and worker threads).
import type { Caller } from "../core/dispatcher/types";
import type { BuiltinExtension } from "../core/extensions/index";
import { agentStoreIpc } from "../core/ipc/agent";
import type { Disposable } from "../core/lifecycle/index";
import {
  type HeadlessPrompts,
  headlessAgentHost,
  headlessPrompts,
  setAgentHost,
  type WorkerFactory,
} from "../extensions/agent/agentHost";
import { isThisWorkspace } from "../extensions/agent/chatWorkspace";
import { type AgentRuntime, agentRuntime } from "../extensions/agent/runtime";
import type { AgentSession } from "../extensions/agent/session";
import {
  observeSession,
  type SessionEvent,
  type SessionEventListener,
  type SessionUsage,
  sessionUsage,
  type TurnEndReason,
} from "../extensions/agent/sessionEvents";
import {
  modeSettings,
  type PermissionDecision,
  promptPolicyOf,
  type UnattendedPolicy,
} from "../extensions/agent/unattended";
import type { WorkbenchServices } from "../workbench/services";
import { bootHeadless, type HeadlessBackend, type HeadlessSession } from "./boot";
import type { HeadlessPolicy } from "./services";

export interface BrainOptions {
  /** Where backend calls go (run.ts: the host process). */
  backend: HeadlessBackend;
  /** The folder (or workspace file) to work in; none: an answer-only chat. */
  folder?: string | null;
  /** The front end's name, for the audit log and `caller` ("cli" by default). */
  frontend?: string;
  /**
   * The permission policy (extensions/agent/unattended.ts). Default: `{ otherwise: "deny" }`:
   * what the settings allow goes ahead, and what would ask is refused.
   */
  permissions?: UnattendedPolicy;
  /**
   * Settings that hold for this run only (a command line's flags), above the user's and the
   * folder's files and never written to them.
   */
  settings?: Readonly<Record<string, unknown>>;
  /** Where workflow scripts run; none: run_workflow is left out. */
  workers?: WorkerFactory | null;
  /**
   * Start the IDE's own MCP server and its Claude Code integration when the settings turn them
   * on. Default false: a brain beside the app would start a second server for the same person.
   * An external agent of a chat gets the IDE's tools either way.
   */
  ideServer?: boolean;
  /**
   * Treat the folder as trusted when nobody has decided about it (its hooks, its MCP servers,
   * its tasks and restricted settings apply): the decision is remembered as the window
   * remembers one. Default: undecided folders stay restricted and nothing is remembered.
   */
  trustFolder?: boolean;
  /**
   * The built-ins to activate, the agent among them (extensions.ts has the list a brain uses;
   * it is handed in so this module imports no extension's views).
   */
  extensions: readonly BuiltinExtension<WorkbenchServices>[];
  /** Answers for the services' own questions (confirmations, pickers); default: declined. */
  policy?: HeadlessPolicy;
}

/** A saved chat, as the app's Chats list has it. */
export interface SavedChat {
  id: string;
  title: string;
  /** When it last changed (ms since the epoch); 0 when unknown. */
  updated: number;
  /** The folder it belongs to, when it has one. */
  workspace: string | null;
  /** It belongs to the folder this brain has open. */
  here: boolean;
}

export interface OpenChatOptions {
  /** A saved or loaded chat's id. */
  session?: string;
  /** With no `session`: the most recently changed chat of this folder, else a new one. */
  continue?: boolean;
  /** "<provider>/<model>", a model's own name, or "acp/<agent>": for this chat only. */
  model?: string;
  /** With an external agent (`acp/<agent>`): its own model and reasoning level. */
  agentModel?: string;
  agentLevel?: string;
  /** agent, plan, ask or `custom:<name>` (one of the user's agents). */
  chatMode?: string;
}

/** The limits of one run. Each ends the turn as Stop does, with its own reason. */
export interface RunLimits {
  /** Model requests the turn may make before it pauses (the app's `agent.maxSteps`). */
  maxSteps?: number;
  /** Dollars this run may spend (by the chat's cost, where the model's price is known). */
  maxCost?: number;
  /** Milliseconds this run may take. */
  timeoutMs?: number;
  /** Aborting it stops the run (reason "cancelled"). */
  signal?: AbortSignal;
}

/**
 * Why a run ended: a turn's own reason (sessionEvents.ts), or the limit of the run that stopped
 * it. `cancelled`: its signal was aborted, or `stop()` was called.
 */
export type RunEndReason = TurnEndReason | "timeout" | "max_cost" | "cancelled";

export interface RunResult {
  /** The chat's id (continue it with `open({ session })`, here or in the app). */
  session: string;
  /** The answer: the last reply's text ("" when the run wrote none). */
  text: string;
  reason: RunEndReason;
  /** The failure, when `reason` is "error". */
  error?: string;
  usage: SessionUsage;
  /** Model requests this run made. */
  steps: number;
  /** Dollars this run spent, where the price is known. */
  cost: number | null;
  /** The permission questions that were refused during the run, and by whom. */
  denied: PermissionDecision[];
  /** Files with edits waiting for review (none when edits apply directly). */
  pending: string[];
  /**
   * What the message did when it wasn't sent to the model: a slash command's own result
   * (`/compact`, `/model`…), as `agent.send` returned it.
   */
  command?: Record<string, unknown>;
}

/** One chat of a brain. */
export interface BrainChat {
  readonly id: string;
  /** The live chat (its signals: status, items, permissions…). Change it through commands. */
  readonly session: AgentSession;
  /** Everything that happens in the chat from now on (sessionEvents.ts). */
  onEvent(listener: SessionEventListener): Disposable;
  /**
   * Sends `prompt` and resolves when the work it started has ended: the turn, and what follows
   * it by itself (queued messages, background helpers' reports). Never rejects for a failed
   * turn: `reason` says how it ended. Rejects when the message couldn't be sent at all.
   */
  send(prompt: string, limits?: RunLimits): Promise<RunResult>;
  /** Stops the running turn (as the Stop button). */
  stop(reason?: string): void;
}

export interface Brain {
  readonly services: WorkbenchServices;
  /** The screenless session under it (its notifications, the extensions' activation…). */
  readonly boot: HeadlessSession;
  /** Who this front end is to the dispatcher: the person, at something that isn't the window. */
  readonly caller: Caller;
  /** The agent's live objects (sessions, providers). */
  readonly agent: AgentRuntime;
  /** Host prompts waiting for an answer (an MCP server's input…), when the policy says wait. */
  readonly prompts: HeadlessPrompts;
  /** Runs a command as the front end (the person's rights; destructive ones are confirmed). */
  execute<O = unknown>(command: string, input?: unknown): Promise<O>;
  /** Reads a state path (`ide://…`). */
  state(path: string, budget?: number): Promise<unknown>;
  /** Changes the settings that hold for this run only (merged over the earlier ones). */
  override(settings: Readonly<Record<string, unknown>>): void;
  /** The saved chats, newest first (the same store the app's Chats list reads). */
  chats(): Promise<SavedChat[]>;
  /** Opens a chat: a saved one, the folder's latest, or a new one. */
  open(options?: OpenChatOptions): Promise<BrainChat>;
  /** Stops every chat, saves them, deactivates the extensions and ends the backend. */
  dispose(): Promise<void>;
}

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Starts a brain: boots the screenless session with the agent's host for nobody at a screen,
 * and resolves once the agent is ready. Rejects when the agent didn't activate.
 */
export async function startBrain(options: BrainOptions): Promise<Brain> {
  const permissions: UnattendedPolicy = options.permissions ?? { otherwise: "deny" };
  const mode = permissions.mode ? modeSettings(permissions.mode) : null;
  const prompts = headlessPrompts(promptPolicyOf(permissions));
  let overrides: Record<string, unknown> = {
    // The IDE's own MCP server and its Claude Code integration: the app's, unless asked for.
    ...(options.ideServer !== true && { "mcp.enabled": false, "mcp.claudeCode.enabled": false }),
    ...mode?.settings,
    ...options.settings,
  };
  const boot = await bootHeadless({
    backend: options.backend,
    extensions: options.extensions,
    folder: options.folder ?? null,
    policy: {
      ...options.policy,
      ...(options.trustFolder && {
        trust: { folder: "trust", ...options.policy?.trust },
      }),
    },
    beforeActivate: (services) => {
      services.settings.setOverrides(overrides);
      setAgentHost(
        services,
        headlessAgentHost({ prompts, workers: options.workers ?? null, permissions }),
      );
    },
  });
  const { services } = boot;
  const agent = agentRuntime(services);
  if (!agent) {
    const failed = boot.extensions.filter((e) => e.error).map((e) => `${e.id}: ${e.error}`);
    await boot.dispose();
    throw new Error(
      `The agent didn't start${failed.length ? ` (${failed.join("; ")})` : ": its extension isn't in the list"}.`,
    );
  }
  if (options.folder && boot.folderError) {
    const why = boot.folderError;
    await boot.dispose();
    throw new Error(`Couldn't open ${options.folder}: ${why}`);
  }
  // A folder nobody decided about, with a flag that says to trust it: decided now, so the
  // folder's own settings and hooks apply from the first message.
  if (options.trustFolder && boot.folder && services.trust.state.peek() === "unknown")
    await services.trust.require("This run").catch(() => {});
  // New chats start as the run's access mode says (a loaded one is set when it's opened).
  if (mode) agent.sessions.autoApply = mode.autoApply;

  const caller: Caller = { kind: "frontend", name: options.frontend ?? "cli" };
  const execute = <O = unknown>(command: string, input: unknown = {}): Promise<O> =>
    services.dispatcher.execute<O>(command, input, caller);
  const override = (settings: Readonly<Record<string, unknown>>): void => {
    overrides = { ...overrides, ...settings };
    services.settings.setOverrides(overrides);
  };

  const chats = async (): Promise<SavedChat[]> =>
    (await agentStoreIpc.list())
      .map(({ id, meta }) => {
        const m = (meta ?? {}) as { title?: unknown; updated?: unknown; workspace?: unknown };
        const workspace = typeof m.workspace === "string" ? m.workspace : null;
        return {
          id,
          title: typeof m.title === "string" ? m.title : "Session",
          updated: typeof m.updated === "number" ? m.updated : 0,
          workspace,
          here: isThisWorkspace(services, workspace),
        };
      })
      .sort((a, b) => b.updated - a.updated);

  const chatOf = (session: AgentSession): BrainChat => ({
    id: session.id,
    session,
    onEvent: (listener) => observeSession(services, session, listener),
    stop: (reason) => session.stop(reason),
    send: (prompt, limits = {}) => runPrompt(services, execute, override, session, prompt, limits),
  });

  const open = async (o: OpenChatOptions = {}): Promise<BrainChat> => {
    let id = o.session;
    if (!id && o.continue) id = (await chats()).find((c) => c.here)?.id;
    if (id && !agent.sessions.find(id) && !(await agentStoreIpc.load(id).catch(() => null)))
      throw new Error(`No saved chat with the id ${id}.`);
    const session = agent.sessions.get(id);
    await session.loaded();
    agent.sessions.active.value = session.id;
    // The run's access mode wins over what a saved chat had.
    if (mode) session.autoApply.value = mode.autoApply;
    if (o.model)
      await execute("agent.selectModel", {
        session: session.id,
        model: o.model,
        remember: false,
        ...(o.agentModel !== undefined && { agentModel: o.agentModel }),
        ...(o.agentLevel !== undefined && { agentLevel: o.agentLevel }),
      });
    if (o.chatMode) await execute("agent.setChatMode", { session: session.id, mode: o.chatMode });
    return chatOf(session);
  };

  let disposed = false;
  return {
    services,
    boot,
    caller,
    agent,
    prompts,
    execute,
    state: async (path, budget) =>
      (await services.state.get(path, budget === undefined ? undefined : { budget })).value,
    override,
    chats,
    open,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      // Running turns stop and every chat is saved while there is still a backend to save to.
      for (const session of agent.sessions.all()) session.stop("the session is ending");
      for (let i = 0; i < 200 && agent.sessions.all().some((s) => s.busyNow()); i++) await wait(25);
      await Promise.all(agent.sessions.all().map((s) => s.save().catch(() => {})));
      await services.persistence.flush().catch(() => {});
      await boot.dispose();
    },
  };
}

/** One prompt sent to `session`, with the run's limits, until the work it started has ended. */
async function runPrompt(
  services: WorkbenchServices,
  execute: Brain["execute"],
  override: Brain["override"],
  session: AgentSession,
  prompt: string,
  limits: RunLimits,
): Promise<RunResult> {
  const startRequests = session.totals.peek().requests;
  const startCost = session.cost.peek() ?? 0;
  const denied: PermissionDecision[] = [];
  let text = "";
  /** How the last turn ended, and the limit that stopped the run when one did. */
  const end: {
    turn: TurnEndReason | null;
    error: string | undefined;
    limit: Exclude<RunEndReason, TurnEndReason> | null;
  } = { turn: null, error: undefined, limit: null };
  const stopFor = (reason: Exclude<RunEndReason, TurnEndReason>, why: string) => {
    if (end.limit) return;
    end.limit = reason;
    session.stop(why);
  };
  const spent = () => (session.cost.peek() ?? 0) - startCost;
  const onEvent = (event: SessionEvent) => {
    if (event.type === "permission.decision" && event.answer === "deny") {
      const { type: _type, session: _session, ...decision } = event;
      denied.push(decision);
    } else if (event.type === "turn.end") {
      if (event.text) text = event.text;
      end.turn = event.reason;
      end.error = event.error;
    } else if (event.type === "usage" && limits.maxCost !== undefined) {
      if (spent() >= limits.maxCost) stopFor("max_cost", "the cost limit of this run was reached");
    }
  };
  const observer = observeSession(services, session, onEvent);
  if (limits.maxSteps !== undefined) override({ "agent.maxSteps": limits.maxSteps });
  const timer =
    limits.timeoutMs !== undefined
      ? setTimeout(
          () => stopFor("timeout", "the time limit of this run was reached"),
          limits.timeoutMs,
        )
      : undefined;
  const onAbort = () => stopFor("cancelled", "the run was cancelled");
  if (limits.signal?.aborted) end.limit = "cancelled";
  limits.signal?.addEventListener("abort", onAbort, { once: true });
  let command: Record<string, unknown> | undefined;
  try {
    if (!end.limit) {
      const sent = await execute<Record<string, unknown> | null>("agent.send", {
        session: session.id,
        message: prompt,
        wait: true,
        noFolder: true,
      });
      // A message that acted instead of being sent (a slash command): its own result.
      if (sent && !("answer" in sent)) command = sent;
      // What the turn started by itself: messages that were queued, helpers still working,
      // their reports. The run ends when the chat is at rest.
      for (;;) {
        await session.settle();
        const busy =
          session.busyNow() ||
          session.background.size > 0 ||
          session.reports.length > 0 ||
          session.queued.peek().length > 0;
        if (!busy) {
          // Follow-ups start a moment after a turn ends: still at rest after one?
          await wait(30);
          await session.settle();
          if (
            !session.busyNow() &&
            session.background.size === 0 &&
            session.reports.length === 0 &&
            session.queued.peek().length === 0
          )
            break;
        } else if (end.limit && !session.busyNow()) break;
        else await wait(25);
      }
    }
  } finally {
    clearTimeout(timer);
    limits.signal?.removeEventListener("abort", onAbort);
    observer.dispose();
  }
  await session.save().catch(() => {});
  const reason: RunEndReason = end.limit ?? end.turn ?? "end";
  const error = end.error ?? session.error.peek() ?? undefined;
  return {
    session: session.id,
    text,
    reason,
    ...(reason === "error" && error && { error }),
    usage: sessionUsage(session),
    steps: session.totals.peek().requests - startRequests,
    cost: session.cost.peek() === null ? null : Math.round(spent() * 10_000) / 10_000,
    denied,
    pending: session.changeset.files.peek().map((f) => f.path),
    ...(command && { command }),
  };
}

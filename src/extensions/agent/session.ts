// One agent session: the conversation and its state, permission requests shown inline, queued
// messages, retry / edit / restore, checkpoints and saving. Split by responsibility (D221): a
// turn of the IDE's own agent is sessionTurn.ts, an external agent's sessionExternal.ts,
// subagents sessionSubagents.ts, summaries and one-off tasks sessionSummaries.ts, request options,
// usage and the budget sessionUsage.ts, the saved form sessionStore.ts; retry, edit and resend,
// restore checkpoint and putting files back sessionRewind.ts (D245). Members marked
// `@internal` are the state those modules share; nothing else should use them.

import type { AcpSetting } from "../../core/acp/client";
import type { AskAnswers, QuestionAnswer } from "../../core/agent/askUser";
import type { SentAttachment, Upload } from "../../core/agent/attachments";
import { findCustomMode, modeAllows } from "../../core/agent/chatModes";
import type { PlanStep } from "../../core/agent/compact";
import { CONTINUE_NOTE, type Item } from "../../core/agent/conversation";
import type { GroupChain } from "../../core/agent/groupChat";
import type { HookDecision, HookEvent } from "../../core/agent/hooks";
import type { ToolOutcome } from "../../core/agent/loop";
import type { ModelPrice } from "../../core/agent/prices";
import { readSandboxSetting } from "../../core/agent/sandbox";
import {
  commandTools,
  mergeTurnTools,
  preApprovedCall,
  type TurnTools,
} from "../../core/agent/slash";
import type { RuleContext } from "../../core/agent/toolRules";
import { aiIpc } from "../../core/ipc/agent";
import { execIpc } from "../../core/ipc/process";
import { effect, type Signal, signal } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import type { AcpBackend } from "./acp";
import { browserTools } from "./browserTools";
import { Changeset } from "./changeset";
import { soloAgentOf } from "./chatAgentModel";
import { chatAttachmentsTool } from "./chatAttachmentsTool";
import { saveImageTool } from "./chatImageTools";
import { chatWorkspaceOf } from "./chatWorkspace";
import { computerTools } from "./computerTool";
import { customModes } from "./customModes";
import { splitDeferred, type ToolSplit } from "./deferredTools";
import { DISPLAY_TOOLS } from "./displayTools";
import { EXPLORE_TOOL, exploreAvailable } from "./exploreTool";
import type { AgentHooks } from "./hooks";
import { newId } from "./ids";
import { MEMORY_TOOLS, memoryFor } from "./memory";
import { commandDenied, DEFAULT_DENIED_COMMANDS } from "./permissions";
import type { ProviderRegistry } from "./providers";
import { rulesFor } from "./rules";
import { SANDBOX_TOOLS } from "./sandboxAllowTool";
import { externalConfig, externalFor } from "./sessionExternal";
import { changedSinceNow, resendNow, restoreNow, retryNow, rewindNow } from "./sessionRewind";
import { loadSaved, resolveSaveConflict, saveSessionNow, sessionJSON } from "./sessionStore";
import { compactNow, sideTaskNow } from "./sessionSummaries";
import { sendNow } from "./sessionTurn";
import {
  type BuiltInMode,
  type ChatMode,
  type PermissionRequest,
  PLAN_NUDGE_AFTER,
  type QueuedMessage,
  RULE_TOOLS,
  type SessionStatus,
} from "./sessionTypes";
import { subagentChoices } from "./subagents";
import { type AgentTool, CORE_TOOLS, PLAN_TOOL, type SubagentSpec } from "./tools";
import { turnTools } from "./turnTools";

export type { ChatMode, PermissionRequest, QueuedMessage, SessionStatus };

export class AgentSession {
  readonly title = signal("New session");
  /** The pull request this chat's agent opened (D227, chatPullRequests.ts), kept with the chat. */
  readonly pullRequest = signal<{
    number: number | null;
    url: string | null;
    title: string;
  } | null>(null);
  /** When the conversation last changed (saved as meta.updated). */
  updated = Date.now();
  /** Pinned to the top of the Chats list (D125). */
  pinned = false;
  /** Archived: out of its folder's list, under Archived in the Chats view. */
  archived = false;
  /**
   * The channel or direct message this chat is a thread of (D237: `general`, `dm:builder`); none
   * for a chat from before channels (rooms.ts `threadRoom` places it).
   */
  room: string | null = null;
  /** A thread (D238): the message it answers ("Reply in thread"). */
  parent: import("../../core/agent/rooms").ThreadParent | null = null;
  /** The chat this one was forked from (D422): the Chats list shows it under that one. */
  forkOf: string | null = null;
  /**
   * A channel's or direct message's own conversation: named after it, and its first message
   * doesn't rename it (D415). Set each time the room is opened; threads don't have it.
   */
  /** @internal */ keepsTitle = false;
  /** Waiting for the model's `<title>` in its first reply (D124). */
  /** @internal */ wantTitle = false;
  readonly status = signal<SessionStatus>("idle");
  /** Files attached to the next message ("Add file to chat"); sent as context, then cleared. */
  readonly attachments = signal<string[]>([]);
  /** Text to put in the message box (a picked slash command); the composer takes and clears it. */
  readonly draft = signal<string | null>(null);
  /**
   * Files picked or dropped from anywhere, big pastes and images, sent with the next message
   * (cards above the box, D131).
   */
  readonly uploads = signal<Upload[]>([]);
  /**
   * A message sent with no folder open (D121): it waits while the card asks where to work —
   * create a project folder (suggested name and place), open one, or just chat.
   */
  readonly folderRequest = signal<{ message: string; name: string; parent: string } | null>(null);
  /** The user message being edited in place (panel state, not saved). */
  readonly editing = signal<string | null>(null);
  /**
   * An external agent's turn ended and its files are being compared and put under review
   * (D294): the review bar waits (its buttons would act on a list still growing).
   */
  readonly gathering = signal(false);
  /** Bumped on every change to items (the view re-renders on the next frame). */
  readonly version = signal(0);
  readonly model: Signal<string | null> = signal<string | null>(null);
  /** An external agent's own models and reasoning levels, once it has started (D193). */
  readonly agentSettings: Signal<{ agent: string; settings: readonly AcpSetting[] } | null> =
    signal<{ agent: string; settings: readonly AcpSetting[] } | null>(null);
  /**
   * A model or reasoning level picked for the external agent that it hasn't taken yet: starting
   * the agent and its answer can take a while, and the pill says so meanwhile.
   */
  readonly agentSettingPending = signal<{
    /** The external agent it was picked for (the chat's model may change meanwhile). */
    agent: string;
    category: AcpSetting["category"];
    value: string;
  } | null>(null);
  readonly autoApply = signal(false);
  /**
   * How the agent works (D180, after Cursor's modes): "agent" does the work; "ask" answers with
   * read-only tools; "plan" researches read-only and writes a plan for Build to carry out.
   */
  readonly chatMode = signal<ChatMode>("agent");
  /**
   * Plan or Ask on top of one of the user's agents (D249): `chatMode` names the agent (who
   * answers), this how it works. Null: its own access. The main agent's mode is `chatMode` itself.
   */
  readonly workMode = signal<"plan" | "ask" | null>(null);
  /** The mode of the running turn (its tool list is fixed for the turn). */
  /** @internal */ turnMode: ChatMode | null = null;
  /**
   * A group chat's agents (D231, groupChat.ts): names of the user's agents, `agent` for the main
   * one. Empty: an ordinary chat. Each turn runs in the mode of the member answering it.
   */
  readonly members = signal<readonly string[]>([]);
  /** The member who answers the next turn (set by routing or a handoff; taken by the turn). */
  nextSpeaker: string | null = null;
  /**
   * The agent answering the running turn (its replies record it as `speaker`). A signal under it:
   * the chats list shows which agent is busy, and that changes within a group round.
   */
  readonly speaking = signal<string | null>(null);
  /** @internal */ get turnSpeaker(): string | null {
    return this.speaking.peek();
  }
  set turnSpeaker(name: string | null) {
    this.speaking.value = name;
  }
  /** What's left of the current user message's round of agent replies (null: none). */
  /** @internal */ groupChain: GroupChain | null = null;

  /** The agent that wrote the newest reply, if it's known. */
  lastSpeaker(): string | null {
    const last = this.items.findLast((i) => i.type === "assistant" && !!i.speaker);
    return last?.type === "assistant" ? (last.speaker ?? null) : null;
  }
  /** The model for the next turn only (Build's, D195); the chat's model stays. */
  nextTurnModel: string | null = null;
  /**
   * A slash command's `allowed-tools` / `disallowed-tools` for the next turn only (D203, D207):
   * that turn is offered just those tools and the read-only ones, minus the disallowed ones, and
   * the user's own command pre-approves the ones it allows.
   */
  nextTurnTools: TurnTools | null = null;
  /**
   * The most tools this chat may ever use (a helper in a worktree: the tools of the chat that
   * started it, D232); null: no limit. Saved with the chat.
   */
  toolLimit: readonly string[] | null = null;
  /** A skill's `effort` for the next turn only (D221: /name of a skill that sets one). */
  nextTurnEffort: string | null = null;
  /** The running turn's effort override (null: agent.effort). */
  /** @internal */ turnEffort: string | null = null;
  /** The running turn's command tools (null: every tool, nothing pre-approved). */
  /** @internal */ turnAllowedTools: TurnTools | null = null;
  readonly permissions = signal<readonly PermissionRequest[]>([]);
  readonly error = signal<string | null>(null);
  /** The agent's checklist (update_plan); sent with every request (D109). */
  readonly plan = signal<readonly PlanStep[]>([]);
  /** Context used by the last request (tokens; estimated when the provider doesn't say). */
  readonly usage = signal<{
    tokens: number;
    limit: number;
    estimated: boolean;
    /** Of `tokens`: read from the provider's prompt cache on the last request. */
    cached?: number;
  } | null>(null);
  /** Tokens this session has used (this window): prompt, of which cached / written to cache, output. */
  readonly totals = signal({ requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
  /**
   * What the chat has cost in dollars, priced as each request was made (D199); null until a
   * request with a known price (local models and unpriced ones add nothing).
   */
  readonly cost = signal<number | null>(null);
  /** The price of the model answering now (set per turn). */
  /** @internal */ price: ModelPrice | undefined;
  /** The current turn's cost so far (shown under its answer). */
  /** @internal */ turnCost = 0;
  /** The budget warning was shown, and going past the budget was allowed, in this chat. */
  /** @internal */ budgetWarned = false;
  /** @internal */ budgetAllowed = false;
  /**
   * The system prompt, built on the session's first request and kept (D112): rebuilding it every
   * step (it used to carry the IDE state and the plan) defeated prompt caching. Rebuilt after a
   * summary (the conversation changes there anyway) and when the app restarts.
   */
  /** @internal */ frozenSystem: string | null = null;
  /** The folder (and profile) `frozenSystem` describes. */
  /** @internal */ frozenFor: string | null = null;
  items: Item[] = [];
  textProtocol = false;
  turn = 0;
  readonly changeset: Changeset;
  /** Live output of running commands, by tool item id. */
  readonly outputs = new Map<string, string>();
  /** Turns with a checkpoint (file snapshots taken when their changes were applied). */
  checkpoints: number[] = [];
  /** MCP and other extra tools (set by the extension). */
  extraTools: () => AgentTool[] = () => [];
  prepare: () => Promise<void> = async () => {};
  /** The user's hooks for an event (D227, hooks.ts); null when none are set. */
  runHook: (
    event: HookEvent,
    fields: Parameters<AgentHooks["run"]>[2],
  ) => Promise<HookDecision | null> = async () => null;
  /**
   * How the chat's next message starts it, for SessionStart hooks (D371): a new chat, one
   * reopened from Chats, after /clear or a summary; null once they ran for it.
   */
  hookStart: "startup" | "resume" | "clear" | "compact" | null = "startup";
  /** SessionStart ran: closing the chat runs SessionEnd. */
  private hookStarted = false;
  /** SessionStart's hooks for the chat's first message (or the first after a summary). */
  async startHooks(): Promise<string> {
    const source = this.hookStart;
    if (!source) return "";
    this.hookStart = null;
    this.hookStarted = true;
    const start = await this.runHook("SessionStart", { source });
    return start?.context ?? "";
  }
  /** SessionEnd's hooks (D371), once, for a chat whose start ran them; nothing waits on them. */
  endHooks(reason: "clear" | "logout" | "prompt_input_exit" | "other"): void {
    if (!this.hookStarted) return;
    this.hookStarted = false;
    void this.runHook("SessionEnd", { reason }).catch(() => {});
  }
  /** A hook that failed: said in the chat (it blocks nothing). */
  hookNotice(text: string): void {
    this.items.push({ type: "notice", id: newId("n"), text, tone: "info" });
    this.bump();
  }
  /**
   * The automatic review after a turn that changed files (D195, agent.autoReview): the reviewer
   * subagent's run for those files, or null (off).
   */
  reviewSpec: (files: string[], tools: string[]) => (SubagentSpec & { name: string }) | null = () =>
    null;
  /** A turn a background report started: no automatic review after it (no review loops). */
  /** @internal */ reportTurn = false;
  /** @internal */ cancelled = false;
  /** End the running tool calls' steps at once (Stop, D151); a sub-agent's call has its own. */
  /** @internal */ readonly stopHandlers = new Set<() => void>();
  /** The running hooks' stops (also in stopHandlers): Send now ends them too (D379). */
  /** @internal */ readonly hookStops = new Set<() => void>();
  /**
   * Messages sent while a turn runs (D151): shown under the conversation, they join the turn at
   * its next step (the model reads them then and carries on).
   */
  readonly queued = signal<readonly QueuedMessage[]>([]);
  /** A model turn is running (messages can be queued for it). */
  /** @internal */ inTurn = false;
  /** Send now asked the running step to end (D363); the loop clears it at each step. */
  /** @internal */ interruptStep = false;
  /** What the turn's step is doing: writing its reply or running its tools (D363). */
  /** @internal */ stepPhase: "model" | "tools" | null = null;
  /** An external turn was cancelled by Send now: its held messages are sent, not put back. */
  private sendHeldAfterCancel = false;
  /** Deleted: nothing is saved any more (a turn unwinding after the delete wrote it back). */
  /** @internal */ deleted = false;
  /**
   * Disposed (put away, or the window closing): it starts no turn of its own any more. A report
   * reaching it then would run a turn nobody sees or can stop, beside the chat loaded again.
   */
  /** @internal */ disposed = false;
  /** @internal */ requestId: string | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** Ends an external agent that doesn't answer Stop (D161). */
  /** @internal */ hungTimer: ReturnType<typeof setTimeout> | undefined;

  /** The folder this session works in (kept when the window switches folders). */
  /** The folder the chat was started in (or moved to): its tools work on that project (D126). */
  readonly folder = signal<string | null>(null);
  /** @internal */ get workspaceRoot(): string | null {
    return this.folder.peek();
  }
  /** @internal */ set workspaceRoot(root: string | null) {
    this.folder.value = root;
  }

  /** Continue this chat in the folder (or multi-root workspace, D251) that is open now. */
  moveToOpenFolder(): void {
    this.workspaceRoot = chatWorkspaceOf(this.services);
    void this.save();
  }

  constructor(
    /** @internal */ readonly services: WorkbenchServices,
    /** @internal */ readonly providers: ProviderRegistry,
    readonly id: string = newId("s"),
  ) {
    this.changeset = new Changeset(services, id);
    // Where it belongs (D251): the window's first folder (a multi-root workspace's too).
    this.workspaceRoot = chatWorkspaceOf(services);
    // Away from the window: say when the agent is done or needs an answer (D107).
    let startedAt = 0;
    let last: SessionStatus = "idle";
    this.notifier = effect(() => {
      const status = this.status.value;
      const before = last;
      last = status;
      if (status === "running" && before === "idle") startedAt = Date.now();
      // The saved chat says how it's doing (the worktree agents' overview reads it, D204).
      if (status !== before) this.scheduleSave();
      const away = document.visibilityState === "hidden" || !document.hasFocus();
      if (!away || services.settings.peek<boolean>("agent.notifyWhenDone") === false)
        return undefined;
      const title = this.title.peek();
      if (status === "waiting" && before === "running") {
        // Its chat on screen already shows the question: no toast for it.
        const view = document.querySelector<HTMLElement>(
          `.agent-view[data-session="${CSS.escape(this.id)}"]`,
        );
        if (!view?.offsetParent)
          services.notifications.show("info", `The agent needs your answer: ${title}`, {
            title: "Agent",
          });
      } else if (status === "idle" && before !== "idle" && Date.now() - startedAt > 5000)
        services.notifications.show(
          this.error.peek() ? "error" : "success",
          `${this.error.peek() ? "The agent stopped with an error" : "The agent finished"}: ${title}`,
          { title: "Agent" },
        );
      return undefined;
    });
  }

  /** @internal */ bump(): void {
    this.updated = Date.now();
    this.version.value = this.version.peek() + 1;
    this.scheduleSave();
  }

  tools(): AgentTool[] {
    return this.toolsFor(this.turnMode ?? this.chatMode.peek());
  }

  /** How the chat works (D249): Agent, Plan or Ask, whichever agent answers. */
  work(): BuiltInMode {
    const mode = this.chatMode.peek();
    return mode.startsWith("custom:") ? (this.workMode.peek() ?? "agent") : (mode as BuiltInMode);
  }

  /** Plan or Ask on top of `mode` (D249): one of the user's agents in a chat with it alone. */
  overlay(mode: ChatMode | null): "plan" | "ask" | null {
    return mode?.startsWith("custom:") &&
      mode === this.chatMode.peek() &&
      !this.members.peek().length
      ? this.workMode.peek()
      : null;
  }

  /** Switches how the chat works, for the agent it's with (D249). */
  setWork(work: BuiltInMode): void {
    if (this.chatMode.peek().startsWith("custom:"))
      this.workMode.value = work === "agent" ? null : work;
    else this.chatMode.value = work;
  }

  /**
   * Switches the agent the chat is with (`agent` or `custom:<name>`), in the mode it starts in
   * (D249): its file's `mode:` (the planner plans, Chat answers); the main agent: Agent.
   */
  setAgent(mode: ChatMode): void {
    this.chatMode.value = mode.startsWith("custom:") ? mode : "agent";
    this.workMode.value = findCustomMode(customModes.peek(), mode)?.startMode ?? null;
  }

  /**
   * The tools a turn in `mode` gets (a group member's mode for the details panel's split, D233;
   * the turn's own via `tools`).
   */
  toolsFor(mode: ChatMode): AgentTool[] {
    return this.splitTools(mode).tools;
  }

  /**
   * The turn's tools split into what its requests offer and the deferred ones (D319: many MCP
   * tools reach the model by name, loaded with tool_search).
   */
  splitTools(mode: ChatMode = this.turnMode ?? this.chatMode.peek()): ToolSplit {
    return splitDeferred(this.services, this.allToolsFor(mode), this.items);
  }

  /** Every tool the running turn may run, deferred ones too (a subagent's named tools). */
  callableTools(): AgentTool[] {
    const split = this.splitTools();
    return [...split.tools, ...split.deferred];
  }

  private allToolsFor(mode: ChatMode): AgentTool[] {
    const limit = this.toolLimit;
    const all = limit
      ? this.allTools().filter((t) => limit.includes(t.spec.name))
      : this.allTools();
    // Ask and Plan look but don't touch: read-only tools (and the plan, in Plan mode).
    // (update_plan is read-only as far as files go, but only Plan writes plans.)
    // A custom mode (D227) uses the tools it lists (all when it lists none).
    const custom = findCustomMode(customModes.peek(), mode);
    // Plan or Ask on one of the user's agents (D249): its own tools, read-only (and the plan).
    const overlay = this.overlay(mode);
    const forMode = custom
      ? all.filter(
          (t) =>
            (overlay === "plan" && t === PLAN_TOOL) ||
            (modeAllows(custom, { name: t.spec.name, readOnly: t.readOnly }) &&
              (!overlay || (t.readOnly && t !== PLAN_TOOL))),
        )
      : mode === "agent"
        ? all
        : all.filter((t) => (t === PLAN_TOOL ? mode === "plan" : t.readOnly));
    const allowed = this.turnAllowedTools;
    if (!allowed) return forMode;
    const kept = commandTools(
      allowed.allowed,
      forMode.map((t) => ({ name: t.spec.name, readOnly: t.readOnly })),
      allowed.disallowed,
    );
    if (!kept) return forMode;
    const keep = new Set(kept);
    return forMode.filter((t) => keep.has(t.spec.name));
  }

  /**
   * A tool's permission question in a slash command's turn (D207): the user's own command
   * pre-approves the tools its `allowed-tools` lists, as full access would — what asks even
   * then (an Ask pattern, delete protection, MCP protection, a destructive call) and the
   * denylist still ask.
   */
  /** @internal */ askForCall(
    name: string,
    args: Record<string, unknown>,
    request: Omit<PermissionRequest, "id" | "resolve">,
  ): Promise<"once" | "always" | "deny"> {
    if (!request.evenWithFullAccess && !request.danger && this.preApproves(name, args))
      return Promise.resolve("once");
    return this.ask(request);
  }

  /** The home folder, for `~/` patterns in allowed-tools (read when a turn starts). */
  /** @internal */ home: string | null = null;

  /**
   * Where allowed-tools path patterns are read from (D221): the open folder and home; in a
   * multi-root workspace (D251) each folder, for the paths in it.
   */
  ruleContext(): RuleContext {
    return {
      root: this.services.workspace.root.peek(),
      home: this.home,
      folders: this.services.workspace.folders.peek(),
    };
  }

  /**
   * Whether the running turn's command or skill pre-approves this call (D207, D221): its
   * `allowed-tools` in a user's own file, the denylist still asking. The permission handler of
   * IDE commands asks it too (web.fetch by `WebFetch(domain:…)`); the caller keeps what asks
   * even then (Ask patterns, destructive calls).
   */
  preApproves(name: string, args: Record<string, unknown>): boolean {
    const turn = this.turnAllowedTools;
    if (!turn?.preApproved.length || !this.inTurn) return false;
    if (!preApprovedCall(turn.preApproved, name, args, this.ruleContext())) return false;
    return !(
      name === "run_command" &&
      typeof args.command === "string" &&
      commandDenied(args.command, [
        ...DEFAULT_DENIED_COMMANDS,
        ...(this.services.settings.peek<string[]>("agent.deniedCommands") ?? []),
      ])
    );
  }

  /**
   * A skill loaded in the running turn (use_skill, D221): its `allowed-tools` pre-approve those
   * tools for the rest of the turn (a user's own skill only; the caller decides).
   */
  preApproveForTurn(entries: readonly string[]): void {
    if (!entries.length || !this.inTurn) return;
    this.turnAllowedTools = mergeTurnTools(this.turnAllowedTools, { preApproved: entries });
  }

  /** A note in the chat (not sent to the model): "Always" saved as a pattern, D207. */
  addNotice(text: string): void {
    this.items.push({ type: "notice", id: newId("n"), text, tone: "info" });
    this.bump();
  }

  /** The small-model profile (D191): fewer tools and a short prompt for a small context. */
  /** @internal */ small = false;

  private allTools(): AgentTool[] {
    return chatTools(this.services, this.small, () => this.items, this.extraTools());
  }

  /** Asks the user inline; resolves when they answer (or the session stops). */
  ask(request: Omit<PermissionRequest, "id" | "resolve">): Promise<"once" | "always" | "deny"> {
    // After Stop, nothing new is asked: the step is being torn down.
    if (this.cancelled) return Promise.resolve("deny");
    return this.askBeforeSend(request);
  }

  /**
   * Asks the user inline before a message is sent (a slash command's shell lines, D200): an
   * earlier Stop doesn't answer it.
   */
  askBeforeSend(
    request: Omit<PermissionRequest, "id" | "resolve">,
  ): Promise<"once" | "always" | "deny"> {
    // Full access (D163): the user is away; everything is allowed, nothing waits on an answer.
    if (
      this.services.settings.peek<string>("agent.runCommands") === "full" &&
      !request.evenWithFullAccess
    )
      return Promise.resolve("once");
    return new Promise((resolve) => {
      const entry: PermissionRequest = {
        ...request,
        id: newId("p"),
        resolve: (answer) => {
          this.permissions.value = this.permissions.peek().filter((p) => p !== entry);
          this.resumeIfAnswered();
          resolve(answer);
        },
      };
      this.permissions.value = [...this.permissions.peek(), entry];
      if (this.status.peek() === "running") this.status.value = "waiting";
    });
  }

  /** ask_user cards waiting for the user (D171), by tool call. */
  readonly questions = signal<
    readonly { itemId: string; resolve(answer: QuestionAnswer | null): void }[]
  >([]);

  /**
   * Waits for the user's answer to tool call `itemId`'s question (ask_user, D171): typed text,
   * or the card's answers by question (D312).
   */
  question(itemId: string): Promise<QuestionAnswer | null> {
    if (this.cancelled) return Promise.resolve(null);
    return new Promise((resolve) => {
      const entry = {
        itemId,
        resolve: (answer: QuestionAnswer | null) => {
          this.questions.value = this.questions.peek().filter((q) => q !== entry);
          this.resumeIfAnswered();
          this.bump();
          resolve(answer);
        },
      };
      this.questions.value = [...this.questions.peek(), entry];
      if (this.status.peek() === "running") this.status.value = "waiting";
      this.bump();
    });
  }

  /**
   * Answers the open question (`itemId`'s, or the first): a choice clicked, or a message typed
   * while the agent waits. False when nothing is being asked.
   */
  answer(text: string | AskAnswers, itemId?: string): boolean {
    const open = this.questions.peek();
    const q = itemId ? open.find((x) => x.itemId === itemId) : open[0];
    const value = typeof text === "string" ? text.trim() : { answers: text };
    if (!q || !value) return false;
    q.resolve(value);
    return true;
  }

  private resumeIfAnswered(): void {
    if (
      this.status.peek() === "waiting" &&
      this.permissions.peek().length === 0 &&
      this.questions.peek().length === 0
    )
      this.status.value = "running";
  }

  /** The external agent (ACP) answering this session, when its model is "acp/<name>". */
  /** @internal */ external: AcpBackend | undefined;
  /** Whether the external agent (if any) got the IDE's tools (D211). */
  get externalIdeTools(): "on" | "off" | "unsupported" | null {
    return this.external ? this.external.ideTools : null;
  }
  /**
   * The external agent's plan limits as its last `/status` showed them (D233: Codex has them only
   * as text there), with the agent and when. Not saved: /status again after a restart.
   */
  externalLimits: {
    agent: string;
    at: number;
    limits: import("../../core/acp/planLimits").PlanLimit[];
  } | null = null;
  /** The external agent's own session, saved so it's picked up after a restart (D200). */
  acpResume: { agent: string; id: string; root: string } | null = null;
  /** The conversation was cut back (retry, edit): the external agent's memory is out of date. */
  /** @internal */ externalStale = false;
  /**
   * The last item the external agent's own session has seen (D235): a group member on another
   * model may have spoken since, and the external agent is told what it missed.
   */
  /** @internal */ externalSeen: Item | null = null;

  /**
   * Starts the external agent ahead of the first message (D193): its models show in the model
   * menu. Nothing happens for the IDE's own models. With no folder open it starts in the chat's
   * private folder (D208).
   */
  async prepareExternal(): Promise<void> {
    const config = externalConfig(this);
    if (!config) return;
    if (this.agentSettings.peek()?.agent !== config.name)
      await (await externalFor(this, config)).prepare();
    await this.syncExternalModel();
  }

  /**
   * The external agent's model for the agent this chat is with (D288): Plato's own (Claude Code ·
   * Sonnet) in Plato's chat, else the one remembered for the external agent, before the next turn,
   * so the model pill says what will answer. Only while idle, and only on that agent's connection.
   */
  async syncExternalModel(): Promise<void> {
    const external = this.external;
    if (!external || this.status.peek() !== "idle") return;
    const agent = soloAgentOf(this);
    const own = agent ? subagentChoices(this.services)[agent] : undefined;
    const id = own?.model === `acp/${external.config.name}` ? own.agentModel : undefined;
    await external.syncModel(id).catch(() => {});
  }

  /** Sets the external agent's model or reasoning level (D193). */
  async setAgentSetting(category: AcpSetting["category"], value: string): Promise<void> {
    const config = externalConfig(this);
    if (!config) throw new Error("This chat isn't using an external agent.");
    if (this.status.peek() !== "idle")
      throw new Error("Wait for the agent's turn to end before changing its model.");
    const pending = { agent: config.name, category, value };
    this.agentSettingPending.value = pending;
    try {
      await (await externalFor(this, config)).setSetting(category, value);
    } finally {
      if (this.agentSettingPending.peek() === pending) this.agentSettingPending.value = null;
    }
  }

  /** Requests a subagent makes on its own model: its own ids, cancelled with it (D195). */
  /** @internal */ readonly subRequests = new Set<string>();

  /** Subagents working in the background (D195), by id: what stops them. */
  /** @internal */ readonly background = new Map<
    string,
    {
      name: string;
      stop(): void;
      started?: number;
      /** A follow-up it reads at its next step (D245); false once it's past taking one. */
      message?(text: string, from: string): boolean;
    }
  >();
  /** Reports of background subagents that finished during a turn: they join it at its next step. */
  /** @internal */ reports: Item[] = [];
  /** Background subagents running now (for the panel and agent.stopSubagents). */
  readonly backgroundCount = signal(0);
  /** @internal */ reportTimer: ReturnType<typeof setTimeout> | undefined;

  /** Stops the subagents working in the background (or the one `id`); returns how many. */
  stopBackground(id?: string): number {
    const runs = id ? [this.background.get(id)].filter((b) => !!b) : [...this.background.values()];
    for (const b of runs) b.stop();
    return runs.length;
  }

  /** A harness message to the agent within the same turn (a failed check). */
  /** @internal */ turnFeedback(text: string): void {
    this.items.push({ type: "user", id: newId("u"), text, auto: "verify" });
    this.bump();
  }

  /** Picks the turn up where it stopped (after an error or Stop): no new message is added. */
  async continueTurn(): Promise<void> {
    await this.hydrating;
    if (!this.items.some((i) => i.type === "user" && !i.auto))
      throw new Error("Nothing to continue.");
    // Changed only once the session is claimed, and put back if the turn can't start (D160).
    await this.exclusive(async () => {
      // Drop the notice being answered; the model sees the conversation as it was.
      const popped: Item[] = [];
      while (this.items[this.items.length - 1]?.type === "notice") {
        const notice = this.items.pop();
        if (notice) popped.unshift(notice);
      }
      // Ending with the agent's own reply (stopped mid-answer, an older "Stopped."), the request
      // would end on an assistant message: a prefill for Claude, a repeat for others. A short
      // harness message asks it to go on instead (D159).
      const note: Item | undefined =
        this.items[this.items.length - 1]?.type === "assistant"
          ? { type: "user", id: newId("u"), text: CONTINUE_NOTE, auto: "continue" }
          : undefined;
      if (note) this.items.push(note);
      try {
        await sendNow(this, "", [], { resume: true });
      } catch (err) {
        if (note) this.items = this.items.filter((it) => it !== note);
        this.items.push(...popped);
        this.bump();
        throw err;
      }
    });
  }

  /**
   * One turn (or summary, or side task) at a time: claimed synchronously, before the first await,
   * so two quick sends can't both start.
   */
  private busy = false;
  /** @internal */ compactFailedAt = -1;

  /** Tool calls since the plan last changed (update_plan), for the reminder below. */
  /** @internal */ callsSincePlan = 0;

  /**
   * A model deep in its work forgets to tick its plan off (the card stays at 0/8 while it writes
   * ten files). Like Claude Code's reminders: after a run of calls without update_plan while a
   * step is unfinished, the tool result carries one quiet line asking for an update (D154).
   */
  /** @internal */ planNudge(tool: string, outcome: ToolOutcome): ToolOutcome {
    // wrap_up finishes the plan itself (D301): no nudge on it.
    if (tool === "update_plan" || tool === "wrap_up") {
      this.callsSincePlan = 0;
      return outcome;
    }
    const plan = this.plan.peek();
    if (!plan.length || plan.every((s) => s.status === "done")) return outcome;
    if (++this.callsSincePlan < PLAN_NUDGE_AFTER) return outcome;
    this.callsSincePlan = 0;
    const current =
      plan.find((s) => s.status === "in_progress") ?? plan.find((s) => s.status !== "done");
    return {
      ...outcome,
      result: `${outcome.result}\n\n(Reminder from the IDE: your plan shows "${current?.text ?? "a step"}" as ${current?.status === "in_progress" ? "in progress" : "not done"}. If it's finished, send update_plan { advance: true } together with your next call. Don't mention this reminder.)`,
    };
  }

  /** Rules attached to tool results so far (rule path → turn, D200): each comes once per chat. */
  readonly attachedRules = new Map<string, number>();

  /**
   * A subfolder's AGENTS.md or a rule for matching files (.mdc globs, applyTo) comes with the
   * result of the first read or edit of a file it covers (D200), like Claude Code's nested
   * CLAUDE.md and Cursor's auto-attached rules.
   */
  /** @internal */ async withRules(
    call: { name: string; arguments: unknown },
    outcome: ToolOutcome,
  ): Promise<ToolOutcome> {
    if (outcome.isError || !RULE_TOOLS.has(call.name)) return outcome;
    const path = (call.arguments as { path?: unknown } | null)?.path;
    if (typeof path !== "string") return outcome;
    const rules = await rulesFor(this.services)
      .forFile(path, this.attachedRules, this.turn)
      .catch(() => "");
    // Skills for that file (`paths`, nested skills, D221): offered once per chat.
    const skills = await this.fileNote(path).catch(() => "");
    const extra = `${rules}${skills}`;
    return extra ? { ...outcome, result: `${outcome.result}${extra}` } : outcome;
  }

  /** Skills offered with tool results so far (name → turn, D221): each once per chat. */
  readonly toldSkills = new Map<string, number>();

  /** What a tool result about `path` adds besides rules (set by the skills; D221). */
  fileNote: (path: string) => Promise<string> = async () => "";

  /** Reloads browser tabs showing a page of a local server (agent.reloadBrowser). */
  async reloadLocalPages(): Promise<void> {
    if (this.services.settings.peek<boolean>("agent.reloadBrowser") === false) return;
    const snap = await this.services.state.get("ide://browser").catch(() => null);
    const tabs = Array.isArray(snap?.value) ? (snap.value as Record<string, unknown>[]) : [];
    for (const t of tabs) {
      const url = typeof t.url === "string" ? t.url : "";
      if (!/^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(url))
        continue;
      void this.services.dispatcher.execute("browser.reload", { tab: t.tab }).catch(() => {});
    }
  }

  /** A message can be sent now and join the running turn at its next step (D151). */
  /**
   * A message can be sent while the agent works (D151, D189): in the IDE's own agent's turn it
   * joins at the next step; anything else that keeps the session busy (an external agent's turn,
   * a summary) can't take it mid-way, so it's held and sent as the next message when that ends.
   */
  canQueue(): boolean {
    return (this.inTurn || this.busyNow()) && !this.cancelled;
  }

  /** Whether a message sent now joins the running turn (else it goes once the turn ends). */
  joinsTurn(): boolean {
    return this.inTurn;
  }

  /** Sends a message into the running turn: it waits for the next step (D151). */
  enqueue(
    text: string,
    context: string[] = [],
    opts: {
      images?: string[];
      attachments?: SentAttachment[];
      uploads?: Upload[];
      paths?: string[];
    } = {},
  ): QueuedMessage {
    if (!this.canQueue()) throw new Error("The agent is still working; stop it first.");
    const queued: QueuedMessage = {
      id: newId("u"),
      text,
      context,
      ...(opts.images?.length && { images: opts.images }),
      ...(opts.attachments?.length && { attachments: opts.attachments }),
      ...(opts.uploads?.length && { uploads: opts.uploads }),
      ...(opts.paths?.length && { paths: opts.paths }),
    };
    this.queued.value = [...this.queued.peek(), queued];
    this.bump();
    return queued;
  }

  /** Takes a queued message back (its text returns to the box). */
  unqueue(id: string): QueuedMessage | undefined {
    const found = this.queued.peek().find((m) => m.id === id);
    if (found) {
      this.queued.value = this.queued.peek().filter((m) => m !== found);
      this.bump();
    }
    return found;
  }

  /** Whether Send now can hurry the waiting messages: a turn that reads them, or an external one. */
  canSendNow(): boolean {
    return (
      !this.cancelled && (this.inTurn || (this.external !== null && this.status.peek() !== "idle"))
    );
  }

  /**
   * Send now (D363): the waiting messages are read now, not after what the agent is doing. The
   * IDE's agent: the reply being written, or the commands running, are cut short and its turn
   * goes on with them (a subagent or a wait finishes first). An external agent can't take a
   * message mid-turn: its turn is cancelled and they go as the next message.
   */
  sendQueuedNow(): boolean {
    if (!this.queued.peek().length || !this.canSendNow()) return false;
    if (this.inTurn) {
      this.interruptStep = true;
      if (this.stepPhase === "model" && this.requestId)
        void aiIpc.cancel(this.requestId).catch(() => {});
      if (this.stepPhase === "tools") {
        for (const it of this.items)
          if (it.type === "tool" && it.status === "running")
            void execIpc.cancel(it.id).catch(() => {});
        // A hook still running before or after a call held the step until its timeout.
        for (const stop of [...this.hookStops]) stop();
        // A call waiting for approval: the message answers it instead (turned down).
        for (const p of this.permissions.peek()) p.resolve("deny");
      }
      return true;
    }
    const external = this.external;
    if (!external) return false;
    this.sendHeldAfterCancel = true;
    this.stopReason = "you sent a message";
    this.cancelled = true;
    external.cancel();
    clearTimeout(this.hungTimer);
    this.hungTimer = setTimeout(() => {
      if (this.external === external && this.status.peek() !== "idle") void external.stop();
    }, 3000);
    return true;
  }

  /**
   * Puts queued messages back in the box (Take back, Stop): their text, and the cards they had
   * (files, pastes, images, project files), after what's there now (D160).
   */
  returnQueued(list: readonly QueuedMessage[]): void {
    if (!list.length) return;
    // A queued command's model and tools go with it: the text sent later is a new message.
    this.nextTurnModel = null;
    this.nextTurnTools = null;
    this.nextTurnEffort = null;
    const text = list.map((m) => m.text).filter((t) => t && t !== "(See the attachments.)");
    if (text.length) this.draft.value = text.join("\n\n");
    const uploads = list.flatMap((m) => m.uploads ?? []);
    if (uploads.length) this.uploads.value = [...this.uploads.peek(), ...uploads];
    const paths = list.flatMap((m) => m.paths ?? []);
    if (paths.length) this.attachments.value = [...new Set([...this.attachments.peek(), ...paths])];
  }

  /** The queued messages as conversation items (the loop adds them before its next call). */
  /** @internal */ takeQueued(forOther?: (text: string) => boolean): Item[] {
    // Background subagents' reports first (D195); in a group chat, only those for the member
    // answering now: the others wait for their own member's turn after this one (D253).
    const speaker = this.turnSpeaker;
    const mine = (r: Item) =>
      r.type !== "user" || !r.to || !speaker || r.to.toLowerCase() === speaker.toLowerCase();
    const reports = this.cancelled ? [] : this.reports.filter(mine);
    if (reports.length) this.reports = this.reports.filter((r) => !mine(r));
    const all = this.queued.peek();
    if (!all.length || this.cancelled) return reports;
    // A group chat (D243): a message reaches the member answering now at its next step (to stop
    // or steer it), unless it calls on another agent: that one waits and starts its own round
    // when this turn ends (D232), so its @mentions pick who answers.
    const group = this.members.peek().length > 0;
    const later = group && forOther ? all.filter((m) => forOther(m.text)) : group ? all : [];
    const queued = all.filter((m) => !later.includes(m));
    if (!queued.length) return reports;
    this.queued.value = later;
    return [
      ...reports,
      ...queued.map((m) => ({
        type: "user" as const,
        id: m.id,
        text: m.text,
        steer: true,
        turn: this.turn,
        ...(m.context.length && { context: m.context }),
        ...(m.images?.length && { images: m.images }),
        ...(m.attachments?.length && { attachments: m.attachments }),
      })),
    ];
  }

  /** Whether a turn, summary or side task is running (or starting). */
  busyNow(): boolean {
    return this.busy || this.status.peek() !== "idle";
  }

  private running: Promise<unknown> | null = null;

  /** Waits for a turn that has finished but is still saving (idle, not yet released). */
  async settle(): Promise<void> {
    if (this.busy && this.status.peek() === "idle" && this.running)
      await this.running.catch(() => {});
  }

  /**
   * The load of the saved transcript (hydrate), while and after it runs. Starting a turn first
   * waits for it: otherwise a message sent right after the tab came back would start a turn
   * whose items, turn counter, changeset and plan the load then overwrites.
   */
  /** @internal */ hydrating: Promise<boolean> = Promise.resolve(false);

  /** @internal */ async exclusive<T>(run: () => Promise<T>): Promise<T> {
    await this.hydrating;
    // A turn that has finished but is still saving (idle, not yet released): wait for it rather
    // than refuse a message sent the moment the answer appeared.
    await this.settle();
    if (this.busy || this.status.peek() !== "idle")
      throw new Error("The agent is still working; stop it first.");
    this.busy = true;
    const pending = run();
    this.running = pending;
    try {
      return await pending;
    } finally {
      this.running = null;
      this.busy = false;
      // Messages held while it couldn't take them (an external agent's turn): sent now.
      queueMicrotask(() => void this.sendHeld());
    }
  }

  /** Sends the messages held during a turn that couldn't take them, as one next message. */
  private async sendHeld(): Promise<void> {
    const held = this.queued.peek();
    if (!held.length || this.busyNow()) return;
    this.queued.value = [];
    const sendNow = this.sendHeldAfterCancel;
    this.sendHeldAfterCancel = false;
    // Stopped: they go back to the box, never into a later turn (unless Send now stopped it).
    if (this.cancelled && !sendNow) {
      this.returnQueued(held);
      this.bump();
      return;
    }
    this.bump();
    const text = held.map((m) => m.text).join("\n\n");
    const context = held.flatMap((m) => m.context);
    const images = held.flatMap((m) => m.images ?? []);
    const attachments = held.flatMap((m) => m.attachments ?? []);
    try {
      await this.send(text, context, {
        ...(images.length && { images }),
        ...(attachments.length && { attachments }),
      });
    } catch {
      // Couldn't start (stopped, a provider error): the text goes back to the box.
      this.returnQueued(held);
    }
  }

  send(
    text: string,
    context: string[] = [],
    opts: { resume?: boolean; images?: string[]; attachments?: SentAttachment[] } = {},
  ): Promise<void> {
    return this.exclusive(() => sendNow(this, text, context, opts));
  }

  private retryNoticeId: string | null = null;

  /** @internal */ showRetryNotice(text: string, detail: string): void {
    const existing = this.items.find((i) => i.id === this.retryNoticeId);
    if (existing?.type === "notice") {
      existing.text = text;
      existing.detail = detail;
    } else {
      this.retryNoticeId = newId("n");
      this.items.push({ type: "notice", id: this.retryNoticeId, text, detail, tone: "info" });
    }
    this.bump();
  }

  /** @internal */ clearRetryNotice(): void {
    if (!this.retryNoticeId) return;
    const at = this.items.findIndex((i) => i.id === this.retryNoticeId);
    if (at >= 0) this.items.splice(at, 1);
    this.retryNoticeId = null;
    this.bump();
  }

  /** Regenerates the last answer: drops everything after the last message and sends it again. */
  retry(opts: { undoFiles?: boolean } = {}): Promise<void> {
    return retryNow(this, opts);
  }

  /** The newest message you wrote (what Retry sends again), if any. */
  lastUserMessage(): Extract<Item, { type: "user" }> | undefined {
    const item = this.items.findLast((i) => i.type === "user" && !i.auto);
    return item?.type === "user" ? item : undefined;
  }

  /**
   * Edits a message you sent and sends it again: the conversation after it is dropped; with
   * `undoFiles` the files the agent changed since go back first (D200), else they stay as they are.
   */
  resend(itemId: string, text: string, opts: { undoFiles?: boolean } = {}): Promise<void> {
    return resendNow(this, itemId, text, opts);
  }

  /**
   * Files the agent changed in turn `turn` and later ones (what restoring to before it would
   * put back), from the checkpoints.
   */
  changedSince(turn: number): Promise<string[]> {
    return changedSinceNow(this, turn);
  }

  /**
   * Restore checkpoint (D200, Cursor's): the chat goes back to before message `itemId` and, with
   * `files` (the default), so do the files the agent changed since. Returns the message's text
   * (it goes back in the box to edit and send again) and the files put back.
   */
  rewind(
    itemId: string,
    opts: { files?: boolean } = {},
  ): Promise<{ text: string; restored: string[]; failed: string[] }> {
    return rewindNow(this, itemId, opts);
  }

  /** Why the turn was stopped, when it wasn't the Stop button ("the folder was closed", D161). */
  private stopReason: string | null = null;

  /** The notice a stopped turn ends with; its reason, once. */
  /** @internal */ stoppedText(): string {
    const text = this.stopReason ? `Stopped: ${this.stopReason}.` : "Stopped.";
    this.stopReason = null;
    return text;
  }

  stop(reason?: string): void {
    // Stop stops everything the chat started, the background subagents too (D195), and a group
    // chat's round of agents answering each other (D231).
    this.groupChain = null;
    this.nextSpeaker = null;
    this.stopBackground();
    if (this.status.peek() === "idle") {
      // A background subagent (or the auto-review) may be waiting on a question with the chat
      // idle: it's refused, so the stopped run ends instead of waiting for an answer.
      for (const p of this.permissions.peek()) p.resolve("deny");
      for (const q of this.questions.peek()) q.resolve(null);
      return;
    }
    this.stopReason = reason ?? null;
    this.cancelled = true;
    this.interruptStep = false;
    this.sendHeldAfterCancel = false;
    for (const stop of [...this.stopHandlers]) stop();
    if (this.external) {
      const external = this.external;
      external.cancel();
      // An agent that doesn't answer its cancel (hung) is ended: the turn can't stay "running"
      // with every send refused (D161). Ending it rejects the prompt that waits.
      clearTimeout(this.hungTimer);
      this.hungTimer = setTimeout(() => {
        if (this.external === external && this.status.peek() !== "idle") void external.stop();
      }, 3000);
    }
    if (this.requestId) void aiIpc.cancel(this.requestId).catch(() => {});
    // A subagent on its own model (D195).
    for (const r of this.subRequests) void aiIpc.cancel(r).catch(() => {});
    for (const it of this.items)
      if (it.type === "tool" && it.status === "running") void execIpc.cancel(it.id).catch(() => {});
    for (const p of this.permissions.peek()) p.resolve("deny");
    for (const q of this.questions.peek()) q.resolve(null);
  }

  /** Puts files back as they were before turn `turn`'s changes were applied (and later ones). */
  restore(turn: number): Promise<string[]> {
    return restoreNow(this, turn);
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    if (this.deleted) return;
    // A stream never pauses 1.5 s: saved at least every 10 s anyway, so a crash mid-answer
    // loses seconds, not the turn (D161).
    this.saveDue ??= Date.now() + 10_000;
    this.saveTimer = setTimeout(
      () => {
        this.saveDue = undefined;
        void this.save();
      },
      Math.max(0, Math.min(1500, this.saveDue - Date.now())),
    );
  }
  private saveDue: number | undefined;

  /**
   * A one-off model call shown as a turn of this session (tidying up memory, D110): `label` is the
   * user message; `finish` turns the reply into the answer (and may propose changes, which are
   * reviewed like any agent edit).
   */
  sideTask(
    label: string,
    request: { system: string; prompt: string; maxTokens: number },
    finish: (reply: string, turn: number) => Promise<string>,
  ): Promise<void> {
    return this.exclusive(() => sideTaskNow(this, label, request, finish));
  }

  /**
   * Summarizes the older part of the conversation with the session's model and replaces it by a
   * summary item (D109). `focus`: what the summary should keep in particular.
   */
  compact(focus?: string): Promise<{ count: number }> {
    return this.exclusive(() => compactNow(this, focus));
  }

  /** What every request repeats (in characters): the kept system prompt and the tool definitions. */
  promptSize(): { system: number | null; tools: number } {
    return {
      system: this.frozenSystem?.length ?? null,
      tools: JSON.stringify(this.tools().map((t) => t.spec)).length,
    };
  }

  /** Models that turned out to have no native tool calling (the loop fell back): text protocol. */
  /** @internal */ readonly textModels = new Set<string>();

  /** agent.budget.perChat in dollars (0: none). */
  chatBudget(): number {
    const b = this.services.settings.peek<number>("agent.budget.perChat");
    return typeof b === "number" && b > 0 ? b : 0;
  }

  toJSON(): unknown {
    return sessionJSON(this);
  }

  async save(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saveDue = undefined;
    if (this.items.length === 0 || this.deleted) return;
    // One save at a time: two at once would both expect the same version, and the second would
    // look like another window's write (D221).
    const next = this.saving.then(() => this.saveNow());
    this.saving = next.catch(() => {});
    return next;
  }

  private saving: Promise<void> = Promise.resolve();

  /** The saved file's version as this window last read or wrote it (D221; null: not saved). */
  /** @internal */ savedVersion: string | null = null;

  /**
   * Another window saved this chat since this one loaded it (D221: the same chat open in two
   * windows). Nothing is saved here until the user picks a version (agent.resolveChatConflict).
   */
  readonly conflict = signal(false);

  private saveNow(): Promise<void> {
    return saveSessionNow(this);
  }

  /**
   * Ends a conflict (D221): `keep` "here" saves this window's chat over the other; "other"
   * loads the saved one in place of this window's (not while the agent works).
   */
  resolveConflict(keep: "here" | "other"): Promise<void> {
    return resolveSaveConflict(this, keep);
  }

  /** Resolves once its saved transcript is loaded (reading another chat, D238). */
  loaded(): Promise<boolean> {
    return this.hydrating;
  }

  /** Fills this session from its saved transcript (if any). Turns wait for it (`hydrating`). */
  hydrate(): Promise<boolean> {
    this.hydrating = loadSaved(this).then((found) => {
      // A chat reopened from Chats resumes (D371): its hooks hear "resume", not "startup".
      if (found && this.items.length && this.hookStart === "startup") this.hookStart = "resume";
      return found;
    });
    return this.hydrating;
  }

  private readonly notifier: { dispose(): void };

  /** The chat is being deleted: stop, and never write it again. */
  markDeleted(): void {
    this.deleted = true;
    this.stopBackground();
    clearTimeout(this.saveTimer);
    clearTimeout(this.reportTimer);
    this.stop();
  }

  dispose(): void {
    this.disposed = true;
    // What happened since the last save is kept (closing the window mid-turn).
    if (!this.deleted && this.items.length) void this.save();
    this.notifier.dispose();
    this.stop();
    void this.external?.stop();
    clearTimeout(this.saveTimer);
    clearTimeout(this.hungTimer);
    clearTimeout(this.reportTimer);
  }
}

/**
 * The tools a chat of the IDE's agent has (its mode narrows them per turn): the IDE's own, then
 * `extra` (MCP servers', subagents', skills', web search). The MCP page counts them too.
 */
export function chatTools(
  services: WorkbenchServices,
  small: boolean,
  items: () => readonly Item[],
  extra: readonly AgentTool[],
): AgentTool[] {
  const memory = memoryFor(services);
  const s = services.settings;
  // With no folder open, what needs a repository can't run (D390): not even named.
  const noFolder = !services.workspace.root.peek();
  const tools = [
    ...CORE_TOOLS,
    PLAN_TOOL,
    ...(small || !exploreAvailable(services) ? [] : [EXPLORE_TOOL]),
    ...(small || s.peek<boolean>("agent.richBlocks") === false ? [] : DISPLAY_TOOLS),
    // wrap_up, chapters, proposed tasks, Plan mode, notify (D301–D305): not for a small model.
    ...(small ? [] : turnTools(items)),
    ...(memory.enabled() ? MEMORY_TOOLS : []),
    chatAttachmentsTool(items),
    // Chat images into the project (D381).
    saveImageTool(items),
    // suggest_sandbox_allowance (D350): only while commands run sandboxed.
    ...(small || readSandboxSetting(s.peek<unknown>("agent.sandbox")) === "off"
      ? []
      : SANDBOX_TOOLS),
    ...(small
      ? browserTools(services).filter((t) => t.spec.name === "screenshot")
      : browserTools(services)),
    // Desktop control (D353): only when turned on, on Windows, and not for a small model.
    ...(small ? [] : computerTools(services)),
    // Subagents too are left out for a small model (like explore): it handles fewer tools.
    ...extra.filter((t) => !small || t.spec.name !== "delegate"),
  ];
  return noFolder ? tools.filter((t) => !NEEDS_FOLDER.has(t.spec.name)) : tools;
}

/** Tools that work on the open folder's repository (D390): left out while none is open. */
const NEEDS_FOLDER: ReadonlySet<string> = new Set(["enter_worktree", "exit_worktree", "watch_pr"]);

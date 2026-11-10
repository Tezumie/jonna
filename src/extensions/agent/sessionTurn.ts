// One turn of the IDE's own agent (D221: split from session.ts): the message, the model for the
// turn, the tool runner (gates, permissions, subagents), the model requests with their retries,
// the verify step and formatting after it, and how the turn ends. The state stays on the session.

import type { SentAttachment } from "../../core/agent/attachments";
import { customModeId, findCustomMode, modeAllows } from "../../core/agent/chatModes";
import { needsCompaction } from "../../core/agent/compact";
import { charsFor, type Item } from "../../core/agent/conversation";
import { findMentions, isGroupContext, MAIN_MEMBER, newContext } from "../../core/agent/groupChat";
import { fileLockKey, KeyedLock } from "../../core/agent/keyedLock";
import {
  affordableOutput,
  ContextOverflowError,
  isContextOverflow,
  isTransientError,
  isUsageLimit,
  type LoopDeps,
  NoToolsError,
  retryDelayMs,
  runTurn,
  SwitchModelError,
  shortError,
  type ToolOutcome,
  toolArguments,
} from "../../core/agent/loop";
import { styledPrompt, styleKey } from "../../core/agent/outputStyles";
import { finishPlan } from "../../core/agent/plan";
import { callDisallowed } from "../../core/agent/slash";
import { resolveModelName } from "../../core/agent/subagents";
import { withoutRefusedResults } from "../../core/agent/toolRules";
import { TOOL_SEARCH, withLoadedTools } from "../../core/agent/toolSearch";
import { MAX_VERIFY_ROUNDS, needsVerify, verifyFeedback } from "../../core/agent/verify";
import { aiIpc, type ModelDetails } from "../../core/ipc/agent";
import { fsIpc } from "../../core/ipc/fs";
import { IpcError } from "../../core/ipc/invoke";
import { formatIpc } from "../../core/ipc/process";
import { appIpc } from "../../core/ipc/system";
import { externalAgents } from "./acpAgents";
import { fileChangeNotes } from "./changeNotices";
import { nameChat } from "./chatTitle";
import { chatWorkspaceOf } from "./chatWorkspace";
import { chatWorktreeNote } from "./chatWorktrees";
import { ideState, systemPrompt } from "./context";
import { customModes } from "./customModes";
import { deferredNote, loadedTools, notLoaded } from "./deferredTools";
import {
  contextKind,
  continueGroup,
  groupTurn,
  knownAgents,
  memberInfo,
  soloSpeaker,
} from "./groupChat";
import { startTogether } from "./groupTogether";
import { newId } from "./ids";
import { memoryFor } from "./memory";
import { activeOutputStyle } from "./outputStyles";
import { participantFor, sendToParticipant } from "./participants";
import { savePlanDoc } from "./planDocs";
import { detectCheck } from "./projectCheck";
import type { ModelChoice } from "./providers";
import { RepetitionWatch } from "./repetition";
import { conversationRoom, isRoomContext, roomContext } from "./roomService";
import type { AgentSession } from "./session";
import { sendExternal } from "./sessionExternal";
import { autoReview, flushReports, runSubagent, startBackground } from "./sessionSubagents";
import { compactWith } from "./sessionSummaries";
import { allModeRules, MODE_RULES, modeRules, SMALL_CONTEXT } from "./sessionTypes";
import {
  contextLengthFor,
  countUsage,
  requestOptions,
  thinkFor,
  withinBudget,
} from "./sessionUsage";
import { agentExternalModel } from "./subagents";
import { runToolGate } from "./toolGate";
import { priceOf } from "./usage";
import { recordUsage } from "./usageLog";

/**
 * agent.formatOnFinish (D179): the files this turn wrote to disk (auto-apply; changes held for
 * review aren't on disk yet) go through the project's formatter (Prettier, Biome, Ruff, Black,
 * rustfmt, gofmt, clang-format), like format-on-save would. Files without one are left alone.
 */
/** A model by key, by name, or by a Claude alias (sonnet, opus: the newest such, D232). */
function findModel(session: AgentSession, wanted: string): ModelChoice | undefined {
  const resolved = resolveModelName(
    wanted,
    session.providers.models.peek().map((m) => m.key),
  );
  return (
    session.providers.find(wanted) ??
    session.providers.models.peek().find((m) => m.model === wanted) ??
    (resolved ? session.providers.find(resolved) : undefined)
  );
}

/** The IDE model a group member's own agent file asks for, when it's there (D235). */
function memberModelChoice(
  session: AgentSession,
  mode: string | undefined,
): ModelChoice | undefined {
  const wanted = mode ? (findCustomMode(customModes.peek(), mode)?.model ?? "").trim() : "";
  if (!wanted || /^(default|inherit)$/i.test(wanted) || wanted.startsWith("acp/")) return undefined;
  return findModel(session, wanted);
}

/** Where Build sends the plan (agent.build, D249): an agent that can't edit hands it on. */
function planReadyText(session: AgentSession): string {
  const own = findCustomMode(customModes.peek(), session.chatMode.peek());
  if (!own || modeAllows(own, { name: "edit_file", readOnly: false }))
    return "Plan ready. Build switches to Agent mode and carries it out.";
  const builder = findCustomMode(customModes.peek(), customModeId("builder"));
  return `Plan ready. Build hands it to ${builder ? (builder.agent?.label ?? "the builder") : memberInfo("agent").label}.`;
}

/**
 * What a chat with one agent sends with each message: its mode's rules, or its agent's
 * instructions with Plan's or Ask's on top (D249).
 */
function soloRules(session: AgentSession): string[] {
  const mode = session.chatMode.peek();
  const overlay = session.overlay(mode);
  return [modeRules(mode), overlay && MODE_RULES[overlay]].filter((r): r is string => !!r);
}

/** The external agent a user's agent's file or card names ("acp/<name>"), when it's set up (D249). */
function memberExternal(session: AgentSession, mode: string | undefined): string | null {
  const wanted = mode ? (findCustomMode(customModes.peek(), mode)?.model ?? "").trim() : "";
  if (!wanted.startsWith("acp/")) return null;
  const name = wanted.slice(4);
  return externalAgents(session.services).some((a) => a.name === name) ? name : null;
}

export async function formatChanged(session: AgentSession): Promise<void> {
  if (session.services.settings.peek<boolean>("agent.formatOnFinish") !== true) return;
  const formatted: string[] = [];
  // Only what this turn wrote to disk (changes held for review aren't there yet).
  for (const path of session.changeset.writtenIn(session.turn).slice(0, 50)) {
    if (session.cancelled) return;
    try {
      const text = new TextDecoder().decode(await fsIpc.read(path));
      // An open file with unsaved edits is left alone (formatting it on disk would conflict).
      const open = session.services.quickDiff.bufferText(path);
      if (open !== null && open !== text) continue;
      const result = await formatIpc.project(path, text);
      if (!result || result.text === text) continue;
      // Through the changeset like the agent's own edits: checkpointed, one undo entry, and
      // merged with anything typed while the formatter ran. A file under review stays under
      // review (formatting doesn't accept the agent's edits for the user).
      const reviewing = session.changeset.get(path) !== undefined;
      await session.changeset.propose(path, result.text, session.turn);
      if (!reviewing) await session.changeset.accept([path]);
      formatted.push(path);
    } catch {
      // No formatter, or it failed on this file: leave it as written.
    }
  }
  if (formatted.length)
    session.items.push({
      type: "notice",
      id: newId("n"),
      text: `Formatted ${formatted.length} file${formatted.length === 1 ? "" : "s"} the agent changed.`,
      tone: "info",
    });
}

/**
 * The verify step (D127): when this message's work changed files (on disk in both edit modes
 * since D199) and nothing has run the project's check since, run it as a visible run_command —
 * with the same permissions as the agent's own commands.
 */
export async function verifyTurn(
  session: AgentSession,
  firstItem: number,
  deps: LoopDeps,
): Promise<{ failed: boolean; command: string; result: string } | null> {
  const s = session.services.settings;
  if (s.peek<string>("agent.verify") === "off") return null;
  const command =
    (s.peek<string>("agent.verifyCommand") ?? "").trim() || (await detectCheck(session.services));
  if (!command || !needsVerify(session.items, firstItem, command) || session.cancelled) return null;
  const call = {
    id: newId("v"),
    name: "run_command",
    arguments: {
      command,
      timeoutMs: (s.peek<number>("agent.verifyTimeoutSeconds") || 180) * 1000,
      // A check runs to the end, even one that looks like a server.
      background: false,
    },
  };
  const item: Extract<Item, { type: "tool" }> = {
    type: "tool",
    id: newId("i"),
    callId: call.id,
    name: call.name,
    args: call.arguments,
    status: "running",
    check: true,
  };
  session.items.push(item);
  session.bump();
  try {
    const outcome = await deps.execute(call, item);
    item.status = outcome.denied ? "denied" : outcome.isError ? "error" : "done";
    item.result = outcome.result;
    item.summary = outcome.summary;
    item.detail = outcome.detail;
  } catch (err) {
    item.status = "error";
    item.result = `Error: ${err instanceof Error ? err.message : String(err)}`;
    item.summary = err instanceof Error ? err.message : String(err);
  }
  session.bump();
  // Denied or stopped: the user decided; nothing goes back to the agent.
  if (item.status === "denied" || session.cancelled) return null;
  return { failed: item.status === "error", command, result: item.result ?? "" };
}

/**
 * The team agents answering right now, window-wide (D254): one of the user's agents (Builder,
 * Reviewer) answers in one conversation at a time, so its DM and #general don't both have it
 * editing at once. A turn for an agent busy elsewhere waits for it (Stop works meanwhile). The
 * main agent isn't limited: several chats with it at once is how it's used.
 */
const agentTurns = new Map<string, { done: Promise<void>; where: string }>();

export async function sendNow(
  session: AgentSession,
  text: string,
  context: string[],
  opts: { resume?: boolean; images?: string[]; attachments?: SentAttachment[] },
): Promise<void> {
  if (session.status.peek() !== "idle")
    throw new Error("The agent is still working; stop it first.");
  // "@name" of an extension's chat participant (D255): it answers instead of the model.
  const participant = opts.resume ? null : participantFor(session, text);
  if (participant) return sendToParticipant(session, text, participant);
  const speaker =
    groupTurn(session, opts.resume ? null : text)?.speaker ?? soloSpeaker(session.chatMode.peek());
  const key = speaker === MAIN_MEMBER ? null : speaker.toLowerCase();
  if (!key) return sendTurn(session, text, context, opts);
  // The agent answers in one chat at a time: wait while another chat has it. The check and the
  // claim below run with no await between them, so two waiters woken together can't both take it.
  let told = false;
  for (let busy = agentTurns.get(key); busy; busy = agentTurns.get(key)) {
    const other = busy;
    if (!told) {
      told = true;
      session.cancelled = false;
      session.addNotice(`${speaker} is answering in ${other.where}; this starts when it's done.`);
    }
    session.status.value = "running";
    let stop = () => {};
    const stopped = await new Promise<boolean>((resolve) => {
      stop = () => resolve(true);
      session.stopHandlers.add(stop);
      void other.done.then(() => resolve(false));
    });
    session.stopHandlers.delete(stop);
    session.status.value = "idle";
    // Stopped while it waited: it never started, so the caller puts the message back in the
    // box (returning quietly lost it, attachments and all).
    if (stopped || session.cancelled) throw new Error("Stopped before it started.");
  }
  let finish = () => {};
  const mine = {
    done: new Promise<void>((resolve) => {
      finish = resolve;
    }),
    where: session.title.peek(),
  };
  agentTurns.set(key, mine);
  try {
    await sendTurn(session, text, context, opts);
  } finally {
    // Only this turn's claim is let go.
    if (agentTurns.get(key) === mine) agentTurns.delete(key);
    finish();
  }
}

async function sendTurn(
  session: AgentSession,
  text: string,
  context: string[],
  opts: { resume?: boolean; images?: string[]; attachments?: SentAttachment[] },
): Promise<void> {
  // A retried or edited message carries the rules of the mode it was sent in: the current
  // mode's rules replace them (D180).
  const oldRules = allModeRules();
  // A group chat's room and member instructions (D231) are added again for the new speaker.
  // A retried or edited message's hook context is added again by its hooks, not kept (D244).
  context = context.filter(
    (c) =>
      !oldRules.has(c) &&
      !isGroupContext(c) &&
      !isRoomContext(c) &&
      !c.startsWith("From the user's hooks:"),
  );
  // A thread in a channel (D237): the channel and what it's for, with every message.
  const roomLine = roomContext(session);
  if (roomLine) context = [roomLine, ...context];
  // A custom mode that's gone (its file renamed or removed, the folder no longer trusted): this
  // message goes in Agent mode, external agents' too.
  const mode = session.chatMode.peek();
  if (mode.startsWith("custom:") && !findCustomMode(customModes.peek(), mode)) {
    session.chatMode.value = "agent";
    session.items.push({
      type: "notice",
      id: newId("n"),
      text: `The ${mode.slice(7)} mode isn't there any more (its file was renamed or removed, or the folder isn't trusted): this message goes in Agent mode.`,
      tone: "info",
    });
  }
  const key = session.model.peek();
  // The agent answering: a group chat's member, or the agent a direct chat is with.
  const agentMode =
    groupTurn(session, opts.resume ? null : text)?.mode ??
    (session.members.peek().length ? undefined : session.chatMode.peek());
  // One of the user's agents on an external agent (Planner on Claude Code, D249) answers through
  // it, whatever the chat's own model is.
  const agentExternal = memberExternal(session, agentMode);
  // A group chat on an external agent (D235): a member with a model of its own (Rev on
  // OpenRouter) answers on that model, through the IDE's loop; the others are the external agent.
  // A chat with one of the user's agents (Builder's direct messages) too (D242): its own model.
  const ownModel =
    !agentExternal && key?.startsWith("acp/") ? memberModelChoice(session, agentMode) : undefined;
  const external = agentExternal ?? (key?.startsWith("acp/") && !ownModel ? key.slice(4) : null);
  // A chat limited to some tools (a helper, D232) can't be answered by an external agent: its own
  // tools can't be narrowed.
  if (external && session.toolLimit)
    throw new Error(
      "This chat is limited to the tools of the chat that started it, and an external agent's tools can't be limited: pick one of the IDE's models.",
    );
  if (external) {
    // An external agent's tools can't be narrowed: it gets the mode's rules as instructions,
    // and its own permission prompts still guard changes (a command's allowed-tools too).
    if (!opts.resume) {
      session.nextTurnTools = null;
      session.nextTurnEffort = null;
    }
    // A group chat (D232): the external agent answers as the member whose turn it is, told the
    // room and that member's instructions; the round goes on as with the IDE's own models.
    const group = groupTurn(session, opts.resume ? null : text);
    const rules = group ? [group.context] : soloRules(session);
    // An agent-to-agent turn: the hand-off note already in the chat is what's sent.
    const last = session.items[session.items.length - 1];
    const note = opts.resume && last?.type === "user" && last.auto === "group" ? last : null;
    const firstItem = session.items.length;
    session.turnSpeaker = group?.speaker ?? soloSpeaker(session.chatMode.peek());
    try {
      await sendExternal(
        session,
        note ? note.text : opts.resume ? "Continue." : text,
        external,
        [...context, ...rules],
        {
          ...opts,
          ...(note && { existing: note }),
          // One of your agents on the external agent: its own model of it (D288).
          model: agentExternal
            ? agentExternalModel(session.services, session.turnSpeaker)
            : undefined,
          // Its routing (members brought in, the round) holds once the turn has started (D233).
          ...(group && { onStart: () => group.commit() }),
        },
      );
    } catch (err) {
      session.turnSpeaker = null;
      session.groupChain = null;
      throw err;
    }
    const speaker = session.turnSpeaker;
    session.turnSpeaker = null;
    for (const it of session.items.slice(firstItem))
      if (it.type === "assistant" && speaker) it.speaker ??= speaker;
    // The replies show their speaker's name now (it was set after the last redraw).
    session.bump();
    if (!session.cancelled && !session.error.peek() && !session.queued.peek().length)
      continueGroup(session, speaker, firstItem);
    else session.groupChain = null;
    return;
  }
  // The message shows and Stop works from now on, not after the model list, the MCP servers
  // and the IDE state are ready (that took seconds, with a Send button that did nothing).
  session.cancelled = false;
  session.error.value = null;
  session.status.value = "running";
  // Messages can be queued from now on, not only once the model call starts (D159).
  session.inTurn = true;
  // Before a group chat's "joined" notice.
  const firstMessage = session.items.length === 0;
  // A group chat (D231): the member answering this turn, in its own mode; else the chat's mode.
  const group = groupTurn(session, opts.resume ? null : text);
  session.turnMode = group?.mode ?? session.chatMode.peek();
  session.turnSpeaker = group?.speaker ?? soloSpeaker(session.chatMode.peek());
  const firstItem = session.items.length;
  const writesBefore = session.changeset.writes;
  let message: Extract<Item, { type: "user" }> | undefined;
  if (!opts.resume) {
    if (firstMessage) {
      // A chat opened before its folder (the new-folder card): it belongs where it starts.
      session.workspaceRoot ??= chatWorkspaceOf(session.services);
      // A channel's conversation keeps the channel's name (D415).
      if (!session.keepsTitle) {
        session.title.value = text.replace(/\s+/g, " ").slice(0, 60) || "New session";
        // The model names the chat in its first reply (D124); this title stands until then.
        session.wantTitle = session.services.settings.peek<boolean>("agent.autoTitle") !== false;
      }
    }
    session.turn++;
    // A finished plan belongs to the last task: a new message starts without it (it came back
    // as a 3/3 card over the next task, D160). The reminder counts from zero again.
    const plan = session.plan.peek();
    if (plan.length && plan.every((p) => p.status === "done")) session.plan.value = [];
    session.callsSincePlan = 0;
    // The mode's rules go with the message, not the frozen system prompt (prompt caching). A
    // group brief or a channel line the model already reads isn't sent again (D253).
    const rules = group ? [group.context] : soloRules(session);
    const withMode = newContext(session.items, [...context, ...rules], contextKind);
    message = {
      type: "user",
      id: newId("u"),
      text,
      turn: session.turn,
      ...(withMode.length && { context: withMode }),
      // Plan or Ask on one of the user's agents shows as that (D249).
      ...(!group &&
        session.chatMode.peek() !== "agent" && {
          mode: session.overlay(session.chatMode.peek()) ?? session.chatMode.peek(),
        }),
      ...(opts.images?.length && { images: opts.images }),
      ...(opts.attachments?.length && { attachments: opts.attachments }),
      ...(firstMessage && session.wantTitle && { askTitle: true }),
    };
    session.items.push(message);
  }
  session.bump();
  let choice!: ModelChoice;
  let details!: ModelDetails;
  try {
    // UserPromptSubmit hooks (D227): one can stop the message (it didn't start: the catch below
    // takes it off and agent.send puts it back in the box) or add context to it.
    if (message) {
      // SessionStart (D371): the chat's first message (or the first after /clear, a reopen or a
      // summary) carries what its hooks print.
      const started = await session.startHooks();
      if (started)
        message.context = [
          ...(message.context ?? []),
          // Kept on a retry (the filter above takes only UserPromptSubmit's): it ran once.
          `From the user's SessionStart hooks:\n${started}`,
        ];
      const hook = await session.runHook("UserPromptSubmit", { prompt: text });
      if (hook?.block || hook?.halt) throw new Error(`A hook stopped this message: ${hook.reason}`);
      if (hook?.context)
        message.context = [...(message.context ?? []), `From the user's hooks:\n${hook.context}`];
    }
    await Promise.all([
      session.providers.refresh().catch(() => {}),
      session.prepare().catch(() => {}),
    ]);
    // A model for this kind of turn (D195, like Claude Code's opusplan): Plan mode's, or the
    // one Build was given; the chat's own model stays as it was.
    // Build's model goes with Build's message (a background report's turn doesn't take it).
    const forMessage = message ? session.nextTurnModel : null;
    if (message) session.nextTurnModel = null;
    // A slash command's allowed-tools hold for its own turn (D203), fixed before the tool list.
    session.turnAllowedTools = message ? session.nextTurnTools : null;
    if (message) session.nextTurnTools = null;
    // A skill's `effort` (D221) holds for the turn /name started.
    session.turnEffort = message ? session.nextTurnEffort : null;
    if (message) session.nextTurnEffort = null;
    // For `~/` patterns in allowed-tools (D221).
    session.home ??= (await appIpc.info().catch(() => null))?.homeDir ?? null;
    // The agent answering's own model (D288: no plan or build model of their own; Plato's model
    // is the plan's, the main agent's the build's).
    const roleKey = forMessage ?? findCustomMode(customModes.peek(), session.turnMode)?.model ?? "";
    // A Claude alias (sonnet, opus) in an agent file names the newest such model (D232).
    const forRole = roleKey ? findModel(session, roleKey) : undefined;
    // An agent's model that isn't there: said, rather than silently using the chat's.
    if (roleKey && !forRole)
      session.addNotice(`${roleKey} isn't available, so this turn uses the chat's model.`);
    const picked =
      forRole ||
      (session.model.peek() && session.providers.find(session.model.peek() as string)) ||
      session.providers.defaultModel();
    if (!picked) {
      throw new Error(
        "No model available. Start Ollama (ollama.com) and pull a model, e.g. `ollama pull qwen3:8b`, or add an OpenAI-compatible provider in settings (agent.providers).",
      );
    }
    choice = picked;
    session.price = priceOf(session.services, session.providers, picked.key);
    session.turnCost = 0;
    if (!forRole) session.model.value = choice.key;
    details = await session.providers.detailsFor(choice);
    // The IDE's state goes with the message and stays with it (prompt caching).
    if (message) {
      const state = await ideState(session.services).catch(() => "");
      // Files changed since the agent read them, while it waited (D308).
      const changed = await fileChangeNotes(session.services, session.changeset, session.id);
      // In a worktree (D337): where its tools work, with each message.
      const told = [state, changed, chatWorktreeNote(session.id)].filter(Boolean).join("\n\n");
      if (told) message.state = told;
    }
    if (session.cancelled) throw new Error("Stopped before it started.");
  } catch (err) {
    // It didn't start: the message comes off the conversation (agent.send puts it back in the
    // box with its attachments), and the session is idle again.
    if (message) {
      session.items = session.items.filter((it) => it !== message);
      session.turn--;
    }
    session.inTurn = false;
    session.turnAllowedTools = null;
    session.turnEffort = null;
    session.turnSpeaker = null;
    session.groupChain = null;
    const left = session.queued.peek();
    if (left.length) {
      session.queued.value = [];
      session.returnQueued(left);
    }
    session.status.value = "idle";
    session.bump();
    throw err;
  }
  // The turn has started: a group chat's routing (members the message brought in, the round)
  // takes effect now, never for a turn that didn't start (D233).
  // Members answering together (D245) start beside this turn once its deps exist.
  group?.commit(true);
  // Per model, not for good: a model without native tools uses the text protocol; switching to
  // one that has them goes back to native calls.
  session.textProtocol = details.tools === false || session.textModels.has(choice.key);
  const s = session.services.settings;
  // `let`: a skill loaded mid-turn may switch the model for the rest of it (D232).
  let contextLength = contextLengthFor(session, choice, details);
  let extra = requestOptions(session, choice, details);
  let think = thinkFor(session.services, details);
  let budgetChars = conversationBudget(session, contextLength);
  /** The loop's deps once made (switchModel updates its budget and vision). */
  let turnDeps: LoopDeps | null = null;
  /**
   * A skill's `model`, asked for mid-turn, or the backup model after a usage limit (D254, with
   * `note`): taken before the next request.
   */
  let wantedModel: { model: string; by: string; note?: string } | null = null;
  /** The turn moved to its backup model already (D254): once a turn. */
  let fellBack = false;
  const switchModel = async (): Promise<void> => {
    const wanted = wantedModel;
    wantedModel = null;
    if (!wanted) return;
    // "default" / "inherit": the turn's model stays.
    if (/^(default|inherit)$/i.test(wanted.model.trim())) return;
    // A Claude alias (sonnet) names the newest such model, as in agent files (D232).
    const resolved = resolveModelName(
      wanted.model,
      session.providers.models.peek().map((m) => m.key),
    );
    const next =
      session.providers.find(wanted.model) ??
      session.providers.models.peek().find((m) => m.model === wanted.model) ??
      (resolved ? session.providers.find(resolved) : undefined);
    if (!next) {
      session.addNotice(
        `${wanted.by} asks for ${wanted.model}, which isn't available; this turn stays on ${choice.model}.`,
      );
      return;
    }
    if (next.key === choice.key) return;
    const nextDetails = await session.providers.detailsFor(next);
    // A model that calls tools the other way takes over too (D233): the next request renders
    // the conversation in its protocol (`toMessages` writes native calls as <tool_call> text and
    // text calls as native ones). The switch runs before the step's messages are built.
    session.textProtocol = nextDetails.tools === false || session.textModels.has(next.key);
    choice = next;
    details = nextDetails;
    contextLength = contextLengthFor(session, choice, details);
    extra = requestOptions(session, choice, details);
    think = thinkFor(session.services, details);
    budgetChars = conversationBudget(session, contextLength);
    // The loop reads these from its deps: the new model's budget and vision from now on.
    if (turnDeps) {
      turnDeps.budgetChars = budgetChars;
      turnDeps.vision = details.vision !== false;
    }
    session.price = priceOf(session.services, session.providers, choice.key);
    session.addNotice(
      wanted.note ?? `${wanted.by} uses ${choice.model} for the rest of this turn.`,
    );
  };
  /** The backup model for this turn's agent at a usage limit (D254): its file's, else the setting. */
  const fallbackModel = (): string =>
    findCustomMode(customModes.peek(), session.turnMode)?.fallbackModel ??
    s.peek<string>("agent.fallbackModel")?.trim() ??
    "";
  const profile = s.peek<string>("agent.smallModelProfile") ?? "auto";
  session.small = profile === "on" || (profile === "auto" && contextLength < SMALL_CONTEXT);
  // One tool list per turn: the prompt prefix stays the same. A tool_search adds the tools it
  // loaded at the end (D319).
  /** The output limit a key could pay for, learned once per turn (D366, D379). */
  let affordable: number | null = null;
  let turnTools = session.tools().map((t) => t.spec);
  const asksTitle = session.items.some((it) => it.type === "user" && it.askTitle === true);
  let subSystem: string | null = null;
  /** A subagent is talking through the turn's own requests (`subSystem`). */
  let sharedChatBusy = false;
  const systems: (string | null)[] = [];
  let failed = false;
  /** The user's messages were waiting when the turn ended (they go before a group's next agent). */
  let heldBack = false;
  /** What a subagent started after the turn uses (the automatic review). */
  let laterDeps: LoopDeps | null = null;
  try {
    const runTool: LoopDeps["execute"] = async (call, item) => {
      // Deferred tools too (D319): a subagent's own list may name one; the chat's own calls of
      // one not loaded stop at `execute` below.
      const tool = session.callableTools().find((t) => t.spec.name === call.name);
      if (!tool) return { result: `Error: unknown tool "${call.name}".`, isError: true };
      const args = toolArguments(call.arguments);
      // Arguments that weren't JSON (cut off at the output limit, or a model's typo): said so,
      // rather than running the tool without them (write_file emptied the file).
      if (!args)
        return {
          result: `Error: the arguments of ${call.name} weren't valid JSON${typeof call.arguments === "string" && call.arguments.length > 2000 ? " (probably cut off at the output limit: write a large file in parts, write_file for the first part and edit_file for the rest)" : ""}. Nothing was run; call it again with a JSON object.`,
          isError: true,
          summary: "bad arguments",
        };
      // Stop ends the step even when the tool doesn't listen for it (an MCP call, an IDE
      // command that waits): the tool may finish in the background, its result is dropped.
      let stop: () => void = () => {};
      // Per call and never reset: a tool still finishing after Stop sees it even once the
      // next turn has started (the session's flag is cleared then), and skips its side effects.
      let ended = false;
      const stopped = new Promise<ToolOutcome>((resolve) => {
        stop = () => {
          ended = true;
          resolve({ result: "Stopped by the user.", isError: true });
        };
      });
      // A slash command's disallowed-tools refuses its Bash lines (D207) and the files or sites
      // its patterns name (`Read(.env)`, `WebFetch(domain:…)`, D221).
      const disallowed = session.turnAllowedTools?.disallowed ?? [];
      if (callDisallowed(disallowed, call.name, args, session.ruleContext()))
        return {
          result:
            call.name === "run_command"
              ? "The command the user ran doesn't allow this command line (its disallowed-tools). Do without it."
              : "The command the user ran doesn't allow this (its disallowed-tools). Do without it.",
          denied: true,
          summary: "disallowed",
        };
      // The tool gates: auto-approve's protected paths (D204), risky folders and agent config
      // files (D213).
      const gated = await runToolGate({
        session: session.id,
        name: call.name,
        args,
        ask: (req) => session.ask(req),
        note: (text) => session.addNotice(text),
      });
      if (gated) return gated;
      // A set: a sub-agent's tool call inside this one has its own (D160).
      session.stopHandlers.add(stop);
      // Two edits of one file never overlap (D253): calls of a step and subagents run together,
      // and so do other chats; by the file itself, however each names it (D254).
      const editKey =
        !tool.readOnly && typeof args.path === "string" && FILE_WRITERS.has(call.name)
          ? fileLockKey(session.services.workspace.resolve(args.path))
          : null;
      const runIt = (): Promise<ToolOutcome> =>
        tool.run(
          args,
          {
            services: session.services,
            session: session.id,
            turn: () => session.turn,
            changeset: session.changeset,
            // An agent whose file says `permissionMode: acceptEdits` keeps its edits (D245).
            autoApply: () =>
              session.autoApply.peek() ||
              !!findCustomMode(customModes.peek(), session.turnMode ?? session.chatMode.peek())
                ?.acceptEdits,
            ask: (req) => session.askForCall(call.name, args, req),
            output: (itemId, chunk) => {
              // The panel shows the live tail (the full result goes to the model).
              const next = (session.outputs.get(itemId) ?? "") + chunk;
              session.outputs.set(itemId, next.length > 64_000 ? next.slice(-48_000) : next);
              session.bump();
            },
            cancelled: () => session.cancelled || ended,
            plan: () => session.plan.peek(),
            setPlan: (steps) => {
              session.plan.value = steps;
              session.bump();
            },
            question: (itemId) => session.question(itemId),
            items: () => session.items,
            subagent: async (spec) => {
              // The turn's own requests carry one subagent's prompt at a time; one started while
              // another works (calls run together, D253, or nested: general → explore) sends its
              // own, as a background one does.
              const shared = !sharedChatBusy;
              if (shared) sharedChatBusy = true;
              try {
                return await runSubagent(
                  session,
                  spec,
                  { ...deps, execute: hookedTool },
                  budgetChars,
                  (sys) => {
                    if (sys === null) subSystem = systems.pop() ?? null;
                    else {
                      systems.push(subSystem);
                      subSystem = sys;
                    }
                  },
                  { choice, details },
                  undefined,
                  !shared,
                );
              } finally {
                if (shared) sharedChatBusy = false;
              }
            },
            // Not tool_search (D319): a subagent's tool list doesn't grow.
            toolNames: () =>
              session
                .tools()
                .map((t) => t.spec.name)
                .filter((n) => n !== TOOL_SEARCH),
            preApprove: (entries) => session.preApproveForTurn(entries),
            setTurnEffort: (effort) => {
              if (session.inTurn) session.turnEffort = effort;
            },
            setTurnModel: (model, by) => {
              if (session.inTurn) wantedModel = { model, by };
            },
            followChatMode: () => {
              if (session.inTurn) session.turnMode = session.chatMode.peek();
            },
            background: (spec) =>
              startBackground(session, spec, { ...deps, execute: hookedTool }, budgetChars, {
                choice,
                details,
              }),
          },
          item.id,
        );
      const running = editKey ? fileEdits.run(editKey, runIt) : runIt();
      try {
        const outcome = await Promise.race([running, stopped]);
        // Files its disallowed-tools refuses (`Read(.env)`) stay out of search results (D229).
        if (!disallowed.length || outcome.isError) return outcome;
        const result = withoutRefusedResults(
          disallowed,
          call.name,
          outcome.result,
          session.ruleContext(),
        );
        return result === outcome.result ? outcome : { ...outcome, result };
      } finally {
        session.stopHandlers.delete(stop);
      }
    };
    // PreToolUse hooks can stop a call (the reason goes to the agent); PostToolUse hooks' words
    // follow its result (D227). Subagents' and background agents' calls too, as in Claude Code.
    // A hook's `"continue": false` ends the turn.
    const hookedTool: LoopDeps["execute"] = async (call, item) => {
      const toolInput = toolArguments(call.arguments) ?? call.arguments;
      const pre = await session.runHook("PreToolUse", { tool: call.name, toolInput });
      if (pre?.halt) session.stop("a hook ended the turn");
      if (pre?.block || pre?.halt)
        return {
          result: `A hook blocked this call: ${pre.reason}`,
          isError: true,
          summary: "blocked by a hook",
        };
      // Stopped while the hook ran: the call doesn't start (not every tool checks for itself).
      if (session.cancelled)
        return { result: "Stopped by the user.", isError: true, summary: "stopped" };
      const ran = await runTool(call, item);
      // Files changed since the agent read them come with the result (D308).
      const changed = await fileChangeNotes(session.services, session.changeset, session.id);
      const out = changed ? { ...ran, result: `${ran.result}\n\n${changed}` } : ran;
      const post = await session.runHook("PostToolUse", {
        tool: call.name,
        toolInput,
        toolResponse: out.result.slice(0, 20_000),
      });
      if (post?.halt) session.stop("a hook ended the turn");
      const words = post?.reason || post?.context;
      return words
        ? {
            ...out,
            result: `${out.result}

From the user's hooks: ${words}`,
          }
        : out;
    };
    const deps: LoopDeps = {
      stableMessages: true,
      // A subagent's own conversation has one author.
      speakerLabels: () =>
        session.members.peek().length && subSystem === null
          ? { current: session.turnSpeaker, label: (name) => memberInfo(name).label }
          : null,
      // A chat that asked for a title: a `<title>` opening any reply is taken out (a retried
      // first answer brings it again); the first one names the chat.
      title: {
        wanted: () => asksTitle,
        set: (title) => {
          if (!session.wantTitle || !title) return;
          session.wantTitle = false;
          session.title.value = title;
        },
      },
      beforeStep: async () => {
        // A skill's model (D232) takes over before this step's messages are built: its tool
        // protocol decides how they're written (D233). Subagents have their own deps.
        await switchModel();
        // Past the chat's budget: asked once before spending more (D199).
        if (!(await withinBudget(session))) return;
        if (s.peek<boolean>("agent.autoCompact") === false) return;
        // After a failed summary, wait until the conversation has grown before trying again.
        if (session.items.length <= session.compactFailedAt) return;
        if (needsCompaction(session.items, budgetChars))
          await compactWith(session, choice, budgetChars, undefined, true, false, {
            tools: turnTools,
            think,
            extra,
          }).catch(() => {
            session.compactFailedAt = session.items.length + 4;
          });
      },
      // The provider refused the request as too big for the model's context: what the
      // estimate says fits didn't, so the older part is summarized against half the budget.
      recoverOverflow: async () => {
        if (subSystem !== null) return false; // a subagent's own conversation isn't this one
        const before = session.items.length;
        const { count } = await compactWith(
          session,
          choice,
          Math.floor(budgetChars / 2),
          undefined,
          true,
          false,
          { tools: turnTools, think, extra },
        );
        return count > 0 || session.items.length !== before;
      },
      // The deferred tools' names (D319), after the kept system prompt.
      system: () => deferredNote(session.splitTools()),
      tools: () => {
        turnTools = withLoadedTools(
          turnTools,
          session.tools().map((t) => t.spec),
          loadedTools(session.items),
        );
        return turnTools;
      },
      deferredTools: () => session.splitTools().deferred.map((t) => t.spec.name),
      chat: async (request, onEvent) => {
        // Built for the open folder (its path, AGENTS.md, memory): rebuilt when the chat
        // goes on in another one (D161).
        const root = session.services.workspace.root.peek();
        // Another folder, or the small-model profile switched (another model): a new prompt.
        // D251: a folder added to, taken out of or renamed in the workspace too (the prompt
        // lists them by name, and paths in it start with the names).
        const folders = session.services.workspace.folders.peek();
        const where =
          folders.length > 1 ? folders.map((f) => `${f.path}\u0001${f.name}`).join("\0") : root;
        // The output style (D356) is part of the prompt: another style, a new prompt (once).
        const { style } = await activeOutputStyle(session.services);
        const frozenKey = `${where}\0${session.small}\0${styleKey(style)}`;
        if (session.frozenFor !== frozenKey) session.frozenSystem = null;
        session.frozenFor = frozenKey;
        session.frozenSystem ??= styledPrompt(
          await systemPrompt(session.services, { small: session.small }),
          style,
        );
        // A sub-agent (explore) talks to the same model with its own prompt (D127).
        const system = subSystem ?? session.frozenSystem;
        const sentChars = request.messages.reduce((n, m) => n + m.content.length, system.length);
        const messages = [
          {
            ...request.messages[0],
            role: "system" as const,
            content: `${system}${request.messages[0]?.content ? `\n\n${request.messages[0].content}` : ""}`,
          },
          ...request.messages.slice(1),
        ];
        // Transient provider errors (rate limits, overload, 5xx, dropped connections) are
        // retried up to 3 times with backoff — but only while nothing has streamed yet, so a
        // retry never duplicates output. A line in the panel says what is happening.
        // A key that can't pay for the model's whole output limit (D366): asked again with less,
        // and the rest of the turn keeps the smaller limit (D379: each step relearned it).
        for (let attempt = 0; ; attempt++) {
          session.requestId = newId("r");
          let received = false;
          // Stops a model stuck repeating itself (D142); the turn ends with why.
          const watch = new RepetitionWatch();
          let stuck: string | null = null;
          try {
            await aiIpc.chat(
              session.requestId,
              {
                provider: choice.provider,
                model: choice.model,
                messages,
                tools: request.tools,
                contextLength,
                // Read per request: a skill loaded mid-turn may have set its effort (D229).
                ...requestOptions(session, choice, details),
                ...(affordable && { maxTokens: affordable }),
                ...(think !== undefined && { think }),
              },
              (event) => {
                // Stop pressed while the request was still starting: Rust hadn't registered
                // it, so that cancel found nothing. Cancel again now that it streams (D174).
                if (session.cancelled && !received)
                  void aiIpc.cancel(session.requestId ?? "").catch(() => {});
                if (!received && subSystem === null) {
                  received = true;
                  session.clearRetryNotice();
                  // Until the provider reports usage: an estimate from what was sent.
                  session.usage.value = {
                    tokens: Math.round(sentChars / 4),
                    limit: contextLength,
                    estimated: true,
                  };
                }
                received = true;
                if (event.kind === "done") {
                  if (subSystem === null) countUsage(session, event, contextLength, "chat", choice);
                  // The explore subagent on the chat's model (D127): logged, not in the meter.
                  else
                    recordUsage(session.services, {
                      source: "subagent",
                      session: session.id,
                      choice,
                      event,
                      price: session.price,
                    });
                }
                if (stuck) return;
                if (event.kind === "text" || event.kind === "thinking") {
                  stuck = watch.push(event.kind, event.text);
                  if (stuck && session.requestId)
                    void aiIpc.cancel(session.requestId).catch(() => {});
                }
                onEvent(event);
              },
            );
            if (stuck) throw new Error(stuck);
            session.clearRetryNotice();
            return;
          } catch (err) {
            if (stuck) {
              session.clearRetryNotice();
              throw new Error(stuck);
            }
            if (err instanceof IpcError && err.code === "AiNoTools")
              throw new NoToolsError(err.message);
            const message = err instanceof Error ? err.message : String(err);
            const cancelled = err instanceof IpcError && err.code === "Cancelled";
            // Asked for more output than the key can pay for: once more with what it can (D366).
            const canAfford = affordableOutput(message);
            if (!cancelled && !received && !session.cancelled && canAfford && !affordable) {
              affordable = canAfford;
              session.showRetryNotice(
                `${choice.provider.name ?? choice.provider.id} can only pay for ${canAfford.toLocaleString()} output tokens on this key — asking again with that limit`,
                message,
              );
              continue;
            }
            // Over the model's context (the size estimate was off): the loop summarizes and
            // tries the step again, once.
            if (!cancelled && !received && !session.cancelled && isContextOverflow(message)) {
              session.clearRetryNotice();
              throw new ContextOverflowError(message);
            }
            // A usage limit (a free tier's cap, a quota): the turn goes on with the agent's backup
            // model, after one retry for a limit that was only momentary (D254). Not for a
            // subagent sharing these requests: its loop has no model switch.
            const backup = fallbackModel();
            if (
              !cancelled &&
              !session.cancelled &&
              !received &&
              subSystem === null &&
              !fellBack &&
              backup &&
              isUsageLimit(message) &&
              (attempt >= 1 || !isTransientError(message))
            ) {
              fellBack = true;
              session.clearRetryNotice();
              const from = choice.model;
              wantedModel = {
                model: backup,
                by: session.turnSpeaker ?? "The agent",
                note: `${from} hit a usage limit (${shortError(message)}); this turn goes on with ${backup}.`,
              };
              throw new SwitchModelError(message);
            }
            if (
              cancelled ||
              session.cancelled ||
              received ||
              attempt >= 3 ||
              !isTransientError(message)
            ) {
              session.clearRetryNotice();
              throw err;
            }
            const delay = retryDelayMs(attempt + 1);
            session.showRetryNotice(
              `${choice.provider.name ?? choice.provider.id} didn't answer (${shortError(message)}) — retrying in ${Math.round(delay / 1000)} s (${attempt + 1}/3)`,
              message,
            );
            const until = Date.now() + delay;
            while (Date.now() < until && !session.cancelled)
              await new Promise((r) => setTimeout(r, 200));
            if (session.cancelled) {
              session.clearRetryNotice();
              throw err;
            }
          } finally {
            session.requestId = null;
          }
        }
      },
      // The plan reminder is for this turn's model only, not the explore sub-agent's (D160).
      execute: async (call, item) =>
        notLoaded(session.splitTools(), call.name) ??
        session.planNudge(call.name, await session.withRules(call, await hookedTool(call, item))),
      update: () => session.bump(),
      newId: () => newId("i"),
      cancelled: () => session.cancelled,
      concurrent: (call) => runsAlongside(session, call.name),
      budgetChars,
      // Unknown (most OpenAI-compatible providers) counts as yes; Ollama reports it.
      vision: details.vision !== false,
      maxSteps: s.peek<number>("agent.maxSteps") || 150,
      // Messages sent while this turn runs join it at the next step (D151).
      // In a group chat, one that calls on another agent waits for its own round (D243).
      takeQueued: () =>
        session.takeQueued((text) => {
          const speaker = session.turnSpeaker;
          return findMentions(text, knownAgents()).some((n) => n !== speaker);
        }),
      hasQueued: () =>
        !session.cancelled && (session.queued.peek().length > 0 || session.reports.length > 0),
      // Send now (D363).
      interrupt: {
        requested: () => session.interruptStep,
        clear: () => {
          session.interruptStep = false;
        },
        phase: (phase) => {
          session.stepPhase = phase;
        },
      },
    };
    turnDeps = deps;
    laterDeps = { ...deps, execute: hookedTool };
    if (group?.together.length)
      startTogether(session, group.together, laterDeps, budgetChars, { choice, details });
    // The verify step (D127): after a turn that changed files, the project's check runs; a
    // failure goes back to the agent, at most MAX_VERIFY_ROUNDS times.
    let stopHookUsed = false;
    for (let round = 0; ; round++) {
      const used = await runTurn(session, deps);
      // The loop fell back to the text protocol: remember it for this model.
      if (session.textProtocol && details.tools !== false) session.textModels.add(choice.key);
      if (session.cancelled) break;
      // Out of steps in the middle of the work (its last item a tool call, not an answer):
      // say so, with Continue, instead of ending as if it were done (and no check on
      // half-written work).
      const tail = session.items[session.items.length - 1];
      if (used >= deps.maxSteps && tail?.type !== "assistant") {
        session.items.push({
          type: "notice",
          id: newId("n"),
          text: `Paused after ${used} steps: the work isn't finished. Continue to let it carry on (agent.maxSteps sets the limit).`,
          tone: "info",
          actions: ["continue"],
        });
        break;
      }
      const check = await verifyTurn(session, firstItem, deps);
      if (check?.failed !== true) {
        // Stop hooks (D227): one can send the agent back to work, once per message (Claude
        // Code's stop_hook_active), so a hook that always says "not done" can't loop.
        const stop = await session.runHook("Stop", { stopHookActive: stopHookUsed });
        if (!stop?.block || stop.halt || stopHookUsed || session.cancelled) break;
        stopHookUsed = true;
        session.turnFeedback(`A Stop hook says the work isn't finished:
${stop.reason}`);
        continue;
      }
      if (round >= MAX_VERIFY_ROUNDS) {
        session.items.push({
          type: "notice",
          id: newId("n"),
          text: `\`${check.command}\` still fails after ${MAX_VERIFY_ROUNDS} tries: over to you.`,
          tone: "info",
        });
        break;
      }
      session.turnFeedback(verifyFeedback(check.command, check.result));
    }
    if (!session.cancelled) await formatChanged(session);
    // A reply with nothing in it (only thinking, or cut off at the output limit) said so.
    const last = session.items[session.items.length - 1];
    if (!session.cancelled && last?.type === "assistant" && !last.text.trim())
      session.items.push({
        type: "notice",
        id: newId("n"),
        text: "The model stopped without answering.",
        tone: "info",
        actions: ["continue"],
      });
  } catch (err) {
    failed = true;
    const message = err instanceof Error ? err.message : String(err);
    // Stopped (also while waiting to retry a provider error): "Stopped." says it (D161).
    if (!(err instanceof IpcError && err.code === "Cancelled") && !session.cancelled) {
      session.items.push({
        type: "notice",
        id: newId("n"),
        text: shortError(message),
        detail: `${message}\n\n${choice.provider.name ?? choice.provider.id} · ${choice.model}`,
        tone: "error",
        actions: ["retry", "continue"],
      });
      session.error.value = message;
    }
  } finally {
    session.inTurn = false;
    session.interruptStep = false;
    session.stepPhase = null;
    // A finished plan offers Build (D180): Agent mode carries it out.
    if (
      (session.turnMode === "plan" || session.overlay(session.turnMode) === "plan") &&
      !session.cancelled &&
      !failed
    ) {
      session.items.push({
        type: "notice",
        id: newId("n"),
        text: planReadyText(session),
        tone: "info",
        actions: ["build"],
      });
      // D330: the plan is saved as a document the user can edit before Build.
      void savePlanDoc(session);
    }
    session.turnMode = null;
    session.turnAllowedTools = null;
    session.turnEffort = null;
    for (const it of session.items) if (it.type === "assistant") it.streaming = false;
    for (const it of session.items.slice(firstItem))
      if (it.type === "assistant") {
        it.model ??= choice.model;
        it.modelKey ??= choice.key;
        // Who wrote it (D231): a group chat's member, or the agent the chat is with.
        if (session.turnSpeaker) it.speaker ??= session.turnSpeaker;
      }
    // What the turn cost, under its last answer (D199).
    if (session.turnCost > 0) {
      const last = session.items
        .slice(firstItem)
        .reverse()
        .find((it) => it.type === "assistant");
      if (last?.type === "assistant") last.cost = Math.round(session.turnCost * 10_000) / 10_000;
    }
    for (const it of session.items)
      if (it.type === "tool" && it.status === "running") it.status = "error";
    if (session.cancelled)
      session.items.push({
        type: "notice",
        id: newId("n"),
        text: session.stoppedText(),
        tone: "info",
        actions: ["continue"],
      });
    // Live output goes for items no longer in the conversation (a retry dropped them), and for
    // finished ones whose row has its final output (D160).
    const done = new Set(
      session.items.flatMap((it) =>
        it.type === "tool" && (it.status === "running" || !it.detail) ? [] : [it.id],
      ),
    );
    const ids = new Set(session.items.map((it) => it.id));
    for (const id of [...session.outputs.keys()])
      if (!ids.has(id) || done.has(id)) session.outputs.delete(id);
    // Older turns' change texts: only their counts are kept.
    session.changeset.settleSpans(session.turn - 1);
    // Files written: a local page open in the browser shows the old version until reloaded
    // when its server has no live reload (a plain Express server, D160).
    if (session.changeset.writes > writesBefore) void session.reloadLocalPages();
    // Messages still waiting (they came as the turn ended): after Stop or an error they go
    // back to the box; otherwise they're sent as the next message, together.
    const left = session.queued.peek();
    heldBack = left.length > 0;
    if (left.length) {
      session.queued.value = [];
      if (session.cancelled || failed) session.returnQueued(left);
      else
        setTimeout(
          () =>
            void session
              .send(
                left.map((m) => m.text).join("\n\n"),
                left.flatMap((m) => m.context),
                {
                  images: left.flatMap((m) => m.images ?? []),
                  attachments: left.flatMap((m) => m.attachments ?? []),
                },
              )
              .catch(() => session.returnQueued(left)),
        );
    }
    if (
      session.changeset.files.peek().some((f) => f.turn === session.turn) ||
      session.autoApply.peek()
    )
      if (!session.checkpoints.includes(session.turn)) session.checkpoints.push(session.turn);
    // A turn that ended normally finishes the step it was on (D300): the model needn't spend a
    // call on the last tick. Stopped or failed, the step stays where it was.
    if (!session.cancelled && !failed) session.plan.value = finishPlan(session.plan.peek());
    session.status.value = "idle";
    session.bump();
    await session.save();
    // The first reply came without a title (the model ignored the ask): one short request names
    // the chat (D294), so the list isn't the first words of every message.
    if (session.wantTitle && !session.cancelled && !failed) {
      session.wantTitle = false;
      void nameChat(session, session.title.peek());
    }
    if (laterDeps && !session.cancelled && !failed && !session.reportTurn)
      autoReview(session, laterDeps, budgetChars, { choice, details });
    // Reports that came after the turn's last step: a turn of their own (after Stop, the
    // next message takes them).
    if (!session.cancelled && !failed) flushReports(session);
    // A group chat's round (D231): the member this reply handed to answers next. Not after Stop
    // or an error, nor when the user's own messages or a report are waiting to go first.
    const speaker = session.turnSpeaker;
    session.turnSpeaker = null;
    if (!session.cancelled && !failed && !heldBack && !session.reports.length)
      continueGroup(session, speaker, firstItem);
    else session.groupChain = null;
    void memoryFor(session.services)
      .maybeSuggest()
      .catch(() => {});
  }
}

/** The tools that rewrite a file from what they read of it (one edit of a file at a time, D253). */
const FILE_WRITERS = new Set(["edit_file", "write_file"]);
/** Shared by every chat in the window: two chats editing one file wait for each other too. */
const fileEdits = new KeyedLock();

/** Whether a call may run alongside the step's others (D253): agent.parallelToolCalls. */
function runsAlongside(session: AgentSession, name: string): boolean {
  if (session.services.settings.peek<boolean>("agent.parallelToolCalls") === false) return false;
  const tool = session.tools().find((t) => t.spec.name === name);
  return tool ? (tool.concurrent ?? tool.readOnly) : false;
}

/**
 * How much of the conversation a turn sends: 70 % of the model's context, or less for a channel's
 * or an agent's direct messages' own conversation (D253, agent.channels.contextTokens): it's
 * mostly talk that grows for weeks, and every handoff sends it again. A summary and the recent
 * messages carry it; threads, where the work happens, keep the full budget.
 */
function conversationBudget(session: AgentSession, contextLength: number): number {
  const full = charsFor(Math.floor(contextLength * 0.7));
  const cap = session.services.settings.peek<number>("agent.channels.contextTokens") ?? 32_000;
  return cap > 0 && conversationRoom(session.id) ? Math.min(full, charsFor(cap)) : full;
}

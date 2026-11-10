// Summaries and one-off tasks of an agent session (D109, D110; split from session.ts in D221):
// summarizing the older part of the conversation (by hand or near the context limit) and a
// one-off model call shown as a turn (tidying up memory).

import {
  compactionCut,
  inConversationSummaryPrompt,
  planText,
  SUMMARY_SYSTEM,
  summaryPrompt,
  transcript,
} from "../../core/agent/compact";
import { charsFor, type Item, toMessages } from "../../core/agent/conversation";
import { shortError } from "../../core/agent/loop";
import { skillsUsedIn } from "../../core/agent/skills";
import { aiIpc, type ChatRequest, type ToolSpec } from "../../core/ipc/agent";
import { IpcError } from "../../core/ipc/invoke";
import { memberInfo } from "./groupChat";
import { newId } from "./ids";
import type { ModelChoice } from "./providers";
import { RepetitionWatch } from "./repetition";
import type { AgentSession } from "./session";
import { contextLengthFor, countUsage, requestOptions } from "./sessionUsage";

export async function sideTaskNow(
  session: AgentSession,
  label: string,
  request: { system: string; prompt: string; maxTokens: number },
  finish: (reply: string, turn: number) => Promise<string>,
): Promise<void> {
  if (session.status.peek() !== "idle") throw new Error("The agent is working; stop it first.");
  await session.providers.refresh().catch(() => {});
  const choice =
    (session.model.peek() && session.providers.find(session.model.peek() as string)) ||
    session.providers.defaultModel();
  if (!choice) throw new Error("No model available.");
  session.model.value = choice.key;
  if (session.items.length === 0) session.title.value = label.slice(0, 60);
  session.turn++;
  const turn = session.turn;
  session.items.push({ type: "user", id: newId("u"), text: label, turn, sideTask: true });
  const answer: Item & { type: "assistant" } = {
    type: "assistant",
    id: newId("a"),
    text: "",
    thinking: "",
    streaming: true,
    model: choice.key,
  };
  session.items.push(answer);
  session.cancelled = false;
  session.status.value = "running";
  session.error.value = null;
  session.bump();
  const requestId = newId("r");
  session.requestId = requestId;
  let reply = "";
  const watch = new RepetitionWatch();
  let stuck: string | null = null;
  try {
    await aiIpc
      .chat(
        requestId,
        {
          provider: choice.provider,
          model: choice.model,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.prompt },
          ],
          noCache: true,
          temperature: 0.2,
          maxTokens: request.maxTokens,
        },
        (event) => {
          if (stuck) return;
          if (event.kind === "text" || event.kind === "thinking") {
            stuck = watch.push(event.kind, event.text);
            if (stuck) void aiIpc.cancel(requestId).catch(() => {});
          }
          if (event.kind === "text") reply += event.text;
          else if (event.kind === "thinking") {
            answer.thinking += event.text;
            session.bump();
          }
        },
      )
      .catch((err: unknown) => {
        throw stuck ? new Error(stuck) : err;
      });
    if (stuck) throw new Error(stuck);
    answer.text = await finish(reply, turn);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Stop isn't an error.
    if (session.cancelled || (err instanceof IpcError && err.code === "Cancelled"))
      session.items.push({
        type: "notice",
        id: newId("n"),
        text: session.stoppedText(),
        tone: "info",
      });
    else {
      session.items.push({
        type: "notice",
        id: newId("n"),
        text: shortError(message),
        tone: "error",
      });
      session.error.value = message;
    }
  } finally {
    session.requestId = null;
    answer.streaming = false;
    if (!answer.text && !answer.thinking)
      session.items = session.items.filter((it) => it !== answer);
    if (
      session.changeset.files.peek().some((f) => f.turn === turn) &&
      !session.checkpoints.includes(turn)
    )
      session.checkpoints.push(turn);
    session.status.value = "idle";
    session.bump();
    await session.save();
  }
}

export async function compactNow(
  session: AgentSession,
  focus?: string,
): Promise<{ count: number }> {
  if (session.status.peek() !== "idle") throw new Error("The agent is working; stop it first.");
  await session.providers.refresh().catch(() => {});
  const choice =
    (session.model.peek() && session.providers.find(session.model.peek() as string)) ||
    session.providers.defaultModel();
  if (!choice) throw new Error("No model available to summarize with.");
  const details = await session.providers.detailsFor(choice);
  const limit = contextLengthFor(session, choice, details);
  session.status.value = "running";
  // A Stop of the previous turn mustn't make this summary look stopped (D161).
  session.cancelled = false;
  try {
    return await compactWith(
      session,
      choice,
      charsFor(Math.floor(limit * 0.7)),
      focus,
      false,
      true,
    );
  } finally {
    session.status.value = "idle";
    session.bump();
  }
}

export async function compactWith(
  session: AgentSession,
  choice: ModelChoice,
  budgetChars: number,
  focus: string | undefined,
  auto: boolean,
  everything = false,
  /** The turn's tools and options: the summary request then shares the cached prefix. */
  turn?: {
    tools: ToolSpec[];
    think: boolean | undefined;
    extra: Pick<ChatRequest, "cacheTtl" | "effort" | "maxTokens" | "keepAlive">;
  },
): Promise<{ count: number }> {
  // Manual: everything up to the newest message; automatic: what the budget needs.
  let cut = everything ? session.items.length : compactionCut(session.items, budgetChars);
  if (everything) {
    for (let i = session.items.length - 1; i >= 0; i--) {
      const it = session.items[i];
      if (it?.type === "assistant" || it?.type === "user") {
        cut = i + 1;
        break;
      }
    }
    // Never split a tool call from its result: end after the last finished step.
    while (cut < session.items.length && session.items[cut]?.type === "tool") cut++;
  }
  let start = 0;
  for (let i = cut - 1; i >= 0; i--)
    if (session.items[i]?.type === "summary") {
      start = i;
      break;
    }
  const older = session.items.slice(start, cut);
  const count = older.filter((it) => it.type !== "summary" && it.type !== "notice").length;
  if (count < 2) return { count: 0 };
  // PreCompact hooks (D371): told before the summary; they don't stop it (as Claude Code's).
  await session.runHook("PreCompact", {
    trigger: auto ? "auto" : "manual",
    ...(focus && { customInstructions: focus }),
  });
  const notice: Item = {
    type: "notice",
    id: newId("n"),
    text: "Summarizing earlier messages…",
    detail: "To keep the conversation within the model's context.",
    tone: "info",
  };
  session.items.splice(cut, 0, notice);
  session.bump();
  let text = "";
  const requestId = newId("r");
  const outer = session.requestId;
  session.requestId = requestId;
  // Providers that cache prompts (hosted ones): the same system prompt, tools and messages as
  // the turn, plus one request to summarize — the whole prefix is read from the cache. Local
  // models: a short transcript instead (a smaller prompt to process).
  const cacheFriendly =
    choice.provider.kind !== "ollama" && !session.textProtocol && !!session.frozenSystem;
  const plain: ChatRequest = {
    provider: choice.provider,
    model: choice.model,
    messages: [
      { role: "system", content: SUMMARY_SYSTEM },
      {
        role: "user",
        // A group chat's summary keeps who said what (D244).
        content: summaryPrompt(
          transcript(
            older,
            Math.max(4000, budgetChars - 2000),
            session.members.peek().length ? (n) => memberInfo(n).label : undefined,
          ),
          focus,
        ),
      },
    ],
    think: false,
    noCache: true,
    temperature: 0.2,
    maxTokens: 1500,
  };
  const request: ChatRequest = cacheFriendly
    ? {
        provider: choice.provider,
        model: choice.model,
        messages: [
          { role: "system", content: session.frozenSystem ?? "" },
          ...toMessages(older, { textProtocol: false, budgetChars, stable: true }),
          { role: "user", content: inConversationSummaryPrompt(focus) },
        ],
        tools: turn?.tools ?? session.tools().map((t) => t.spec),
        ...(turn?.extra ??
          requestOptions(session, choice, await session.providers.detailsFor(choice))),
        ...(turn?.think !== undefined && { think: turn.think }),
      }
    : plain;
  const ask = (req: ChatRequest) =>
    aiIpc.chat(requestId, req, (event) => {
      if (event.kind === "text") text += event.text;
      else if (event.kind === "done")
        countUsage(session, event, session.usage.peek()?.limit ?? 0, "summary", choice);
    });
  try {
    await ask(request);
    // A model that answered with tool calls instead of a summary: ask the plain way.
    if (cacheFriendly && !text.trim() && !session.cancelled) await ask(plain);
  } finally {
    session.requestId = outer;
    session.items = session.items.filter((it) => it !== notice);
  }
  let summary = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (!summary) throw new Error("The model returned an empty summary.");
  // The plan isn't in the system prompt (it changes): the summary carries it forward.
  const plan = session.plan.peek();
  if (plan.length) summary += `\n\nPlan at this point:\n${planText(plan)}`;
  // Skills stay in use across a summary (D221: no separate "mode"; their instructions were in
  // the part summarized away, so the agent is told to load them again when it needs them).
  const skills = skillsUsedIn(older);
  if (skills.length)
    summary += `\n\nSkills used earlier in this chat (their instructions were summarized away; load one again with use_skill before following it): ${skills.join(", ")}.`;
  // The conversation changed: the next request may as well refresh the system prompt (memory
  // index, instructions).
  session.frozenSystem = null;
  // The tool results that carried the rules are summarized away: they come again (D200).
  session.attachedRules.clear();
  session.toldSkills.clear();
  session.items.splice(cut, 0, {
    type: "summary",
    id: newId("m"),
    text: summary,
    count,
    auto,
  });
  // The next message starts it again for SessionStart hooks, as "compact" (D371).
  session.hookStart = "compact";
  session.bump();
  return { count };
}

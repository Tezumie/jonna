// Model request options and usage for an agent session (split from session.ts in D221): the
// context to use, provider options (caching, effort, output budget, keep-alive), thinking, the
// context meter and token totals, and the chat's budget (D199).

import { findCustomMode } from "../../core/agent/chatModes";
import { budgetState, formatCost } from "../../core/agent/prices";
import type { ChatEvent, ChatRequest, ModelDetails } from "../../core/ipc/agent";
import type { WorkbenchServices } from "../../workbench/services";
import { customModes } from "./customModes";
import { newId } from "./ids";
import type { ModelChoice } from "./providers";
import type { AgentSession } from "./session";
import { costOf } from "./usage";
import { recordUsage } from "./usageLog";

/** agent.thinking for a request: on, off, or the model's default when it thinks (auto). */
export function thinkFor(services: WorkbenchServices, details: ModelDetails): boolean | undefined {
  const setting = services.settings.peek<string>("agent.thinking") ?? "auto";
  if (setting === "on") return true;
  if (setting === "off") return false;
  return details.thinking ? true : undefined;
}

/**
 * The context to use, in tokens. Local models: the context to allocate (memory). Hosted ones:
 * the model's own window, capped by agent.cloudContextLength (a bigger context costs more per
 * request; caching softens it).
 */
export function contextLengthFor(
  session: AgentSession,
  choice: ModelChoice,
  details: ModelDetails,
): number {
  const s = session.services.settings;
  const local = choice.provider.kind === "ollama" && !choice.info.remote;
  const wanted = local
    ? s.peek<number>("agent.contextLength") || 16384
    : s.peek<number>("agent.cloudContextLength") || 200_000;
  return details.contextLength
    ? Math.min(details.contextLength, wanted)
    : local
      ? wanted
      : Math.min(wanted, 128_000);
}

/** Provider options for a request: caching hints, effort, output budget, keep-alive (D112). */
export function requestOptions(
  session: AgentSession,
  choice: ModelChoice,
  details: ModelDetails,
): Pick<ChatRequest, "cacheTtl" | "effort" | "maxTokens" | "keepAlive" | "modalities"> {
  const s = session.services.settings;
  if (choice.provider.kind === "anthropic") {
    // A skill's own effort for the turn it started (D221), else the answering agent's (D273: a
    // group chat's Effort list), else the setting.
    const effort =
      session.turnEffort ??
      findCustomMode(customModes.peek(), session.turnMode)?.effort ??
      s.peek<string>("agent.effort");
    return {
      cacheTtl: s.peek<string>("agent.cacheTtl") === "1h" ? "1h" : "5m",
      // Up to 64k when the model allows it (D157): a big file plus thinking ran out at 32k.
      maxTokens: Math.min(details.maxOutputTokens ?? 32_000, 64_000),
      ...(effort && effort !== "default" && { effort }),
    };
  }
  if (choice.provider.kind === "ollama")
    return { keepAlive: s.peek<string>("agent.ollama.keepAlive") || "30m" };
  // A model that draws (OpenRouter's image models) answers with images only when asked (D381).
  if (choice.info.outputImages) return { modalities: ["image", "text"] };
  return {};
}

/** The context meter and the session's token totals from a request's usage. */
export function countUsage(
  session: AgentSession,
  event: Extract<ChatEvent, { kind: "done" }>,
  limit: number,
  source: "chat" | "summary",
  choice: Pick<ModelChoice, "key" | "provider" | "info">,
): void {
  // The usage history (D201), with the provider's own cost when it reports one.
  recordUsage(session.services, {
    source,
    session: session.id,
    choice,
    event,
    price: session.price,
  });
  if (!event.inputTokens) return;
  const cached = event.cacheReadTokens ?? 0;
  session.usage.value = {
    tokens: event.inputTokens + (event.outputTokens ?? 0),
    limit,
    estimated: false,
    ...(cached && { cached }),
  };
  const t = session.totals.peek();
  session.totals.value = {
    requests: t.requests + 1,
    input: t.input + event.inputTokens,
    cacheRead: t.cacheRead + cached,
    cacheWrite: t.cacheWrite + (event.cacheWriteTokens ?? 0),
    output: t.output + (event.outputTokens ?? 0),
  };
  const spent =
    typeof event.cost === "number"
      ? event.cost
      : costOf(
          {
            requests: 1,
            input: event.inputTokens,
            cacheRead: cached,
            cacheWrite: event.cacheWriteTokens ?? 0,
            output: event.outputTokens ?? 0,
          },
          session.price,
        );
  if (spent !== null) {
    session.turnCost += spent;
    session.cost.value = Math.round(((session.cost.peek() ?? 0) + spent) * 10_000) / 10_000;
    checkBudget(session);
  }
}

/** A notice once the chat has used 80 % of its budget (or gone past it in one step). */
export function checkBudget(session: AgentSession): void {
  const budget = session.chatBudget();
  if (session.budgetWarned || budgetState(session.cost.peek(), budget) === "ok") return;
  session.budgetWarned = true;
  session.items.push({
    type: "notice",
    id: newId("n"),
    text: `This chat has used ${formatCost(session.cost.peek())} of its ${formatCost(budget)} budget (agent.budget.perChat).`,
    tone: "info",
  });
  session.bump();
}

/**
 * Whether the agent may make another request: below the budget, or the user said to go on past
 * it (asked once per chat; no answer, or "deny", stops the turn).
 */
export async function withinBudget(session: AgentSession): Promise<boolean> {
  const budget = session.chatBudget();
  if (session.budgetAllowed || budgetState(session.cost.peek(), budget) !== "over") return true;
  const answer = await session.ask({
    title: `This chat has used ${formatCost(session.cost.peek())}, past its ${formatCost(budget)} budget. Keep going?`,
    detail:
      "The budget is agent.budget.perChat. Allowing it lets this chat go on without asking again.",
    heading: "Over budget",
    kind: "agent",
    evenWithFullAccess: true,
  });
  if (answer === "deny") {
    session.stop("Stopped at the chat's budget.");
    return false;
  }
  session.budgetAllowed = true;
  return true;
}

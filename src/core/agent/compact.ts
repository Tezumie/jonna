// Compaction and the plan (D109). When the conversation nears the model's context, the older part
// is summarized by the model (goal, decisions, files, state, what's left) and replaced by a summary
// item; the newest steps stay verbatim. The plan is the agent's own checklist (update_plan),
// re-sent with every request so it survives compaction. DOM-free and tested.
import { type Item, toMessages } from "./conversation";

export type PlanStatus = "pending" | "in_progress" | "done";

export interface PlanStep {
  text: string;
  status: PlanStatus;
}

/** Steps from the update_plan tool's arguments (tolerant of what small models send). */
export function parsePlan(args: unknown): PlanStep[] | null {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  let raw = a.steps ?? a.plan ?? a.items ?? a.todos;
  if (typeof raw === "string") {
    const text: string = raw;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = text.split("\n").filter((l) => l.trim());
    }
  }
  if (!Array.isArray(raw)) return null;
  const steps: PlanStep[] = [];
  for (const entry of raw.slice(0, 30)) {
    if (typeof entry === "string") {
      const done = /^\s*[-*]?\s*\[x\]/i.test(entry);
      steps.push({
        text: entry.replace(/^\s*[-*]?\s*\[[ x~]?\]\s*/i, "").trim(),
        status: done ? "done" : "pending",
      });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const text = String(e.text ?? e.step ?? e.title ?? e.content ?? "").trim();
    if (!text) continue;
    const s = String(
      e.status ?? (e.done === true || e.completed === true ? "done" : "pending"),
    ).toLowerCase();
    const status: PlanStatus =
      s === "done" || s === "completed" || s === "complete"
        ? "done"
        : s === "in_progress" || s === "in-progress" || s === "active" || s === "doing"
          ? "in_progress"
          : "pending";
    steps.push({ text: text.slice(0, 200), status });
  }
  return steps;
}

/** The plan as the model sees it in the system prompt. */
export function planText(steps: readonly PlanStep[]): string {
  const mark = { done: "[x]", in_progress: "[~]", pending: "[ ]" } as const;
  return steps.map((s) => `${mark[s.status]} ${s.text}`).join("\n");
}

/** Characters the conversation would take as messages (no turns dropped). */
export function conversationChars(items: readonly Item[]): number {
  return toMessages(items, { textProtocol: false, budgetChars: Number.MAX_SAFE_INTEGER }).reduce(
    (n, m) => n + m.content.length + JSON.stringify(m.toolCalls ?? "").length,
    0,
  );
}

/** Whether to compact before the next request: over `ratio` of the budget. */
export function needsCompaction(items: readonly Item[], budgetChars: number, ratio = 0.8): boolean {
  return conversationChars(items) > budgetChars * ratio && compactionCut(items, budgetChars) > 0;
}

/**
 * Where to split: items before the index get summarized, the rest stay. Keeps the current turn
 * from its user message when that fits in half the budget, else its last few steps; never splits a
 * tool call from its result (the cut lands on a user or assistant item). 0: nothing to compact.
 */
export function compactionCut(items: readonly Item[], budgetChars: number): number {
  let start = 0;
  for (let i = items.length - 1; i >= 0; i--)
    if (items[i]?.type === "summary") {
      start = i + 1;
      break;
    }
  let lastUser = -1;
  for (let i = items.length - 1; i >= start; i--) {
    const it = items[i];
    if (it?.type === "user" && !it.auto) {
      lastUser = i;
      break;
    }
  }
  const fits = (from: number) => conversationChars(items.slice(from)) <= budgetChars / 2;
  let cut = lastUser > start && fits(lastUser) ? lastUser : -1;
  if (cut < 0) {
    // Keep the newest steps that fit, cutting at an assistant item.
    cut = items.length;
    for (let i = items.length - 1; i > start; i--) {
      const it = items[i];
      if (it?.type !== "assistant" && it?.type !== "user") continue;
      if (!fits(i)) break;
      cut = i;
    }
    if (cut === items.length) {
      // Even the last step alone is big: keep from the last assistant item.
      for (let i = items.length - 1; i > start; i--)
        if (items[i]?.type === "assistant") {
          cut = i;
          break;
        }
    }
  }
  // At least two items to summarize, or it isn't worth a model call.
  return cut - start >= 2 ? cut : 0;
}

const TOOL_LIMIT = 800;

/** The items to summarize as plain text (tool results shortened; oldest dropped past `limit`). */
export function transcript(
  items: readonly Item[],
  limitChars: number,
  /** A group chat's speaker names (D235): "REV:" rather than "ASSISTANT:". */
  nameOf?: (speaker: string) => string,
): string {
  const lines: string[] = [];
  for (const it of items) {
    if (it.type === "user") lines.push(`USER: ${it.text}`);
    else if (it.type === "assistant" && it.text)
      lines.push(
        `${it.speaker && nameOf ? nameOf(it.speaker).toUpperCase() : "ASSISTANT"}: ${it.text}`,
      );
    else if (it.type === "summary") lines.push(`EARLIER SUMMARY:\n${it.text}`);
    else if (it.type === "tool") {
      const result = it.result ?? "";
      lines.push(
        `TOOL ${it.name} ${JSON.stringify(it.args ?? {}).slice(0, 300)} → ${it.status}${result ? `\n${result.length > TOOL_LIMIT ? `${result.slice(0, TOOL_LIMIT)}…` : result}` : ""}`,
      );
    }
  }
  let text = lines.join("\n\n");
  if (text.length > limitChars) text = `…\n${text.slice(text.length - limitChars)}`;
  return text;
}

export const SUMMARY_SYSTEM =
  "You compress a coding agent's conversation so the agent can continue the task with only your summary. Be factual and concise; use short bullet points.";

export function summaryPrompt(text: string, focus?: string): string {
  return [
    "Summarize this conversation between a user and a coding agent. Include:",
    "- the user's goal and any requirements or preferences they stated",
    "- what has been done: decisions, files created or changed (paths), commands run and their results",
    "- the current state: what works, errors or failing tests still open",
    "- what is left to do next",
    focus ? `Pay special attention to: ${focus}` : "",
    "Don't invent anything. Reply with the summary only.",
    "",
    "<conversation>",
    text,
    "</conversation>",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * The summary request at the end of the conversation itself (providers with prompt caching send
 * the same prefix as the turn, read from the cache, plus this message).
 */
export function inConversationSummaryPrompt(focus?: string): string {
  return [
    "Stop here: don't call tools. The conversation so far is about to be replaced by a summary so you can continue with less context. Write that summary now, for yourself:",
    "- the user's goal and any requirements or preferences they stated",
    "- what has been done: decisions, files created or changed (paths), commands run and their results",
    "- the current state: what works, errors or failing tests still open",
    "- what is left to do next",
    focus ? `Pay special attention to: ${focus}` : "",
    "Be factual and concise; use short bullet points. Reply with the summary only.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The conversation as a Markdown document (export / share): messages, tool calls in one line. */
export function conversationMarkdown(title: string, items: readonly Item[]): string {
  const out: string[] = [`# ${title}`, ""];
  for (const it of items) {
    if (it.type === "user") out.push("## You", "", it.text, "");
    else if (it.type === "assistant" && it.text) out.push("## Agent", "", it.text, "");
    else if (it.type === "summary")
      out.push(
        `> Summary of ${it.count} earlier items:`,
        ">",
        ...it.text.split("\n").map((l) => `> ${l}`),
        "",
      );
    else if (it.type === "tool") {
      const args = JSON.stringify(it.args ?? {});
      out.push(
        `- \`${it.name}\` ${args.length > 160 ? `${args.slice(0, 160)}…` : args} → ${it.status}${it.summary ? ` (${it.summary})` : ""}`,
        "",
      );
    }
  }
  return `${out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

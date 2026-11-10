// A fork of the chat's agent (D324, Claude Code's Agent with subagent_type "fork"): a background
// subagent that starts with this conversation so far instead of a brief, for side work that leans
// on what was said and found. It gets the conversation as a transcript in its instructions
// (trimmed to fit its budget: the first request, then the newest messages; old tool results
// shortened more), works with the background subagents' read-only tools and reports back as a
// message. DOM-free and tested.

import { charsFor, fromLastSummary, type Item } from "./conversation";
import type { SubagentDef } from "./subagents";

export const FORK_PROMPT =
  "You are a fork of the agent in this chat: you start from the conversation so far (below) and do one side task while the agent goes on. Everything said and found in the conversation is yours to use; don't redo work it already did. Do only the task you're given, then report.";

/** The fork's own definition when no subagent is named. */
export const FORK_DEF: SubagentDef = {
  name: "fork",
  label: "Fork",
  description: "A copy of this chat's agent that starts from the conversation so far.",
  prompt: FORK_PROMPT,
  maxSteps: 40,
  source: "builtin",
};

/** The newest tool results keep this much; older ones less. */
const RECENT_TOOL_CHARS = 2000;
const OLD_TOOL_CHARS = 300;
const RECENT_TOOLS = 6;
/** The first request keeps at most this share of the budget. */
const FIRST_SHARE = 0.25;

/**
 * The transcript's budget in characters for a model with a `contextTokens` window (null: not
 * known): about a third of it, the rest left for the fork's own steps.
 */
export function forkBudget(contextTokens: number | null): number {
  const tokens = contextTokens && contextTokens > 0 ? contextTokens : 32_000;
  return Math.min(240_000, Math.max(8_000, charsFor(Math.floor(tokens * 0.35))));
}

function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.75);
  return `${text.slice(0, head)}\n… [${text.length - head} characters left out]`;
}

/**
 * The conversation as the fork reads it: who said what, the tool calls with their results. The
 * running call (the delegate that starts the fork) and notices are left out. When it doesn't fit
 * `budgetChars`, the first request stays and the newest messages that fit follow it.
 */
export function forkTranscript(
  all: readonly Item[],
  budgetChars: number,
): { text: string; omitted: number } {
  const items = fromLastSummary(all);
  const toolCount = items.filter((i) => i.type === "tool").length;
  let toolIndex = 0;
  const blocks: string[] = [];
  for (const it of items) {
    if (it.type === "user") {
      if (it.auto === "limit" || it.auto === "continue" || it.auto === "group") continue;
      const who = it.auto ? `IDE (automatic message: ${it.auto})` : "USER";
      if (it.text.trim()) blocks.push(`${who}: ${it.text.trim()}`);
    } else if (it.type === "assistant") {
      if (it.text.trim()) blocks.push(`YOU (the agent): ${it.text.trim()}`);
    } else if (it.type === "tool") {
      const recent = toolIndex++ >= toolCount - RECENT_TOOLS;
      if (it.status === "pending" || it.status === "running") continue;
      const args = JSON.stringify(it.args ?? {});
      const result = (it.result ?? "").trim();
      blocks.push(
        `TOOL ${it.name} ${args.length > 300 ? `${args.slice(0, 300)}…` : args} → ${it.status}${
          result ? `\n${cut(result, recent ? RECENT_TOOL_CHARS : OLD_TOOL_CHARS)}` : ""
        }`,
      );
    }
  }
  const size = (list: readonly string[]) => list.reduce((n, b) => n + b.length + 2, 0);
  if (size(blocks) <= budgetChars) return { text: blocks.join("\n\n"), omitted: 0 };
  const first = cut(blocks[0] ?? "", Math.floor(budgetChars * FIRST_SHARE));
  const kept: string[] = [];
  let used = first.length + 2;
  for (let i = blocks.length - 1; i >= 1; i--) {
    const b = blocks[i] ?? "";
    if (used + b.length + 2 > budgetChars) {
      // The newest message alone is too big: its end is what matters.
      if (!kept.length) kept.unshift(cut(b, Math.max(500, budgetChars - used - 2)));
      break;
    }
    kept.unshift(b);
    used += b.length + 2;
  }
  const omitted = blocks.length - 1 - kept.length;
  return {
    text: [
      first,
      ...(omitted > 0 ? [`[${omitted} earlier message${omitted === 1 ? "" : "s"} left out]`] : []),
      ...kept,
    ].join("\n\n"),
    omitted,
  };
}

/** The fork's instructions: the subagent's own, then the conversation it starts from. */
export function forkSystem(base: string, transcript: string): string {
  const note = base.includes(FORK_PROMPT) ? "" : `\n\n${FORK_PROMPT}`;
  return `${base}${note}\n\nThe conversation so far:\n<conversation>\n${transcript}\n</conversation>`;
}

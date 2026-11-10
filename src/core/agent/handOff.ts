// Handing off a task in flight (D329, Claude Code's hand_off_to_session): a new message about
// something else arrives while the agent is mid-task; the task moves to a new chat (a fork of this
// conversation plus the remaining plan) that starts working on it at once, and this chat answers
// the new message. What the call may say, the new chat's first message and the context it starts
// from are here; the tool and its card are in extensions/agent/handOff.ts. DOM-free and tested.

import type { Item } from "./conversation";

export const HANDOFF_TITLE_MAX = 60;
export const HANDOFF_PLAN_MAX = 8000;

export interface HandOff {
  title: string;
  plan: string;
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The call's arguments checked: a short title and the remaining plan. */
export function parseHandOff(args: unknown): { handOff: HandOff } | { error: string } {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const title = text(a.title);
  const plan = text(a.remaining_plan);
  if (!title) return { error: "Give the task a title (a few words)." };
  if (title.length > HANDOFF_TITLE_MAX)
    return {
      error: `The title is ${title.length} characters: keep it under ${HANDOFF_TITLE_MAX}.`,
    };
  if (!plan)
    return {
      error:
        "Give remaining_plan: what is left (the steps, the files, what done looks like). The new chat starts from it.",
    };
  if (plan.length > HANDOFF_PLAN_MAX)
    return {
      error: `remaining_plan is ${plan.length} characters: keep it under ${HANDOFF_PLAN_MAX} (the conversation goes with it anyway).`,
    };
  return { handOff: { title, plan } };
}

/** Opens the hidden context the new chat starts from (its chip shows the first line). */
export const HANDOFF_CONTEXT_PREFIX = "Handed off from chat";

/** The new chat's first message: the remaining plan, said as the task to carry on. */
export function handOffMessage(h: HandOff): string {
  return `Carry on with this task, handed off from another chat (the conversation so far is attached): ${h.title}\n\n${h.plan}`;
}

/** The context that goes with it: the conversation it continues, as a transcript. */
export function handOffContext(from: { id: string; title: string }, transcript: string): string {
  return `${HANDOFF_CONTEXT_PREFIX} "${from.title}" (${from.id}): the conversation so far, where the task was started. You continue that task here; the other chat moved on to something else. Files it changed are already on disk. Don't redo what it did.\n<conversation>\n${transcript}\n</conversation>`;
}

/** What the call returns: the work moved, so stop it here and answer the new message. */
export function handOffResult(chat: { id: string; title: string }): string {
  return `Handed off: chat "${chat.title}" (${chat.id}) is working on it now, with this conversation and your plan. Stop that task here: don't continue it or recap it. Answer the user's new message now.`;
}

/** The items the transcript is built from: everything before the hand-off call itself. */
export function beforeCall(items: readonly Item[], itemId: string): readonly Item[] {
  const at = items.findIndex((it) => it.id === itemId);
  return at >= 0 ? items.slice(0, at) : items;
}

/** A hand-off call's new chat (kept in the call's `detail`), or null while it runs / failed. */
export function handOffChat(item: Item): string | null {
  if (item.type !== "tool" || item.name !== "hand_off_task" || item.status !== "done") return null;
  return item.detail && /^[\w-]+$/.test(item.detail) ? item.detail : null;
}

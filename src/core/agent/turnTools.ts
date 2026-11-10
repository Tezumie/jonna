// The tools that shape a turn rather than change files (D301–D305), after Claude Code's app:
// wrap_up (the "next step" box at a turn's end: a recap, one question, buttons), mark_chapter
// (dividers and a table of contents), propose_task (a separate task offered as a card),
// enter_plan_mode (asks to switch to Plan) and notify (a message when the user is away).
// What their arguments may be, and what the conversation's calls left. DOM-free and tested.

import type { Item } from "./conversation";

/** Drawn on their own in the conversation (a divider, a card), not as a row of the work. */
export const TURN_CARD_TOOLS = new Set([
  "mark_chapter",
  "propose_task",
  "enter_plan_mode",
  // D329: a task handed off to a new chat.
  "hand_off_task",
]);

/** Not drawn where they were called: the box at the turn's end shows wrap_up, a card dismiss. */
export const TURN_HIDDEN_TOOLS = new Set(["wrap_up", "dismiss_task"]);

/** The main agent's own: subagents and background runs don't get them. */
export const TURN_TOOL_NAMES = new Set([
  "wrap_up",
  "mark_chapter",
  "propose_task",
  "dismiss_task",
  "enter_plan_mode",
  "notify",
  // D329, D332: handing a task to a new chat, a loop's next wake-up.
  "hand_off_task",
  "schedule_wakeup",
]);

// --- wrap_up --------------------------------------------------------------------------------

/** The app actions a wrap-up button may run (each the IDE's own command). */
export const WRAP_UP_ACTIONS = [
  "review",
  "keep_all",
  "commit",
  "create_pr",
  "new_chat",
  "archive",
] as const;
export type WrapUpAction = (typeof WRAP_UP_ACTIONS)[number];

export type WrapUpButton = { label: string; action?: WrapUpAction };

export interface WrapUp {
  recap: string;
  ask?: string;
  actions?: WrapUpButton[];
  blocked?: boolean;
}

export const RECAP_MAX = 300;
export const ASK_MAX = 100;
export const LABEL_MAX = 24;
const LABEL_WORDS = 4;

const text = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

/**
 * A wrap_up call's arguments as the box shows them, or what to fix (said the way Claude Code's
 * app says it: "this one ran 303"). `available`: the app actions that make sense now; a button
 * for another is refused, naming those that do. `labels`: each app action's button text.
 */
export function parseWrapUp(
  args: unknown,
  available: readonly WrapUpAction[],
  labels: Readonly<Record<WrapUpAction, string>>,
): { wrapUp: WrapUp } | { error: string } {
  const a = record(args);
  const recap = text(a.recap);
  if (!recap) return { error: "Give a recap: two or three short sentences on where things stand." };
  if (recap.length > RECAP_MAX)
    return {
      error: `The recap is at most ${RECAP_MAX} characters; this one ran ${recap.length}. Shorten it.`,
    };
  const ask = text(a.ask);
  if (ask.length > ASK_MAX)
    return {
      error: `The ask is at most ${ASK_MAX} characters; this one ran ${ask.length}. Ask just the one decision.`,
    };
  const raw = Array.isArray(a.actions) ? a.actions : [];
  if (raw.length > 2)
    return {
      error: `Give at most 2 actions (your recommendation first); this one has ${raw.length}.`,
    };
  if (raw.length && !ask)
    return {
      error: "Actions answer the ask: add the one question they answer, or leave both out.",
    };
  if (ask && !raw.length)
    return {
      error: "Give 1 or 2 actions that answer the ask (a reply's label, or an app action).",
    };
  const actions: WrapUpButton[] = [];
  for (const entry of raw) {
    const b = typeof entry === "string" ? { label: entry } : record(entry);
    const action = text(b.action);
    if (action) {
      if (!(WRAP_UP_ACTIONS as readonly string[]).includes(action))
        return {
          error: `There's no app action "${action}". ${availableText(available)}`,
        };
      if (!available.includes(action as WrapUpAction))
        return { error: `"${action}" isn't available now. ${availableText(available)}` };
      actions.push({ label: labels[action as WrapUpAction], action: action as WrapUpAction });
      continue;
    }
    const label = text(b.label);
    if (!label)
      return { error: "Each action needs a label (a reply) or an action (an app action)." };
    if (label.length > LABEL_MAX)
      return {
        error: `A reply's label is at most ${LABEL_MAX} characters; "${label}" ran ${label.length}.`,
      };
    if (label.split(" ").length > LABEL_WORDS)
      return { error: `A reply's label is 1–3 words, a button: "${label}" is a sentence.` };
    if (/^[/!]/.test(label)) return { error: `A reply's label can't start with / or !.` };
    actions.push({ label });
  }
  if (new Set(actions.map((b) => b.label.toLowerCase())).size < actions.length)
    return { error: "The two actions have the same label." };
  return {
    wrapUp: {
      recap,
      ...(ask && { ask }),
      ...(actions.length && { actions }),
      ...((a.blocked === true || a.blocked === "true") && ask && { blocked: true }),
    },
  };
}

function availableText(available: readonly WrapUpAction[]): string {
  return available.length
    ? `Available now: ${available.join(", ")}; or a reply (label only).`
    : "None is available now: use a reply (label only).";
}

/** The recap's first sentence: the chat's status line in the lists. */
export function statusLine(recap: string): string {
  const one = recap.replace(/\s+/g, " ").trim();
  const m = /^.+?[.!?](?=\s|$)/.exec(one);
  const first = (m ? m[0] : one).trim();
  return first.length > 140 ? `${first.slice(0, 139).trimEnd()}…` : first;
}

/** Items after the user's latest message (one they typed): the latest turn. */
export function latestTurn(items: readonly Item[]): readonly Item[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.type === "user" && !it.auto) return items.slice(i + 1);
  }
  return items;
}

/**
 * The latest turn's wrap-up (its last wrap_up call that went through), with that call's item
 * id; null when the turn has none. An older turn's box is gone once the user writes again.
 */
export function latestWrapUp(items: readonly Item[]): { itemId: string; wrapUp: WrapUp } | null {
  const turn = latestTurn(items);
  for (let i = turn.length - 1; i >= 0; i--) {
    const it = turn[i];
    if (it?.type !== "tool" || it.name !== "wrap_up" || it.status !== "done") continue;
    const w = savedWrapUp(it.args);
    if (w) return { itemId: it.id, wrapUp: w };
  }
  return null;
}

/**
 * A saved call's wrap-up, as it was checked when it ran: its app actions aren't checked again
 * (what was available then), only their shape.
 */
function savedWrapUp(args: unknown): WrapUp | null {
  const a = record(args);
  const recap = text(a.recap);
  if (!recap) return null;
  const ask = text(a.ask);
  const actions = (Array.isArray(a.actions) ? a.actions : []).flatMap((entry): WrapUpButton[] => {
    const b = typeof entry === "string" ? { label: entry } : record(entry);
    const action = text(b.action);
    if (action)
      return (WRAP_UP_ACTIONS as readonly string[]).includes(action)
        ? [{ label: "", action: action as WrapUpAction }]
        : [];
    const label = text(b.label);
    return label ? [{ label }] : [];
  });
  return {
    recap,
    ...(ask && { ask }),
    ...(ask && actions.length && { actions: actions.slice(0, 2) }),
    ...(a.blocked === true && ask && { blocked: true }),
  };
}

// --- mark_chapter ---------------------------------------------------------------------------

export const CHAPTER_TITLE_MAX = 40;
export const CHAPTER_SUMMARY_MAX = 160;

export interface Chapter {
  /** The mark_chapter call's item id: where the divider is. */
  id: string;
  title: string;
  summary?: string;
}

/**
 * A mark_chapter call's chapter, or what to fix. `items`: the conversation up to the call
 * (the call itself last, or not there yet).
 */
export function parseChapter(
  args: unknown,
  items: readonly Item[],
): { chapter: Omit<Chapter, "id"> } | { error: string } {
  const a = record(args);
  const title = text(a.title);
  if (!title) return { error: "Give the chapter a title: a short noun phrase." };
  if (title.length > CHAPTER_TITLE_MAX)
    return {
      error: `A chapter's title is under ${CHAPTER_TITLE_MAX} characters; this one ran ${title.length}.`,
    };
  const summary = text(a.summary).slice(0, CHAPTER_SUMMARY_MAX);
  const typed = items.filter((it) => it.type === "user" && !it.auto).length;
  const turn = latestTurn(items);
  if (typed <= 1 && leadsTurn(turn, turn.length))
    return {
      error:
        "Not for the session's very start: a chapter marks a shift after some work. Carry on without one.",
    };
  const last = chaptersOf(items).at(-1);
  if (last && last.title.toLowerCase() === title.toLowerCase())
    return { error: `The current chapter is already "${last.title}".` };
  return { chapter: { title, ...(summary && { summary }) } };
}

/** The conversation's chapters, in order. */
export function chaptersOf(items: readonly Item[]): Chapter[] {
  const out: Chapter[] = [];
  for (const it of items) {
    if (it.type !== "tool" || it.name !== "mark_chapter" || it.status !== "done") continue;
    const a = record(it.args);
    const title = text(a.title).slice(0, CHAPTER_TITLE_MAX);
    if (!title) continue;
    const summary = text(a.summary).slice(0, CHAPTER_SUMMARY_MAX);
    out.push({ id: it.id, title, ...(summary && { summary }) });
  }
  return out;
}

/**
 * Whether a call in a turn comes before anything the user would see of it (only calls of the
 * turn's first step, no text): a chapter marked there opens the turn, so its divider goes above
 * the user's message rather than under it.
 */
export function leadsTurn(turn: readonly Item[], index: number): boolean {
  let steps = 0;
  for (const it of turn.slice(0, index)) {
    if (it.type === "assistant") {
      if (it.text.trim() || ++steps > 1) return false;
    } else if (it.type !== "tool") return false;
  }
  return true;
}

// --- propose_task ---------------------------------------------------------------------------

export const TASK_TITLE_MAX = 60;
export const TASK_BRIEF_MAX = 4000;
export const TASKS_PER_TURN = 3;

/** What became of a proposed task (kept as its call's summary, so it's saved with the chat). */
export const TASK_STARTED = "Started in a new chat";
export const TASK_DISMISSED = "Dismissed";

export interface ProposedTask {
  title: string;
  brief: string;
}

/** A propose_task call's task, or what to fix. `turn`: the latest turn's items before it. */
export function parseProposal(
  args: unknown,
  turn: readonly Item[],
): { task: ProposedTask } | { error: string } {
  const a = record(args);
  const title = text(a.title);
  const brief = typeof a.brief === "string" ? a.brief.trim() : "";
  if (!title || !brief)
    return {
      error:
        "Give a title (a few words) and a brief: the new chat's first message, complete on its own.",
    };
  if (title.length > TASK_TITLE_MAX)
    return {
      error: `A task's title is at most ${TASK_TITLE_MAX} characters; this one ran ${title.length}.`,
    };
  if (brief.length > TASK_BRIEF_MAX)
    return {
      error: `A brief is at most ${TASK_BRIEF_MAX} characters; this one ran ${brief.length}.`,
    };
  const earlier = turn.filter(
    (it) => it.type === "tool" && it.name === "propose_task" && it.status === "done",
  ).length;
  if (earlier >= TASKS_PER_TURN)
    return { error: `At most ${TASKS_PER_TURN} proposed tasks a turn: keep the best ones.` };
  return { task: { title, brief } };
}

/** A propose_task call's task as saved (null: not one). */
export function proposalOf(item: Item): ProposedTask | null {
  if (item.type !== "tool" || item.name !== "propose_task" || item.status !== "done") return null;
  const a = record(item.args);
  const title = text(a.title).slice(0, TASK_TITLE_MAX);
  const brief = typeof a.brief === "string" ? a.brief.trim() : "";
  return title && brief ? { title, brief } : null;
}

/** The conversation's proposed tasks with what became of them (open, started, dismissed). */
export function proposalsOf(
  items: readonly Item[],
): { id: string; title: string; state: "open" | "started" | "dismissed"; chat?: string }[] {
  return items.flatMap((it) => {
    const p = proposalOf(it);
    if (!p || it.type !== "tool") return [];
    const state =
      it.summary === TASK_STARTED
        ? "started"
        : it.summary === TASK_DISMISSED
          ? "dismissed"
          : "open";
    return [{ id: it.id, title: p.title, state, ...(it.detail && { chat: it.detail }) }];
  });
}

// --- notify ---------------------------------------------------------------------------------

export const NOTIFY_MAX = 200;

/** A notify call's message, or what to fix. */
export function parseNotify(args: unknown): { message: string } | { error: string } {
  const raw = record(args).message;
  const message = typeof raw === "string" ? raw.trim() : "";
  if (!message) return { error: "Give the message: one line on what's worth coming back for." };
  if (/\n/.test(message)) return { error: "Keep the message on one line." };
  if (message.length > NOTIFY_MAX)
    return {
      error: `The message is under ${NOTIFY_MAX} characters; this one ran ${message.length}.`,
    };
  return { message };
}

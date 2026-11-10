// How the turn tools show in the chat (D301–D304): a chapter's divider, a proposed task's card,
// the Plan mode consent card, the wrap-up box at the end of the latest turn, and the chapters
// menu in the chat's header. Plain DOM with tokens; every button runs a command.

import type { Item } from "../../../core/agent/conversation";
import {
  chaptersOf,
  proposalOf,
  TASK_DISMISSED,
  TASK_STARTED,
  type WrapUp,
} from "../../../core/agent/turnTools";
import { h, on } from "../../../core/dom/index";
import { type Disposable, DisposableStore } from "../../../core/lifecycle/index";
import { icon } from "../../../ui/Icon";
import { showMenu } from "../../../ui/Menu";
import { setTooltip } from "../../../ui/Tooltip";
import type { AgentSession } from "../session";
import { PLAN_NO, PLAN_YES, WRAP_UP_LABELS } from "../turnTools";
import { handOffCard } from "./chatFlowCards";

type ToolItem = Extract<Item, { type: "tool" }>;

export interface TurnCardHost {
  session: AgentSession;
  run(command: string, input?: unknown): void;
}

const button = (label: string, cls: string, run: () => void, disabled = false) => {
  const b = h(
    "button",
    { class: `button ${cls} button-sm`, type: "button", ...(disabled && { disabled: "" }) },
    label,
  );
  on(b, "click", run);
  return b;
};

/** A turn tool's call as it shows in the conversation, or null (drawn as a row instead). */
export function turnCard(item: ToolItem, host: TurnCardHost): HTMLElement | null {
  switch (item.name) {
    case "mark_chapter":
      return chapterDivider(item);
    case "propose_task":
      return taskCard(item, host);
    case "enter_plan_mode":
      return planModeCard(item, host);
    case "hand_off_task":
      return handOffCard(item, host);
    default:
      return null;
  }
}

/** A chapter's divider (D302): its title between two rules; its summary on hover. */
function chapterDivider(item: ToolItem): HTMLElement | null {
  const a = (item.args ?? {}) as { title?: unknown; summary?: unknown };
  const title = typeof a.title === "string" ? a.title.trim() : "";
  if (!title) return null;
  const el = h(
    "div",
    { class: "agent-chapter", role: "separator", "aria-label": `Chapter: ${title}` },
    h("span", { class: "agent-chapter-title" }, title),
  );
  if (typeof a.summary === "string" && a.summary.trim()) setTooltip(el, a.summary.trim());
  return el;
}

/**
 * A task the agent proposed (D303): "New task", its title and brief, Start in a new chat or
 * Dismiss. Started, it says so and opens that chat; dismissed (by the user or the agent), it's gone.
 */
function taskCard(item: ToolItem, host: TurnCardHost): HTMLElement | null {
  // While the call runs (or if it failed) there's no task yet: the row shows.
  const task =
    item.status === "done" ? proposalOf(item) : item.status === "error" ? null : undefined;
  if (task === null) return null;
  const session = host.session.id;
  const a = (item.args ?? {}) as { title?: unknown; brief?: unknown };
  const title = task?.title ?? (typeof a.title === "string" ? a.title : "");
  const brief = task?.brief ?? (typeof a.brief === "string" ? a.brief : "");
  if (item.summary === TASK_DISMISSED)
    return h("div", { class: "agent-task is-dismissed", hidden: true });
  const started = item.summary === TASK_STARTED;
  const firstLine = brief.split("\n").find((l) => l.trim()) ?? "";
  const briefEl = h("div", { class: "agent-task-brief" }, firstLine);
  setTooltip(briefEl, brief.length > 600 ? `${brief.slice(0, 600)}…` : brief);
  return h(
    "div",
    {
      class: "agent-task",
      role: "group",
      "aria-label": `New task: ${title}`,
      // Its buttons' handlers belong to one state: a new state draws it anew (morph).
      "data-key": `task-${item.id}-${item.summary ?? ""}-${task ? 1 : 0}`,
    },
    h("div", { class: "agent-task-head" }, icon("message-square-plus"), "New task"),
    h("div", { class: "agent-task-title" }, title),
    briefEl,
    h(
      "div",
      { class: "agent-turn-actions" },
      started
        ? [
            h("span", { class: "agent-task-state" }, icon("check"), TASK_STARTED),
            item.detail
              ? button("Open chat", "button-ghost", () =>
                  host.run("agent.openThread", { session: item.detail }),
                )
              : null,
          ]
        : [
            button(
              "Start in a new chat",
              "button-secondary",
              () => host.run("agent.startTask", { session, item: item.id }),
              !task,
            ),
            button(
              "Dismiss",
              "button-ghost",
              () => host.run("agent.dismissTask", { session, item: item.id }),
              !task,
            ),
          ],
    ),
  );
}

/**
 * The agent asks to switch to Plan mode first (D304): Switch to Plan / Keep going while it waits;
 * answered, what was chosen.
 */
function planModeCard(item: ToolItem, host: TurnCardHost): HTMLElement | null {
  if (item.status === "error") return null;
  const waiting = host.session.questions.peek().some((q) => q.itemId === item.id);
  const reason = (item.args as { reason?: unknown } | null)?.reason;
  const answer = (text: string) =>
    host.run("agent.answer", { session: host.session.id, item: item.id, text });
  const outcome =
    item.summary === PLAN_YES
      ? "Switched to Plan mode"
      : item.summary === PLAN_NO
        ? "Kept going in Agent mode"
        : item.summary === "not asked"
          ? "Not asked (full access)"
          : item.status === "done"
            ? "Answered"
            : null;
  return h(
    "div",
    {
      class: { "agent-consent": true, "is-answered": !waiting },
      role: "group",
      "data-key": `plan-${item.id}-${waiting ? 1 : 0}-${item.summary ?? ""}`,
    },
    h("div", { class: "agent-task-head" }, icon("list-tree"), "Plan first?"),
    h(
      "div",
      { class: "agent-task-title" },
      "The agent would like to switch this chat to Plan mode: it looks around without changing anything, then writes a plan you approve with Build.",
    ),
    typeof reason === "string" && reason.trim()
      ? h("div", { class: "agent-task-brief" }, reason.trim())
      : null,
    h(
      "div",
      { class: "agent-turn-actions" },
      waiting
        ? [
            button(PLAN_YES, "button-primary", () => answer(PLAN_YES)),
            button(PLAN_NO, "button-secondary", () => answer(PLAN_NO)),
          ]
        : outcome
          ? h("span", { class: "agent-task-state" }, icon("check"), outcome)
          : null,
    ),
  );
}

/**
 * The latest turn's wrap-up box (D301), under its answer and the plan: the recap, the one
 * question and its buttons. A reply's button sends its label as the user's message; an app
 * action's runs it. The buttons work once the turn has ended. A recap alone draws no box.
 */
export function wrapUpBox(wrapUp: WrapUp, host: TurnCardHost, live: boolean): HTMLElement | null {
  if (!wrapUp.ask || !wrapUp.actions?.length) return null;
  const session = host.session.id;
  return h(
    "div",
    { class: "agent-wrapup", role: "group", "aria-label": "Next step" },
    h("div", { class: "agent-wrapup-recap" }, wrapUp.recap),
    h("div", { class: "agent-wrapup-ask" }, wrapUp.ask),
    h(
      "div",
      { class: "agent-turn-actions" },
      ...wrapUp.actions.map((b, i) => {
        const cls = i === 0 ? "button-primary" : "button-secondary";
        const action = b.action;
        return action
          ? button(
              WRAP_UP_LABELS[action],
              cls,
              () => host.run("agent.runWrapUpAction", { session, action }),
              !live,
            )
          : button(
              b.label,
              cls,
              () => host.run("agent.send", { session, message: b.label, wait: false }),
              !live,
            );
      }),
    ),
  );
}

/**
 * The chat's table of contents (D302): a header button, shown once the agent marked a chapter,
 * whose menu lists them; picking one scrolls there (agent.showChapter).
 */
export class ChapterMenu implements Disposable {
  readonly button: HTMLElement;
  private shown = "";
  private readonly store = new DisposableStore();

  constructor(
    private readonly session: AgentSession,
    private readonly run: (command: string, input?: unknown) => void,
  ) {
    this.button = h(
      "button",
      {
        class: "icon-button agent-chapters",
        type: "button",
        "aria-label": "Chapters",
        "aria-haspopup": "menu",
        hidden: true,
      },
      icon("bookmark"),
    );
    setTooltip(this.button, "Chapters");
    this.store.add(on(this.button, "click", () => this.open()));
  }

  /** Shown when there are chapters (cheap: called on each redraw). */
  update(items: readonly Item[]): void {
    const key = chaptersOf(items)
      .map((c) => c.id)
      .join(",");
    if (key === this.shown) return;
    this.shown = key;
    this.button.hidden = !key;
  }

  private open(): void {
    const chapters = chaptersOf(this.session.items);
    if (!chapters.length) return;
    showMenu(
      this.button,
      chapters.map((c, i) => ({
        label: `${i + 1}. ${c.title}`,
        ...(c.summary && { tooltip: c.summary }),
        run: () => this.run("agent.showChapter", { session: this.session.id, chapter: c.id }),
      })),
      "Chapters",
    );
  }

  dispose(): void {
    this.store.dispose();
    this.button.remove();
  }
}

// How package D329–D332 shows in the chat: a handed-off task's card (it links to the new chat),
// Plan mode's plan document card (in place of the "Plan ready" notice: the plan as it is in its
// file, folded or open, with Build, Open to edit and Keep planning), a loop's check as a quiet
// line, and the loop's strip above the message box (its pace, the next check, Stop). Plain DOM
// with tokens; every button runs a command. Styles: styles/agent-chatflow.css.

import { loopPace, readTick, tickPromptText } from "../../../core/agent/chatLoop";
import type { Item } from "../../../core/agent/conversation";
import { handOffChat } from "../../../core/agent/handOff";
import { latestPlanNotice, planSteps, planTitle } from "../../../core/agent/planDoc";
import { describeNext } from "../../../core/agent/schedules";
import { h, on, replaceChildren } from "../../../core/dom/index";
import { type Disposable, DisposableStore } from "../../../core/lifecycle/index";
import { effect } from "../../../core/reactive/index";
import { icon } from "../../../ui/Icon";
import { renderMarkdown } from "../../../ui/markdown/render";
import { setTooltip } from "../../../ui/Tooltip";
import { chatLoops, loopOf } from "../chatLoops";
import { planDocOf } from "../planDocs";
import type { AgentSession } from "../session";

type ToolItem = Extract<Item, { type: "tool" }>;
type NoticeItem = Extract<Item, { type: "notice" }>;
type UserItem = Extract<Item, { type: "user" }>;

interface CardHost {
  session: AgentSession;
  run(command: string, input?: unknown): void;
}

const button = (label: string, cls: string, run: () => void) => {
  const b = h("button", { class: `button ${cls} button-sm`, type: "button" }, label);
  on(b, "click", run);
  return b;
};

/**
 * A task handed off to a new chat (D329): "Moved to a new chat", its title and plan, Open chat.
 * While the call runs (or if it failed) it's a row instead.
 */
export function handOffCard(item: ToolItem, host: CardHost): HTMLElement | null {
  const chat = handOffChat(item);
  if (!chat) return null;
  const a = (item.args ?? {}) as { title?: unknown; remaining_plan?: unknown };
  const title = typeof a.title === "string" ? a.title : "";
  const plan = typeof a.remaining_plan === "string" ? a.remaining_plan : "";
  const firstLine = plan.split("\n").find((l) => l.trim()) ?? "";
  const brief = h("div", { class: "agent-task-brief" }, firstLine);
  setTooltip(brief, plan.length > 600 ? `${plan.slice(0, 600)}…` : plan);
  return h(
    "div",
    {
      class: "agent-task agent-handoff",
      role: "group",
      "aria-label": `Handed off: ${title}`,
      "data-key": `handoff-${item.id}`,
    },
    h("div", { class: "agent-task-head" }, icon("git-fork"), "Moved to a new chat"),
    h("div", { class: "agent-task-title" }, title),
    brief,
    h(
      "div",
      { class: "agent-turn-actions" },
      button("Open chat", "button-secondary", () =>
        host.run("agent.openThread", { session: chat }),
      ),
    ),
  );
}

/** What changes the plan card (its signature): the file's version, folded or open, latest. */
export function planCardKey(item: NoticeItem, session: AgentSession, open: boolean): string {
  if (!item.actions?.includes("build")) return "";
  if (latestPlanNotice(session.items) !== session.items.indexOf(item)) return "old";
  const doc = planDocOf(session);
  return doc ? `${doc.version}|${doc.edited}|${open}` : "none";
}

/**
 * The latest plan's card (D330), in place of its "Plan ready" notice: the plan's title and steps,
 * the file's text when opened (as the user edited it), and Build / Open to edit / Keep planning
 * while nothing was sent after it. Null: the plain notice (an older plan, no file).
 */
export function planCard(
  item: NoticeItem,
  host: CardHost & {
    open: boolean;
    toggle(): void;
    live: boolean;
    openLink(href: string): void;
    copy(text: string): void;
  },
): HTMLElement | null {
  const session = host.session;
  const at = session.items.indexOf(item);
  if (at < 0 || latestPlanNotice(session.items) !== at) return null;
  const doc = planDocOf(session);
  if (!doc?.text) return null;
  const text = doc.text;
  const steps = planSteps(text);
  const head = h(
    "button",
    { class: "agent-plandoc-head", type: "button", "aria-expanded": String(host.open) },
    icon("list-tree"),
    h("span", { class: "agent-plandoc-title" }, planTitle(text)),
    h(
      "span",
      { class: "agent-plandoc-meta" },
      [steps ? `${steps} step${steps === 1 ? "" : "s"}` : "", doc.edited ? "edited" : ""]
        .filter(Boolean)
        .join(" · "),
    ),
    icon(host.open ? "chevron-down" : "chevron-right"),
  );
  setTooltip(head, host.open ? "Fold the plan" : "Show the plan as it is in its file");
  on(head, "click", () => host.toggle());
  let body: HTMLElement | null = null;
  if (host.open) {
    body = h("div", { class: "agent-plandoc-body md agent-prose" });
    try {
      renderMarkdown(body, text, { openLink: host.openLink, copy: host.copy });
    } catch {
      body.replaceChildren(h("pre", null, text));
    }
  }
  const id = session.id;
  return h(
    "div",
    {
      class: "agent-plandoc",
      role: "group",
      "aria-label": "Plan",
      "data-key": `plandoc-${item.id}-${doc.version}-${host.open ? 1 : 0}-${host.live ? 1 : 0}`,
    },
    head,
    body,
    h(
      "div",
      { class: "agent-turn-actions" },
      host.live
        ? [
            button("Build", "button-primary", () => host.run("agent.build", { session: id })),
            button("Open to edit", "button-secondary", () =>
              host.run("agent.openPlan", { session: id }),
            ),
            button("Keep planning", "button-ghost", () =>
              host.run("agent.keepPlanning", { session: id }),
            ),
          ]
        : [
            button("Open to edit", "button-ghost", () =>
              host.run("agent.openPlan", { session: id }),
            ),
          ],
    ),
  );
}

/** A loop's check (D332): a quiet line, "Loop check 3: <what>"; the whole message on hover. */
export function loopTickRow(item: UserItem): HTMLElement | null {
  if (item.auto !== "schedule") return null;
  const n = readTick(item.text);
  if (n === null) return null;
  const what = tickPromptText(item.text).split("\n")[0] ?? "";
  const row = h(
    "div",
    { class: "agent-msg agent-auto is-loop", "data-key": item.id },
    icon("refresh-cw"),
    h("span", null, `Loop check ${n}: ${what}`),
  );
  setTooltip(row, item.text.slice(0, 1200));
  return row;
}

/** How often the strip's "in N min" is redrawn. */
const STRIP_TICK_MS = 30_000;

/**
 * A chat's loop above the message box (D332): what it checks, its pace, the next check (or that
 * the agent is choosing it), the counts, and Stop.
 */
export class LoopStrip implements Disposable {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly rows = this.store.add(new DisposableStore());
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly session: string,
    private readonly run: (command: string, input?: unknown) => void,
  ) {
    this.element = h("div", { class: "agent-processes agent-loop", hidden: true });
    this.store.add(
      effect(() => {
        chatLoops.value;
        this.render();
        return undefined;
      }),
    );
    this.store.add({ dispose: () => clearInterval(this.timer) });
  }

  private render(): void {
    const loop = loopOf(this.session);
    this.rows.clear();
    clearInterval(this.timer);
    this.element.hidden = !loop;
    if (!loop) {
      replaceChildren(this.element);
      return;
    }
    this.timer = setInterval(() => this.render(), STRIP_TICK_MS);
    const next = loop.next
      ? `next check ${describeNext(loop.next, Date.now())}`
      : loop.every
        ? "checking"
        : "the agent is choosing the next check";
    const counts = `${loop.ticks} check${loop.ticks === 1 ? "" : "s"}${loop.quiet ? `, ${loop.quiet} quiet` : ""}`;
    const title = h(
      "span",
      { class: "agent-processes-title" },
      `Loop · ${loopPace(loop)} · ${next} · ${counts}`,
    );
    setTooltip(
      title,
      `${loop.prompt}${loop.reason ? `\n\n${loop.reason}` : ""}\n\nEnds ${new Date(loop.expires).toLocaleString()}`,
    );
    const stop = h(
      "button",
      { class: "button button-ghost button-sm agent-loop-stop", type: "button" },
      "Stop",
    );
    this.rows.add(on(stop, "click", () => this.run("agent.stopLoop", { session: this.session })));
    replaceChildren(
      this.element,
      h("div", { class: "agent-processes-head agent-loop-head" }, icon("refresh-cw"), title, stop),
    );
  }

  dispose(): void {
    this.store.dispose();
    this.element.remove();
  }
}

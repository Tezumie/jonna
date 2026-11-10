// The Inbox (D237, D238): every conversation in this folder (channels, direct messages, threads)
// by what it needs: Needs you, Working, Failed, Done. As a list, or as a board with a column each
// (Linear's board; the cards move as the agents work, not by dragging). A card opens its
// conversation; unread ones are marked. The choice of list or board is kept for the window.

import {
  boardColumns,
  inboxGroups,
  relativeAge,
  STATUS_LABEL,
  type ThreadRow,
  type ThreadStatus,
  threadRoom,
  threadStatus,
} from "../../core/agent/rooms";
import type { Json } from "../../core/dock/index";
import { h } from "../../core/dom/index";
import { Emitter } from "../../core/events/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { agentFace, type FaceState, faceGroup } from "../../ui/AgentFace";
import { keepFocus } from "../../ui/focusKeep";
import { icon } from "../../ui/Icon";
import { showContextMenu } from "../../ui/Menu";
import { keepTimesCurrent, timeAttrs } from "../../ui/relativeTimes";
import { setTooltip } from "../../ui/Tooltip";
import type { DockView, DockViewContext } from "../../workbench/dock/views";
import { customModes } from "./customModes";
import { memberInfo } from "./groupChat";
import { mainAgent } from "./mainAgent";
import { INBOX, rooms, roomTitle } from "./roomService";
import { threads } from "./threadList";

export interface InboxViewHost {
  run(command: string, input?: unknown): void;
  execute(command: string, input?: unknown): Promise<unknown>;
}

const STATE_FACE: Record<ThreadStatus, FaceState> = {
  "needs-you": "waiting",
  working: "working",
  failed: "failed",
  done: "idle",
};

const COLUMN_LABEL: Record<ThreadStatus, string> = {
  "needs-you": "Needs you",
  working: "Working",
  failed: "Failed",
  done: "Done",
};

export class InboxView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly body = h("div", { class: "inbox-body", tabindex: "-1" });
  private readonly toggle: HTMLElement;
  /** List or board, for the window. */
  private static board = false;

  constructor(
    ctx: DockViewContext,
    private readonly host: InboxViewHost,
  ) {
    void ctx;
    this.toggle = h("div", { class: "inbox-toggle", role: "group", "aria-label": "Show as" });
    const header = h(
      "div",
      { class: "room-header" },
      h("span", { class: "room-header-icon" }, icon("bell")),
      h("h2", { class: "room-title" }, "Inbox"),
      h("span", { class: "room-purpose" }, "What needs you, what's working"),
      h("span", { class: "room-spacer" }),
      this.toggle,
    );
    this.element = h("div", { class: "room inbox", "data-room": INBOX }, header, this.body);
    this.store.add(this.changed);
    // Each card's "5 min ago" stays current between redraws.
    this.store.add(keepTimesCurrent(this.body, relativeAge));
    this.store.add(
      effect(() => {
        threads.value;
        rooms.value;
        mainAgent.value;
        customModes.value;
        this.render();
        return undefined;
      }),
    );
  }

  title(): string {
    return "Inbox";
  }

  serialize(): Json {
    return { room: INBOX };
  }

  focus(): void {
    this.body.focus();
  }

  private renderToggle(): void {
    keepFocus(this.toggle, () => this.drawToggle());
  }

  private drawToggle(): void {
    const button = (board: boolean, glyph: "list" | "kanban", label: string) => {
      const b = h(
        "button",
        {
          class: { "icon-button": true, "is-on": InboxView.board === board },
          type: "button",
          "aria-label": label,
          "aria-pressed": String(InboxView.board === board),
          "data-show": board ? "board" : "list",
        },
        icon(glyph),
      );
      setTooltip(b, label);
      b.addEventListener("click", () => {
        InboxView.board = board;
        this.render();
      });
      return b;
    };
    this.toggle.replaceChildren(button(false, "list", "List"), button(true, "kanban", "Board"));
  }

  private render(): void {
    this.renderToggle();
    // An archived chat is out of the way here too (the Chats view lists it under Archived).
    const rows = threads.peek().filter((r) => !r.archived);
    this.element.classList.toggle("is-board", InboxView.board);
    if (!rows.length) {
      this.redraw(
        h(
          "div",
          { class: "room-empty" },
          icon("bell"),
          h("h3", {}, "Nothing here yet"),
          h("p", {}, "Conversations show here: what needs you, what's working, what's done."),
        ),
      );
      this.changed.fire();
      return;
    }
    if (InboxView.board) {
      this.redraw(
        h(
          "div",
          { class: "inbox-board" },
          ...boardColumns(rows).map((c) =>
            h(
              "section",
              { class: "inbox-column", "data-status": c.status },
              h(
                "div",
                { class: "inbox-column-head" },
                h("span", {}, COLUMN_LABEL[c.status]),
                h("span", { class: "room-section-count" }, String(c.rows.length)),
              ),
              h("div", { class: "inbox-column-cards" }, ...c.rows.map((r) => this.card(r))),
            ),
          ),
        ),
      );
    } else {
      const nodes: HTMLElement[] = [];
      for (const g of inboxGroups(rows)) {
        nodes.push(
          h(
            "div",
            { class: "room-section", "data-status": g.status },
            h("span", {}, g.status === "done" ? "Recent" : STATUS_LABEL[g.status]),
            h("span", { class: "room-section-count" }, String(g.rows.length)),
          ),
        );
        for (const r of g.rows) nodes.push(this.card(r));
      }
      this.redraw(h("div", { class: "inbox-list" }, ...nodes));
    }
    this.changed.fire();
  }

  /** The body's new content, the focused card or toggle keeping focus (D244). */
  private redraw(...nodes: Node[]): void {
    keepFocus(this.element, () => this.body.replaceChildren(...nodes));
  }

  /** A conversation: where it is, its title, its agents, the newest reply. */
  private card(row: ThreadRow): HTMLElement {
    const status = threadStatus(row);
    const agents = row.members?.length ? [...row.members] : [row.speaker];
    const where = roomTitle(threadRoom(row, rooms.peek()));
    const card = h(
      "div",
      {
        class: { "inbox-card": true, "is-unread": !!row.unread },
        role: "button",
        tabindex: "0",
        "data-session": row.id,
        "data-status": status,
      },
      h(
        "div",
        { class: "inbox-card-head" },
        faceGroup(
          agents.map((a) => memberInfo(a).face),
          18,
        ),
        h("span", { class: "inbox-card-where" }, row.parent ? `Thread in ${where}` : where),
        h("span", { class: "inbox-card-age", ...timeAttrs(row.updated) }, relativeAge(row.updated)),
      ),
      h("div", { class: "inbox-card-title" }, row.parent ? row.parent.text : row.title),
      // Where it stands (the agent's wrap-up, D301), else its newest reply.
      (row.recap ?? row.last)
        ? h(
            "div",
            { class: "room-last" },
            row.lastBy
              ? h(
                  "span",
                  { class: "room-last-by" },
                  agentFace(memberInfo(row.lastBy).face, { size: 14, state: STATE_FACE[status] }),
                  memberInfo(row.lastBy).label,
                )
              : null,
            h("span", { class: "room-last-text" }, row.recap ?? row.last ?? ""),
          )
        : null,
    );
    const open = (newTab: boolean) =>
      this.host.run("agent.openThread", { session: row.id, ...(newTab && { newTab }) });
    // Plain listeners: the card is rebuilt on each render and goes with them.
    card.addEventListener("click", (e) => open(e.ctrlKey || e.metaKey));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open(e.ctrlKey || e.metaKey);
      }
    });
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: "Open", icon: "message-square", run: () => open(false) },
        {
          label: "Open to the side",
          icon: "columns-2",
          run: () => this.host.run("agent.openThread", { session: row.id, side: true }),
        },
        { label: "Open in new tab", icon: "plus", run: () => open(true) },
        {
          label: "Rename…",
          icon: "pencil",
          separatorBefore: true,
          run: () => this.host.run("agent.renameSession", { session: row.id }),
        },
        {
          label: "Delete",
          icon: "trash-2",
          destructive: true,
          run: () => this.host.run("agent.deleteSession", { session: row.id }),
        },
      ]);
    });
    return card;
  }

  dispose(): void {
    this.store.dispose();
  }
}

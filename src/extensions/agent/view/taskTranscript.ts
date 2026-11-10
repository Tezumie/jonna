// A subagent's transcript in the Background tasks view (D326, Claude Code's subagent view): a
// header with back, its title, its time, Stop, expand and close; the brief it was given in a
// card folded to a few lines ("Show more"); "Model <name>"; then its work as the chat shows a
// turn — work groups that read "Ran 3 commands, read 2 files" and open to their rows, and what it
// said between them — live while it runs. Finished runs open too (Claude Code shows only running
// ones). A helper working in this window shows its own chat the same way.
//
// It reuses the chat's turn layout (turns.ts) and renderers (items.ts, steps.ts) with a quiet
// ItemHost: no message actions, no editing, no retry.

import { type BackgroundTask, taskTime } from "../../../core/agent/backgroundTasks";
import type { Item } from "../../../core/agent/conversation";
import { h } from "../../../core/dom/index";
import { clipboardIpc } from "../../../core/ipc/system";
import type { Disposable } from "../../../core/lifecycle/index";
import { icon } from "../../../ui/Icon";
import { setTooltip } from "../../../ui/Tooltip";
import type { WorkbenchServices } from "../../../workbench/services";
import type { AgentSession } from "../session";
import type { SessionManager } from "../sessions";
import { subagentRuns } from "../subagentRuns";
import { type ItemHost, renderItem, toolLabel } from "./items";
import { renderRow } from "./steps";
import { layoutTurns, workActivity, workRows, workSummary } from "./turns";

/** A brief longer than this folds behind "Show more". */
const BRIEF_FOLD_CHARS = 280;

export class TaskTranscript implements Disposable {
  /** One quiet host per chat whose items are shown (its outputs, its changes). */
  private readonly hosts = new Map<string, ItemHost>();
  private readonly openWork = new Set<string>();
  private briefOpen = false;

  constructor(
    private readonly services: WorkbenchServices,
    private readonly sessions: SessionManager,
    private readonly rerender: () => void,
  ) {}

  /** Called in the view's effect: follows a helper's chat while its transcript is shown. */
  watch(task: string | null): void {
    if (!task || subagentRuns.get(task)) return;
    const chat = this.sessions.find(task);
    if (chat) {
      chat.version.value;
      chat.status.value;
    }
  }

  /** A helper's own conversation when its chat is in this window. */
  helperItems(id: string): readonly Item[] | null {
    return this.sessions.find(id)?.items ?? null;
  }

  /** Where a task's tool calls' live output is kept (its chat's outputs). */
  outputsFor(t: BackgroundTask): ReadonlyMap<string, string> | undefined {
    const run = t.kind === "subagent" ? subagentRuns.get(t.id) : undefined;
    return this.sessions.find(run ? run.session : t.id)?.outputs;
  }

  /** The transcript's own toggles; false: not one of them. */
  onAction(action: string, id: string): boolean {
    if (action === "brief") {
      this.briefOpen = !this.briefOpen;
      return true;
    }
    if (action === "work") {
      if (this.openWork.has(id)) this.openWork.delete(id);
      else this.openWork.add(id);
      return true;
    }
    return false;
  }

  private hostFor(session: AgentSession): ItemHost {
    let host = this.hosts.get(session.id);
    if (host) return host;
    const { dispatcher, workspace, notifications } = this.services;
    const run = (command: string, input?: unknown) =>
      void dispatcher.execute(command, input).catch((err: unknown) => {
        notifications.show("error", err instanceof Error ? err.message : String(err));
      });
    host = {
      session,
      root: () => workspace.root.peek() ?? "",
      relative: (path) => (workspace.root.peek() ? workspace.relative(path) : path),
      run,
      openLink: (href) => {
        if (/^(https?:|mailto:)/i.test(href)) run("agent.openLink", { url: href });
        else if (!href.startsWith("#") && !/^(file:)?(\\\\|\/\/)/i.test(href))
          run("editor.openFile", { path: workspace.resolve(href.replace(/^file:\/\//, "")) });
      },
      copy: (text) => void clipboardIpc.writeText(text).catch(() => {}),
      expanded: new Set(),
      rerender: this.rerender,
      editing: null,
      answers: new Map(),
      idle: () => true,
      lastItemId: () => undefined,
      canRetry: () => false,
      threadsFor: () => [],
    };
    this.hosts.set(session.id, host);
    return host;
  }

  /** The page for task `task` of chat `chat`: its head and body (morphed into the view). */
  render(
    task: BackgroundTask,
    chat: string,
    now: number,
  ): { head: HTMLElement; body: HTMLElement } {
    const run = task.kind === "subagent" ? subagentRuns.get(task.id) : undefined;
    const helperChat = task.kind === "helper" ? this.sessions.find(task.id) : undefined;
    const owner = run ? this.sessions.find(run.session) : helperChat;
    const items: readonly Item[] = run?.items ?? helperChat?.items ?? [];
    const brief = run?.brief ?? (items[0]?.type === "user" ? items[0].text : task.title);
    const model = run ? run.model : (helperChat?.model.peek() ?? null);
    const running = task.status === "running";
    const head = h(
      "div",
      { class: "agent-bgtasks-head is-transcript" },
      iconButton("arrow-left", "Back", "back"),
      h("span", { class: "agent-bgtasks-title" }, task.title),
      h(
        "span",
        { class: "agent-bgtask-time" },
        running ? h("span", { class: "agent-spinner" }) : null,
        taskTime(task, now),
      ),
      h("span", { class: "agent-bgtasks-spacer" }),
      task.canStop ? iconButton("square", "Stop", "stop", task.id) : null,
      iconButton("maximize-2", "Expand", "expand"),
      iconButton("x", "Close", "close"),
    );
    const long = brief.length > BRIEF_FOLD_CHARS || brief.split("\n").length > 4;
    const briefCard = h(
      "div",
      {
        class: { "agent-bgtask-brief": true, "is-folded": long && !this.briefOpen },
        "data-key": "brief",
      },
      h("div", { class: "agent-bgtask-brief-text" }, brief),
      long
        ? h(
            "button",
            {
              class: "link-button agent-bgtask-brief-more",
              type: "button",
              "data-action": "brief",
            },
            this.briefOpen ? "Show less" : "Show more",
          )
        : null,
    );
    const facts = h(
      "div",
      { class: "agent-bgtask-facts" },
      h("span", null, "Model ", h("strong", null, model ?? "the chat's model")),
      task.detail ? h("span", null, task.detail) : null,
    );
    const work = owner ? this.work(items, this.hostFor(owner), running) : [];
    return {
      head,
      body: h(
        "div",
        { class: "agent-bgtasks-body is-transcript", "data-chat": chat },
        h(
          "div",
          { class: "agent-bgtask-transcript" },
          briefCard,
          facts,
          ...work,
          !owner
            ? h(
                "button",
                { class: "link-button", type: "button", "data-action": "chat", "data-id": task.id },
                "Open its chat",
              )
            : null,
          running && !items.some((i) => i.type !== "user")
            ? h("p", { class: "agent-bgtasks-empty" }, "Starting…")
            : null,
        ),
      ),
    };
  }

  /** Its items as the chat lays out a turn: work groups and what it said between them. */
  private work(items: readonly Item[], host: ItemHost, running: boolean): HTMLElement[] {
    // The first item is the brief, shown above.
    const shown = items[0]?.type === "user" ? items.slice(1) : items;
    const segments = layoutTurns(shown);
    const lastWork = segments.reduce((at, seg, i) => (seg.kind === "work" ? i : at), -1);
    const out: HTMLElement[] = [];
    segments.forEach((seg, index) => {
      if (seg.kind === "item") {
        const it = seg.item;
        if (it.type === "user")
          out.push(
            h(
              "div",
              { class: "agent-msg agent-user-wrap", "data-key": it.id },
              h("div", { class: "agent-user" }, h("div", { class: "agent-user-text" }, it.text)),
            ),
          );
        else out.push(renderItem(it, host, { hideThinking: !!seg.hideThinking }));
        return;
      }
      const open = this.openWork.has(seg.id);
      const activity =
        running && index === lastWork
          ? (workActivity(seg.entries, (t) => toolLabel(t, host.relative)) ?? null)
          : null;
      const rows = open ? workRows(seg.entries) : [];
      out.push(
        h(
          "div",
          {
            class: { "agent-work": true, "is-open": open, "is-working": !!activity },
            "data-key": seg.id,
          },
          h(
            "div",
            { class: "agent-work-top" },
            h(
              "button",
              {
                class: "agent-work-header",
                type: "button",
                "aria-expanded": String(open),
                "data-action": "work",
                "data-id": seg.id,
              },
              h(
                "span",
                { class: "agent-work-label" },
                activity ? `${activity}…` : workSummary(seg.entries),
              ),
              h(
                "span",
                { class: "agent-work-chevron" },
                icon(open ? "chevron-down" : "chevron-right"),
              ),
            ),
          ),
          open
            ? h(
                "div",
                { class: "agent-work-body" },
                ...rows.map((r) => renderRow(r, host, rows.length === 1)),
              )
            : null,
        ),
      );
    });
    return out;
  }

  dispose(): void {
    this.hosts.clear();
  }
}

function iconButton(
  name: Parameters<typeof icon>[0],
  label: string,
  action: string,
  id?: string,
): HTMLElement {
  const b = h(
    "button",
    {
      class: "icon-button",
      type: "button",
      "aria-label": label,
      "data-action": action,
      ...(id && { "data-id": id }),
    },
    icon(name),
  );
  setTooltip(b, label);
  return b;
}

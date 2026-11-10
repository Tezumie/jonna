// The Background tasks view (D326, after Claude Code's app): a tab beside the chat listing what
// it has working on its own (backgroundTasks.ts gathers it). Header: title, clear finished,
// expand, close. "Running (N)" and "Finished (N)" (folds; "Show more" past FINISHED_SHOWN).
// A subagent row: its title (opens its transcript), live time, Stop; under it "N tasks" opens its
// own tool calls, each to its command and output. A command row opens to `$ command` and what it
// printed. The transcript page (taskTranscript.ts): back, title, the brief, the model, its work.
//
// Drawn whole on each change and morphed into place (rows keep their scroll and focus); clicks
// are handled once on the root by `data-action`, and every action that does something runs a
// command (agent.stopBackgroundTask, agent.clearBackgroundTasks, agent.showBackgroundTasks…).

import {
  type BackgroundTask,
  blockedHostsLine,
  FINISHED_SHOWN,
  splitTasks,
  stepsLabel,
  taskTime,
} from "../../../core/agent/backgroundTasks";
import type { Item } from "../../../core/agent/conversation";
import type { Json } from "../../../core/dock/index";
import { h, morph, on } from "../../../core/dom/index";
import { DisposableStore, toDisposable } from "../../../core/lifecycle/index";
import { effect } from "../../../core/reactive/index";
import { icon } from "../../../ui/Icon";
import { setTooltip } from "../../../ui/Tooltip";
import type { DockView, DockViewContext, DockViewDescriptor } from "../../../workbench/dock/views";
import { stateField } from "../../../workbench/dock/views";
import type { WorkbenchServices } from "../../../workbench/services";
import { backgroundProcesses } from "../backgroundProcesses";
import type { BackgroundTaskSource } from "../backgroundTasks";
import type { SessionManager } from "../sessions";
import { subagentRuns } from "../subagentRuns";
import { toolDetail, toolLabel } from "./items";
import { TaskTranscript } from "./taskTranscript";

export const BACKGROUND_TASKS_VIEW = "agent.backgroundTasks";

/** How often times and live output refresh while something runs. */
const TICK_MS = 1000;
/** What an expanded row shows of a command's output. */
const OUTPUT_CHARS = 20_000;

/** The open views by tab, for agent.showBackgroundTasks to switch one to a task. */
const views = new Map<string, BackgroundTasksView>();

/** Shows task `task`'s transcript (null: the list) in the view of tab `tabId`. */
export function showTaskIn(tabId: string, task: string | null): void {
  views.get(tabId)?.show(task);
}

class BackgroundTasksView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly body = h("div", { class: "agent-bgtasks-body" });
  private readonly head = h("div", { class: "agent-bgtasks-head" });
  private readonly transcript: TaskTranscript;
  private task: string | null;
  /** Rows, steps and output opened by the user. */
  private readonly expanded = new Set<string>();
  private finishedOpen = true;
  private showAll = false;
  private frame = 0;

  constructor(
    private readonly session: string,
    task: string | null,
    private readonly ctx: DockViewContext,
    private readonly services: WorkbenchServices,
    sessions: SessionManager,
    private readonly source: BackgroundTaskSource,
  ) {
    this.task = task;
    this.transcript = this.store.add(new TaskTranscript(services, sessions, () => this.schedule()));
    this.element = h(
      "div",
      { class: "agent-bgtasks", tabindex: "-1", "data-session": session },
      this.head,
      this.body,
    );
    views.set(ctx.tabId, this);
    this.store.add(toDisposable(() => views.delete(ctx.tabId)));
    this.store.add(on(this.element, "click", (e) => this.onClick(e)));
    this.store.add(
      effect(() => {
        // What the list is made of: re-read on each change.
        this.source.tasks(this.session);
        this.transcript.watch(this.task);
        this.schedule();
        return undefined;
      }),
    );
    const timer = window.setInterval(() => {
      if (this.source.tasks(this.session).some((t) => t.status === "running")) this.schedule();
    }, TICK_MS);
    this.store.add(toDisposable(() => window.clearInterval(timer)));
  }

  /** Switches to a task's transcript (null: the list). */
  show(task: string | null): void {
    this.task = task;
    this.ctx.updateState({ session: this.session, ...(task && { task }) });
    this.transcript.watch(task);
    this.body.scrollTop = 0;
    this.schedule();
  }

  private run(command: string, input: unknown): void {
    void this.services.dispatcher.execute(command, input).catch((err: unknown) => {
      this.services.notifications.show("error", err instanceof Error ? err.message : String(err));
    });
  }

  private onClick(e: MouseEvent): void {
    const target = (e.target as Element).closest<HTMLElement>("[data-action]");
    if (!target || !this.element.contains(target)) return;
    const id = target.dataset.id ?? "";
    const session = this.session;
    switch (target.dataset.action) {
      case "back":
        this.run("agent.showBackgroundTasks", { session });
        return;
      case "open":
        this.run("agent.showBackgroundTasks", { session, task: id });
        return;
      case "chat":
        this.run("agent.openThread", { session: id });
        return;
      case "clear":
        this.run("agent.clearBackgroundTasks", { session });
        return;
      case "stop":
        this.run("agent.stopBackgroundTask", { session, id });
        return;
      // D352: a watched pull request's auto-merge.
      case "automerge-on":
        this.run("agent.autoMergePullRequest", { session });
        return;
      case "automerge-off":
        this.run("agent.autoMergePullRequest", { session, off: true });
        return;
      case "output":
        this.run("agent.showProcessOutput", { id });
        return;
      case "toggle":
        if (this.expanded.has(id)) this.expanded.delete(id);
        else this.expanded.add(id);
        break;
      case "fold-finished":
        this.finishedOpen = !this.finishedOpen;
        break;
      case "more":
        this.showAll = true;
        break;
      default:
        // The transcript's own toggles (the brief, work groups).
        if (!this.transcript.onAction(target.dataset.action ?? "", id)) return;
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private render(): void {
    const tasks = this.source.tasks(this.session);
    const task = this.task ? tasks.find((t) => t.id === this.task) : undefined;
    if (this.task && task) {
      const page = this.transcript.render(task, this.session, Date.now());
      this.draw(this.head, page.head);
      this.draw(this.body, page.body);
      return;
    }
    this.draw(this.head, this.listHead(tasks));
    this.draw(this.body, this.list(tasks));
  }

  /** Morphs `next`'s children into `into` (rows keep their state and scroll). */
  private draw(into: HTMLElement, next: HTMLElement): void {
    const scroll = [...into.querySelectorAll<HTMLElement>("pre")].map((p) => ({
      key: p.closest<HTMLElement>("[data-key]")?.dataset.key,
      top: p.scrollTop,
      end: p.scrollHeight - p.scrollTop - p.clientHeight < 8,
    }));
    morph(into, next);
    // Output that followed its end keeps following it.
    for (const pre of into.querySelectorAll<HTMLElement>("pre")) {
      const key = pre.closest<HTMLElement>("[data-key]")?.dataset.key;
      const was = scroll.find((s) => s.key === key);
      if (!was || was.end) pre.scrollTop = pre.scrollHeight;
    }
  }

  private listHead(tasks: readonly BackgroundTask[]): HTMLElement {
    const finished = tasks.some((t) => t.status !== "running");
    const clear = button("trash-2", "Clear finished", "clear");
    if (!finished) clear.setAttribute("disabled", "");
    return h(
      "div",
      { class: "agent-bgtasks-head" },
      h("span", { class: "agent-bgtasks-title" }, "Background tasks"),
      h("span", { class: "agent-bgtasks-spacer" }),
      // Close and expand are the tab's and its group's own (no second pair here).
      clear,
    );
  }

  private list(tasks: readonly BackgroundTask[]): HTMLElement {
    const { running, finished } = splitTasks(tasks);
    const now = Date.now();
    const shown = this.showAll ? finished : finished.slice(0, FINISHED_SHOWN);
    return h(
      "div",
      { class: "agent-bgtasks-body" },
      tasks.length === 0
        ? h("p", { class: "agent-bgtasks-empty" }, "Nothing is working in the background.")
        : null,
      running.length
        ? h(
            "section",
            { class: "agent-bgtasks-section", "data-key": "running" },
            h("h3", { class: "agent-bgtasks-section-title" }, `Running (${running.length})`),
            h("ul", { class: "agent-bgtasks-list" }, ...running.map((t) => this.row(t, now))),
          )
        : null,
      finished.length
        ? h(
            "section",
            { class: "agent-bgtasks-section", "data-key": "finished" },
            h(
              "button",
              {
                class: "agent-bgtasks-section-title is-fold",
                type: "button",
                "data-action": "fold-finished",
                "aria-expanded": String(this.finishedOpen),
              },
              `Finished (${finished.length})`,
              icon(this.finishedOpen ? "chevron-down" : "chevron-right"),
            ),
            this.finishedOpen
              ? h("ul", { class: "agent-bgtasks-list" }, ...shown.map((t) => this.row(t, now)))
              : null,
            this.finishedOpen && shown.length < finished.length
              ? h(
                  "button",
                  {
                    class: "link-button agent-bgtasks-more",
                    type: "button",
                    "data-action": "more",
                  },
                  `Show ${finished.length - shown.length} more`,
                )
              : null,
          )
        : null,
    );
  }

  private row(t: BackgroundTask, now: number): HTMLElement {
    const open = this.expanded.has(t.id);
    const agent = t.kind === "subagent" || t.kind === "helper";
    const status =
      t.status === "running" && t.serving
        ? icon("server")
        : t.status === "running"
          ? h("span", { class: "agent-spinner" })
          : icon(
              t.status === "done"
                ? "circle-check"
                : t.status === "failed"
                  ? "circle-x"
                  : "circle-minus",
            );
    const titleText = h("span", { class: "agent-bgtask-title-text" }, t.title);
    // A subagent's title opens its transcript; a helper elsewhere opens its chat; a command
    // row's title opens it in place.
    const title = h(
      "button",
      {
        class: "agent-bgtask-title",
        type: "button",
        "data-action": agent
          ? (t.transcript && this.source.helperSession(t.id) !== null) || t.kind === "subagent"
            ? "open"
            : "chat"
          : "toggle",
        "data-id": t.id,
        ...(!agent && { "aria-expanded": String(open) }),
      },
      titleText,
    );
    setTooltip(
      title,
      agent ? "Open its transcript" : `${t.title}${t.detail ? `\n${t.detail}` : ""}`,
    );
    const stop = t.canStop ? button("square", "Stop", "stop", t.id, "agent-bgtask-stop") : null;
    const autoMerge =
      t.kind === "pr" && t.status === "running"
        ? t.autoMerge
          ? button("git-merge", "Turn auto-merge off", "automerge-off", t.id, "agent-bgtask-stop")
          : button("git-merge", "Auto-merge when ready", "automerge-on", t.id, "agent-bgtask-stop")
        : null;
    const steps = agent ? stepsLabel(t.steps) : null;
    const top = h(
      "div",
      { class: "agent-bgtask-top" },
      h("span", { class: "agent-bgtask-status" }, status),
      title,
      h("span", { class: "agent-bgtask-time" }, taskTime(t, now)),
      autoMerge,
      stop,
      agent ? null : chevronButton(open, t.id),
    );
    const sub = agent
      ? h(
          "div",
          { class: "agent-bgtask-sub" },
          t.detail ? h("span", { class: "agent-bgtask-detail" }, t.detail) : null,
          steps
            ? h(
                "button",
                {
                  class: "agent-bgtask-steps",
                  type: "button",
                  "data-action": "toggle",
                  "data-id": t.id,
                  "aria-expanded": String(open),
                },
                steps.text,
                steps.failed ? h("span", { class: "agent-bgtask-failed" }, steps.failed) : null,
                icon(open ? "chevron-down" : "chevron-right"),
              )
            : null,
        )
      : t.detail || t.blockedHosts
        ? h(
            "div",
            { class: "agent-bgtask-sub" },
            t.detail ? h("span", { class: "agent-bgtask-detail" }, t.detail) : null,
            // The sandbox held it back from a host (D372), as a foreground command's result says.
            t.blockedHosts
              ? h(
                  "span",
                  { class: "agent-bgtask-detail is-refused", title: t.blockedHosts.join("\n") },
                  blockedHostsLine(t.blockedHosts),
                )
              : null,
          )
        : null;
    return h(
      "li",
      {
        class: `agent-bgtask is-${t.kind} is-${t.status}`,
        "data-task": t.id,
        "data-key": t.id,
      },
      top,
      sub,
      open ? (agent ? this.stepsOf(t) : this.outputOf(t)) : null,
    );
  }

  /** A subagent's (or helper's) own tool calls, each opening to its command and output. */
  private stepsOf(t: BackgroundTask): HTMLElement {
    const items: readonly Item[] =
      t.kind === "subagent"
        ? (subagentRuns.get(t.id)?.items ?? [])
        : (this.transcript.helperItems(t.id) ?? []);
    const relative = (path: string) =>
      this.services.workspace.root.peek() ? this.services.workspace.relative(path) : path;
    const outputs = this.transcript.outputsFor(t);
    const rows = items.flatMap((item) => {
      if (item.type !== "tool") return [];
      const key = `${t.id}/${item.id}`;
      const open = this.expanded.has(key);
      const { verb, target } = toolLabel(item, relative);
      const args = (item.args ?? {}) as Record<string, unknown>;
      const command = typeof args.command === "string" ? `$ ${args.command}` : null;
      const output = toolDetail(item, outputs?.get(item.id)) ?? item.result ?? "";
      return [
        h(
          "li",
          { class: `agent-bgtask-step is-${item.status}`, "data-key": key },
          h(
            "button",
            {
              class: "agent-bgtask-step-row",
              type: "button",
              "data-action": "toggle",
              "data-id": key,
              "aria-expanded": String(open),
            },
            item.status === "running"
              ? h("span", { class: "agent-spinner" })
              : icon(item.status === "error" ? "circle-x" : "check"),
            h(
              "span",
              { class: "agent-bgtask-step-text" },
              h("span", { class: "agent-step-verb" }, verb),
              target ? ` ${target}` : "",
            ),
            item.summary ? h("span", { class: "agent-bgtask-step-meta" }, item.summary) : null,
            icon(open ? "chevron-down" : "chevron-right"),
          ),
          open
            ? h(
                "pre",
                { class: "agent-bgtask-output" },
                command
                  ? `${command}\n\n${output}`
                  : `${item.name} ${JSON.stringify(item.args ?? {}).slice(0, 400)}\n\n${output}`,
              )
            : null,
        ),
      ];
    });
    return h(
      "ul",
      { class: "agent-bgtask-steps-list" },
      ...(rows.length ? rows : [h("li", { class: "agent-bgtask-none" }, "No tool calls yet.")]),
    );
  }

  /** A command's line and what it printed (live while it runs). */
  private outputOf(t: BackgroundTask): HTMLElement {
    if (t.kind === "pr")
      return h("pre", { class: "agent-bgtask-output" }, t.detail ?? "Not looked at yet.");
    const p = backgroundProcesses.get(t.id);
    const text = p?.output.tail(OUTPUT_CHARS) ?? "";
    return h(
      "div",
      { class: "agent-bgtask-cmd" },
      h(
        "pre",
        { class: "agent-bgtask-output" },
        `$ ${p?.command ?? t.title}\n\n${text || (t.status === "running" ? "Nothing printed yet." : "It printed nothing.")}`,
      ),
      p
        ? h(
            "button",
            {
              class: "link-button agent-bgtask-open-output",
              type: "button",
              "data-action": "output",
              "data-id": t.id,
            },
            icon("square-terminal"),
            "Open output",
          )
        : null,
    );
  }

  focus(): void {
    this.element.focus();
  }

  serialize(): Json {
    return { session: this.session, ...(this.task && { task: this.task }) };
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.store.dispose();
  }
}

function button(
  name: Parameters<typeof icon>[0],
  label: string,
  action: string,
  id?: string,
  extra = "",
): HTMLElement {
  const b = h(
    "button",
    {
      class: `icon-button ${extra}`.trim(),
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

function chevronButton(open: boolean, id: string): HTMLElement {
  return h(
    "button",
    {
      class: "icon-button agent-bgtask-chevron",
      type: "button",
      "aria-label": open ? "Hide output" : "Show output",
      "aria-expanded": String(open),
      "data-action": "toggle",
      "data-id": id,
    },
    icon(open ? "chevron-down" : "chevron-right"),
  );
}

export function backgroundTasksView(
  services: WorkbenchServices,
  sessions: SessionManager,
  source: BackgroundTaskSource,
): DockViewDescriptor {
  return {
    type: BACKGROUND_TASKS_VIEW,
    title: () => "Background tasks",
    icon: () => "list-checks",
    defaultPlacement: "right",
    create: (st, ctx) => {
      const session = stateField(st, "session");
      const task = stateField(st, "task");
      return new BackgroundTasksView(
        typeof session === "string" ? session : "",
        typeof task === "string" ? task : null,
        ctx,
        services,
        sessions,
        source,
      );
    },
  };
}

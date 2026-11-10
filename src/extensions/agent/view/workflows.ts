// The chat's workflow runs (D338) as cards under the conversation's latest message, as the plan
// is: each run's name and status, its usage so far, Stop while it runs, and its agents grouped by
// phase (a phase from the script's meta, or one a phase() call started), each with its status.
// A run stays shown after it ends until the user's next message. Stop runs agent.stopWorkflow.
// D351: an editing agent's row has its worktree under it, with Review / Merge once it ended.
import type { Item } from "../../../core/agent/conversation";
import { formatTokens, type WorkflowAgentRecord } from "../../../core/agent/workflow";
import { worktreeChanges } from "../../../core/agent/workflowEditing";
import { h, on, replaceChildren } from "../../../core/dom/index";
import { type Disposable, DisposableStore } from "../../../core/lifecycle/index";
import { effect } from "../../../core/reactive/index";
import { icon } from "../../../ui/Icon";
import { setTooltip } from "../../../ui/Tooltip";
import { type WorkflowRun, workflowRuns } from "../workflows";

const STATUS_TEXT: Record<WorkflowRun["status"], string> = {
  running: "Running",
  done: "Finished",
  failed: "Failed",
  stopped: "Stopped",
};

const AGENT_TEXT: Record<WorkflowAgentRecord["status"], string> = {
  queued: "waiting",
  running: "working",
  done: "done",
  failed: "failed",
  cached: "cached",
  stopped: "stopped",
};

export class WorkflowCards implements Disposable {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  /** The cards' listeners, cleared on each draw. */
  private readonly rows = this.store.add(new DisposableStore());
  /** Runs folded to their head line. */
  private readonly folded = new Set<string>();
  /** The id of the user's latest typed message (runs started before it aren't shown). */
  private lastMessage: string | null = null;
  private shown = "";

  constructor(
    private readonly session: string,
    private readonly run: (command: string, input?: unknown) => void,
  ) {
    this.element = h("div", { class: "agent-workflows", role: "group" });
    this.store.add(
      effect(() => {
        workflowRuns.version.value;
        this.draw();
        return undefined;
      }),
    );
  }

  /** The cards for the conversation as it is now, or null when no run is shown. */
  update(items: readonly Item[]): HTMLElement | null {
    let last: string | null = null;
    for (const it of items) if (it.type === "user" && !it.auto) last = it.id;
    if (last !== this.lastMessage) {
      this.lastMessage = last;
      this.draw();
    }
    return this.visible().length ? this.element : null;
  }

  private visible(): WorkflowRun[] {
    return workflowRuns
      .list(this.session)
      .filter((r) => r.status === "running" || r.startedUnder === this.lastMessage);
  }

  private draw(): void {
    const runs = this.visible();
    const key = JSON.stringify([
      [...this.folded],
      runs.map((r) => [r.id, r.status, r.runtime.phase, r.logs.length, r.runtime.agents]),
    ]);
    if (key === this.shown) return;
    this.shown = key;
    this.rows.clear();
    replaceChildren(this.element, ...runs.map((r) => this.card(r)));
  }

  private card(r: WorkflowRun): HTMLElement {
    const running = r.status === "running";
    const open = !this.folded.has(r.id);
    const agents = r.runtime.agents;
    const finished = agents.filter((a) => a.status !== "queued" && a.status !== "running").length;
    const tokens = agents.reduce((n, a) => n + a.inputTokens + a.outputTokens, 0);
    const meta = [
      STATUS_TEXT[r.status],
      agents.length ? `${finished} of ${agents.length} agents` : "",
      tokens ? `${formatTokens(tokens)} tokens` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const head = h(
      "button",
      { class: "agent-workflow-head", type: "button", "aria-expanded": String(open) },
      running
        ? h("span", { class: "agent-workflow-mark is-running", "aria-label": "Running" })
        : icon(
            r.status === "done" ? "circle-check" : r.status === "failed" ? "circle-x" : "square",
          ),
      h("span", { class: "agent-workflow-title" }, `Workflow ${r.meta.name}`),
      h("span", { class: "agent-workflow-meta" }, meta),
      icon(open ? "chevron-down" : "chevron-right"),
    );
    setTooltip(head, `${r.id}: ${r.meta.description}`);
    this.rows.add(
      on(head, "click", () => {
        if (open) this.folded.add(r.id);
        else this.folded.delete(r.id);
        this.draw();
      }),
    );
    let stop: HTMLElement | null = null;
    if (running) {
      stop = h(
        "button",
        { class: "button button-ghost button-sm agent-workflow-stop", type: "button" },
        "Stop",
      );
      setTooltip(stop, "Stop the workflow and its agents", "agent.stopWorkflow");
      this.rows.add(on(stop, "click", () => this.run("agent.stopWorkflow", { id: r.id })));
    }
    const last = r.error ?? r.logs[r.logs.length - 1];
    return h(
      "div",
      { class: `agent-workflow is-${r.status}`, "data-run": r.id },
      h("div", { class: "agent-workflow-top" }, head, stop),
      open ? h("div", { class: "agent-workflow-desc" }, r.meta.description) : null,
      open && agents.length ? this.phases(r) : null,
      open && last
        ? h("div", { class: `agent-workflow-log${r.error ? " is-error" : ""}` }, last)
        : null,
    );
  }

  /** The agents grouped by phase: the meta's phases in order, then any others, then the rest. */
  private phases(r: WorkflowRun): HTMLElement {
    const agents = r.runtime.agents;
    const titles = [
      ...r.meta.phases.map((p) => p.title),
      ...agents.map((a) => a.phase).filter((p): p is string => !!p),
    ].filter((t, i, all) => all.indexOf(t) === i);
    const groups: { title: string | null; agents: WorkflowAgentRecord[] }[] = [
      ...titles.map((title) => ({ title, agents: agents.filter((a) => a.phase === title) })),
      { title: null, agents: agents.filter((a) => !a.phase) },
    ].filter((g) => g.agents.length || (g.title && g.title === r.runtime.phase));
    return h(
      "ol",
      { class: "agent-workflow-phases" },
      ...groups.map((g) =>
        h(
          "li",
          { class: "agent-workflow-phase" },
          g.title ? h("div", { class: "agent-workflow-phase-title" }, g.title) : null,
          h(
            "ul",
            { class: "agent-workflow-agents" },
            ...g.agents.flatMap((a) => [agentRow(a), this.worktreeRow(a)]),
          ),
        ),
      ),
    );
  }

  /**
   * D351: an editing agent's worktree under its row: its branch, what it changed, and Review /
   * Merge once it ended with changes (agent.helpers: the compare page; merge asks first).
   */
  private worktreeRow(a: WorkflowAgentRecord): HTMLElement | null {
    const w = a.worktree;
    if (!w) return null;
    const changes = w.ended && w.files.length > 0;
    const button = (label: string, action: "review" | "merge", primary: boolean) => {
      const b = h(
        "button",
        {
          class: `button ${primary ? "button-primary" : "button-secondary"} button-sm`,
          type: "button",
        },
        label,
      );
      setTooltip(
        b,
        action === "review"
          ? `Review ${w.branch}'s changes`
          : `Merge ${w.branch}'s changes into this folder (asks first)`,
        "agent.helpers",
      );
      this.rows.add(on(b, "click", () => this.run("agent.helpers", { helper: w.helper, action })));
      return b;
    };
    return h(
      "li",
      { class: "agent-workflow-worktree", "data-branch": w.branch },
      icon("git-branch"),
      h("span", { class: "agent-workflow-branch" }, w.branch),
      h(
        "span",
        { class: "agent-workflow-state" },
        w.ended ? worktreeChanges(w) : "editing in its worktree",
      ),
      changes ? button("Review", "review", true) : null,
      changes ? button("Merge", "merge", false) : null,
    );
  }

  dispose(): void {
    this.store.dispose();
  }
}

function agentRow(a: WorkflowAgentRecord): HTMLElement {
  const tokens = a.inputTokens + a.outputTokens;
  const mark =
    a.status === "running"
      ? h("span", { class: "agent-workflow-mark is-running", "aria-label": "Working" })
      : a.status === "queued"
        ? h("span", { class: "agent-workflow-mark is-waiting", "aria-label": "Waiting" })
        : icon(
            a.status === "done" || a.status === "cached"
              ? "check"
              : a.status === "failed"
                ? "circle-x"
                : "square",
          );
  const li = h(
    "li",
    { class: `agent-workflow-agent is-${a.status}` },
    mark,
    h("span", { class: "agent-workflow-label" }, a.label),
    h(
      "span",
      { class: "agent-workflow-state" },
      [AGENT_TEXT[a.status], tokens ? `${formatTokens(tokens)} tokens` : ""]
        .filter(Boolean)
        .join(" · "),
    ),
  );
  if (a.error) setTooltip(li, a.error);
  return li;
}

// The worktree agents' pages (D204). Worktree agents (dock view `agent.worktreeAgents`): every
// agent started in a worktree from this folder, its state (setting up, working, waiting for you,
// done, error), the files and lines it changed, how long it has run, its PORT, with Open, Compare,
// Apply, Review and Delete. Compare (dock view `agent.compareWorktrees`, state { group }): the
// agents given the same task (best of N) side by side, one's diff shown at a time, Apply this one.
// Both read again every few seconds while open. Actions are commands (worktreeAgents.ts).
import { elapsedText } from "../../core/agent/worktrees";
import type { Json } from "../../core/dock/index";
import { h, on } from "../../core/dom/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { DockView, DockViewDescriptor } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import {
  emptyNote,
  linkButton,
  pageButton,
  pageHeader,
  pageSection,
  runCommand,
  tag,
} from "./view/pageKit";
import type { AgentProgress, WorktreeRegistry } from "./worktreeRuns";

/**
 * An open page follows the agents' saved chats as they change (D233: the saved-chats folder is
 * watched, each window saves within 1.5 s); this slower check is for what isn't a save: an agent's
 * window that closed or crashed, and changes in the worktree between saves.
 */
const LIVENESS_MS = 15_000;

const STATE_LABEL: Record<string, string> = {
  starting: "Setting up",
  working: "Working",
  waiting: "Waiting for you",
  done: "Done",
  error: "Stopped with an error",
  stopped: "Stopped",
  gone: "Gone",
};

/** "2 conflicts" after an Apply that left some (D207). */
function conflictText(conflicts: readonly string[] | undefined): string {
  const n = conflicts?.length ?? 0;
  return n ? `${n} conflict${n === 1 ? "" : "s"}` : "";
}

function progressText(p: AgentProgress | undefined): string {
  if (!p) return "…";
  const lines = p.files !== undefined ? `${p.files} files +${p.added ?? 0} −${p.removed ?? 0}` : "";
  return [STATE_LABEL[p.state] ?? p.state, lines].filter(Boolean).join(" · ");
}

abstract class PollingPage implements DockView {
  readonly element: HTMLElement;
  protected readonly store = new DisposableStore();
  protected readonly render = this.store.add(new DisposableStore());
  protected readonly body: HTMLElement;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    protected readonly services: WorkbenchServices,
    protected readonly registry: WorktreeRegistry,
    className: string,
  ) {
    this.body = h("div", { class: `ai-setup ${className}` });
    this.element = h("div", { class: "ai-page", tabindex: "-1" }, this.body);
  }

  /** Called by the subclass once its own fields are set (draw() reads them). */
  protected start(): void {
    const registry = this.registry;
    this.store.add(
      effect(() => {
        registry.agents.value;
        registry.progress.value;
        this.draw();
        return undefined;
      }),
    );
    void registry.refresh();
    this.store.add(registry.follow());
    this.timer = setInterval(() => void registry.refresh(), LIVENESS_MS);
    this.store.add({ dispose: () => clearInterval(this.timer) });
  }

  protected run(command: string, input: unknown = {}): Promise<unknown> {
    return runCommand(this.services, command, input);
  }

  protected abstract draw(): void;

  focus(): void {
    this.element.focus();
  }

  abstract serialize(): Json;

  dispose(): void {
    this.store.dispose();
  }
}

class WorktreeAgentsView extends PollingPage {
  constructor(services: WorkbenchServices, registry: WorktreeRegistry) {
    super(services, registry, "worktree-agents-page");
    this.start();
  }

  protected draw(): void {
    this.render.clear();
    const st = this.render;
    const agents = [...this.registry.agents.peek()].sort((a, b) => b.startedAt - a.startedAt);
    const progress = this.registry.progress.peek();
    const rows = agents.map((a) => {
      const p = progress.get(a.chat);
      const setup =
        a.setup?.state === "failed"
          ? `setup failed (exit ${a.setup.exitCode ?? "?"})`
          : a.setup?.state === "running"
            ? "setting up"
            : a.setup?.copied.length
              ? `copied ${a.setup.copied.join(", ")}`
              : "";
      return h(
        "div",
        { class: "ai-row", "data-branch": a.branch },
        h("span", {
          class: `ai-dot${p?.state === "working" || p?.state === "starting" ? " is-busy" : p?.state === "error" ? " is-error" : p?.state === "waiting" || p?.state === "stopped" ? " is-warning" : " is-ok"}`,
        }),
        h(
          "div",
          { class: "ai-row-main" },
          h("span", { class: "ai-row-name" }, a.branch),
          h(
            "span",
            { class: "ai-row-detail" },
            [
              a.model ?? "",
              progressText(p),
              `${elapsedText(Date.now() - a.startedAt)}`,
              `PORT ${a.port}`,
              setup,
              a.applied ? "applied" : "",
              conflictText(a.conflicts),
            ]
              .filter(Boolean)
              .join(" · "),
          ),
          h("span", { class: "ai-row-detail" }, a.task.replace(/\s+/g, " ").slice(0, 140)),
        ),
        a.group ? tag("Best of N") : null,
        a.headless ? tag("In this window") : null,
        h(
          "div",
          { class: "ai-row-actions" },
          linkButton(st, "Open", () =>
            this.run("agent.worktrees", { branch: a.branch, action: "open" }),
          ),
          a.group
            ? linkButton(st, "Compare", () =>
                this.run("agent.compareWorktrees", { group: a.group }),
              )
            : linkButton(st, "Changes", () =>
                this.run("agent.compareWorktrees", { agents: [a.chat] }),
              ),
          linkButton(st, "Apply", () => this.run("agent.applyWorktree", { agent: a.chat })),
          a.conflicts?.length
            ? linkButton(st, "Resolve conflicts", () =>
                this.run("agent.resolveWorktreeConflicts", { agent: a.chat }),
              )
            : null,
          linkButton(st, "Review", () =>
            this.run("agent.worktrees", { branch: a.branch, action: "review" }),
          ),
          linkButton(
            st,
            "Delete",
            () => this.run("agent.worktrees", { branch: a.branch, action: "delete" }),
            true,
          ),
        ),
      );
    });
    this.body.replaceChildren(
      pageHeader(
        "Worktree agents",
        "Agents working in git worktrees of this folder, each with its own branch and PORT, in a window of its own or (helpers) in this one.",
        pageButton(
          st,
          "New agent in a worktree",
          "plus",
          () => this.run("agent.startInWorktree"),
          "ai-header-button",
        ),
        pageButton(st, "Best of N", "layers", () => this.run("agent.bestOfN"), "ai-header-button"),
      ),
      pageSection(
        "Running and finished",
        null,
        rows.length
          ? h("div", { class: "ai-list" }, ...rows)
          : emptyNote("None yet. New agent in a worktree gives a task its own branch and window."),
      ),
    );
  }

  serialize(): Json {
    return null;
  }
}

class CompareView extends PollingPage {
  private selected: string | null = null;
  private diffText = "";
  private diffFor: string | null = null;
  private seen: unknown = null;

  constructor(
    services: WorkbenchServices,
    registry: WorktreeRegistry,
    private readonly target: { group?: string; agents?: string[] },
  ) {
    super(services, registry, "compare-page");
    this.start();
  }

  private candidates() {
    const all = this.registry.agents.peek();
    return this.target.group
      ? all.filter((a) => a.group === this.target.group)
      : all.filter((a) => this.target.agents?.includes(a.chat));
  }

  private async loadDiff(chat: string): Promise<void> {
    const agent = this.candidates().find((a) => a.chat === chat);
    if (!agent) return;
    const d = await this.registry.diff(agent).catch((err: unknown) => ({
      files: [],
      text: `Couldn't read its changes: ${err instanceof Error ? err.message : String(err)}`,
      truncated: false,
    }));
    this.diffFor = chat;
    this.diffText = `${d.text}${d.truncated ? "\n… (truncated)" : ""}`;
    this.draw();
  }

  protected draw(): void {
    this.render.clear();
    const st = this.render;
    const list = this.candidates();
    if (!this.selected && list[0]) this.selected = list[0].chat;
    const progress = this.registry.progress.peek();
    // Read again after each refresh (the agent may have changed more).
    if (progress !== this.seen) {
      this.seen = progress;
      this.diffFor = null;
    }
    if (this.selected && this.diffFor !== this.selected) void this.loadDiff(this.selected);
    const rows = list.map((a) => {
      const row = h(
        "div",
        {
          class: `ai-row compare-row${a.chat === this.selected ? " is-selected" : ""}`,
          "data-branch": a.branch,
          role: "button",
          tabindex: "0",
        },
        h(
          "div",
          { class: "ai-row-main" },
          h("span", { class: "ai-row-name" }, a.model ?? a.branch),
          h(
            "span",
            { class: "ai-row-detail" },
            [
              a.branch,
              progressText(progress.get(a.chat)),
              a.applied ? "applied" : "",
              conflictText(a.conflicts),
            ]
              .filter(Boolean)
              .join(" · "),
          ),
        ),
        h(
          "div",
          { class: "ai-row-actions" },
          a.conflicts?.length
            ? pageButton(st, "Resolve conflicts", "git-merge", () =>
                this.run("agent.resolveWorktreeConflicts", { agent: a.chat }),
              )
            : null,
          pageButton(st, "Apply this one", "check", () =>
            this.run("agent.applyWorktree", { agent: a.chat }),
          ),
        ),
      );
      const pick = () => {
        this.selected = a.chat;
        this.diffFor = null;
        this.draw();
      };
      st.add(
        on(row, "click", (e) => {
          if (!(e.target as HTMLElement).closest("button")) pick();
        }),
      );
      st.add(
        on(row, "keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            pick();
          }
        }),
      );
      return row;
    });
    const diff = h(
      "pre",
      { class: "compare-diff", "aria-label": "Changes" },
      ...this.diffText.split("\n").map((line) =>
        h(
          "span",
          {
            class:
              line.startsWith("+") && !line.startsWith("+++")
                ? "diff-line is-added"
                : line.startsWith("-") && !line.startsWith("---")
                  ? "diff-line is-removed"
                  : line.startsWith("@@")
                    ? "diff-line is-hunk"
                    : line.startsWith("diff --git")
                      ? "diff-line is-file"
                      : "diff-line",
          },
          `${line}\n`,
        ),
      ),
    );
    const title = list[0]?.task.replace(/\s+/g, " ").slice(0, 90) ?? "Compare";
    this.body.replaceChildren(
      pageHeader(
        "Compare",
        list.length > 1
          ? `${list.length} agents on: ${title}. Pick one to see its changes; Apply this one brings them into this folder (staged).`
          : `Changes of ${list[0]?.branch ?? "the agent"} against the commit it started from.`,
        pageButton(
          st,
          "Worktree agents",
          "layers",
          () => this.run("agent.worktreeAgents"),
          "ai-header-button",
        ),
      ),
      pageSection(
        "Agents",
        null,
        rows.length ? h("div", { class: "ai-list" }, ...rows) : emptyNote("These agents are gone."),
      ),
      pageSection(
        "Changes",
        null,
        this.diffText.trim()
          ? diff
          : emptyNote(this.selected ? "No changes yet." : "Pick an agent."),
      ),
    );
  }

  serialize(): Json {
    return { ...this.target } as Json;
  }
}

export function registerWorktreePages(
  sub: DisposableStore,
  services: WorkbenchServices,
  registry: WorktreeRegistry,
): void {
  const { dispatcher, dock } = services;
  sub.add(
    dock.views.register({
      type: "agent.worktreeAgents",
      title: () => "Worktree agents",
      icon: () => "folder-git-2",
      singleton: true,
      defaultPlacement: "main",
      editorLike: true,
      create: () => new WorktreeAgentsView(services, registry),
    } satisfies DockViewDescriptor),
  );
  sub.add(
    dock.views.register({
      type: "agent.compareWorktrees",
      title: () => "Compare agents",
      icon: () => "git-compare",
      defaultPlacement: "main",
      editorLike: true,
      create: (state) => {
        const st = (state ?? {}) as { group?: unknown; agents?: unknown };
        return new CompareView(services, registry, {
          ...(typeof st.group === "string" && { group: st.group }),
          ...(Array.isArray(st.agents) && {
            agents: st.agents.filter((x): x is string => typeof x === "string"),
          }),
        });
      },
    } satisfies DockViewDescriptor),
  );
  sub.add(
    dispatcher.register({
      id: "agent.worktreeAgents",
      title: "Worktree agents",
      category: "Agent",
      description:
        "Opens the worktree agents overview: every agent started in a git worktree from this folder with its state, files changed, elapsed time and PORT (the same data as ide://agent/worktrees).",
      input: s.empty(),
      effects: [],
      when: "gitRepo",
      agent: "hidden",
      run: () => ({ tabId: dock.openView("agent.worktreeAgents", null, "main", true) }),
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.compareWorktrees",
      title: "Compare worktree agents",
      category: "Agent",
      description:
        "Opens the compare page for the agents of a best-of-N `group` (or the given `agents`, chat ids or branches): their changes against the start commit, one at a time, with Apply this one. Without either, the newest group.",
      input: s.object({
        group: s.string().optional(),
        agents: s.array(s.string()).optional(),
      }),
      effects: [],
      when: "gitRepo",
      agent: "hidden",
      run: ({ group, agents }) => {
        const all = registry.agents.peek();
        const chats = agents
          ?.map((ref) => registry.find(ref)?.chat)
          .filter((x): x is string => !!x);
        const newest = [...all].filter((a) => a.group).sort((a, b) => b.startedAt - a.startedAt)[0];
        const target: Json =
          group || !chats?.length ? { group: group ?? newest?.group ?? "" } : { agents: chats };
        if (!group && !chats?.length && !newest) throw new Error("No best-of-N agents to compare.");
        return { tabId: dock.openView("agent.compareWorktrees", target, "main", true) };
      },
    }),
  );
}

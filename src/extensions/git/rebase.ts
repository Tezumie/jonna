// Interactive rebase (D139), in the spirit of GitLens's rebase editor: the commits after a base,
// oldest first (the order git replays them), each with an action — pick, reword (new message
// typed here), edit (stop to amend), squash, fixup, drop — reordered by dragging or Alt+↑/↓.
// "Start rebase" runs git.rebaseInteractive with the list; git takes it as written (no editor,
// see src-tauri/src/git/rebase.rs). A conflict or an edit stop leaves the rebase in progress
// for the source control banner's Continue / Abort.

import type { Json } from "../../core/dock/index";
import { h, on, replaceChildren } from "../../core/dom/index";
import type { Commit, RebaseAction, RebaseStep } from "../../core/ipc/git";
import { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import { icon } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import type { DockView, DockViewContext } from "../../workbench/dock/views";
import { stateField } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { blameAge } from "./cloneBlame";
import type { GitRepo } from "./controller";
import type { GitRepositories } from "./repositories";

export const REBASE_ACTIONS: readonly RebaseAction[] = [
  "pick",
  "reword",
  "edit",
  "squash",
  "fixup",
  "drop",
];

const ACTION_HINTS: Record<RebaseAction, string> = {
  pick: "Keep the commit",
  reword: "Keep it with a new message",
  edit: "Stop after it to amend",
  squash: "Fold into the one above, combining messages",
  fixup: "Fold into the one above, keeping its message",
  drop: "Remove the commit",
};

/** A planned step with the commit it came from. */
export interface PlannedStep extends RebaseStep {
  subject: string;
  author: string;
  time: number;
}

/** What's wrong with a plan, or undefined when git can run it. */
export function planProblem(steps: readonly RebaseStep[]): string | undefined {
  const kept = steps.filter((st) => st.action !== "drop");
  if (!kept.length) return "Every commit is dropped: keep at least one (or reset instead).";
  const first = kept[0];
  if (first && (first.action === "squash" || first.action === "fixup"))
    return `The first kept commit can't be ${first.action === "squash" ? "squashed" : "fixed up"}: there's nothing above it to fold into.`;
  const reword = steps.find((st) => st.action === "reword" && !st.message?.trim());
  if (reword) return `Type the new message for ${reword.hash.slice(0, 7)}.`;
  return undefined;
}

/** Moves item `from` to `to` (a new array). */
export function moveStep<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}

class RebaseView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly list: HTMLElement;
  private readonly status: HTMLElement;
  private readonly start: HTMLButtonElement;
  private steps: PlannedStep[] = [];
  private dragFrom = -1;

  constructor(
    private readonly base: string,
    private readonly services: WorkbenchServices,
    private readonly ctx: DockViewContext,
    private readonly git: GitRepo,
    /** The repository's root (D220: the tab rebases the repository it was opened for). */
    private readonly repository: string,
  ) {
    this.list = h("div", { class: "rebase-list", role: "list" });
    this.status = h("div", { class: "rebase-status", role: "status" });
    this.start = h(
      "button",
      { class: "button button-primary", type: "button" },
      icon("git-branch"),
      h("span", {}, "Start rebase"),
    );
    const cancel = h("button", { class: "button button-secondary", type: "button" }, "Cancel");
    this.element = h(
      "div",
      { class: "rebase-view" },
      h(
        "div",
        { class: "rebase-header" },
        h(
          "div",
          { class: "rebase-title" },
          `Rebase onto ${base === "root" ? "the first commit (all commits)" : base.slice(0, 12)}`,
        ),
        h(
          "div",
          { class: "rebase-hint" },
          "Top runs first. Drag or Alt+↑/↓ to reorder; type p, r, e, s, f or d on a row to set its action.",
        ),
        h("div", { class: "rebase-actions" }, this.start, cancel),
      ),
      this.status,
      this.list,
    );
    this.store.add(on(this.start, "click", () => void this.run()));
    this.store.add(on(cancel, "click", () => ctx.close()));
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const commits = await this.git.ipc.rebasePlan(this.base);
      this.steps = commits.map((c: Commit) => ({
        action: "pick",
        hash: c.hash,
        subject: c.subject,
        author: c.author,
        time: c.time,
      }));
      if (!this.steps.length) this.status.textContent = "No commits after the base to rebase.";
      this.render();
    } catch (err) {
      this.status.textContent = err instanceof Error ? err.message : String(err);
      this.status.classList.add("is-error");
    }
  }

  private render(focusIndex?: number): void {
    const rows = this.steps.map((st, i) => this.row(st, i));
    replaceChildren(this.list, ...rows);
    const problem = this.steps.length ? planProblem(this.steps) : "Nothing to rebase.";
    this.start.disabled = !!problem;
    if (this.steps.length) {
      this.status.textContent = problem ?? summary(this.steps);
      this.status.classList.toggle("is-error", !!problem);
    }
    if (focusIndex !== undefined) rows[focusIndex]?.focus();
  }

  private row(st: PlannedStep, index: number): HTMLElement {
    const select = h(
      "select",
      { class: "input rebase-action", "aria-label": `Action for ${st.hash.slice(0, 7)}` },
      ...REBASE_ACTIONS.map((a) =>
        h("option", { value: a, selected: a === st.action, title: ACTION_HINTS[a] }, a),
      ),
    );
    select.addEventListener("change", () => {
      this.setAction(index, select.value as RebaseAction);
    });
    const message =
      st.action === "reword"
        ? h("textarea", {
            class: "input rebase-message",
            rows: Math.min(6, Math.max(1, (st.message ?? st.subject).split("\n").length)),
            spellcheck: "true",
            "aria-label": "New commit message (subject, blank line, body)",
          })
        : h("span", { class: "rebase-subject" }, st.subject || "(no message)");
    if (message instanceof HTMLTextAreaElement) {
      message.value = st.message ?? st.subject;
      message.addEventListener("input", () => {
        st.message = message.value;
        const problem = planProblem(this.steps);
        this.start.disabled = !!problem;
        this.status.textContent = problem ?? summary(this.steps);
        this.status.classList.toggle("is-error", !!problem);
      });
      message.addEventListener("keydown", (e) => e.stopPropagation());
    }
    const grip = h("span", { class: "rebase-grip" }, icon("grip-vertical"));
    setTooltip(grip, "Drag to reorder");
    const row = h(
      "div",
      {
        class: `rebase-row is-${st.action}`,
        role: "listitem",
        tabindex: "0",
        draggable: "true",
        "data-index": String(index),
      },
      grip,
      select,
      h("code", { class: "rebase-hash" }, st.hash.slice(0, 7)),
      message,
      h("span", { class: "rebase-meta" }, `${st.author} · ${blameAge(st.time)}`),
    );
    row.addEventListener("keydown", (e) => {
      if (e.target !== row) return;
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        const to = index + (e.key === "ArrowUp" ? -1 : 1);
        if (to < 0 || to >= this.steps.length) return;
        this.steps = moveStep(this.steps, index, to);
        this.render(to);
        return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const next = row.parentElement?.children[index + (e.key === "ArrowUp" ? -1 : 1)];
        if (next instanceof HTMLElement) next.focus();
        return;
      }
      const action = REBASE_ACTIONS.find((a) => a[0] === e.key.toLowerCase());
      if (action && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        this.setAction(index, action, true);
      }
    });
    row.addEventListener("dragstart", (e) => {
      this.dragFrom = index;
      e.dataTransfer?.setData("text/plain", st.hash);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      row.classList.add("is-dragging");
    });
    row.addEventListener("dragend", () => row.classList.remove("is-dragging"));
    row.addEventListener("dragover", (e) => {
      if (this.dragFrom < 0) return;
      e.preventDefault();
      row.classList.add("is-drop-target");
    });
    row.addEventListener("dragleave", () => row.classList.remove("is-drop-target"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      const from = this.dragFrom;
      this.dragFrom = -1;
      if (from < 0 || from === index) return this.render();
      this.steps = moveStep(this.steps, from, index);
      this.render(index);
    });
    return row;
  }

  private setAction(index: number, action: RebaseAction, keepFocus = false): void {
    const st = this.steps[index];
    if (!st) return;
    st.action = action;
    const focusMessage = () =>
      this.list
        .querySelectorAll<HTMLTextAreaElement>(".rebase-message")
        [
          this.steps.slice(0, this.steps.indexOf(st) + 1).filter((x) => x.action === "reword")
            .length - 1
        ]?.focus();
    if (action === "reword" && st.message === undefined) {
      st.message = st.subject;
      // The whole message (body, trailers), so rewording doesn't drop them.
      void this.git.ipc
        .commitDetail(st.hash)
        .then((d) => {
          if (st.message === st.subject && d.message) {
            st.message = d.message;
            this.render();
            if (st.action === "reword") focusMessage();
          }
        })
        .catch(() => {});
    }
    this.render(keepFocus ? index : undefined);
    if (action === "reword") focusMessage();
  }

  private async run(): Promise<void> {
    if (planProblem(this.steps)) return;
    this.start.disabled = true;
    this.status.textContent = "Rebasing…";
    this.status.classList.remove("is-error");
    try {
      const result = (await this.services.dispatcher.execute("git.rebaseInteractive", {
        base: this.base,
        ...(this.repository && { repository: this.repository }),
        steps: this.steps.map(({ action, hash, message }) => ({
          action,
          hash,
          ...(action === "reword" && { message: message ?? "" }),
        })),
      })) as { stopped?: boolean } | undefined;
      if (result?.stopped) {
        this.status.textContent =
          "The rebase stopped (a conflict or an edit). Finish in Source control: Continue or Abort.";
        void this.services.dispatcher.execute("git.showView").catch(() => {});
      } else this.ctx.close();
    } catch (err) {
      this.start.disabled = false;
      const text = err instanceof Error ? err.message : String(err);
      // Declining the confirmation isn't an error.
      const declined = /^Not permitted/.test(text);
      this.status.textContent = declined ? summary(this.steps) : text;
      this.status.classList.toggle("is-error", !declined);
    }
  }

  focus(): void {
    (this.list.querySelector<HTMLElement>(".rebase-row") ?? this.start).focus();
  }

  serialize(): Json {
    return { base: this.base, repository: this.repository };
  }

  persist(): boolean {
    return false;
  }

  dispose(): void {
    this.store.dispose();
    this.element.remove();
  }
}

function summary(steps: readonly RebaseStep[]): string {
  const count = (a: RebaseAction) => steps.filter((st) => st.action === a).length;
  const parts = REBASE_ACTIONS.filter((a) => a !== "pick" && count(a) > 0).map(
    (a) => `${count(a)} ${a}`,
  );
  return `${steps.length} commit${steps.length === 1 ? "" : "s"}${parts.length ? ` · ${parts.join(", ")}` : ""}`;
}

export function registerRebase(
  sub: DisposableStore,
  services: WorkbenchServices,
  repos: GitRepositories,
): void {
  const { dispatcher, dock, quickInput } = services;
  sub.add(
    dock.views.register({
      type: "gitRebase",
      title: () => "Interactive rebase",
      icon: () => "git-branch",
      singleton: true,
      editorLike: true,
      create: (state, ctx) => {
        const base = stateField(state, "base");
        const named = stateField(state, "repository");
        let git: GitRepo = repos.selected.peek();
        try {
          if (typeof named === "string" && named) git = repos.pick(named);
        } catch {
          // That repository is gone: the selected one.
        }
        return new RebaseView(
          typeof base === "string" ? base : "root",
          services,
          ctx,
          git,
          git.repo.peek()?.root ?? "",
        );
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "git.rebaseInteractive",
      title: "Interactive rebase…",
      category: "Git",
      description:
        'Rewrites the commits after `base` (a commit, branch or "root"). With `steps` (oldest first: {action: pick|reword|edit|squash|fixup|drop, hash, message for reword}) git runs that list as written; without, opens the rebase editor for the user (base picked from the history when missing). A conflict or an edit stop leaves the rebase in progress (git.continueOperation / git.abortOperation). Returns `stopped` when it did.',
      input: s.object({
        base: s.string().describe('Rebase the commits after this one ("root": all)').optional(),
        steps: s
          .array(
            s.object({
              action: s.enum(REBASE_ACTIONS as RebaseAction[]),
              hash: s.string(),
              message: s.string().optional(),
            }),
          )
          .optional(),
        repository: s
          .string()
          .describe(
            "Repository: its root or folder name (git.repositories). Default: the selected one (the user picks when there are several)",
          )
          .optional(),
      }),
      effects: ["write", "destructive"],
      when: "gitRepo",
      agent: "discoverable",
      confirm: ({ steps }) =>
        steps
          ? `Rewrite ${steps.length} commit${steps.length === 1 ? "" : "s"} (${summary(steps as RebaseStep[])})? The old commits stay reachable in the reflog.`
          : "",
      run: async ({ base, steps, repository }, ctx) => {
        const git = await repos.choose(repository, ctx.caller);
        if (!git) return { started: false };
        if (!git.repo.peek()) throw new Error("This folder isn't a git repository.");
        if (git.repoState.peek()?.operation)
          throw new Error("Finish the operation in progress first (Continue or Abort).");
        let target = base;
        if (!target) {
          const branch = git.status.peek()?.branch;
          const log = await git.ipc.log(50);
          const picked = await quickInput.pick(
            [
              ...(branch?.upstream && branch.ahead > 0
                ? [
                    {
                      id: "@{u}",
                      label: `The ${branch.ahead} commit${branch.ahead === 1 ? "" : "s"} not pushed yet`,
                      description: `onto ${branch.upstream}`,
                      icon: "arrow-up" as const,
                    },
                  ]
                : []),
              ...log.slice(1).map((c) => ({
                id: c.hash,
                label: c.subject || "(no message)",
                description: `${c.hash.slice(0, 7)} · ${c.author}, ${blameAge(c.time)}`,
                icon: "git-commit-horizontal" as const,
              })),
              { id: "root", label: "All commits (from the first)", icon: "history" as const },
            ],
            { placeholder: "Rebase the commits after… (pick the base)" },
          );
          if (!picked) return { started: false };
          target = picked.id;
        }
        if (!steps) {
          // One rebase tab, for the base asked for now.
          for (const t of dock.tabs("gitRebase")) await dock.closeTab(t.id, true);
          dock.openView(
            "gitRebase",
            { base: target, repository: git.repo.peek()?.root ?? "" },
            undefined,
            true,
          );
          return { opened: true, base: target };
        }
        const output = await git.ipc.rebaseInteractive(target, steps as RebaseStep[]);
        await git.refresh(true);
        const stopped = git.repoState.peek()?.operation === "rebase";
        services.events.emit("files.didChange", { path: git.repo.peek()?.root ?? "" });
        return { stopped, output: output.trim().slice(-2000) };
      },
    }),
  );
}

// GitHub pull requests and issues (D139) through the user's GitHub CLI (`gh`): no tokens in the
// IDE, `gh auth login` is the sign-in. Commands list, open, check out, create and merge pull
// requests and list issues; a pull request opens in a tab (description, checks, comments,
// Checkout / Open on GitHub / Merge). The status bar shows the current branch's pull request.
// Without gh, or signed out, the commands say how to set it up. D220: each takes `repository`
// (the user picks one when there are several); a pull request tab keeps its repository.

import type { Json } from "../../core/dock/index";
import { h, on, replaceChildren } from "../../core/dom/index";
import type { GhArgs } from "../../core/ipc/git";
import { clipboardIpc, openerIpc } from "../../core/ipc/system";
import { DisposableStore } from "../../core/lifecycle/index";
import { effect, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { icon } from "../../ui/Icon";
import { showMenu } from "../../ui/Menu";
import { renderMarkdown } from "../../ui/markdown/render";
import type { DockView, DockViewContext } from "../../workbench/dock/views";
import { stateField } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { blameAge } from "./cloneBlame";
import type { GitRepo } from "./controller";
import type { GitRepositories } from "./repositories";

export interface PullRequest {
  number: number;
  title: string;
  author: { login: string } | null;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  state: "OPEN" | "CLOSED" | "MERGED";
  url: string;
  updatedAt: string;
  reviewDecision?: string | null;
}

interface Check {
  name?: string;
  context?: string;
  workflowName?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
}

export interface PullRequestDetail extends PullRequest {
  body: string;
  mergeable?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  statusCheckRollup?: Check[] | null;
  comments?: { author: { login: string } | null; body: string; createdAt: string }[];
}

interface Issue {
  number: number;
  title: string;
  author: { login: string } | null;
  labels: { name: string }[];
  state: string;
  url: string;
  updatedAt: string;
}

/** "passing" / "failing" / "pending" / "" for a pull request's checks. */
export function checksSummary(checks: readonly Check[] | null | undefined): {
  state: "" | "passing" | "failing" | "pending";
  passed: number;
  failed: number;
  pending: number;
} {
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const c of checks ?? []) {
    const outcome = (c.conclusion ?? c.state ?? "").toUpperCase();
    const running = (c.status ?? "").toUpperCase();
    if (running && running !== "COMPLETED") pending++;
    else if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(outcome)) passed++;
    else if (outcome === "PENDING" || outcome === "EXPECTED" || outcome === "") pending++;
    else failed++;
  }
  const state = failed ? "failing" : pending ? "pending" : passed ? "passing" : "";
  return { state, passed, failed, pending };
}

const ageOf = (iso: string) => blameAge(Date.parse(iso) / 1000);

class PullRequestView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  /** Listeners of the current rendering (replaced on Refresh). */
  private readonly renderStore = this.store.add(new DisposableStore());
  private readonly body: HTMLElement;
  private detail: PullRequestDetail | null = null;

  constructor(
    private readonly number: number | null,
    private readonly services: WorkbenchServices,
    ctx: DockViewContext,
    private readonly git: GitRepo,
  ) {
    void ctx;
    this.body = h("div", { class: "pr-body" });
    this.element = h("div", { class: "pr-view" }, this.body);
    void this.load();
  }

  title(): string {
    return this.detail ? `#${this.detail.number} ${this.detail.title}` : "Pull request";
  }

  /** Runs a command on this tab's repository. */
  private run(command: string, input: Record<string, unknown> = {}): void {
    void this.services.dispatcher.execute(command, this.withRepo(input)).catch(() => {});
  }

  private withRepo(input: Record<string, unknown>): Record<string, unknown> {
    const repository = this.git.repo.peek()?.root;
    return repository ? { ...input, repository } : input;
  }

  async load(): Promise<void> {
    replaceChildren(this.body, h("div", { class: "pr-muted" }, "Loading pull request…"));
    try {
      this.detail = await this.git.github.json<PullRequestDetail>("prView", {
        ...(this.number !== null && { number: this.number }),
      });
      this.render();
    } catch (err) {
      replaceChildren(
        this.body,
        h("div", { class: "pr-error" }, err instanceof Error ? err.message : String(err)),
      );
    }
  }

  private render(): void {
    const d = this.detail;
    if (!d) return;
    this.renderStore.clear();
    const button = (label: string, cls: string, run: (el: HTMLButtonElement) => void) => {
      const b = h("button", { class: `button ${cls}`, type: "button" }, label);
      this.renderStore.add(on(b, "click", () => run(b)));
      return b;
    };
    const checks = checksSummary(d.statusCheckRollup);
    const state =
      d.isDraft && d.state === "OPEN" ? "Draft" : d.state[0] + d.state.slice(1).toLowerCase();
    const markdown = (host: HTMLElement, text: string) =>
      renderMarkdown(host, text, {
        openLink: (href) => this.run("ui.openLink", { url: href }),
        copy: (t) => void clipboardIpc.writeText(t).catch(() => {}),
        // No remote images (nothing loads from the network by itself): alt text instead.
        image: () => null,
        softBreaks: "br",
      });
    const description = h("div", { class: "md pr-markdown" });
    if (d.body.trim()) markdown(description, d.body);
    else description.append(h("p", { class: "pr-muted" }, "No description."));
    const comments = (d.comments ?? []).map((c) => {
      const text = h("div", { class: "md pr-markdown" });
      markdown(text, c.body);
      return h(
        "div",
        { class: "pr-comment" },
        h(
          "div",
          { class: "pr-comment-head" },
          `${c.author?.login ?? "someone"} · ${ageOf(c.createdAt)}`,
        ),
        text,
      );
    });
    const checkRows = (d.statusCheckRollup ?? []).map((c) => {
      const one = checksSummary([c]).state;
      return h(
        "div",
        { class: `pr-check is-${one || "pending"}` },
        icon(one === "passing" ? "circle-check" : one === "failing" ? "circle-x" : "clock"),
        h("span", {}, c.name ?? c.context ?? "check"),
        c.workflowName ? h("span", { class: "pr-muted" }, c.workflowName) : null,
      );
    });
    replaceChildren(
      this.body,
      h(
        "div",
        { class: "pr-header" },
        h("h1", { class: "pr-title" }, d.title, h("span", { class: "pr-number" }, ` #${d.number}`)),
        h(
          "div",
          { class: "pr-sub" },
          h("span", { class: `pr-state is-${state.toLowerCase()}` }, state),
          h(
            "span",
            {},
            `${d.author?.login ?? "someone"} wants to merge `,
            h("code", {}, d.headRefName),
            " into ",
            h("code", {}, d.baseRefName),
            ` · updated ${ageOf(d.updatedAt)}`,
          ),
        ),
        h(
          "div",
          { class: "pr-stats pr-muted" },
          d.changedFiles !== undefined
            ? `${d.changedFiles} file${d.changedFiles === 1 ? "" : "s"} · +${d.additions ?? 0} −${d.deletions ?? 0}`
            : "",
          d.reviewDecision ? ` · ${d.reviewDecision.toLowerCase().replace(/_/g, " ")}` : "",
          checks.state
            ? ` · checks ${checks.state} (${checks.passed} passed${checks.failed ? `, ${checks.failed} failed` : ""}${checks.pending ? `, ${checks.pending} pending` : ""})`
            : "",
        ),
        h(
          "div",
          { class: "pr-buttons" },
          button("Checkout", "button-primary", () =>
            this.run("github.checkoutPullRequest", { number: d.number }),
          ),
          // D204: the changed files as diffs, with the review threads.
          button("Files changed", "button-secondary", () =>
            this.run("github.pullRequestFiles", { number: d.number }),
          ),
          button(
            "Open on GitHub",
            "button-secondary",
            () => void openerIpc.openUrl(d.url).catch(() => {}),
          ),
          d.state === "OPEN"
            ? button("Merge…", "button-secondary", (el) =>
                showMenu(
                  el,
                  (["merge", "squash", "rebase"] as const).map((method) => ({
                    icon: "git-merge" as const,
                    label:
                      method === "merge"
                        ? "Create a merge commit"
                        : method === "squash"
                          ? "Squash and merge"
                          : "Rebase and merge",
                    run: () =>
                      void this.services.dispatcher
                        .execute(
                          "github.mergePullRequest",
                          this.withRepo({ number: d.number, method }),
                        )
                        .then(() => this.load())
                        .catch(() => {}),
                  })),
                ),
              )
            : null,
          button("Refresh", "button-secondary", () => void this.load()),
        ),
      ),
      h("h2", { class: "pr-section" }, "Description"),
      description,
      ...(checkRows.length ? [h("h2", { class: "pr-section" }, "Checks"), ...checkRows] : []),
      h("h2", { class: "pr-section" }, `Comments (${comments.length})`),
      ...(comments.length ? comments : [h("p", { class: "pr-muted" }, "No comments yet.")]),
    );
  }

  serialize(): Json {
    return { number: this.number, repository: this.git.repo.peek()?.root ?? null };
  }

  dispose(): void {
    this.store.dispose();
    this.element.remove();
  }
}

export function registerGitHub(
  sub: DisposableStore,
  services: WorkbenchServices,
  repos: GitRepositories,
): void {
  const { dispatcher, dock, quickInput, statusBar, notifications } = services;
  /** The selected repository: the status bar's pull request item. */
  const git = repos.current;
  const repository = s
    .string()
    .describe(
      "Repository: its root or folder name (git.repositories). Default: the selected one (the user picks when there are several)",
    )
    .optional();
  const requireRepo = (target: GitRepo) => {
    if (!target.repo.peek()) throw new Error("This folder isn't a git repository.");
  };
  const rootOf = (target: GitRepo) => target.repo.peek()?.root ?? "";
  const list = (target: GitRepo, state: GhArgs["state"] = "open") =>
    target.github.json<PullRequest[]>("prList", { state });

  sub.add(
    dock.views.register({
      type: "githubPullRequest",
      title: (state) => {
        const n = stateField(state, "number");
        return typeof n === "number" ? `Pull request #${n}` : "Pull request";
      },
      icon: () => "git-pull-request",
      editorLike: true,
      create: (state, ctx) => {
        const n = stateField(state, "number");
        const named = stateField(state, "repository");
        let target: GitRepo = repos.selected.peek();
        try {
          if (typeof named === "string" && named) target = repos.pick(named);
        } catch {
          // That repository is gone: the selected one.
        }
        return new PullRequestView(typeof n === "number" ? n : null, services, ctx, target);
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "github.pullRequests",
      title: "Pull requests…",
      category: "GitHub",
      description:
        "Lists the repository's pull requests on GitHub (number, title, author, branches, draft, review state) through the GitHub CLI. For the user, a picker that opens the chosen one.",
      input: s.object({
        state: s.enum(["open", "closed", "merged", "all"] as const).optional(),
        repository,
      }),
      effects: ["read", "network"],
      when: "gitRepo",
      agent: "discoverable",
      run: async ({ state, repository: named }, ctx) => {
        const target = await repos.choose(named, ctx.caller);
        if (!target) return { pullRequests: [] };
        requireRepo(target);
        const prs = await list(target, state ?? "open");
        const brief = prs.map((p) => ({
          number: p.number,
          title: p.title,
          author: p.author?.login ?? null,
          head: p.headRefName,
          base: p.baseRefName,
          draft: p.isDraft,
          state: p.state,
          review: p.reviewDecision ?? null,
          url: p.url,
        }));
        if (ctx.caller.kind !== "user") return { pullRequests: brief };
        if (!prs.length) {
          notifications.show("info", `No ${state ?? "open"} pull requests.`);
          return { pullRequests: [] };
        }
        const picked = await quickInput.pick(
          prs.map((p) => ({
            id: String(p.number),
            label: `#${p.number} ${p.title}`,
            description: `${p.isDraft ? "draft · " : ""}${p.author?.login ?? ""} · ${p.headRefName} → ${p.baseRefName} · ${ageOf(p.updatedAt)}`,
            icon: "git-pull-request" as const,
          })),
          {
            placeholder: "Pick a pull request to open",
            matchOn: (i) => `${i.label} ${i.description ?? ""}`,
          },
        );
        if (picked)
          await ctx.execute("github.openPullRequest", {
            number: Number(picked.id),
            repository: rootOf(target),
          });
        return { pullRequests: brief };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "github.openPullRequest",
      title: "Open pull request",
      category: "GitHub",
      description:
        "Shows a pull request (default: the current branch's) in a tab: description, checks, comments. Agents get its details instead.",
      input: s.object({ number: s.integer({ min: 1 }).optional(), repository }),
      effects: ["read", "network"],
      when: "gitRepo",
      agent: "discoverable",
      run: async ({ number, repository: named }, ctx) => {
        const target = await repos.choose(named, ctx.caller);
        if (!target) return null;
        requireRepo(target);
        if (ctx.caller.kind !== "user") {
          const d = await target.github.json<PullRequestDetail>("prView", number ? { number } : {});
          return {
            ...d,
            checks: checksSummary(d.statusCheckRollup),
            statusCheckRollup: undefined,
          };
        }
        dock.openView(
          "githubPullRequest",
          { number: number ?? null, repository: rootOf(target) },
          undefined,
          true,
        );
        return { opened: number ?? "current branch" };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "github.checkoutPullRequest",
      title: "Checkout pull request…",
      category: "GitHub",
      description: "Checks out a pull request's branch locally (`gh pr checkout`).",
      input: s.object({ number: s.integer({ min: 1 }).optional(), repository }),
      effects: ["write", "network"],
      when: "gitRepo",
      run: async ({ number, repository: named }, ctx) => {
        const git = await repos.choose(named, ctx.caller);
        if (!git) return { checkedOut: null };
        requireRepo(git);
        let n = number;
        if (!n) {
          const prs = await list(git);
          const picked = await quickInput.pick(
            prs.map((p) => ({
              id: String(p.number),
              label: `#${p.number} ${p.title}`,
              description: `${p.headRefName} · ${p.author?.login ?? ""}`,
              icon: "git-pull-request" as const,
            })),
            { placeholder: "Pick a pull request to check out" },
          );
          if (!picked) return { checkedOut: null };
          n = Number(picked.id);
        }
        git.busy.value = `Checking out #${n}…`;
        try {
          await git.github.run("prCheckout", { number: n });
        } finally {
          git.busy.value = null;
        }
        await git.refresh(true);
        services.events.emit("files.didChange", { path: git.repo.peek()?.root ?? "" });
        return { checkedOut: n, branch: git.status.peek()?.branch.head ?? null };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "github.createPullRequest",
      title: "Create pull request…",
      category: "GitHub",
      description:
        "Opens a pull request for the current branch (publishing it first if it has no upstream). `title` defaults to the last commit's subject; `base` to the repository's default branch.",
      input: s.object({
        title: s.string().optional(),
        body: s.string().optional(),
        base: s.string().optional(),
        draft: s.boolean().optional(),
        repository,
      }),
      effects: ["write", "network"],
      when: "gitRepo",
      agent: "discoverable",
      run: async ({ title, body, base, draft, repository: named }, ctx) => {
        const git = await repos.choose(named, ctx.caller);
        if (!git) return { created: null };
        requireRepo(git);
        const branch = git.status.peek()?.branch;
        if (!branch?.head) throw new Error("Check out a branch first (HEAD is detached).");
        let t = title;
        let isDraft = draft;
        if (!t && ctx.caller.kind === "user") {
          const last = await git.ipc.log(1).catch(() => []);
          t = await quickInput.prompt({
            prompt: `Title of the pull request for "${branch.head}"`,
            value: last[0]?.subject ?? branch.head,
            validate: (v) => (v.trim() ? undefined : "The pull request needs a title"),
          });
          if (!t) return { created: null };
          if (isDraft === undefined) {
            const kind = await quickInput.pick(
              [
                { id: "ready", label: "Create pull request" },
                { id: "draft", label: "Create draft pull request" },
              ],
              { placeholder: t },
            );
            if (!kind) return { created: null };
            isDraft = kind.id === "draft";
          }
        }
        if (!t) throw new Error("Give the pull request a `title`.");
        if (!branch.upstream || branch.ahead > 0)
          await ctx.execute("git.push", { repository: rootOf(git) });
        git.busy.value = "Creating pull request…";
        let out: string;
        try {
          out = await git.github.run("prCreate", {
            title: t,
            body: body ?? "",
            ...(base && { base }),
            ...(isDraft && { draft: true }),
          });
        } finally {
          git.busy.value = null;
        }
        const url = out.match(/https:\/\/\S+\/pull\/\d+/)?.[0] ?? null;
        const number = url ? Number(url.slice(url.lastIndexOf("/") + 1)) : null;
        prCache.clear();
        refreshPrItem();
        services.events.emit("github.didCreatePullRequest", {
          number,
          url,
          title: t,
          caller: ctx.caller,
        });
        if (ctx.caller.kind === "user")
          notifications.show("info", `Created pull request${number ? ` #${number}` : ""}.`, {
            actions: [
              ...(number
                ? [
                    {
                      label: "Open",
                      run: () =>
                        void ctx
                          .execute("github.openPullRequest", { number, repository: rootOf(git) })
                          .catch(() => {}),
                    },
                  ]
                : []),
              ...(url
                ? [
                    {
                      label: "Open on GitHub",
                      run: () => void openerIpc.openUrl(url).catch(() => {}),
                    },
                  ]
                : []),
            ],
          });
        return { created: number, url };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "github.mergePullRequest",
      title: "Merge pull request",
      category: "GitHub",
      description: "Merges a pull request on GitHub with `method` (merge, squash or rebase).",
      input: s.object({
        number: s.integer({ min: 1 }),
        method: s.enum(["merge", "squash", "rebase"] as const).optional(),
        repository,
      }),
      effects: ["write", "network", "destructive"],
      when: "gitRepo",
      confirm: ({ number, method }) =>
        `Merge pull request #${number} on GitHub (${method ?? "merge"})? Everyone sees it right away.`,
      run: async ({ number, method, repository: named }, ctx) => {
        const target = await repos.choose(named, ctx.caller);
        if (!target) return { merged: null };
        await target.github.run("prMerge", { number, method: method ?? "merge" });
        prCache.clear();
        refreshPrItem();
        return { merged: number };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "github.issues",
      title: "Issues…",
      category: "GitHub",
      description:
        "Lists the repository's GitHub issues (number, title, author, labels). For the user, a picker that opens the chosen one on GitHub.",
      input: s.object({
        state: s.enum(["open", "closed", "all"] as const).optional(),
        repository,
      }),
      effects: ["read", "network"],
      when: "gitRepo",
      agent: "discoverable",
      run: async ({ state, repository: named }, ctx) => {
        const target = await repos.choose(named, ctx.caller);
        if (!target) return { issues: [] };
        requireRepo(target);
        const issues = await target.github.json<Issue[]>("issueList", { state: state ?? "open" });
        const brief = issues.map((i) => ({
          number: i.number,
          title: i.title,
          author: i.author?.login ?? null,
          labels: i.labels.map((l) => l.name),
          url: i.url,
        }));
        if (ctx.caller.kind !== "user") return { issues: brief };
        const picked = await quickInput.pick(
          issues.map((i) => ({
            id: i.url,
            label: `#${i.number} ${i.title}`,
            description: `${i.labels.map((l) => l.name).join(", ")}${i.labels.length ? " · " : ""}${i.author?.login ?? ""} · ${ageOf(i.updatedAt)}`,
            icon: "circle-dot" as const,
          })),
          { placeholder: issues.length ? "Pick an issue to open on GitHub" : "No open issues" },
        );
        if (picked) await openerIpc.openUrl(picked.id);
        return { issues: brief };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "github.authStatus",
      title: "Check GitHub sign-in",
      category: "GitHub",
      description: "Whether the GitHub CLI is installed and signed in (`gh auth status`).",
      input: s.empty(),
      effects: ["read", "network"],
      run: async (_input, ctx) => {
        const text = await git.github.run("authStatus");
        if (ctx.caller.kind === "user")
          notifications.show("info", text.split("\n").slice(0, 3).join(" "));
        return { status: text };
      },
    }),
  );

  // The current branch's pull request in the status bar: per repository and branch, asked again
  // after a few minutes (checks change) and on window focus once stale; a failed lookup (gh
  // missing, offline) is retried later too.
  const PR_TTL_MS = 3 * 60_000;
  const prCache = new Map<string, { at: number; pr: PullRequestDetail | null }>();
  const current = signal<PullRequestDetail | null>(null);
  let asking = "";
  const refreshPrItem = () => {
    const head = git.status.peek()?.branch.head;
    const root = git.repo.peek()?.root;
    const enabled =
      services.settings.peek<boolean | undefined>("github.statusBar.enabled") !== false;
    if (!head || !root || !enabled || !git.repoState.peek()?.remotes.length) {
      current.value = null;
      return;
    }
    const key = `${root}\n${head}`;
    const cached = prCache.get(key);
    if (cached) current.value = cached.pr;
    else current.value = null;
    if ((cached && Date.now() - cached.at < PR_TTL_MS) || asking === key) return;
    asking = key;
    void git.github
      .json<PullRequestDetail>("prView", {})
      .then(
        (d) => (d.headRefName === head ? d : null),
        () => null,
      )
      .then((pr) => {
        prCache.set(key, { at: Date.now(), pr });
        if (asking === key) asking = "";
        if (git.repo.peek()?.root === root && git.status.peek()?.branch.head === head)
          current.value = pr;
      });
  };
  sub.add(
    effect(() => {
      git.status.value?.branch.head;
      git.repo.value;
      git.repoState.value;
      refreshPrItem();
      return undefined;
    }),
  );
  const onFocus = () => refreshPrItem();
  window.addEventListener("focus", onFocus);
  sub.add({ dispose: () => window.removeEventListener("focus", onFocus) });
  sub.add(
    statusBar.add({
      id: "github.pullRequest",
      name: "Pull request",
      alignment: "left",
      priority: 88,
      text: () => {
        const d = current.value;
        if (!d) return "";
        const checks = checksSummary(d.statusCheckRollup).state;
        const mark =
          checks === "failing" ? " $(circle-x)" : checks === "pending" ? " $(clock)" : "";
        return `$(git-pull-request) #${d.number}${mark}`;
      },
      tooltip: () => {
        const d = current.value;
        return d ? `#${d.number} ${d.title} (${d.state.toLowerCase()}) · Open pull request` : "";
      },
      command: "github.openPullRequest",
      // The selected repository's (the item shows its pull request): no picker.
      get input() {
        const root = git.repo.peek()?.root;
        return root ? { repository: root } : {};
      },
    }),
  );
}

// GitHub review (D204, like VS Code's GitHub Pull Requests extension), through the user's `gh`
// sign-in: a pull request's changed files in a tab, each opening as a diff of the merge base ↔
// the pull request's head (contents from the local repository when it has the commits, else
// `gh api`); its review threads in that tab with Reply and Resolve, and as marks in the margin
// of the checked-out files (the hover shows the thread). GitHub notifications are the Git tools
// extension's (D208).
import type { Json } from "../../core/dock/index";
import { h, on, replaceChildren } from "../../core/dom/index";
import { openerIpc } from "../../core/ipc/system";
import { DisposableStore } from "../../core/lifecycle/index";
import { basename, pathKey, resolveInRoot } from "../../core/paths/index";
import { effect, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { fileIcon, icon } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import type { DockView, DockViewContext } from "../../workbench/dock/views";
import { stateField } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { blameAge } from "./cloneBlame";
import type { GitController } from "./controller";
import { type ReviewThread, threadLine, threadSummary, threadsByPath, threadsOf } from "./lens";
import type { GitRepositories } from "./repositories";

/** A file of a pull request (`gh api …/pulls/N/files`). */
export interface PullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  previous_filename?: string;
}

interface PullRequestMeta {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  baseRefOid: string;
  state: string;
}

const STATUS_LETTERS: Record<string, string> = {
  added: "A",
  removed: "D",
  modified: "M",
  renamed: "R",
  copied: "C",
  changed: "M",
};

interface Review {
  number: number;
  meta: PullRequestMeta;
  /** The commit the diff starts from (the merge base, else the base's tip). */
  baseSha: string;
  files: PullRequestFile[];
  threads: ReviewThread[];
  root: string;
  /**
   * The repository it was loaded from: replies, comments and marks go there, not to whichever
   * repository is selected by then (another repository's pull request with the same number).
   */
  git: GitController;
}

const isHash = (v: string) => /^[0-9a-f]{7,40}$/i.test(v);

class PullRequestFilesView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly rows = this.store.add(new DisposableStore());
  private readonly body: HTMLElement;

  constructor(
    private readonly number: number,
    private readonly services: WorkbenchServices,
    private readonly review: () => Review | null,
    private readonly loading: () => boolean,
    subscribe: (fn: () => void) => () => void,
  ) {
    this.body = h("div", { class: "pr-body" });
    this.element = h("div", { class: "pr-view pr-files-view" }, this.body);
    const unsubscribe = subscribe(() => this.render());
    this.store.add({ dispose: unsubscribe });
    this.render();
  }

  private run(command: string, input: unknown): void {
    void this.services.dispatcher.execute(command, input).catch((err: unknown) => {
      this.services.notifications.show("error", err instanceof Error ? err.message : String(err));
    });
  }

  private render(): void {
    this.rows.clear();
    const r = this.review();
    if (!r || r.number !== this.number) {
      replaceChildren(
        this.body,
        h(
          "div",
          { class: "pr-muted" },
          this.loading() ? "Loading the pull request's files…" : "Not loaded.",
        ),
      );
      return;
    }
    const byPath = threadsByPath(r.threads);
    const button = (label: string, cls: string, run: () => void) => {
      const b = h("button", { class: `button ${cls}`, type: "button" }, label);
      this.rows.add(on(b, "click", run));
      return b;
    };
    const fileRow = (f: PullRequestFile) => {
      const threads = byPath.get(f.filename) ?? [];
      const open = h(
        "button",
        { class: "pr-file", type: "button", "data-path": f.filename },
        fileIcon(basename(f.filename)),
        h("span", { class: "pr-file-name" }, f.filename),
        h("span", { class: "pr-file-status" }, STATUS_LETTERS[f.status] ?? f.status),
        h("span", { class: "pr-file-stat" }, `+${f.additions} −${f.deletions}`),
        threads.length
          ? h(
              "span",
              { class: "pr-file-threads" },
              icon("message-square-code"),
              String(threads.length),
            )
          : null,
      );
      setTooltip(
        open,
        `${f.previous_filename ? `${f.previous_filename} → ` : ""}${f.filename} · open the diff`,
      );
      this.rows.add(
        on(open, "click", () =>
          this.run("github.openPullRequestFile", {
            number: r.number,
            path: f.filename,
            ...(r.root && { repository: r.root }),
          }),
        ),
      );
      const threadEls = threads.map((t) => {
        const first = t.comments.nodes[0];
        const line = threadLine(t);
        return h(
          "div",
          { class: `pr-thread${t.isResolved ? " is-resolved" : ""}`, "data-thread": t.id },
          h(
            "div",
            { class: "pr-thread-head" },
            `${line ? `Line ${line}` : "File"} · ${first?.author?.login ?? "someone"}${first ? ` · ${blameAge(Date.parse(first.createdAt) / 1000)}` : ""}${t.isResolved ? " · resolved" : ""}${t.isOutdated ? " · outdated" : ""}`,
          ),
          ...t.comments.nodes.map((c) =>
            h(
              "div",
              { class: "pr-thread-comment" },
              h("span", { class: "pr-thread-author" }, `${c.author?.login ?? "someone"}: `),
              c.body,
            ),
          ),
          h(
            "div",
            { class: "pr-thread-actions" },
            button("Reply", "button-ghost button-sm", () =>
              this.run("github.replyToReviewThread", {
                number: r.number,
                thread: t.id,
                ...(r.root && { repository: r.root }),
              }),
            ),
            button(t.isResolved ? "Unresolve" : "Resolve", "button-ghost button-sm", () =>
              this.run("github.resolveReviewThread", {
                number: r.number,
                thread: t.id,
                resolved: !t.isResolved,
                ...(r.root && { repository: r.root }),
              }),
            ),
            line
              ? button("Go to line", "button-ghost button-sm", () =>
                  this.run("editor.openFile", { path: resolveInRoot(r.root, t.path), line }),
                )
              : null,
          ),
        );
      });
      return h("div", { class: "pr-file-block" }, open, ...threadEls);
    };
    const unresolved = r.threads.filter((t) => !t.isResolved).length;
    replaceChildren(
      this.body,
      h(
        "div",
        { class: "pr-header" },
        h(
          "h1",
          { class: "pr-title" },
          r.meta.title,
          h("span", { class: "pr-number" }, ` #${r.number}`),
        ),
        h(
          "div",
          { class: "pr-sub pr-muted" },
          h("code", {}, r.meta.headRefName),
          " → ",
          h("code", {}, r.meta.baseRefName),
          ` · ${r.files.length} file${r.files.length === 1 ? "" : "s"} · ${r.threads.length} review thread${r.threads.length === 1 ? "" : "s"}${unresolved ? ` (${unresolved} unresolved)` : ""}`,
        ),
        h(
          "div",
          { class: "pr-buttons" },
          // From the repository it was loaded from, not whichever is selected now (D207).
          button("Refresh", "button-secondary", () =>
            this.run("github.pullRequestFiles", {
              number: r.number,
              ...(r.root && { repository: r.root }),
            }),
          ),
          button("Overview", "button-secondary", () =>
            this.run("github.openPullRequest", {
              number: r.number,
              ...(r.root && { repository: r.root }),
            }),
          ),
          button(
            "Open on GitHub",
            "button-secondary",
            () => void openerIpc.openUrl(`${r.meta.url}/files`).catch(() => {}),
          ),
        ),
      ),
      h("h2", { class: "pr-section" }, "Files changed"),
      ...r.files.map(fileRow),
    );
  }

  title(): string {
    return `#${this.number} files`;
  }
  serialize(): Json {
    return { number: this.number };
  }
  dispose(): void {
    this.store.dispose();
    this.element.remove();
  }
}

export function registerGitHubReview(
  sub: DisposableStore,
  services: WorkbenchServices,
  repos: GitRepositories,
): void {
  const { dispatcher, dock, quickDiff, gutterMarks, quickInput, state } = services;
  const review = signal<Review | null>(null);
  const loading = signal(false);
  const renders = new Set<() => void>();
  sub.add(
    effect(() => {
      review.value;
      loading.value;
      for (const fn of renders) fn();
      return undefined;
    }),
  );
  const requireRepo = (): GitController => {
    const git = repos.selected.peek();
    if (!git.repo.peek()) throw new Error("This folder isn't a git repository.");
    return git;
  };

  // The pull request's file contents at a commit: local first, else GitHub ("ghpr:<sha>").
  const contents = new Map<string, Promise<string | null>>();
  sub.add({ dispose: () => contents.clear() });
  sub.add(
    quickDiff.registerContent("ghpr:", (path, scheme) => {
      const spec = scheme.slice("ghpr:".length);
      const at = spec.indexOf("@");
      const sha = at < 0 ? spec : spec.slice(0, at);
      const r = review.peek();
      const git = repos.forPath(path) ?? repos.selected.peek();
      const root = git.repo.peek()?.root ?? r?.root ?? "";
      const rel =
        at < 0
          ? path
              .slice(root.length)
              .replace(/^[\\/]+/, "")
              .replaceAll("\\", "/")
          : spec.slice(at + 1);
      if (!isHash(sha) || !rel) return Promise.resolve(null);
      const key = `${sha}:${rel}`;
      let p = contents.get(key);
      if (!p) {
        if (contents.size > 300) contents.clear();
        p = git.ipc
          .show(sha, rel)
          .catch(() => null)
          .then((local) =>
            local !== null
              ? local
              : git.github.run("fileAt", { path: rel, rev: sha }).catch(() => null),
          );
        contents.set(key, p);
      }
      return p;
    }),
  );

  /** Review comment marks in the margin of the checked-out files of the pull request. */
  const showMarks = () => {
    const r = review.peek();
    const branch = r?.git.status.peek()?.branch.head;
    const byPath = new Map<string, { line: number; className: string; hover: string }[]>();
    if (r && branch === r.meta.headRefName) {
      for (const t of r.threads) {
        const line = threadLine(t);
        if (!line || t.isOutdated) continue;
        const abs = resolveInRoot(r.root, t.path);
        const list = byPath.get(abs) ?? [];
        list.push({
          line,
          className: `review-comment-mark${t.isResolved ? " is-resolved" : ""}`,
          hover: threadSummary(t),
        });
        byPath.set(abs, list);
      }
    }
    const keyed = new Map<string, { line: number; className: string; hover: string }[]>();
    for (const [p, list] of byPath) keyed.set(pathKey(p), list);
    gutterMarks.set("github.review", keyed);
  };
  sub.add(
    effect(() => {
      review.value?.git.status.value?.branch.head;
      showMarks();
      return undefined;
    }),
  );
  sub.add({ dispose: () => gutterMarks.set("github.review", new Map()) });

  const load = async (number?: number, from?: GitController): Promise<Review> => {
    const git = from ?? requireRepo();
    const root = git.repo.peek()?.root ?? "";
    loading.value = true;
    try {
      const meta = await git.github.json<PullRequestMeta>("prMeta", number ? { number } : {});
      const [files, threadsReply, baseSha] = await Promise.all([
        git.github.json<PullRequestFile[]>("prFiles", { number: meta.number }),
        git.github.json<unknown>("prThreads", { number: meta.number }).catch(() => null),
        isHash(meta.baseRefOid) && isHash(meta.headRefOid)
          ? git.github
              .run("compareBase", { rev: meta.baseRefOid, head: meta.headRefOid })
              .then((s) => (isHash(s.trim()) ? s.trim() : meta.baseRefOid))
              .catch(() => meta.baseRefOid)
          : Promise.resolve(meta.baseRefOid),
      ]);
      const r: Review = {
        number: meta.number,
        meta,
        baseSha,
        files: Array.isArray(files) ? files : [],
        threads: threadsOf(threadsReply),
        root,
        git,
      };
      review.value = r;
      return r;
    } finally {
      loading.value = false;
    }
  };
  /**
   * The pull request a review command acts on (D220): the loaded one when it matches; else
   * `number` from `repository`, or — with only a number — from the repository of the pull
   * request under review (the one the user is looking at), else the selected one.
   */
  const ensure = async (number?: number, repository?: string) => {
    const r = review.peek();
    const named = repository ? repos.pick(repository) : undefined;
    if (r && (number === undefined || r.number === number) && (!named || named === r.git)) return r;
    return load(number, named ?? r?.git);
  };
  const repositoryInput = s
    .string()
    .describe(
      "Repository root or name (git.repositories); default: the pull request's under review, else the selected one",
    )
    .optional();

  sub.add(
    dock.views.register({
      type: "githubPullRequestFiles",
      title: (st) => {
        const n = stateField(st, "number");
        return typeof n === "number" ? `#${n} files` : "Pull request files";
      },
      icon: () => "git-pull-request",
      editorLike: true,
      create: (st, _ctx: DockViewContext) => {
        const n = stateField(st, "number");
        const number = typeof n === "number" ? n : 0;
        const repository = stateField(st, "repository");
        const view = new PullRequestFilesView(
          number,
          services,
          () => review.peek(),
          () => loading.peek(),
          (fn) => {
            renders.add(fn);
            return () => renders.delete(fn);
          },
        );
        // A restored tab loads its pull request again (from its own repository).
        if (number && review.peek()?.number !== number)
          void Promise.resolve()
            .then(() =>
              load(number, typeof repository === "string" ? repos.pick(repository) : undefined),
            )
            .catch(() => {});
        return view;
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "github.pullRequestFiles",
      title: "Pull request files changed",
      category: "GitHub",
      description:
        "A pull request's changed files (default: the current branch's) with their review threads, in a tab; each file opens as a diff (merge base ↔ the pull request's head). Also marks the review comments in the margin of the checked-out files. Returns the files and threads. `repository`: which repository's pull request (its root or name; default: the selected one).",
      input: s.object({
        number: s.integer({ min: 1 }).optional(),
        repository: s
          .string()
          .describe("Repository root or name (git.repositories); default: the selected one")
          .optional(),
        open: s.boolean().describe("Show the tab (always when the user runs it)").optional(),
      }),
      effects: ["read", "network"],
      when: "gitRepo",
      agent: "discoverable",
      run: async ({ number, open, repository }, ctx) => {
        const r = await load(number, repository ? repos.pick(repository) : undefined);
        if (open || ctx.caller.kind === "user") {
          const existing = dock
            .tabs("githubPullRequestFiles")
            .find((t) => stateField(t.viewState, "number") === r.number);
          if (existing) dock.activateTab(existing.id, true);
          else
            dock.openView(
              "githubPullRequestFiles",
              { number: r.number, ...(r.root && { repository: r.root }) },
              undefined,
              true,
            );
        }
        return {
          number: r.number,
          title: r.meta.title,
          base: r.baseSha,
          head: r.meta.headRefOid,
          files: r.files.map((f) => ({
            path: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
          })),
          threads: r.threads.map((t) => ({
            id: t.id,
            path: t.path,
            line: threadLine(t),
            resolved: t.isResolved,
            outdated: t.isOutdated,
            comments: t.comments.nodes.map((c) => ({
              id: c.databaseId,
              author: c.author?.login ?? null,
              body: c.body,
            })),
          })),
        };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "github.openPullRequestFile",
      title: "Open pull request file diff",
      category: "GitHub",
      description:
        "Opens one file of a pull request as a diff: the merge base ↔ the pull request's head (read-only).",
      input: s.object({
        number: s.integer({ min: 1 }).optional(),
        path: s.string(),
        repository: repositoryInput,
      }),
      effects: ["read", "network"],
      when: "gitRepo",
      run: async ({ number, path, repository }, ctx) => {
        const r = await ensure(number, repository);
        const f = r.files.find((x) => x.filename === path || x.previous_filename === path);
        if (!f) throw new Error(`#${r.number} doesn't change ${path}.`);
        const before = f.previous_filename ?? f.filename;
        await ctx.execute("editor.openDiff", {
          path: resolveInRoot(r.root, f.filename),
          base: `ghpr:${r.baseSha}@${before}`,
          baseLabel: `${r.meta.baseRefName} (merge base)`,
          head: `ghpr:${r.meta.headRefOid}@${f.filename}`,
          headLabel: `#${r.number}`,
        });
        return { opened: f.filename };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "github.replyToReviewThread",
      title: "Reply to review comment",
      category: "GitHub",
      description:
        "Replies to a pull request review thread (`thread`: its id from github.pullRequestFiles) with `body` (asked for when missing).",
      input: s.object({
        number: s.integer({ min: 1 }).optional(),
        thread: s.string(),
        body: s.string().optional(),
        repository: repositoryInput,
      }),
      effects: ["write", "network"],
      when: "gitRepo",
      agent: "discoverable",
      run: async ({ number, thread, body, repository }, ctx) => {
        const r = await ensure(number, repository);
        const t = r.threads.find((x) => x.id === thread);
        const last = t?.comments.nodes[t.comments.nodes.length - 1] ?? t?.comments.nodes[0];
        if (!t || !last) throw new Error("There is no such review thread.");
        let text = body;
        if (text === undefined && ctx.caller.kind === "user")
          text = await quickInput.prompt({
            prompt: `Reply to ${last.author?.login ?? "the thread"} on ${t.path}`,
            placeholder: "Your reply (Markdown)",
          });
        if (!text?.trim()) return { replied: false };
        await r.git.github.run("prReply", {
          number: r.number,
          comment: t.comments.nodes[0]?.databaseId ?? last.databaseId,
          body: text,
        });
        await load(r.number, r.git);
        return { replied: true };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "github.resolveReviewThread",
      title: "Resolve review thread",
      category: "GitHub",
      description:
        "Marks a pull request review thread resolved (or, with `resolved: false`, unresolved).",
      input: s.object({
        number: s.integer({ min: 1 }).optional(),
        thread: s.string(),
        resolved: s.boolean().optional(),
        repository: repositoryInput,
      }),
      effects: ["write", "network"],
      when: "gitRepo",
      agent: "discoverable",
      run: async ({ number, thread, resolved, repository }) => {
        const r = review.peek();
        const named = repository ? repos.pick(repository) : undefined;
        const mine =
          r && (number === undefined || r.number === number) && (!named || named === r.git)
            ? r
            : null;
        // A thread id is global on GitHub, but `gh` runs in a repository: the one named, else the
        // reviewed pull request's, else the selected one.
        await (named ?? mine?.git ?? r?.git ?? requireRepo()).github.run("prResolve", {
          thread,
          resolved: resolved !== false,
        });
        if (mine) await load(mine.number, mine.git);
        return { thread, resolved: resolved !== false };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "github.addReviewComment",
      title: "Add review comment",
      category: "GitHub",
      description:
        "Comments on a line of a pull request's file (its head version; default: the current branch's pull request, the active editor's line). `body` is asked for when missing.",
      input: s.object({
        number: s.integer({ min: 1 }).optional(),
        path: s.string().describe("Repository-relative file").optional(),
        line: s.integer({ min: 1 }).optional(),
        body: s.string().optional(),
        repository: repositoryInput,
      }),
      effects: ["write", "network"],
      when: "gitRepo",
      run: async ({ number, path, line, body, repository }, ctx) => {
        const r = await ensure(number, repository);
        let file = path;
        let at = line;
        if (!file || !at) {
          const active = (await state.get("ide://editors/active")).value as {
            absolutePath?: string | null;
            cursor?: { line: number };
          } | null;
          if (!file && active?.absolutePath)
            file = active.absolutePath
              .slice(r.root.length)
              .replace(/^[\\/]+/, "")
              .replaceAll("\\", "/");
          at ??= active?.cursor?.line;
        }
        if (!file || !at) throw new Error("Open a file of the pull request first.");
        let text = body;
        if (text === undefined && ctx.caller.kind === "user")
          text = await quickInput.prompt({
            prompt: `Comment on ${file}:${at}`,
            placeholder: "Markdown",
          });
        if (!text?.trim()) return { commented: false };
        await r.git.github.run("prComment", {
          number: r.number,
          path: file,
          line: at,
          rev: r.meta.headRefOid,
          body: text,
        });
        await load(r.number, r.git);
        return { commented: true, path: file, line: at };
      },
    }),
  );

  sub.add(
    state.register("ide://github/review", {
      description:
        "The pull request under review (github.pullRequestFiles): number, files, review threads (path, line, resolved).",
      get: () => {
        const r = review.peek();
        return {
          pullRequest: r && {
            number: r.number,
            title: r.meta.title,
            files: r.files.map((f) => f.filename),
            threads: r.threads.map((t) => ({
              id: t.id,
              path: t.path,
              line: threadLine(t),
              resolved: t.isResolved,
              comments: t.comments.nodes.length,
            })),
          },
        };
      },
    }),
  );
}

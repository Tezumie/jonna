// Built-in Git: the source control view, status-bar branch and sync items, file decorations,
// quick-diff base texts (editor change bars, diff tabs) and git.* commands. Git itself is the
// user's CLI, driven from Rust (src-tauri/src/git). D204: several repositories in one folder
// (repositories.ts), the merge editor's stage texts and GitHub review; D208: read-only git for
// extensions (access.ts) — the GitLens-style views (blame gutter, line history, compare,
// stashes, GitHub notifications) are the bundled Git tools extension's.
// State: ide://git/status, ide://git/problem, ide://git/repositories.

import { Emitter } from "../../core/events/index";
import type { BuiltinExtension } from "../../core/extensions/index";
import { MutableDisposable } from "../../core/lifecycle/index";
import { relativePath } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { registerGitAccess } from "./access";
import { registerAskpass } from "./askpass";
import { registerAutofetch } from "./autofetch";
import { registerChangesTabs } from "./changesTab";
import { registerCloneAndBlame } from "./cloneBlame";
import { registerGitCommands } from "./commands";
import type { GitController } from "./controller";
import manifest from "./extension.json";
import { registerFileHistory } from "./fileHistory";
import { registerGitHub } from "./github";
import { registerGitHubReview } from "./githubReview";
import { registerGraph } from "./graphCommands";
import { registerMultiDiffFollow } from "./multiDiffFollow";
import { registerPublish } from "./publish";
import { registerRebase } from "./rebase";
import { GitRepositories } from "./repositories";
import { registerStashCommands } from "./stash";
import { ScmView } from "./view";
import { registerGitWorkflow } from "./workflow";
import { registerWorktreeCommands } from "./worktrees";

export const gitExtension: BuiltinExtension<WorkbenchServices> = {
  manifest,
  activate({ subscriptions: sub, services }) {
    const { dispatcher, views, state, statusBar, context } = services;
    const repos = sub.add(new GitRepositories(services));
    // The selected repository: views, the status bar and commands without `repository`.
    const git = repos.current;
    let view: ScmView | undefined;
    // One commit message per repository (VS Code keeps each repository's box).
    const texts = new Map<string, string>();
    const keyOf = (r?: GitController) => (r ?? repos.selected.peek()).repo.peek()?.root ?? "";
    const changed = sub.add(new Emitter<void>());
    const message = {
      get: (r?: GitController) => texts.get(keyOf(r)) ?? "",
      set: (value: string, r?: GitController) => {
        texts.set(keyOf(r), value);
        changed.fire();
      },
      onChange: (fn: () => void) => changed.event(fn),
    };
    sub.add(
      effect(() => {
        repos.selected.value;
        changed.fire();
        return undefined;
      }),
    );

    sub.add(
      effect(() => {
        context.set("gitRepo", git.repo.value !== null);
        return undefined;
      }),
    );
    // Push, pull, commit, checkout…: the Source control view's progress line, or a busy mark on
    // its activity-bar icon when another view is shown (D118). Status refreshes are quick and
    // stay under the line's delay.
    const gitProgress = sub.add(new MutableDisposable());
    sub.add(
      effect(() => {
        const busy = git.busy.value;
        gitProgress.value = busy === null ? undefined : views.progress("scm.view", busy);
        return undefined;
      }),
    );

    // Source control's activity badge: every pending change (staged, unstaged, conflicts), like
    // VS Code's scm.countBadge "all" (D134).
    sub.add(
      effect(() => {
        let n = 0;
        for (const r of repos.all.value) {
          const g = r.groups.value;
          n += g.staged.length + g.changes.length + g.merge.length;
        }
        // Extensions' source controls count too (D233).
        n += services.extensionFeatures.sourceControls.count();
        views.setBadge("scm.view", n, n === 1 ? "1 pending change" : `${n} pending changes`);
        return undefined;
      }),
    );

    sub.add(
      views.register({
        id: "scm.view",
        title: "Source control",
        icon: "git-branch",
        command: "git.showView",
        actions: [
          { command: "git.commit", icon: "check", title: "Commit" },
          { command: "git.refresh", icon: "refresh-cw", title: "Refresh" },
          { command: "git.pull", icon: "arrow-down", title: "Pull" },
          { command: "git.push", icon: "arrow-up", title: "Push" },
          { command: "git.checkout", icon: "git-branch", title: "Checkout branch…" },
        ],
        create(host) {
          view = new ScmView(host, services, git, message, repos);
          return view;
        },
      }),
    );
    // The Graph: its own resizable section below Changes (D210).
    registerGraph(sub, services, git);

    sub.add(
      dispatcher.register({
        id: "git.showView",
        title: "Show source control",
        category: "Git",
        description: "Shows the source control view and focuses the commit message box.",
        input: s.empty(),
        effects: [],
        agent: "hidden",
        run: async (_input, ctx) => {
          await ctx.execute("view.show", { id: "scm.view" });
          view?.focus();
        },
      }),
    );

    registerGitCommands(sub, services, repos, message);
    registerChangesTabs(sub, services, repos);
    registerMultiDiffFollow(sub, services, repos);
    registerAutofetch(sub, services, repos.all);

    sub.add(
      dispatcher.register({
        id: "git.sync",
        title: "Sync (pull, then push)",
        category: "Git",
        description:
          "Pulls (fast-forward) when behind, then pushes when ahead or unpublished; with no remote at all, publishes to GitHub (git.publish).",
        input: s.object({
          repository: s
            .string()
            .describe(
              "Repository: its root or folder name (git.repositories). Default: the selected one",
            )
            .optional(),
        }),
        effects: ["write", "network"],
        when: "gitRepo",
        run: async ({ repository: named }, ctx) => {
          const target = repos.pick(named);
          const repository = target.repo.peek()?.root ?? "";
          const b = target.status.peek()?.branch;
          if (b?.upstream && b.behind > 0) await ctx.execute("git.pull", { repository });
          const now = target.status.peek()?.branch;
          // Nowhere to push to yet: publish to GitHub (VS Code's Publish branch; the folder's
          // own repository).
          if (!now?.upstream && !target.repoState.peek()?.remotes.length) {
            if (target !== repos.primary)
              throw new Error(`${target.name} has no remote: add one first (git.addRemote).`);
            await ctx.execute("git.publish", {});
            return { published: true };
          }
          if (!now?.upstream || now.ahead > 0) await ctx.execute("git.push", { repository });
          return {
            ahead: target.status.peek()?.branch.ahead ?? 0,
            behind: target.status.peek()?.branch.behind ?? 0,
          };
        },
      }),
    );

    registerCloneAndBlame(sub, services, repos);
    registerStashCommands(sub, services, repos);
    registerFileHistory(sub, services, repos);
    // Read-only git for extensions (D208): the Git tools extension's views are built on it.
    registerGitAccess(sub, services, repos);
    registerGitWorkflow(sub, services, repos, message);
    registerWorktreeCommands(sub, services, repos);
    registerRebase(sub, services, repos);
    registerGitHub(sub, services, repos);
    registerGitHubReview(sub, services, repos);
    registerPublish(sub, services, repos.primary);
    registerAskpass(services);

    sub.add(
      dispatcher.register({
        id: "git.toggleGraphAllBranches",
        title: "Toggle all branches in the graph",
        category: "Git",
        description:
          "Switches the Graph between the current branch (with its upstream) and every branch, tag and remote branch (git.graph.allBranches).",
        input: s.object({ value: s.boolean().optional() }),
        effects: ["write"],
        run: async ({ value }) => {
          const next =
            value ?? services.settings.peek<boolean | undefined>("git.graph.allBranches") !== true;
          await services.settings.update("git.graph.allBranches", next);
          return { allBranches: next };
        },
      }),
    );

    // Status bar: branch (opens the picker) and sync state (DESIGN.md §10 status bar).
    sub.add(
      statusBar.add({
        id: "git.branch",
        name: "Git branch",
        alignment: "left",
        priority: 90,
        text: () => {
          const st = git.status.value;
          if (!git.repo.value || !st) return "";
          const b = st.branch;
          const name = b.head ?? `${b.oid?.slice(0, 7) ?? "?"} (detached)`;
          const dirty = st.files.some((f) => f.index !== "!") ? "*" : "";
          return `$(git-branch) ${name}${dirty}`;
        },
        tooltip: () => {
          const b = git.status.value?.branch;
          const name = repos.all.value.length > 1 ? `${repos.selected.value.name}: ` : "";
          return b?.head
            ? `${name}${b.head}${b.upstream ? ` → ${b.upstream}` : ""} · Checkout branch…`
            : "Checkout branch…";
        },
        command: "git.checkout",
      }),
    );
    sub.add(
      statusBar.add({
        id: "git.sync",
        name: "Git sync",
        alignment: "left",
        priority: 89,
        text: () => {
          const busy = git.busy.value;
          if (busy) return `$(refresh-cw) ${busy}`;
          const b = git.status.value?.branch;
          if (!git.repo.value || !b?.oid) return "";
          if (!b.upstream) return b.head ? "$(cloud-upload) Publish" : "";
          if (b.ahead === 0 && b.behind === 0) return "$(refresh-cw)";
          return `${b.behind ? `$(arrow-down)${b.behind} ` : ""}${b.ahead ? `$(arrow-up)${b.ahead}` : ""}`.trim();
        },
        tooltip: () => {
          if (git.busy.value) return git.progress.value || git.busy.value;
          const b = git.status.value?.branch;
          if (b && !b.upstream)
            return git.repoState.value?.remotes.length
              ? "Publish this branch (push to origin)"
              : "Publish to GitHub";
          return b ? `${b.behind} to pull, ${b.ahead} to push · Sync` : "Sync";
        },
        command: "git.sync",
      }),
    );

    sub.add(
      state.register("ide://git/problem", {
        description:
          "Why the selected repository can't be shown (git missing, restricted mode…), or null. `paused`: its git settings changed after an agent's sandboxed command ran there, so the IDE's git waits until a person runs git.trustSettings (D392).",
        get: () => {
          const problem = git.problem.peek();
          return problem === null ? null : { problem, paused: git.paused.peek() };
        },
      }),
    );
    sub.add(
      state.register("ide://git/repositories", {
        description:
          "Every git repository in the open folder (its own, nested ones, submodules; in a multi-root workspace every folder's, with the `folder` holding it): root, workspace-relative path, kind, branch, ahead/behind, pending changes, which one is selected and which ones Source control lists in its multiple selection mode (shown).",
        get: () => repos.describe(),
      }),
    );
    sub.add(
      dispatcher.register({
        id: "git.repositories",
        title: "List repositories",
        category: "Git",
        description:
          "The git repositories in the open folder (VS Code's Source control repositories): the folder's own, nested repositories (git.repositoryScanMaxDepth) and submodules, each with its branch and pending changes. Their name or root is the `repository` input of git commands.",
        input: s.empty(),
        effects: ["read"],
        when: "workspaceOpen",
        agent: "discoverable",
        run: async () => {
          await repos.discover();
          return repos.describe();
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "git.selectRepository",
        title: "Select repository…",
        category: "Git",
        description:
          "Makes a repository the selected one: Source control shows it and git commands without `repository` act on it. Without `repository`, a picker.",
        input: s.object({
          repository: s.string().optional(),
          show: s.boolean().describe("Show Source control (default true)").optional(),
        }),
        effects: [],
        when: "gitRepo",
        run: async ({ repository, show }, ctx) => {
          let target = repository;
          if (!target) {
            if (ctx.caller.kind !== "user") throw new Error("Name the `repository`.");
            const list = repos.describe();
            const picked = await services.quickInput.pick(
              list.map((r) => ({
                id: r.root,
                label: r.name,
                description: `${r.path} · ${r.branch ?? ""}${r.changes ? ` · ${r.changes} changes` : ""}`,
                icon: "git-branch" as const,
              })),
              { placeholder: "Select a repository" },
            );
            if (!picked) return null;
            target = picked.id;
          }
          const repo = repos.pick(target);
          repos.select(repo);
          if (show !== false) await ctx.execute("view.show", { id: "scm.view" });
          return { selected: repo.name, root: repo.repo.peek()?.root ?? null };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "git.toggleRepositoryShown",
        title: "Show or hide a repository in source control",
        category: "Git",
        description:
          "With scm.repositories.selectionMode \"multiple\" (VS Code's selection in its Repositories view): whether Source control lists a repository's changes and commit box. `shown` sets it (default: toggles). One always stays shown. Kept with the folder.",
        input: s.object({
          repository: s.string().describe("Its root or folder name (git.repositories)"),
          shown: s.boolean().describe("Show (true) or hide (false); default: toggle").optional(),
        }),
        effects: [],
        when: "gitRepo",
        run: async ({ repository, shown }) => {
          const repo = repos.pick(repository);
          repos.setShown(repo, shown ?? !repos.isShown(repo));
          return repos.describe().map((r) => ({ name: r.name, shown: r.shown }));
        },
      }),
    );

    sub.add(
      state.register("ide://git/status", {
        description:
          "The selected git repository (the workspace's own unless another is selected, ide://git/repositories): root, branch (upstream, ahead/behind) and changed files (staged, changes, conflicts) as workspace paths with status letters; null when there is none.",
        get: () => {
          const repo = git.repo.peek();
          const st = git.status.peek();
          if (!repo || !st) return null;
          const { workspace } = services;
          const g = git.groups.peek();
          // D251: workspace paths (a folder's name first in a multi-root workspace).
          const item = (c: { path: string; letter: string; conflict: string | null }) => ({
            path: workspace.root.peek()
              ? workspace.relative(c.path)
              : relativePath(repo.root, c.path),
            status: c.letter,
            ...(c.conflict && { conflict: c.conflict }),
          });
          return {
            root: repo.root,
            branch: st.branch,
            busy: git.busy.peek(),
            // D220: files changing on disk start a status read (else a 5 s poll).
            watched: repos.watching.peek(),
            staged: g.staged.map(item),
            changes: g.changes.map(item),
            conflicts: g.merge.map(item),
          };
        },
      }),
    );
  },
};

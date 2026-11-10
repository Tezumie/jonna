// Git commands (every UI action is one of these; agents use them too). Paths may be absolute or
// relative to the workspace root; without paths, stage/unstage act on everything. D204: each
// takes `repository` (a root or folder name, git.repositories); without it, the repository the
// paths are in, else the selected one.
import { fsIpc } from "../../core/ipc/fs";
import { type GitIpc, gitIpc, type RemoteOp } from "../../core/ipc/git";
import type { DisposableStore } from "../../core/lifecycle/index";
import { pathKey, relativePath, samePath } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import { showDialog } from "../../ui/Dialog";
import type { WorkbenchServices } from "../../workbench/services";
import type { GitController } from "./controller";
import { revertWorkingChange, stageChange, stageLines, unstageChange } from "./hunks";
import { type Change, isDeletionConflict } from "./model";
import { type GitRepositories, initFolder } from "./repositories";

export function registerGitCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  repos: GitRepositories,
  message: {
    get(repo?: GitController): string;
    set(value: string, repo?: GitController): void;
  },
): void {
  const { dispatcher, workspace, notifications } = services;
  // D251: a relative path may start with a workspace folder's name ("api/src/x.ts").
  const resolve = (path: string) => workspace.resolve(path);
  const requireRepo = (git: GitController) => {
    const repo = git.repo.peek();
    if (!repo) throw new Error(git.problem.peek() ?? "This folder isn't a git repository.");
    return repo;
  };
  const after = async (git: GitController) => {
    await git.refresh();
    return summary(git);
  };
  const summary = (git: GitController) => {
    const rel = (c: Change) => relativePath(requireRepo(git).root, c.path);
    const g = git.groups.peek();
    return {
      ...(repos.all.peek().length > 1 && { repository: git.name }),
      staged: g.staged.map(rel),
      changes: g.changes.map(rel),
      conflicts: g.merge.map(rel),
    };
  };
  const repository = s
    .string()
    .describe(
      "Repository: its root or folder name (git.repositories). Default: the one the paths are in, else the selected one",
    )
    .optional();
  /** Paths grouped by the repository each is in (`repository` forces one). */
  const byRepo = (paths: string[], named?: string) => {
    const out = new Map<GitController, string[]>();
    for (const p of paths) {
      const git = named ? repos.pick(named) : (repos.forPath(p) ?? repos.pick());
      out.set(git, [...(out.get(git) ?? []), p]);
    }
    return out;
  };
  /**
   * Staging a delete / modify conflict (VS Code's): keep the changed file, or delete it first so
   * `git add` stages the deletion. A person is asked per file (Cancel leaves it out); other
   * callers pass `deletion`. Returns the paths left to stage.
   */
  const settleDeletions = async (
    git: GitController,
    list: string[],
    deletion: "keep" | "delete" | undefined,
    user: boolean,
  ): Promise<string[]> => {
    const conflicts = new Map(
      git.groups
        .peek()
        .merge.filter((c) => isDeletionConflict(c.conflict))
        .map((c) => [pathKey(c.path), c]),
    );
    const out: string[] = [];
    for (const path of list) {
      const c = conflicts.get(pathKey(path));
      if (!c) {
        out.push(path);
        continue;
      }
      let choice = deletion;
      if (!choice && !user)
        throw new Error(
          `${c.rel} was ${c.conflict === "deletedByUs" ? "deleted by us and modified by them" : "deleted by them and modified by us"}: pass deletion "keep" or "delete".`,
        );
      if (!choice) {
        const theirs = c.conflict === "deletedByUs";
        choice =
          (await showDialog<"keep" | "delete" | null>({
            title: "Deleted on one side",
            message: `${c.rel} was ${theirs ? "deleted by us and modified by them" : "deleted by them and modified by us"}. What would you like to do?`,
            actions: [
              { label: "Cancel", value: null },
              { label: "Delete file", value: "delete" },
              {
                label: theirs ? "Keep their version" : "Keep our version",
                value: "keep",
                variant: "primary",
              },
            ],
            cancelValue: null,
          })) ?? undefined;
      }
      if (!choice) continue;
      if (choice === "delete") {
        // To the app trash (recoverable), then `git add -A` stages the deletion.
        await fsIpc.trash(path).catch(() => {});
        services.events.emit("files.didDelete", { path });
      }
      out.push(path);
    }
    return out;
  };
  const paths = s.array(s.string()).describe("Files (absolute or workspace-relative)");
  const pathAndLine = s.object({
    path: s.string().describe("File (absolute or workspace-relative)"),
    line: s.integer({ min: 1 }).describe("A line inside the change (1-based)"),
  });

  sub.add(
    dispatcher.register({
      id: "git.refresh",
      title: "Refresh source control",
      category: "Git",
      description: "Looks for the folder's repository again and reloads its status.",
      input: s.object({ repository }),
      effects: [],
      when: "workspaceOpen",
      run: async ({ repository: named }) => {
        if (!named) {
          await repos.primary.open();
          await repos.discover();
          const git = repos.selected.peek();
          if (git !== repos.primary) await git.refresh(true);
          return git.repo.peek() ? summary(git) : null;
        }
        const git = repos.pick(named);
        await git.open();
        return summary(git);
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "git.trustSettings",
      title: "Trust git settings",
      category: "Git",
      description:
        "The IDE's git pauses for a repository whose git settings (.git/config, its hooks) changed after an agent's sandboxed command ran there, since git runs programs they name (D392). This accepts the settings as they are now. Only a person can run it, after checking them.",
      input: s.object({ repository }),
      effects: ["write"],
      when: "workspaceOpen",
      run: async ({ repository: named }, ctx) => {
        // The whole point is that a person looked: an agent (or an extension) that could trust
        // them could undo the pause it caused.
        if (ctx.caller.kind !== "user" && ctx.caller.kind !== "test")
          throw new Error(
            "Only a person can trust a repository's git settings: ask the user to check them and choose Trust git settings.",
          );
        const git = repos.pick(named);
        if (ctx.caller.kind === "user") {
          const trusted = await showDialog({
            title: "Trust this repository's git settings?",
            message: `${git.problem.peek() ?? ""}\n\nGit runs programs named in .git/config (core.fsmonitor, core.sshCommand, filters, credential helpers) and the scripts in .git/hooks, outside the sandbox. Trust them only if you know what changed.`,
            actions: [
              { label: "Cancel", value: false },
              { label: "Trust settings", value: true, variant: "primary" },
            ],
            cancelValue: false,
            defaultValue: false,
          });
          if (!trusted) return null;
        }
        await git.ipc.trustSettings();
        await git.open();
        if (git === repos.primary) await repos.discover();
        return git.repo.peek() ? after(git) : null;
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "git.status",
      title: "Show git status",
      category: "Git",
      description:
        "The repository's branch (with ahead/behind counts) and changed files: staged, unstaged/untracked and conflicted, as workspace paths with status letters (M modified, A added, D deleted, R renamed, U untracked; conflicts ! both modified, A added by one or both sides, D deleted by one or both sides, with `conflict` naming which).",
      input: s.object({ repository }),
      effects: ["read"],
      when: "workspaceOpen",
      agent: "core",
      run: async ({ repository: named }) => {
        const git = repos.pick(named);
        requireRepo(git);
        await git.refresh();
        const g = git.groups.peek();
        const item = (c: Change) => ({
          path: relativePath(requireRepo(git).root, c.path),
          status: c.letter,
          ...(c.conflict && { conflict: c.conflict }),
        });
        const others = repos.all.peek().filter((r) => r !== git);
        return {
          ...(others.length && {
            repository: git.name,
            otherRepositories: others.map((r) => r.name),
          }),
          branch: git.status.peek()?.branch ?? null,
          staged: g.staged.map(item),
          changes: g.changes.map(item),
          conflicts: g.merge.map(item),
        };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "git.init",
      title: "Initialize repository",
      category: "Git",
      description:
        "Creates a git repository in the open folder. In a multi-root workspace, in `folder` (a workspace folder's path or name); without it, the folder that has none (a person picks among several).",
      input: s.object({
        folder: s
          .string()
          .describe("Multi-root workspaces: the workspace folder (its path or name)")
          .optional(),
      }),
      effects: ["write"],
      when: "workspaceOpen",
      run: async ({ folder }, ctx) => {
        const target = await initFolder(services, repos, folder, ctx.caller.kind === "user");
        if (target === null) return null;
        const root = workspace.root.peek();
        if (target === undefined || (root && samePath(target, root))) {
          await gitIpc.init();
          await repos.primary.open();
          repos.select(repos.primary);
          return { root: repos.primary.repo.peek()?.root ?? null };
        }
        const made = await gitIpc.init(target);
        await repos.discover();
        const repo = made
          ? repos.all.peek().find((c) => samePath(c.ipc.repo ?? "", made.root))
          : undefined;
        if (repo) repos.select(repo);
        return { root: made?.root ?? null, ...(repo && { repository: repo.name }) };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "git.stage",
      title: "Stage changes",
      category: "Git",
      description:
        "Stages files (git add), or every change when no paths are given. A conflict where one side deleted the file and the other changed it needs `deletion` (keep the changed file, or delete it); a person is asked.",
      input: s.object({
        paths: paths.optional(),
        repository,
        deletion: s
          .enum(["keep", "delete"] as const)
          .describe(
            "Delete / modify conflicts: keep the changed file, or delete it (then the deletion is staged)",
          )
          .optional(),
      }),
      effects: ["write"],
      when: "gitRepo",
      agent: "discoverable",
      run: async ({ paths, repository: named, deletion }, ctx) => {
        const user = ctx.caller.kind === "user";
        if (!paths) {
          const git = repos.pick(named);
          requireRepo(git);
          const targets = await settleDeletions(
            git,
            [
              ...git.groups.peek().changes.map((c) => c.path),
              ...git.groups.peek().merge.map((c) => c.path),
            ],
            deletion,
            user,
          );
          if (targets.length) await git.ipc.stage(targets);
          return after(git);
        }
        let last: GitController | undefined;
        for (const [git, list] of byRepo(paths.map(resolve), named)) {
          requireRepo(git);
          const targets = await settleDeletions(git, list, deletion, user);
          if (targets.length) await git.ipc.stage(targets);
          await git.refresh();
          last = git;
        }
        return last ? summary(last) : null;
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "git.unstage",
      title: "Unstage changes",
      category: "Git",
      description:
        "Unstages files (keeps the working-tree edits), or everything staged when no paths are given.",
      input: s.object({ paths: paths.optional(), repository }),
      effects: ["write"],
      when: "gitRepo",
      agent: "discoverable",
      run: async ({ paths, repository: named }) => {
        if (!paths) {
          const git = repos.pick(named);
          requireRepo(git);
          const targets = git.groups.peek().staged.map((c) => c.path);
          if (targets.length) await git.ipc.unstage(targets);
          return after(git);
        }
        let last: GitController | undefined;
        for (const [git, list] of byRepo(paths.map(resolve), named)) {
          requireRepo(git);
          await git.ipc.unstage(list);
          await git.refresh();
          last = git;
        }
        return last ? summary(last) : null;
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "git.discard",
      title: "Discard changes",
      category: "Git",
      description:
        "Throws away working-tree changes to files: tracked files go back to their staged/committed text, untracked files are deleted. Without paths: every unstaged change.",
      input: s.object({ paths: paths.optional(), repository }),
      effects: ["write", "destructive"],
      when: "gitRepo",
      agent: "discoverable",
      confirm: ({ paths, repository: named }) => {
        const all = repos.pick(named, paths?.[0]).groups.peek().changes;
        const n = paths?.length ?? all.length;
        // Untracked files among the ones named are deleted too: say so.
        const given = paths ? new Set(paths.map((p) => pathKey(resolve(p)))) : null;
        const untracked = all.filter(
          (c) => c.untracked && (!given || given.has(pathKey(c.path))),
        ).length;
        const what =
          n === 1 && paths?.[0]
            ? `changes to ${paths[0]}`
            : `${n} changed file${n === 1 ? "" : "s"}`;
        return `Discard ${what}?${untracked ? `\n\n${untracked} untracked file${untracked === 1 ? " is" : "s are"} deleted.` : ""}\n\nThis can't be undone.`;
      },
      run: async ({ paths, repository: named }) => {
        const groups = paths
          ? byRepo(paths.map(resolve), named)
          : new Map([[repos.pick(named), null as string[] | null]]);
        let last: GitController | undefined;
        for (const [git, list] of groups) {
          requireRepo(git);
          const changes = git.groups.peek().changes;
          // Matched by path key, as the confirmation counted them: a path spelled with other
          // separators or case (Windows) is still the untracked file it names.
          const chosen = list
            ? list.map(
                (path) =>
                  changes.find((c) => pathKey(c.path) === pathKey(path)) ?? {
                    path,
                    untracked: false,
                  },
              )
            : changes;
          const tracked = chosen.filter((c) => !c.untracked).map((c) => c.path);
          const untracked = chosen.filter((c) => c.untracked).map((c) => c.path);
          await git.ipc.discard(tracked, untracked);
          for (const c of chosen) services.events.emit("files.didChange", { path: c.path });
          await git.refresh();
          last = git;
        }
        return last ? summary(last) : null;
      },
    }),
  );

  const hunkCommand = (
    id: string,
    title: string,
    description: string,
    fn: (path: string, line: number, ipc: GitIpc) => Promise<void>,
  ) =>
    sub.add(
      dispatcher.register({
        id,
        title,
        category: "Git",
        description,
        input: pathAndLine,
        effects: ["write"],
        when: "gitRepo",
        agent: "discoverable",
        run: async ({ path, line }) => {
          const target = resolve(path);
          const git = repos.pick(undefined, target);
          requireRepo(git);
          await fn(target, line, git.ipc);
          services.quickDiff.changed();
          return after(git);
        },
      }),
    );
  hunkCommand(
    "git.stageChange",
    "Stage change",
    "Stages only the change (hunk) touching `line` of the file as it is in the editor.",
    (path, line, ipc) => stageChange(services, path, line, ipc),
  );
  sub.add(
    dispatcher.register({
      id: "git.stageSelectedRanges",
      title: "Stage selected lines",
      category: "Git",
      description:
        "Stages only lines `from`..`to` (1-based, of the file as it is in the editor; default: the active editor's selection): the changes on those lines, a partly selected change with just its selected new lines (VS Code's Stage selected ranges).",
      input: s.object({
        path: s.string().optional(),
        from: s.number().optional(),
        to: s.number().optional(),
      }),
      effects: ["write"],
      when: "gitRepo",
      agent: "discoverable",
      run: async ({ path, from, to }) => {
        let target = path ? resolve(path) : undefined;
        let lo = from;
        let hi = to;
        if (!target || lo === undefined || hi === undefined) {
          const active = (await services.state.get("ide://editors/active")).value as {
            absolutePath?: string | null;
            selections?: { start: { line: number }; end: { line: number } }[];
            cursor?: { line: number };
          } | null;
          target ??= active?.absolutePath ?? undefined;
          const sel = active?.selections?.[0];
          lo ??= sel?.start.line ?? active?.cursor?.line;
          hi ??= sel?.end.line ?? lo;
        }
        if (!target || lo === undefined || hi === undefined)
          throw new Error("Open a changed file and select the lines to stage.");
        const git = repos.pick(undefined, target);
        requireRepo(git);
        await stageLines(services, target, lo, hi, git.ipc);
        services.quickDiff.changed();
        return after(git);
      },
    }),
  );
  hunkCommand(
    "git.unstageChange",
    "Unstage change",
    "Unstages the staged change touching `line` (a line of the staged version).",
    (path, line, ipc) => unstageChange(path, line, ipc),
  );
  hunkCommand(
    "git.revertChange",
    "Revert change",
    "Reverts the unstaged change touching `line` back to the staged text. In an open editor this is one undoable edit.",
    (path, line, ipc) => revertWorkingChange(services, path, line, ipc),
  );

  sub.add(
    dispatcher.register({
      id: "git.commit",
      title: "Commit",
      category: "Git",
      description:
        "Commits the staged changes with `message` (default: the source control view's message box). With nothing staged, commits all tracked changes (`all` forces that). `amend` rewrites the last commit.",
      input: s.object({
        message: s.string().describe("Commit message (first line is the summary)").optional(),
        amend: s.boolean().describe("Amend the previous commit").optional(),
        all: s.boolean().describe("Stage all tracked changes first").optional(),
        repository,
      }),
      effects: ["write"],
      when: "gitRepo",
      agent: "discoverable",
      run: async ({ message: given, amend, all, repository: named }) => {
        const git = repos.pick(named);
        requireRepo(git);
        const text = (given ?? message.get(git)).trim();
        if (!text) throw new Error("Type a commit message first.");
        await git.refresh();
        const g = git.groups.peek();
        if (g.merge.length) throw new Error("Resolve and stage the conflicted files first.");
        const commitAll = all ?? (g.staged.length === 0 && !amend);
        if (!amend && !commitAll && g.staged.length === 0)
          throw new Error("There is nothing to commit.");
        if (commitAll && !amend && !g.changes.some((c) => !c.untracked))
          throw new Error("There is nothing to commit (untracked files must be staged first).");
        // git.enableCommitSigning / git.alwaysSignOff (D200); git's own commit.gpgsign works too.
        const hash = await git.ipc.commit(text, amend ?? false, commitAll, {
          sign: services.settings.peek<boolean>("git.enableCommitSigning") === true,
          signoff: services.settings.peek<boolean>("git.alwaysSignOff") === true,
        });
        if (given === undefined || given === message.get(git)) message.set("", git);
        await git.refresh();
        return { commit: hash, summary: text.split("\n")[0] };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "git.checkout",
      title: "Checkout branch…",
      category: "Git",
      description:
        "Switches to `branch` (a local branch, or a remote one like origin/feature to track). `create` makes a new branch from the current commit. Without a branch, shows a picker.",
      input: s.object({
        branch: s.string().describe("Branch name").optional(),
        create: s.boolean().describe("Create a new branch").optional(),
        repository,
      }),
      effects: ["write"],
      when: "gitRepo",
      agent: "discoverable",
      run: async ({ branch, create, repository: named }) => {
        const git = repos.pick(named);
        requireRepo(git);
        let name = branch;
        let remote = false;
        let make = create ?? false;
        if (!name) {
          const picked = await pickBranch(services, git.ipc);
          if (!picked) return null;
          ({ name, remote, create: make } = picked);
        } else if (!make) {
          remote = (await git.ipc.branches()).some((b) => b.remote && b.name === name);
        }
        await git.ipc.checkout(name, make, remote);
        services.events.emit("files.didChange", { path: requireRepo(git).root });
        await git.refresh();
        return { branch: git.status.peek()?.branch.head ?? null };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "git.branches",
      title: "List branches",
      category: "Git",
      description:
        "Local and remote branches, most recently committed first, with the current one marked.",
      input: s.object({ repository }),
      effects: ["read"],
      when: "gitRepo",
      agent: "discoverable",
      run: async ({ repository: named }) => {
        const git = repos.pick(named);
        requireRepo(git);
        return git.ipc.branches();
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "git.log",
      title: "Show commit history",
      category: "Git",
      description:
        "Recent commits (hash, author, time, subject), optionally only those touching `path`.",
      input: s.object({
        limit: s.integer({ min: 1, max: 1000 }).describe("How many (default 30)").optional(),
        path: s.string().describe("Only commits touching this file or folder").optional(),
        repository,
      }),
      effects: ["read"],
      when: "gitRepo",
      agent: "discoverable",
      run: async ({ limit, path, repository: named }, ctx) => {
        const git = repos.pick(named, path);
        requireRepo(git);
        // From the palette: pick a commit and see its changes.
        if (ctx.caller.kind === "user" && limit === undefined && path === undefined)
          return ctx.execute("git.showCommit", { repository: requireRepo(git).root });
        const commits = await git.ipc.log(limit ?? 30, path ? resolve(path) : undefined);
        return commits.map((c) => ({ ...c, date: new Date(c.time * 1000).toISOString() }));
      },
    }),
  );

  const remote = (
    op: RemoteOp,
    title: string,
    verb: string,
    done: string,
    description: string,
    confirm?: string,
  ) =>
    sub.add(
      dispatcher.register({
        id: `git.${op}`,
        title,
        category: "Git",
        description,
        input: s.object({ repository }),
        effects: confirm ? ["write", "network", "destructive"] : ["write", "network"],
        when: "gitRepo",
        agent: "discoverable",
        ...(confirm && { confirm: () => confirm }),
        run: async ({ repository: named }, ctx) => {
          const git = repos.pick(named);
          requireRepo(git);
          if (git.busy.peek()) throw new Error(`${git.busy.peek()} Wait for it to finish.`);
          git.busy.value = `${verb}…`;
          git.progress.value = "";
          const lines: string[] = [];
          try {
            await git.ipc.remote(op, (line) => {
              lines.push(line);
              git.progress.value = line;
            });
          } catch (err) {
            // The branch and its upstream diverged: VS Code asks how to reconcile them.
            const text = err instanceof Error ? err.message : String(err);
            if (op === "pull" && ctx.caller.kind === "user" && /fast-forward|diverge/i.test(text)) {
              git.busy.value = null;
              const how = await showDialog<"pullRebase" | "pullMerge" | null>({
                title: "Branches have diverged",
                message:
                  "Your branch and its upstream both have new commits. Rebase your commits on top of the upstream's, or merge them?",
                actions: [
                  { label: "Cancel", value: null },
                  { label: "Merge", value: "pullMerge" },
                  { label: "Rebase", value: "pullRebase", variant: "primary" },
                ],
                cancelValue: null,
              });
              if (how) return ctx.execute(`git.${how}`, named ? { repository: named } : {});
            }
            throw err;
          } finally {
            git.busy.value = null;
            git.progress.value = "";
            await git.refresh();
          }
          if (op !== "fetch")
            services.events.emit("files.didChange", { path: requireRepo(git).root });
          const b = git.status.peek()?.branch;
          if (b && op !== "fetch") notifications.show("info", `${done} ${b.head ?? ""}`.trim());
          return { output: lines.slice(-20), ahead: b?.ahead ?? 0, behind: b?.behind ?? 0 };
        },
      }),
    );
  remote(
    "fetch",
    "Fetch",
    "Fetching",
    "Fetched",
    "Fetches from the remote (git fetch --prune); updates ahead/behind counts.",
  );
  remote(
    "pull",
    "Pull",
    "Pulling",
    "Pulled",
    "Pulls the current branch's upstream (fast-forward only).",
  );
  remote(
    "push",
    "Push",
    "Pushing",
    "Pushed",
    "Pushes the current branch (publishes it — sets the upstream to origin, or the only remote — on the first push).",
  );
  remote(
    "pullRebase",
    "Pull (rebase)",
    "Pulling",
    "Pulled",
    "Pulls the upstream and rebases the current branch's new commits on top (git pull --rebase).",
  );
  remote(
    "pullMerge",
    "Pull (merge)",
    "Pulling",
    "Pulled",
    "Pulls the upstream and merges it into the current branch (git pull --no-rebase).",
  );
  remote(
    "pushForce",
    "Push (force with lease)",
    "Pushing",
    "Pushed",
    "Overwrites the remote branch with the local one (--force-with-lease: refused if the remote has commits you haven't fetched).",
    "Force push? The remote branch is replaced with yours; commits only on the remote are lost.",
  );
  remote("pushTags", "Push tags", "Pushing tags", "Pushed tags", "Pushes all tags to the remote.");
}

interface PickedBranch {
  name: string;
  remote: boolean;
  create: boolean;
}

async function pickBranch(
  services: WorkbenchServices,
  ipc: GitIpc,
): Promise<PickedBranch | undefined> {
  const branches = await ipc.branches();
  const CREATE = "\u0000create";
  const items = [
    { id: CREATE, label: "Create new branch…", icon: "plus" as const },
    ...branches.map((b) => ({
      id: `${b.remote ? "r" : "l"}:${b.name}`,
      label: b.name,
      description: `${b.current ? "current · " : ""}${b.commit} ${b.subject}`,
      icon: (b.remote ? "cloud-download" : "git-branch") as "cloud-download" | "git-branch",
      disabled: b.current,
    })),
  ];
  const picked = await services.quickInput.pick(items, {
    placeholder: "Select a branch to check out",
  });
  if (!picked) return undefined;
  if (picked.id === CREATE) {
    const name = await services.quickInput.prompt({
      prompt: "New branch name",
      placeholder: "feature/my-change",
      validate: (v) =>
        !v.trim()
          ? "Type a name."
          : /[\s~^:?*[\\]|\.\.|^-|\/$|\.lock$|@\{/.test(v.trim())
            ? "That isn't a valid branch name."
            : branches.some((b) => !b.remote && b.name === v.trim())
              ? "A branch with that name exists."
              : undefined,
    });
    return name ? { name: name.trim(), remote: false, create: true } : undefined;
  }
  return { name: picked.label, remote: picked.id.startsWith("r:"), create: false };
}

// Worktrees (D139), like VS Code's "Worktrees" in the source control menu: another branch
// checked out in a folder of its own, so a hotfix or a review doesn't disturb the work in
// progress. git.worktrees lists them (and offers open / open in a new window / remove);
// git.createWorktree makes one (a new branch from a base, or an existing branch);
// git.deleteWorktree and git.pruneWorktrees tidy up. Opening switches this window's folder, or
// starts a new window. D220: each takes `repository` (the user picks one when there are several).
import type { Worktree } from "../../core/ipc/git";
import { appIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { basename, dirname, isWithin, joinPath, samePath } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import { confirmAction } from "../../ui/Dialog";
import type { WorkbenchServices } from "../../workbench/services";
import type { GitRepo } from "./controller";
import type { GitRepositories } from "./repositories";

/** "../repo.feature-x" for branch "feature/x": next to the repository, named after the branch. */
export function defaultWorktreePath(root: string, branch: string): string {
  const name = `${basename(root)}.${branch.replace(/[\\/:*?"<>|\s]+/g, "-")}`;
  return joinPath(dirname(root), name);
}

export function registerWorktreeCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  repos: GitRepositories,
): void {
  const { dispatcher, quickInput, workspace } = services;
  const repository = s
    .string()
    .describe(
      "Repository: its root or folder name (git.repositories). Default: the selected one (the user picks when there are several)",
    )
    .optional();
  const requireRepo = (git: GitRepo) => {
    const repo = git.repo.peek();
    if (!repo) throw new Error(git.problem.peek() ?? "This folder isn't a git repository.");
    return repo;
  };
  const describe = (git: GitRepo) => (w: Worktree) => ({
    path: w.path,
    branch: w.branch,
    head: w.head.slice(0, 7),
    main: w.main,
    current: samePath(w.path, requireRepo(git).root),
    ...(w.locked && { locked: true }),
    ...(w.prunable && { prunable: true }),
  });
  const pickWorktree = async (
    git: GitRepo,
    placeholder: string,
    filter: (w: Worktree) => boolean,
  ) => {
    const list = (await git.ipc.worktrees()).filter(filter);
    if (!list.length) throw new Error("There are no other worktrees.");
    const picked = await quickInput.pick(
      list.map((w) => ({
        id: w.path,
        label: w.branch ?? `${w.head.slice(0, 7)} (detached)`,
        description: `${w.path}${w.main ? " · main worktree" : ""}${w.prunable ? " · missing" : ""}`,
        icon: "folder-git-2" as const,
      })),
      { placeholder },
    );
    return picked ? list.find((w) => w.path === picked.id) : undefined;
  };
  const open = async (path: string, newWindow: boolean) => {
    if (newWindow) return { opened: path, newWindow: await appIpc.newWindow(path) };
    return { opened: await workspace.open(path) };
  };

  sub.add(
    dispatcher.register({
      id: "git.worktrees",
      title: "Worktrees…",
      category: "Git",
      description:
        "Lists the repository's worktrees (folder, branch, commit; the main one first). For the user, a picker that opens the chosen one here or (`newWindow`) in a new window.",
      input: s.object({
        open: s.string().describe("A worktree folder to open").optional(),
        newWindow: s.boolean().describe("Open in a new window").optional(),
        repository,
      }),
      effects: ["read"],
      when: "gitRepo",
      agent: "discoverable",
      run: async ({ open: target, newWindow, repository: named }, ctx) => {
        const git = await repos.choose(named, ctx.caller);
        if (!git) return null;
        requireRepo(git);
        const list = await git.ipc.worktrees();
        const describeOne = describe(git);
        if (target) {
          const w = list.find((x) => samePath(x.path, target));
          if (!w) throw new Error(`${target} isn't a worktree of this repository.`);
          return open(w.path, newWindow ?? false);
        }
        if (ctx.caller.kind !== "user") return { worktrees: list.map(describeOne) };
        const root = requireRepo(git).root;
        type Item = {
          id: string;
          label: string;
          description?: string;
          icon?: "plus" | "folder-git-2";
        };
        const items: Item[] = [
          ...list.map((w) => ({
            id: w.path,
            label: `${w.branch ?? `${w.head.slice(0, 7)} (detached)`}${samePath(w.path, root) ? " (current)" : ""}`,
            description: w.path,
            icon: "folder-git-2" as const,
          })),
          { id: "#new", label: "Create worktree…", icon: "plus" as const },
        ];
        const picked = await quickInput.pick(items, {
          placeholder: "Pick a worktree to open (in this window)",
        });
        if (!picked) return { worktrees: list.map(describeOne) };
        if (picked.id === "#new") return ctx.execute("git.createWorktree", { repository: root });
        if (samePath(picked.id, root)) return { worktrees: list.map(describeOne) };
        const how = await quickInput.pick(
          [
            { id: "here", label: "Open in this window" },
            { id: "new", label: "Open in a new window" },
          ],
          { placeholder: picked.label },
        );
        return how ? open(picked.id, how.id === "new") : { worktrees: list.map(describeOne) };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "git.createWorktree",
      title: "Create worktree…",
      category: "Git",
      description:
        'Adds a worktree: `branch` (new, from `base`, default the current commit) checked out in `path` (default: next to the repository, named after the branch). With `existing`, checks out that existing branch instead. Opens it if `open` is "here" or "newWindow".',
      input: s.object({
        branch: s.string().describe("New branch name").optional(),
        base: s.string().describe("Start point (branch or commit; default HEAD)").optional(),
        existing: s.string().describe("Check out this existing branch instead").optional(),
        path: s.string().describe("Folder for the worktree (absolute)").optional(),
        open: s.enum(["no", "here", "newWindow"] as const).optional(),
        repository,
      }),
      effects: ["write"],
      when: "gitRepo",
      agent: "discoverable",
      run: async ({ branch, base, existing, path, open: how, repository: named }, ctx) => {
        const git = await repos.choose(named, ctx.caller);
        if (!git) return { created: null };
        const repo = requireRepo(git);
        let name = branch;
        let checkout = existing;
        if (!name && !checkout) {
          if (ctx.caller.kind !== "user") throw new Error("Give `branch` or `existing`.");
          const branches = await git.ipc.branches();
          const choice = await quickInput.pick(
            [
              { id: "#new", label: "New branch…", icon: "plus" as const },
              ...branches
                .filter((b) => !b.remote && !b.current)
                .map((b) => ({
                  id: b.name,
                  label: b.name,
                  description: b.subject,
                  icon: "git-branch" as const,
                })),
            ],
            { placeholder: "Create a worktree for a new branch, or an existing one" },
          );
          if (!choice) return { created: null };
          if (choice.id === "#new") {
            name = await quickInput.prompt({
              prompt: "Name of the new branch for the worktree",
              validate: (v) =>
                /^[^\s~^:?*[\\]+$/.test(v.trim()) ? undefined : "Not a valid branch name",
            });
            if (!name) return { created: null };
          } else checkout = choice.id;
        }
        const label = (name ?? checkout ?? "").trim();
        let target = path ?? defaultWorktreePath(repo.root, label);
        if (!path && ctx.caller.kind === "user") {
          const typed = await quickInput.prompt({
            prompt: "Folder for the worktree",
            value: target,
            selection: [target.length - basename(target).length, target.length],
            validate: (v) =>
              isWithin(repo.root, v.trim()) ? "Pick a folder outside the repository" : undefined,
          });
          if (!typed) return { created: null };
          target = typed.trim();
        }
        await git.ipc.worktreeOp(
          "add",
          target,
          name?.trim() ?? "",
          checkout?.trim() ?? base?.trim() ?? "",
        );
        await git.refresh(true);
        let opened: unknown = null;
        let answer = how;
        if (!answer && ctx.caller.kind === "user") {
          const pick = await quickInput.pick(
            [
              { id: "newWindow", label: "Open in a new window" },
              { id: "here", label: "Open in this window" },
              { id: "no", label: "Don't open" },
            ],
            { placeholder: `Worktree ready at ${target}` },
          );
          answer = (pick?.id as typeof how) ?? "no";
        }
        if (answer === "here" || answer === "newWindow")
          opened = await open(target, answer === "newWindow");
        return { created: target, branch: label, opened };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "git.deleteWorktree",
      title: "Delete worktree…",
      category: "Git",
      description:
        "Removes a worktree (its folder; the branch stays). Refuses one with changes unless `force`.",
      input: s.object({
        path: s.string().describe("The worktree's folder").optional(),
        force: s.boolean().describe("Also when it has uncommitted changes").optional(),
        repository,
      }),
      effects: ["write", "destructive"],
      when: "gitRepo",
      agent: "discoverable",
      confirm: ({ path }) =>
        path ? `Delete the worktree at ${path}? Its uncommitted changes are lost.` : "",
      run: async ({ path, force, repository: named }, ctx) => {
        const git = await repos.choose(named, ctx.caller);
        if (!git) return { deleted: null };
        const repo = requireRepo(git);
        let target = path;
        if (!target) {
          const w = await pickWorktree(
            git,
            "Pick a worktree to delete",
            (x) => !x.main && !samePath(x.path, repo.root),
          );
          if (!w) return { deleted: null };
          if (
            !(await confirmAction(
              `Delete the worktree "${w.branch ?? basename(w.path)}"?`,
              `${w.path} is deleted. The branch stays.`,
              "Delete",
              true,
            ))
          )
            return { deleted: null };
          target = w.path;
        }
        if (samePath(target, repo.root))
          throw new Error("This window's worktree can't delete itself.");
        try {
          await git.ipc.worktreeOp(force ? "forceRemove" : "remove", target);
        } catch (err) {
          // git refuses a worktree with changes (or a locked one): the user may force it.
          const message = err instanceof Error ? err.message : String(err);
          if (
            force ||
            ctx.caller.kind !== "user" ||
            !/modified or untracked|locked|--force/i.test(message) ||
            !(await confirmAction(
              "Delete it anyway?",
              `${message}\n\nIts uncommitted changes are lost.`,
              "Delete anyway",
              true,
            ))
          )
            throw err;
          await git.ipc.worktreeOp("forceRemove", target);
        }
        await git.refresh(true);
        return { deleted: target };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "git.pruneWorktrees",
      title: "Prune worktrees",
      category: "Git",
      description: "Forgets worktrees whose folders were deleted by hand (`git worktree prune`).",
      input: s.object({ repository }),
      effects: ["write"],
      when: "gitRepo",
      run: async ({ repository: named }, ctx) => {
        const git = await repos.choose(named, ctx.caller);
        if (!git) return null;
        await git.ipc.worktreeOp("prune");
        return { worktrees: (await git.ipc.worktrees()).map(describe(git)) };
      },
    }),
  );
}

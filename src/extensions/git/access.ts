// The read-only git extensions get (D208, services.gitAccess → `ide.git.*`): the repositories,
// blame, line history, diffs between refs, refs, stashes and file contents at a revision, routed
// like the git commands (a named repository, else the one a path is in, else the selected one),
// plus a change signal when a repository's HEAD, index or refs move. The Git tools extension's
// views are built on it; anything that changes the repository stays a git.* command.
import type { DisposableStore } from "../../core/lifecycle/index";
import { toDisposable } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import type { GitAccessProvider, GitAccessRepository } from "../../workbench/gitAccess";
import type { WorkbenchServices } from "../../workbench/services";
import type { GitController } from "./controller";
import { parseBlamePorcelain, parseLineLog } from "./lens";
import type { GitRepositories } from "./repositories";

function accessTo(git: GitController): GitAccessRepository | null {
  const root = git.repo.peek()?.root;
  if (!root) return null;
  return {
    root,
    name: git.name,
    blame: async (path, contents) => parseBlamePorcelain(await git.ipc.blameFile(path, contents)),
    lineLog: async (path, start, end, limit) =>
      parseLineLog(await git.ipc.logLines(path, start, end, limit)),
    diffNames: (left, right) => git.ipc.diffNames(left, right),
    revParse: (rev) => git.ipc.revParse(rev),
    mergeBase: (left, right) => git.ipc.mergeBaseOf(left, right),
    refs: async () => {
      const [branches, tags] = await Promise.all([
        git.ipc.branches(),
        git.ipc
          .repoState()
          .then((st) => st.tags)
          .catch(() => [] as string[]),
      ]);
      return { branches, tags };
    },
    stashes: () => git.ipc.stashList(),
    show: (rev, path) => git.ipc.show(rev, path),
  };
}

export function registerGitAccess(
  sub: DisposableStore,
  services: WorkbenchServices,
  repos: GitRepositories,
): void {
  const listeners = new Set<(root: string) => void>();
  const fire = (root: string) => {
    for (const l of listeners) l(root);
  };
  // A repository's git dir changed (commit, checkout, stash, fetch…), or the list did.
  const seen = new Map<GitController, number>();
  let count = -1;
  sub.add(
    effect(() => {
      const all = repos.all.value;
      for (const git of all) {
        const version = git.gitDirVersion.value;
        const root = git.repo.value?.root ?? "";
        if (seen.has(git) && seen.get(git) !== version) fire(root);
        seen.set(git, version);
      }
      for (const git of [...seen.keys()]) if (!all.includes(git)) seen.delete(git);
      if (count !== -1 && count !== all.length) fire("");
      count = all.length;
      return undefined;
    }),
  );
  // The selected repository changed: "" (every view showing "the repository" reloads).
  let selected: GitController | null = null;
  sub.add(
    effect(() => {
      const now = repos.selected.value;
      now.repo.value;
      if (selected) fire("");
      selected = now;
      return undefined;
    }),
  );
  const provider: GitAccessProvider = {
    repositories: () =>
      repos.describe().map((r) => ({
        root: r.root,
        name: r.name,
        kind: r.kind,
        selected: r.selected,
        branch: r.branch,
      })),
    repository: (repository, path) => accessTo(repos.pick(repository, path)),
    // Notifications are the user's, not a repository's (Rust runs them anywhere).
    github: {
      notifications: (all) => repos.selected.peek().github.json("notifications", { all }),
      markRead: async (thread) => {
        const gh = repos.selected.peek().github;
        if (thread === null) await gh.run("notificationsReadAll");
        else await gh.run("notificationRead", { thread });
      },
    },
    onDidChange: (listener) => {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
  };
  sub.add(services.gitAccess.provide(provider));
}

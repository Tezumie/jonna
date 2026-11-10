// Source control's multi-file diffs (D229, VS Code's multi-diff editor): "View all changes" and
// "View staged changes" of a repository, a commit's "Open changes" and the Graph's Incoming /
// Outgoing rows open one tab with every file (editor.openMultiDiff). The file lists are built
// here (DOM-free, tested); the tab is the editor's (editor/multiDiffView.ts).

import type { ChangedFile } from "../../core/ipc/git";
import type { DisposableStore } from "../../core/lifecycle/index";
import { resolveInRoot } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import type { GitController } from "./controller";
import type { GroupedChanges } from "./model";
import type { GitRepositories } from "./repositories";

/** One file as editor.openMultiDiff takes it. */
export interface DiffFile {
  path: string;
  status?: string;
  from?: string;
  staged?: boolean;
  base?: string;
  head?: string;
}

/**
 * A repository's working-tree changes (index ↔ file, untracked files as added) or its staged
 * ones (HEAD ↔ index), in the view's order. Conflicted files aren't listed: they have the
 * merge editor.
 */
export function changesFiles(groups: GroupedChanges, staged: boolean): DiffFile[] {
  return (staged ? groups.staged : groups.changes).map((c) => ({
    path: c.path,
    status: c.letter,
    ...(c.origRel && { from: c.origRel }),
    ...(staged && { staged: true }),
  }));
}

/**
 * The files changed between two revisions (a commit and its parent, the fork and a branch tip),
 * each `git:<base>[@<old path>]` ↔ `git:<tip>`. No base (a root commit): the left side is empty.
 */
export function rangeFiles(
  root: string,
  files: readonly ChangedFile[],
  base: string | null,
  tip: string,
): DiffFile[] {
  return files.map((f) => ({
    path: resolveInRoot(root, f.path),
    status: f.status.charAt(0) || "M",
    ...(f.origPath && { from: f.origPath }),
    ...(base && { base: `git:${base}${f.origPath ? `@${f.origPath}` : ""}` }),
    head: `git:${tip}`,
  }));
}

/** The multi-file diff's `source` for a repository's changes or staged changes. */
export function changesSource(root: string, staged: boolean): string {
  return `git:${staged ? "staged" : "changes"}:${root}`;
}

/** editor.openMultiDiff's input for View all changes / View staged changes of a repository. */
export function changesTabInput(
  git: GitController,
  root: string,
  staged: boolean,
  several: boolean,
): {
  title: string;
  source: string;
  refresh: { command: string; input: { repository: string } };
  files: DiffFile[];
} {
  const label = staged ? "Staged changes" : "Changes";
  return {
    title: several ? `${label} · ${git.name}` : label,
    source: changesSource(root, staged),
    refresh: {
      command: staged ? "git.viewStagedChanges" : "git.viewChanges",
      input: { repository: root },
    },
    files: changesFiles(git.groups.peek(), staged),
  };
}

export function registerChangesTabs(
  sub: DisposableStore,
  services: WorkbenchServices,
  repos: GitRepositories,
): void {
  const { dispatcher } = services;
  const repository = s
    .string()
    .describe("Repository: its root or folder name (git.repositories). Default: the selected one")
    .optional();
  const rootOf = (git: GitController): string => {
    const root = git.repo.peek()?.root;
    if (!root) throw new Error(git.problem.peek() ?? "This folder isn't a git repository.");
    return root;
  };
  const several = () => repos.all.peek().length > 1;

  for (const [id, title, staged] of [
    ["git.viewChanges", "View all changes", false],
    ["git.viewStagedChanges", "View staged changes", true],
  ] as const)
    sub.add(
      dispatcher.register({
        id,
        title,
        category: "Git",
        description: staged
          ? "Opens every staged file's change (HEAD ↔ index) in one multi-file diff tab (VS Code's View staged changes)."
          : "Opens every changed file (index ↔ file, editable; untracked files as added) in one multi-file diff tab (VS Code's View all changes). Opening it again lists the files again.",
        input: s.object({ repository }),
        effects: [],
        when: "gitRepo",
        agent: "discoverable",
        run: async ({ repository: named }, ctx) => {
          const git = repos.pick(named);
          const root = rootOf(git);
          await git.refresh();
          return ctx.execute("editor.openMultiDiff", changesTabInput(git, root, staged, several()));
        },
      }),
    );

  sub.add(
    dispatcher.register({
      id: "git.openCommitChanges",
      title: "Open all changes of a commit",
      category: "Git",
      description:
        "Opens every file a commit changed (parent ↔ commit) in one multi-file diff tab (VS Code's Open changes on a Graph commit). git.showCommit lists them instead.",
      input: s.object({
        commit: s.string().describe("Hash or any revision (default HEAD)").optional(),
        repository,
      }),
      effects: ["read"],
      when: "gitRepo",
      agent: "discoverable",
      run: async ({ commit, repository: named }, ctx) => {
        const git = repos.pick(named);
        const root = rootOf(git);
        const d = await git.ipc.commitDetail(commit ?? "HEAD");
        const subject = d.message.split("\n")[0]?.slice(0, 50) ?? "";
        return ctx.execute("editor.openMultiDiff", {
          title: `${d.hash.slice(0, 7)} · ${subject}`,
          source: `git:commit:${root}:${d.hash}`,
          files: rangeFiles(root, d.files, d.parent, d.hash),
        });
      },
    }),
  );
}

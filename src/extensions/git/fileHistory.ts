// File history (D127, like VS Code's Timeline / GitLens's file history): the commits that touched
// a file, newest first; picking one opens that version ↔ the file now in a diff tab. The left
// side comes from the "git:<hash>" content scheme (`git show <hash>:<path>`); D204: also the
// "gitStage:<n>" scheme, a conflicted file's index stage (1 base, 2 ours, 3 theirs) for the merge
// editor. Both read from the repository the file is in.
import { gitIpc } from "../../core/ipc/git";
import type { DisposableStore } from "../../core/lifecycle/index";
import { isWithin, relativePath } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import { stateField } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { blameAge } from "./cloneBlame";
import type { GitRepositories } from "./repositories";

export function registerFileHistory(
  sub: DisposableStore,
  services: WorkbenchServices,
  repos: GitRepositories,
): void {
  const { dispatcher, quickDiff, quickInput, workspace, dock } = services;
  sub.add(
    // "git:<hash>" — the file at that commit; "git:<hash>@<repo path>" — another path at it (the
    // old name of a renamed file, D137).
    quickDiff.registerContent("git:", (path, scheme) => {
      const spec = scheme.slice(4);
      const at = spec.indexOf("@");
      const hash = at < 0 ? spec : spec.slice(0, at);
      const file = at < 0 ? path : spec.slice(at + 1);
      const ipc = repos.forPath(path)?.ipc ?? gitIpc;
      return /^[0-9a-f]{7,40}$/i.test(hash) ? ipc.show(hash, file) : Promise.resolve(null);
    }),
  );
  sub.add(
    quickDiff.registerContent("gitStage:", (path, scheme) => {
      const stage = scheme.slice("gitStage:".length);
      if (stage !== "1" && stage !== "2" && stage !== "3") return Promise.resolve(null);
      return (repos.forPath(path)?.ipc ?? gitIpc).show(`:${stage}`, path).catch(() => null);
    }),
  );
  sub.add(
    dispatcher.register({
      id: "git.fileHistory",
      title: "Show file history",
      category: "Git",
      description:
        "The commits that changed a file (default: the active editor's), newest first. With `commit`, opens that version ↔ the file now in a diff tab; without, shows a picker. Returns the commits.",
      input: s.object({
        path: s.string().describe("File (default: the active editor)").optional(),
        commit: s.string().describe("A commit hash from the list: open its version").optional(),
      }),
      effects: ["read"],
      agent: "discoverable",
      when: "gitRepo",
      run: async ({ path, commit }, ctx) => {
        const tab = dock.activeTab();
        const active = tab?.viewType === "editor" ? stateField(tab.viewState, "path") : undefined;
        const file = path
          ? workspace.resolve(path)
          : typeof active === "string"
            ? active
            : undefined;
        const repo = file ? repos.forPath(file) : undefined;
        const root = repo?.repo.peek()?.root;
        if (!repo || !root || !file || !isWithin(root, file))
          throw new Error("Open a file in a git repository first.");
        const rel = workspace.root.peek() ? workspace.relative(file) : relativePath(root, file);
        const commits = await repo.ipc.log(100, file);
        if (!commits.length) throw new Error(`${rel} has no commits yet.`);
        const open = async (hash: string) => {
          const c = commits.find((x) => x.hash.startsWith(hash));
          if (!c) throw new Error(`${hash} didn't change ${rel}.`);
          await ctx.execute("editor.openDiff", {
            path: file,
            base: `git:${c.hash}`,
            baseLabel: `${c.hash.slice(0, 7)} · ${c.subject.slice(0, 50)}`,
          });
          return c.hash;
        };
        const list = commits.map((c) => ({
          hash: c.hash,
          author: c.author,
          date: new Date(c.time * 1000).toISOString(),
          subject: c.subject,
        }));
        if (commit) return { path: rel, opened: await open(commit), commits: list };
        if (ctx.caller.kind !== "user") return { path: rel, commits: list };
        const picked = await quickInput.pick(
          commits.map((c) => ({
            id: c.hash,
            label: c.subject || "(no message)",
            description: `${c.author}, ${blameAge(c.time)} · ${c.hash.slice(0, 7)}`,
            icon: "git-commit-horizontal" as const,
          })),
          { placeholder: `History of ${rel}: pick a version to compare with the file now` },
        );
        return { path: rel, opened: picked ? await open(picked.id) : null, commits: list };
      },
    }),
  );
}

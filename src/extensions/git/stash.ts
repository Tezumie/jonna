// Git stash (D122), like VS Code's Stash / Stash (include untracked) / Apply / Pop / Drop:
// commands for the palette, the Git menu, the Git tools extension's Stashes view (D208) and agents.
// Without an index, apply / pop / drop ask which stash with a picker (newest first). Afterwards
// the open files reload from disk (the watcher sees the change) and the source control view
// refreshes. D204: `git.stashShow` lists a stash's files and opens one as stash^1 ↔ stash; every
// command takes `repository`.
import type { Stash } from "../../core/ipc/git";
import type { DisposableStore } from "../../core/lifecycle/index";
import { resolveInRoot } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import { confirmAction } from "../../ui/Dialog";
import type { WorkbenchServices } from "../../workbench/services";
import { blameAge } from "./cloneBlame";
import type { GitController } from "./controller";
import type { GitRepositories } from "./repositories";

/** "stash@{0}: On main: wip" → the label the picker shows. */
export function stashLabel(st: Stash, now = Date.now() / 1000): string {
  return `${st.message.replace(/^(?:WIP )?[Oo]n [^:]+:\s*/, "") || st.message} · ${blameAge(st.time, now)}`;
}

export function registerStashCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  repos: GitRepositories,
): void {
  const { dispatcher, quickInput } = services;
  const repository = s
    .string()
    .describe("Repository: its root or folder name (default: the selected one)")
    .optional();
  const requireRepo = (git: GitController) => {
    const repo = git.repo.peek();
    if (!repo) throw new Error(git.problem.peek() ?? "This folder isn't a git repository.");
    return repo;
  };
  const changed = async (git: GitController) => {
    services.events.emit("files.didChange", { path: requireRepo(git).root });
    await git.refresh();
  };
  const pick = async (git: GitController, placeholder: string): Promise<number | undefined> => {
    const list = await git.ipc.stashList();
    if (!list.length) throw new Error("There are no stashes.");
    const picked = await quickInput.pick(
      list.map((st) => ({
        id: String(st.index),
        label: stashLabel(st),
        description: `stash@{${st.index}}`,
      })),
      { placeholder },
    );
    return picked ? Number(picked.id) : undefined;
  };

  sub.add(
    dispatcher.register({
      id: "git.stash",
      title: "Stash changes…",
      category: "Git",
      description:
        "Saves the working changes on the stash and cleans the working tree (`untracked: true` includes new files). `message` names it (asked for when run from the palette).",
      input: s.object({
        message: s.string().describe("Stash message").optional(),
        untracked: s.boolean().describe("Include untracked files").optional(),
        repository,
      }),
      effects: ["write"],
      when: "gitRepo",
      agent: "discoverable",
      run: async ({ message, untracked, repository: named }, ctx) => {
        const git = repos.pick(named);
        requireRepo(git);
        await git.refresh();
        const g = git.groups.peek();
        const any = g.staged.length + g.changes.filter((c) => untracked || !c.untracked).length;
        if (!any)
          throw new Error(
            g.changes.length
              ? "Only untracked files changed: use Stash (include untracked)."
              : "There are no changes to stash.",
          );
        let text = message;
        if (text === undefined && ctx.caller.kind === "user") {
          text = await quickInput.prompt({
            prompt: "Stash message (optional)",
            placeholder: "Press Enter to stash without a message",
          });
          if (text === undefined) return { stashed: false };
        }
        await git.ipc.stash("push", {
          ...(text?.trim() && { message: text.trim() }),
          untracked: untracked ?? false,
        });
        await changed(git);
        return { stashed: true, stashes: (await git.ipc.stashList()).length };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "git.stashIncludeUntracked",
      title: "Stash (include untracked)…",
      category: "Git",
      description: "Like git.stash, including new files.",
      input: s.object({ message: s.string().describe("Stash message").optional(), repository }),
      effects: ["write"],
      when: "gitRepo",
      run: ({ message, repository: named }) =>
        dispatcher.execute("git.stash", {
          ...(message !== undefined && { message }),
          ...(named && { repository: named }),
          untracked: true,
        }),
    }),
  );

  sub.add(
    dispatcher.register({
      id: "git.stashList",
      title: "List stashes",
      category: "Git",
      description: "The stash entries, newest first: index (stash@{index}), message, time.",
      input: s.object({ repository }),
      effects: ["read"],
      when: "gitRepo",
      agent: "discoverable",
      run: async ({ repository: named }) => {
        const git = repos.pick(named);
        requireRepo(git);
        return (await git.ipc.stashList()).map((st) => ({
          ...st,
          date: new Date(st.time * 1000).toISOString(),
        }));
      },
    }),
  );

  const restore = (op: "apply" | "pop", title: string, verb: string) =>
    sub.add(
      dispatcher.register({
        id: op === "pop" ? "git.stashPop" : "git.stashApply",
        title,
        category: "Git",
        description: `${verb} stash@{index} (default: asks; from agents the newest) onto the working tree, staged changes kept staged.${op === "pop" ? " The stash entry is removed when it applies cleanly." : ""}`,
        input: s.object({
          index: s.integer({ min: 0 }).describe("Stash index (0 = newest)").optional(),
          repository,
        }),
        effects: ["write"],
        when: "gitRepo",
        agent: "discoverable",
        run: async ({ index, repository: named }, ctx) => {
          const git = repos.pick(named);
          requireRepo(git);
          const at =
            index ?? (ctx.caller.kind === "user" ? await pick(git, `Select a stash to ${op}`) : 0);
          if (at === undefined) return { applied: false };
          try {
            await git.ipc.stash(op, { index: at });
          } finally {
            await changed(git);
          }
          return { applied: true, index: at };
        },
      }),
    );
  restore("pop", "Pop stash…", "Applies and removes");
  restore("apply", "Apply stash…", "Applies");

  sub.add(
    dispatcher.register({
      id: "git.stashDrop",
      title: "Drop stash…",
      category: "Git",
      description:
        "Deletes stash@{index} without applying it (asks which when `index` is missing).",
      input: s.object({
        index: s.integer({ min: 0 }).describe("Stash index (0 = newest)").optional(),
        repository,
      }),
      effects: ["write", "destructive"],
      when: "gitRepo",
      agent: "discoverable",
      run: async ({ index, repository: named }, ctx) => {
        const git = repos.pick(named);
        requireRepo(git);
        const at = index ?? (await pick(git, "Select a stash to drop"));
        if (at === undefined) return { dropped: false };
        if (ctx.caller.kind === "user") {
          const answer = await confirmAction(
            `Drop stash@{${at}}?`,
            "Its changes are deleted. This can't be undone.",
            "Drop",
            true,
          );
          if (!answer) return { dropped: false };
        }
        await git.ipc.stash("drop", { index: at });
        await git.refresh();
        return { dropped: true, index: at };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "git.stashShow",
      title: "Show stash…",
      category: "Git",
      description:
        "The files stash@{index} changed (against the commit it was made on). With `path`, opens that file's change in a diff tab (before ↔ stashed); from the palette, pick a stash and a file. Untracked files saved with the stash aren't listed.",
      input: s.object({
        index: s.integer({ min: 0 }).describe("Stash index (0 = newest)").optional(),
        path: s.string().describe("A file of the stash (repository-relative) to open").optional(),
        repository,
      }),
      effects: ["read"],
      when: "gitRepo",
      agent: "discoverable",
      run: async ({ index, path, repository: named }, ctx) => {
        const git = repos.pick(named);
        const root = requireRepo(git).root;
        const at =
          index ?? (ctx.caller.kind === "user" ? await pick(git, "Select a stash to show") : 0);
        if (at === undefined) return null;
        const [stash, parent] = await Promise.all([
          git.ipc.revParse(`stash@{${at}}`),
          git.ipc.revParse(`stash@{${at}}^1`),
        ]);
        const files = await git.ipc.diffNames(parent, stash);
        const open = (file: string) =>
          ctx.execute("editor.openDiff", {
            path: resolveInRoot(root, file),
            base: `git:${parent}@${file}`,
            baseLabel: `Before stash@{${at}}`,
            head: `git:${stash}@${file}`,
            headLabel: `stash@{${at}}`,
          });
        let opened: string | null = null;
        if (path) {
          await open(path);
          opened = path;
        } else if (ctx.caller.kind === "user" && files.length) {
          const picked = await quickInput.pick(
            files.map((f) => ({ id: f.path, label: f.path, description: f.status })),
            { placeholder: `stash@{${at}}: pick a file to see its change` },
          );
          if (picked) {
            await open(picked.id);
            opened = picked.id;
          }
        }
        return { index: at, stash, parent, files, opened };
      },
    }),
  );
}

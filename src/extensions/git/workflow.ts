// The rest of the everyday git workflow (D137), as commands: commits (details and their diffs,
// history picker), branches (create from, rename, delete, merge, rebase), an operation in
// progress (continue / abort a merge, rebase, cherry-pick, revert), tags, remotes, undo last
// commit, commit variants (amend, staged, all, & push, & sync), pull with rebase / merge, force
// push, .gitignore, and a commit message written by the user's model from the staged diff.
// D220: each takes `repository`; without it, with several repositories, the user picks one
// (VS Code's "Choose a repository"), other callers get the selected one.

import { fsIpc } from "../../core/ipc/fs";
import type { RepoOp } from "../../core/ipc/git";
import type { DisposableStore } from "../../core/lifecycle/index";
import { isWithin, joinPath, relativePath, resolveInRoot, samePath } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { showDialog } from "../../ui/Dialog";
import type { WorkbenchServices } from "../../workbench/services";
import { blameAge } from "./cloneBlame";
import {
  COMMIT_SYSTEM,
  cleanCommitMessage,
  commitPrompt,
  looksLikeCommitMessage,
  REWRITE_SYSTEM,
  WRITING_COMMIT_MESSAGE,
} from "./commitMessage";
import type { GitController, GitRepo } from "./controller";
import type { GitRepositories } from "./repositories";

/** Names git accepts for branches and tags (the common rules of check-ref-format). */
export function refNameProblem(name: string): string | undefined {
  const v = name.trim();
  if (!v) return "Type a name.";
  if (/[\s~^:?*[\\]|\.\.|^-|^\/|\/$|\.lock$|@\{|\/\/|\.$/.test(v))
    return "That isn't a valid name.";
  return undefined;
}

export function registerGitWorkflow(
  sub: DisposableStore,
  services: WorkbenchServices,
  repos: GitRepositories,
  message: { get(repo?: GitController): string; set(value: string, repo?: GitController): void },
): void {
  const { dispatcher, quickInput, notifications, workspace, languageModel } = services;
  /** The selected repository (the message box's: Generate commit message). */
  const selected = repos.current;
  const requireRepo = (git: GitRepo) => {
    const repo = git.repo.peek();
    if (!repo) throw new Error(git.problem.peek() ?? "This folder isn't a git repository.");
    return repo;
  };
  const register: typeof dispatcher.register = (c) =>
    sub.add(dispatcher.register({ category: "Git", when: "gitRepo", ...c }));
  const repository = s
    .string()
    .describe(
      "Repository: its root or folder name (git.repositories). Default: the selected one (the user picks when there are several)",
    )
    .optional();
  /** Runs an operation, then refreshes (the working tree may have changed under the editors). */
  const op = async (git: GitRepo, kind: RepoOp, name = "", target = "") => {
    requireRepo(git);
    try {
      return await git.ipc.repoOp(kind, name, target);
    } finally {
      services.events.emit("files.didChange", { path: requireRepo(git).root });
      await git.refresh(true);
    }
  };
  const head = (git: GitRepo) => git.status.peek()?.branch.head ?? null;
  /** A repository's root, the `repository` input of the commands a command runs next. */
  const rootOf = (git: GitRepo) => git.repo.peek()?.root ?? "";

  const pickBranch = async (
    git: GitRepo,
    placeholder: string,
    filter: (b: { name: string; remote: boolean; current: boolean }) => boolean,
  ) => {
    const branches = (await git.ipc.branches()).filter(filter);
    if (!branches.length) throw new Error("There's no branch to pick.");
    return (
      await quickInput.pick(
        branches.map((b) => ({
          id: b.name,
          label: b.name,
          description: `${b.commit} ${b.subject}`,
          icon: (b.remote ? "cloud-download" : "git-branch") as "cloud-download" | "git-branch",
        })),
        { placeholder },
      )
    )?.id;
  };
  const askName = (prompt: string, value = "") =>
    quickInput.prompt({ prompt, value, validate: refNameProblem }).then((v) => v?.trim());

  const pickCommit = async (git: GitRepo, placeholder: string): Promise<string | undefined> => {
    const commits = await git.ipc.log(200);
    if (!commits.length) throw new Error("There are no commits yet.");
    return (
      await quickInput.pick(
        commits.map((c) => ({
          id: c.hash,
          label: c.subject || "(no message)",
          description: `${c.author}, ${blameAge(c.time)} · ${c.hash.slice(0, 7)}${c.refs.length ? ` · ${c.refs.join(", ")}` : ""}`,
          icon: "git-commit-horizontal" as const,
        })),
        { placeholder, matchOn: (i) => `${i.label} ${i.description ?? ""}` },
      )
    )?.id;
  };

  /** Opens one file of a commit as a diff (parent ↔ commit). */
  const openCommitFile = async (git: GitRepo, hash: string, rel: string, preview = true) => {
    const repo = requireRepo(git);
    const detail = await git.ipc.commitDetail(hash);
    const file = detail.files.find((f) => f.path === rel);
    if (!file) throw new Error(`${hash.slice(0, 7)} didn't change ${rel}.`);
    const short = detail.hash.slice(0, 7);
    await dispatcher.execute("editor.openDiff", {
      path: resolveInRoot(repo.root, rel),
      ...(detail.parent && {
        base: `git:${detail.parent}${file.origPath ? `@${file.origPath}` : ""}`,
        baseLabel: detail.parent.slice(0, 7),
      }),
      head: `git:${detail.hash}`,
      headLabel: `${short} · ${detail.message.split("\n")[0]?.slice(0, 50) ?? ""}`,
      preview,
    });
  };

  register({
    id: "git.showCommit",
    title: "Show commit…",
    description:
      "A commit's author, date, whole message and changed files (default: pick one from the history). With `path`, opens that file's change in the commit as a diff (parent ↔ commit); without, the user picks a file.",
    input: s.object({
      commit: s.string().describe("Hash (or any revision, e.g. HEAD~2)").optional(),
      path: s.string().describe("A file the commit changed (repo-relative)").optional(),
      repository,
    }),
    effects: ["read"],
    agent: "discoverable",
    run: async ({ commit, path, repository: named }, ctx) => {
      const git = await repos.choose(named, ctx.caller);
      if (!git) return null;
      requireRepo(git);
      const rev =
        commit ?? (ctx.caller.kind === "user" ? await pickCommit(git, "Show a commit") : "HEAD");
      if (!rev) return null;
      const d = await git.ipc.commitDetail(rev);
      const info = {
        hash: d.hash,
        parent: d.parent,
        author: d.author,
        date: new Date(d.time * 1000).toISOString(),
        message: d.message,
        files: d.files.map((f) => ({
          status: f.status,
          path: f.path,
          ...(f.origPath && { from: f.origPath }),
        })),
      };
      if (path) {
        await openCommitFile(git, d.hash, path, false);
        return info;
      }
      if (ctx.caller.kind !== "user") return info;
      const picked = await quickInput.pick(
        d.files.map((f) => ({
          id: f.path,
          label: f.path,
          description: f.origPath ? `${f.status} ← ${f.origPath}` : f.status,
          icon: "git-compare" as const,
        })),
        {
          placeholder: `${d.hash.slice(0, 7)} · ${d.message.split("\n")[0]} — pick a file to see its change`,
        },
      );
      if (picked) await openCommitFile(git, d.hash, picked.id, false);
      return info;
    },
  });
  register({
    id: "git.openCommitFile",
    title: "Open file change in commit",
    description: "Opens a file's change in a commit as a diff (parent ↔ commit).",
    input: s.object({
      commit: s.string(),
      path: s.string().describe("Repo-relative path"),
      repository,
    }),
    effects: [],
    agent: "hidden",
    palette: false,
    run: async ({ commit, path, repository: named }) => {
      await openCommitFile(repos.pick(named), commit, path);
      return { opened: path };
    },
  });

  // ---- Commit variants ----
  const commitVariant = (
    id: string,
    title: string,
    description: string,
    input: { amend?: boolean; all?: boolean },
    then?: "git.push" | "git.sync",
  ) =>
    register({
      id,
      title,
      description,
      input: s.object({ repository }),
      effects: then ? ["write", "network"] : ["write"],
      agent: "hidden",
      run: async ({ repository: named }, ctx) => {
        const git = await repos.choose(named, ctx.caller);
        if (!git) return null;
        const amendEmpty = input.amend && !message.get(git).trim();
        // Amend with an empty box keeps the last message.
        const last = amendEmpty ? (await git.ipc.commitDetail("HEAD")).message : undefined;
        const result = await ctx.execute("git.commit", {
          ...input,
          ...(last && { message: last }),
          repository: rootOf(git),
        });
        if (then) await ctx.execute(then, { repository: rootOf(git) });
        return result;
      },
    });
  commitVariant("git.commitStaged", "Commit staged", "Commits only what is staged.", {
    all: false,
  });
  commitVariant("git.commitAll", "Commit all", "Commits all tracked changes (stages them first).", {
    all: true,
  });
  commitVariant(
    "git.commitAmend",
    "Commit (amend)",
    "Rewrites the last commit with what is staged; the message box's text replaces its message (empty: keep it).",
    { amend: true },
  );
  commitVariant("git.commitAndPush", "Commit & push", "Commits, then pushes.", {}, "git.push");
  commitVariant(
    "git.commitAndSync",
    "Commit & sync",
    "Commits, then pulls and pushes.",
    {},
    "git.sync",
  );
  register({
    id: "git.undoLastCommit",
    title: "Undo last commit",
    description:
      "Undoes the last commit (git reset --soft HEAD~1): its changes are staged again and its message goes back into the message box.",
    input: s.object({ repository }),
    effects: ["write"],
    agent: "discoverable",
    run: async ({ repository: named }, ctx) => {
      const git = await repos.choose(named, ctx.caller);
      if (!git) return null;
      const last = await git.ipc.commitDetail("HEAD");
      if (!last.parent) throw new Error("The first commit can't be undone this way.");
      await op(git, "undoCommit");
      if (!message.get(git).trim()) message.set(last.message, git);
      return { undone: last.hash.slice(0, 7), message: last.message };
    },
  });

  // ---- Branches ----
  register({
    id: "git.createBranchFrom",
    title: "Create branch from…",
    description: "Creates a branch from another branch or commit (`from`) and switches to it.",
    input: s.object({ name: s.string().optional(), from: s.string().optional(), repository }),
    effects: ["write"],
    agent: "discoverable",
    run: async ({ name, from, repository: named }, ctx) => {
      const git = await repos.choose(named, ctx.caller);
      if (!git) return null;
      requireRepo(git);
      const start = from ?? (await pickBranch(git, "Create the branch from…", () => true));
      if (!start) return null;
      const branch = name ?? (await askName(`New branch from ${start}`));
      if (!branch) return null;
      await op(git, "createBranchFrom", branch, start);
      return { branch: head(git) };
    },
  });
  register({
    id: "git.renameBranch",
    title: "Rename branch…",
    description: "Renames a branch (default: the current one).",
    input: s.object({
      branch: s.string().optional(),
      newName: s.string().optional(),
      repository,
    }),
    effects: ["write"],
    agent: "discoverable",
    run: async ({ branch, newName, repository: named }, ctx) => {
      const git = await repos.choose(named, ctx.caller);
      if (!git) return null;
      requireRepo(git);
      const from = branch ?? head(git) ?? "";
      const to = newName ?? (await askName(`Rename ${from || "the branch"} to`, from));
      if (!to || to === from) return null;
      await op(git, "renameBranch", branch ?? "", to);
      return { branch: head(git) };
    },
  });
  register({
    id: "git.deleteBranch",
    title: "Delete branch…",
    description: "Deletes a local branch. One that isn't merged needs `force` (the user is asked).",
    input: s.object({
      branch: s.string().optional(),
      force: s.boolean().optional(),
      repository,
    }),
    effects: ["write", "destructive"],
    agent: "discoverable",
    run: async ({ branch, force, repository: named }, ctx) => {
      const git = await repos.choose(named, ctx.caller);
      if (!git) return null;
      requireRepo(git);
      const name =
        branch ?? (await pickBranch(git, "Delete which branch?", (b) => !b.remote && !b.current));
      if (!name) return null;
      try {
        await op(git, force ? "forceDeleteBranch" : "deleteBranch", name);
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        if (force || !/not fully merged/i.test(text) || ctx.caller.kind !== "user") throw err;
        const sure = await showDialog({
          title: "Branch not merged",
          message: `"${name}" has commits that aren't merged anywhere. Delete it anyway? They'll be lost.`,
          actions: [
            { label: "Cancel", value: false },
            { label: "Delete anyway", value: true, variant: "danger" },
          ],
          cancelValue: false,
        });
        if (!sure) return null;
        await op(git, "forceDeleteBranch", name);
      }
      return { deleted: name };
    },
  });
  for (const [id, kind, title, verb] of [
    ["git.merge", "merge", "Merge branch…", "Merge into the current branch"],
    ["git.rebase", "rebase", "Rebase branch…", "Rebase the current branch onto"],
  ] as const)
    register({
      id,
      title,
      description: `${verb} \`branch\` (default: pick one). Conflicts show in Source control; finish with git.continueOperation or git.abortOperation.`,
      input: s.object({ branch: s.string().optional(), repository }),
      effects: ["write"],
      agent: "discoverable",
      run: async ({ branch, repository: named }, ctx) => {
        const git = await repos.choose(named, ctx.caller);
        if (!git) return null;
        requireRepo(git);
        const name =
          branch ?? (await pickBranch(git, `${verb}…`, (b) => !b.current && b.name !== head(git)));
        if (!name) return null;
        try {
          return { output: (await op(git, kind, name)).trim() };
        } catch (err) {
          // Conflicts: git stops; the view shows them and Continue / Abort.
          const state = git.repoState.peek()?.operation;
          if (!state) throw err;
          notifications.show(
            "warning",
            `${kind === "merge" ? "Merge" : "Rebase"} stopped on conflicts: resolve them, stage the files, then Continue (Source control).`,
          );
          return { conflicts: git.groups.peek().merge.map((c) => c.path), operation: state };
        }
      },
    });
  const OPS = {
    merge: { abort: "mergeAbort", next: "mergeContinue", name: "merge" },
    rebase: { abort: "rebaseAbort", next: "rebaseContinue", name: "rebase" },
    cherryPick: { abort: "cherryPickAbort", next: "cherryPickContinue", name: "cherry-pick" },
    revert: { abort: "revertAbort", next: "revertContinue", name: "revert" },
  } as const;
  const current = async (git: GitRepo) => {
    requireRepo(git);
    await git.refresh(true);
    const now = git.repoState.peek()?.operation;
    if (!now) throw new Error("No merge, rebase, cherry-pick or revert is in progress.");
    return OPS[now];
  };
  register({
    id: "git.continueOperation",
    title: "Continue merge / rebase",
    description:
      "Continues the merge, rebase, cherry-pick or revert in progress once the conflicts are resolved and staged.",
    input: s.object({ repository }),
    effects: ["write"],
    agent: "discoverable",
    run: async ({ repository: named }, ctx) => {
      const git = await repos.choose(named, ctx.caller);
      if (!git) return null;
      const o = await current(git);
      if (git.groups.peek().merge.length)
        throw new Error("Resolve the conflicts and stage those files first.");
      await op(git, o.next);
      return { continued: o.name, operation: git.repoState.peek()?.operation ?? null };
    },
  });
  register({
    id: "git.abortOperation",
    title: "Abort merge / rebase",
    description:
      "Abandons the merge, rebase, cherry-pick or revert in progress and goes back to where it started.",
    input: s.object({ repository }),
    effects: ["write", "destructive"],
    agent: "discoverable",
    run: async ({ repository: named }, ctx) => {
      const git = await repos.choose(named, ctx.caller);
      if (!git) return null;
      const o = await current(git);
      await op(git, o.abort);
      return { aborted: o.name };
    },
  });

  // ---- Commits from the history ----
  for (const [id, kind, title, description] of [
    [
      "git.cherryPick",
      "cherryPick",
      "Cherry-pick commit…",
      "Applies a commit's change onto the current branch as a new commit.",
    ],
    [
      "git.revertCommit",
      "revertCommit",
      "Revert commit…",
      "Makes a new commit that undoes a commit's change.",
    ],
    [
      "git.checkoutCommit",
      "checkoutDetached",
      "Checkout commit (detached)…",
      "Switches to a commit without a branch (detached HEAD).",
    ],
  ] as const)
    register({
      id,
      title,
      description: `${description} Without \`commit\`, pick one from the history.`,
      input: s.object({ commit: s.string().optional(), repository }),
      effects: ["write"],
      agent: "discoverable",
      run: async ({ commit, repository: named }, ctx) => {
        const git = await repos.choose(named, ctx.caller);
        if (!git) return null;
        requireRepo(git);
        const hash = commit ?? (await pickCommit(git, title.replace("…", "")));
        if (!hash) return null;
        return { output: (await op(git, kind, hash)).trim(), branch: head(git) };
      },
    });

  // ---- Tags ----
  register({
    id: "git.createTag",
    title: "Create tag…",
    description: "Tags the current commit; with `message`, an annotated tag.",
    input: s.object({
      name: s.string().optional(),
      message: s.string().optional(),
      repository,
    }),
    effects: ["write"],
    agent: "discoverable",
    run: async ({ name, message: text, repository: named }, ctx) => {
      const git = await repos.choose(named, ctx.caller);
      if (!git) return null;
      requireRepo(git);
      const tag = name ?? (await askName("Tag name (e.g. v1.2.0)"));
      if (!tag) return null;
      const note =
        text ??
        (ctx.caller.kind === "user" && name === undefined
          ? ((await quickInput.prompt({
              prompt: "Message (optional: empty for a lightweight tag)",
            })) ?? "")
          : "");
      await op(git, "tag", tag, note);
      return { tag };
    },
  });
  register({
    id: "git.deleteTag",
    title: "Delete tag…",
    description: "Deletes a local tag.",
    input: s.object({ name: s.string().optional(), repository }),
    effects: ["write", "destructive"],
    agent: "discoverable",
    run: async ({ name, repository: named }, ctx) => {
      const git = await repos.choose(named, ctx.caller);
      if (!git) return null;
      requireRepo(git);
      const tags = git.repoState.peek()?.tags ?? (await git.ipc.repoState()).tags;
      const tag =
        name ??
        (
          await quickInput.pick(
            tags.map((t) => ({ id: t, label: t, icon: "tag" as const })),
            { placeholder: "Delete which tag?" },
          )
        )?.id;
      if (!tag) return null;
      await op(git, "deleteTag", tag);
      return { deleted: tag };
    },
  });

  // ---- Remotes ----
  register({
    id: "git.addRemote",
    title: "Add remote…",
    description: "Adds a remote (`name`, default origin) at `url`.",
    input: s.object({ name: s.string().optional(), url: s.string().optional(), repository }),
    effects: ["write"],
    agent: "discoverable",
    run: async ({ name, url, repository: named }, ctx) => {
      const git = await repos.choose(named, ctx.caller);
      if (!git) return null;
      requireRepo(git);
      const address =
        url ??
        (await quickInput.prompt({
          prompt: "Remote URL",
          placeholder: "https://github.com/owner/repo.git",
          validate: (v) => (v.trim() ? undefined : "Type the URL."),
        }));
      if (!address) return null;
      const has = git.repoState.peek()?.remotes ?? [];
      const remote = name ?? (has.includes("origin") ? await askName("Remote name") : "origin");
      if (!remote) return null;
      await op(git, "addRemote", remote, address.trim());
      return { remote, url: address.trim() };
    },
  });
  register({
    id: "git.removeRemote",
    title: "Remove remote…",
    description: "Removes a remote.",
    input: s.object({ name: s.string().optional(), repository }),
    effects: ["write", "destructive"],
    agent: "discoverable",
    run: async ({ name, repository: named }, ctx) => {
      const git = await repos.choose(named, ctx.caller);
      if (!git) return null;
      requireRepo(git);
      const remotes = (await git.ipc.repoState()).remotes;
      const remote =
        name ??
        (
          await quickInput.pick(
            remotes.map((r) => ({ id: r, label: r, icon: "globe" as const })),
            { placeholder: "Remove which remote?" },
          )
        )?.id;
      if (!remote) return null;
      await op(git, "removeRemote", remote);
      return { removed: remote };
    },
  });

  // ---- .gitignore ----
  register({
    id: "git.ignore",
    title: "Add to .gitignore",
    description:
      "Adds files or folders to the repository's .gitignore (as /path from the repo root).",
    input: s.object({ paths: s.array(s.string()).describe("Files or folders"), repository }),
    effects: ["write"],
    agent: "discoverable",
    run: async ({ paths, repository: named }) => {
      // The repository the first path is in (they come from one view's rows).
      const git = repos.pick(named, paths[0]);
      const repo = requireRepo(git);
      const file = joinPath(repo.root, ".gitignore");
      const before = await fsIpc
        .read(file)
        .then((b) => new TextDecoder().decode(b))
        .catch(() => "");
      const lines = new Set(before.split(/\r?\n/).map((l) => l.trim()));
      const added = paths
        .map((p) => (workspace.root.peek() ? workspace.resolve(p) : resolveInRoot(repo.root, p)))
        // Only paths inside the repository (not the root itself) can be ignored by it.
        .filter((abs) => isWithin(repo.root, abs) && !samePath(abs, repo.root))
        .map((abs) => `/${relativePath(repo.root, abs)}`)
        .filter((l) => !lines.has(l));
      if (added.length) {
        const sep = before && !before.endsWith("\n") ? "\n" : "";
        await fsIpc.write(
          file,
          new TextEncoder().encode(`${before}${sep}${added.join("\n")}\n`),
          "save",
        );
        services.events.emit("files.didChange", { path: file });
        await git.refresh();
      }
      return { added };
    },
  });

  // ---- A commit message from the staged diff (the user's model) ----
  /** The message being written now (git.cancelCommitMessage stops it). */
  let writing: AbortController | null = null;
  register({
    id: "git.cancelCommitMessage",
    title: "Stop writing the commit message",
    description: "Stops Generate commit message; the message box keeps what it had before.",
    input: s.empty(),
    effects: [],
    agent: "hidden",
    run: () => {
      if (!writing) throw new Error("No commit message is being written.");
      writing.abort();
      return { stopped: true };
    },
  });
  // On by default: it runs only when pressed, and every IDE has it (the exception to AI being
  // opt-in outside the chat, D173); git.aiCommitMessage.enabled turns it off.
  sub.add(
    effect(() => {
      services.settings.version.value;
      services.context.set(
        "aiCommitMessage",
        services.settings.peek<boolean>("git.aiCommitMessage.enabled") !== false,
      );
      return undefined;
    }),
  );
  register({
    id: "git.generateCommitMessage",
    when: "gitRepo && aiCommitMessage",
    title: "Generate commit message",
    description:
      "Writes a commit message for the staged changes with the user's model, into the message box. With nothing staged, the user is asked to stage everything first; other callers get a message for all changes.",
    input: s.empty(),
    effects: ["network"],
    agent: "hidden",
    run: async (_input, ctx) => {
      // The message box's repository: the selected one.
      const git = selected;
      requireRepo(git);
      // One at a time, and not while another git operation runs (the button would lose its
      // Stop, and two streams would write into one box; D174 audit).
      if (writing) throw new Error("A commit message is already being written.");
      const other = git.busy.peek();
      if (other) throw new Error(`${other} Wait for it to finish.`);
      // Claimed at once: a second press while this awaits (the stage dialog, the diff) is refused.
      const abort = new AbortController();
      writing = abort;
      let before: string | null = null;
      try {
        if (!languageModel.model("commit"))
          throw new Error("Set up a model first (the agent panel's model picker).");
        const groups = git.groups.peek();
        let staged = groups.staged.length > 0;
        if (!staged && groups.changes.length + groups.merge.length === 0)
          throw new Error("There are no changes to describe.");
        if (!staged && ctx.caller.kind === "user") {
          // VS Code-like: offer to stage everything rather than refusing.
          const answer = await showDialog<"stage" | "cancel">({
            title: "Nothing is staged",
            message: `Stage all ${groups.changes.length} change${groups.changes.length === 1 ? "" : "s"} and write a message for them?`,
            actions: [
              { label: "Cancel", value: "cancel" },
              { label: "Stage all and continue", value: "stage", variant: "primary" },
            ],
            cancelValue: "cancel",
            defaultValue: "stage",
          });
          if (answer !== "stage") return { message: null };
          await ctx.execute("git.stage", { repository: rootOf(git) });
          staged = git.groups.peek().staged.length > 0;
        }
        const diff = await git.ipc.diff(staged, 24_000);
        if (!diff.trim()) throw new Error("There are no changes to describe.");
        const kept = message.get();
        before = kept;
        if (git.busy.peek()) throw new Error(`${git.busy.peek()} Wait for it to finish.`);
        git.busy.value = WRITING_COMMIT_MESSAGE;
        // A few recent subjects: the model matches the repository's style (D174).
        const recent = (await git.ipc.log(8).catch(() => [])).map((c) => c.subject);
        const reply = await languageModel.generate({
          purpose: "commit",
          system: COMMIT_SYSTEM,
          prompt: commitPrompt({ branch: head(git), diff, staged, recent }),
          // Room for reasoning models, which think before answering; the message itself is short.
          maxTokens: 2000,
          signal: abort.signal,
          // Shown as it comes while it reads like a message (not a review of the diff).
          onText: (t) => {
            if (looksLikeCommitMessage(t)) message.set(cleanCommitMessage(t) || kept);
          },
        });
        // Stopped: what was there before comes back.
        if (abort.signal.aborted) {
          message.set(before);
          return { message: null, stopped: true };
        }
        let text = looksLikeCommitMessage(reply) ? cleanCommitMessage(reply) : "";
        // A small model sometimes reviews the diff instead: one format-only request turns its
        // answer into a message (cheap: no diff this time).
        if (!text && reply.trim()) {
          message.set(before);
          const rewritten = await languageModel.generate({
            purpose: "commit",
            system: REWRITE_SYSTEM,
            prompt: `Description of the changes:\n${cleanCommitMessage(reply).slice(0, 4000)}\n\nWrite the commit message now. Output only the message.`,
            maxTokens: 600,
            signal: abort.signal,
          });
          if (abort.signal.aborted) {
            message.set(before);
            return { message: null, stopped: true };
          }
          text = cleanCommitMessage(rewritten);
        }
        message.set(text || before);
        if (!text)
          throw new Error(
            "The model answered with no message. Try again, or pick another model for commit messages (git.aiCommitMessage.model).",
          );
        return { message: text };
      } catch (err) {
        // Half a streamed message is worse than what was there.
        if (before !== null) message.set(before);
        throw err;
      } finally {
        if (writing === abort) writing = null;
        if (git.busy.peek() === WRITING_COMMIT_MESSAGE) git.busy.value = null;
      }
    },
  });
}

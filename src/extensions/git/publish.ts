// Publish to GitHub (D148), as VS Code's "Publish to GitHub": from a folder that isn't a
// repository yet (it's initialized, everything not ignored committed as the first commit), or a
// repository without a remote. A new GitHub repository (private or public, named after the
// folder by default) is created with the GitHub CLI and becomes `origin`, and the branch is
// pushed. A repository that has a remote already just publishes its branch (git.push).
import { fsIpc } from "../../core/ipc/fs";
import { githubIpc, gitIpc } from "../../core/ipc/git";
import { openerIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { basename, joinPath } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import { showDialog } from "../../ui/Dialog";
import type { WorkbenchServices } from "../../workbench/services";
import type { GitRepo } from "./controller";
import { repoNameFrom, validRepoName } from "./refs";

export function registerPublish(
  sub: DisposableStore,
  services: WorkbenchServices,
  git: GitRepo,
): void {
  const { dispatcher, workspace, notifications, quickInput } = services;

  sub.add(
    dispatcher.register({
      id: "git.publish",
      title: "Publish to GitHub",
      category: "Git",
      description:
        "Publishes the open folder to a new GitHub repository (GitHub CLI): initializes git if needed, commits everything not ignored when there's no commit yet, creates the repository (private unless `visibility` is public; named after the folder unless `name`), adds it as origin and pushes. A repository that already has a remote just publishes its branch.",
      input: s.object({
        name: s.string().describe("Repository name, `name` or `owner/name`").optional(),
        visibility: s.enum(["private", "public"] as const).optional(),
      }),
      effects: ["write", "network"],
      when: "workspaceOpen",
      agent: "discoverable",
      run: async ({ name, visibility }, ctx) => {
        const root = workspace.root.peek();
        if (!root) throw new Error("Open a folder first.");
        if (git.busy.peek()) throw new Error(`${git.busy.peek()} Wait for it to finish.`);
        const user = ctx.caller.kind === "user";
        // A remote already: VS Code's "Publish branch".
        if (git.repo.peek()) await git.refresh(true);
        if (git.repo.peek() && git.repoState.peek()?.remotes.length)
          return ctx.execute("git.push", {});

        // Signed in to GitHub? (gh says.)
        try {
          await githubIpc.run("authStatus");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (user && /signed in|auth login|not logged/i.test(message)) {
            const signIn = await showDialog<boolean>({
              title: "Sign in to GitHub",
              message:
                "Publishing creates the repository with the GitHub CLI, which isn't signed in yet. Sign in, then publish again.",
              actions: [
                { label: "Cancel", value: false },
                { label: "Sign in", value: true, variant: "primary" },
              ],
              cancelValue: false,
            });
            if (signIn) await ctx.execute("accounts.signIn", { provider: "github" });
            return { published: false, reason: "not signed in" };
          }
          throw err;
        }

        let repoName = name?.trim() ?? "";
        if (!repoName) {
          if (!user) repoName = repoNameFrom(basename(root));
          else {
            const typed = await quickInput.prompt({
              prompt: "Repository name on GitHub",
              value: repoNameFrom(basename(root)),
              validate: validRepoName,
            });
            if (!typed) return { published: false };
            repoName = typed.trim();
          }
        }
        const invalid = validRepoName(repoName);
        if (invalid) throw new Error(invalid);
        let vis = visibility;
        if (!vis) {
          if (!user) vis = "private";
          else {
            const picked = await quickInput.pick(
              [
                {
                  id: "private",
                  label: `Publish to GitHub private repository ${repoName}`,
                  description: "Only you (and people you invite) can see it",
                  icon: "shield" as const,
                },
                {
                  id: "public",
                  label: `Publish to GitHub public repository ${repoName}`,
                  description: "Anyone on the internet can see it",
                  icon: "globe" as const,
                },
              ],
              { placeholder: "Private or public?" },
            );
            if (!picked) return { published: false };
            vis = picked.id as "private" | "public";
          }
        }

        git.busy.value = "Publishing…";
        try {
          // A folder that isn't a repository yet.
          if (!git.repo.peek()) {
            await gitIpc.init();
            await git.open();
          }
          await git.refresh();
          // A first commit, of everything not ignored. node_modules without a .gitignore would
          // upload thousands of files: ignored first (VS Code leaves that to you; we don't).
          if (!git.status.peek()?.branch.oid) {
            const modules = await fsIpc
              .stat(joinPath(root, "node_modules"))
              .then(() => true)
              .catch(() => false);
            const changes = git.groups.peek().changes;
            if (modules && changes.some((c) => /(^|\/)node_modules(\/|$)/.test(c.rel)))
              await ctx.execute("git.ignore", { paths: [joinPath(root, "node_modules")] });
            await gitIpc.stage([]);
            await git.refresh();
            if (!git.groups.peek().staged.length)
              throw new Error("There's nothing to publish yet: the folder has no files git keeps.");
            await gitIpc.commit("Initial commit", false, false);
          }
          git.busy.value = "Publishing to GitHub…";
          const out = await githubIpc.run("repoCreate", { name: repoName, visibility: vis });
          const url = /https:\/\/\S+/.exec(out)?.[0]?.replace(/\.git$/, "") ?? null;
          await git.refresh(true);
          services.events.emit("files.didChange", { path: root });
          notifications.show("success", `Published to GitHub: ${repoName} (${vis}).`, {
            ...(url && {
              actions: [{ label: "Open on GitHub", run: () => void openerIpc.openUrl(url) }],
            }),
          });
          return { published: true, name: repoName, visibility: vis, url };
        } finally {
          git.busy.value = null;
          await git.refresh(true);
        }
      },
    }),
  );
}

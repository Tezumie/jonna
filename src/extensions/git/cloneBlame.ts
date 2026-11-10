// Git: clone a repository, and who changed the cursor's line (D120).
// - `git.clone`: asks for the URL and the parent folder, clones with progress (the explorer's
//   progress line, the last git line in the status bar), then offers to open it.
// - Blame: the status bar shows the cursor line's author and age ("Ada, 3 days ago", like VS
//   Code's git.blame.statusBarItem); its tooltip has the commit; `git.blameLine` returns it for
//   agents. Unsaved edits are sent along (`--contents -`) so the line numbers match the editor.
import { type BlameLine, gitIpc } from "../../core/ipc/git";
import { clipboardIpc, dialogIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { isWithin } from "../../core/paths/index";
import { effect, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { stateField } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import type { GitRepositories } from "./repositories";

/** "just now", "5 minutes ago", "3 days ago", "2 years ago". */
export function blameAge(seconds: number, now = Date.now() / 1000): string {
  const d = Math.max(0, now - seconds);
  const units: [number, string][] = [
    [365 * 86400, "year"],
    [30 * 86400, "month"],
    [7 * 86400, "week"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    const n = Math.floor(d / size);
    if (n >= 1) return `${n} ${name}${n === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

/**
 * What the clone box accepts, as git wants it: a full https / ssh / git URL or a local path as
 * given, `github.com/owner/repo` → https, and the `owner/repo` shorthand → GitHub over https (no
 * account needed for public repositories; private ones use git's credential helper).
 */
export function normalizeCloneUrl(input: string): string {
  const v = input.trim().replace(/^git clone\s+/, "");
  if (/^(?:https?|ssh|git|file):\/\//i.test(v) || /^[\w.-]+@[\w.-]+:/.test(v)) return v;
  if (/^[a-zA-Z]:[\\/]|^[\\/.~]/.test(v)) return v; // a local path
  if (/^(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\//i.test(v)) return `https://${v}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(v)) return `https://github.com/${v.replace(/\.git$/, "")}.git`;
  return v;
}

/** A clone error in words people can act on (git's last line otherwise). */
export function cloneErrorHint(message: string): string {
  if (
    /authentication failed|could not read username|terminal prompts disabled|403|401/i.test(message)
  )
    return `${message}\nThe repository needs a sign-in: public repositories clone without one; for a private one, sign in through git (Git Credential Manager) or use an SSH URL (git@github.com:owner/repo.git).`;
  if (/repository not found|not found/i.test(message))
    return `${message}\nCheck the URL (private repositories also say "not found" without access).`;
  if (/could not resolve host|unable to access/i.test(message))
    return `${message}\nCheck your internet connection or the host name.`;
  return message;
}

/** The status bar text for a blame result. */
export function blameLabel(b: BlameLine): string {
  if (!b.committed) return "Not committed yet";
  return `${b.author}, ${blameAge(b.time)}`;
}

const MAX_BLAME_CHARS = 1024 * 1024;

export function registerCloneAndBlame(
  sub: DisposableStore,
  services: WorkbenchServices,
  repos: GitRepositories,
): void {
  const { dispatcher, quickInput, statusBar, settings, documents, workspace, dock } = services;
  let lastParent: string | undefined;

  sub.add(
    dispatcher.register({
      id: "git.clone",
      title: "Clone repository…",
      category: "Git",
      description:
        "Clones a git repository (`url`: https, ssh, a local path, or `owner/repo` for GitHub) into a new folder inside `parent` (asks for both when missing), showing progress, then offers to open it (`open: true` opens it right away).",
      input: s.object({
        url: s.string().describe("Repository URL").optional(),
        parent: s.string().describe("Folder to clone into (a new subfolder is made)").optional(),
        open: s.boolean().describe("Open the clone as the workspace").optional(),
      }),
      effects: ["write", "network"],
      agent: "discoverable",
      run: async ({ url, parent, open }) => {
        const target =
          url ??
          (await quickInput.prompt({
            prompt: "Repository URL",
            placeholder:
              "owner/repo, https://github.com/owner/repo or git@github.com:owner/repo.git",
            validate: (v) =>
              !v.trim()
                ? "Enter a URL."
                : v.trim().startsWith("-")
                  ? "That isn't a repository URL."
                  : undefined,
          }));
        if (!target?.trim()) return { path: null };
        const remote = normalizeCloneUrl(target);
        // The picker starts in git.defaultCloneDirectory (VS Code's setting), else the last one.
        const preset = settings.peek<string>("git.defaultCloneDirectory") || undefined;
        const into =
          parent ??
          (await dialogIpc.pickFolder("Choose a folder to clone into", preset ?? lastParent));
        if (!into) return { path: null };
        lastParent = into;
        const busy = services.views.progress("explorer.view", `Cloning ${target}`, 0);
        let last = "";
        const progress = signal("");
        const line = sub.add(
          statusBar.add({
            id: "git.cloneProgress",
            name: "Clone progress",
            alignment: "left",
            priority: 95,
            text: () => `$(cloud-download) ${progress.value || "Cloning…"}`,
            tooltip: () => `Cloning ${target}`,
          }),
        );
        try {
          const path = await gitIpc.clone(remote, into, (l) => {
            last = l;
            progress.value = l.length > 60 ? `${l.slice(0, 59)}…` : l;
          });
          if (open) await dispatcher.execute("workspace.openFolder", { path });
          else
            services.notifications.show("info", `Cloned into ${path}`, {
              actions: [
                {
                  label: "Open",
                  run: () =>
                    void dispatcher.execute("workspace.openFolder", { path }).catch(() => {}),
                },
              ],
            });
          return { path };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const full = cloneErrorHint(
            last && !message.includes(last) ? `${message}\n${last}` : message,
          );
          services.notifications.show("error", `Clone failed: ${full}`);
          throw new Error(full);
        } finally {
          busy.dispose();
          line.dispose();
        }
      },
    }),
  );

  // ---- Blame of the cursor line -------------------------------------------------------------
  const current = signal<{ path: string; line: number; blame: BlameLine } | null>(null);
  const enabled = () => settings.peek<boolean>("git.blame.statusBarItem.enabled") !== false;
  const inline = () => settings.peek<boolean>("git.blame.editorDecoration.enabled") === true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let token = 0;
  sub.add({ dispose: () => clearTimeout(timer) });
  const activePath = (): string | null => {
    const tab = dock.activeTab();
    const p = tab?.viewType === "editor" ? stateField(tab.viewState, "path") : undefined;
    return typeof p === "string" ? p : null;
  };
  const lookup = async (path: string, line: number) => {
    const mine = ++token;
    // The repository the file is in (D204: nested ones and submodules too).
    const repo = repos.forPath(path);
    const root = repo?.repo.peek()?.root;
    if ((!enabled() && !inline()) || !repo || !root || !isWithin(root, path)) {
      current.value = null;
      return;
    }
    const text = documents.text(path);
    try {
      const blame = await repo.ipc.blame(
        path,
        line,
        text !== null && text.length <= MAX_BLAME_CHARS ? text : undefined,
      );
      if (mine === token) current.value = { path, line, blame };
    } catch {
      // Untracked, ignored, binary or a new file: nothing to show.
      if (mine === token) current.value = null;
    }
  };
  sub.add(
    documents.onDidScroll(({ path, cursor }) => {
      const line = cursor + 1;
      const shown = current.peek();
      if (shown && shown.path === path && shown.line === line) return;
      clearTimeout(timer);
      timer = setTimeout(() => void lookup(path, line), 300);
    }),
  );
  // A commit or checkout changes what blame says; leaving the editor hides it.
  let firstStatus = true;
  sub.add(
    effect(() => {
      for (const r of repos.all.value) r.status.value;
      if (firstStatus) {
        firstStatus = false;
        return undefined;
      }
      const shown = current.peek();
      if (shown) void lookup(shown.path, shown.line);
      return undefined;
    }),
  );
  // Inline blame (VS Code's git.blame.editorDecoration.enabled, D127): the same answer as faint
  // text after the cursor's line, in the editor showing it.
  sub.add(
    effect(() => {
      const b = current.value;
      settings.version.value;
      dock.root.value;
      if (!b || !inline() || b.path !== activePath()) {
        documents.annotate(null);
        return undefined;
      }
      const summary = b.blame.committed
        ? ` • ${b.blame.summary.length > 40 ? `${b.blame.summary.slice(0, 39)}…` : b.blame.summary}`
        : "";
      documents.annotate({
        path: b.path,
        line: b.line,
        text: `\u2003\u2003${blameLabel(b.blame)}${summary}`,
      });
      return undefined;
    }),
  );
  sub.add({ dispose: () => documents.annotate(null) });
  sub.add(
    dispatcher.register({
      id: "git.toggleInlineBlame",
      title: "Toggle inline blame",
      category: "Git",
      description:
        "Shows or hides who last changed the cursor's line as faint text at the end of the line (git.blame.editorDecoration.enabled).",
      input: s.empty(),
      effects: ["write"],
      run: async () => {
        const next = !inline();
        await settings.update("git.blame.editorDecoration.enabled", next, "user");
        return { enabled: next };
      },
    }),
  );
  sub.add(
    statusBar.add({
      id: "git.blame",
      name: "Git blame",
      alignment: "left",
      priority: 85,
      text: () => {
        const b = current.value;
        dock.root.value;
        return b && enabled() && b.path === activePath()
          ? `$(git-commit-horizontal) ${blameLabel(b.blame)}`
          : "";
      },
      tooltip: () => {
        const b = current.value?.blame;
        if (!b) return "";
        if (!b.committed) return "This line has changes that aren't committed yet.";
        const date = new Date(b.time * 1000).toLocaleString();
        return `${b.author} <${b.authorMail}> · ${date}\n${b.summary}\n${b.hash.slice(0, 10)}`;
      },
      command: "git.blameLine",
    }),
  );
  sub.add(
    dispatcher.register({
      id: "git.blameLine",
      title: "Show who changed this line",
      category: "Git",
      description:
        "Who last changed a line (git blame): author, email, time, commit summary and hash. Default: the active editor's cursor line.",
      input: s.object({
        path: s.string().describe("File (default: the active editor)").optional(),
        line: s.integer({ min: 1 }).describe("1-based line (default: the cursor's)").optional(),
      }),
      effects: ["read"],
      agent: "discoverable",
      when: "gitRepo",
      run: async ({ path, line }) => {
        const shown = current.peek();
        const file = path ? workspace.resolve(path) : shown?.path;
        const at = line ?? shown?.line;
        if (!file || !at) throw new Error("No line to blame: open a file in a git repository.");
        const text = documents.text(file);
        const b = await (repos.forPath(file)?.ipc ?? gitIpc).blame(file, at, text ?? undefined);
        if (!path && !line)
          services.notifications.show(
            "info",
            b.committed
              ? `${b.author}, ${blameAge(b.time)}: ${b.summary} (${b.hash.slice(0, 7)})`
              : "This line isn't committed yet.",
            b.committed
              ? {
                  actions: [
                    {
                      label: "Copy hash",
                      run: () => void clipboardIpc.writeText(b.hash).catch(() => {}),
                    },
                  ],
                }
              : {},
          );
        return { path: file, line: at, ...b, age: b.committed ? blameAge(b.time) : null };
      },
    }),
  );
}

// The chat itself in a git worktree (D337, Claude Code's EnterWorktree / ExitWorktree): the
// branch a new one gets, what a chat saves about it, and what leaving with `remove` would lose.
// DOM-free; the tools and the header's branch button are extensions/agent/chatWorktrees.ts.

/** A chat working in a worktree: its tools act there instead of the window's folder. */
export interface ChatWorktree {
  folder: string;
  branch: string;
  /** Its record in the worktree agents' list (review and merge go by it): the chat's id. */
  agent: string;
  /** The window's folder it came from. */
  from: string;
  /** Made by enter_worktree (exit_worktree may remove it); false: an existing one entered by path. */
  created: boolean;
}

/** Where the chat's worktrees' branches go (the worktree agents' prefix). */
export const CHAT_WORKTREE_PREFIX = "agent/";

/**
 * The branch for `name` ("fix login" → agent/fix-login): letters, digits, dots, underscores and
 * dashes, in at most 64 characters; none given: agent/chat-<id>. An error message for a name with
 * nothing usable in it.
 */
export function chatWorktreeBranch(
  name: unknown,
  id: string,
): { branch: string } | { error: string } {
  if (name === undefined || name === null || (typeof name === "string" && !name.trim()))
    return { branch: `${CHAT_WORKTREE_PREFIX}chat-${id.replace(/[^A-Za-z0-9]/g, "").slice(-8)}` };
  if (typeof name !== "string") return { error: "name must be a string." };
  const slug = name
    .trim()
    .replace(new RegExp(`^${CHAT_WORKTREE_PREFIX}`), "")
    .split("/")
    .map((part) =>
      part
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^[-.]+|[-.]+$/g, "")
        .replace(/\.{2,}/g, "."),
    )
    .filter(Boolean)
    .join("/")
    .slice(0, 64)
    .replace(/[/.-]+$/, "");
  if (!slug)
    return { error: `"${name}" has nothing a branch name can use (letters, digits, . _ -).` };
  return { branch: `${CHAT_WORKTREE_PREFIX}${slug}` };
}

/** A chat's saved worktree (meta.worktree), when it's well formed. */
export function parseChatWorktree(raw: unknown): ChatWorktree | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === "string" && r[k] ? (r[k] as string) : null);
  const folder = str("folder");
  const branch = str("branch");
  const agent = str("agent");
  const from = str("from");
  if (!folder || !branch || !agent || !from) return null;
  return { folder, branch, agent, from, created: r.created === true };
}

/** Lines of `git status --porcelain` (one per changed or untracked file). */
export function changedFiles(porcelain: string): number {
  return porcelain.split(/\r?\n/).filter((l) => l.trim()).length;
}

/**
 * What removing the worktree would lose, for the question asked first: null when nothing (no
 * uncommitted change and no commit the branch has beyond where it started).
 */
export function removalLoss(opts: { changed: number; commits: number }): string | null {
  const parts: string[] = [];
  if (opts.changed > 0)
    parts.push(`${opts.changed} uncommitted ${opts.changed === 1 ? "change" : "changes"}`);
  if (opts.commits > 0)
    parts.push(`${opts.commits} ${opts.commits === 1 ? "commit" : "commits"} not merged`);
  return parts.length ? `It has ${parts.join(" and ")}: removing it deletes them.` : null;
}

/** What enter_worktree tells the model. */
export function enteredText(w: ChatWorktree, setupNote = ""): string {
  return `You're now working in a git worktree: ${w.folder} (branch ${w.branch}, ${w.created ? "new, " : ""}from ${w.from}). Your file tools, searches and run_command act there from now on (paths relative to it); the open folder isn't touched. IDE commands through call_command that act on files, editors, git or terminals still reach the window's folder and are refused. Commit your work there with git. When you're done, call exit_worktree: keep leaves the branch for the user to review and merge, remove deletes it.${setupNote}`;
}

/** What exit_worktree tells the model. */
export function leftText(w: ChatWorktree, action: "keep" | "remove"): string {
  return action === "remove"
    ? `Removed the worktree ${w.folder} and its branch ${w.branch}. Your tools work in ${w.from} again.`
    : `Left the worktree; your tools work in ${w.from} again. The branch ${w.branch} and its folder stay: the user can review and merge it (the branch button in the chat's header, or agent.compareWorktrees / agent.applyWorktree with agent "${w.agent}").`;
}

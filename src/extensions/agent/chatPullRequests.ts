// Pull requests from a chat (D227, Claude Code's and Cursor's "create a PR"): Open pull request asks
// the chat's agent to commit the conversation's work on a branch and open the pull request with
// github.createPullRequest, the title and description written from the conversation. The chat
// links the pull request its agent opened (github.didCreatePullRequest): a card in the chat,
// `pullRequest` in ide://agent/session, kept with the chat.
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { newId } from "./ids";
import type { SessionManager } from "./sessions";

/** The message the agent gets (also for external agents: they may use `gh` instead). */
export function pullRequestPrompt(draft: boolean): string {
  return [
    `Open a ${draft ? "draft " : ""}pull request for the work in this conversation.`,
    "1. Check `git status` and the current branch. If this conversation's changes aren't committed, commit them with a clear message, on a new branch named after the work when the current branch is the repository's default branch. Ask me before committing changes this conversation didn't make.",
    `2. Open the pull request with the IDE command github.createPullRequest (through call_command) if you have it, otherwise with \`gh pr create\`: a short title, and a description written from this conversation: what changed and why, how it was checked, anything left to do${draft ? ", as a draft" : ""}.`,
    "3. Reply with the pull request's link.",
  ].join("\n");
}

/** Chats waiting for the pull request they asked for (callers that don't name a chat). */
const WAIT_MS = 30 * 60_000;

export function registerChatPullRequests(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
): void {
  const { dispatcher, events } = services;
  // Chat id → until when it waits. An MCP caller (an external agent) names no chat: its pull
  // request goes to the one chat waiting, never a guess between two.
  const waiting = new Map<string, number>();
  const onlyWaiting = (): string | null => {
    const now = Date.now();
    for (const [id, until] of waiting) if (until <= now) waiting.delete(id);
    return waiting.size === 1 ? ([...waiting.keys()][0] ?? null) : null;
  };

  sub.add(
    dispatcher.register({
      id: "agent.createPullRequest",
      title: "Open pull request from chat",
      category: "Agent",
      description:
        "Asks a chat's agent to commit the conversation's work on a branch and open a pull request whose title and description come from the conversation (github.createPullRequest). The chat links the pull request once it's opened (ide://agent/session pullRequest).",
      input: s.object({
        session: s.string().describe("Session id (default: the active session)").optional(),
        draft: s.boolean().describe("A draft pull request").optional(),
      }),
      effects: ["write", "network"],
      when: "gitRepo",
      agent: "hidden",
      run: async ({ session, draft }, ctx) => {
        const target = session
          ? sessions.get(session)
          : (sessions.find(undefined) ?? sessions.get());
        if (!target.items.some((i) => i.type === "user" && !i.auto))
          throw new Error("The chat has no work yet: ask the agent for a change first.");
        waiting.set(target.id, Date.now() + WAIT_MS);
        await ctx.execute("agent.send", {
          message: pullRequestPrompt(draft === true),
          session: target.id,
          wait: false,
        });
        return { session: target.id, asked: true };
      },
    }),
  );

  sub.add(
    events.on("github.didCreatePullRequest", ({ number, url, title, caller }) => {
      // The chat whose agent opened it; an external agent calls through MCP (no chat named):
      // the chat that asked for one, when only one is waiting.
      const id =
        caller.kind === "agent" || caller.kind === "acp"
          ? caller.session
          : caller.kind === "mcp"
            ? onlyWaiting()
            : null;
      const target = id ? sessions.all().find((x) => x.id === id) : undefined;
      if (!target) return;
      waiting.delete(target.id);
      target.pullRequest.value = { number, url, title };
      target.items.push({
        type: "notice",
        id: newId("n"),
        text: `Opened pull request${number ? ` #${number}` : ""}: ${title}${url ? ` (${url})` : ""}`,
        tone: "info",
      });
      target.bump();
    }),
  );
}

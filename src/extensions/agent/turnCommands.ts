// The commands behind the turn tools' cards (D301–D303): a wrap-up box's app action, a proposed
// task started in a new chat or dismissed, and jumping to a chapter of the chat.
import {
  chaptersOf,
  proposalOf,
  TASK_DISMISSED,
  TASK_STARTED,
  WRAP_UP_ACTIONS,
} from "../../core/agent/turnTools";
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import type { AgentSession } from "./session";
import type { SessionManager } from "./sessions";

type ToolItem = Extract<AgentSession["items"][number], { type: "tool" }>;

/** Proposed tasks whose new chat is being opened (by the proposal's item id). */
const startingTasks = new Set<string>();

export function registerTurnCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
): void {
  const { dispatcher } = services;
  const register: typeof dispatcher.register = (c) =>
    sub.add(dispatcher.register({ category: "Agent", ...c }));
  const sessionInput = s.string().describe("Session id (default: the active session)").optional();

  /** The chat's proposed task `item` (propose_task's task_id). */
  const taskOf = (session: string | undefined, item: string) => {
    const target = sessions.require(session);
    const it = target.items.find(
      (i): i is ToolItem => i.type === "tool" && i.name === "propose_task" && i.id === item,
    );
    const task = it ? proposalOf(it) : null;
    if (!it || !task) throw new Error(`No proposed task ${item} in this chat.`);
    return { target, it, task };
  };

  register({
    id: "agent.runWrapUpAction",
    title: "Run a wrap-up action",
    description:
      "Runs an app action of the agent's wrap-up box (D301): review (opens the chat's changes), keep_all (keeps them all), commit (Source Control with a written message), create_pr (agent.createPullRequest), new_chat, archive (the chat).",
    input: s.object({ session: sessionInput, action: s.enum(WRAP_UP_ACTIONS) }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ session, action }, ctx) => {
      const target = sessions.require(session);
      const id = target.id;
      switch (action) {
        case "review":
          return ctx.execute("agent.review", { session: id });
        case "keep_all":
          return ctx.execute("agent.acceptAll", { session: id });
        case "commit":
          // Like VS Code's: the message is written into the box, the user commits.
          await ctx.execute("git.showView", {});
          if (dispatcher.info("git.generateCommitMessage")?.enabled)
            return ctx.execute("git.generateCommitMessage", {});
          return { shown: true };
        case "create_pr":
          return ctx.execute("agent.createPullRequest", { session: id });
        case "new_chat":
          return ctx.execute("agent.newSession", {});
        case "archive":
          return ctx.execute("agent.archiveSession", { session: id, archived: true });
      }
    },
  });

  register({
    id: "agent.startTask",
    title: "Start a proposed task",
    description:
      "Starts a task the agent proposed (its card, D303) in a new chat: the task's brief is the new chat's first message. `item`: the proposal's id (ide://agent/session proposals).",
    input: s.object({ session: sessionInput, item: s.string().describe("The proposal's id") }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ session, item }, ctx) => {
      const { target, it, task } = taskOf(session, item);
      if (it.summary === TASK_STARTED && it.detail) {
        await ctx.execute("agent.openThread", { session: it.detail });
        return { session: it.detail, started: false };
      }
      // A double click starts it once: the second came while the new chat was being opened.
      if (startingTasks.has(it.id)) return { started: false };
      startingTasks.add(it.id);
      try {
        const made = (await ctx.execute("agent.newSession", {})) as
          | { session?: string }
          | undefined;
        const chat = made?.session;
        if (!chat) throw new Error("Couldn't open a new chat.");
        it.summary = TASK_STARTED;
        it.detail = chat;
        target.bump();
        void target.save();
        await ctx.execute("agent.send", { session: chat, message: task.brief, wait: false });
        return { session: chat, started: true };
      } finally {
        startingTasks.delete(it.id);
      }
    },
  });

  register({
    id: "agent.dismissTask",
    title: "Dismiss a proposed task",
    description: "Dismisses a task the agent proposed (its card, D303).",
    input: s.object({ session: sessionInput, item: s.string().describe("The proposal's id") }),
    effects: [],
    agent: "hidden",
    run: async ({ session, item }) => {
      const { target, it } = taskOf(session, item);
      if (it.summary === TASK_STARTED) throw new Error("That task was started already.");
      it.summary = TASK_DISMISSED;
      target.bump();
      void target.save();
      return { dismissed: true };
    },
  });

  register({
    id: "agent.showChapter",
    title: "Go to chapter",
    description:
      "Scrolls the chat to one of its chapters (the agent's mark_chapter dividers, D302): `chapter` is its number (1 = the first), its title, or its id (ide://agent/session chapters).",
    input: s.object({
      session: sessionInput,
      chapter: s.string().describe("Number, title or id"),
    }),
    effects: [],
    agent: "hidden",
    run: async ({ session, chapter }, ctx) => {
      const target = sessions.require(session);
      const all = chaptersOf(target.items);
      const wanted = chapter.trim().toLowerCase();
      const n = Number(wanted);
      const found =
        (Number.isInteger(n) && n > 0 ? all[n - 1] : undefined) ??
        all.find((c) => c.id === chapter || c.title.toLowerCase() === wanted);
      if (!found)
        throw new Error(
          all.length
            ? `No chapter ${chapter}: ${all.map((c, i) => `${i + 1}. ${c.title}`).join(", ")}.`
            : "This chat has no chapters.",
        );
      await ctx.execute("agent.showMessage", { session: target.id, item: found.id });
      return { chapter: found.title };
    },
  });
}

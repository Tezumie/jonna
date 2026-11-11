// The built-in slash commands that act on a chat instead of sending a message (D389), after
// Claude Code's: /undo, /rewind, /fork, /resume, /rename, /export, /copy, /context, /usage,
// /effort, /plan, /todos, /tasks, /security-review, /memory, /agents, /skills, /rules, /mcp,
// /hooks, /permissions, /add-dir, /config, /help, /release-notes, /bug and /btw. Most open the
// page or run the command the IDE already has; each goes through the dispatcher as the caller.
// The list itself (names, other names, descriptions) is BUILTIN_COMMANDS in slashCommands.ts.
import type { Caller } from "../../core/dispatcher/types";
import type { DisposableStore } from "../../core/lifecycle/index";
import { s as schema } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { runSideQuestion } from "./btw";
import { newId } from "./ids";
import type { ProviderRegistry } from "./providers";
import type { AgentSession } from "./session";
import type { SessionManager } from "./sessions";
import { BUILTIN_COMMANDS, sessionSlash } from "./slashCommands";

const EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"] as const;

export function registerSlashBuiltins(
  sub: DisposableStore,
  services: WorkbenchServices,
  providers: ProviderRegistry,
  sessions: SessionManager,
): void {
  const { dispatcher, quickInput, settings } = services;
  const exec = (caller: Caller, command: string, input: unknown = {}) =>
    dispatcher.execute(command, input, caller) as Promise<Record<string, unknown> | undefined>;
  const opens =
    (command: string, input: (s: AgentSession) => unknown = () => ({})) =>
    async (s: AgentSession, _args: string, caller: Caller) => ({
      opened: command,
      result: (await exec(caller, command, input(s))) ?? null,
    });
  const notice = (s: AgentSession, text: string) => {
    s.items.push({ type: "notice", id: newId("n"), text, tone: "info" });
    s.bump();
  };

  const handlers: Record<
    string,
    (s: AgentSession, args: string, caller: Caller) => Promise<Record<string, unknown>>
  > = {
    undo: async (s, _args, caller) => {
      if (s.busyNow()) throw new Error("The agent is working; stop it first.");
      if (!s.checkpoints.length) {
        notice(s, "Nothing to undo: the agent hasn't changed files in this chat.");
        return { undone: false };
      }
      const turn = Math.max(...s.checkpoints);
      return {
        undone: true,
        ...(await exec(caller, "agent.restoreCheckpoint", { session: s.id, turn })),
      };
    },
    rewind: async (s, args, caller) => {
      if (s.busyNow()) throw new Error("The agent is working; stop it first.");
      const mine = s.items.filter((i) => i.type === "user" && !i.auto) as {
        id: string;
        text: string;
      }[];
      if (!mine.length) throw new Error("There's no message of yours to go back to.");
      let item = args ? mine.find((m) => m.id === args)?.id : undefined;
      if (!item && caller.kind === "user") {
        const picked = await quickInput.pick(
          [...mine].reverse().map((m, i) => ({
            id: m.id,
            label: m.text.split("\n")[0]?.slice(0, 120) || "(attachments)",
            description: i === 0 ? "your latest message" : `${i + 1} messages back`,
          })),
          { placeholder: "Go back to before which message? (its files are put back too)" },
        );
        if (!picked) return { rewound: false };
        item = picked.id;
      }
      return {
        rewound: true,
        ...(await exec(caller, "agent.restoreToMessage", { session: s.id, ...(item && { item }) })),
      };
    },
    fork: opens("agent.forkSession", (s) => ({ session: s.id })),
    resume: opens("agent.showHistory"),
    rename: async (s, args, caller) =>
      (await exec(caller, "agent.renameSession", {
        session: s.id,
        ...(args && { title: args }),
      })) ?? {},
    export: opens("agent.exportMarkdown", (s) => ({ session: s.id })),
    copy: async (s, _args, caller) => {
      const last = [...s.items].reverse().find((i) => i.type === "assistant" && i.text.trim());
      if (last?.type !== "assistant") throw new Error("The agent hasn't answered yet.");
      await exec(caller, "ui.copyText", { text: last.text });
      return { copied: last.text.length };
    },
    context: async (s) => {
      const usage = s.usage.peek();
      const messages = s.items.filter((i) => i.type === "user" || i.type === "assistant").length;
      const tools = s.items.filter((i) => i.type === "tool").length;
      const fill =
        usage?.tokens && usage.limit
          ? `${usage.tokens.toLocaleString()} of ${usage.limit.toLocaleString()} tokens (${Math.round((usage.tokens / usage.limit) * 100)}%)`
          : "not measured yet (it is after the next answer)";
      const auto =
        settings.peek<boolean>("agent.autoCompact") === false
          ? "Automatic summaries are off (agent.autoCompact)."
          : "It's summarized by itself when nearly full.";
      notice(
        s,
        `Context: ${fill}. ${messages} messages, ${tools} tool calls. ${auto} /compact summarizes now; /clear starts afresh.`,
      );
      return { tokens: usage?.tokens ?? null, limit: usage?.limit ?? null, messages, tools };
    },
    usage: opens("agent.showUsage"),
    effort: async (s, args, caller) => {
      let level = args.toLowerCase();
      if (!level && caller.kind === "user") {
        const current = settings.peek<string>("agent.effort") || "default";
        const picked = await quickInput.pick(
          EFFORTS.map((e) => ({
            id: e,
            label: e === "default" ? "Default" : e[0]?.toUpperCase() + e.slice(1),
            description: e === current ? "now" : "",
          })),
          { placeholder: "How hard the model thinks (models that take it)" },
        );
        if (!picked) return { effort: current };
        level = picked.id;
      }
      if (!(EFFORTS as readonly string[]).includes(level))
        throw new Error(`Effort is one of ${EFFORTS.join(", ")}.`);
      await exec(caller, "settings.set", { key: "agent.effort", value: level });
      notice(s, `Effort: ${level}.`);
      return { effort: level };
    },
    plan: async (s, args, caller) => {
      await exec(caller, "agent.setChatMode", { session: s.id, mode: "plan" });
      if (args) await exec(caller, "agent.send", { session: s.id, message: args, wait: false });
      return { mode: "plan", ...(args && { sent: true }) };
    },
    todos: opens("agent.openPlan", (s) => ({ session: s.id })),
    tasks: opens("agent.showBackgroundTasks"),
    "security-review": async (s, args, caller) => {
      const model = s.model.peek();
      const focus = `Security: injection, authentication and authorization, secrets in code, unsafe input handling, dependency risks${args ? `; ${args}` : ""}.`;
      return (
        (await exec(caller, "agent.reviewChanges", {
          scope: "uncommitted",
          focus,
          ...(model && { model }),
        })) ?? {}
      );
    },
    memory: opens("agent.openMemory"),
    agents: opens("agent.showAgentConfig"),
    skills: opens("agent.showSkills"),
    rules: opens("agent.showRules"),
    mcp: opens("agent.showMcpPage"),
    hooks: opens("settings.open", () => ({ query: "@id:agent.hooks" })),
    permissions: opens("agent.showAutoApprove"),
    "add-dir": opens("workspace.addFolder"),
    config: opens("settings.open", () => ({ category: "Agent" })),
    help: opens("agent.showSlashCommands"),
    "release-notes": opens("help.showReleaseNotes"),
    bug: opens("help.reportProblem"),
    btw: async (s, args) => {
      if (!args) throw new Error("/btw needs a question: /btw <question>.");
      return runSideQuestion(services, providers, s, args);
    },
  };
  // The side question's ×, and any other notice that can go (D389).
  sub.add(
    dispatcher.register({
      id: "agent.dismissNotice",
      title: "Close a note in the chat",
      description:
        "Removes a note from a chat (a /btw side question and its answer): notes aren't part of the conversation the model sees.",
      input: schema.object({
        session: schema.string().describe("Session id (default: the active session)").optional(),
        item: schema.string().describe("The note's item id"),
      }),
      effects: [],
      agent: "hidden",
      palette: false,
      run: async ({ session, item }) => {
        const target = sessions.require(session);
        const before = target.items.length;
        target.items = target.items.filter((i) => !(i.id === item && i.type === "notice"));
        if (target.items.length === before) throw new Error("No such note in this chat.");
        target.bump();
        return { dismissed: item };
      },
    }),
  );
  for (const [name, run] of Object.entries(handlers)) {
    if (!BUILTIN_COMMANDS.some((c) => c.name === name))
      throw new Error(`/${name} isn't in BUILTIN_COMMANDS.`);
    sessionSlash.set(name, run);
  }
  sub.add({ dispose: () => sessionSlash.clear() });
}

// agent.* commands: every button in the panel is one of these (and agents/tests can drive them).
// Sending is in sendCommands.ts, reviewing changes in reviewCommands.ts, models and providers in
// modelCommands.ts, @-mentions' context in mentionContext.ts (D221).

import { customModeId, findCustomMode, modeAllows } from "../../core/agent/chatModes";
import { conversationMarkdown } from "../../core/agent/compact";
import { contextMentionCard } from "../../core/agent/mentions";
import { agentStoreIpc } from "../../core/ipc/agent";
import { indexIpc } from "../../core/ipc/fs";
import { openerIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { joinPath } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import type { QuickPickItem } from "../../ui/QuickInput";
import type { WorkbenchServices } from "../../workbench/services";
import { backgroundProcesses } from "./backgroundProcesses";
import { isThisWorkspace } from "./chatWorkspace";
import { askUndoFiles } from "./checkpointCommands";
import { extraMentionItems, extraSlashCommands, mentionSourceFor } from "./composerExtras";
import { customModes } from "./customModes";
import { agentIgnored } from "./ignore";
import { mainAgent } from "./mainAgent";
import { memoryFor } from "./memory";
import { MENTIONS } from "./mentionContext";
import { pickContextMention, symbolChoices } from "./mentions";
import { registerModelCommands } from "./modelCommands";
import { planBuildMessage } from "./planDocs";
import type { ProviderRegistry } from "./providers";
import { registerReviewCommands } from "./reviewCommands";
import { registerSendCommands } from "./sendCommands";
import type { SessionManager } from "./sessions";
import type { ChatMode } from "./sessionTypes";
import { slashCommands } from "./slashCommands";
import { subagentRuns } from "./subagentRuns";
import { showThreadTab } from "./threadTabs";
import { questionAnswers, skippedAnswers } from "./toolCardCommands";
import { normalizeUrl } from "./webFetch";

/**
 * Deletes a chat for good: stopped, its tabs closed, its transcript and checkpoints removed (also
 * a channel's chats when the channel is deleted, D270). Asks nothing: the command does.
 */
export async function deleteChat(
  services: WorkbenchServices,
  sessions: SessionManager,
  id: string,
): Promise<void> {
  const { dock } = services;
  // Stopped and never saved again: a turn unwinding after this would write it back.
  sessions.find(id)?.markDeleted();
  // Its background commands (dev servers, watchers) go with it (D201).
  backgroundProcesses.killSession(id);
  // And its subagents' transcripts in the Background tasks view (D326).
  subagentRuns.forgetSession(id);
  for (const t of dock.tabs("agent"))
    if ((t.viewState as { session?: string } | null)?.session === id)
      await dock.closeTab(t.id, true);
  // Its proposal diff tabs have nothing behind them any more.
  for (const t of dock.tabs("diff"))
    if ((t.viewState as { agent?: string } | null)?.agent === id) await dock.closeTab(t.id, true);
  sessions.forget(id);
  await agentStoreIpc.delete(id);
  sessions.changed();
}

export function registerAgentCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
  providers: ProviderRegistry,
): void {
  const { dispatcher, dock, quickInput, workspace } = services;
  const register: typeof dispatcher.register = (c) =>
    sub.add(dispatcher.register({ category: "Agent", ...c }));
  const sessionInput = s.string().describe("Session id (default: the active session)").optional();
  /** Opens (or focuses) the tab of session `id`. */
  const showSession = (id: string) => {
    const tab = dock
      .tabs("agent")
      .find((t) => (t.viewState as { session?: string } | null)?.session === id);
    if (tab) dock.activateTab(tab.id, true);
    else showThreadTab(dock, id);
    sessions.active.value = id;
  };

  registerSendCommands(register, services, sessions, providers, showSession);
  registerReviewCommands(register, services, sessions);

  register({
    id: "agent.openSession",
    title: "Open agent session",
    description:
      "Shows a saved or open agent session in its tab (the Chats list); without `session`, the most recently active saved chat.",
    input: s.object({ session: s.string().optional() }),
    effects: [],
    agent: "hidden",
    palette: false,
    run: async ({ session }) => {
      const id =
        session ??
        (await agentStoreIpc.list())
          .map((r) => ({
            id: r.id,
            updated: ((r.meta ?? {}) as { updated?: number }).updated ?? 0,
          }))
          .sort((a, b) => b.updated - a.updated)[0]?.id;
      if (!id) throw new Error("No saved chats.");
      sessions.get(id);
      showSession(id);
      return { session: id };
    },
  });

  register({
    id: "agent.newSession",
    title: "New agent session",
    description:
      "Opens a new, empty agent session tab (on the right) and focuses its message box; `side` opens it beside the chats, `newTab` in a tab of its own.",
    input: s.object({
      side: s.boolean().optional(),
      newTab: s.boolean().optional(),
    }),
    effects: [],
    agent: "hidden",
    run: ({ side, newTab }) => {
      const session = sessions.get();
      showThreadTab(dock, session.id, { ...(side && { side }), ...(newTab && { newTab }) });
      sessions.active.value = session.id;
      return { session: session.id };
    },
  });

  register({
    id: "agent.compact",
    title: "Summarize the conversation",
    description:
      "Replaces the session's conversation so far by a summary the model writes (goal, what was done, files, state, what's left), to free up context. Same as sending /compact [focus]. It also happens by itself when the context is nearly full (agent.autoCompact).",
    input: s.object({
      session: sessionInput,
      focus: s.string().describe("What the summary should keep in particular").optional(),
    }),
    effects: [],
    agent: "hidden",
    run: async ({ session, focus }) => {
      const target = session ? sessions.get(session) : (sessions.find(undefined) ?? sessions.get());
      const { count } = await target.compact(focus);
      return { session: target.id, compacted: count };
    },
  });

  register({
    id: "agent.slash",
    title: "Agent: run a slash command…",
    description: `Lists the slash commands for the agent: the built-ins (/compact, /clear, /btw, /undo, /model, /review, /init… Claude Code's, with their other names), the prompt files in <workspace folder>/commands, .claude/commands, .cursor/commands and the user's own (<config>/commands, ~/.claude/commands), running MCP servers' prompts as /mcp__<server>__<prompt>, and an external agent's own commands. With \`pick\` (the default when a person runs it) the chosen one goes into the session's message box.`,
    input: s.object({ session: sessionInput, pick: s.boolean().optional() }),
    effects: [],
    agent: "hidden",
    run: async ({ session, pick }, ctx) => {
      const target = session ? sessions.get(session) : (sessions.find(undefined) ?? sessions.get());
      const own = await slashCommands(services);
      // Plus MCP prompts and an external agent's own commands (D200).
      const extra = (await extraSlashCommands(target)).filter(
        (c) => !own.some((o) => o.name === c.name),
      );
      const list = [...own, ...extra];
      if (pick === false || ctx.caller.kind === "test") return { commands: list };
      const chosen = await quickInput.pick(
        list.map((c) => ({
          id: c.name,
          label: `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}`,
          description: `${c.description} · ${c.source}`,
        })),
        { placeholder: "Run a command" },
      );
      target.draft.value = chosen ? `/${chosen.id} ` : "/";
      return { commands: list, picked: chosen?.id ?? null };
    },
  });

  register({
    id: "agent.exportMarkdown",
    title: "Export conversation as Markdown",
    description:
      "Opens the session's conversation as a Markdown document (messages, and one line per tool call); `copy` puts it on the clipboard instead.",
    input: s.object({ session: sessionInput, copy: s.boolean().optional() }),
    effects: [],
    agent: "hidden",
    run: async ({ session, copy }, ctx) => {
      const target = sessions.require(session);
      const text = conversationMarkdown(target.title.peek(), target.items);
      if (copy) await ctx.execute("ui.copyText", { text });
      else
        await ctx.execute("editor.openReadOnly", {
          title: `${target.title.peek().slice(0, 40) || "Session"}.md`,
          content: text,
        });
      return { chars: text.length };
    },
  });

  register({
    id: "agent.dream",
    title: "Tidy up agent memory",
    description: `Has the model curate the project memory (<workspace folder>/memory) using the sessions since the last tidy-up: fixes outdated notes, merges duplicates, adds lessons the sessions show. The result is proposed as changes in a new session, for review; nothing changes until accepted.`,
    input: s.object({
      focus: s.string().describe("What to pay attention to").optional(),
      wait: s.boolean().optional(),
      background: s
        .boolean()
        .describe("Don't show the chat; say when the result is ready to review (D193)")
        .optional(),
    }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ focus, wait, background }) => {
      const target = sessions.get();
      // Its own model when one is set (Models for each feature, D194).
      const own = services.settings.peek<string>("agent.memory.model");
      if (own && (providers.find(own) ?? providers.models.peek().find((m) => m.model === own)))
        target.model.value = providers.find(own)?.key ?? own;
      if (!background) {
        showThreadTab(dock, target.id);
        sessions.active.value = target.id;
      }
      const job = memoryFor(services).dream(target, focus);
      if (background) {
        void job
          .then(({ files }) => {
            if (!files) return;
            services.notifications.show(
              "info",
              `The agent tidied up its memory: ${files} file${files === 1 ? "" : "s"} to review. Nothing changes until you accept.`,
              {
                title: "Agent memory",
                actions: [
                  {
                    label: "Review",
                    run: () => {
                      showThreadTab(dock, target.id);
                      sessions.active.value = target.id;
                    },
                  },
                ],
              },
            );
          })
          .catch(() => {});
        return { session: target.id };
      }
      if (wait === false) {
        void job.catch(() => {});
        return { session: target.id };
      }
      const { files, sessions: read } = await job;
      return { session: target.id, files, sessions: read };
    },
  });

  register({
    id: "agent.openMemory",
    title: "Show agent memory",
    description: `Shows the project memory folder (<workspace folder>/memory) in the explorer.`,
    input: s.empty(),
    effects: [],
    agent: "hidden",
    run: async (_input, ctx) => {
      const memory = memoryFor(services);
      const dir = memory.dir();
      if (!dir) throw new Error("No folder is open.");
      const files = await memory.files();
      if (!files.length)
        throw new Error(
          "No memory yet: the agent saves notes there as it learns about the project.",
        );
      await ctx.execute("explorer.reveal", { path: memory.path(files[0]?.name ?? "") });
      return { folder: dir, files: files.map((f) => f.name) };
    },
  });

  register({
    id: "agent.retry",
    title: "Retry the last answer",
    description:
      'Regenerates a session\'s last answer: drops everything after your last message and sends it again. `files`: "undo" first puts back the files the agent changed since that message (its checkpoint), "keep" leaves them; asked when a person retries a turn that changed files.',
    input: s.object({
      session: sessionInput,
      wait: s.boolean().optional(),
      files: s.enum(["undo", "keep"] as const).optional(),
    }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ session, wait, files }, ctx) => {
      const target = sessions.require(session);
      // A second click while the first one's turn runs does nothing (no "still working" toast).
      if (target.busyNow()) return { session: target.id, busy: true };
      const last = target.lastUserMessage();
      const undo =
        files ??
        (ctx.caller.kind === "user" && last
          ? await askUndoFiles(target, last.turn, "Retry")
          : "keep");
      if (undo === "cancel") return { session: target.id, cancelled: true };
      const done = target.retry({ undoFiles: undo === "undo" });
      if (wait === false) {
        done.catch(() => {});
        return { session: target.id };
      }
      await done;
      return { session: target.id, error: target.error.peek() };
    },
  });

  register({
    id: "agent.addContext",
    title: "Add file to chat",
    description:
      "Attaches files to the next message of the active agent session (shown as chips above the message box; their text is sent with the message). Opens the agent panel.",
    input: s.object({
      paths: s.array(s.string()).describe("Files, absolute or workspace-relative"),
      session: sessionInput,
    }),
    effects: [],
    agent: "hidden",
    run: ({ paths, session }) => {
      const target = session ? sessions.get(session) : (sessions.find(undefined) ?? sessions.get());
      showSession(target.id);
      const next = [...target.attachments.peek()];
      for (const p of paths) {
        // Workspace-relative: "api/src/x.ts" names a folder of a multi-root workspace (D251).
        const abs = workspace.resolve(p);
        if (!next.includes(abs)) next.push(abs);
      }
      target.attachments.value = next;
      return { session: target.id, attachments: next };
    },
  });

  register({
    id: "agent.compose",
    title: "Start a message to the agent",
    description:
      "Opens the agent panel with `text` in the message box (not sent), for the user to finish and send — e.g. the extension page's Edit with agent.",
    input: s.object({ text: s.string(), session: sessionInput }),
    effects: [],
    agent: "hidden",
    run: ({ text, session }) => {
      const target = session ? sessions.get(session) : (sessions.find(undefined) ?? sessions.get());
      target.draft.value = text;
      showSession(target.id);
    },
  });
  /**
   * What "@" offers for `query` (the picker's list and the composer's inline list, D389): a typed
   * web address first, then MCP resources and web searches, the specials (@problems, @git…),
   * files from the index and symbols by name.
   */
  const mentionItems = async (query: string): Promise<QuickPickItem[]> => {
    const root = workspace.root.peek() ?? "";
    const specials = MENTIONS.map((m) => ({
      id: m.id,
      label: m.label,
      description: m.description,
      icon: m.icon,
    }));

    // A typed address (http…, www…, or "web <address>") offers that page first; a bare
    // "readme.md" stays a file search.
    const asked = /^@?web\s+/i.test(query.trim());
    const typed = query.trim().replace(/^@?web\s+/i, "");
    let url: string | null = null;
    if (typed && !/\s/.test(typed) && (asked || /^(https?:\/\/|www\.)/i.test(typed)))
      try {
        url = normalizeUrl(typed);
      } catch {}
    const page = url
      ? [
          {
            id: `@web ${url}`,
            label: url,
            description: "Web page: its text goes with the message",
            icon: "globe" as const,
          },
        ]
      : [];
    const q = query.toLowerCase().replace(/^@/, "");
    const extra = specials.filter(
      (m) => !q || m.label.toLowerCase().includes(q) || m.id.includes(q),
    );
    if (!root) return extra;
    const files = q
      ? (
          await indexIpc
            .query(q, 40)
            .catch(() => ({ items: [] as { path: string; root?: string }[] }))
        ).items.map((f) => {
          // As the workspace writes it ("api/src/x.ts" outside the first folder, D251).
          const shown = f.root ? workspace.relative(joinPath(f.root, f.path)) : f.path;
          return {
            id: shown,
            label: f.path.split("/").pop() ?? f.path,
            description: shown,
            icon: "file" as const,
          };
        })
      : [];
    // MCP resources and web searches, then functions, classes and types by name (D200).
    const more = await extraMentionItems(query);
    const symbols = await symbolChoices(services, query).catch(() => []);
    return [...page, ...more, ...extra, ...files, ...symbols];
  };

  register({
    id: "agent.mentionItems",
    title: "What @ offers",
    description:
      "What typing @ in the message box offers for `query`: files, @problems, @git and the other context mentions, web addresses, MCP resources and symbols (agent.mention adds one).",
    input: s.object({ query: s.string().describe("What follows the @") }),
    effects: ["read"],
    agent: "hidden",
    palette: false,
    run: async ({ query }) => ({ items: await mentionItems(query) }),
  });

  register({
    id: "agent.mention",
    title: "Mention in chat…",
    description:
      "Adds context to the next agent message, like typing @ in the message box: a file, @problems (errors and warnings), @terminal (the latest terminal commands and their output), @selection (the editor's selected text), `@web <url>` (a web page's text, fetched when the message is sent), `@web search <words>` (web search results), `@mcp <server> <uri>` (an MCP server's resource), @git (the uncommitted diff), `@commit <hash>` (a commit's message and diff), @branch (this branch against the default branch), `@chat <session id>` (another chat's transcript), @rules (every rules file) or `@symbol <path>:<line> <name>` (a definition's code). @commit, @chat and @symbol without their argument show a list when a person runs it. Without `mention`, shows a picker.",
    input: s.object({
      mention: s
        .string()
        .describe(
          "A file path, or @problems, @terminal, @selection, @web <url>, @git, @commit <hash>, @branch, @chat <id>, @rules, @symbol <path>:<line> <name>",
        )
        .optional(),
      session: sessionInput,
    }),
    effects: [],
    agent: "hidden",
    run: async ({ mention, session }, ctx) => {
      const target = session ? sessions.get(session) : (sessions.find(undefined) ?? sessions.get());
      let picked = mention;
      if (!picked) {
        const choice = await quickInput.pickDynamic({
          placeholder: "Mention a file, @problems, @terminal, @selection or a web address",
          load: async (query) => ({ items: await mentionItems(query) }),
        });
        if (!choice) return { session: target.id, attachments: target.attachments.peek() };
        picked = choice.id;
      }
      if (picked === "@web") {
        const address = await quickInput.prompt({
          prompt: "Web page to add as context",
          placeholder: "https://…",
        });
        if (!address?.trim()) return { session: target.id, attachments: target.attachments.peek() };
        picked = `@web ${normalizeUrl(address)}`;
      }
      const source = mentionSourceFor(picked);
      if (!source && /^@web\s+\S/.test(picked)) picked = `@web ${normalizeUrl(picked.slice(5))}`;
      // @commit, @chat and @symbol: which one (D200).
      if (/^@(commit|chat|symbol)$/.test(picked)) {
        if (ctx.caller.kind !== "user" && !mention?.includes(" "))
          throw new Error(`${picked} needs its argument (${picked} <…>).`);
        const detail = await pickContextMention(services, picked, target.id);
        if (!detail) return { session: target.id, attachments: target.attachments.peek() };
        picked = detail;
      }
      const value = picked.startsWith("@") ? picked : workspace.resolve(picked);
      if (!picked.startsWith("@") && agentIgnored(services, value))
        throw new Error(
          `${picked} is excluded from the agent (.aiignore, .cursorignore, agent.ignoreFiles or the default secret files).`,
        );
      if (
        picked.startsWith("@") &&
        !picked.startsWith("@web ") &&
        !source &&
        !contextMentionCard(picked) &&
        !MENTIONS.some((m) => m.id === picked)
      )
        throw new Error(`Unknown mention ${picked} (${MENTIONS.map((m) => m.id).join(", ")}).`);
      if (!target.attachments.peek().includes(value))
        target.attachments.value = [...target.attachments.peek(), value];
      return { session: target.id, attachments: target.attachments.peek() };
    },
  });

  register({
    id: "agent.continue",
    title: "Continue the agent's turn",
    description:
      "Picks a session's turn up where it stopped (after a provider error or Stop) without adding a message.",
    input: s.object({ session: sessionInput, wait: s.boolean().optional() }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ session, wait }) => {
      const target = sessions.require(session);
      if (target.busyNow()) return { session: target.id, busy: true };
      const done = target.continueTurn();
      if (wait === false) {
        done.catch(() => {});
        return { session: target.id };
      }
      await done;
      return { session: target.id, error: target.error.peek() };
    },
  });

  register({
    id: "agent.editMessage",
    title: "Edit a message",
    description:
      'Edits one of your messages in a session: without `text`, opens it for editing in the panel; with `text`, sends the new text (the conversation after it is replaced); `cancel` closes the editor. `files`: "undo" first puts back the files the agent changed since that message (its checkpoint), "keep" leaves them; asked when a person sends an edit of a turn that changed files.',
    input: s.object({
      session: sessionInput,
      item: s.string().describe("The message's item id (ide://agent/session items)"),
      text: s.string().optional(),
      cancel: s.boolean().optional(),
      wait: s.boolean().optional(),
      files: s.enum(["undo", "keep"] as const).optional(),
    }),
    effects: ["write"],
    agent: "hidden",
    palette: false,
    run: async ({ session, item, text, cancel, wait, files }, ctx) => {
      const target = sessions.require(session);
      if (cancel) {
        target.editing.value = null;
        return { editing: null };
      }
      if (text === undefined) {
        target.editing.value = item;
        return { editing: item };
      }
      const edited = target.items.find((i) => i.id === item);
      const undo =
        files ??
        (ctx.caller.kind === "user" && edited?.type === "user"
          ? await askUndoFiles(target, edited.turn, "Send")
          : "keep");
      // Cancel keeps the editor open with the new text.
      if (undo === "cancel") return { session: target.id, cancelled: true };
      target.editing.value = null;
      const done = target.resend(item, text, { undoFiles: undo === "undo" });
      // A resend that can't start keeps the edited text: back in the box (D159).
      const keep = () => {
        if (!target.draft.peek()) target.draft.value = text;
      };
      if (wait === false) {
        done.catch(keep);
        return { session: target.id };
      }
      try {
        await done;
      } catch (err) {
        keep();
        throw err;
      }
      return { session: target.id, error: target.error.peek() };
    },
  });

  register({
    id: "agent.stop",
    title: "Stop agent",
    description: "Stops the agent's current work (the model call and any running command).",
    input: s.object({ session: sessionInput }),
    effects: [],
    run: async ({ session }, ctx) => {
      const target = sessions.require(session);
      target.stop();
      // Stop also closes what the chat opened, when the user wants that (D179).
      if (services.settings.peek<boolean>("agent.closeOpenedOnStop") === true)
        await ctx.execute("agent.closeOpened", { session: target.id, quiet: true }).catch(() => {});
    },
  });

  register({
    id: "agent.answer",
    title: "Answer the agent's question",
    description:
      "Answers the question the agent is waiting on (its ask_user card, D171): the choice clicked or a typed answer in `text`, or with `answers` each of the card's questions (D312), keyed by question, header or number (a list for several picks); every question needs one. `skip: true` skips them all (D335: the model is told the user skipped).",
    input: s.object({
      session: sessionInput,
      text: s.string().describe("The answer").optional(),
      answers: s.unknown().describe('By question: { "Auth method": "OAuth" }').optional(),
      item: s.string().optional().describe("The question's tool call (default: the open one)"),
      skip: s.boolean().describe("Skip every question of the card").optional(),
    }),
    effects: [],
    agent: "hidden",
    run: ({ session, text, answers, item, skip }) => {
      const target = sessions.require(session);
      const answer = skip
        ? skippedAnswers(target, item)
        : answers === undefined
          ? (text ?? "")
          : questionAnswers(target, answers, item);
      if (!target.answer(answer, item)) throw new Error("The agent isn't waiting for an answer.");
      return { answered: true };
    },
  });

  register({
    id: "agent.unqueue",
    title: "Take back a queued message",
    description:
      "Takes back a message sent while the agent was working, before it reads it (D151): its text goes back into the message box.",
    input: s.object({ session: sessionInput, id: s.string().describe("The queued message's id") }),
    effects: [],
    agent: "hidden",
    run: ({ session, id }) => {
      const target = sessions.require(session);
      const taken = target.unqueue(id);
      if (!taken) throw new Error("That message was already sent to the agent.");
      target.returnQueued([taken]);
      return { text: taken.text };
    },
  });

  register({
    id: "agent.sendNow",
    title: "Send queued messages now",
    description:
      "Has the agent read the messages sent while it works now, not after its current step (D363): the reply it is writing, or the commands it is running, are cut short and its turn goes on with them. An external agent (it can't take a message mid-turn) has its turn cancelled and gets them as the next message.",
    input: s.object({ session: sessionInput }),
    effects: [],
    agent: "hidden",
    run: ({ session }) => {
      const target = sessions.require(session);
      if (!target.sendQueuedNow()) throw new Error("No message is waiting for the agent.");
      return { session: target.id };
    },
  });

  register({
    id: "agent.setMode",
    title: "Set agent edit mode",
    description:
      "Review edits (default: the agent's changes wait for you) or auto-apply (applied at once, checkpointed).",
    input: s.object({ session: sessionInput, autoApply: s.boolean() }),
    effects: [],
    agent: "hidden",
    run: ({ session, autoApply }) => {
      const target = sessions.require(session);
      target.autoApply.value = autoApply;
      // Remembered: new chats in this workspace start this way, and this chat keeps it.
      sessions.autoApply = autoApply;
      services.persistence.scheduleSave();
      void target.save();
    },
  });

  register({
    id: "agent.setChatMode",
    title: "Set agent mode",
    category: "Agent",
    description:
      "How the agent works in a chat (D180): agent (reads, edits files, runs commands), plan (researches read-only and writes a plan to Build), ask (answers read-only). These apply to whichever agent the chat is with (D249): Plan or Ask on one of the user's agents keeps its instructions with read-only tools. `custom:<name>` (ide://agent/chatModes) switches the chat to that agent instead, in the mode it starts in (as agent.setChatAgent).",
    input: s.object({
      session: sessionInput,
      mode: s.string().describe("agent, plan, ask or custom:<name>"),
    }),
    effects: [],
    agent: "hidden",
    run: ({ session, mode }) => {
      if (
        mode !== "agent" &&
        mode !== "plan" &&
        mode !== "ask" &&
        !findCustomMode(customModes.peek(), mode)
      )
        throw new Error(`No chat mode ${mode}: agent, plan, ask or one of ide://agent/chatModes.`);
      const target = session ? sessions.get(session) : (sessions.find(undefined) ?? sessions.get());
      if (mode === "agent" || mode === "plan" || mode === "ask") target.setWork(mode);
      else target.setAgent(mode as ChatMode);
      void target.save();
      return { mode: target.work(), agent: target.chatMode.peek() };
    },
  });
  register({
    id: "agent.setChatAgent",
    title: "Switch the chat's agent",
    category: "Agent",
    description:
      "Which agent a chat is with (D249): `agent` for the main agent, or one of the user's agents by name (ide://agent/chatModes without `custom:`). The chat takes the mode that agent starts in (its file's `mode:`: Planner plans, Chat answers; else Agent); agent.setChatMode changes it after. Its instructions, tools and model apply from the next message.",
    input: s.object({
      session: sessionInput,
      agent: s.string().describe('"agent" for the main agent, or an agent\'s name'),
    }),
    effects: [],
    agent: "hidden",
    run: ({ session, agent }) => {
      const mode = agent === "agent" ? "agent" : customModeId(agent.replace(/^custom:/, ""));
      if (mode !== "agent" && !findCustomMode(customModes.peek(), mode))
        throw new Error(`No agent named ${agent} (ide://agent/chatModes lists them).`);
      const target = session ? sessions.get(session) : (sessions.find(undefined) ?? sessions.get());
      if (target.members.peek().length)
        throw new Error("A group chat has its members: @mention one, or agent.addToChat.");
      target.setAgent(mode as ChatMode);
      void target.save();
      // On an external agent: its model follows the agent the chat is with now (D288).
      void target.syncExternalModel();
      return { agent: target.chatMode.peek(), mode: target.work() };
    },
  });
  register({
    id: "agent.chatWith",
    title: "Chat with an agent…",
    category: "Agent",
    description:
      "Starts a new chat with one of the user's agents (D230: its instructions, tools and model apply to the chat; ide://agent/chatModes lists them as custom:<name>), or with the main agent when `agent` is `agent`. Without `agent`, asks which. Returns the new chat's session id.",
    input: s.object({
      agent: s
        .string()
        .describe('The agent\'s name (id), or "agent" for the main agent')
        .optional(),
    }),
    effects: [],
    agent: "hidden",
    run: async ({ agent }) => {
      const agents = customModes.peek().filter((m) => m.agent);
      let name = agent;
      if (!name) {
        const picked = await services.quickInput.pick(
          [
            { id: "agent", label: mainAgent.peek().label, description: "The main agent" },
            ...agents.map((m) => ({
              id: m.name,
              label: m.agent?.label ?? m.name,
              description: m.agent?.role ?? "",
              detail: m.description,
            })),
          ],
          { placeholder: "Chat with which agent?" },
        );
        if (!picked) return null;
        name = picked.id;
      }
      const mode = name === "agent" ? "agent" : customModeId(name);
      if (mode !== "agent" && !findCustomMode(customModes.peek(), mode))
        throw new Error(`No agent named ${name} (Customize → Agents lists them).`);
      const session = sessions.get();
      session.setAgent(mode as ChatMode);
      // Named after the agent until the first reply names the chat.
      const label = findCustomMode(customModes.peek(), mode)?.agent?.label;
      if (label) session.title.value = label;
      showThreadTab(dock, session.id);
      sessions.active.value = session.id;
      return { session: session.id, mode };
    },
  });
  register({
    id: "agent.build",
    title: "Build the plan",
    category: "Agent",
    description:
      "Switches a chat from Plan to Agent mode and has the agent carry out the plan it wrote. An agent that can't edit files (the planner) hands it to the builder, or the main agent (D249).",
    input: s.object({ session: sessionInput }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ session }, ctx) => {
      const target = session ? sessions.get(session) : (sessions.find(undefined) ?? sessions.get());
      // An older plan's Build, once something was sent after it, would build a stale plan.
      const items = target.items;
      const notice = items.findLastIndex(
        (i) => i.type === "notice" && i.actions?.includes("build"),
      );
      if (notice < 0) throw new Error("There's no plan to build in this chat.");
      if (items.slice(notice).some((i) => i.type === "user"))
        throw new Error("That plan was already followed by another message: ask for a new plan.");
      const before = { mode: target.chatMode.peek(), work: target.workMode.peek() };
      // An agent that can't edit (the planner) hands the plan to the builder, else the main
      // agent (D249); one that can builds it itself, in Agent mode.
      const own = findCustomMode(customModes.peek(), target.chatMode.peek());
      if (own && !modeAllows(own, { name: "edit_file", readOnly: false }))
        target.setAgent(
          findCustomMode(customModes.peek(), customModeId("builder"))
            ? (customModeId("builder") as ChatMode)
            : "agent",
        );
      target.setWork("agent");
      try {
        return await ctx.execute("agent.send", {
          session: target.id,
          // D330: the plan file as it is now (the user's edits are what gets built).
          message: await planBuildMessage(target),
          wait: false,
        });
      } catch (err) {
        // The agent was busy: the mode stays as it was.
        target.chatMode.value = before.mode;
        target.workMode.value = before.work;
        target.nextTurnModel = null;
        throw err;
      }
    },
  });
  register({
    id: "agent.setCommandMode",
    title: "Set agent command approval",
    category: "Agent",
    description:
      "Whether the agent asks before running terminal commands (`ask`: unless allowlisted), runs them automatically (`auto`: deleting, killing, downloading, git push and agent.deniedCommands still ask), or never asks about anything (`full`: full access, D163). Saved in agent.runCommands.",
    input: s.object({ mode: s.enum(["ask", "auto", "full"]) }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ mode }) => {
      await services.settings.update("agent.runCommands", mode, "user");
      return { mode };
    },
  });

  register({
    id: "agent.deleteSession",
    title: "Delete agent session",
    description: "Deletes a session's transcript and checkpoints and closes its tab.",
    input: s.object({ session: sessionInput }),
    effects: ["destructive"],
    agent: "hidden",
    confirm: () => "Delete this agent session? Its conversation and checkpoints are removed.",
    run: async ({ session }) => {
      // A saved session that isn't loaded (the Chats list) is deleted from disk only.
      const id = sessions.find(session)?.id ?? session;
      if (!id) throw new Error("No agent session. Open one with Ctrl/Cmd+L.");
      await deleteChat(services, sessions, id);
    },
  });

  register({
    id: "agent.deleteSessions",
    title: "Delete agent sessions",
    description:
      "Deletes several sessions at once (D377: chats selected in the Chats list), asked once: their transcripts and checkpoints, and their tabs close.",
    input: s.object({ sessions: s.array(s.string()) }),
    effects: ["destructive"],
    agent: "hidden",
    palette: false,
    confirm: ({ sessions: ids }) =>
      `Delete ${ids.length} chat${ids.length === 1 ? "" : "s"}? Their conversations and checkpoints are removed.`,
    run: async ({ sessions: ids }) => {
      // Each one tried; the ones that couldn't be deleted are named (D379).
      const deleted: string[] = [];
      const failed: { session: string; error: string }[] = [];
      for (const id of ids) {
        try {
          await deleteChat(services, sessions, sessions.find(id)?.id ?? id);
          deleted.push(id);
        } catch (err) {
          failed.push({ session: id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      if (failed.length && !deleted.length)
        throw new Error(`No chat was deleted: ${failed[0]?.error ?? "unknown error"}`);
      return { deleted, ...(failed.length && { failed }) };
    },
  });

  register({
    id: "agent.showHistory",
    title: "Sessions…",
    description: "Lists saved agent sessions (newest first) to reopen one.",
    input: s.empty(),
    effects: [],
    agent: "hidden",
    run: async () => {
      const saved = await agentStoreIpc.list();
      const rows = saved
        .map((r) => ({
          id: r.id,
          meta: (r.meta ?? {}) as { title?: string; updated?: number; workspace?: string },
        }))
        .sort(
          (a, b) =>
            Number(isThisWorkspace(services, b.meta.workspace)) -
            Number(isThisWorkspace(services, a.meta.workspace)),
        );
      const picked = await quickInput.pick(
        [
          { id: "\u0000new", label: "New session", icon: "plus" as const },
          ...rows.map((r) => ({
            id: r.id,
            label: r.meta.title ?? "Session",
            description: `${r.meta.updated ? new Date(r.meta.updated).toLocaleString() : ""}${r.meta.workspace && !isThisWorkspace(services, r.meta.workspace) ? ` · ${r.meta.workspace}` : ""}`,
            icon: "agent" as const,
          })),
        ],
        { placeholder: "Open an agent session" },
      );
      if (!picked) return null;
      if (picked.id === "\u0000new") return dispatcher.execute("agent.newSession");
      sessions.get(picked.id);
      showSession(picked.id);
      return { session: picked.id };
    },
  });

  registerModelCommands(register, services, sessions, providers);

  register({
    id: "agent.respondPermission",
    title: "Answer an agent permission request",
    description:
      "Answers a pending permission request of a session (the inline card): once, always or deny. Without `id`: the oldest.",
    input: s.object({
      session: sessionInput,
      id: s.string().optional(),
      answer: s.enum(["once", "always", "deny"] as const),
    }),
    effects: [],
    agent: "hidden",
    palette: false,
    run: ({ session, id, answer }) => {
      const sess = sessions.require(session);
      const request = sess.permissions.peek().find((p) => !id || p.id === id);
      if (!request) throw new Error("No pending permission request.");
      request.resolve(answer);
    },
  });

  register({
    id: "agent.resolveChatConflict",
    title: "Resolve a chat changed in another window",
    description:
      "When the same chat was saved by another window since this one loaded it (D221), this window stops saving it. `keep: here` saves this window's chat over the other's; `keep: other` loads the saved chat in its place (what happened here since is dropped; not while the agent works).",
    input: s.object({ session: sessionInput, keep: s.enum(["here", "other"] as const) }),
    effects: ["write"],
    agent: "hidden",
    palette: false,
    run: async ({ session, keep }) => {
      const target = sessions.require(session);
      if (!target.conflict.peek()) return { conflict: false };
      await target.resolveConflict(keep);
      sessions.changed();
      return { conflict: target.conflict.peek(), kept: keep };
    },
  });

  register({
    id: "agent.openLink",
    title: "Open link",
    description:
      "Opens a link from the conversation: local dev-server addresses in the IDE's browser (beside), others in the system browser.",
    input: s.object({ url: s.string() }),
    effects: [],
    agent: "hidden",
    palette: false,
    run: async ({ url }) => {
      const local =
        /^http:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0|[\w-]+\.localhost)(:\d+)?(\/|$)/i.test(
          url,
        );
      if (local && services.dispatcher.has("browser.open"))
        return services.dispatcher.execute("browser.open", { url, toSide: true });
      return openerIpc.openUrl(url);
    },
  });
}

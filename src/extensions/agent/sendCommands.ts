// agent.send and agent.startInFolder (split from commands.ts in D221): a message with its
// attachments, @-mentions and slash commands goes to a session, or waits for a folder first.

import {
  countLines,
  previewOf,
  type SentAttachment,
  sentAttachment,
  uploadContext,
  viewText,
} from "../../core/agent/attachments";
import { pathInMessage, suggestFolderName } from "../../core/agent/projectFolder";
import { canonicalSlash } from "../../core/agent/slash";
import { fsIpc } from "../../core/ipc/fs";
import { appIpc, dialogIpc } from "../../core/ipc/system";
import { basename, dirname, joinPath, relativePath } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { readText } from "./changeset";
import { expandExtraSlash, extraSendContext } from "./composerExtras";
import { agentIgnored } from "./ignore";
import { mentionContext, mentionLabel } from "./mentionContext";
import { planEditContext } from "./planDocs";
import type { ProviderRegistry } from "./providers";
import { conversationRoom } from "./roomService";
import type { SessionManager } from "./sessions";
import { actionSlashFor, BUILTIN_COMMANDS, promptSlash, sessionSlashFor } from "./slashCommands";
import { showThreadTab } from "./threadTabs";

/** Sessions whose folder card is starting its request (a double click starts once). */
const startingFolder = new Set<string>();

export function registerSendCommands(
  register: WorkbenchServices["dispatcher"]["register"],
  services: WorkbenchServices,
  sessions: SessionManager,
  providers: ProviderRegistry,
  /** Opens (or focuses) the tab of session `id`. */
  showSession: (id: string) => void,
): void {
  const { dock, workspace } = services;
  const sessionInput = s.string().describe("Session id (default: the active session)").optional();
  register({
    id: "agent.startInFolder",
    title: "Start the agent in a folder",
    description:
      'Answers a session\'s "where should I work?" card (a message sent with no folder open): `create` makes the folder `name` in `parent` and opens it; `open` opens `path` (or asks); `chat` sends without a folder; `cancel` drops the message. Then the waiting message is sent.',
    input: s.object({
      session: sessionInput,
      choice: s.enum(["create", "open", "chat", "cancel"] as const),
      name: s.string().optional(),
      parent: s.string().optional(),
      path: s.string().optional(),
    }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ session, choice, name, parent, path }) => {
      const target = sessions.require(session);
      const request = target.folderRequest.peek();
      if (!request) return { started: false };
      if (choice === "cancel") {
        // The message isn't thrown away: it goes back to the box.
        target.folderRequest.value = null;
        if (!target.draft.peek()) target.draft.value = request.message;
        return { started: false };
      }
      // A double click on "Create and start" starts once (D159).
      if (startingFolder.has(target.id)) return { started: false };
      startingFolder.add(target.id);
      try {
        if (choice !== "chat") {
          let folder: string | null = null;
          if (choice === "create") {
            const where = parent ?? request.parent;
            if (!where) throw new Error("Choose where to put the folder first.");
            folder = await fsIpc.createProjectFolder(where, name ?? request.name);
            // Made empty here: trusted, so opening it asks nothing and stops nothing (D273).
            await services.trust.trustCreated(folder);
          } else folder = path ?? (await dialogIpc.pickFolder("Open folder for the agent"));
          if (!folder) return { started: false };
          if (!(await workspace.open(folder))) return { started: false };
        }
        target.folderRequest.value = null;
        showSession(target.id);
        // The agent asked (agent.askForFolder): no message waits to be sent.
        if (!request.message) return { started: true, folder: workspace.root.peek() };
        void services.dispatcher
          .execute("agent.send", {
            session: target.id,
            message: request.message,
            wait: false,
            noFolder: choice === "chat",
          })
          .catch(() => {});
        return { started: true, folder: workspace.root.peek() };
      } finally {
        startingFolder.delete(target.id);
      }
    },
  });

  register({
    id: "agent.askForFolder",
    title: "Ask where to work",
    description:
      'Shows the user the "Where should this project live?" card again (D239) when the chat has no folder open and the work needs one (files to create, a project to build): they make a folder, open one, or keep chatting. `name` suggests the new folder\'s name. Asked once per chat on its own; use this when a later message needs a folder.',
    input: s.object({
      session: sessionInput,
      name: s.string().describe("A name for the new folder").optional(),
    }),
    effects: [],
    run: async ({ session, name }) => {
      if (workspace.root.peek()) return { asked: false, folder: workspace.root.peek() };
      const target = session ? sessions.get(session) : (sessions.find(undefined) ?? sessions.get());
      const home = (await appIpc.info().catch(() => null))?.homeDir ?? null;
      const base =
        services.settings.peek<string>("agent.projectsFolder") ||
        (home ? joinPath(home, "Projects") : "");
      target.folderRequest.value = {
        message: "",
        name: name?.trim() || suggestFolderName(target.title.peek()),
        parent: base,
      };
      return { asked: true, session: target.id };
    },
  });

  register({
    id: "agent.send",
    title: "Send to agent",
    description:
      "Sends a message to an agent session and waits until the agent is done (or `wait: false`). While the agent is working, the message is queued and joins its work at the next step (returns `queued`).",
    input: s.object({
      // May be empty when something is attached (an image alone, D160).
      message: s.string(),
      session: sessionInput,
      wait: s.boolean().optional(),
      noFolder: s
        .boolean()
        .describe("Send even with no folder open (an answer-only chat)")
        .optional(),
    }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ message, session, wait, noFolder }, ctx) => {
      const target = session ? sessions.get(session) : (sessions.find(undefined) ?? sessions.get());
      if (!message.trim() && !target.attachments.peek().length && !target.uploads.peek().length)
        throw new Error("Type a message or attach something to send.");
      // No folder open: ask where to work first (the card in the panel), then send (D121). Once
      // per chat, on its first message: after "Just chat" (or any answer) the conversation goes
      // on without asking again (D239).
      const started = target.items.some((it) => it.type === "user");
      if (!workspace.root.peek() && !noFolder && !started && !message.trim().startsWith("/")) {
        showSession(target.id);
        const home = (await appIpc.info().catch(() => null))?.homeDir ?? null;
        const named = pathInMessage(message, home);
        const base =
          services.settings.peek<string>("agent.projectsFolder") ||
          (home ? joinPath(home, "Projects") : "");
        target.folderRequest.value = {
          message,
          name: named ? basename(named) : suggestFolderName(message),
          parent: named ? dirname(named) : base,
        };
        return { session: target.id, needsFolder: true };
      }
      // /plugin (D358) and other commands that act instead of sending.
      const action = actionSlashFor(message);
      if (action) return { session: target.id, ...(await action.run(action.args, ctx.caller)) };
      // /undo, /btw, /context… (D389): they act on this chat instead of sending.
      const chatAction = sessionSlashFor(message);
      if (chatAction)
        return {
          session: target.id,
          ...(await chatAction.run(target, chatAction.args, ctx.caller)),
        };
      // /new and /reset are /clear (Claude Code's other names, D389).
      message = canonicalSlash(message, BUILTIN_COMMANDS);
      // "/compact [focus]": summarize the conversation so far instead of sending.
      const compact = /^\/compact\b\s*(.*)$/s.exec(message.trim());
      if (compact) {
        const { count } = await target.compact(compact[1]?.trim() || undefined);
        return { session: target.id, compacted: count };
      }
      // /output-style [name] (D356): picks the style instead of sending.
      const styleCmd = /^\/output-style(?:\s+([\s\S]*))?$/.exec(message.trim());
      if (styleCmd) {
        const style = styleCmd[1]?.trim();
        const r = await ctx.execute("agent.setOutputStyle", style ? { style } : {});
        return { session: target.id, outputStyle: r };
      }
      // /clear, /model, /review (D200): they act instead of sending.
      const builtin = /^\/(clear|model|review)\b\s*([\s\S]*)$/.exec(message.trim());
      if (builtin) {
        const arg = builtin[2]?.trim() ?? "";
        if (builtin[1] === "clear") {
          if (target.busyNow()) throw new Error("The agent is working; stop it first.");
          const next = sessions.get();
          // Claude Code's /clear: the old chat ends, the new one starts "clear" (D371).
          target.endHooks("clear");
          next.hookStart = "clear";
          showThreadTab(dock, next.id);
          sessions.active.value = next.id;
          // The old chat stays in Chats; its tab gives way to the new one.
          for (const t of dock.tabs("agent"))
            if ((t.viewState as { session?: string } | null)?.session === target.id)
              await dock.closeTab(t.id, true);
          return { session: next.id, cleared: target.id };
        }
        if (builtin[1] === "model") {
          const key = arg
            ? (providers.find(arg)?.key ??
              providers.models.peek().find((m) => m.model === arg || m.key === arg)?.key ??
              (arg.startsWith("acp/") ? arg : undefined))
            : undefined;
          if (arg && !key) throw new Error(`No model named ${arg}: /model alone lists them.`);
          if (!key && ctx.caller.kind !== "user")
            return { session: target.id, models: providers.models.peek().map((m) => m.key) };
          const picked = await ctx.execute("agent.selectModel", {
            session: target.id,
            ...(key && { model: key }),
          });
          return { session: target.id, model: target.model.peek(), picked };
        }
        const model = target.model.peek();
        return ctx.execute("agent.reviewChanges", {
          scope: "uncommitted",
          ...(arg && { focus: arg }),
          ...(model && { model }),
        });
      }
      // A channel's or a direct message's conversation shows in the channel tab when that's
      // opened (D238); a post to it (an agent's, a task channel) doesn't open a chat tab.
      if (
        !conversationRoom(target.id) &&
        !dock
          .tabs("agent")
          .some((t) => (t.viewState as { session?: string } | null)?.session === target.id)
      )
        showSession(target.id);
      // Before taking the attachments: a send that can't start keeps them.
      await target.settle();
      // agent.whileWorking "interrupt" (D179): the user's message stops the running turn and
      // starts a new one, instead of joining it at its next step.
      if (
        target.busyNow() &&
        ctx.caller.kind === "user" &&
        services.settings.peek<string>("agent.whileWorking") === "interrupt" &&
        target.questions.peek().length === 0
      ) {
        target.stop("you sent a new message");
        for (let i = 0; i < 200 && target.busyNow(); i++)
          await new Promise((r) => setTimeout(r, 25));
      }
      // While a turn runs, the message joins it at its next step (D151); during a summary or
      // a side task it can't, and the text goes back to the box.
      const queue = target.busyNow();
      if (queue && !target.canQueue()) {
        if (message.trim() && !target.draft.peek()) target.draft.value = message;
        throw new Error("The agent is busy for a moment; send it again when it's done.");
      }
      // The agent is waiting on its question (ask_user, D171): a typed message is the answer
      // (anything attached stays in the box for the next message).
      if (queue && message.trim() && target.answer(message))
        return { session: target.id, answered: true };
      // Only attachments while it asks: they'd wait for a step that comes after the answer.
      if (queue && !message.trim() && target.questions.peek().length)
        throw new Error("The agent is waiting for your answer: type it (or pick a choice) first.");
      // Attached files and @-mentions go with the message as context (current text, capped).
      const attached = target.attachments.peek();
      target.attachments.value = [];
      const uploads = target.uploads.peek();
      target.uploads.value = [];
      const restoreBox = () => {
        // A command's model and tools were for this message only (D203 audit).
        target.nextTurnModel = null;
        target.nextTurnTools = null;
        target.nextTurnEffort = null;
        target.attachments.value = [...attached, ...target.attachments.peek()];
        target.uploads.value = [...uploads, ...target.uploads.peek()];
        if (message.trim() && !target.draft.peek()) target.draft.value = message;
      };
      const context: string[] = [];
      const cards: SentAttachment[] = [];
      for (const path of attached) {
        if (path.startsWith("@")) {
          context.push(await mentionContext(services, path, sessions, target, message));
          cards.push({ kind: "mention", name: mentionLabel(path) });
          continue;
        }
        // As the workspace names it ("api/…" in another folder of a multi-root workspace, D251).
        const rel =
          (workspace.root.peek() ? workspace.relative(path) : relativePath("", path)) || path;
        // Excluded from the agent (D199): named, not sent.
        if (agentIgnored(services, path)) {
          context.push(`Attached file ${rel} (excluded from the agent: its content wasn't sent)`);
          cards.push({ kind: "file", name: rel });
          continue;
        }
        const text = await readText(services, path);
        cards.push({
          kind: "file",
          name: rel,
          ...(text !== null && {
            preview: previewOf(text, 300),
            text: viewText(text),
            lines: countLines(text),
          }),
        });
        if (text === null) context.push(`Attached file ${rel} (couldn't be read)`);
        // Sent whole, an attached file counts as read (D309: edit_file needs no read_file first).
        else if (text.length <= 20000) target.changeset.noteSeen(path, text);
        if (text !== null)
          context.push(
            `Attached file ${rel}:\n\`\`\`\n${text.length > 20000 ? `${text.slice(0, 20000)}\n… (truncated; use read_file for the rest)` : text}\n\`\`\``,
          );
      }
      for (const u of uploads) {
        const c = uploadContext(u);
        if (c) context.push(c);
        cards.push(sentAttachment(u));
      }
      // Attached MCP resources that changed since (D204, resources/subscribe).
      context.push(...(await extraSendContext(target)));
      // D330: in Plan mode, the plan file as the user edited it.
      context.push(...(await planEditContext(target)));
      // "/name args": /init, or a prompt file from <workspace folder>/commands, .claude/commands,
      // .cursor/commands or the user's own (D200: front matter, $1…$9, !`shell`, @files); else an
      // MCP prompt or an external agent's own command (D200).
      const custom = await promptSlash(services, target, message).catch((err) => {
        restoreBox();
        throw err;
      });
      if (custom) {
        context.unshift(custom.context);
        if (custom.model) target.nextTurnModel = custom.model;
        target.nextTurnTools = custom.turnTools ?? null;
      } else {
        const extra = await expandExtraSlash(message, target);
        if (extra) context.unshift(extra);
      }
      const images = uploads.filter((u) => u.kind === "image").map((u) => u.data);
      const text = message.trim() || "(See the attachments.)";
      const extras = {
        ...(images.length && { images }),
        ...(cards.length && { attachments: cards }),
      };
      // A send that didn't start loses nothing: the text, the attachments and the pasted files
      // go back to the box.
      const restore = restoreBox;
      // Finished meanwhile (reading the attachments): it's sent as a new message instead. Started
      // meanwhile (a round's next agent, a report): it's queued rather than refused (D244).
      if (target.busyNow() && target.canQueue()) {
        // A message joining the running turn skips the turn's start, where UserPromptSubmit
        // hooks run: they run here (a held one goes through them when it's sent).
        if (target.joinsTurn()) {
          const hook = await target.runHook("UserPromptSubmit", { prompt: text });
          if (hook?.block || hook?.halt) {
            restore();
            throw new Error(`A hook stopped this message: ${hook.reason}`);
          }
          if (hook?.context) context.push(`From the user's hooks:\n${hook.context}`);
        }
        // The cards go with it, so Take back / Stop can put them back in the box (D160).
        const queued = target.enqueue(text, context, { ...extras, uploads, paths: attached });
        return { session: target.id, queued: queued.id };
      }
      const done = target.send(text, context, extras);
      if (wait === false) {
        done.catch(restore);
        return { session: target.id };
      }
      try {
        await done;
      } catch (err) {
        restore();
        throw err;
      }
      const last = [...target.items].reverse().find((i) => i.type === "assistant" && i.text);
      return {
        session: target.id,
        answer: last?.type === "assistant" ? last.text : "",
        pending: target.changeset.files.peek().map((f) => f.path),
        error: target.error.peek(),
      };
    },
  });
}

// The Chats list's commands (D124, D125): rename, pin, archive, fork, clear. A chat that isn't loaded is changed
// in its saved file, without touching when it was last active. Also agent.showMessage (a thread's
// "Show it in the conversation").
import { agentStoreIpc } from "../../core/ipc/agent";
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import { confirmAction, showDialog } from "../../ui/Dialog";
import type { WorkbenchServices } from "../../workbench/services";
import { backgroundProcesses } from "./backgroundProcesses";
import { isThisWorkspace } from "./chatWorkspace";
import { newId } from "./ids";
import type { SessionManager } from "./sessions";
import { subagentRuns } from "./subagentRuns";
import { messageReveal } from "./threadTabs";

/** What a chat's commands change in its saved meta. */
interface ChatMeta {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
}

export function registerChatCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
): void {
  const { dispatcher, dock, quickInput, workspace } = services;
  const register: typeof dispatcher.register = (c) =>
    sub.add(dispatcher.register({ category: "Agent", ...c }));
  const sessionInput = s.string().describe("Session id (default: the active session)").optional();

  /**
   * Changes a chat's saved details (title, pinned, archived): a loaded session directly, a saved one in
   * its file — without touching when it was last active.
   */
  const updateChat = async (
    session: string | undefined,
    change: (meta: ChatMeta) => void,
  ): Promise<ChatMeta> => {
    const loaded = sessions.find(session);
    if (loaded) {
      const meta: ChatMeta = {
        title: loaded.title.peek(),
        pinned: loaded.pinned,
        archived: loaded.archived,
      };
      change(meta);
      if (meta.title) loaded.title.value = meta.title;
      loaded.pinned = meta.pinned === true;
      loaded.archived = meta.archived === true;
      await loaded.save();
      sessions.changed();
      return meta;
    }
    if (!session) throw new Error("No agent session.");
    const text = await agentStoreIpc.load(session);
    if (!text) throw new Error("That chat no longer exists.");
    const saved = JSON.parse(text) as { meta?: ChatMeta };
    const meta = { ...saved.meta };
    change(meta);
    saved.meta = meta;
    await agentStoreIpc.save(session, JSON.stringify(saved));
    sessions.changed();
    return meta;
  };
  const chatTitle = async (session: string | undefined): Promise<string> => {
    const loaded = sessions.find(session);
    if (loaded) return loaded.title.peek();
    const text = session ? await agentStoreIpc.load(session) : null;
    return (text && (JSON.parse(text) as { meta?: { title?: string } }).meta?.title) || "";
  };

  register({
    id: "agent.renameSession",
    title: "Rename chat…",
    description: "Renames an agent chat (asks for the name when `title` is missing).",
    input: s.object({
      session: sessionInput,
      title: s.string({ minLength: 1 }).optional(),
    }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ session, title }) => {
      const name =
        title ??
        (await quickInput.prompt({
          prompt: "Chat name",
          value: await chatTitle(session),
          validate: (v) => (v.trim() ? undefined : "Type a name."),
        }));
      const clean = name?.replace(/\s+/g, " ").trim().slice(0, 80);
      if (!clean) return { renamed: false };
      await updateChat(session, (m) => {
        m.title = clean;
      });
      return { renamed: true, title: clean };
    },
  });

  register({
    id: "agent.pinSession",
    title: "Pin chat",
    description:
      "Pins an agent chat to the top of the Chats list (`pinned: false` unpins; default: toggles).",
    input: s.object({ session: sessionInput, pinned: s.boolean().optional() }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ session, pinned }) => {
      const meta = await updateChat(session, (m) => {
        m.pinned = pinned ?? !m.pinned;
        if (!m.pinned) delete m.pinned;
      });
      return { pinned: meta.pinned === true };
    },
  });

  register({
    id: "agent.archiveSession",
    title: "Archive chat",
    description:
      "Archives an agent chat: out of its folder's list, under Archived in the Chats view (`archived: false` restores it; default: toggles). Archiving unpins it.",
    input: s.object({ session: sessionInput, archived: s.boolean().optional() }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ session, archived }) => {
      const meta = await updateChat(session, (m) => {
        m.archived = archived ?? !m.archived;
        if (m.archived) delete m.pinned;
        else delete m.archived;
      });
      return { archived: meta.archived === true };
    },
  });

  register({
    id: "agent.forkSession",
    title: "Fork chat",
    description:
      'Copies an agent chat\'s conversation into a new chat ("… (fork)") and opens it: the two go on separately. Edits waiting for review stay with the original.',
    input: s.object({ session: sessionInput }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ session }, ctx) => {
      const loaded = sessions.find(session);
      const id = loaded?.id ?? session;
      if (!id) throw new Error("No agent session.");
      if (loaded) await loaded.save();
      const text = await agentStoreIpc.load(id);
      if (!text) throw new Error("That chat has nothing to fork yet.");
      const saved = JSON.parse(text) as Record<string, unknown> & {
        meta?: Record<string, unknown>;
      };
      const meta = { ...saved.meta };
      meta.title = `${typeof meta.title === "string" ? meta.title : "Chat"} (fork)`;
      meta.updated = Date.now();
      delete meta.pinned;
      delete meta.archived;
      // Its review state and file checkpoints are the original's.
      const { changeset: _c, checkpoints: _k, ...rest } = saved;
      const fork = newId("s");
      await agentStoreIpc.save(fork, JSON.stringify({ ...rest, meta }));
      sessions.changed();
      await ctx.execute("agent.openThread", { session: fork });
      return { session: fork };
    },
  });

  register({
    id: "agent.clearChats",
    title: "Clear chats…",
    description:
      'Deletes saved agent chats: `scope` "folder" (the open folder\'s) or "all". Chats that are still running are kept. Asks first when run by the user.',
    input: s.object({
      scope: s
        .enum(["folder", "all"] as const)
        .describe("Which chats (asked when missing)")
        .optional(),
    }),
    effects: ["destructive"],
    agent: "hidden",
    run: async ({ scope }, ctx) => {
      const root = workspace.root.peek();
      const saved = await agentStoreIpc.list();
      // This window's chats (D251: its folder, or its multi-root workspace).
      const inFolder = (r: (typeof saved)[number]) =>
        isThisWorkspace(services, ((r.meta ?? {}) as { workspace?: string | null }).workspace);
      let which = scope;
      if (!which) {
        const here = root ? saved.filter(inFolder).length : 0;
        which = await showDialog<"folder" | "all" | undefined>({
          title: "Clear chats?",
          message: `Deletes ${saved.length === 1 ? "the saved chat" : `all ${saved.length} saved chats`} and their checkpoints${here ? `, or only the ${here} from this folder` : ""}. Running chats are kept.\n\nThis can't be undone.`,
          actions: [
            { label: "Cancel", value: undefined },
            ...(here && here < saved.length
              ? [{ label: "This folder's", value: "folder" as const }]
              : []),
            { label: "Delete all", value: "all" as const, variant: "danger" as const },
          ],
          cancelValue: undefined,
        });
        if (!which) return { deleted: 0 };
      } else if (
        ctx.caller.kind === "user" &&
        !(await confirmAction("Clear chats?", "This can't be undone.", "Delete", true))
      )
        return { deleted: 0 };
      const running = new Set(
        sessions
          .all()
          .filter((sess) => sess.status.peek() !== "idle")
          .map((sess) => sess.id),
      );
      let deleted = 0;
      for (const r of saved) {
        if (running.has(r.id) || (which === "folder" && !inFolder(r))) continue;
        sessions.find(r.id)?.markDeleted();
        // Its dev servers and watchers go with it, as with Delete chat (D201).
        backgroundProcesses.killSession(r.id);
        subagentRuns.forgetSession(r.id);
        for (const t of dock.tabs("agent"))
          if ((t.viewState as { session?: string } | null)?.session === r.id)
            await dock.closeTab(t.id, true);
        sessions.forget(r.id);
        await agentStoreIpc.delete(r.id).catch(() => {});
        deleted++;
      }
      sessions.changed();
      return { deleted, kept: running.size };
    },
  });

  /** The folder a chat belongs to: the loaded session's, else its saved file's. */
  const folderOf = async (session: string | undefined): Promise<string | null> => {
    const loaded = sessions.find(session);
    if (loaded) return loaded.folder.peek();
    const text = session ? await agentStoreIpc.load(session) : null;
    return (
      (text && (JSON.parse(text) as { meta?: { workspace?: string } }).meta?.workspace) || null
    );
  };

  register({
    id: "agent.openChatFolder",
    title: "Open the chat's folder",
    description:
      "Opens the folder (or multi-root workspace file) an agent chat was started in as the workspace, then shows the chat there (its tools work on that project).",
    input: s.object({ session: sessionInput }),
    effects: [],
    agent: "hidden",
    run: async ({ session }, ctx) => {
      const id = sessions.find(session)?.id ?? session;
      const folder = await folderOf(id);
      if (!id || !folder) throw new Error("This chat isn't tied to a folder.");
      if (!isThisWorkspace(services, folder)) {
        await ctx.execute("workspace.openFolder", { path: folder });
        if (!isThisWorkspace(services, folder)) return { opened: false };
      }
      await ctx.execute("agent.openSession", { session: id });
      return { opened: true, folder };
    },
  });

  register({
    id: "agent.showMessage",
    title: "Show message in its conversation",
    description:
      "Opens the conversation `session` (a channel's, a direct message or a chat) and scrolls message `item` into view, highlighted for a moment: a thread's \"Show it in the conversation\".",
    input: s.object({
      session: s.string().describe("The conversation's session id"),
      item: s.string().describe("The message's item id"),
    }),
    effects: [],
    agent: "hidden",
    run: async ({ session, item }, ctx) => {
      // Asked first, so a view made by opening the tab finds it too.
      messageReveal.value = { session, item, at: Date.now() };
      await ctx.execute("agent.openThread", { session });
      return { session, item };
    },
  });

  register({
    id: "agent.moveChatHere",
    title: "Continue chat in this folder",
    description:
      "Ties an agent chat that was started in another folder to the open one (its tools then work here).",
    input: s.object({ session: sessionInput }),
    effects: ["write"],
    agent: "hidden",
    when: "workspaceOpen",
    run: async ({ session }) => {
      const sess = sessions.require(session);
      sess.moveToOpenFolder();
      sessions.changed();
      return { folder: sess.folder.peek() };
    },
  });
}

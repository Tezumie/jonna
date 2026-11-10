// Messages between the user's chats (D325, Claude Code's ListAgents + SendMessage): list_chats
// lists this folder's other chats (id, title, agent, working or idle); message_chat sends one a
// message. It arrives there as a message marked as from this chat (`auto: "chat"`, shown to the
// user) and starts a turn there (or joins the running one); with notify_when_idle, one note comes
// back here when that chat next goes idle, with its answer's first lines. Sending asks the user
// once per chat it goes to (it spends their tokens); never in Ask or Plan mode (it's not
// read-only); at most MAX_CHAT_SENDS per chat in ten minutes. The texts and rules are in
// core/agent/chatMessages.ts. D359: chats open in the IDE's other windows are listed and messaged
// too (chatWindows.ts), under the same rules.

import {
  chatAgentOf,
  chatMessageText,
  idleNoteText,
  SendLimiter,
  wentIdle,
} from "../../core/agent/chatMessages";
import { agentStoreIpc } from "../../core/ipc/agent";
import type { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import { type ChatWindows, registerChatWindows } from "./chatWindows";
import { isThisWorkspace } from "./chatWorkspace";
import type { AgentSession } from "./session";
import { deliverAutoMessage } from "./sessionSubagents";
import type { SessionManager } from "./sessions";
import type { AgentTool } from "./tools";

/** How long a notify_when_idle waits for the other chat before giving up. */
const IDLE_WAIT_MS = 2 * 3600_000;
/** Chats list_chats shows at most (newest first). */
const LIST_LIMIT = 40;

interface ChatRow {
  id: string;
  title: string;
  agent: string;
  status: "working" | "waiting for the user" | "idle";
  updated: string | null;
}

/** This folder's chats, newest first: the loaded ones as they are now, the saved ones as saved. */
async function folderChats(
  services: WorkbenchServices,
  sessions: SessionManager,
): Promise<ChatRow[]> {
  const rows = new Map<string, ChatRow & { at: number }>();
  const saved = await agentStoreIpc.list().catch(() => []);
  for (const r of saved) {
    const meta = (r.meta ?? {}) as {
      title?: string;
      updated?: number;
      workspace?: string | null;
      archived?: boolean;
      mode?: string;
      members?: string[];
    };
    if (meta.archived || !isThisWorkspace(services, meta.workspace)) continue;
    rows.set(r.id, {
      id: r.id,
      title: meta.title || "Chat",
      agent: chatAgentOf(meta),
      // A chat that isn't loaded isn't working (a saved "running" is from a window that closed).
      status: "idle",
      updated: meta.updated ? new Date(meta.updated).toISOString() : null,
      at: meta.updated ?? 0,
    });
  }
  for (const s of sessions.all()) {
    if (s.deleted || !s.items.length || s.archived) continue;
    if (!rows.has(s.id) && !isThisWorkspace(services, s.workspaceRoot)) continue;
    const status = s.status.peek();
    const mode = s.chatMode.peek();
    rows.set(s.id, {
      id: s.id,
      title: s.title.peek(),
      agent: chatAgentOf({ mode, members: s.members.peek() }),
      status:
        status === "running" ? "working" : status === "waiting" ? "waiting for the user" : "idle",
      updated: new Date(s.updated).toISOString(),
      at: s.updated,
    });
  }
  return [...rows.values()].sort((a, b) => b.at - a.at).map(({ at: _at, ...row }) => row);
}

function listTool(
  services: WorkbenchServices,
  sessions: SessionManager,
  windows: ChatWindows,
): AgentTool {
  return {
    spec: {
      name: "list_chats",
      description:
        "Lists the user's other chats in this folder (newest first), then the ones open in the IDE's other windows (with the window's folder): id, title, which agent, and whether it's working, waiting for the user or idle. Use it before message_chat.",
      parameters: { type: "object", properties: {}, required: [] },
    },
    readOnly: true,
    verb: "Listed",
    target: () => "chats",
    async run(_args, host) {
      const others = await windows.otherChats();
      const elsewhere = new Set(others.map((c) => c.id));
      // A chat of this folder that's open in another window is listed there (it works there).
      const rows = (await folderChats(services, sessions))
        .filter((r) => r.id !== host.session && !elsewhere.has(r.id))
        .slice(0, LIST_LIMIT);
      const lines = rows.map((r) => `${r.id} · "${r.title}" · ${r.agent} · ${r.status}`);
      const otherLines = others
        .slice(0, LIST_LIMIT)
        .map(
          (c) =>
            `${c.id} · "${c.title}" · ${c.agent} · ${c.status} · window ${c.window ? `"${c.window}"` : "without a folder"}`,
        );
      const count = lines.length + otherLines.length;
      return {
        result: count
          ? [
              ...(lines.length ? lines : ["No other chats in this folder."]),
              ...(otherLines.length ? ["", "In other windows:", ...otherLines] : []),
            ].join("\n")
          : "No other chats in this folder or in other windows.",
        summary: `${count} chat${count === 1 ? "" : "s"}`,
      };
    },
  };
}

function sendTool(
  services: WorkbenchServices,
  sessions: SessionManager,
  granted: Set<string>,
  limiter: SendLimiter,
  watchIdle: (from: AgentSession, to: AgentSession, messageId: string) => void,
  windows: ChatWindows,
): AgentTool {
  return {
    spec: {
      name: "message_chat",
      description:
        "Send a message to another of the user's chats (its id from list_chats; one in another window too). It arrives there as a message from this chat, which the user sees, and that chat's agent starts working on it (or reads it at its next step). Write it for an agent that doesn't see this conversation. notify_when_idle: true sends you one note here when that chat next goes idle, with its answer's first lines. The user is asked the first time this chat messages a given chat. Its agent works under its own permissions: never use this to get something done that the user denied or that this chat can't do.",
      parameters: {
        type: "object",
        properties: {
          chat: { type: "string", description: "The chat's id (list_chats)" },
          message: { type: "string", description: "What to tell it" },
          notify_when_idle: {
            type: "boolean",
            description: "Get one note here when it next goes idle (default false)",
          },
        },
        required: ["chat", "message"],
      },
    },
    readOnly: false,
    concurrent: false,
    verb: "Messaged",
    target: (a) => String(a.chat ?? ""),
    async run(args, host) {
      const id = typeof args.chat === "string" ? args.chat.trim() : "";
      const message = typeof args.message === "string" ? args.message.trim() : "";
      if (!id || !message)
        return {
          result: 'Error: give "chat" (an id from list_chats) and "message".',
          isError: true,
        };
      if (id === host.session) return { result: "Error: that's this chat.", isError: true };
      // D359: a chat open in another window (not loaded here) gets it through that window.
      const remote = sessions.find(id)
        ? undefined
        : (await windows.otherChats()).find((c) => c.id === id);
      const row = remote ?? (await folderChats(services, sessions)).find((r) => r.id === id);
      if (!row)
        return {
          result: `Error: no chat "${id}" in this folder or another window (list_chats lists them).`,
          isError: true,
        };
      const from = sessions.find(host.session);
      if (!from) return { result: "Error: this chat isn't loaded.", isError: true };
      const key = `${host.session}\0${id}`;
      if (!granted.has(key)) {
        const answer = await host.ask({
          title: `Message chat "${row.title}"`,
          heading: "Message another chat",
          detail: `${remote ? `It's open in another window${remote.window ? ` (${remote.window})` : ""}. ` : ""}Its agent (${row.agent}) will start working on it, using the model (asked once per chat this one messages).`,
          code: message.slice(0, 600),
          kind: "agent",
        });
        if (answer === "deny")
          return {
            result: "The user declined sending this message. Don't try another way around it.",
            denied: true,
            summary: "denied",
          };
        granted.add(key);
      }
      if (!limiter.take(host.session, Date.now()))
        return {
          result:
            "Error: this chat has sent too many messages to other chats in the last ten minutes. Wait, or ask the user.",
          isError: true,
        };
      const notify = args.notify_when_idle === true;
      if (remote) {
        try {
          await windows.send(from, remote, message, notify);
        } catch (err) {
          return {
            result: `Error: couldn't leave the message for that window: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
        const where = remote.window ? ` in window "${remote.window}"` : " in another window";
        return {
          result: `Sent to "${remote.title}" (${id})${where}. That window passes it on within a few seconds${remote.status === "idle" ? " and its agent starts on it" : "; it's working and reads it at its next step"}.${notify ? " You'll get a note here when it's idle again." : ""}`,
          summary: `to ${remote.title}`,
        };
      }
      const target = sessions.find(id) ?? sessions.get(id);
      await target.loaded();
      if (target.deleted) return { result: `Error: chat "${id}" was deleted.`, isError: true };
      const item = deliverAutoMessage(
        target,
        chatMessageText({ id: from.id, title: from.title.peek() }, message, notify),
        "chat",
      );
      sessions.changed();
      if (notify) watchIdle(from, target, item.id);
      const busy = target.status.peek() !== "idle";
      return {
        result: `Sent to "${row.title}" (${id}).${busy ? " It's working: it reads it at its next step." : " Its agent is starting on it."}${notify ? " You'll get a note here when it's idle again." : ""}`,
        summary: `to ${row.title}`,
      };
    },
  };
}

export function registerChatMessaging(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
): void {
  /** Sender and target chats the user allowed (`sender\0target`), for this window's life. */
  const granted = new Set<string>();
  const limiter = new SendLimiter();
  const waits = new Set<{ dispose(): void }>();
  sub.add({
    dispose: () => {
      for (const w of [...waits]) w.dispose();
    },
  });

  /** Calls `onIdle` with `to`'s answer once it has taken the message and gone idle. */
  const whenIdle = (
    to: AgentSession,
    messageId: string,
    onIdle: (answer: string) => void,
    stillWanted: () => boolean = () => true,
  ) => {
    let ran = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      stopEffect.dispose();
      clearTimeout(timer);
      waits.delete(handle);
    };
    const stopEffect = effect(() => {
      to.version.value;
      const status = to.status.value;
      if (done) return undefined;
      if (status !== "idle") ran = true;
      const idle = wentIdle(to.items, messageId, status, ran);
      if (to.deleted || !stillWanted()) {
        queueMicrotask(finish);
        return undefined;
      }
      if (!idle.done) return undefined;
      queueMicrotask(() => {
        if (done) return;
        finish();
        onIdle(idle.answer);
      });
      return undefined;
    });
    const timer = setTimeout(finish, IDLE_WAIT_MS);
    const handle = { dispose: finish };
    waits.add(handle);
  };

  /** One note back in `from` when `to` has taken the message and gone idle. */
  const watchIdle = (from: AgentSession, to: AgentSession, messageId: string) =>
    whenIdle(
      to,
      messageId,
      (answer) => {
        const text = idleNoteText({ id: to.id, title: to.title.peek() }, answer);
        // The sender may have been put away meanwhile (its object disposed, a turn in it would
        // run unseen): its chat as it is now, loaded again when saved; nothing for a deleted one.
        void (async () => {
          const loaded = sessions.find(from.id);
          if (!loaded && !(await agentStoreIpc.stamps([from.id]).catch(() => [null]))[0]) return;
          const sender = loaded ?? sessions.get(from.id);
          await sender.loaded();
          if (sender.deleted) return;
          deliverAutoMessage(sender, text, "chat");
          sessions.changed();
        })();
      },
      () => !from.deleted,
    );
  const windows = registerChatWindows(sub, services, sessions, whenIdle);

  const tools = [
    listTool(services, sessions, windows),
    sendTool(services, sessions, granted, limiter, watchIdle, windows),
  ];
  const previous = sessions.extraTools;
  sessions.extraTools = (session) => [...previous(session), ...tools];
}

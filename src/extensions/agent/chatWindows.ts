// Chats in the IDE's other windows (D359, Claude Code's SendMessage across sessions on one
// machine). Each window is its own process: this one publishes its chats (id, title, agent,
// working or idle) through Rust to a file of its own, and list_chats reads the other live
// windows' (core/agent/windowChats.ts). message_chat to a chat in another window leaves a mail in
// a shared mailbox (Rust: agent/window_chats.rs, the helper reports' store, D233), which the
// window that has that chat open takes exactly once and delivers as a message from this chat
// ("… in window <folder>"), starting a turn there; a notify_when_idle note comes back the same
// way. The permission (once per pair of chats) and the rate limit are chatMessaging.ts's.

import { chatAgentOf, chatMessageText, idleNoteText } from "../../core/agent/chatMessages";
import {
  decodeMail,
  encodeMail,
  type OtherWindowChat,
  otherWindowChats,
  PUBLISHED_CHATS,
  parseWindowChats,
  shouldRepublish,
  type WindowChat,
  type WindowChats,
  type WindowMail,
} from "../../core/agent/windowChats";
import { windowChatsIpc } from "../../core/ipc/agentIntegrations";
import type { DisposableStore } from "../../core/lifecycle/index";
import { basename } from "../../core/paths/index";
import type { WorkbenchServices } from "../../workbench/services";
import { newId } from "./ids";
import type { AgentSession } from "./session";
import { deliverAutoMessage } from "./sessionSubagents";
import type { SessionManager } from "./sessions";

/** How often this window's chats are looked at (written only when they changed). */
const PUBLISH_MS = 4000;
/** Written again at least this often, so other windows know it's still there. */
const HEARTBEAT_MS = 60_000;
/** How often the mailbox is looked at. */
const MAIL_MS = 2000;

/** Waits for a chat to take a message and go idle, then calls back with its answer. */
export type WhenIdle = (
  to: AgentSession,
  messageId: string,
  onIdle: (answer: string) => void,
  stillWanted?: () => boolean,
) => void;

export class ChatWindows {
  private last: { text: string; at: number } | null = null;
  private published = false;
  private publishing = false;
  private reading = false;
  private disposed = false;

  constructor(
    private readonly services: WorkbenchServices,
    private readonly sessions: SessionManager,
    private readonly whenIdle: WhenIdle,
  ) {}

  /** This window's folder as the other windows show it ("" for none). */
  private folderName(): string {
    const root = this.services.workspace.root.peek();
    return root ? basename(root) || root : "";
  }

  /** This window's chats as published: the loaded ones with something in them, newest first. */
  private ownChats(): WindowChat[] {
    return this.sessions
      .all()
      .filter((s) => !s.deleted && s.items.length > 0 && !s.archived)
      .sort((a, b) => b.updated - a.updated)
      .slice(0, PUBLISHED_CHATS)
      .map((s) => {
        const status = s.status.peek();
        return {
          id: s.id,
          title: s.title.peek(),
          agent: chatAgentOf({ mode: s.chatMode.peek(), members: s.members.peek() }),
          status:
            status === "running"
              ? "working"
              : status === "waiting"
                ? "waiting for the user"
                : "idle",
        };
      });
  }

  /** Writes this window's record when its chats changed (or it's due); removes it when empty. */
  async publish(): Promise<void> {
    if (this.publishing || this.disposed) return;
    this.publishing = true;
    try {
      const chats = this.ownChats();
      if (!chats.length) {
        if (this.published) await windowChatsIpc.unpublish().catch(() => {});
        this.published = false;
        this.last = null;
        return;
      }
      const record: Pick<WindowChats, "folder" | "chats"> = {
        folder: this.services.workspace.root.peek() ?? "",
        chats,
      };
      const text = JSON.stringify(record);
      const now = Date.now();
      if (!shouldRepublish(this.last, text, now, HEARTBEAT_MS)) return;
      await windowChatsIpc.publish(text);
      this.published = true;
      this.last = { text, at: now };
    } catch {
      // Not written this time (a file in use): tried again at the next look.
      this.last = null;
    } finally {
      this.publishing = false;
    }
  }

  /** The chats open in the IDE's other windows (none when they can't be read). */
  async otherChats(): Promise<OtherWindowChat[]> {
    const [pid, texts] = await windowChatsIpc.list().catch((): [number, string[]] => [0, []]);
    const windows = texts.map(parseWindowChats).filter((w): w is WindowChats => !!w);
    const here = new Set(this.sessions.all().map((s) => s.id));
    return otherWindowChats(windows, pid, here);
  }

  /** Leaves a message for a chat in another window. */
  async send(
    from: AgentSession,
    to: OtherWindowChat,
    message: string,
    notify: boolean,
  ): Promise<void> {
    const mail: WindowMail = {
      kind: "message",
      to: to.id,
      from: { id: from.id, title: from.title.peek(), window: this.folderName() },
      text: message,
      ...(notify && { notify: true }),
    };
    await windowChatsIpc.mailPut(newId("mail"), to.id, encodeMail(mail));
  }

  /** Takes the mail for chats open here and delivers it. */
  async readMail(): Promise<void> {
    if (this.reading || this.disposed) return;
    this.reading = true;
    try {
      const waiting = await windowChatsIpc.mailList().catch(() => []);
      for (const entry of waiting) {
        const target = this.sessions.find(entry.chat);
        if (!target || target.deleted) continue;
        const text = await windowChatsIpc.mailClaim(entry.id).catch(() => null);
        const mail = text === null ? null : decodeMail(text);
        if (!mail || target.deleted) continue;
        this.deliver(target, mail);
      }
    } finally {
      this.reading = false;
    }
  }

  private deliver(target: AgentSession, mail: WindowMail): void {
    // Always named as from another window (its card doesn't open it here).
    const from = { ...mail.from, window: mail.from.window || "without a folder" };
    if (mail.kind === "idle") {
      deliverAutoMessage(target, idleNoteText(from, mail.text), "chat");
      this.sessions.changed();
      return;
    }
    const item = deliverAutoMessage(
      target,
      chatMessageText(from, mail.text, !!mail.notify),
      "chat",
    );
    this.sessions.changed();
    if (!mail.notify) return;
    // The note back goes to the sender's chat, wherever it is now.
    this.whenIdle(target, item.id, (answer) => {
      const back: WindowMail = {
        kind: "idle",
        to: mail.from.id,
        from: { id: target.id, title: target.title.peek(), window: this.folderName() },
        text: answer,
      };
      void windowChatsIpc.mailPut(newId("mail"), mail.from.id, encodeMail(back)).catch(() => {});
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.published) void windowChatsIpc.unpublish().catch(() => {});
  }
}

export function registerChatWindows(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
  whenIdle: WhenIdle,
): ChatWindows {
  const windows = new ChatWindows(services, sessions, whenIdle);
  sub.add(windows);
  const publish = setInterval(() => void windows.publish(), PUBLISH_MS);
  const mail = setInterval(() => void windows.readMail(), MAIL_MS);
  sub.add({
    dispose: () => {
      clearInterval(publish);
      clearInterval(mail);
    },
  });
  // A window closing (or reloading) takes its chats out at once rather than when it's found gone.
  const unload = () => windows.dispose();
  window.addEventListener("beforeunload", unload);
  sub.add({ dispose: () => window.removeEventListener("beforeunload", unload) });
  void windows.publish();
  return windows;
}

// Messages between the user's chats (D325, Claude Code's ListAgents + SendMessage): an agent may
// list the folder's other chats and send one a message; it arrives there as a message marked as
// from this chat (the user sees it), starting a turn; `notify_when_idle` brings one note back
// when that chat next goes idle. The DOM-free part: the texts, reading them back for the view,
// the rate limit and the "went idle" rule.

/** Sends from one chat in CHAT_SEND_WINDOW_MS at most (two agents can't talk forever). */
export const MAX_CHAT_SENDS = 20;
export const CHAT_SEND_WINDOW_MS = 10 * 60_000;
/** Lines of the other chat's answer the idle note carries. */
const NOTE_LINES = 8;
const NOTE_CHARS = 800;

/** The message as the other chat's agent reads it. Its first line is what that chat shows. */
export function chatMessageText(
  from: { id: string; title: string; window?: string },
  message: string,
  replyAsked: boolean,
): string {
  // From another window (D359): its folder is named, so the reader knows where it works.
  const where = from.window ? ` in window "${from.window}"` : "";
  return [
    `Message from chat "${from.title}" (${from.id})${where}`,
    "",
    message.trim(),
    "",
    `(Sent by that chat's agent, not typed by the user, who can see it here. Your own permissions apply as usual.${
      replyAsked
        ? " It will see your answer's first lines when you're done; to send it more, message_chat it."
        : " To answer it, use message_chat with that chat's id."
    })`,
  ].join("\n");
}

/** The sender chat's title and id, and the message, from that text (the view's card). */
export function readChatMessage(
  text: string,
): { title: string; id: string; body: string; window?: string } | null {
  const m =
    /^Message from chat "(.*)" \(([^)\s]+)\)(?: in window "(.*)")?\n\n([\s\S]*?)(?:\n\n\(Sent by that chat's agent[\s\S]*)?$/.exec(
      text,
    );
  if (!m) return null;
  return {
    title: m[1] ?? "",
    id: m[2] ?? "",
    body: (m[4] ?? "").trim(),
    ...(m[3] && { window: m[3] }),
  };
}

/** The note back in the sender's chat when the other chat went idle. */
export function idleNoteText(
  chat: { id: string; title: string; window?: string },
  lastAnswer: string,
): string {
  const lines = lastAnswer.trim().split("\n").slice(0, NOTE_LINES).join("\n");
  const short = lines.length > NOTE_CHARS ? `${lines.slice(0, NOTE_CHARS)}…` : lines;
  const more = short.length < lastAnswer.trim().length;
  return [
    `Chat "${chat.title}" (${chat.id})${chat.window ? ` in window "${chat.window}"` : ""} is idle now`,
    "",
    short ? `Its last answer${more ? " begins" : ""}:\n${short}` : "It didn't answer in words.",
  ].join("\n");
}

/** Whether a sender may send one more now; records it when it may. */
export class SendLimiter {
  private readonly sent = new Map<string, number[]>();

  constructor(
    private readonly max = MAX_CHAT_SENDS,
    private readonly windowMs = CHAT_SEND_WINDOW_MS,
  ) {}

  take(sender: string, now: number): boolean {
    const recent = (this.sent.get(sender) ?? []).filter((t) => t > now - this.windowMs);
    if (recent.length >= this.max) {
      this.sent.set(sender, recent);
      return false;
    }
    recent.push(now);
    this.sent.set(sender, recent);
    return true;
  }
}

/**
 * The chat went idle after our message: the message was taken into its conversation (not still
 * waiting), nothing runs, and an answer came after it (or it ended without one, after running).
 */
export function wentIdle(
  items: readonly { type: string; id: string; text?: string }[],
  messageId: string,
  status: "idle" | "running" | "waiting",
  ranSince: boolean,
): { done: boolean; answer: string } {
  const at = items.findIndex((i) => i.id === messageId);
  if (at < 0 || status !== "idle") return { done: false, answer: "" };
  let answer = "";
  for (let i = items.length - 1; i > at; i--) {
    const it = items[i];
    if (it?.type === "assistant" && it.text?.trim()) {
      answer = it.text;
      break;
    }
  }
  return { done: !!answer || ranSince, answer };
}

/** "agent", one of the user's agents (`custom:<name>` mode), or a group chat's members. */
export function chatAgentOf(meta: { mode?: unknown; members?: unknown }): string {
  if (Array.isArray(meta.members) && meta.members.length)
    return meta.members.filter((m): m is string => typeof m === "string").join(", ");
  if (typeof meta.mode === "string" && meta.mode.startsWith("custom:")) return meta.mode.slice(7);
  return "agent";
}

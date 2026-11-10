// Messages between chats in different windows (D359, Claude Code's SendMessage across sessions).
// Each window is its own process: it publishes its chats (id, title, agent, working or idle) to
// a file of its own in the data folder, and reads the other live windows' files for list_chats.
// A message for a chat in another window is a mail in a shared mailbox, taken exactly once by
// the window that has that chat open; a `notify_when_idle` note comes back the same way. The
// DOM-free part: the published record, merging the windows' lists, and the mail's shape.

export type WindowChatStatus = "working" | "waiting for the user" | "idle";

export interface WindowChat {
  id: string;
  title: string;
  agent: string;
  status: WindowChatStatus;
}

/** What one window publishes. */
export interface WindowChats {
  /** Its process (Rust fills it in). */
  pid: number;
  /** The folder it has open ("" for none), as the user knows it. */
  folder: string;
  /** When it wrote this (ms; Rust fills it in). */
  at: number;
  chats: WindowChat[];
}

/** A chat in another window, as list_chats shows it. */
export interface OtherWindowChat extends WindowChat {
  /** The window's folder (its name), "" for a window without one. */
  window: string;
  folderPath: string;
}

/** Chats one window publishes at most (the newest). */
export const PUBLISHED_CHATS = 40;

const STATUSES: readonly WindowChatStatus[] = ["working", "waiting for the user", "idle"];

function folderName(path: string): string {
  const parts = path.replaceAll("\\", "/").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

/** One window's record from its file's text, or null when it isn't one. */
export function parseWindowChats(text: string): WindowChats | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const o = v as Partial<WindowChats> | null;
  if (!o || typeof o.pid !== "number" || !Array.isArray(o.chats)) return null;
  const chats: WindowChat[] = [];
  for (const c of o.chats) {
    const x = c as Partial<WindowChat> | null;
    if (!x || typeof x.id !== "string" || !/^[\w-]{1,80}$/.test(x.id)) continue;
    chats.push({
      id: x.id,
      title: typeof x.title === "string" ? x.title.slice(0, 200) : "Chat",
      agent: typeof x.agent === "string" ? x.agent.slice(0, 200) : "agent",
      status: STATUSES.includes(x.status as WindowChatStatus)
        ? (x.status as WindowChatStatus)
        : "idle",
    });
  }
  return {
    pid: o.pid,
    folder: typeof o.folder === "string" ? o.folder : "",
    at: typeof o.at === "number" ? o.at : 0,
    chats,
  };
}

/**
 * The chats open in other windows: every live window's but this one's (`ownPid`), less the ones
 * loaded here (`here`: a chat open in two windows is this window's), each once (the newest
 * record wins).
 */
export function otherWindowChats(
  windows: readonly WindowChats[],
  ownPid: number,
  here: ReadonlySet<string>,
): OtherWindowChat[] {
  const out = new Map<string, OtherWindowChat & { at: number }>();
  for (const w of windows) {
    if (w.pid === ownPid) continue;
    for (const c of w.chats) {
      if (here.has(c.id)) continue;
      const known = out.get(c.id);
      if (known && known.at >= w.at) continue;
      out.set(c.id, {
        ...c,
        window: w.folder ? folderName(w.folder) : "",
        folderPath: w.folder,
        at: w.at,
      });
    }
  }
  return [...out.values()].map(({ at: _at, ...c }) => c);
}

/** A mail between windows: a message for a chat, or the note back when it went idle. */
export interface WindowMail {
  kind: "message" | "idle";
  /** The chat it's for. */
  to: string;
  from: { id: string; title: string; window: string };
  /** The message (or the idle note's answer). */
  text: string;
  /** A message: send a note back when the chat next goes idle. */
  notify?: boolean;
}

/** The mail's text in the shared mailbox. */
export function encodeMail(mail: WindowMail): string {
  return JSON.stringify(mail);
}

/** A mail from the mailbox, or null when it isn't one (it's then dropped). */
export function decodeMail(text: string): WindowMail | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const o = v as Partial<WindowMail> | null;
  const from = o?.from as Partial<WindowMail["from"]> | undefined;
  if (
    !o ||
    (o.kind !== "message" && o.kind !== "idle") ||
    typeof o.to !== "string" ||
    typeof o.text !== "string" ||
    !from ||
    typeof from.id !== "string" ||
    typeof from.title !== "string"
  )
    return null;
  return {
    kind: o.kind,
    to: o.to,
    from: {
      id: from.id,
      title: from.title,
      window: typeof from.window === "string" ? from.window : "",
    },
    text: o.text,
    ...(o.notify === true && { notify: true }),
  };
}

/** Whether a published record should be written again: its chats changed, or it's getting old. */
export function shouldRepublish(
  last: { text: string; at: number } | null,
  text: string,
  now: number,
  everyMs: number,
): boolean {
  return !last || last.text !== text || now - last.at >= everyMs;
}

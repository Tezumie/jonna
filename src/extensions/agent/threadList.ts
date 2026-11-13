// This folder's threads (D237), saved and live, as one signal: the Channels sidebar, a channel's
// view, the Inbox and ide://agent/channels read it. Saved chats come from their files' meta (the
// list doesn't load each chat); open ones from the session, so a working thread updates at once.

import { MAIN_MEMBER } from "../../core/agent/groupChat";
import { isUnread, type ThreadParent, type ThreadRow } from "../../core/agent/rooms";
import { agentStoreIpc } from "../../core/ipc/agent";
import type { DisposableStore } from "../../core/lifecycle/index";
import { effect, signal } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import { isThisWorkspace } from "./chatWorkspace";
import { soloSpeaker } from "./groupChat";
import type { AgentSession } from "./session";
import { threadParent, threadPreview } from "./sessionStore";
import type { SessionManager } from "./sessions";
import type { ChatMode } from "./sessionTypes";
import { seenAt, seenSince } from "./unread";

export const threads = signal<readonly ThreadRow[]>([]);

/** A saved chat of another folder (D245: the sidebar's Recent list shows them after this one's). */
export interface OtherChat {
  id: string;
  title: string;
  updated: number;
  workspace: string;
  /** Who answers it (its mode's agent), and a group's agents: their faces in the list (D291). */
  speaker: string;
  members?: readonly string[];
  /** The model that wrote most of its replies (D364), for its face's logo (D410). */
  usedModel?: string;
  /** A fork (D422): the chat it was copied from. */
  forkOf?: string;
  pinned?: boolean;
  archived?: boolean;
}

/** Other folders' saved chats (every saved chat with a folder, when none is open). */
export const otherChats = signal<readonly OtherChat[]>([]);

/**
 * Whether there's any saved chat, in any folder: a brand-new user (none) isn't greeted with
 * "Welcome back" (core/agent/greetings.ts). False until the list is first read.
 */
export const hasSavedChats = signal(false);

/** Whether a stored workspace is this window's (D251: its first folder or its workspace file). */
type Mine = (workspace: string | null | undefined) => boolean;

function otherChat(id: string, raw: unknown, mine: Mine): OtherChat | null {
  const meta = (raw ?? {}) as Record<string, unknown>;
  const workspace = str(meta.workspace);
  if (!workspace || mine(workspace)) return null;
  // A thread opens from its channel; the list keeps to conversations.
  if (threadParent(meta.parent)) return null;
  const members = Array.isArray(meta.members)
    ? meta.members.filter((m): m is string => typeof m === "string")
    : [];
  const mode = str(meta.mode);
  return {
    id,
    title: str(meta.title) ?? "Chat",
    updated: typeof meta.updated === "number" ? meta.updated : 0,
    workspace,
    speaker: mode ? soloSpeaker(mode as ChatMode) : MAIN_MEMBER,
    ...(members.length && { members }),
    // As this folder's rows have it (D410: another folder's showed today's default's logo).
    ...((str(meta.usedModel) ?? str(meta.model)) && {
      usedModel: str(meta.usedModel) ?? str(meta.model),
    }),
    ...(typeof meta.forkOf === "string" && { forkOf: meta.forkOf }),
    ...(meta.pinned === true && { pinned: true }),
    ...(meta.archived === true && { archived: true }),
  };
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** What a saved chat's meta says, as a row (null when it's another folder's). */
function savedRow(
  id: string,
  raw: unknown,
  open: boolean,
  mine: Mine,
): (ThreadRow & { workspace: string | null }) | null {
  const meta = (raw ?? {}) as Record<string, unknown>;
  const workspace = str(meta.workspace) ?? null;
  if (open ? !mine(workspace) : workspace) return null;
  const members = Array.isArray(meta.members)
    ? meta.members.filter((m): m is string => typeof m === "string")
    : [];
  const mode = str(meta.mode);
  return {
    id,
    title: str(meta.title) ?? "Thread",
    workspace,
    updated: typeof meta.updated === "number" ? meta.updated : 0,
    speaker: mode ? soloSpeaker(mode as ChatMode) : MAIN_MEMBER,
    ...(str(meta.room) && { room: str(meta.room) }),
    ...(members.length && { members }),
    ...(meta.error === true && { failed: true }),
    ...(str(meta.first) && { first: str(meta.first) }),
    ...(str(meta.last) && { last: str(meta.last) }),
    ...(str(meta.lastBy) && { lastBy: str(meta.lastBy) }),
    ...(typeof meta.replies === "number" && { replies: meta.replies }),
    ...(str(meta.recap) && { recap: str(meta.recap) }),
    ...((str(meta.usedModel) ?? str(meta.model)) && {
      usedModel: str(meta.usedModel) ?? str(meta.model),
    }),
    // The agent's wrap-up asked and stopped until the user answers (D301).
    ...(meta.blocked === true && meta.status !== "running" && { waiting: true }),
    ...(threadParent(meta.parent) && { parent: threadParent(meta.parent) as ThreadParent }),
    ...(str(meta.forkOf) && { forkOf: str(meta.forkOf) }),
    ...(meta.pinned === true && { pinned: true }),
    ...(meta.archived === true && { archived: true }),
  };
}

/** An open session as a row. */
export function liveRow(s: AgentSession): ThreadRow {
  const status = s.status.peek();
  const { blocked, ...preview } = threadPreview(s.items);
  return {
    id: s.id,
    title: s.title.peek(),
    updated: s.updated,
    speaker: soloSpeaker(s.chatMode.peek()),
    ...(s.room && { room: s.room }),
    ...(s.members.peek().length && { members: s.members.peek() }),
    ...(status === "running" && { running: true }),
    ...(status === "waiting" && { waiting: true, running: true }),
    ...(!!s.error.peek() && { failed: true }),
    ...(s.parent && { parent: s.parent }),
    ...(s.forkOf && { forkOf: s.forkOf }),
    ...(s.pinned && { pinned: true }),
    ...(s.archived && { archived: true }),
    ...(s.model.peek() && { usedModel: s.model.peek() as string }),
    ...preview,
    // The agent's wrap-up asked and stopped until the user answers (D301).
    ...(blocked && status === "idle" && { waiting: true }),
  };
}

export function registerThreadList(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
): { refresh(): Promise<void> } {
  let saved: ThreadRow[] = [];
  let loading = 0;
  /** What the lists show of the rows last published: an update that changes none is skipped. */
  let shown = "";
  const merge = () => {
    const open = !!services.workspace.root.peek();
    const byId = new Map(saved.map((r) => [r.id, r]));
    for (const s of sessions.all()) {
      // An empty new thread isn't one yet; another folder's chat belongs there.
      if (!s.items.length) continue;
      const where = s.workspaceRoot;
      if (open ? where && !isThisWorkspace(services, where) : where) continue;
      byId.set(s.id, liveRow(s));
    }
    // Unread (D238): replies since you last saw it.
    const seen = seenAt.peek();
    const since = seenSince.peek();
    const rows = [...byId.values()].map((r) =>
      isUnread(r, seen.get(r.id), since) ? { ...r, unread: true } : r,
    );
    // A streaming reply changes its chat on every chunk; the lists redraw only when what they
    // show changed (D244: the sidebar and the Inbox were rebuilt, and lost focus, on each one).
    const key = JSON.stringify(rows);
    if (key === shown) return;
    shown = key;
    threads.value = rows;
  };
  // Changes while agents work come in bursts: one merge for each burst, at most every 150 ms.
  let mergeTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleMerge = () => {
    if (mergeTimer !== undefined) return;
    mergeTimer = setTimeout(() => {
      mergeTimer = undefined;
      merge();
    }, 150);
  };
  sub.add({ dispose: () => clearTimeout(mergeTimer) });
  const refresh = async () => {
    const token = ++loading;
    const list = await agentStoreIpc.list().catch(() => []);
    if (token !== loading) return;
    if (hasSavedChats.peek() !== list.length > 0) hasSavedChats.value = list.length > 0;
    const open = !!services.workspace.root.peek();
    const mine: Mine = (w) => isThisWorkspace(services, w);
    saved = list.flatMap((r) => savedRow(r.id, r.meta, open, mine) ?? []);
    const others = list.flatMap((r) => otherChat(r.id, r.meta, mine) ?? []);
    if (JSON.stringify(others) !== JSON.stringify(otherChats.peek())) otherChats.value = others;
    merge();
  };
  sub.add(
    effect(() => {
      sessions.listVersion.value;
      services.workspace.root.value;
      services.workspace.file.value;
      void refresh();
      return undefined;
    }),
  );
  // Open threads change as they work: their titles, status and replies.
  sub.add(
    effect(() => {
      // A new session joins the list when it's made active or saved.
      sessions.active.value;
      sessions.listVersion.value;
      seenAt.value;
      for (const s of sessions.all()) {
        s.title.value;
        s.status.value;
        s.version.value;
        s.members.value;
        s.error.value;
      }
      scheduleMerge();
      return undefined;
    }),
  );
  // Saved chats finish in other windows too. The list reads every chat's file (D244): only
  // while this window is in front, and not often.
  const timer = setInterval(() => {
    if (document.visibilityState === "visible" && document.hasFocus()) void refresh();
  }, 30_000);
  sub.add({ dispose: () => clearInterval(timer) });
  return { refresh };
}

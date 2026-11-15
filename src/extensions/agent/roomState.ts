// The channels and direct messages of this folder as state (D237, D238): the list, each agent's
// direct-message conversation, and what a chat needs to know about its own room (which room it
// is, what its messages are told, joining one). No commands and no views: a chat's turn reads
// these. The commands, memory and task channels are in roomService.ts.

import { BUILT_IN_AGENT_NAMES } from "../../core/agent/builtInAgents";
import { customModeId } from "../../core/agent/chatModes";
import { MAIN_MEMBER } from "../../core/agent/groupChat";
import {
  DM_PREFIX,
  defaultRooms,
  dmAgent,
  dmRoomId,
  ROOM_BRIEF_PREFIX,
  type Room,
  roomBriefLine,
  roomName,
} from "../../core/agent/rooms";
import { signal } from "../../core/reactive/index";
import { knownAgents, memberInfo } from "./groupChat";
import type { AgentSession } from "./session";
import type { ChatMode } from "./sessionTypes";

/** This folder's channels (archived ones included, hidden in lists). */
export const rooms = signal<readonly Room[]>(defaultRooms(BUILT_IN_AGENT_NAMES));
/** Each agent's direct-message conversation (agent name → session id). */
export const dmSessions = signal<ReadonlyMap<string, string>>(new Map());

export const INBOX = "inbox";

/** A channel by id, name or "#name"; a direct message by `dm:<agent>`, agent name or label. */
export function resolveRoom(ref: string): string | null {
  const raw = ref.trim();
  if (!raw) return null;
  if (raw === INBOX) return INBOX;
  // A direct message by its agent's id (case and label normalized: one conversation per agent).
  if (raw.startsWith(DM_PREFIX)) {
    const info = memberInfo(raw.slice(DM_PREFIX.length));
    return info.known ? dmRoomId(info.name) : null;
  }
  const name = roomName(raw);
  const channel = () =>
    rooms.peek().find((r) => !r.archived && (r.id === raw || r.name === name))?.id ?? null;
  // "#name" is a channel; a bare name is an agent's direct messages first (D244: a channel named
  // like an agent mustn't take its messages).
  if (raw.startsWith("#")) return channel();
  const agent = knownAgents().find(
    (a) =>
      a.name.toLowerCase() === raw.toLowerCase() || a.label.toLowerCase() === raw.toLowerCase(),
  );
  return agent ? dmRoomId(agent.name) : channel();
}

export function roomById(id: string | null | undefined): Room | undefined {
  return id ? rooms.peek().find((r) => r.id === id) : undefined;
}

/** "#general", the agent's name for a direct message, "Inbox". */
export function roomTitle(id: string): string {
  if (id === INBOX) return "Inbox";
  const agent = dmAgent(id);
  if (agent) return memberInfo(agent).label;
  const room = roomById(id);
  return room ? `#${room.name}` : `#${id}`;
}

/** The room whose conversation `session` is (not a thread: that's in `session.parent`). */
export function conversationRoom(sessionId: string): string | null {
  const room = rooms.peek().find((r) => r.session === sessionId);
  if (room) return room.id;
  for (const [agent, id] of dmSessions.peek()) if (id === sessionId) return dmRoomId(agent);
  return null;
}

/** What a conversation in a channel or a thread is told with each message. */
export function roomContext(session: AgentSession): string | null {
  return roomBriefLine(roomById(session.room) ?? null, session.parent);
}

export function isRoomContext(text: string): boolean {
  return text.startsWith(ROOM_BRIEF_PREFIX);
}

/** The agent a chat is with: `custom:<name>`, or `agent` for the main one in any mode (D249). */
function chatAgentOf(session: AgentSession): string {
  const mode = session.chatMode.peek();
  return mode.startsWith("custom:") ? mode : "agent";
}

/** Makes `session` a conversation of `roomId`: its agents (a channel's as a group). */
export function joinRoom(session: AgentSession, roomId: string): void {
  session.room = roomId;
  const agent = dmAgent(roomId);
  if (agent) {
    session.members.value = [];
    // In the mode it starts in (D249), only when it changes: a mode picked since stays.
    const mode = (agent === MAIN_MEMBER ? "agent" : customModeId(agent)) as ChatMode;
    if (chatAgentOf(session) !== mode) session.setAgent(mode);
    return;
  }
  const room = roomById(roomId);
  const known = (n: string) => memberInfo(n).known;
  const members = room ? room.members.filter(known) : [];
  if (members.length > 1) {
    session.members.value = members;
    session.chatMode.value = "agent";
  } else {
    session.members.value = [];
    const only = members[0] ?? MAIN_MEMBER;
    const mode = (only === MAIN_MEMBER ? "agent" : customModeId(only)) as ChatMode;
    if (chatAgentOf(session) !== mode) session.setAgent(mode);
  }
}

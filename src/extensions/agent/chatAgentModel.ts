// Whose model a chat runs on (D242). A chat with one of the user's agents (Builder's direct
// messages) runs on that agent's own model when it has one (set on the Agents page or in its file),
// not the main agent's; the composer's model pill shows and changes that agent's model. A group
// chat's pill lists each agent with its model instead.

import { findCustomMode } from "../../core/agent/chatModes";
import { customModes } from "./customModes";
import type { AgentSession } from "./session";

/** The user's agent a chat is with (one agent, not a group), else null. */
export function soloAgentOf(session: AgentSession, track = false): string | null {
  if ((track ? session.members.value : session.members.peek()).length) return null;
  const mode = track ? session.chatMode.value : session.chatMode.peek();
  if (!mode.startsWith("custom:")) return null;
  const found = findCustomMode(track ? customModes.value : customModes.peek(), mode);
  return found?.agent ? found.name : null;
}

/** The model an agent's chat mode asks for (its own), or null for "same as the chat". */
export function agentOwnModel(name: string, track = false): string | null {
  const found = findCustomMode(track ? customModes.value : customModes.peek(), `custom:${name}`);
  const model = found?.model?.trim();
  return model && !/^(default|inherit)$/i.test(model) ? model : null;
}

/** The model key a chat runs on: its agent's own, else the chat's (null: the default). */
export function chatModelKey(session: AgentSession, track = false): string | null {
  const agent = soloAgentOf(session, track);
  const own = agent ? agentOwnModel(agent, track) : null;
  return own ?? (track ? session.model.value : session.model.peek());
}

// "@name" in the agent's chat for an extension's chat participant (D255, VS Code's chat
// participants): a message that starts with a participant's name goes to it instead of the model
// (`@name /command rest` passes its slash command), and its Markdown answer shows in the chat under
// "@name". The user's own agents keep their names: one of them by that name wins. Participants are
// what extensions register with ide.chat.createChatParticipant (opt-in, extensions' language model
// access).
import { findCustomMode } from "../../core/agent/chatModes";
import type { ChatParticipantEntry } from "../../workbench/extensionHooks";
import { customModes } from "./customModes";
import { newId } from "./ids";
import type { AgentSession } from "./session";

/** `@name [/command] rest` → its parts, or null for a message that doesn't start with a name. */
export function participantMessage(
  text: string,
): { name: string; command?: string; prompt: string } | null {
  const m = /^@([\w.-]+)(?:\s+\/([\w-]+))?\s*([\s\S]*)$/.exec(text.trim());
  if (!m?.[1]) return null;
  return { name: m[1], ...(m[2] && { command: m[2] }), prompt: (m[3] ?? "").trim() };
}

/** The chat's own mentions (context, not someone to ask): never an extension's name. */
const BUILT_IN = new Set([
  "problems",
  "terminal",
  "selection",
  "web",
  "docs",
  "git",
  "commit",
  "branch",
  "chat",
  "rules",
  "symbol",
  "file",
  "folder",
  "all",
  "agent",
]);

/** The extension participant a message is for, unless one of the user's agents has that name. */
export function participantFor(
  session: AgentSession,
  text: string,
): { participant: ChatParticipantEntry; command?: string; prompt: string } | null {
  const msg = participantMessage(text);
  if (!msg) return null;
  const name = msg.name.toLowerCase();
  if (BUILT_IN.has(name)) return null;
  if (findCustomMode(customModes.peek(), `custom:${msg.name}`)) return null;
  const participant = session.services.extensionFeatures.hooks.chatParticipants
    .peek()
    .find((p) => p.name.toLowerCase() === name);
  return participant
    ? { participant, ...(msg.command && { command: msg.command }), prompt: msg.prompt }
    : null;
}

/** Sends the message to the participant and adds its answer (or why it failed) to the chat. */
export async function sendToParticipant(
  session: AgentSession,
  text: string,
  to: { participant: ChatParticipantEntry; command?: string; prompt: string },
): Promise<void> {
  const label = `@${to.participant.name}`;
  session.items.push({ type: "user", id: newId("u"), text });
  session.cancelled = false;
  session.error.value = null;
  session.status.value = "running";
  session.bump();
  try {
    const { markdown } = await to.participant.request(to.prompt, to.command);
    if (session.cancelled) return;
    session.items.push({
      type: "assistant",
      id: newId("a"),
      text: markdown || "(no answer)",
      thinking: "",
      streaming: false,
      model: label,
      speaker: label,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    session.items.push({
      type: "notice",
      id: newId("n"),
      text: `${label} couldn't answer: ${message}`,
      tone: "error",
    });
    session.error.value = message;
  } finally {
    session.status.value = "idle";
    session.bump();
  }
}

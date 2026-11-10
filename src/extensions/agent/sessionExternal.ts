// An agent session answered by an external agent (ACP, D73): its backend, kept per session, and
// one turn sent to it. Split from session.ts (D221); the session's state stays there.

import { parsePlanLimits } from "../../core/acp/planLimits";
import type { SentAttachment } from "../../core/agent/attachments";
import { transcript } from "../../core/agent/compact";
import type { Item } from "../../core/agent/conversation";
import { CATCH_UP_PREFIX } from "../../core/agent/groupChat";
import { shortError } from "../../core/agent/loop";
import { product } from "../../core/product";
import { AcpBackend } from "./acp";
import { type ExternalAgentConfig, externalAgents } from "./acpAgents";
import { nameChat } from "./chatTitle";
import { ideState } from "./context";
import { memberInfo } from "./groupChat";
import { newId } from "./ids";
import type { AgentSession } from "./session";

/** This session's backend for `config` (a new one when the agent changed). */
export async function externalFor(
  session: AgentSession,
  config: ExternalAgentConfig,
): Promise<AcpBackend> {
  // Same agent: same name and command (custom agents' config objects are rebuilt each time).
  const key = (c: ExternalAgentConfig) => JSON.stringify([c.name, c.command, c.args, c.env]);
  if (!session.external || key(session.external.config) !== key(config)) {
    // Another agent had the chat (members on different external agents, D249): this one is told
    // the whole conversation when it starts, not only what came after the other's last turn.
    if (session.external) session.externalSeen = null;
    await session.external?.stop();
    session.agentSettings.value = null;
    session.external = new AcpBackend(session.services, session, config);
  }
  return session.external;
}

/** The external agent this session's model names ("acp/<name>"), if any. */
export function externalConfig(session: AgentSession): ExternalAgentConfig | null {
  const key = session.model.peek();
  if (!key?.startsWith("acp/")) return null;
  const name = key.slice(4);
  return externalAgents(session.services).find((a) => a.name === name) ?? null;
}

export async function sendExternal(
  session: AgentSession,
  text: string,
  name: string,
  context: string[] = [],
  opts: {
    images?: string[];
    attachments?: SentAttachment[];
    /** The message is already in the chat (a group chat's hand-off note, D232). */
    existing?: Item;
    /** Called once the turn has started (its message is in the chat), D233. */
    onStart?: () => void;
    /** The answering agent's own model of the external agent (D288). */
    model?: string | undefined;
  } = {},
): Promise<void> {
  const config = externalAgents(session.services).find((a) => a.name === name);
  if (!config) throw new Error(`No external agent named ${name} (see agent.externalAgents).`);
  // After a retry or an edit, the agent's own session still remembers the dropped turns: it
  // starts over, with a recap of the conversation so far (D160).
  let recap = "";
  // A group chat's replies say who wrote them (D235): another member may have been on another model.
  const nameOf = (n: string) => memberInfo(n).label;
  // Started in another folder: its own tools work in its cwd, so it starts over here (D161).
  // With no folder it works in the chat's private folder (D208): opening one moves it there.
  if (session.external && !session.external.startedFor(session.services.workspace.root.peek()))
    session.externalStale = true;
  // Started over with another launch model (Copilot's --model): it remembers nothing (D194).
  if (session.external?.lostContext) session.externalStale = true;
  if (session.external && session.externalStale) {
    await session.external.stop();
    session.external = undefined;
    // Its old session remembers the dropped turns: not the one to pick up again.
    session.acpResume = null;
    const earlier = transcript(session.items, 20_000, nameOf).trim();
    if (earlier) recap = `Earlier in this conversation (you were restarted):\n${earlier}`;
  }
  session.externalStale = false;
  await externalFor(session, config);
  if (!session.external) throw new Error(`${name} isn't running.`);
  // For an agent that starts without the chat (a restart, and no session/load, D200).
  // Without the hand-off note being sent as the message (it would come twice).
  const earlierItems = opts.existing
    ? session.items.filter((it) => it !== opts.existing)
    : session.items;
  const history = recap ? "" : transcript(earlierItems, 20_000, nameOf);
  // What was said while another model had the turn (a group member on its own model, D235).
  const seenAt = session.externalSeen ? earlierItems.indexOf(session.externalSeen) : -1;
  const missed =
    !recap && seenAt >= 0 ? transcript(earlierItems.slice(seenAt + 1), 20_000, nameOf).trim() : "";
  if (missed) context = [`${CATCH_UP_PREFIX}${missed}`, ...context];
  // A channel's conversation keeps the channel's name (D415).
  if (session.items.length === 0 && !session.keepsTitle) {
    session.title.value = text.replace(/\s+/g, " ").slice(0, 60);
    // An external agent isn't asked for a title: the chat is named after its first answer (D294).
    session.wantTitle = session.services.settings.peek<boolean>("agent.autoTitle") !== false;
  }
  session.turn++;
  // The hand-off note belongs to this turn (checkpoints and Revert group by turn).
  if (opts.existing?.type === "user") opts.existing.turn = session.turn;
  if (!opts.existing)
    session.items.push({
      type: "user",
      id: newId("u"),
      text,
      turn: session.turn,
      ...(context.length && { context }),
      ...(opts.images?.length && { images: opts.images }),
      ...(opts.attachments?.length && { attachments: opts.attachments }),
    });
  session.status.value = "running";
  session.error.value = null;
  session.cancelled = false;
  opts.onStart?.();
  session.bump();
  const firstNew = session.items.length;
  try {
    // The IDE's state with each message, as the IDE's own agent gets it (D365): open browser tabs
    // and their console errors among it. Only when it has the IDE's tools to act on it.
    if (session.external.ideTools === "on") {
      const state = await ideState(session.services).catch(() => "");
      if (state)
        context = [
          `<ide_state>\n${state}\n</ide_state>\nThe IDE's state when this was sent, for you (don't repeat it). The IDE's tools come from its MCP server "${product.nameShort}"; ide_find_commands finds more.`,
          ...context,
        ];
    }
    await session.external.prompt(text, {
      context: recap ? [recap, ...context] : context,
      ...(history && { history }),
      ...(opts.images?.length && { images: opts.images }),
      model: opts.model,
    });
    // The agent's /status (D233): its plan limits as structured data, when its answer shows them.
    if (/^\/status\b/i.test(text.trim())) {
      const answer = session.items
        .slice(firstNew)
        .filter((it) => it.type === "assistant")
        .map((it) => (it.type === "assistant" ? it.text : ""))
        .join("\n");
      const limits = parsePlanLimits(answer);
      if (limits) session.externalLimits = { agent: name, at: Date.now(), limits };
    }
  } catch (err) {
    // A CLI's own error text can carry its terminal colors (ANSI codes): not shown in the chat.
    const message = (err instanceof Error ? err.message : String(err)).replace(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
      /\u001b\[[0-9;]*[A-Za-z]/g,
      "",
    );
    // Ended after a Stop it didn't answer: "Stopped." says it all (D161).
    if (!session.cancelled)
      session.items.push({
        type: "notice",
        id: newId("n"),
        text: shortError(message),
        detail: `${message}\n\n${name}`,
        tone: "error",
        actions: ["retry", "continue"],
      });
    if (!session.cancelled) session.error.value = message;
  } finally {
    // Stop's "hung agent" timer belongs to this turn: once it has ended, it mustn't end the next
    // turn's prompt (a message sent within 3 s of a Stop).
    clearTimeout(session.hungTimer);
    session.hungTimer = undefined;
    const usedKey = session.model.peek();
    for (const it of session.items)
      if (it.type === "assistant") {
        it.streaming = false;
        if (usedKey && session.items.indexOf(it) >= firstNew) it.modelKey ??= usedKey;
      }
    session.externalSeen = session.items[session.items.length - 1] ?? null;
    if (session.cancelled)
      session.items.push({
        type: "notice",
        id: newId("n"),
        text: session.stoppedText(),
        tone: "info",
      });
    if (
      session.changeset.files.peek().some((f) => f.turn === session.turn) ||
      session.autoApply.peek()
    )
      if (!session.checkpoints.includes(session.turn)) session.checkpoints.push(session.turn);
    session.status.value = "idle";
    session.bump();
    await session.save();
    if (session.wantTitle && !session.cancelled && !session.error.peek()) {
      session.wantTitle = false;
      void nameChat(session, session.title.peek());
    }
  }
}

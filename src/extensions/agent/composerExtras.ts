// More slash commands and @-mentions for the composer (D200), from other parts of the agent: MCP
// servers' prompts (`/mcp__<server>__<prompt>`) and resources (`@mcp <server> <uri>`), an external
// agent's own commands (ACP `available_commands_update`) and web searches (`@web search …`).
// commands.ts asks these sources when it lists, labels and expands, so the built-in lists there
// stay as they are. Sources register with a disposable.
import type { Disposable } from "../../core/lifecycle/index";
import type { IconName } from "../../ui/Icon";
import type { AgentSession } from "./session";
import type { SlashCommand } from "./slashCommands";

export interface SlashSource {
  /** Commands for this chat (names without the slash). */
  list(session: AgentSession | undefined): SlashCommand[] | Promise<SlashCommand[]>;
  /**
   * The context `/name args` sends with the message, or null when the name isn't this source's
   * (or the command goes to the agent as typed, like an external agent's own).
   */
  expand?(name: string, args: string, session: AgentSession): Promise<string | null>;
}

export interface MentionItem {
  id: string;
  label: string;
  description?: string;
  icon: IconName;
}

export interface MentionSource {
  /** Mentions this source owns start with this ("@mcp "). */
  prefix: string;
  icon: IconName;
  /** Picker rows for what was typed after "@". */
  items(query: string): MentionItem[] | Promise<MentionItem[]>;
  /** The card's label. */
  label(mention: string): string;
  /**
   * The context sent with the message (looked up when it's sent), for the chat sending it;
   * `message` is what was typed (@docs searches with it, D204).
   */
  context(mention: string, session?: AgentSession, message?: string): Promise<string>;
}

/**
 * Context that goes with a chat's next message without being mentioned again (D204: an
 * attached MCP resource that changed since). Asked by agent.send; an empty list adds nothing.
 */
export type SendContextSource = (session: AgentSession) => Promise<string[]>;

const sendSources = new Set<SendContextSource>();

export function registerSendContext(source: SendContextSource): Disposable {
  sendSources.add(source);
  return { dispose: () => void sendSources.delete(source) };
}

/** What every send-context source adds to this chat's next message. */
export async function extraSendContext(session: AgentSession): Promise<string[]> {
  const out: string[] = [];
  for (const source of sendSources) out.push(...(await source(session).catch(() => [])));
  return out;
}

const slashSources = new Set<SlashSource>();
const mentionSources = new Set<MentionSource>();

export function registerSlashSource(source: SlashSource): Disposable {
  slashSources.add(source);
  return { dispose: () => void slashSources.delete(source) };
}

export function registerMentionSource(source: MentionSource): Disposable {
  mentionSources.add(source);
  return { dispose: () => void mentionSources.delete(source) };
}

/** Every source's commands for this chat (a failing source is left out). */
export async function extraSlashCommands(
  session: AgentSession | undefined,
): Promise<SlashCommand[]> {
  const out: SlashCommand[] = [];
  for (const source of slashSources) {
    const list = await Promise.resolve(source.list(session)).catch(() => []);
    for (const c of list) if (!out.some((x) => x.name === c.name)) out.push(c);
  }
  return out;
}

/** `/name args` from a source: the context to send, or null. */
export async function expandExtraSlash(
  message: string,
  session: AgentSession,
): Promise<string | null> {
  const m = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(message.trim());
  if (!m?.[1]) return null;
  for (const source of slashSources) {
    const context = await source.expand?.(m[1], (m[2] ?? "").trim(), session);
    if (context) return context;
  }
  return null;
}

export function mentionSourceFor(mention: string): MentionSource | undefined {
  for (const s of mentionSources) if (mention.startsWith(s.prefix)) return s;
  return undefined;
}

/** Picker rows from every source for what was typed. */
export async function extraMentionItems(query: string): Promise<MentionItem[]> {
  const out: MentionItem[] = [];
  for (const s of mentionSources)
    out.push(...(await Promise.resolve(s.items(query)).catch(() => [])));
  return out;
}

/** A source's mention as a card: its label and icon. */
export function extraMentionCard(mention: string): [string, IconName] | undefined {
  const s = mentionSourceFor(mention);
  return s ? [s.label(mention), s.icon] : undefined;
}

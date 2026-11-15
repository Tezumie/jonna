// The interactive session's own slash commands: the ones a terminal answers itself. Anything
// else that starts with a slash goes to the agent as typed, where the app's commands
// (/compact, /undo, /init, prompt files, skills, MCP prompts…) are handled as in the app. Pure.

export interface FrontCommand {
  name: string;
  /** Other names for it. */
  aliases?: readonly string[];
  /** What it takes, for the help. */
  hint?: string;
  description: string;
}

export const FRONT_COMMANDS: readonly FrontCommand[] = [
  { name: "help", aliases: ["?"], description: "The commands, the session's and the app's" },
  { name: "model", hint: "[name|number]", description: "Show the models, or switch to one" },
  {
    name: "mode",
    hint: "[agent|plan|ask|<your agent>]",
    description: "Show or set how the agent works",
  },
  {
    name: "permissions",
    hint: "[ask|accept-edits|auto|full-access]",
    description: "Show or set what the agent may do without asking",
  },
  { name: "sessions", aliases: ["chats"], description: "This folder's saved chats" },
  { name: "resume", hint: "<id|number>", description: "Switch to a saved chat" },
  {
    name: "new",
    aliases: ["clear", "reset"],
    description: "Start a new chat (the old one stays saved)",
  },
  { name: "compact", hint: "[focus]", description: "Summarize the conversation to free context" },
  { name: "cost", aliases: ["usage"], description: "Tokens and cost of this chat" },
  { name: "status", description: "The model, mode, folder and chat" },
  { name: "diff", description: "The edits waiting for review" },
  { name: "accept", hint: "[path]", description: "Keep the edits waiting for review" },
  { name: "reject", hint: "[path]", description: "Drop the edits waiting for review" },
  { name: "exit", aliases: ["quit", "q"], description: "End the session" },
];

export type ParsedLine =
  /** One of the session's own commands. */
  | { kind: "front"; command: string; args: string }
  /** A slash command for the agent (the app's): sent as typed. */
  | { kind: "agent"; name: string; text: string }
  /** A message. */
  | { kind: "message"; text: string }
  | { kind: "empty" };

/**
 * What a typed line is. A slash only counts at the very start, followed by a name: a path
 * (`/usr/bin`) or a lone slash is a message.
 */
export function parseLine(line: string): ParsedLine {
  const text = line.trim();
  if (!text) return { kind: "empty" };
  const m = /^\/([A-Za-z?][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(text);
  if (!m) return { kind: "message", text };
  const name = (m[1] ?? "").toLowerCase();
  const front = FRONT_COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
  if (front) return { kind: "front", command: front.name, args: (m[2] ?? "").trim() };
  return { kind: "agent", name: m[1] ?? "", text };
}

/**
 * Joins lines typed with a trailing backslash into one message. Returns the message when the
 * last line ends it, or null while more is expected (`pending` then holds what there is).
 */
export class MultiLine {
  private lines: string[] = [];

  /** True while a message is being continued. */
  get open(): boolean {
    return this.lines.length > 0;
  }

  /** Adds a typed line; the whole message when it is complete, else null. */
  add(line: string): string | null {
    if (/(^|[^\\])(\\\\)*\\$/.test(line)) {
      this.lines.push(line.slice(0, -1));
      return null;
    }
    this.lines.push(line);
    const text = this.lines.join("\n");
    this.lines = [];
    return text;
  }

  /** Drops what was typed so far (Ctrl+C). */
  reset(): void {
    this.lines = [];
  }
}

/**
 * Picks from a numbered list by what was typed: a number (1-based), an exact id or name, or a
 * unique part of one. Null when nothing or several match.
 */
export function pick<T>(
  typed: string,
  items: readonly T[],
  names: (item: T) => string[],
): T | null {
  const text = typed.trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return items[Number(text) - 1] ?? null;
  const lower = text.toLowerCase();
  const exact = items.filter((item) => names(item).some((n) => n.toLowerCase() === lower));
  if (exact.length >= 1) return exact[0] ?? null;
  const partial = items.filter((item) => names(item).some((n) => n.toLowerCase().includes(lower)));
  return partial.length === 1 ? (partial[0] ?? null) : null;
}

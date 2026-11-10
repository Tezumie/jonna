// MCP prompts and resources as chat context (D200): a server's prompts become slash commands
// (`/mcp__<server>__<prompt> args`, Claude Code's naming) and its resources @-mentions
// (`@mcp <server> <uri>`). This file holds the text handling: arguments typed after the command,
// a prompt's messages and a resource's contents as the text sent with the message. DOM-free;
// tested.
import { agentToolName } from "./client";

export interface McpPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

export interface McpResource {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

export interface McpPromptMessage {
  role?: string;
  content?: unknown;
}

/** The slash command's name for a server's prompt. */
export const promptCommandName = (server: string, prompt: string): string =>
  agentToolName(server, prompt);

/** "<focus> [depth]": the argument hint shown with the command. */
export function argumentHint(prompt: McpPrompt): string {
  return (prompt.arguments ?? [])
    .map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`))
    .join(" ");
}

/**
 * Arguments typed after the command: `name=value` pairs (values may be quoted) fill those
 * arguments, and the other words go to the remaining arguments in order, the last one taking
 * whatever is left. A prompt with one argument gets the whole text. Returns the values and the
 * required arguments still missing.
 */
export function parsePromptArgs(
  prompt: McpPrompt,
  text: string,
): { values: Record<string, string>; missing: string[] } {
  const args = prompt.arguments ?? [];
  const values: Record<string, string> = {};
  const t = text.trim();
  if (args.length === 1 && t && !/^[\w-]+=/.test(t)) {
    values[args[0]?.name ?? ""] = t;
  } else if (t) {
    const rest: string[] = [];
    const re = /([\w-]+)=("([^"]*)"|'([^']*)'|(\S+))|"([^"]*)"|(\S+)/g;
    for (const m of t.matchAll(re)) {
      if (m[1] && args.some((a) => a.name === m[1])) values[m[1]] = m[3] ?? m[4] ?? m[5] ?? "";
      else rest.push(m[6] ?? m[7] ?? m[0]);
    }
    const open = args.filter((a) => values[a.name] === undefined);
    open.forEach((a, i) => {
      if (!rest.length) return;
      values[a.name] = i === open.length - 1 ? rest.splice(0).join(" ") : (rest.shift() ?? "");
    });
  }
  const missing = args.filter((a) => a.required && !values[a.name]).map((a) => a.name);
  return { values, missing };
}

/** One content block as text: text as is, a resource's text, others named. */
export function contentText(content: unknown): string {
  const c = (content ?? {}) as {
    type?: string;
    text?: string;
    resource?: { uri?: string; text?: string; blob?: string };
    uri?: string;
    name?: string;
  };
  if (c.type === "text") return c.text ?? "";
  if (c.type === "resource")
    return c.resource?.text ?? `[resource ${c.resource?.uri ?? ""} (binary)]`;
  if (c.type === "resource_link") return `[resource ${c.name ?? ""} ${c.uri ?? ""}]`.trim();
  return `[${c.type ?? "content"}]`;
}

/** What a prompt's messages send with the user's message. */
export function promptContext(
  server: string,
  prompt: string,
  result: { description?: string; messages?: McpPromptMessage[] },
  maxChars = 40000,
): string {
  const parts = (result.messages ?? []).map((m) => {
    const text = contentText(m.content);
    return m.role === "assistant" ? `(assistant) ${text}` : text;
  });
  const body = parts.join("\n\n").trim() || "(the prompt is empty)";
  const clipped = body.length > maxChars ? `${body.slice(0, maxChars)}\n… (truncated)` : body;
  return `The user ran the MCP prompt /${promptCommandName(server, prompt)} from server ${server}${result.description ? ` (${result.description})` : ""}. Follow it:\n${clipped}`;
}

/** A resource's contents as context (`resources/read`). */
export function resourceContext(
  server: string,
  uri: string,
  result: { contents?: { uri?: string; mimeType?: string; text?: string; blob?: string }[] },
  maxChars = 20000,
): string {
  const parts = (result.contents ?? []).map((c) =>
    c.text !== undefined
      ? c.text
      : `[binary${c.mimeType ? ` ${c.mimeType}` : ""}, ${Math.floor(((c.blob ?? "").length * 3) / 4)} bytes]`,
  );
  const body = parts.join("\n\n");
  const clipped = body.length > maxChars ? `${body.slice(0, maxChars)}\n… (truncated)` : body;
  return `MCP resource ${uri} from server ${server}:\n\`\`\`\n${clipped || "(empty)"}\n\`\`\``;
}

/** The `@mcp <server> <uri>` mention for a resource, and back. */
export const resourceMention = (server: string, uri: string): string => `@mcp ${server} ${uri}`;

export function parseResourceMention(mention: string): { server: string; uri: string } | null {
  const m = /^@mcp\s+(\S+)\s+(\S.*)$/.exec(mention.trim());
  return m?.[1] && m[2] ? { server: m[1], uri: m[2].trim() } : null;
}

/** A resource's short label for its card: its title or name, else the end of its address. */
export function resourceLabel(r: Pick<McpResource, "uri" | "name" | "title">): string {
  if (r.title || r.name) return (r.title || r.name) ?? r.uri;
  const tail = r.uri
    .replace(/[?#].*$/, "")
    .split(/[/\\]/)
    .filter(Boolean)
    .pop();
  return tail || r.uri;
}

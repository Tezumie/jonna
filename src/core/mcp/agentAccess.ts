// The IDE's own MCP server lent to external agents (D211): an ACP agent (Codex, Claude Code,
// Gemini CLI…) gets the IDE's tools (terminals, editors, diagnostics, git, commands) with its
// session, the same tools Claude Code's `claude mcp add` connects to. Calls run as caller
// `{ kind: "mcp" }`, so the permission policy asks before anything that changes things.
//
// Not a command on purpose: the result carries the server's token, which no extension or agent
// should be able to ask for. The MCP extension provides it; the ACP backend borrows it.
//
// A chat that borrows it says who it is (D419): its token then ends in a key only that chat's
// agent has, and calls made with it run as caller `{ kind: "acp", agent, session }`: questions
// show in that chat, under its access mode, like the IDE's own agent's. Any other client of the
// server stays `{ kind: "mcp" }`.

export interface LentServer {
  url: string;
  token: string;
}

/** The chat an external agent works in: who its calls to the IDE's server are. */
export interface LentTo {
  /** The agent's name ("Claude Code"). */
  agent: string;
  /** The chat's id. */
  session: string;
}

/** The token a chat's agent sends: the server's, a dot, the chat's key (Rust `mcp/http.rs`). */
export function chatToken(token: string, key: string): string {
  return `${token}.${key}`;
}

/** A new chat key: letters and digits only (what the server accepts after the token). */
export function newChatKey(random: (bytes: Uint8Array<ArrayBuffer>) => void): string {
  const bytes = new Uint8Array(new ArrayBuffer(16));
  random(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface McpLender {
  /**
   * Starts the server if needed (without turning `mcp.enabled` on) and keeps it up for `owner`.
   * With `chat`, the token returned is that chat's own.
   */
  acquire(owner: string, chat?: LentTo): Promise<LentServer | null>;
  /** `owner` no longer needs it; the server stops when nobody does and the setting is off. */
  release(owner: string): void;
}

/** The IDE's executable as a stdio MCP server (D223; Rust `mcp/stdio_proxy.rs`). */
export interface StdioProxyCommand {
  command: string;
  flag: string;
  tokenEnv: string;
}

/** An ACP `McpServer` (HTTP, or stdio through the proxy). */
export type IdeMcpServer =
  | { type: "http"; name: string; url: string; headers: { name: string; value: string }[] }
  | { name: string; command: string; args: string[]; env: { name: string; value: string }[] };

/**
 * The lent server as the agent gets it: over HTTP with the token as a header, or — for an agent
 * that takes only stdio servers (`proxy` given) — the IDE's executable with the proxy flag and
 * the address as arguments and the token in the environment (other programs can read a
 * process's command line; its environment only with the same rights as the agent).
 */
export function ideMcpServer(
  lent: LentServer,
  productName: string,
  proxy: StdioProxyCommand | null,
): IdeMcpServer {
  const name = ideServerName(productName);
  if (!proxy)
    return {
      type: "http",
      name,
      url: lent.url,
      headers: [{ name: "Authorization", value: `Bearer ${lent.token}` }],
    };
  return {
    name,
    command: proxy.command,
    args: [proxy.flag, lent.url],
    env: [{ name: proxy.tokenEnv, value: lent.token }],
  };
}

/** The lent server's name, as the agent lists it among its MCP servers. */
export function ideServerName(productName: string): string {
  return productName.toLowerCase().replace(/[^a-z0-9_-]/g, "") || "ide";
}

/**
 * Whether an agent's own permission request is about one of the lent server's tools (D420):
 * agents name MCP tools `mcp__<server>__<tool>` (Claude Code's form). The agent asking "may I use
 * the IDE's tool?" before the IDE asks "may it run this command?" was two questions for one
 * action, and the first says less: the IDE's permission policy decides every such call anyway.
 */
export function isIdeToolRequest(title: string, productName: string): boolean {
  return title.startsWith(`mcp__${ideServerName(productName)}__`);
}

let lender: McpLender | null = null;

export const mcpAgentAccess = {
  provide(l: McpLender | null): void {
    lender = l;
  },
  acquire(owner: string, chat?: LentTo): Promise<LentServer | null> {
    return lender ? lender.acquire(owner, chat) : Promise.resolve(null);
  },
  release(owner: string): void {
    lender?.release(owner);
  },
};

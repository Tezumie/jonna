// The IDE's own MCP server lent to external agents (D211): an ACP agent (Codex, Claude Code,
// Gemini CLI…) gets the IDE's tools (terminals, editors, diagnostics, git, commands) with its
// session, the same tools Claude Code's `claude mcp add` connects to. Calls run as caller
// `{ kind: "mcp" }`, so the permission policy asks before anything that changes things.
//
// Not a command on purpose: the result carries the server's token, which no extension or agent
// should be able to ask for. The MCP extension provides it; the ACP backend borrows it.

export interface LentServer {
  url: string;
  token: string;
}

export interface McpLender {
  /** Starts the server if needed (without turning `mcp.enabled` on) and keeps it up for `owner`. */
  acquire(owner: string): Promise<LentServer | null>;
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
  const name = productName.toLowerCase().replace(/[^a-z0-9_-]/g, "") || "ide";
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

let lender: McpLender | null = null;

export const mcpAgentAccess = {
  provide(l: McpLender | null): void {
    lender = l;
  },
  acquire(owner: string): Promise<LentServer | null> {
    return lender ? lender.acquire(owner) : Promise.resolve(null);
  },
  release(owner: string): void {
    lender?.release(owner);
  },
};

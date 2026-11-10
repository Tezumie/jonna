// The user-facing side of the permission policy (core/permissions): asking whether an MCP client
// may run a command that changes something.
import type { AuthorizeRequest } from "../core/permissions/index";
import { showDialog } from "../ui/Dialog";

export function askMcpPermission(
  request: AuthorizeRequest & { client: string },
): Promise<"once" | "session" | "deny"> {
  const destructive = request.effects.includes("destructive");
  const what = request.effects.filter((e) => e !== "read").join(", ") || "changes";
  return showDialog<"once" | "session" | "deny">({
    title: `Allow ${request.client} to run "${request.title}"?`,
    message: `An external tool connected over MCP wants to run ${request.commandId} (${what}).${
      request.confirmMessage ? `\n\n${request.confirmMessage}` : ""
    }`,
    actions: [
      { label: "Deny", value: "deny" },
      ...(destructive ? [] : [{ label: "Allow for this session", value: "session" as const }]),
      { label: "Allow once", value: "once", variant: destructive ? "danger" : "primary" },
    ],
    cancelValue: "deny",
    defaultValue: "deny",
  });
}

type AgentAsk = (
  request: AuthorizeRequest & { session: string },
) => Promise<"once" | "session" | "deny">;
let agentAsk: AgentAsk | undefined;

/** The agent extension shows these requests inline in the session's conversation. */
export function setAgentPermissionHandler(handler: AgentAsk | undefined): void {
  agentAsk = handler;
}

export function askAgentPermission(
  request: AuthorizeRequest & { session: string },
): Promise<"once" | "session" | "deny"> {
  return agentAsk ? agentAsk(request) : Promise.resolve("deny");
}

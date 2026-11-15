// Asking whether an agent may run a command that changes something: the agent extension answers
// inline, in the session's conversation, so this needs no dialog. DOM-free.
import type { AuthorizeRequest } from "../core/permissions/index";

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

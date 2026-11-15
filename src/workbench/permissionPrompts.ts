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

// An agent's requests are asked in its conversation (agentPermission.ts, no dialog); importers keep
// this path.
export { askAgentPermission, setAgentPermissionHandler } from "./agentPermission";

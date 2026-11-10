// suggest_sandbox_allowance (D350): when a sandboxed command failed because it needed a host the
// network filter refused or a folder outside the project, the agent shows a card; Allow (the
// user's click, agent.allowSandboxSuggestion in sandboxRun.ts) keeps it for the project in
// agent.sandbox.projects. The agent never widens the sandbox itself. Offered only while commands
// run sandboxed (session.ts). Core logic in core/agent/sandboxPolicy.ts.

import { allowanceResult, allowanceText, parseAllowanceArgs } from "../../core/agent/sandboxPolicy";
import type { AgentTool } from "./tools";

export const SUGGEST_SANDBOX_ALLOWANCE_TOOL: AgentTool = {
  spec: {
    name: "suggest_sandbox_allowance",
    description:
      "Ask the user, as a card with an Allow button, to let this project's sandboxed commands reach hosts or write folders outside the project, kept for the project. Only after a sandboxed command failed because of that (its result names refused hosts, or a write outside the folder was denied) and the task needs it again. Name exact hosts (registry.npmjs.org, *.pythonhosted.org) and folders (absolute or ~/…), not wider ones. The card says what it allows: don't repeat it.",
    parameters: {
      type: "object",
      properties: {
        hosts: {
          type: "array",
          items: { type: "string" },
          description: 'Hosts to allow, e.g. ["registry.npmjs.org"]',
        },
        folders: {
          type: "array",
          items: { type: "string" },
          description: "Folders outside the project to make writable",
        },
        reason: {
          type: "string",
          description: "One line on what needs it, shown on the card",
        },
      },
      required: ["reason"],
    },
  },
  readOnly: true,
  verb: "Suggested a sandbox allowance",
  target: (a) =>
    [...(Array.isArray(a.hosts) ? a.hosts : []), ...(Array.isArray(a.folders) ? a.folders : [])]
      .map(String)
      .join(", "),
  async run(args, host) {
    const card = parseAllowanceArgs(args, host.services.workspace.root.peek());
    if ("error" in card) return { result: `Error: ${card.error}.`, isError: true };
    return {
      result: allowanceResult(card),
      summary: allowanceText(card),
      detail: JSON.stringify(card),
    };
  },
};

export const SANDBOX_TOOLS: AgentTool[] = [SUGGEST_SANDBOX_ALLOWANCE_TOOL];

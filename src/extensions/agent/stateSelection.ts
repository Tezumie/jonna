// get_state's guard on the editor's selected text (D199, D221): a selection in a file excluded
// from the agent isn't shown, and one in a file agent.autoApprove asks before reading is asked
// about first, as read_file would (the selection was a way around the question).
import { approveDecision, readApproveRules } from "../../core/agent/autoApprove";
import { pathReadings } from "../../core/agent/workspaceFolders";
import { agentFolders, ignoredInInput } from "./ignore";
import type { ToolHost } from "./tools";

/** The state value as the agent may see it: the selection taken out when it may not. */
export async function guardSelection(host: ToolHost, value: unknown): Promise<unknown> {
  if (!value || typeof value !== "object") return value;
  const v = value as { path?: unknown; absolutePath?: unknown; selectedText?: unknown };
  if (typeof v.selectedText !== "string") return value;
  const { workspace } = host.services;
  const root = workspace.root.peek();
  if (ignoredInInput(host.services, root, { path: v.path, file: v.absolutePath }))
    return { ...v, selectedText: "(excluded from the agent)" };
  // `path` is workspace-relative in ide://editors/active ("api/…" in another folder of a
  // multi-root workspace, D251), `absolutePath` absolute.
  const file =
    typeof v.absolutePath === "string"
      ? v.absolutePath
      : typeof v.path === "string" && root
        ? workspace.resolve(v.path)
        : "";
  const inside = !!root && !!file && workspace.contains(file);
  const shown = inside ? workspace.relative(file) : "";
  const rules = readApproveRules(host.services.settings.peek<unknown>("agent.autoApprove"));
  if (
    !shown ||
    !pathReadings(agentFolders(host.services), file).some(
      (p) => approveDecision(rules, "reads", p) === "ask",
    )
  )
    return value;
  const answer = await host.ask({
    title: `Read the selection in ${shown}`,
    heading: "Read a protected file",
    code: shown,
    kind: "tool",
    detail: "agent.autoApprove says to ask before reading this file.",
    evenWithFullAccess: true,
  });
  return answer === "deny"
    ? { ...v, selectedText: "(the user didn't allow reading this file)" }
    : value;
}

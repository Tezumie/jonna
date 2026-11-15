// agent.autoApprove as decisions (D204, D207): the rules as the setting holds them, the browser
// and web decision the permission handler uses, and saving "Always" as a pattern. No page here:
// the Auto-approve page, its commands and the tool gate are in autoApprove.ts.
import {
  type ApproveCategory,
  type ApproveRules,
  alwaysPattern,
  approveDecision,
  CATEGORY_INFO,
  readApproveRules,
  withAllowed,
} from "../../core/agent/autoApprove";
import { pathReadings, resolveInFolders } from "../../core/agent/workspaceFolders";
import type { DisposableStore } from "../../core/lifecycle/index";
import type { WorkbenchServices } from "../../workbench/services";
import { agentFolders } from "./ignore";
import type { McpClients } from "./mcp";
import { cleanPathArg } from "./pathArg";
import { addToolGate } from "./toolGate";

export function approveRules(services: WorkbenchServices): ApproveRules {
  return readApproveRules(services.settings.peek<unknown>("agent.autoApprove"));
}

/**
 * "Always" on a read, edit, browser or web question (D207): the exact file or the domain saved
 * to agent.autoApprove as Allow (as Always on a command adds to agent.allowedCommands), with a
 * note in the chat saying so. Returns the pattern, or null when there was nothing to save.
 */
export async function saveAlways(
  services: WorkbenchServices,
  category: ApproveCategory,
  subject: string,
  note?: (text: string) => void,
): Promise<string | null> {
  const pattern = alwaysPattern(category, subject);
  if (!pattern) return null;
  try {
    await services.settings.update(
      "agent.autoApprove",
      withAllowed(approveRules(services), category, pattern),
      "user",
    );
  } catch {
    return null;
  }
  note?.(
    `Saved to auto-approve: ${CATEGORY_INFO[category].title.toLowerCase()} ${pattern} is allowed from now on (Customize → Auto-approve to change it).`,
  );
  return pattern;
}

/** The page a browser.* command acts on (its `url`, else its tab's), or null. */
export async function browserUrl(
  services: WorkbenchServices,
  input: unknown,
): Promise<string | null> {
  const fields = (input ?? {}) as Record<string, unknown>;
  if (typeof fields.url === "string") return fields.url;
  const tabs = (await services.state
    .get("ide://browser")
    .then((snap) => snap.value)
    .catch(() => null)) as { tab?: string; url?: string }[] | null;
  // The tab the command acts on, as the browser picks it: `tab`, the active one, else the
  // most recent browser tab — not the first one, whose domain may have another answer.
  const { dock } = services;
  const active = dock.activeTab();
  const wanted =
    typeof fields.tab === "string"
      ? fields.tab
      : services.context.get("browserExternalCurrent") === true
        ? "external"
        : active?.viewType === "browser"
          ? active.id
          : (dock.recentTab((t) => t.viewType === "browser")?.id ?? null);
  return wanted ? ((tabs ?? []).find((t) => t.tab === wanted)?.url ?? null) : null;
}

/** The browser decision for an IDE command an agent called (browser.*). */
export async function browserDecision(
  services: WorkbenchServices,
  input: unknown,
): Promise<"allow" | "ask" | null> {
  const rules = approveRules(services);
  if (!rules.browser) return null;
  const url = await browserUrl(services, input);
  return url ? approveDecision(rules, "browser", url) : null;
}

export function webDecision(services: WorkbenchServices, input: unknown): "allow" | "ask" | null {
  const url = (input as { url?: unknown } | null)?.url;
  return typeof url === "string" ? approveDecision(approveRules(services), "web", url) : null;
}

/** The tools whose `path` is read or written, by category. */
const READ_TOOLS = new Set(["read_file", "list_dir"]);
const WRITE_TOOLS = new Set(["edit_file", "write_file"]);

/**
 * The decisions that aren't a page (D204): an MCP tool's, and the gate that asks before a
 * protected file is read or changed.
 */
export function registerApproveGate(
  sub: DisposableStore,
  services: WorkbenchServices,
  clients: McpClients,
): void {
  clients.autoApprove = (subject) => approveDecision(approveRules(services), "mcp", subject);
  sub.add({ dispose: () => (clients.autoApprove = () => null) });

  // Reads and edits of protected paths ask first.
  const gate = addToolGate(async ({ name, args, ask, note }) => {
    const category: ApproveCategory | null = READ_TOOLS.has(name)
      ? "reads"
      : WRITE_TOOLS.has(name)
        ? "edits"
        : null;
    if (!category || typeof args.path !== "string") return null;
    const folders = agentFolders(services);
    if (!folders.length) return null;
    // Each folder's files by their workspace path and (multi-root) their path in the folder.
    const readings = pathReadings(folders, resolveInFolders(folders, cleanPathArg(args.path)));
    const rules = approveRules(services);
    const rel = readings.find((p) => approveDecision(rules, category, p) === "ask");
    if (rel === undefined) return null;
    const verb = category === "reads" ? "Read" : "Change";
    // "Always" saves this one file as Allow (D207): the glob that asked stays for the others.
    const always = alwaysPattern(category, rel);
    const answer = await ask({
      title: `${verb} ${rel}`,
      heading: `${verb} a protected file`,
      code: rel,
      kind: "tool",
      detail: `agent.autoApprove says to ask before ${category === "reads" ? "reading" : "changing"} this file.`,
      ...(always && { always }),
      evenWithFullAccess: true,
    });
    if (answer === "always") await saveAlways(services, category, rel, note);
    return answer === "deny"
      ? {
          result: `The user denied ${category === "reads" ? "reading" : "changing"} ${rel}.`,
          denied: true,
          summary: "denied",
        }
      : null;
  });
  sub.add(gate);
}

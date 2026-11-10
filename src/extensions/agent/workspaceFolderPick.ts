// The one folder a command acts on in a multi-root workspace (D251): agent commands that write
// into a folder (add an MCP server, a skill, a command, a subagent) take an optional `folder` (a
// path or a folder's name). Without it: the only folder; with several, the active editor's folder,
// else the user picks one. Given, it is never asked (agents call with it).
import { samePath } from "../../core/paths/index";
import { stateField } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";

/** The workspace folder named by `wanted` (its path or name); throws for one that isn't. */
export function namedWorkspaceFolder(services: WorkbenchServices, wanted: string): string {
  const folders = services.workspace.folders.peek();
  const root = services.workspace.root.peek();
  const found =
    folders.find((f) => samePath(f.path, wanted)) ?? folders.find((f) => f.name === wanted);
  if (found) return found.path;
  if (!folders.length && root && samePath(root, wanted)) return root;
  throw new Error(`${wanted} isn't a folder of this workspace.`);
}

/** The active editor's file, if a file editor is active. */
function activeFile(services: WorkbenchServices): string | null {
  const tab = services.dock.activeTab();
  if (tab?.viewType !== "editor") return null;
  const p = stateField(tab.viewState, "path");
  return typeof p === "string" && !p.startsWith("virtual:") ? p : null;
}

/**
 * The folder to act on: `wanted` (path or name), else the only folder, else the active editor's
 * folder, else the one the user picks (null: cancelled, or nothing open).
 */
export async function pickWorkspaceFolder(
  services: WorkbenchServices,
  wanted: string | undefined,
  placeholder: string,
): Promise<string | null> {
  const { workspace, quickInput } = services;
  if (wanted) return namedWorkspaceFolder(services, wanted);
  const folders = workspace.folders.peek();
  if (folders.length <= 1) return workspace.root.peek();
  const file = activeFile(services);
  const owner = file ? workspace.folderOf(file) : undefined;
  if (owner) return owner.path;
  const picked = await quickInput.pick(
    folders.map((f) => ({ id: f.path, label: f.name, description: f.path })),
    { placeholder },
  );
  return picked?.id ?? null;
}

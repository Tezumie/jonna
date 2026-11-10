// The folder a command works in, in a multi-root workspace (D251): named by its `folder` input,
// else the active editor's, else asked with the quick pick. Used by tasks, debug and terminals.
import type { TabRef } from "../../core/dock/index";
import { stateField } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { folderByInput } from "./folders";

const pathOf = (tab: TabRef | undefined): string | undefined => {
  const path = tab ? stateField(tab.viewState, "path") : undefined;
  return typeof path === "string" && !path.startsWith("virtual:") ? path : undefined;
};

/** The active editor's file (absolute), when the active tab is one. */
export function activeFile(services: WorkbenchServices): string | undefined {
  return pathOf(services.dock.activeTab());
}

/**
 * The folder of the editor the user is working in (D251): the active tab's file, else the most
 * recent editor's (focus may be in a terminal or the sidebar). Undefined outside every folder.
 */
export function editorFolder(services: WorkbenchServices): string | undefined {
  const { dock, workspace } = services;
  const file = activeFile(services) ?? pathOf(dock.recentTab((t) => t.viewType === "editor"));
  return file ? workspace.folderOf(file)?.path : undefined;
}

/**
 * The folder a command works in (D251): the one `given` names (a name or path); with one folder,
 * it; with several, the editor's folder (unless `ask` is "always"), else asked with the quick
 * pick (null when that's cancelled). Agents pass `folder`, so they're never asked.
 */
export async function chooseFolder(
  services: WorkbenchServices,
  given: string | undefined,
  options: { placeholder: string; ask?: "always" | "needed" },
): Promise<string | null> {
  const { workspace } = services;
  const folders = workspace.folders.peek();
  const root = workspace.root.peek();
  if (!root) throw new Error("Open a folder first.");
  if (given?.trim()) return folders.length ? folderByInput(folders, given).path : root;
  if (folders.length <= 1) return root;
  if (options.ask !== "always") {
    const own = editorFolder(services);
    if (own) return own;
  }
  const picked = await services.quickInput.pick(
    folders.map((f) => ({
      id: f.path,
      label: f.name,
      description: f.path,
      icon: "folder" as const,
    })),
    { placeholder: options.placeholder, matchOn: (i) => `${i.label} ${i.description ?? ""}` },
  );
  return picked?.id ?? null;
}

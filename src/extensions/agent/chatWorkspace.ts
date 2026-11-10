// A chat's workspace (D251, core/agent/chatWorkspace.ts): what a new chat stores as
// `meta.workspace` (the first folder, a multi-root workspace's too) and whether a stored chat is
// this window's (its first folder, or its workspace file for chats stored that way before).
import { belongsToWorkspace, chatWorkspaceKey } from "../../core/agent/chatWorkspace";
import { samePath } from "../../core/paths/index";
import type { WorkbenchServices } from "../../workbench/services";

const placeOf = (services: WorkbenchServices) => ({
  root: services.workspace.root.peek(),
  file: services.workspace.file.peek(),
});

/** What a chat started now stores as its workspace (the first folder). */
export function chatWorkspaceOf(services: WorkbenchServices): string | null {
  return chatWorkspaceKey(placeOf(services));
}

/** Whether a chat stored with `stored` is this window's. */
export function isThisWorkspace(
  services: WorkbenchServices,
  stored: string | null | undefined,
): boolean {
  return belongsToWorkspace(stored, placeOf(services), samePath);
}

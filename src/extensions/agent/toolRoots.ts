// Per-chat tool folders (headless helpers, D246): a chat whose tools work in another folder than the
// window's open one — a helper's git worktree, run in this window's process instead of a window
// of its own. tools.ts, processTools.ts and the background commands ask `toolRootFor` (by the
// chat's id, so subagents and explore inside that chat follow it); isolatedHelpers.ts sets and
// clears it. Rust lets the folder in as an extra root while it's set (`fsIpc.allowRoot`).

import type { WorkbenchServices } from "../../workbench/services";

interface HelperRoot {
  folder: string;
  /** PORT / WORKTREE_* for its commands, as its window would have had (D207). */
  env: Record<string, string>;
}

const roots = new Map<string, HelperRoot>();

/** Chat `session`'s tools work in `folder` from now on (null: the window's folder again). */
export function setToolRoot(
  session: string,
  folder: string | null,
  env: Record<string, string> = {},
): void {
  if (folder) roots.set(session, { folder, env });
  else roots.delete(session);
}

/** The worktree a headless helper's chat works in, when it is one. */
export function helperRootOf(session: string): string | undefined {
  return roots.get(session)?.folder;
}

/** The environment a headless helper's commands get (empty for any other chat). */
export function helperEnvOf(session: string): Record<string, string> {
  return roots.get(session)?.env ?? {};
}

/** The folder chat `session`'s tools work in: its worktree, else the window's open folder. */
export function toolRootFor(services: WorkbenchServices, session: string): string | null {
  return roots.get(session)?.folder ?? services.workspace.root.peek();
}

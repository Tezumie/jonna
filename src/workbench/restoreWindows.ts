// Which windows a start reopens (D209, VS Code's window.restoreWindows): "all" — every window the
// last session had open (this one takes the last folder, the others start as new windows), "one"
// — the last folder only (before D209, always), "none" — an empty window. A folder from the
// command line or "New window" opens just that. Empty windows that kept unsaved untitled text
// come back too (VS Code restores them with their untitled editors): with no folder window to
// reopen, this window becomes the most recent of them. DOM-free and tested.
import { samePath } from "../core/paths/index";

export type RestoreWindows = "all" | "one" | "none";

/** The setting's value (VS Code's "preserve" and "folders" act like "all" here). */
export function parseRestoreWindows(value: unknown): RestoreWindows {
  if (value === "one" || value === "none") return value;
  return "all";
}

export interface StartupFolders {
  /** The folder this window opens (none: empty). */
  open?: string;
  /** Folders to start a window each for. */
  spawn: string[];
  /** The last session's empty window this one becomes (its backup id), with its unsaved text. */
  takeEmpty?: string;
  /** The last session's empty windows to start a window each for (backup ids). */
  spawnEmpty: string[];
}

export function startupFolders(opts: {
  setting: RestoreWindows;
  launchFolder: string | null;
  newWindow: boolean;
  lastFolder: string | undefined;
  /** The last session's windows' folders, most recently used first (empty unless first window). */
  previous: readonly string[];
  /** The last session's empty windows with unsaved text, most recent first (backup ids). */
  previousEmpty?: readonly string[];
}): StartupFolders {
  const empties = opts.previousEmpty ?? [];
  if (opts.launchFolder) return { open: opts.launchFolder, spawn: [], spawnEmpty: [] };
  if (opts.newWindow || opts.setting === "none") return { spawn: [], spawnEmpty: [] };
  // Nothing recorded but empty windows with unsaved text: this window is the most recent one.
  if (!opts.previous.length && empties.length && opts.setting === "all") {
    const [first, ...rest] = empties;
    return { spawn: [], ...(first && { takeEmpty: first }), spawnEmpty: rest };
  }
  if (opts.setting === "one" || !opts.previous.length) {
    if (opts.lastFolder) return { open: opts.lastFolder, spawn: [], spawnEmpty: [] };
    // "one" with no folder: the most recent empty window's text, if there is one.
    const first = empties[0];
    return { spawn: [], ...(first && { takeEmpty: first }), spawnEmpty: [] };
  }
  const last = opts.lastFolder;
  const open = last && opts.previous.some((p) => samePath(p, last)) ? last : opts.previous[0];
  const spawn = opts.previous.filter((p) => !open || !samePath(p, open));
  return { ...(open && { open }), spawn, spawnEmpty: [...empties] };
}

/**
 * Resolves once main.ts has reopened the folder (or found none): files from the command line and
 * an empty window's unsaved text wait for it, so the restored layout doesn't replace their tabs.
 */
let markRestored: () => void = () => {};
const restored = new Promise<void>((resolve) => (markRestored = resolve));
export function whenStartupRestored(): Promise<void> {
  return restored;
}
export function startupRestored(): void {
  markRestored();
}

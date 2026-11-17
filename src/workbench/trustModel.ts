// Which trust decision applies to a folder (D103, VS Code's model): its own, else the nearest
// parent folder the user trusted ("Trust the authors of all files in the parent folder"), so a
// trusted parent covers every folder under it. Only trust is inherited: a parent left restricted
// says nothing about its subfolders, and a folder's own decision wins over its parent's.
// DOM-free and tested.
import { dirname, pathKey } from "../core/paths/index";

export type TrustState = "trusted" | "restricted" | "unknown";

export interface TrustDecision {
  state: TrustState;
  /** The trusted parent folder (its key) the state comes from, when it isn't the folder's own. */
  inheritedFrom?: string;
}

export function trustOf(
  decisions: Readonly<Record<string, boolean>> | undefined,
  root: string,
  /** False for a risky folder (Downloads, D213): only its own decision counts. */
  inherit = true,
): TrustDecision {
  if (!decisions) return { state: "unknown" };
  const own = decisions[pathKey(root)];
  if (own !== undefined) return { state: own ? "trusted" : "restricted" };
  if (!inherit) return { state: "unknown" };
  let folder = root;
  for (let parent = dirname(folder); parent !== folder; parent = dirname(folder)) {
    folder = parent;
    if (decisions[pathKey(folder)] === true)
      return { state: "trusted", inheritedFrom: pathKey(folder) };
  }
  return { state: "unknown" };
}

/**
 * Why git is off in an open folder with this trust, or null when it may run. Git runs what a
 * repository's own settings name (core.fsmonitor on every status, hooks, filters, sshCommand),
 * so it runs only once the folder's authors are trusted: not in restricted mode (VS Code's
 * way), and not while the question is still open either — files that arrived in the folder
 * (an archive, a synced snapshot, a teammate's copy) would otherwise run before the answer.
 */
export function gitOffReason(state: TrustState): string | null {
  if (state === "trusted") return null;
  return state === "restricted"
    ? "Git is off in restricted mode: it would run this repository's own settings. Trust the folder (Manage workspace trust) to use it."
    : "Git is off until this folder is trusted: it would run this repository's own settings. Trust the folder (Manage workspace trust) to use it.";
}

/** The decisions after the user answered for `root` (and maybe trusted its parent too). */
export function withDecision(
  decisions: Readonly<Record<string, boolean>> | undefined,
  root: string,
  trusted: boolean,
  parent = false,
): Record<string, boolean> {
  const next = { ...decisions, [pathKey(root)]: trusted };
  const up = dirname(root);
  if (trusted && parent && up !== root) next[pathKey(up)] = true;
  return next;
}

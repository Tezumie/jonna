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

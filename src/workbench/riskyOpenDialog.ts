// The caution shown before a risky folder (riskyFolders.ts, D213) opens as the workspace. A dialog:
// only for a screen.
import { basename } from "../core/paths/index";
import { type RiskyMatch, riskyLabel, riskyReason } from "../core/security/riskyFolders";
import { showDialog } from "../ui/Dialog";

export type RiskyOpenChoice = "restricted" | "trusted" | "cancel";

/**
 * The caution before a risky folder opens: what's risky about it, in plain words, and three
 * choices — open in restricted mode (the default), open and trust, cancel — with "Don't ask
 * again for this folder".
 */
export async function askRiskyOpen(
  path: string,
  match: RiskyMatch,
  /** `path` is inside the risky folder rather than the folder itself. */
  nested: boolean,
): Promise<{ choice: RiskyOpenChoice; dontAsk: boolean }> {
  let dontAsk = false;
  const label = riskyLabel(match.kind);
  const name = basename(path) || path;
  const title = nested ? `“${name}” is in ${label}` : `Open ${label}?`;
  const choice = await showDialog<RiskyOpenChoice>({
    title,
    message: `${riskyReason(match.kind)}\n\nIn restricted mode, agents don't load this folder's instruction files (AGENTS.md, CLAUDE.md, rules, skills), its tasks, debugging, tests and git don't run, and an agent asks before it works here. You can still browse and edit every file, and trust the folder later with "Manage workspace trust".`,
    actions: [
      { label: "Cancel", value: "cancel", variant: "secondary" },
      { label: "Open and trust", value: "trusted", variant: "secondary" },
      { label: "Open in restricted mode", value: "restricted", variant: "primary" },
    ],
    cancelValue: "cancel",
    defaultValue: "restricted",
    size: "md",
    checkbox: {
      label: "Don't ask again for this folder",
      detail: path,
      onCheck: (checked) => (dontAsk = checked),
    },
  });
  return { choice, dontAsk };
}

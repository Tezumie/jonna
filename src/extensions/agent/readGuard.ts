// Read before edit (D309, Claude Code's "You must Read the file in this conversation before
// editing"): edit_file, and write_file over a file that exists, need the agent to have read the
// file in this chat (or written it itself), and refuse when it changed since. The error says
// exactly which call to make next, for small models and the text protocol alike.
import type { ToolOutcome } from "../../core/agent/loop";
import type { Changeset } from "./changeset";

export function readGuard(
  changeset: Pick<Changeset, "hasSeen" | "changedSinceSeen">,
  path: string,
  name: string,
  current: string,
  tool: "edit_file" | "write_file",
): ToolOutcome | null {
  if (!changeset.hasSeen(path))
    return {
      result: `Error: you haven't read ${name} in this chat, so ${tool} was refused and nothing was changed. Call read_file with {"path": "${name}"} first, then call ${tool} again${tool === "write_file" ? " (or use edit_file for a change to part of it)" : ""}.`,
      isError: true,
      summary: "not read yet",
    };
  if (changeset.changedSinceSeen(path, current))
    return {
      result: `Error: ${name} changed since you last read it (the user, a formatter or a command changed it), so ${tool} was refused and nothing was changed. Call read_file with {"path": "${name}"} again, then make your change to what it holds now.`,
      isError: true,
      summary: "changed since read",
    };
  return null;
}

// Restore checkpoint on a message (D200, Cursor's and Claude Code's rewind): the chat goes back to
// before one of your messages and the files the agent changed since go back too (from the
// checkpoints, D71). Editing or retrying a message whose turn changed files asks first whether to
// undo those changes.
import type { DisposableStore } from "../../core/lifecycle/index";
import { basename } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import { showDialog } from "../../ui/Dialog";
import type { WorkbenchServices } from "../../workbench/services";
import type { AgentSession } from "./session";
import type { SessionManager } from "./sessions";

const names = (paths: readonly string[]) => {
  const shown = paths.slice(0, 4).map((p) => basename(p));
  return `${shown.join(", ")}${paths.length > shown.length ? ` and ${paths.length - shown.length} more` : ""}`;
};

/**
 * Before an edit or a retry resends a message (D200): when the agent changed files since it,
 * asks whether to put them back first. "keep" when nothing changed.
 */
export async function askUndoFiles(
  session: AgentSession,
  turn: number | undefined,
  action: "Send" | "Retry",
): Promise<"undo" | "keep" | "cancel"> {
  if (turn === undefined) return "keep";
  const changed = await session.changedSince(turn);
  if (!changed.length) return "keep";
  return showDialog<"undo" | "keep" | "cancel">({
    title: "Undo the agent's file changes?",
    message: `Since this message the agent changed ${changed.length === 1 ? "1 file" : `${changed.length} files`} (${names(changed)}). Put them back as they were before ${action === "Send" ? "sending the edited message" : "retrying"}?`,
    actions: [
      { label: "Cancel", value: "cancel" },
      { label: "Keep changes", value: "keep" },
      { label: `Undo and ${action.toLowerCase()}`, value: "undo", variant: "primary" },
    ],
    cancelValue: "cancel",
  });
}

export function registerCheckpointCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
): void {
  sub.add(
    services.dispatcher.register({
      id: "agent.restoreToMessage",
      title: "Restore checkpoint",
      category: "Agent",
      description:
        "Restores a chat to before one of your messages (its Restore button): the messages from it on are removed, the message's text goes back in the box, and with `files` (default true) the files the agent changed since are put back as they were (from the checkpoints). Later changes to those files are lost.",
      input: s.object({
        session: s.string().describe("Session id (default: the active session)").optional(),
        item: s
          .string()
          .describe("The user message's item id (ide://agent/session items; default: your latest)")
          .optional(),
        files: s.boolean().describe("Also put the files back (default true)").optional(),
      }),
      effects: ["write", "destructive"],
      agent: "hidden",
      palette: false,
      confirm: ({ files }) =>
        files === false
          ? "Restore the chat to before this message? The messages after it are removed."
          : "Restore the chat and the files to before this message? The messages after it are removed, and the agent's changes to files since then are undone.",
      run: async ({ session, item, files }) => {
        const target = sessions.require(session);
        const id = item ?? target.lastUserMessage()?.id;
        if (!id) throw new Error("This chat has no message of yours to go back to.");
        const { text, restored, failed } = await target.rewind(id, {
          ...(files !== undefined && { files }),
        });
        // The message comes back to the box, to change and send again (Cursor's way).
        if (!target.draft.peek()) target.draft.value = text;
        return { session: target.id, restored, failed, draft: text };
      },
    }),
  );
}

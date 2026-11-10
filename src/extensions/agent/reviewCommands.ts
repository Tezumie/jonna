// Review commands of the agent's changes (split from commands.ts in D221): accept / reject all
// or one change, open a change for review or as applied, restore a checkpoint.

import { historyIpc } from "../../core/ipc/fs";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import type { SessionManager } from "./sessions";

export function registerReviewCommands(
  register: WorkbenchServices["dispatcher"]["register"],
  services: WorkbenchServices,
  sessions: SessionManager,
): void {
  const { dock, workspace } = services;
  const sessionInput = s.string().describe("Session id (default: the active session)").optional();
  register({
    id: "agent.acceptAll",
    title: "Accept all agent changes",
    description:
      "Accepts every change of the session under review (or only `paths`): the agent's edits are on disk already (D199), so this keeps them and ends the review (one workspace undo entry); a staged proposal is written now (checkpointed first).",
    input: s.object({ session: sessionInput, paths: s.array(s.string()).optional() }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ session, paths }) => {
      const target = sessions.require(session);
      const accepted = await target.changeset.accept(paths);
      // Written now: a local page in the browser shows them (D160).
      if (accepted.length) void target.reloadLocalPages();
      return { accepted };
    },
  });
  register({
    id: "agent.rejectAll",
    title: "Reject all agent changes",
    description:
      "Rejects every change of the session under review (or only `paths`): each file gets back what it held before the agent's edits, on top of anything typed since (D199). A file changed since in the same lines is left and reported.",
    input: s.object({ session: sessionInput, paths: s.array(s.string()).optional() }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ session, paths }) => ({
      rejected: await sessions.require(session).changeset.reject(paths),
    }),
  });
  register({
    id: "agent.reviewChange",
    title: "Accept or reject an agent change",
    description:
      "Accepts or rejects the agent's change to `path` under review — the whole file, or only the change at `line` (a line of the file as it is now). Rejecting puts back what was there before (D199).",
    input: s.object({
      session: sessionInput,
      path: s.string(),
      action: s.enum(["accept", "reject"] as const),
      line: s.integer({ min: 1 }).optional(),
    }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ session, path, action, line }) => {
      const cs = sessions.require(session).changeset;
      const abs = workspace.resolve(path);
      if (line) await cs.hunk(abs, line, action);
      else if (action === "accept") await cs.accept([abs]);
      else await cs.reject([abs]);
      if (action === "accept") void sessions.require(session).reloadLocalPages();
      // A fully reviewed file closes its proposal tab.
      if (!cs.get(abs))
        for (const t of dock.tabs("diff")) {
          const st = t.viewState as { path?: string; agent?: string; base?: string } | null;
          const review = st?.agent || st?.base?.startsWith("agentBase:");
          if (review && st?.path === abs) void dock.closeTab(t.id, true);
        }
      return { pending: cs.files.peek().map((f) => f.path) };
    },
  });
  register({
    id: "agent.openAppliedDiff",
    title: "Show an applied agent change",
    description:
      "Shows what the agent changed in a file it already wrote (auto-apply, or accepted): the version before its change ↔ the file now (the local-history snapshot with that content). A file the agent created opens as it is.",
    input: s.object({ session: sessionInput, path: s.string() }),
    effects: ["read"],
    agent: "hidden",
    run: async ({ session, path }, ctx) => {
      const abs = workspace.resolve(path);
      // The snapshot holding what the file had before the change (D119): local history keeps
      // the content before every write; find it by content hash.
      const sess = sessions.require(session);
      const text = sess.changeset.appliedBefore(abs);
      // Known this session (an empty file is ""): diff against it directly (D120).
      if (text !== undefined && text !== null) {
        await ctx.execute("editor.openDiff", {
          path: abs,
          base: `agentBefore:${sess.id}`,
          baseLabel: "agent's change",
        });
        return { diff: true };
      }
      // After a reload: the local-history snapshot of what was on disk before the write.
      const entries = text === undefined ? await historyIpc.list(abs).catch(() => []) : [];
      const at = entries.findIndex((e) => e.source === "agent" || e.source === "save");
      const before = at >= 0 ? entries[at + 1] : undefined;
      if (!before) {
        await ctx.execute("editor.openFile", { path: abs });
        return { diff: false };
      }
      await ctx.execute("editor.openDiff", {
        path: abs,
        version: before.id,
        versionLabel: "before the agent's change",
      });
      return { diff: true };
    },
  });
  register({
    id: "agent.review",
    title: "Review agent changes",
    description: "Opens the first pending change of the session in a diff tab.",
    input: s.object({ session: sessionInput }),
    effects: [],
    agent: "hidden",
    run: async ({ session }, ctx) => {
      const sess = sessions.require(session);
      const first = sess.changeset.files.peek()[0];
      if (!first) throw new Error("No pending changes.");
      for (const f of sess.changeset.files.peek())
        await ctx.execute("agent.openReviewDiff", {
          path: f.path,
          session: sess.id,
          preserveFocus: f !== first,
        });
    },
  });
  register({
    id: "agent.openReviewDiff",
    title: "Open an agent change for review",
    description:
      "Opens a file the agent changed (under review) in a diff tab: what it held before the agent's edits ↔ the file now (editable; D199). A staged proposal shows the file ↔ the proposal.",
    input: s.object({
      session: sessionInput,
      path: s.string(),
      preserveFocus: s.boolean().optional(),
    }),
    effects: [],
    agent: "hidden",
    run: async ({ session, path, preserveFocus }, ctx) => {
      const sess = sessions.require(session);
      const abs = workspace.resolve(path);
      const f = sess.changeset.get(abs);
      if (!f) throw new Error("No change of the agent's is under review in this file.");
      await ctx.execute(
        "editor.openDiff",
        f.onDisk
          ? {
              path: abs,
              base: `agentBase:${sess.id}`,
              baseLabel: "before the agent's edits",
              ...(preserveFocus && { preserveFocus }),
            }
          : { path: abs, agent: sess.id, ...(preserveFocus && { preserveFocus }) },
      );
      return { path: abs, onDisk: f.onDisk === true };
    },
  });

  register({
    id: "agent.restoreCheckpoint",
    title: "Restore agent checkpoint…",
    description:
      "Puts files back as they were before a turn's changes were applied (that turn and later ones).",
    input: s.object({ session: sessionInput, turn: s.integer({ min: 1 }).optional() }),
    effects: ["write", "destructive"],
    agent: "hidden",
    confirm: ({ turn }) =>
      `Restore files to before ${turn ? `turn ${turn}` : "the chosen turn"}? Later changes to those files are lost.`,
    run: async ({ session, turn }) => {
      const sess = sessions.require(session);
      // Not while it works: its next write would race the restore (D159).
      if (sess.busyNow()) throw new Error("The agent is working; stop it first.");
      const t = turn ?? Math.min(...sess.checkpoints);
      if (!Number.isFinite(t)) throw new Error("This session has no checkpoints.");
      return { restored: await sess.restore(t) };
    },
  });
}

// Files changed since the agent read them (D308, Claude Code's "changed on disk since you last
// read it"): after each tool call and with the user's next message, the files the chat read or
// wrote are looked at again; one someone else changed since (the user, a formatter, a git
// checkout, a command) comes back as a note with a short diff. The agent's own writes update what
// it saw (Changeset.noteSeen), so they're never news, and a file with a staged proposal is the
// agent's own text. core/agent/readTracker.ts holds the texts and builds the notes.
import { changeNotesText } from "../../core/agent/readTracker";
import { relativeInFolders } from "../../core/agent/workspaceFolders";
import { fsIpc } from "../../core/ipc/fs";
import { relativePath } from "../../core/paths/index";
import type { WorkbenchServices } from "../../workbench/services";
import { type Changeset, readDiskForAgent } from "./changeset";
import { agentFolders } from "./ignore";
import { helperRootOf } from "./toolRoots";

/** The most recently read files looked at each time (each costs a stat, rarely a read). */
const CHECKED_FILES = 50;

/** One check at a time per chat: calls of a step finish together, each change is told once. */
const running = new WeakMap<Changeset, Promise<string | null>>();

/**
 * The note for the files of `changeset`'s chat that changed since the agent last saw them, or
 * null. A change shown whole counts as read (the agent may edit the file); one too large to show
 * doesn't (edit_file asks for a read first).
 */
export function fileChangeNotes(
  services: WorkbenchServices,
  changeset: Changeset,
  session: string,
): Promise<string | null> {
  const before = running.get(changeset) ?? Promise.resolve(null);
  const next = before.then(
    () => check(services, changeset, session),
    () => check(services, changeset, session),
  );
  const settled = next.catch(() => null);
  running.set(changeset, settled);
  return settled;
}

async function check(
  services: WorkbenchServices,
  changeset: Changeset,
  session: string,
): Promise<string | null> {
  const name = (abs: string) => {
    const worktree = helperRootOf(session);
    if (worktree) return relativePath(worktree, abs);
    return relativeInFolders(agentFolders(services), abs) || abs;
  };
  const found: { key: string; path: string; note: string; shown: boolean; text: string | null }[] =
    [];
  await Promise.all(
    changeset.reads.recent(CHECKED_FILES).map(async ({ key, path, stamp }) => {
      // A staged proposal is the agent's own text: nothing to tell.
      if (changeset.staged(path) !== undefined) return;
      // An open editor's text is what read_file reads (unsaved changes too).
      let now = services.quickDiff.bufferText(path);
      let nextStamp: string | null = null;
      if (now === null) {
        const stat = await fsIpc.stat(path).catch(() => null);
        if (stat && stat.kind !== "file") return;
        if (stat) {
          nextStamp = `${stat.size}:${stat.mtimeMs}`;
          // Same size and time as when it last matched: unchanged, no read.
          if (stamp === nextStamp) return;
          const disk = await readDiskForAgent(path).catch(() => null);
          // Binary now, too large or unreadable: not a text change to show.
          if (!disk || (disk.kind !== "text" && disk.kind !== "missing")) return;
          now = disk.kind === "text" ? disk.text : null;
        }
      }
      const change = changeset.reads.observe(key, now, name(path));
      if (!change) {
        changeset.reads.setStamp(key, nextStamp);
        return;
      }
      changeset.reads.setStamp(key, nextStamp);
      found.push({ key, path, note: change.note, shown: change.shown, text: now });
    }),
  );
  if (!found.length) return null;
  const text = changeNotesText(found.map((f) => f.note));
  if (!text) return null;
  // What the agent was shown whole, it now knows: an edit needs no new read (as Claude Code).
  for (const f of found.slice(0, text.included))
    if (f.shown && f.text !== null) changeset.noteSeen(f.path, f.text);
  return text.text;
}

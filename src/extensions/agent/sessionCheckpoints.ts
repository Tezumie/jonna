// A chat hearing of its file snapshots as they are taken (the changeset tells, changeset.ts):
// which turns have a checkpoint, and a word when one couldn't be kept.

import type { Item } from "../../core/agent/conversation";
import { newId } from "./ids";

/** What of a chat this touches. */
export interface SnapshotTarget {
  checkpoints: number[];
  items: Item[];
  bump(): void;
  save(): Promise<void>;
}

/** The turn each chat was last told about a snapshot that couldn't be kept (one notice a turn). */
const failedTurn = new WeakMap<SnapshotTarget, number>();

/**
 * A file's snapshot for turn `turn` was written, or (`error`) couldn't be. Written: the turn is
 * one of the chat's checkpoints from now, not from the turn's end, and the chat is saved, so a
 * turn cut short by a crash or the window closing can still be restored (Restore read only the
 * turns listed, and said it worked with nothing put back). Not written: the chat says so once a
 * turn, since those edits can't be put back from here.
 */
export function noteSnapshot(session: SnapshotTarget, turn: number, error: string | null): void {
  if (error === null) {
    if (session.checkpoints.includes(turn)) return;
    session.checkpoints.push(turn);
    void session.save().catch(() => {});
    return;
  }
  if (failedTurn.get(session) === turn) return;
  failedTurn.set(session, turn);
  session.items.push({
    type: "notice",
    id: newId("n"),
    text: "A checkpoint couldn't be saved for this turn. The agent's edits were made all the same, but Restore checkpoint and /undo may not put these files back.",
    detail: error,
    tone: "error",
  });
  session.bump();
}

// Going back in an agent session (split from session.ts in D245): Retry, editing a message you
// sent and sending it again, Restore checkpoint (D200), and putting the files the agent changed
// back from the checkpoints. The session's `retry`, `resend`, `changedSince`, `rewind` and
// `restore` call these.

import type { Item } from "../../core/agent/conversation";
import { planFromItems } from "../../core/agent/plan";
import { agentStoreIpc } from "../../core/ipc/agent";
import { fsIpc } from "../../core/ipc/fs";
import { newId } from "./ids";
import { imagesToResend } from "./previews";
import type { AgentSession } from "./session";
import { sendNow } from "./sessionTurn";

/** Regenerates the last answer: drops everything after the last message and sends it again. */
export async function retryNow(
  session: AgentSession,
  opts: { undoFiles?: boolean } = {},
): Promise<void> {
  await session.hydrating; // the last message may still be loading
  await session.settle();
  if (session.busyNow()) throw new Error("The agent is still working; stop it first.");
  // The last message the user wrote (not the harness's feedback, D127).
  const at = session.items.findLastIndex((i) => i.type === "user" && !i.auto);
  const item = session.items[at];
  if (item?.type !== "user") throw new Error("Nothing to retry.");
  // A one-off task (tidying up memory) isn't a chat message to send again (D160).
  if (item.sideTask) throw new Error("That was a one-off task: run it again from its menu.");
  await replaceFrom(session, at, item.text, item.context ?? [], item, opts.undoFiles);
}

/**
 * Edits a message you sent and sends it again: the conversation after it is dropped; with
 * `undoFiles` the files the agent changed since go back first (D200), else they stay as they are.
 */
export async function resendNow(
  session: AgentSession,
  itemId: string,
  text: string,
  opts: { undoFiles?: boolean } = {},
): Promise<void> {
  await session.hydrating;
  await session.settle();
  if (session.busyNow()) throw new Error("The agent is still working; stop it first.");
  const at = session.items.findIndex((i) => i.id === itemId);
  const item = session.items[at];
  if (item?.type !== "user" || item.auto || item.sideTask)
    throw new Error("That message isn't one you sent.");
  await replaceFrom(session, at, text, item.context ?? [], item, opts.undoFiles);
}

/** Drops the conversation from `at` and sends `text`; puts it back if the send couldn't start. */
async function replaceFrom(
  session: AgentSession,
  at: number,
  text: string,
  context: string[],
  // Its pasted images and attachment cards go again too.
  from?: Extract<Item, { type: "user" }>,
  // Put the files back as they were before that message first (D200).
  undoFiles = false,
): Promise<void> {
  // After a restart only the saved previews are left: they're sent again as PNGs (D159).
  const images = from ? await imagesToResend(from) : [];
  // The conversation is cut only once the session is claimed: a message sent meanwhile can't
  // be cut out with it (D160).
  await session.exclusive(async () => {
    if (from && session.items[at] !== from)
      throw new Error("The conversation changed meanwhile; try again.");
    // A file that couldn't be put back keeps its checkpoints (try again later), and so do all
    // until the new message is on its way.
    let restoreOk = false;
    if (undoFiles && from?.turn !== undefined)
      restoreOk = (await restoreFiles(session, from.turn)).failed.length === 0;
    const removed = cutFrom(session, at);
    try {
      await sendNow(session, text, context, {
        ...(images.length && { images }),
        ...(from?.attachments?.length && { attachments: from.attachments }),
      });
      if (restoreOk && from?.turn !== undefined)
        session.checkpoints = session.checkpoints.filter((t) => t < (from.turn ?? 0));
    } catch (err) {
      if (session.items.length === at) {
        session.items.push(...removed);
        session.bump();
      }
      throw err;
    }
  });
}

/**
 * Drops the conversation from `at` (an edit, a retry, a restore): the plan and the rules
 * attached go back to what the remaining conversation had.
 */
function cutFrom(session: AgentSession, at: number): Item[] {
  const removed = session.items.splice(at);
  // Background subagents work for the conversation being cut: their reports would come back
  // into the new one as a turn about a task that's gone (a retry, an edit, a restore).
  session.stopBackground();
  session.reports = [];
  // The plan as the remaining conversation left it: a dropped turn's plan would sit over the
  // new task, and the plan reminder would point at a step the model never wrote (D161).
  if (removed.some((it) => it.type === "tool" && it.name === "update_plan")) {
    const kept = planFromItems(session.items);
    session.plan.value = kept.every((s) => s.status === "done") ? [] : kept;
  }
  const firstTurn = removed.find((it) => it.type === "user" && it.turn !== undefined);
  const cutTurn = firstTurn?.type === "user" ? firstTurn.turn : undefined;
  if (cutTurn !== undefined)
    for (const [path, turn] of session.attachedRules)
      if (turn >= cutTurn) session.attachedRules.delete(path);
  if (cutTurn !== undefined)
    for (const [name, turn] of session.toldSkills)
      if (turn >= cutTurn) session.toldSkills.delete(name);
  session.externalStale = true;
  session.bump();
  return removed;
}

/**
 * Files the agent changed in turn `turn` and later ones (what restoring to before it would
 * put back), from the checkpoints.
 */
export async function changedSinceNow(session: AgentSession, turn: number): Promise<string[]> {
  await session.hydrating;
  const paths = new Set<string>();
  for (const t of session.checkpoints.filter((c) => c >= turn))
    for (const f of await agentStoreIpc.checkpointLoad(session.id, t).catch(() => []))
      paths.add(f.path);
  return [...paths];
}

/**
 * Restore checkpoint (D200, Cursor's): the chat goes back to before message `itemId` and, with
 * `files` (the default), so do the files the agent changed since. Returns the message's text
 * (it goes back in the box to edit and send again) and the files put back.
 */
export async function rewindNow(
  session: AgentSession,
  itemId: string,
  opts: { files?: boolean } = {},
): Promise<{ text: string; restored: string[]; failed: string[] }> {
  await session.hydrating;
  await session.settle();
  if (session.busyNow()) throw new Error("The agent is still working; stop it first.");
  return session.exclusive(async () => {
    const at = session.items.findIndex((i) => i.id === itemId);
    const item = session.items[at];
    if (item?.type !== "user" || item.auto || item.sideTask)
      throw new Error("That message isn't one you sent.");
    const turn = item.turn;
    const done =
      opts.files !== false && turn !== undefined
        ? await restoreFiles(session, turn)
        : { restored: [], failed: [] };
    cutFrom(session, at);
    // Later turns' checkpoints go with their messages (the turn count goes on, so a new turn
    // never adds to an old turn's snapshot); kept when a file couldn't be put back (locked on
    // Windows), so Restore checkpoint can try again.
    if (turn !== undefined && !done.failed.length)
      session.checkpoints = session.checkpoints.filter((t) => t < turn);
    const n = done.restored.length;
    session.items.push({
      type: "notice",
      id: newId("n"),
      text: `Restored the chat to before your message${n ? ` and ${n} file${n === 1 ? "" : "s"}` : ""}.${done.failed.length ? ` ${done.failed.length} couldn't be restored.` : ""}`,
      ...(done.failed.length && { detail: done.failed.join("\n") }),
      tone: done.failed.length ? "error" : "info",
    });
    session.updated = Date.now();
    session.bump();
    await session.save();
    return { text: item.text, ...done };
  });
}

/** Puts files back as they were before turn `turn`'s changes were applied (and later ones). */
export async function restoreNow(session: AgentSession, turn: number): Promise<string[]> {
  const { restored, failed } = await restoreFiles(session, turn);
  session.items.push({
    type: "notice",
    id: newId("n"),
    text: `Restored ${restored.length} file${restored.length === 1 ? "" : "s"} to before turn ${turn}.${failed.length ? ` ${failed.length} couldn't be restored.` : ""}`,
    ...(failed.length && { detail: failed.join("\n") }),
    tone: failed.length ? "error" : "info",
  });
  session.bump();
  return restored;
}

/**
 * The files back as they were before turn `turn` (and later ones); the review list follows
 * (D200: a change put back is no longer under review).
 */
async function restoreFiles(
  session: AgentSession,
  turn: number,
): Promise<{ restored: string[]; failed: string[] }> {
  await session.hydrating; // the checkpoints come with the transcript
  const restored: string[] = [];
  const failed: string[] = [];
  const contents = new Map<string, string | null>();
  const turns = [...session.checkpoints].filter((t) => t >= turn).sort((a, b) => b - a);
  const seen = new Set<string>();
  for (const t of turns.reverse()) {
    for (const f of await agentStoreIpc.checkpointLoad(session.id, t)) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      // A file the agent created goes to the IDE's trash (recoverable), not away for good; one
      // that fails doesn't stop the rest, and the notice names it (D161).
      try {
        if (f.content === null) {
          await fsIpc.trash(f.path);
          session.services.events.emit("files.didDelete", { path: f.path });
        } else if (!(await session.services.quickDiff.writeBuffer(f.path, f.content))) {
          const old = await fsIpc.read(f.path).catch(() => null);
          const bom = old ? new TextDecoder().decode(old.subarray(0, 3)) === "\uFEFF" : false;
          await fsIpc.write(
            f.path,
            new TextEncoder().encode(bom ? `\uFEFF${f.content}` : f.content),
            "agent revert",
          );
          session.services.events.emit("files.didChange", { path: f.path });
        }
        restored.push(f.path);
        contents.set(f.path, f.content);
      } catch (err) {
        failed.push(`${f.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  session.changeset.afterRestore(turn, contents);
  return { restored, failed };
}

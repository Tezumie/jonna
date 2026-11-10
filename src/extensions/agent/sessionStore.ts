// An agent session's saved form (split from session.ts in D221): what's written to the
// transcript store and how a saved transcript is read back (malformed items dropped, a turn the
// IDE closed in the middle of marked as interrupted).

import type { PlanStep } from "../../core/agent/compact";
import type { Item } from "../../core/agent/conversation";
import { MAX_MEMBERS } from "../../core/agent/groupChat";
import { mostUsedModel, type ThreadParent } from "../../core/agent/rooms";
import { latestWrapUp, statusLine } from "../../core/agent/turnTools";
import { agentStoreIpc } from "../../core/ipc/agent";
import { ACP_PRESETS } from "./acpAgents";
import { restoreChatWorktree, worktreeMeta } from "./chatWorktrees";
import { newId } from "./ids";
import { addPreviews, itemsForSaving, keepChatImages } from "./previews";
import type { AgentSession } from "./session";
import type { ChatMode } from "./sessionTypes";

/** A saved thread's parent, if well formed. */
export function threadParent(raw: unknown): ThreadParent | null {
  const p = raw as Partial<ThreadParent> | null;
  return p && typeof p.session === "string" && typeof p.item === "string"
    ? {
        session: p.session,
        item: p.item,
        author: typeof p.author === "string" ? p.author : "",
        text: typeof p.text === "string" ? p.text : "",
      }
    : null;
}

/** A thread's root and newest reply, for its channel (D237): saved so lists don't load each chat. */
export function threadPreview(items: readonly Item[]): {
  first?: string;
  last?: string;
  lastBy?: string;
  replies?: number;
  recap?: string;
  blocked?: true;
  usedModel?: string;
} {
  const first = items.find((it) => it.type === "user" && !it.auto);
  const replies = items.filter((it) => it.type === "assistant" && it.text.trim());
  const last = replies[replies.length - 1];
  const line = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, 240);
  // Replies saved before D405 have no key: a built-in external agent's name gives it.
  const usedModel = mostUsedModel(replies, (model) =>
    ACP_PRESETS.some((p) => p.name === model) ? `acp/${model}` : undefined,
  );
  // The latest turn's wrap-up (D301): its first sentence is the chat's status in the lists, and
  // a question that stops the work marks the chat as needing the user.
  const wrapUp = latestWrapUp(items)?.wrapUp;
  return {
    ...(first?.type === "user" && { first: line(first.text) }),
    ...(last?.type === "assistant" && { last: line(last.text) }),
    ...(last?.type === "assistant" && last.speaker && { lastBy: last.speaker }),
    ...(replies.length && { replies: replies.length }),
    ...(wrapUp && { recap: statusLine(wrapUp.recap) }),
    ...(wrapUp?.blocked && { blocked: true }),
    ...(usedModel && { usedModel }),
  };
}

export function sessionJSON(session: AgentSession): unknown {
  return {
    meta: {
      title: session.title.peek(),
      // When the conversation last changed (renaming or pinning doesn't count).
      updated: session.updated,
      ...(session.pinned && { pinned: true }),
      ...(session.archived && { archived: true }),
      // Its channel or direct message, and what the channel shows of it (D237).
      ...(session.room && { room: session.room }),
      ...(session.parent && { parent: session.parent }),
      ...threadPreview(session.items),
      workspace: session.workspaceRoot,
      model: session.model.peek(),
      // For other windows (the worktree agents' overview, D204).
      status: session.status.peek(),
      ...(session.error.peek() && { error: true }),
      // Which of the user's agents the chat is with (its face in the Chats list, D230).
      ...(session.chatMode.peek().startsWith("custom:") && { mode: session.chatMode.peek() }),
      // A group chat's agents (D231): the row shows their faces.
      ...(session.members.peek().length && { members: session.members.peek() }),
      // Edits waiting for review (D273): its folder opening loads the chat, so they show.
      ...(session.changeset.files.peek().length && {
        pending: session.changeset.files.peek().length,
      }),
      // Working in a git worktree (D337): it goes on there.
      ...worktreeMeta(session.id),
    },
    // Full images stay in memory; small previews of the newest are saved (D156).
    items: itemsForSaving(session.items),
    textProtocol: session.textProtocol,
    ...(session.toolLimit && { toolLimit: [...session.toolLimit] }),
    turn: session.turn,
    autoApply: session.autoApply.peek(),
    chatMode: session.chatMode.peek(),
    ...(session.workMode.peek() && { workMode: session.workMode.peek() }),
    changeset: session.changeset.toJSON(),
    applied: session.changeset.appliedJSON(),
    rejected: session.changeset.rejectedJSON(),
    checkpoints: session.checkpoints,
    ...(session.attachedRules.size && { attachedRules: Object.fromEntries(session.attachedRules) }),
    ...(session.toldSkills.size && { toldSkills: Object.fromEntries(session.toldSkills) }),
    // What the agent last saw of each file, as fingerprints (write_file's check, D221).
    seen: session.changeset.seenJSON(),
    plan: session.plan.peek(),
    ...(session.pullRequest.peek() && { pullRequest: session.pullRequest.peek() }),
    // The chat's spend, so agent.budget.perChat holds across restarts (D199).
    ...(session.cost.peek() !== null && { cost: session.cost.peek() }),
    ...(session.budgetAllowed && { budgetAllowed: true }),
    ...(session.acpResume && { acpResume: session.acpResume }),
    // What the external agent last saw, so a restart doesn't lose what it missed (D244).
    ...(session.externalSeen && { externalSeen: session.externalSeen.id }),
  };
}

/**
 * Writes the chat (D221): only over the version this window last read or wrote. When another
 * window saved it since, nothing is written and the chat asks which version to keep.
 */
export async function saveSessionNow(session: AgentSession): Promise<void> {
  if (session.items.length === 0 || session.deleted || session.conflict.peek()) return;
  // New images get their compressed previews first (only those still missing); the chat's own
  // images go whole to its media folder (D381).
  await addPreviews(session.items).catch(() => false);
  await keepChatImages(session.id, session.items).catch(() => false);
  if (session.deleted || session.conflict.peek()) return;
  const saved = await agentStoreIpc
    .save(session.id, JSON.stringify(session), session.savedVersion)
    .catch(() => null);
  if (!saved) return;
  if (!saved.conflict) {
    session.savedVersion = saved.version;
    return;
  }
  session.conflict.value = true;
  session.items.push({
    type: "notice",
    id: newId("n"),
    text: "This chat was changed in another window. Nothing more is saved here until you choose: keep this window's version (it replaces the other) or reload the other one (what happened here since is dropped).",
    tone: "error",
    actions: ["keepHere", "reloadChat"],
  });
  session.bump();
}

/** Ends a two-window conflict: this window's version saved over the other, or the other loaded. */
export async function resolveSaveConflict(
  session: AgentSession,
  keep: "here" | "other",
): Promise<void> {
  if (!session.conflict.peek()) return;
  if (keep === "other") {
    if (session.busyNow()) throw new Error("The agent is still working; stop it first.");
    // Still blocking saves until the other version is loaded (with its own version): a save in
    // flight would otherwise conflict again and put the notice into the reloaded chat (D226 audit).
    try {
      await session.hydrate();
    } finally {
      session.conflict.value = false;
    }
    return;
  }
  session.conflict.value = false;
  // Without an expectation: written whatever the file holds now.
  session.savedVersion = null;
  session.items = session.items.filter(
    (it) => !(it.type === "notice" && it.actions?.includes("keepHere")),
  );
  session.bump();
  await session.save();
}

export async function loadSaved(session: AgentSession): Promise<boolean> {
  // The saved file's version first (D221): a write by another window after it then shows as a
  // conflict on this window's next save, rather than slipping through.
  const version = await agentStoreIpc.version(session.id).catch(() => null);
  const text = await agentStoreIpc.load(session.id).catch(() => null);
  if (!text) return false;
  session.savedVersion = version;
  // Loaded again (the other window's version, D221): nothing of this window's chat stays.
  session.attachedRules.clear();
  session.toldSkills.clear();
  try {
    const data = JSON.parse(text) as {
      meta?: {
        title?: string;
        model?: string;
        workspace?: string | null;
        updated?: number;
        pinned?: boolean;
        archived?: boolean;
        room?: string;
        parent?: unknown;
        worktree?: unknown;
      };
      items?: Item[];
      textProtocol?: boolean;
      turn?: number;
      autoApply?: boolean;
      chatMode?: string;
      changeset?: [];
      checkpoints?: number[];
      plan?: PlanStep[];
    };
    session.title.value = data.meta?.title ?? "Session";
    if (typeof data.meta?.updated === "number") session.updated = data.meta.updated;
    session.pinned = data.meta?.pinned === true;
    session.archived = data.meta?.archived === true;
    session.room = typeof data.meta?.room === "string" ? data.meta.room : null;
    session.parent = threadParent(data.meta?.parent);
    if (typeof data.meta?.workspace === "string") session.workspaceRoot = data.meta.workspace;
    restoreChatWorktree(session.id, data.meta?.worktree);
    session.model.value = data.meta?.model ?? null;
    // Saved by an older or damaged file: only well-formed items (one bad item broke rendering of
    // the whole chat, D160).
    session.items = Array.isArray(data.items) ? data.items.flatMap(validItem) : [];
    session.textProtocol = data.textProtocol === true;
    session.turn = data.turn ?? 0;
    // Auto (full access) is on: nothing waits on review, whatever the chat had (D273).
    session.autoApply.value =
      data.autoApply === true ||
      session.services.settings.peek<string>("agent.runCommands") === "full";
    if (
      data.chatMode === "ask" ||
      data.chatMode === "plan" ||
      // A custom mode (D227) comes back even when it's gone; its next message says so and goes
      // in Agent mode (until then it gets read-only tools).
      data.chatMode?.startsWith("custom:")
    )
      session.chatMode.value = data.chatMode as ChatMode;
    // Plan or Ask on one of the user's agents (D249).
    const work = (data as { workMode?: unknown }).workMode;
    session.workMode.value =
      session.chatMode.peek().startsWith("custom:") && (work === "plan" || work === "ask")
        ? work
        : null;
    session.checkpoints = Array.isArray(data.checkpoints) ? data.checkpoints : [];
    const limit = (data as { toolLimit?: unknown }).toolLimit;
    session.toolLimit = Array.isArray(limit)
      ? limit.filter((t): t is string => typeof t === "string")
      : null;
    const members = (data.meta as { members?: unknown } | undefined)?.members;
    session.members.value = Array.isArray(members)
      ? members.filter((m): m is string => typeof m === "string").slice(0, MAX_MEMBERS)
      : [];
    const pr = (data as { pullRequest?: { number?: unknown; url?: unknown; title?: unknown } })
      .pullRequest;
    session.pullRequest.value =
      pr && typeof pr.title === "string"
        ? {
            number: typeof pr.number === "number" ? pr.number : null,
            url: typeof pr.url === "string" ? pr.url : null,
            title: pr.title,
          }
        : null;
    const attached = (data as { attachedRules?: unknown }).attachedRules;
    if (attached && typeof attached === "object")
      for (const [path, turn] of Object.entries(attached))
        if (typeof turn === "number") session.attachedRules.set(path, turn);
    const told = (data as { toldSkills?: unknown }).toldSkills;
    if (told && typeof told === "object")
      for (const [name, turn] of Object.entries(told))
        if (typeof turn === "number") session.toldSkills.set(name, turn);
    session.changeset.restoreSeen((data as { seen?: unknown }).seen);
    session.plan.value = Array.isArray(data.plan) ? data.plan : [];
    if (Array.isArray(data.changeset)) session.changeset.restore(data.changeset);
    session.changeset.restoreApplied((data as { applied?: unknown }).applied);
    session.changeset.restoreRejected((data as { rejected?: unknown }).rejected);
    const saved = data as { cost?: unknown; budgetAllowed?: unknown };
    if (typeof saved.cost === "number" && Number.isFinite(saved.cost))
      session.cost.value = saved.cost;
    session.budgetAllowed = saved.budgetAllowed === true;
    const resume = (data as { acpResume?: { agent?: unknown; id?: unknown; root?: unknown } })
      .acpResume;
    session.acpResume =
      resume &&
      typeof resume.agent === "string" &&
      typeof resume.id === "string" &&
      typeof resume.root === "string"
        ? { agent: resume.agent, id: resume.id, root: resume.root }
        : null;
    const seenId = (data as { externalSeen?: unknown }).externalSeen;
    session.externalSeen =
      typeof seenId === "string" ? (session.items.find((it) => it.id === seenId) ?? null) : null;
    let interrupted = false;
    for (const it of session.items) {
      if (it.type === "assistant" && it.streaming) {
        it.streaming = false;
        interrupted = true;
      }
      if (it.type === "tool" && (it.status === "running" || it.status === "pending")) {
        it.status = "error";
        it.summary = "interrupted";
        // The model sees this on Continue, not "(no output)" read as success (D161).
        it.result ??= "Interrupted: the IDE closed before this finished; it may not have run.";
        interrupted = true;
      }
    }
    // The IDE closed mid-turn (D159): say so, with Continue, instead of a chat that just stops.
    const last = session.items[session.items.length - 1];
    if (
      last &&
      last.type !== "notice" &&
      // The check ends a finished turn with its tool item: that's not an interruption (D161).
      (interrupted ||
        (last.type === "tool" && !last.check) ||
        (last.type === "user" && (!last.auto || last.auto === "group")))
    )
      session.items.push({
        type: "notice",
        id: newId("n"),
        text: "Interrupted when the IDE closed.",
        tone: "info",
        actions: ["continue"],
      });
    session.version.value = session.version.peek() + 1;
    return true;
  } catch {
    return false;
  }
}

/** A saved item as the panel needs it, or nothing when it's malformed (D160). */
function validItem(raw: unknown): Item[] {
  if (!raw || typeof raw !== "object") return [];
  const it = raw as Record<string, unknown>;
  if (typeof it.id !== "string") return [];
  switch (it.type) {
    case "user":
      return typeof it.text === "string" ? [raw as Item] : [];
    case "assistant":
      return [
        {
          ...(raw as Item & { type: "assistant" }),
          text: typeof it.text === "string" ? it.text : "",
          thinking: typeof it.thinking === "string" ? it.thinking : "",
          // Kept as saved: loadSaved turns it off and, when it was on, says the answer was cut
          // short by the IDE closing (false here hid that notice).
          streaming: it.streaming === true,
        },
      ];
    case "tool":
      return typeof it.name === "string" && typeof it.status === "string" ? [raw as Item] : [];
    case "notice":
    case "summary":
      return typeof it.text === "string" ? [raw as Item] : [];
    default:
      return [];
  }
}

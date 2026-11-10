// The shape of several debug sessions at once (D204), VS Code's: sessions in the order they
// started, child sessions (a Node program's child processes and workers, a compound's
// serverReadyAction browser) under their parent; each session's threads, stopped or running;
// which session and thread the toolbar acts on. Pure functions over plain data, so the
// controller's signals stay simple and this is tested. DOM-free.
import type { StackFrame } from "./session";

export interface ThreadRow {
  id: number;
  name: string;
  stopped: boolean;
  /** Why it stopped ("breakpoint", "exception"…), with an exception's text. */
  reason?: string;
  text?: string;
  /** Its call stack while stopped; null until loaded (other threads load on demand). */
  frames: readonly StackFrame[] | null;
}

export interface SessionLink {
  id: string;
  parentId: string | null;
}

/** Sessions with their depth, each parent followed by its children (in start order). */
export function sessionTree<T extends SessionLink>(
  sessions: readonly T[],
): { session: T; depth: number }[] {
  const ids = new Set(sessions.map((s) => s.id));
  const out: { session: T; depth: number }[] = [];
  const visit = (s: T, depth: number) => {
    out.push({ session: s, depth });
    for (const c of sessions) if (c.parentId === s.id) visit(c, depth + 1);
  };
  // A child whose parent ended shows at the top.
  for (const s of sessions) if (!s.parentId || !ids.has(s.parentId)) visit(s, 0);
  return out;
}

/**
 * Which session gets the focus when `removed` ends (it had it): its parent, else a stopped
 * session, else the most recent one left; null when none is left.
 */
export function focusAfter<T extends SessionLink & { stopped: boolean }>(
  sessions: readonly T[],
  removed: string,
): string | null {
  const gone = sessions.find((s) => s.id === removed);
  const left = sessions.filter((s) => s.id !== removed);
  if (!left.length) return null;
  const parent = gone?.parentId ? left.find((s) => s.id === gone.parentId) : undefined;
  if (parent) return parent.id;
  const stopped = [...left].reverse().find((s) => s.stopped);
  return (stopped ?? left[left.length - 1])?.id ?? null;
}

/** A name for a new session: the configuration's, numbered when one by that name runs. */
export function uniqueName(name: string, taken: readonly string[]): string {
  if (!taken.includes(name)) return name;
  for (let n = 2; ; n++) if (!taken.includes(`${name} (${n})`)) return `${name} (${n})`;
}

/**
 * Threads after a stop: the debugger's list (when it gave one) merged with what was known; the
 * stopped thread (all of them with `allThreadsStopped`) marked, frames kept only for threads
 * still stopped.
 */
export function threadsAfterStop(
  known: readonly ThreadRow[],
  listed: readonly { id: number; name: string }[] | null,
  stop: { threadId: number; reason: string; text?: string; allThreadsStopped?: boolean },
): ThreadRow[] {
  const base: { id: number; name: string }[] = listed?.length
    ? [...listed]
    : known.map((t) => ({ id: t.id, name: t.name }));
  if (!base.some((t) => t.id === stop.threadId))
    base.push({
      id: stop.threadId,
      name: stop.threadId === 1 ? "Main thread" : `Thread ${stop.threadId}`,
    });
  return base.map((t) => {
    const old = known.find((k) => k.id === t.id);
    const hit = t.id === stop.threadId;
    const stopped = hit || stop.allThreadsStopped === true || (old?.stopped ?? false);
    return {
      id: t.id,
      name: t.name,
      stopped,
      ...(hit
        ? { reason: stop.reason, ...(stop.text ? { text: stop.text } : {}) }
        : stopped && old?.reason
          ? { reason: old.reason, ...(old.text ? { text: old.text } : {}) }
          : stop.allThreadsStopped
            ? { reason: "pause" }
            : {}),
      // The stopped thread's stack is loaded fresh; others' on demand.
      frames: hit ? null : stopped ? (old?.frames ?? null) : null,
    };
  });
}

/** Threads after a `continued`: one thread, or all (DAP's default). */
export function threadsAfterContinue(
  known: readonly ThreadRow[],
  e: { threadId?: number; all: boolean },
): ThreadRow[] {
  return known.map((t) =>
    e.all || e.threadId === undefined || t.id === e.threadId
      ? { id: t.id, name: t.name, stopped: false, frames: null }
      : t,
  );
}

/** The thread commands act on: `preferred` when it's there, else a stopped one, else the first. */
export function pickThread(threads: readonly ThreadRow[], preferred: number | null): number | null {
  if (preferred !== null && threads.some((t) => t.id === preferred)) return preferred;
  return threads.find((t) => t.stopped)?.id ?? threads[0]?.id ?? null;
}

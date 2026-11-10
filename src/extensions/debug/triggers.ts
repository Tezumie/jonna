// Triggered breakpoints (VS Code 1.86's "Add triggered breakpoint…" / "Wait for breakpoint"): a
// breakpoint that waits for another one to be hit before it is set. As in VS Code this is the
// IDE's own bookkeeping, not the debugger's: a waiting breakpoint isn't sent to a session until
// its trigger stops that session; then it is sent there (and only there), and a session that ends
// takes that with it. DOM-free and tested; breakpoints.ts keeps the list, breakpointSync.ts
// sends what `sentTo` allows, controller.ts marks what a stop triggered.
import { pathKey } from "../../core/paths/index";

/** What of a breakpoint the bookkeeping reads. */
export interface TriggerFields {
  id: number;
  path: string;
  line: number;
  enabled: boolean;
  /** The id of the breakpoint it waits for. */
  triggeredBy?: number;
  /** Sessions whose stop at the trigger set it (runtime only, never saved). */
  triggeredIn?: readonly string[];
}

/** Whether `b` is sent to session `sessionId` (a waiting one only once triggered there). */
export function sentTo(b: TriggerFields, sessionId: string): boolean {
  return b.triggeredBy === undefined || (b.triggeredIn?.includes(sessionId) ?? false);
}

/** Waiting for its trigger in every running session (VS Code's "pending" glyph while debugging). */
export function isWaiting(b: TriggerFields): boolean {
  return b.enabled && b.triggeredBy !== undefined && !b.triggeredIn?.length;
}

/**
 * The breakpoints a stop hit: the debugger's `hitBreakpointIds` when it said, else (reason
 * "breakpoint") the enabled ones on the line it stopped at, as VS Code does without ids.
 */
export function breakpointsHit(
  list: readonly TriggerFields[],
  stop: {
    hitBreakpointIds?: readonly number[];
    reason: string;
    path?: string | null;
    line?: number;
  },
): number[] {
  if (stop.hitBreakpointIds?.length) return [...stop.hitBreakpointIds];
  if (stop.reason !== "breakpoint" || !stop.path || stop.line === undefined) return [];
  const key = pathKey(stop.path);
  return list
    .filter((b) => b.enabled && b.line === stop.line && pathKey(b.path) === key)
    .map((b) => b.id);
}

/** The enabled breakpoints waiting for one of `hit` that session `sessionId` doesn't have yet. */
export function triggeredBy(
  list: readonly TriggerFields[],
  hit: readonly number[],
  sessionId: string,
): number[] {
  if (!hit.length) return [];
  return list
    .filter(
      (b) =>
        b.enabled &&
        b.triggeredBy !== undefined &&
        hit.includes(b.triggeredBy) &&
        !b.triggeredIn?.includes(sessionId),
    )
    .map((b) => b.id);
}

/** `list` with `ids` triggered in `sessionId` (the same list when nothing changes). */
export function markTriggered<T extends TriggerFields>(
  list: readonly T[],
  ids: readonly number[],
  sessionId: string,
): readonly T[] {
  if (!ids.length) return list;
  return list.map((b) =>
    ids.includes(b.id) && !b.triggeredIn?.includes(sessionId)
      ? { ...b, triggeredIn: [...(b.triggeredIn ?? []), sessionId] }
      : b,
  );
}

/** `list` without session `sessionId`'s triggers (it ended); the same list when it had none. */
export function forgetSession<T extends TriggerFields>(
  list: readonly T[],
  sessionId: string,
): readonly T[] {
  if (!list.some((b) => b.triggeredIn?.includes(sessionId))) return list;
  return list.map((b) => {
    if (!b.triggeredIn?.includes(sessionId)) return b;
    const rest = b.triggeredIn.filter((id) => id !== sessionId);
    const { triggeredIn: _gone, ...plain } = b;
    return (rest.length ? { ...plain, triggeredIn: rest } : plain) as T;
  });
}

/**
 * `list` with links to breakpoints that are gone (or to themselves) dropped: such a breakpoint
 * stops like any other. The same list when every link holds.
 */
export function dropDanglingTriggers<T extends TriggerFields>(list: readonly T[]): readonly T[] {
  const ids = new Set(list.map((b) => b.id));
  const broken = (b: T) =>
    b.triggeredBy !== undefined && (b.triggeredBy === b.id || !ids.has(b.triggeredBy));
  if (!list.some(broken)) return list;
  return list.map((b) => {
    if (!broken(b)) return b;
    const { triggeredBy: _t, triggeredIn: _i, ...plain } = b;
    return plain as T;
  });
}

/**
 * The breakpoints `id` may wait for: every other one, except those that (through their own
 * triggers) wait for `id` — a loop would never fire. `id` null: a breakpoint not added yet.
 */
export function triggerCandidates<T extends TriggerFields>(
  list: readonly T[],
  id: number | null,
): T[] {
  if (id === null) return [...list];
  const byId = new Map(list.map((b) => [b.id, b]));
  const waitsFor = (b: T): boolean => {
    const seen = new Set<number>();
    let next = b.triggeredBy;
    while (next !== undefined && !seen.has(next)) {
      if (next === id) return true;
      seen.add(next);
      next = byId.get(next)?.triggeredBy;
    }
    return false;
  };
  return list.filter((b) => b.id !== id && !waitsFor(b));
}

/** How a link is saved: the trigger's place (ids are new each time breakpoints are restored). */
export function savedTrigger(
  list: readonly TriggerFields[],
  b: TriggerFields,
): { path: string; line: number } | undefined {
  if (b.triggeredBy === undefined) return undefined;
  const t = list.find((x) => x.id === b.triggeredBy);
  return t ? { path: t.path, line: t.line } : undefined;
}

/** The id of the breakpoint saved as `at` in the restored `list`. */
export function restoredTrigger(list: readonly TriggerFields[], at: unknown): number | undefined {
  const a = at as { path?: unknown; line?: unknown } | null | undefined;
  if (!a || typeof a.path !== "string" || typeof a.line !== "number") return undefined;
  const key = pathKey(a.path);
  return list.find((b) => b.line === a.line && pathKey(b.path) === key)?.id;
}

// Unread (D238): when you last saw each conversation, per folder. A conversation shown on screen
// is seen as it changes; one that changed since is unread (bold in the sidebar, marked in the
// Inbox), as Slack's channels.

import type { DisposableStore } from "../../core/lifecycle/index";
import { effect, signal } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";

/** Session id → when it was last seen (its `updated` then). */
export const seenAt = signal<ReadonlyMap<string, number>>(new Map());
/** When this folder started keeping track: conversations older than it count as seen. */
export const seenSince = signal(Date.now());

let schedule: () => void = () => {};

export function markSeen(id: string, updated: number): void {
  const now = seenAt.peek();
  if ((now.get(id) ?? -1) >= updated) return;
  const next = new Map(now);
  // Re-inserted, so the Map's order is "least recently seen first".
  next.delete(id);
  next.set(id, updated);
  // Only the newest few hundred are kept. Older conversations count as seen: tracking starts
  // after the newest one dropped (D244: they turned unread before).
  if (next.size > 500) {
    const dropped = [...next.entries()].slice(0, next.size - 500);
    for (const [k] of dropped) next.delete(k);
    const newest = Math.max(...dropped.map(([, t]) => t));
    if (newest > seenSince.peek()) seenSince.value = newest;
  }
  seenAt.value = next;
  schedule();
}

export function registerUnread(sub: DisposableStore, services: WorkbenchServices): void {
  const { persistence, workspace } = services;
  schedule = () => persistence.scheduleSave();
  sub.add({ dispose: () => (schedule = () => {}) });
  sub.add(
    effect(() => {
      workspace.root.value;
      seenAt.value = new Map();
      seenSince.value = Date.now();
      return undefined;
    }),
  );
  sub.add(
    persistence.register("agent.seen", {
      save: () => ({ since: seenSince.peek(), seen: Object.fromEntries(seenAt.peek()) }),
      restore: (data) => {
        const o = data as { since?: unknown; seen?: unknown } | null;
        if (!o || typeof o !== "object") return;
        if (typeof o.since === "number") seenSince.value = o.since;
        if (o.seen && typeof o.seen === "object")
          seenAt.value = new Map(
            Object.entries(o.seen as Record<string, unknown>).filter(
              (e): e is [string, number] => typeof e[1] === "number",
            ),
          );
      },
    }),
  );
}

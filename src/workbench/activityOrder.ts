// The activity bar's icon order (workbench.activityBar.order, a list of view ids). DOM-free.
// The stored list may name views that aren't registered right now (an extension turned off);
// they keep their place for when they come back. Views the list doesn't name go at the end, in
// registration order.

/** The stored order with every registered id it lacks appended (no duplicates). */
export function mergeOrder(stored: readonly string[], registered: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...stored, ...registered]) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** `views` sorted by the stored order; unnamed views after the named ones, as registered. */
export function orderViews<T extends { id: string }>(
  views: readonly T[],
  stored: readonly string[],
): T[] {
  const rank = new Map<string, number>();
  for (const [i, id] of stored.entries()) if (!rank.has(id)) rank.set(id, i);
  const end = stored.length;
  return views
    .map((view, i) => ({ view, key: rank.get(view.id) ?? end + i }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.view);
}

/**
 * `order` with `id` moved to just before `before` (or to the end when `before` is missing,
 * unknown or `id` itself). An `id` not in the list is inserted.
 */
export function moveInOrder(
  order: readonly string[],
  id: string,
  before?: string | null,
): string[] {
  const rest = order.filter((x) => x !== id);
  const at = before && before !== id ? rest.indexOf(before) : -1;
  if (at < 0) rest.push(id);
  else rest.splice(at, 0, id);
  return rest;
}

/** Reads the setting's value: only strings, in order. */
export function parseOrder(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Where a drag over a vertical list of items drops: the index of the item the dragged one goes
 * before (`mids.length` is the end). `mids` are the items' vertical centers, top to bottom.
 */
export function dropIndex(mids: readonly number[], y: number): number {
  const i = mids.findIndex((mid) => y < mid);
  return i < 0 ? mids.length : i;
}

/**
 * An activity bar badge's text (D210): the count up to four digits, then "9999+" (VS Code stops
 * at a few digits too; "99+" hid how many changes a big checkout has).
 */
export function badgeText(count: number): string {
  const n = Math.max(0, Math.floor(count));
  return n > 9999 ? "9999+" : String(n);
}

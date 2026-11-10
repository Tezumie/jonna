// Tab strip rules that don't need the DOM (D279): which tabs the open-tab limit closes, and where a
// dragged tab lands among tabs laid out in rows (top placement, a separate row for pinned tabs)
// or in a column (tabs on the side).

/** VS Code's workbench.editor.limit.* settings. */
export interface TabLimit {
  enabled: boolean;
  value: number;
  perEditorGroup: boolean;
  excludeDirty: boolean;
}

export interface LimitTab {
  id: string;
  groupId: string;
  pinned: boolean;
  dirty: boolean;
}

/**
 * The tabs to close so no more than `limit.value` stay open (all groups together, or each group
 * on its own), least recently used first. `mru` lists tab ids most recent first; a tab not in it
 * was never shown and counts as the oldest. Pinned and dirty tabs and `keep` (the tab just
 * opened) are never closed; dirty ones don't count when `excludeDirty`.
 */
export function tabsOverLimit(
  tabs: readonly LimitTab[],
  mru: readonly string[],
  limit: TabLimit,
  keep: string | null,
): string[] {
  if (!limit.enabled) return [];
  const max = Math.max(1, Math.floor(limit.value));
  const recency = (id: string) => {
    const i = mru.indexOf(id);
    return i < 0 ? Number.POSITIVE_INFINITY : i;
  };
  const sets = limit.perEditorGroup
    ? [...new Set(tabs.map((t) => t.groupId))].map((g) => tabs.filter((t) => t.groupId === g))
    : [tabs];
  const close: string[] = [];
  for (const set of sets) {
    const counted = set.filter((t) => !(limit.excludeDirty && t.dirty));
    let over = counted.length - max;
    if (over <= 0) continue;
    const candidates = set
      .filter((t) => !t.pinned && !t.dirty && t.id !== keep)
      .sort((a, b) => recency(b.id) - recency(a.id));
    for (const t of candidates) {
      if (over <= 0) break;
      close.push(t.id);
      over--;
    }
  }
  return close;
}

export interface TabBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where a tab dropped at (x, y) goes among `boxes` (the strip's tabs in order): the index of the
 * tab it lands before, or `boxes.length` after the last. Tabs in rows go before the first tab
 * whose row is below the pointer, or whose row it's in and whose middle is right of it; tabs in a
 * column (`vertical`) before the first tab whose middle is below it.
 */
export function dropIndex(
  boxes: readonly TabBox[],
  x: number,
  y: number,
  vertical: boolean,
): number {
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i] as TabBox;
    if (vertical) {
      if (y < b.top + b.height / 2) return i;
      continue;
    }
    if (y < b.top) return i;
    if (y <= b.top + b.height && x < b.left + b.width / 2) return i;
  }
  return boxes.length;
}

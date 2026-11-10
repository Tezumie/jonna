// The status bar's right-click menu (D383, VS Code's): the items on the bar listed with a check,
// in the order they show, and the set of items the user hid (workbench.statusBar.hidden).
// DOM-free so the order and the hidden list are unit-tested.

/** What the menu needs to know about a status bar item. */
export interface StatusEntry {
  id: string;
  /** What the item is ("Problems", "Git branch"); the menu's label. */
  name?: string;
  alignment: "left" | "right";
  /** Higher priority = closer to the edge. */
  priority: number;
  /** False for an item the user can't hide (a pending key chord's message). */
  hideable?: boolean;
  /** Whether it shows something now (its text isn't empty). */
  showing?: boolean;
}

export interface StatusMenuEntry {
  id: string;
  label: string;
  alignment: "left" | "right";
  showing: boolean;
}

/**
 * The hideable items in the order they sit on the bar, left to right: the left side's from the
 * edge in (highest priority first), then the right side's towards the edge (lowest first). Items
 * sharing an id (several downloads use one) are listed once, showing if any of them is; ties
 * keep their registration order. With `hidden` (the menu), only what's on the bar now and what
 * the user hid: an item that shows nothing yet (a download's progress, Go Live without a page)
 * isn't listed, as in VS Code, where such items don't exist until they show.
 */
export function statusMenuEntries(
  entries: readonly StatusEntry[],
  hidden?: ReadonlySet<string>,
): StatusMenuEntry[] {
  const byId = new Map<string, StatusMenuEntry & { priority: number }>();
  for (const e of entries) {
    if (e.hideable === false) continue;
    const seen = byId.get(e.id);
    if (seen) {
      seen.showing ||= e.showing !== false;
      continue;
    }
    byId.set(e.id, {
      id: e.id,
      label: e.name?.trim() || e.id,
      alignment: e.alignment,
      priority: e.priority,
      showing: e.showing !== false,
    });
  }
  const listed = [...byId.values()].filter((e) => !hidden || e.showing || hidden.has(e.id));
  const left = listed.filter((e) => e.alignment === "left").sort((a, b) => b.priority - a.priority);
  const right = listed
    .filter((e) => e.alignment === "right")
    .sort((a, b) => a.priority - b.priority);
  return [...left, ...right].map(({ priority: _, ...entry }) => entry);
}

/** workbench.statusBar.hidden's value as a set of item ids (anything else is ignored). */
export function readHiddenItems(value: unknown): Set<string> {
  return new Set(
    Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && !!x) : [],
  );
}

/** The hidden list after hiding or showing one item, or showing them all (`id` null). */
export function withItemHidden(
  current: Iterable<string>,
  id: string | null,
  hidden: boolean,
): string[] {
  if (id === null) return hidden ? [...current] : [];
  const next = new Set(current);
  if (hidden) next.add(id);
  else next.delete(id);
  return [...next];
}

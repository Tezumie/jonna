// launch.json `presentation` (D207), VS Code's: on a configuration or a compound, `hidden` leaves
// it out of the configuration picker (it still starts by name), `group` puts it in a group
// (groups sorted by name, a line between them) and `order` sorts inside the group. Entries
// without a presentation come last, in file order. DOM-free and tested.

export interface Presentation {
  hidden?: boolean;
  group?: string;
  order?: number;
}

/** `presentation` from a configuration's or compound's JSON (undefined when there is none). */
export function parsePresentation(raw: unknown): Presentation | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const p = raw as Record<string, unknown>;
  const out: Presentation = {};
  if (p.hidden === true) out.hidden = true;
  if (typeof p.group === "string" && p.group.trim()) out.group = p.group.trim();
  if (typeof p.order === "number" && Number.isFinite(p.order)) out.order = p.order;
  return out;
}

function compareOrders(a: number | undefined, b: number | undefined): number {
  if (a === undefined) return b === undefined ? 0 : 1;
  if (b === undefined) return -1;
  return a - b;
}

/** Without the hidden ones, sorted as VS Code's picker sorts them (stable otherwise). */
export function visibleAndSorted<T extends { presentation?: Presentation | undefined }>(
  items: readonly T[],
): T[] {
  return items
    .filter((i) => !i.presentation?.hidden)
    .sort((x, y) => {
      const a = x.presentation;
      const b = y.presentation;
      if (!a) return b ? 1 : 0;
      if (!b) return -1;
      if (!a.group) return b.group ? 1 : compareOrders(a.order, b.order);
      if (!b.group) return -1;
      if (a.group !== b.group) return a.group.localeCompare(b.group);
      return compareOrders(a.order, b.order);
    });
}

/** Whether a line goes above item `i` of a sorted list: its group differs from the one above. */
export function startsGroup(
  items: readonly { presentation?: Presentation | undefined }[],
  i: number,
): boolean {
  if (i === 0) return false;
  return items[i]?.presentation?.group !== items[i - 1]?.presentation?.group;
}

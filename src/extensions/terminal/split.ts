// Split terminals inside one tab (D209, VS Code's terminal groups): the panes' sizes, the sash
// math, the orientation, focus order, the group's title and the tab state's shape. DOM-free and
// tested; the view (view.ts) lays the panes out from these.
import type { Json } from "../../core/dock/index";

/** A pane narrower (or shorter) than this can't be made by dragging a sash. */
export const MIN_PANE_PX = 80;

export type SplitOrientation = "row" | "column";

/**
 * `terminal.splitDirection`: "auto" follows the tab's shape; "horizontal" puts split terminals
 * side by side and "vertical" stacks them, whatever the shape.
 */
export type SplitDirection = "auto" | "horizontal" | "vertical";

/** The setting's value as a direction (anything else: "auto"). */
export function splitDirectionOf(value: unknown): SplitDirection {
  return value === "horizontal" || value === "vertical" ? value : "auto";
}

/**
 * How a tab's terminals are laid out. "auto": side by side when the tab is wider than tall (a
 * terminal at the bottom, as VS Code's panel splits), stacked when it's tall (a side group).
 */
export function orientationFor(
  width: number,
  height: number,
  direction: SplitDirection = "auto",
): SplitOrientation {
  if (direction === "horizontal") return "row";
  if (direction === "vertical") return "column";
  return width >= height ? "row" : "column";
}

/** Fractions that sum to 1, one per pane (bad or missing values: equal shares). */
export function normalizeSizes(sizes: readonly unknown[] | undefined, count: number): number[] {
  if (count <= 0) return [];
  const list =
    sizes && sizes.length === count
      ? sizes.map((s) => (typeof s === "number" && Number.isFinite(s) && s > 0 ? s : 0))
      : [];
  const total = list.reduce((a, b) => a + b, 0);
  if (list.length !== count || total <= 0 || list.some((s) => s <= 0))
    return Array.from({ length: count }, () => 1 / count);
  return list.map((s) => s / total);
}

/** A pane added after `index`: every pane gets an equal share (VS Code distributes them). */
export function sizesAfterAdd(count: number): number[] {
  return normalizeSizes(undefined, count + 1);
}

/** Pane `index` removed: its share goes to the others in proportion. */
export function sizesAfterRemove(sizes: readonly number[], index: number): number[] {
  const rest = sizes.filter((_, i) => i !== index);
  return normalizeSizes(rest, rest.length);
}

/**
 * The sash after pane `sash` dragged by `delta` px (from the sizes at drag start): only the two
 * panes beside it change, neither below `minPx`.
 */
export function resizeAtSash(
  start: readonly number[],
  sash: number,
  delta: number,
  totalPx: number,
  minPx = MIN_PANE_PX,
): number[] {
  const sizes = [...start];
  const a = sizes[sash];
  const b = sizes[sash + 1];
  if (a === undefined || b === undefined || totalPx <= 0) return sizes;
  const pair = (a + b) * totalPx;
  const min = Math.min(minPx, pair / 2);
  const next = Math.max(min, Math.min(pair - min, a * totalPx + delta));
  sizes[sash] = next / totalPx;
  sizes[sash + 1] = (pair - next) / totalPx;
  return sizes;
}

/** The pane focus moves to: the next or previous one, wrapping (VS Code's focus next / previous pane). */
export function neighbourPane(count: number, active: number, direction: 1 | -1): number {
  if (count <= 0) return 0;
  return (((active + direction) % count) + count) % count;
}

/** The tab's title for a group: the panes' titles joined (VS Code's "bash, node"). */
export function groupTitle(titles: readonly string[]): string {
  const list = titles.map((t) => t.trim()).filter(Boolean);
  return list.length ? list.join(", ") : "Terminal";
}

/** The key a pane's output is saved under (D204): the tab's id for the first, `<tab>#<n>` after. */
export function paneRestoreKey(tabId: string, index: number): string {
  return index === 0 ? tabId : `${tabId}#${index}`;
}

/** Whether a saved output key belongs to tab `tabId` (its first pane or a later one). */
export function isRestoreKeyOf(key: string, tabId: string): boolean {
  return key === tabId || key.startsWith(`${tabId}#`);
}

export interface GroupState {
  /** Each pane's own state (cwd, profile, name, color, icon, task). */
  panes: Json[];
  active: number;
  sizes: number[];
}

// "pseudo" and "shell": an extension's terminal (extensionTerminals.ts, D233).
const PANE_FIELDS = [
  "cwd",
  "profile",
  "task",
  "run",
  "name",
  "color",
  "icon",
  "env",
  "pseudo",
  "shell",
  // The running process a page reload takes back (m7.12).
  "pty",
  // An extension's terminal that isn't saved with the folder (hideFromUser / isTransient, D388).
  "transient",
] as const;

/** One pane's fields out of a tab state (the single-pane shape keeps them at the top level). */
function paneFields(state: Json): Json {
  if (state === null || typeof state !== "object" || Array.isArray(state)) return null;
  const out: Record<string, Json> = {};
  for (const k of PANE_FIELDS) {
    const v = (state as Record<string, Json>)[k];
    if (v !== undefined) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The panes a tab state describes: `panes` (a split group, D209), else the state itself as the
 * only pane (every terminal tab before D209, and new ones).
 */
export function parseGroupState(state: Json): GroupState {
  const record =
    state !== null && typeof state === "object" && !Array.isArray(state)
      ? (state as Record<string, Json>)
      : null;
  const panes = record?.panes;
  if (Array.isArray(panes) && panes.length > 0) {
    const list = panes.map((p) => paneFields(p));
    const active = typeof record?.active === "number" ? Math.trunc(record.active) : 0;
    return {
      panes: list,
      active: Math.max(0, Math.min(list.length - 1, active)),
      sizes: normalizeSizes(Array.isArray(record?.sizes) ? record.sizes : undefined, list.length),
    };
  }
  return { panes: [paneFields(state)], active: 0, sizes: [1] };
}

/**
 * The tab state for a group: one pane keeps the plain shape (older versions read it); several
 * carry `panes`, `active` and `sizes`, with the active pane's color and icon at the top level
 * for the tab's icon.
 */
export function serializeGroup(
  panes: readonly Json[],
  active: number,
  sizes: readonly number[],
): Json {
  if (panes.length <= 1) return panes[0] ?? null;
  const lead = panes[active] ?? panes[0];
  const top: Record<string, Json> = {};
  if (lead && typeof lead === "object" && !Array.isArray(lead)) {
    const { color, icon } = lead as Record<string, Json>;
    if (color !== undefined) top.color = color;
    if (icon !== undefined) top.icon = icon;
  }
  return {
    ...top,
    panes: panes.map((p) => p ?? {}),
    active,
    sizes: sizes.map((s) => Math.round(s * 10000) / 10000),
  };
}

/**
 * A tab state without its panes' running processes (`pty`, m7.12): a duplicated tab starts its
 * own shells rather than reaching for the original's.
 */
export function withoutPty(state: Json): Json {
  if (state === null || typeof state !== "object" || Array.isArray(state)) return state;
  const { pty: _pty, ...rest } = state as Record<string, Json>;
  const panes = rest.panes;
  if (Array.isArray(panes)) rest.panes = panes.map((p) => withoutPty(p));
  return rest;
}

/** A pane state's `pty` (`{ id, key }`), or null. */
export function parsePtyRef(value: unknown): { id: number; key: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { id, key } = value as Record<string, unknown>;
  return typeof id === "number" && Number.isInteger(id) && id > 0 && typeof key === "string" && key
    ? { id, key }
    : null;
}

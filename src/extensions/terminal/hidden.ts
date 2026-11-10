// Hidden terminals (D217, VS Code's detached terminal sessions / "Attach to session"): a
// terminal tab taken out of the dock while its shells keep running. The tab's panes (one, or a
// split group) wait here with their sizes, active pane and the place the tab had, until
// "Show hidden terminal" opens a tab that adopts them again. DOM-free and tested; the panes are
// whatever the caller keeps (TerminalPane in the app).
import type { Json } from "../../core/dock/index";
import { normalizeSizes, paneRestoreKey, sizesAfterRemove } from "./split";

/** Where the tab was (its dock group and index), to put it back there. */
export interface HiddenPlace {
  groupId: string;
  index: number;
}

export interface HiddenGroup<P> {
  /** Unique for the session; hidden panes report `hidden:<key>` as their tab. */
  readonly key: string;
  panes: P[];
  sizes: number[];
  active: number;
  /** Date.now() when it was hidden (the newest is listed first). */
  readonly hiddenAt: number;
  readonly place: HiddenPlace | null;
}

/** The tab id hidden panes report: no dock tab has it. */
export const hiddenTabId = (key: string): string => `hidden:${key}`;
export const isHiddenTabId = (tabId: string): boolean => tabId.startsWith("hidden:");

export class HiddenTerminals<P> {
  private groups: HiddenGroup<P>[] = [];
  private next = 1;

  /** Parks a tab's panes; returns the group (its key names it from now on). */
  add(
    panes: readonly P[],
    sizes: readonly number[],
    active: number,
    place: HiddenPlace | null,
    now = Date.now(),
  ): HiddenGroup<P> {
    const group: HiddenGroup<P> = {
      key: `h${this.next++}`,
      panes: [...panes],
      sizes: normalizeSizes(sizes, panes.length),
      active: Math.max(0, Math.min(panes.length - 1, active)),
      hiddenAt: now,
      place,
    };
    if (group.panes.length) this.groups.push(group);
    return group;
  }

  /** A group put back as it was (its tab couldn't open): same key and place. */
  restore(group: HiddenGroup<P>): void {
    if (group.panes.length && !this.groups.includes(group)) this.groups.push(group);
  }

  /** Newest first (the order of the ▾ menu and the picker). */
  list(): readonly HiddenGroup<P>[] {
    return [...this.groups].sort((a, b) => b.hiddenAt - a.hiddenAt);
  }

  get size(): number {
    return this.groups.length;
  }

  get(key: string): HiddenGroup<P> | undefined {
    return this.groups.find((g) => g.key === key);
  }

  /** The hidden group a pane is in, if any. */
  groupOf(pane: P): HiddenGroup<P> | undefined {
    return this.groups.find((g) => g.panes.includes(pane));
  }

  /** Takes a group out (to show it again). */
  take(key: string): HiddenGroup<P> | undefined {
    const group = this.get(key);
    if (group) this.groups = this.groups.filter((g) => g !== group);
    return group;
  }

  /**
   * Drops one pane (it was killed): the others keep their shares; a group left empty goes.
   * Returns whether the pane was hidden.
   */
  removePane(pane: P): boolean {
    const group = this.groupOf(pane);
    if (!group) return false;
    const index = group.panes.indexOf(pane);
    group.panes.splice(index, 1);
    group.sizes = sizesAfterRemove(group.sizes, index);
    if (group.active >= index && group.active > 0) group.active--;
    group.active = Math.max(0, Math.min(group.panes.length - 1, group.active));
    if (!group.panes.length) this.groups = this.groups.filter((g) => g !== group);
    return true;
  }

  /** Every hidden pane, the groups forgotten (the folder closed: the caller disposes them). */
  clear(): P[] {
    const all = this.groups.flatMap((g) => g.panes);
    this.groups = [];
    return all;
  }
}

/** The restore key of pane `index` of the `group`-th hidden tab (newest first) in the state. */
export const hiddenRestoreKey = (group: number, index: number) =>
  paneRestoreKey(`hidden-${group}`, index);

/** One hidden tab as saved with the folder. */
export interface SavedHiddenGroup {
  panes: Json[];
  sizes: number[];
  active: number;
  hiddenAt: number;
  place: { groupId: string; index: number } | null;
}

/** Saved hidden tabs, anything malformed dropped. */
export function parseSavedHidden(data: unknown): SavedHiddenGroup[] {
  if (!Array.isArray(data)) return [];
  const out: SavedHiddenGroup[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const g = raw as Record<string, unknown>;
    if (!Array.isArray(g.panes) || !g.panes.length) continue;
    const place = g.place as Record<string, unknown> | null | undefined;
    out.push({
      panes: g.panes as Json[],
      sizes: Array.isArray(g.sizes)
        ? g.sizes.filter((n): n is number => typeof n === "number")
        : [],
      active: typeof g.active === "number" ? g.active : 0,
      hiddenAt: typeof g.hiddenAt === "number" ? g.hiddenAt : Date.now(),
      place:
        place && typeof place.groupId === "string" && typeof place.index === "number"
          ? { groupId: place.groupId, index: place.index }
          : null,
    });
  }
  return out;
}

// Extensions' webview panels kept across restarts (VS Code's registerWebviewPanelSerializer): the
// panels whose view type the extension can restore are saved with the folder's state (view type,
// title, where, the state their page last saved); after a restart they wait here until their
// extension is loaded, which reopens them, starts its code and hands each to its serializer.
// DOM-free and unit-tested.
import { type Signal, signal } from "../core/reactive/index";

export interface SavedPanel {
  /** The extension's id. */
  owner: string;
  viewType: string;
  title: string;
  /** What its page last gave `setState` (JSON). */
  state?: unknown;
  /** The dock group it was in (reused when that group is still there). */
  groupId?: string;
  /** It was the tab shown in its group. */
  shown?: boolean;
}

/** At most this many panels are kept, and this much state each (JSON characters). */
export const MAX_SAVED_PANELS = 30;
export const MAX_PANEL_STATE = 512 * 1024;

const ID = /^[\w.-]{1,200}$/;

/** One saved panel checked (null: not one); a state that's too big is left out. */
export function toSavedPanel(raw: unknown): SavedPanel | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.owner !== "string" || !ID.test(r.owner)) return null;
  if (typeof r.viewType !== "string" || !r.viewType || r.viewType.length > 100) return null;
  const title = typeof r.title === "string" ? r.title.slice(0, 200) : "";
  let state: unknown;
  if (r.state !== undefined && r.state !== null) {
    const json = safeJson(r.state);
    if (json !== undefined && json.length <= MAX_PANEL_STATE) state = JSON.parse(json);
  }
  return {
    owner: r.owner,
    viewType: r.viewType,
    title,
    ...(state !== undefined && { state }),
    ...(typeof r.groupId === "string" && /^g?\w{1,40}$/.test(r.groupId) && { groupId: r.groupId }),
    ...(r.shown === true && { shown: true }),
  };
}

function safeJson(v: unknown): string | undefined {
  try {
    return JSON.stringify(v);
  } catch {
    return undefined;
  }
}

export class RestorablePanels {
  /** Panels from the folder's saved state whose extension hasn't taken them yet. */
  readonly pending: Signal<readonly SavedPanel[]> = signal<readonly SavedPanel[]>([]);

  /** The folder's saved panels (replaces what was waiting). */
  load(raw: unknown): void {
    const list = Array.isArray(raw) ? raw : [];
    this.pending.value = list
      .map(toSavedPanel)
      .filter((p): p is SavedPanel => p !== null)
      .slice(0, MAX_SAVED_PANELS);
  }

  /** The folder closed: nothing waits any more. */
  clear(): void {
    if (this.pending.peek().length) this.pending.value = [];
  }

  /** Takes `owner`'s panels it can restore now (the others keep waiting). */
  take(owner: string, canRestore: (viewType: string) => boolean): SavedPanel[] {
    const taken: SavedPanel[] = [];
    const left: SavedPanel[] = [];
    for (const p of this.pending.peek())
      (p.owner === owner && canRestore(p.viewType) ? taken : left).push(p);
    if (taken.length) this.pending.value = left;
    return taken;
  }

  /**
   * What to save: the open panels that can come back, then those still waiting (an extension
   * not loaded this session keeps its panels for the next one), within the limits.
   */
  save(open: readonly SavedPanel[]): SavedPanel[] {
    return [...open, ...this.pending.peek()]
      .map(toSavedPanel)
      .filter((p): p is SavedPanel => p !== null)
      .slice(0, MAX_SAVED_PANELS);
  }
}

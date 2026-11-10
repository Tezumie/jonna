// Every view keeps its scroll positions (D190): while it lives (a tab moved to another group or
// window loses its scroll offsets when its element is re-parented, so they're put back), and
// after it closes or the app restarts (saved per workspace by the view's identity: the view
// type and its state, e.g. a Markdown preview of one file; capped). Text editors keep their
// own positions (editor/positions.ts): Monaco and terminals scroll themselves and are skipped.
import { type Disposable, toDisposable } from "../core/lifecycle/index";

interface Offset {
  top: number;
  left: number;
}
/** A scrolled element, found again by its child-index path from the view's root. */
interface SavedOffset extends Offset {
  path: number[];
}

/** How many closed views' positions are kept per workspace. */
export const SCROLL_MEMORY_CAP = 150;
const SKIP = ".monaco-editor, .xterm, iframe";
const RETRY_MS = [0, 80, 250, 600, 1500];

interface Tracked {
  key: () => string;
  live: Map<Element, Offset>;
  /** Set while restoring: the restore's own scroll events aren't the user's. */
  restoring: boolean;
  userScrolled: boolean;
}

export class ScrollMemory {
  private readonly roots = new Map<HTMLElement, Tracked>();
  /** Closed or not-yet-shown views by key, most recent last. */
  private saved = new Map<string, SavedOffset[]>();
  /** Called when something worth saving changed (persistence.scheduleSave). */
  onChange: () => void = () => {};

  /** Starts remembering the scroll offsets of `root`'s scrollable elements. */
  track(root: HTMLElement, key: () => string): Disposable {
    // Views without a DOM (the dock's unit tests) have nothing to keep.
    if (typeof root?.addEventListener !== "function") return toDisposable(() => {});
    const tracked: Tracked = { key, live: new Map(), restoring: false, userScrolled: false };
    this.roots.set(root, tracked);
    const onScroll = (e: Event) => {
      const el = e.target;
      if (!(el instanceof Element) || el === document.documentElement) return;
      if (!root.contains(el) || el.closest(SKIP)) return;
      // A hidden or detached element reads 0: not a position anyone chose.
      if (!el.isConnected || !(el as HTMLElement).offsetParent) return;
      tracked.live.set(el, { top: el.scrollTop, left: el.scrollLeft });
      // A view that re-renders its scrollers (chat code blocks) mustn't keep the old ones.
      if (tracked.live.size > 32)
        for (const old of tracked.live.keys()) if (!root.contains(old)) tracked.live.delete(old);
      if (!tracked.restoring) tracked.userScrolled = true;
      this.onChange();
    };
    root.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return toDisposable(() => {
      root.removeEventListener("scroll", onScroll, { capture: true });
      this.remember(root, tracked);
      this.roots.delete(root);
    });
  }

  /**
   * Puts the offsets back after `root` was shown or moved: the live ones, or for a view
   * created just now, the saved ones of the same key (retried while its content loads).
   */
  restore(root: HTMLElement): void {
    const tracked = this.roots.get(root);
    if (!tracked) return;
    for (const [el, at] of tracked.live) {
      if (!root.contains(el)) {
        tracked.live.delete(el);
        continue;
      }
      if (el.scrollTop !== at.top || el.scrollLeft !== at.left) this.apply(tracked, el, at);
    }
    if (tracked.live.size || tracked.userScrolled) return;
    const key = tracked.key();
    const saved = this.saved.get(key);
    if (!saved?.length) return;
    let pending = saved;
    for (const delay of RETRY_MS)
      setTimeout(() => {
        if (tracked.userScrolled || !pending.length || !this.roots.has(root)) return;
        pending = pending.filter((s) => {
          const el = elementAt(root, s.path);
          if (!el || el.closest(SKIP)) return true;
          // Not tall enough yet (content still loading): try again later.
          if (el.scrollHeight - el.clientHeight < s.top || el.scrollWidth - el.clientWidth < s.left)
            return true;
          this.apply(tracked, el, s);
          tracked.live.set(el, { top: s.top, left: s.left });
          return false;
        });
      }, delay);
  }

  private apply(tracked: Tracked, el: Element, at: Offset): void {
    tracked.restoring = true;
    el.scrollTop = at.top;
    el.scrollLeft = at.left;
    // Scroll events are async: clear the flag after they've been delivered.
    requestAnimationFrame(() => {
      tracked.restoring = false;
    });
  }

  /** Copies a live view's offsets into the saved ones (closing, saving the workspace). */
  private remember(root: HTMLElement, tracked: Tracked): void {
    const offsets: SavedOffset[] = [];
    for (const [el, at] of tracked.live) {
      if (!root.contains(el) || (at.top === 0 && at.left === 0)) continue;
      const path = pathOf(root, el);
      if (path) offsets.push({ path, ...at });
    }
    let key: string;
    try {
      key = tracked.key();
    } catch {
      return;
    }
    if (!key) return;
    // Nothing scrolled this time: keep what an earlier session saved for it.
    if (!offsets.length && !tracked.userScrolled) return;
    this.saved.delete(key);
    if (offsets.length) this.saved.set(key, offsets);
    while (this.saved.size > SCROLL_MEMORY_CAP) {
      const oldest = this.saved.keys().next().value;
      if (oldest === undefined) break;
      this.saved.delete(oldest);
    }
  }

  /** The saved offsets (live views included), for the workspace state. */
  save(): Record<string, SavedOffset[]> {
    for (const [root, tracked] of this.roots) this.remember(root, tracked);
    return Object.fromEntries(this.saved);
  }

  load(data: unknown): void {
    this.saved = new Map();
    if (!data || typeof data !== "object") return;
    for (const [key, list] of Object.entries(data as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const offsets = list.filter(
        (o): o is SavedOffset =>
          !!o &&
          Array.isArray(o.path) &&
          o.path.every((n: unknown) => Number.isInteger(n) && (n as number) >= 0) &&
          Number.isFinite(o.top) &&
          Number.isFinite(o.left),
      );
      if (offsets.length) this.saved.set(key, offsets);
    }
  }

  /** What `ide://layout`-style state can show: how many views have saved positions. */
  get size(): number {
    return this.saved.size;
  }
}

function pathOf(root: Element, el: Element): number[] | null {
  const path: number[] = [];
  let node: Element | null = el;
  while (node && node !== root) {
    const parent: Element | null = node.parentElement;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.children, node));
    node = parent;
  }
  return node === root ? path : null;
}

function elementAt(root: Element, path: readonly number[]): Element | null {
  let node: Element | undefined = root;
  for (const i of path) {
    node = node?.children[i];
    if (!node) return null;
  }
  return node ?? null;
}

/** A stable key for a view: its type and state (object keys sorted). */
export function viewKey(type: string, state: unknown): string {
  const stable = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort()
            .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
        )
      : v;
  return `${type}:${JSON.stringify(stable(state ?? null))}`;
}

/** The workbench's one memory (dock tabs and side bar views). */
export const scrollMemory = new ScrollMemory();

// The dock's state and queries: the tree signal, focus, live views (created lazily per tab, kept
// alive across moves, disposed when the tab closes), most-recently-used order and id allocation.
// Operations that change the tree live in DockService (service.ts), which extends this.

import type {
  DockNode,
  GroupNode,
  Json,
  Placement,
  Side,
  TabLimit,
  TabRef,
} from "../../core/dock/index";
import * as dock from "../../core/dock/index";
import { Emitter } from "../../core/events/index";
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import { computed, type ReadonlySignal, type Signal, signal } from "../../core/reactive/index";
import { scrollMemory, viewKey } from "../scrollMemory";
import type { DockView, DockViewDescriptor, DockViewRegistry } from "./views";

export type OpenPlacement =
  | Placement
  | { groupId: string; index?: number }
  | { groupId: string; split: Side }
  | { root: Side };

export type Region = "bottom" | "right";

interface LiveView {
  view: DockView;
  store: DisposableStore;
}

export const STATE_VERSION = 1;

/** How tabs look and behave (VS Code's workbench.editor.* settings, D279). */
export interface TabOptions {
  /** Git and problem colors on tab titles. */
  decorationColors: boolean;
  /** Git letters and problem counts after tab titles. */
  decorationBadges: boolean;
  /** Which side of the title the close (or unpin) button is on. */
  actionLocation: "left" | "right";
  /** Whether tabs have a close button. */
  closeButton: boolean;
  /** Pinned tabs on a row of their own. */
  pinnedOnSeparateRow: boolean;
  /** Tabs above the group, or a list on its left or right. */
  placement: "top" | "left" | "right";
  limit: TabLimit;
  /** After closing the active tab: the most recently used one (else its neighbor). */
  focusRecentAfterClose: boolean;
}

export const DEFAULT_TAB_OPTIONS: TabOptions = {
  decorationColors: true,
  decorationBadges: true,
  actionLocation: "right",
  closeButton: true,
  pinnedOnSeparateRow: false,
  placement: "top",
  limit: { enabled: false, value: 10, perEditorGroup: false, excludeDirty: false },
  focusRecentAfterClose: true,
};

export abstract class DockModel implements Disposable {
  /** Closes a tab (service.ts); views can close their own tab. */
  abstract closeTab(tabId: string, force?: boolean): Promise<boolean>;
  abstract pinTab(tabId: string): void;

  readonly root: Signal<DockNode>;
  readonly focusedGroupId: Signal<string | null> = signal<string | null>(null);
  /** Bumped when a tab's title or dirty flag changes (tab strips re-render). */
  readonly decorations: Signal<number> = signal(0);
  /**
   * Tabs whose view is shown in an auxiliary window (D101): the tab stays in its group (a
   * placeholder there) and its live view keeps running; the renderer leaves its element alone.
   */
  readonly detached: Signal<ReadonlySet<string>> = signal<ReadonlySet<string>>(new Set());
  /** Set from the settings by the workbench extension; tab strips re-render when it changes. */
  readonly tabOptions: Signal<TabOptions> = signal<TabOptions>(DEFAULT_TAB_OPTIONS);
  protected readonly live = new Map<string, LiveView>();
  /** Tab ids, most recently active first. */
  protected mru: string[] = [];
  protected counter = 0;
  protected readonly store = new DisposableStore();
  protected readonly focusRequested = this.store.add(new Emitter<string>());
  /** The renderer focuses the tab's view when this fires. */
  readonly onDidRequestFocus = this.focusRequested.event;
  protected readonly flashRequested = this.store.add(new Emitter<string>());
  /** The renderer flashes the tab (visual bell) when this fires. */
  readonly onDidRequestFlash = this.flashRequested.event;

  constructor(readonly views: DockViewRegistry) {
    this.root = signal<DockNode>({ kind: "group", id: "main", tabs: [], activeTabId: null });
  }

  // ---- Queries ---------------------------------------------------------------------

  descriptor(tab: TabRef): DockViewDescriptor | undefined {
    return this.views.get(tab.viewType);
  }

  /** Recently closed editor tabs, newest last (Reopen closed tab). */
  protected closedTabs: { viewType: string; viewState: Json; groupId: string }[] = [];

  isEditorLike = (tab: TabRef): boolean => this.descriptor(tab)?.editorLike === true;

  tabs(viewType?: string): TabRef[] {
    const all = dock.allTabs(this.root.peek());
    return viewType ? all.filter((t) => t.viewType === viewType) : all;
  }

  findTab(tabId: string): { group: GroupNode; index: number } | undefined {
    return dock.findTab(this.root.peek(), tabId);
  }

  findGroup(groupId: string): GroupNode | undefined {
    return dock.findGroup(this.root.peek(), groupId);
  }

  /** The visible group next to `groupId` on `side`, if any. */
  neighbor(groupId: string, side: Side): string | undefined {
    return dock.neighborGroup(this.root.peek(), groupId, side);
  }

  focusedGroup(): GroupNode | undefined {
    const id = this.focusedGroupId.peek();
    const groups = dock.allGroups(this.root.peek());
    return groups.find((g) => g.id === id) ?? groups[0];
  }

  /** The active tab of the focused group. */
  activeTab(): TabRef | undefined {
    const group = this.focusedGroup();
    return group?.tabs.find((t) => t.id === group.activeTabId);
  }

  /** Most recently active tab matching `predicate`. */
  recentTab(predicate: (t: TabRef) => boolean): TabRef | undefined {
    const tabs = new Map(this.tabs().map((t) => [t.id, t]));
    for (const id of this.mru) {
      const tab = tabs.get(id);
      if (tab && predicate(tab)) return tab;
    }
    return this.tabs().find(predicate);
  }

  title(tab: TabRef): string {
    return (
      this.live.get(tab.id)?.view.title?.() ??
      this.descriptor(tab)?.title(tab.viewState) ??
      tab.viewType
    );
  }

  isDirty(tab: TabRef): boolean {
    return this.live.get(tab.id)?.view.isDirty?.() ?? false;
  }

  /** The tab's view is still getting ready (DockView.busy). */
  isBusy(tab: TabRef): boolean {
    return this.live.get(tab.id)?.view.busy?.() ?? false;
  }

  /** The tab's live view, created on first use. */
  view(tab: TabRef): DockView | undefined {
    const existing = this.live.get(tab.id);
    if (existing) return existing.view;
    const descriptor = this.descriptor(tab);
    if (!descriptor) return undefined;
    const store = new DisposableStore();
    const view = descriptor.create(tab.viewState, {
      tabId: tab.id,
      updateState: (state) => this.set(dock.updateTabState(this.root.peek(), tab.id, state)),
      close: () => void this.closeTab(tab.id, true),
      pin: () => this.pinTab(tab.id),
      flash: () => this.flashRequested.fire(tab.id),
    });
    store.add(view);
    // Its scroll offsets survive moves, closing and restarts (D190); disposed before the view.
    const viewType = tab.viewType;
    store.add(scrollMemory.track(view.element, () => viewKey(viewType, view.serialize())));
    if (view.onDidChange)
      store.add(view.onDidChange(() => (this.decorations.value = this.decorations.peek() + 1)));
    this.live.set(tab.id, { view, store });
    return view;
  }

  liveView(tabId: string): DockView | undefined {
    return this.live.get(tabId)?.view;
  }

  /** Groups currently in the bottom/right region (hidden ones included). */
  regionGroups(region: Region): GroupNode[] {
    return dock.regionGroups(this.root.peek(), region, this.isEditorLike);
  }

  /** True while some group of the region is showing (title-bar toggle state). */
  regionVisible(region: Region): ReadonlySignal<boolean> {
    return computed(() =>
      dock.regionGroups(this.root.value, region, this.isEditorLike).some((g) => !g.hidden),
    );
  }

  /** Disposes every live view (folder switch); the tree stays until replaced. */
  closeAllLive(): void {
    // Each view's element goes with it, as when one tab closes (D237): groups keep the elements
    // they've shown, so a notebook left in the page after Close folder stayed on screen.
    for (const live of this.live.values()) {
      live.store.dispose();
      live.view.element.remove?.();
    }
    this.live.clear();
    this.mru = [];
    this.closedTabs = [];
  }

  /**
   * The dock never goes blank: with no tab left on screen, show `welcome` (docs/dock.md §5). Any
   * tab on screen (a chat, the terminal) is enough, so Welcome can be closed beside it (D368).
   */
  protected ensureEditorRegion(root: DockNode, preferredGroupId?: string): DockNode {
    if (
      !this.views.get("welcome") ||
      dock.allTabs(root).some(this.isEditorLike) ||
      dock.hasShownTab(root)
    )
      return root;
    const tab: TabRef = { id: this.newId("t"), viewType: "welcome", viewState: null };
    const target =
      (preferredGroupId && dock.findGroup(root, preferredGroupId)) ||
      dock.mainGroup(root, this.isEditorLike);
    return target ? dock.addTab(root, target.id, tab, 0, true) : root;
  }

  /** Adds the welcome tab to `groupId` as if `closing` were already gone (see closeTab). */
  protected ensureEditorRegionIn(root: DockNode, groupId: string, closing: string): DockNode {
    if (!this.views.get("welcome") || !dock.findGroup(root, groupId)) return root;
    const tab: TabRef = { id: this.newId("t"), viewType: "welcome", viewState: null };
    const group = dock.findGroup(root, groupId);
    const index = group
      ? Math.max(
          0,
          group.tabs.findIndex((t) => t.id === closing),
        )
      : 0;
    return dock.addTab(root, groupId, tab, index, true);
  }

  // ---- Internals -------------------------------------------------------------------------------

  protected set(root: DockNode): void {
    this.root.value = root;
    this.sweepSoon();
  }

  private sweepQueued = false;

  /**
   * After the tree changes, a live view whose tab is gone is disposed (D379): closeTab does it,
   * but a tab dropped another way (a layout replaced, a transient tab left out) kept its view
   * and element alive, hidden in its group. A microtask later, so an operation that removes and
   * adds back in steps isn't caught halfway.
   */
  private sweepSoon(): void {
    if (this.sweepQueued) return;
    this.sweepQueued = true;
    queueMicrotask(() => {
      this.sweepQueued = false;
      if (this.disposed) return;
      const open = new Set(dock.allTabs(this.root.peek()).map((t) => t.id));
      for (const [id, live] of [...this.live]) {
        if (open.has(id)) continue;
        this.live.delete(id);
        live.store.dispose();
        live.view.element.remove?.();
      }
    });
  }

  private disposed = false;

  protected groupOf(root: DockNode, tabId: string): string {
    const found = dock.findTab(root, tabId);
    if (!found) throw new Error(`No tab ${tabId}`);
    return found.group.id;
  }

  protected newGroup(tab: TabRef): GroupNode {
    return { kind: "group", id: this.newId("g"), tabs: [tab], activeTabId: tab.id };
  }

  protected newId(prefix: "g" | "t"): string {
    const used = new Set([
      ...dock.allGroups(this.root.peek()).map((g) => g.id),
      ...this.tabs().map((t) => t.id),
    ]);
    let id: string;
    do id = `${prefix}${++this.counter}`;
    while (used.has(id));
    return id;
  }

  /** Size for a new split (docs/dock.md §4): 25% bottom, 30% right for terminal/agent, else 50%. */
  protected fractionFor(viewType: string, side: Side): number {
    if (viewType !== "terminal" && viewType !== "agent") return 0.5;
    return side === "bottom" ? 0.25 : side === "right" ? 0.3 : 0.5;
  }

  dispose(): void {
    this.disposed = true;
    this.closeAllLive();
    this.store.dispose();
  }
}

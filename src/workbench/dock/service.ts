// DockService: every operation on the dock tree (open, move, split, close, focus, maximize,
// hide/restore, reset, persist). All public operations are wrapped as `layout.*` commands by the
// workbench extension, so UI, keybindings and agents share one path. State and queries: model.ts.

import type {
  DockNode,
  GroupNode,
  Json,
  Placement,
  TabRef,
  TabTarget,
} from "../../core/dock/index";
import * as dock from "../../core/dock/index";
import { batch } from "../../core/reactive/index";
import { DockModel, type OpenPlacement, type Region, STATE_VERSION } from "./model";

export type { OpenPlacement, Region, TabOptions } from "./model";

/** The bottom panel's share of the height when it opens (D189: a quarter, was 30%). */
export const BOTTOM_SHARE = 0.25;

export class DockService extends DockModel {
  /** Hides a showing region, or restores it at its previous size. False if the region is empty. */
  toggleRegion(region: Region): boolean {
    const groups = this.regionGroups(region);
    if (groups.length === 0) return false;
    const showing = groups.some((g) => !g.hidden);
    this.setGroupsHidden(
      groups.map((g) => g.id),
      showing,
    );
    if (!showing) {
      const first = groups[0];
      if (first) this.focusGroup(first.id);
    }
    return true;
  }

  // ---- Opening and moving -------------------------------------------------------------

  /** Opens a view (reusing an open singleton). Returns the tab id. */
  openView(
    viewType: string,
    state: Json = null,
    placement?: OpenPlacement,
    focus = true,
    /** `background`: added behind its group's active tab, not shown or focused (D269). */
    options: { preview?: boolean; background?: boolean } = {},
  ): string {
    const descriptor = this.views.get(viewType);
    if (!descriptor)
      throw new Error(`Unknown view type "${viewType}". Known: ${this.views.types().join(", ")}`);
    if (descriptor.singleton) {
      const existing = this.tabs(viewType)[0];
      if (existing) {
        if (!options.background) this.activateTab(existing.id, focus);
        return existing.id;
      }
    }
    const activate = !options.background;
    const tab: TabRef = {
      id: this.newId("t"),
      viewType,
      viewState: state,
      ...(options.preview ? { preview: true as const } : {}),
    };
    let target = placement ?? descriptor.defaultPlacement ?? "main";
    let root = this.root.peek();
    // A group fills the dock (maximized): what opens without a place of its own, or in the
    // editor area (a file from the explorer, D398), goes in it, so it shows rather than opening
    // out of sight (D233); what names another place (the bottom panel) goes there, and bringing
    // it forward restores the layout (activateTab).
    const maximized = this.maximizedGroupId();
    if (maximized && (placement === undefined || placement === "main"))
      target = { groupId: maximized };
    const noEditorArea =
      target === "main" &&
      descriptor.editorLike === true &&
      !dock.allTabs(root).some(this.isEditorLike);
    if (noEditorArea && dock.hasShownTab(root)) {
      // Welcome was closed beside a chat or the terminal (D368): the file gets an editor area of
      // its own on the left, not a tab in their group.
      root = dock.splitRoot(root, "left", this.newGroup(tab), 0.6);
    } else if (typeof target === "string") {
      const group = dock.resolvePlacement(root, target, this.isEditorLike);
      if (group) root = dock.addTab(root, group.id, tab, undefined, activate);
      else root = this.createRegion(root, target, tab);
    } else if ("root" in target) {
      root = dock.splitRoot(
        root,
        target.root,
        this.newGroup(tab),
        this.fractionFor(viewType, target.root),
      );
    } else if ("split" in target) {
      root = dock.splitGroup(
        root,
        target.groupId,
        target.split,
        this.newGroup(tab),
        this.fractionFor(viewType, target.split),
      );
    } else {
      root = dock.addTab(root, target.groupId, tab, target.index, activate);
    }
    // A new preview replaces the group's previous preview tab (VS Code behavior).
    const groupId = this.groupOf(root, tab.id);
    const kind = (type: string) => this.views.get(type)?.previewKind ?? "";
    const stale = options.preview
      ? dock
          .findGroup(root, groupId)
          ?.tabs.filter(
            (t) =>
              t.preview &&
              t.id !== tab.id &&
              !this.isDirty(t) &&
              kind(t.viewType) === kind(viewType),
          )
      : [];
    if (!activate) {
      // Beside what's shown: the group keeps its tab and the focus stays where it is.
      this.set(root);
      return tab.id;
    }
    this.set(dock.setHidden(root, [groupId], false));
    this.activateTab(tab.id, focus);
    for (const old of stale ?? []) void this.closeTab(old.id, true);
    this.applyTabLimit(tab.id);
    return tab.id;
  }

  /**
   * Closes the least recently used editor tabs past workbench.editor.limit (D279), never
   * `keep` (the tab just opened), pinned tabs or tabs with unsaved changes.
   */
  applyTabLimit(keep: string | null = null): void {
    const { limit } = this.tabOptions.peek();
    if (!limit.enabled) return;
    const tabs = dock
      .allGroups(this.root.peek())
      .flatMap((g) =>
        g.tabs
          .filter((t) => this.isEditorLike(t) && t.viewType !== "welcome")
          .map((t) => ({ id: t.id, groupId: g.id, pinned: !!t.pinned, dirty: this.isDirty(t) })),
      );
    for (const id of dock.tabsOverLimit(tabs, this.mru, limit, keep)) void this.closeTab(id, true);
  }

  /** Pins a tab (VS Code's sticky tabs: kept first in its group) or unpins it (D279). */
  setTabPinned(tabId: string, pinned: boolean): void {
    if (!this.findTab(tabId)) throw new Error(`No tab ${tabId}`);
    this.set(dock.setTabPinned(this.root.peek(), tabId, pinned));
    this.decorations.value = this.decorations.peek() + 1;
  }

  /**
   * Shows another view in a tab's place (D237: the one channel tab and the one thread tab switch
   * what they show): the new tab opens where the old one is, and the old one closes. Returns the
   * new tab's id, or null when `tabId` isn't open.
   */
  replaceTab(
    tabId: string,
    viewType: string,
    state: Json,
    focus = true,
    options: { preview?: boolean } = {},
  ): string | null {
    const found = this.findTab(tabId);
    if (!found) return null;
    const id = this.openView(
      viewType,
      state,
      { groupId: found.group.id, index: found.index + 1 },
      focus,
      options,
    );
    void this.closeTab(tabId, true);
    return id;
  }

  /** Turns a preview tab into a normal one (double-click, edit, or `layout.pinTab`). */
  pinTab(tabId: string): void {
    const found = this.findTab(tabId);
    const tab = found?.group.tabs[found.index];
    if (!tab?.preview) return;
    const root = structuredClone(this.root.peek());
    const copy = dock.findTab(root, tabId);
    const ref = copy?.group.tabs[copy.index];
    if (ref) delete ref.preview;
    this.set(root);
    this.decorations.value = this.decorations.peek() + 1;
  }

  /** Same operation as drag and drop. */
  moveTab(tabId: string, to: TabTarget): void {
    const found = this.findTab(tabId);
    if (!found) throw new Error(`No tab ${tabId}`);
    const side = "split" in to ? to.split : "root" in to ? to.root : undefined;
    const fraction = side
      ? this.fractionFor(found.group.tabs[found.index]?.viewType ?? "", side)
      : 0.5;
    const next = dock.moveTab(this.root.peek(), tabId, to, this.newId("g"), fraction);
    this.set(next);
    this.activateTab(tabId, true);
  }

  /** Moves a whole group (dragging it by its tab strip); see dock.moveGroup. */
  moveGroup(groupId: string, to: TabTarget): void {
    const group = this.findGroup(groupId);
    if (!group) throw new Error(`No group ${groupId}`);
    const active = group.tabs.find((t) => t.id === group.activeTabId) ?? group.tabs[0];
    // Next to a group: half of it; at a dock edge: the view type's usual share.
    const fraction = "root" in to ? this.fractionFor(active?.viewType ?? "", to.root) : 0.5;
    this.set(dock.moveGroup(this.root.peek(), groupId, to, fraction));
    if (active) this.activateTab(active.id, true);
  }

  activateTab(tabId: string, focus = true): void {
    let root = dock.setActiveTab(this.root.peek(), tabId);
    const groupId = this.groupOf(root, tabId);
    // A tab brought forward behind a maximized group: the layout comes back so it can be seen
    // (D233). Background activations (focus false) leave it.
    const maximized = dock.allGroups(root).find((g) => g.maximized);
    if (focus && maximized && maximized.id !== groupId) root = dock.setMaximized(root, null);
    // A tab brought forward in a hidden region (the chat panel toggled off): the region shows,
    // as VS Code reveals a hidden panel for what's opened in it. Background activations leave it.
    if (focus && groupId && dock.findGroup(root, groupId)?.hidden) {
      // Its region's groups all come back (two chats side by side, not just the one).
      const region = (["right", "bottom"] as const).find((r) =>
        dock.regionGroups(root, r, this.isEditorLike).some((g) => g.id === groupId),
      );
      const ids = region
        ? dock.regionGroups(root, region, this.isEditorLike).map((g) => g.id)
        : [groupId];
      root = dock.setHidden(root, ids, false);
    }
    batch(() => {
      this.set(root);
      this.focusedGroupId.value = groupId;
    });
    this.mru = [tabId, ...this.mru.filter((id) => id !== tabId)];
    if (focus) this.focusRequested.fire(tabId);
  }

  focusGroup(groupId: string, focusView = true): void {
    const group = dock.findGroup(this.root.peek(), groupId);
    if (!group) throw new Error(`No group ${groupId}`);
    if (group.activeTabId) this.activateTab(group.activeTabId, focusView);
    else this.focusedGroupId.value = groupId;
  }

  // ---- Closing -------------------------------------------------------------------------------

  /** Closes a tab (asking the view first unless `force`). False if the view refused. */
  async closeTab(tabId: string, force = false): Promise<boolean> {
    const found = this.findTab(tabId);
    if (!found) return true;
    const live = this.live.get(tabId);
    if (!force && live?.view.confirmClose && !(await live.view.confirmClose())) return false;
    const groupId = found.group.id;
    const wasFocused = this.focusedGroupId.peek() === groupId;
    // Move keyboard focus to the next tab only if it was inside the closed view; closing a
    // background tab (a replaced preview, the welcome tab) must not steal focus (e.g. from the
    // explorer after a single click).
    const active = typeof document === "undefined" ? null : document.activeElement;
    const hadFocus =
      !active ||
      active === document.body ||
      !!active.closest(".dock-strip") ||
      (!!live && live.view.element.contains(active));
    const closedTab = found.group.tabs[found.index];
    if (closedTab && this.isEditorLike(closedTab) && closedTab.viewType !== "welcome") {
      this.closedTabs.push({
        viewType: closedTab.viewType,
        viewState: closedTab.viewState,
        groupId,
      });
      if (this.closedTabs.length > 30) this.closedTabs.shift();
    }
    live?.store.dispose();
    // Groups keep the views they've shown (hidden); a closed one's element goes with it (D237: a
    // replaced thread tab left its view in the page, found by selectors and kept alive).
    live?.view.element.remove?.();
    this.live.delete(tabId);
    this.mru = this.mru.filter((id) => id !== tabId);
    // The last editor-like tab: Welcome takes its place in the same group first (removing the tab
    // would drop the empty group, and the editor area with it).
    const before = this.root.peek();
    const lastEditor =
      this.isEditorLike(found.group.tabs[found.index] as TabRef) &&
      !dock.allTabs(before).some((t) => t.id !== tabId && this.isEditorLike(t)) &&
      // Closing Welcome itself beside another tab (a chat, the terminal): it stays closed (D368).
      !(found.group.tabs[found.index]?.viewType === "welcome" && dock.hasShownTab(before, tabId));
    let root = lastEditor ? this.ensureEditorRegionIn(before, groupId, tabId) : before;
    const wasActive = found.group.activeTabId === tabId;
    root = dock.removeTab(root, tabId);
    // The group shows the tab used most recently, not its neighbor (VS Code's
    // workbench.editor.focusRecentEditorAfterClose, D279).
    const left = dock.findGroup(root, groupId);
    if (wasActive && left && this.tabOptions.peek().focusRecentAfterClose) {
      const recent = this.mru.find((id) => left.tabs.some((t) => t.id === id));
      if (recent) root = dock.setActiveTab(root, recent);
    }
    root = this.ensureEditorRegion(root, groupId);
    this.set(root);
    const stillThere = dock.findGroup(root, groupId);
    if (wasFocused || !dock.findGroup(root, this.focusedGroupId.peek() ?? "")) {
      const next = stillThere ?? dock.mainGroup(root, this.isEditorLike);
      if (next) this.focusGroup(next.id, hadFocus);
    }
    return true;
  }

  /** Reopens the most recently closed editor tab (its group if it's still there). */
  reopenClosedTab(): string | null {
    while (this.closedTabs.length) {
      const last = this.closedTabs.pop();
      if (!last || !this.views.get(last.viewType)) continue;
      const group = dock.findGroup(this.root.peek(), last.groupId);
      return this.openView(last.viewType, last.viewState, group ? { groupId: group.id } : "main");
    }
    return null;
  }

  async closeGroup(groupId: string): Promise<boolean> {
    const group = dock.findGroup(this.root.peek(), groupId);
    if (!group) return true;
    for (const tab of [...group.tabs]) {
      if (!(await this.closeTab(tab.id))) return false;
    }
    return true;
  }

  // ---- Groups ----------------------------------------------------------------------------------

  toggleMaximize(groupId?: string): void {
    const id = groupId ?? this.focusedGroupId.peek();
    if (!id) return;
    const maximized = dock.allGroups(this.root.peek()).find((g) => g.maximized);
    this.set(dock.setMaximized(this.root.peek(), maximized?.id === id ? null : id));
  }

  maximizedGroupId(): string | null {
    // A hidden group's maximize isn't drawn (render.ts): files don't go into it (D407).
    return dock.allGroups(this.root.peek()).find((g) => g.maximized && !g.hidden)?.id ?? null;
  }

  setGroupsHidden(groupIds: readonly string[], hidden: boolean): void {
    let root = dock.setHidden(this.root.peek(), groupIds, hidden);
    // Never hide everything: keep the main region visible.
    if (!dock.isVisible(root)) root = dock.setHidden(root, groupIds, false);
    if (hidden && groupIds.includes(this.focusedGroupId.peek() ?? "")) {
      const main = dock.mainGroup(root, this.isEditorLike);
      this.set(root);
      if (main) this.focusGroup(main.id);
      return;
    }
    this.set(root);
  }

  resizeGroup(groupId: string, fraction: number): void {
    this.set(dock.resizeGroup(this.root.peek(), groupId, fraction));
  }

  setSplitSizes(path: readonly number[], sizes: readonly number[]): void {
    this.set(dock.setSplitSizes(this.root.peek(), path, sizes));
  }

  equalize(path?: readonly number[]): void {
    this.set(dock.equalize(this.root.peek(), path));
  }

  /** Back to the default arrangement, keeping every open tab (editors main, terminals bottom, agent right). */
  reset(): void {
    const tabs = this.tabs();
    const pick = (pred: (t: TabRef) => boolean) => tabs.filter(pred);
    const bottom = pick((t) => !this.isEditorLike(t) && t.viewType !== "agent");
    const right = pick((t) => t.viewType === "agent");
    const main = pick((t) => this.isEditorLike(t));
    this.set(this.arrangement(main, bottom, right));
    this.focusGroup("main");
  }

  /** Replaces everything with the default arrangement holding fresh tabs of the given view types. */
  resetToDefault(main: string[], bottom: string[], right: string[], rightShare = 0.3): void {
    this.closeAllLive();
    const make = (types: string[]) =>
      types
        .filter((t) => this.views.get(t))
        .map((viewType): TabRef => ({ id: this.newId("t"), viewType, viewState: null }));
    this.set(this.arrangement(make(main), make(bottom), make(right), rightShare));
    this.focusGroup(dock.mainGroup(this.root.peek(), this.isEditorLike)?.id ?? "main", false);
  }

  /** The default tree (docs/dock.md §3) holding the given tabs. */
  arrangement(main: TabRef[], bottom: TabRef[], right: TabRef[], rightShare = 0.3): DockNode {
    const group = (id: string, tabs: TabRef[]): GroupNode => ({
      kind: "group",
      id,
      tabs,
      activeTabId: tabs[0]?.id ?? null,
    });
    const column: DockNode = {
      kind: "split",
      direction: "column",
      sizes: [1 - BOTTOM_SHARE, BOTTOM_SHARE],
      children: [group("main", main), group("bottom", bottom)],
    };
    const tree: DockNode = {
      kind: "split",
      direction: "row",
      sizes: [1 - rightShare, rightShare],
      children: [column, group("right", right)],
    };
    return this.ensureEditorRegion(dock.normalize(tree) ?? group("main", []), "main");
  }

  // ---- Persistence -------------------------------------------------------------------------------

  serialize(): Json {
    // One copy, the views' states written into it (D379: a copy per open tab grew with tabs²).
    let root = structuredClone(this.root.peek());
    const transient: string[] = [];
    for (const [tabId, live] of this.live) {
      // Transient tabs (generated read-only text, test views) are not restored.
      if (live.view.persist?.() === false) {
        transient.push(tabId);
        continue;
      }
      const found = dock.findTab(root, tabId);
      const tab = found?.group.tabs[found.index];
      if (tab) tab.viewState = live.view.serialize();
    }
    for (const tabId of transient) root = dock.removeTab(root, tabId);
    root = this.ensureEditorRegion(root);
    return {
      version: STATE_VERSION,
      root: dock.serialize(root),
      focusedGroupId: this.focusedGroupId.peek(),
    };
  }

  /** Replaces the tree from persisted state. Unknown view types are dropped. Returns success. */
  restore(data: unknown): boolean {
    const d = data as { version?: unknown; root?: unknown; focusedGroupId?: unknown } | null;
    if (!d || d.version !== STATE_VERSION) return false;
    let root = dock.deserialize(d.root);
    if (!root) return false;
    for (const tab of dock.allTabs(root))
      if (!this.views.get(tab.viewType)) root = dock.removeTab(root, tab.id);
    this.closeAllLive();
    for (const id of [
      ...dock.allGroups(root).map((g) => g.id),
      ...dock.allTabs(root).map((t) => t.id),
    ]) {
      const n = Number(/^[gt](\d+)$/.exec(id)?.[1] ?? 0);
      this.counter = Math.max(this.counter, n);
    }
    root = this.ensureEditorRegion(root);
    this.set(root);
    const focused =
      typeof d.focusedGroupId === "string" && dock.findGroup(root, d.focusedGroupId)
        ? d.focusedGroupId
        : null;
    const target = focused ?? dock.mainGroup(root, this.isEditorLike)?.id;
    if (target) this.focusGroup(target, false);
    return true;
  }

  /** Creates the region a placement hint names when it doesn't exist yet. */
  private createRegion(root: DockNode, placement: Placement, tab: TabRef): DockNode {
    const main = dock.mainGroup(root, this.isEditorLike);
    if (placement === "right") return dock.splitRoot(root, "right", this.newGroup(tab), 0.3);
    if (placement === "bottom" && main)
      return dock.splitGroup(root, main.id, "bottom", this.newGroup(tab), BOTTOM_SHARE);
    if (main) return dock.addTab(root, main.id, tab);
    return { kind: "group", id: "main", tabs: [tab], activeTabId: tab.id };
  }
}

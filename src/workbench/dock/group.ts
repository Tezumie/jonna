// One dock group: tab strip (DESIGN.md §12.3) + body. The body holds the live view elements of
// the group's tabs; only the active one is shown. View elements are appended (moved), never
// recreated, so Monaco and terminals keep their state when a tab changes group.

import type { ContextKeyService } from "../../core/context/index";
import type { GroupNode, TabRef } from "../../core/dock/index";
import { delegate, h, on } from "../../core/dom/index";
import { type Disposable, DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { icon, imageIcon } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import { scrollMemory } from "../scrollMemory";
import type { FileDecorationService } from "../services";
import { showGroupMenu } from "./groupMenu";
import type { NewTabTool } from "./newTab";
import type { DockService } from "./service";
import { showTabMenu } from "./tabMenu";
import type { DockView } from "./views";

/** The group body each view was last shown in (a move to another group resets scrolling). */
const lastBody = new WeakMap<DockView, HTMLElement>();

export interface GroupDeps {
  dock: DockService;
  /** Go back / forward buttons at the strip's start (`navigationControlLocation`, D279). */
  context?: ContextKeyService;
  /** Git (and later problem) colors and badges for tabs showing files. */
  decorations?: FileDecorationService;
  run(command: string, input?: unknown): void;
  label(command: string): string | undefined;
  /** Extensions' tools, listed under New tab after the IDE's own (D181). */
  tools?(): readonly NewTabTool[];
  /** Pointer went down on a tab (drag may start). */
  onTabPointerDown(tabId: string, event: PointerEvent, tabElement: HTMLElement): void;
  /** Pointer went down on the strip's empty area (dragging moves the whole group). */
  onGroupPointerDown(groupId: string, event: PointerEvent, groupElement: HTMLElement): void;
}

/** Two presses on a tab this close in time (and place, in px) are a double-click. */
const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_SLOP = 6;
/**
 * The last press on a tab and the last double-click handled. Kept outside the group's element:
 * a press can redraw the dock, and the second press may land on a new one.
 */
let lastTabPress: { tabId: string; at: number; x: number; y: number } | undefined;
let doubleHandledAt = 0;

export class GroupElement implements Disposable {
  readonly element: HTMLElement;
  readonly strip: HTMLElement;
  readonly tabsHost: HTMLElement;
  readonly body: HTMLElement;
  private readonly store = new DisposableStore();
  private shown: DockView | undefined;
  private readonly split: HTMLElement;
  /** The active tab's own toolbar actions (TabAction). */
  private readonly viewActions: HTMLElement;
  private actionsKey = "";
  private node: GroupNode;
  private frame = 0;
  private readonly maximize: HTMLElement;
  private shownMaximized = false;
  /** Go back / Go forward, shown when workbench.navigationControl.location is "tabBar". */
  private readonly nav: HTMLElement;

  constructor(
    node: GroupNode,
    private readonly deps: GroupDeps,
  ) {
    this.node = node;
    this.tabsHost = h("div", { class: "dock-tabs", role: "tablist" });
    const split = this.actionButton("columns-2", "Split right", "layout.splitActive", {
      direction: "right",
    });
    const maximize = this.actionButton("maximize-2", "Maximize group", "layout.toggleMaximize");
    const overflow = h(
      "button",
      { class: "icon-button dock-strip-menu", type: "button", "aria-label": "Group actions" },
      icon("ellipsis"),
    );
    setTooltip(overflow, "Group actions");
    this.store.add(
      on(overflow, "click", () => this.store.add(showGroupMenu(deps, this.node, overflow))),
    );
    this.split = split;
    this.maximize = maximize;
    this.viewActions = h("div", { class: "dock-view-actions" });
    this.nav = this.navButtons();
    this.strip = h(
      "div",
      { class: "dock-strip" },
      this.nav,
      this.tabsHost,
      h("div", { class: "dock-strip-actions" }, this.viewActions, overflow, split, maximize),
    );
    this.body = h("div", { class: "dock-body", role: "tabpanel" });
    this.element = h(
      "section",
      { class: "dock-group", "data-group-id": node.id },
      this.strip,
      this.body,
    );

    this.store.add(
      on(
        this.element,
        "pointerdown",
        (e) => {
          // A tab press focuses its own tab (layout.focusTab); focusing the group first would
          // race it and re-activate the group's previous tab, swallowing the first click.
          if ((e.target as Element).closest(".dock-tab")) return;
          this.focusIfNeeded(false);
        },
        { capture: true },
      ),
    );
    this.store.add(on(this.element, "focusin", () => this.focusIfNeeded(false)));
    this.store.add(
      delegate(this.tabsHost, "pointerdown", ".dock-tab", (e, el) => {
        const tabId = el.dataset.tabId;
        if (!tabId) return;
        if ((e.target as Element).closest(".dock-tab-close, .dock-tab-unpin")) {
          // No focus change: focusing the button focused its group, which re-rendered the strip
          // under the pointer, so the click never landed and a tab in an inactive group didn't
          // close (D119).
          e.preventDefault();
          return;
        }
        if (e.button === 1) {
          e.preventDefault();
          deps.run("layout.closeTab", { tabId });
          return;
        }
        if (e.button !== 0) return;
        // No native text selection or focus change: the dock focuses the view itself.
        e.preventDefault();
        deps.run("layout.focusTab", { tabId });
        deps.onTabPointerDown(tabId, e, el);
      }),
    );
    // Mouse wheel scrolls the strip (or the row under the pointer) sideways; overflow shows the
    // "⋯" menu and a thin scrollbar. Tabs on the side scroll the usual way.
    this.store.add(
      on(
        this.tabsHost,
        "wheel",
        (e) => {
          if (this.vertical) return;
          const row = (e.target as Element).closest<HTMLElement>(".dock-tabs-row") ?? this.tabsHost;
          if (row.scrollWidth <= row.clientWidth || e.deltaX !== 0) return;
          e.preventDefault();
          row.scrollLeft += e.deltaY;
        },
        { passive: false },
      ),
    );
    const overflowObserver = new ResizeObserver(() => this.syncOverflow());
    overflowObserver.observe(this.tabsHost);
    this.store.add(toDisposable(() => overflowObserver.disconnect()));
    this.store.add(
      delegate(this.tabsHost, "contextmenu", ".dock-tab", (e, el) => {
        e.preventDefault();
        const tab = this.node.tabs.find((t) => t.id === el.dataset.tabId);
        if (!tab) return;
        // The menu acts on this tab without switching to it (like VS Code).
        showTabMenu(deps, tab, this.node.tabs, e.clientX, e.clientY);
      }),
    );
    // The strip's empty area: right-click opens the group menu; dragging moves the whole group.
    const isStripBackground = (e: Event) =>
      !(e.target as Element).closest(".dock-tab, button, input, .dock-view-actions");
    this.store.add(
      on(this.strip, "contextmenu", (e) => {
        if (!isStripBackground(e)) return;
        e.preventDefault();
        this.store.add(showGroupMenu(deps, this.node, { x: e.clientX, y: e.clientY }));
      }),
    );
    this.store.add(
      on(this.strip, "pointerdown", (e) => {
        if (e.button !== 0 || !isStripBackground(e)) return;
        e.preventDefault();
        deps.onGroupPointerDown(this.node.id, e, this.element);
      }),
    );
    // A double-click keeps a preview tab (or renames a terminal). The first press usually redraws
    // the strip (the tab is focused), which replaces the tab's element, and the browser sends no
    // dblclick to a replaced element. So two presses on the same tab, close in time and place,
    // count as one here (the press is cancelled above, so no mousedown carries a click count).
    const tabDoubleClicked = (tabId: string | undefined) => {
      if (!tabId || performance.now() - doubleHandledAt < DOUBLE_CLICK_MS) return;
      doubleHandledAt = performance.now();
      deps.run("layout.pinTab", { tabId, doubleClick: true });
    };
    this.store.add(
      delegate(this.tabsHost, "pointerdown", ".dock-tab", (e, el) => {
        const tabId = el.dataset.tabId;
        if (e.button !== 0 || !tabId) return;
        if ((e.target as Element).closest(".dock-tab-close, .dock-tab-unpin")) return;
        const last = lastTabPress;
        const now = performance.now();
        const again =
          last?.tabId === tabId &&
          now - last.at < DOUBLE_CLICK_MS &&
          Math.abs(e.clientX - last.x) <= DOUBLE_CLICK_SLOP &&
          Math.abs(e.clientY - last.y) <= DOUBLE_CLICK_SLOP;
        // A third press starts over.
        lastTabPress = again ? undefined : { tabId, at: now, x: e.clientX, y: e.clientY };
        if (again) tabDoubleClicked(tabId);
      }),
    );
    this.store.add(
      delegate(this.tabsHost, "dblclick", ".dock-tab", (_e, el) =>
        tabDoubleClicked(el.dataset.tabId),
      ),
    );
    this.store.add(
      delegate(this.tabsHost, "click", ".dock-tab-close:not(.dock-tab-unpin)", (_e, el) => {
        const tabId = el.closest<HTMLElement>(".dock-tab")?.dataset.tabId;
        if (tabId) deps.run("layout.closeTab", { tabId });
      }),
    );
    // A pinned tab's pin is its button: a click unpins it (VS Code).
    this.store.add(
      delegate(this.tabsHost, "click", ".dock-tab-unpin", (_e, el) => {
        const tabId = el.closest<HTMLElement>(".dock-tab")?.dataset.tabId;
        if (tabId) deps.run("layout.unpinEditor", { tabId });
      }),
    );
    this.store.add(
      on(this.strip, "dblclick", (e) => {
        if ((e.target as Element).closest(".dock-tab, button")) return;
        deps.run("layout.toggleMaximize", { groupId: this.node.id });
      }),
    );
    const observer = new ResizeObserver(() => this.scheduleResize());
    observer.observe(this.body);
    this.store.add(toDisposable(() => observer.disconnect()));
    this.store.add(toDisposable(() => cancelAnimationFrame(this.frame)));
  }

  get id(): string {
    return this.node.id;
  }

  /**
   * Tabs in a column on the group's side (workbench.editor.tabPlacement left / right): editor
   * groups only; panels (the terminal, the agent) keep theirs on top.
   */
  get vertical(): boolean {
    return this.side !== undefined;
  }

  private side: "left" | "right" | undefined;

  private navButtons(): HTMLElement {
    const button = (name: "arrow-left" | "arrow-right", label: string, command: string) => {
      const b = h(
        "button",
        { class: "icon-button dock-nav-button", type: "button", "aria-label": label },
        icon(name),
      );
      setTooltip(b, label, command);
      this.store.add(on(b, "click", () => this.deps.run(command)));
      return b;
    };
    const back = button("arrow-left", "Go back", "workbench.navigateBack");
    const forward = button("arrow-right", "Go forward", "workbench.navigateForward");
    const nav = h("div", { class: "dock-nav" }, back, forward);
    const { context } = this.deps;
    const sync = () => {
      nav.hidden = context?.get("navigationControlLocation") !== "tabBar";
      back.toggleAttribute("disabled", context?.get("canNavigateBack") !== true);
      forward.toggleAttribute("disabled", context?.get("canNavigateForward") !== true);
    };
    sync();
    if (context)
      this.store.add(
        context.onDidChange((keys) => {
          if (
            keys.some(
              (k) =>
                k === "canNavigateBack" ||
                k === "canNavigateForward" ||
                k === "navigationControlLocation",
            )
          )
            sync();
        }),
      );
    return nav;
  }

  /** Re-renders the strip and shows the active tab's view. */
  update(node: GroupNode, focused: boolean, maximized: boolean): void {
    this.node = node;
    this.element.classList.toggle("is-focused", focused);
    this.element.classList.toggle("is-maximized", maximized);
    // Maximized: the button restores (inward arrows).
    if (maximized !== this.shownMaximized) {
      this.shownMaximized = maximized;
      this.maximize.replaceChildren(icon(maximized ? "minimize-2" : "maximize-2"));
      const label = maximized ? "Restore group" : "Maximize group";
      this.maximize.setAttribute("aria-label", label);
      setTooltip(this.maximize, label, "layout.toggleMaximize");
    }
    this.renderTabs(node);
    const active = node.tabs.find((t) => t.id === node.activeTabId);
    const detached = !!active && this.deps.dock.detached.peek().has(active.id);
    const view = active ? this.deps.dock.view(active) : undefined;
    // A tab shown in its own window: its view stays there; the group shows a placeholder.
    if (view && !detached && view.element.parentElement !== this.body) {
      const moved = view.element.ownerDocument !== this.body.ownerDocument;
      this.body.appendChild(view.element);
      if (moved) view.onWindowChanged?.(window);
      this.scheduleResize();
    }
    const placeholder = detached && active ? this.detachedNote(active) : null;
    if (placeholder && placeholder.parentElement !== this.body) this.body.append(placeholder);
    // Hide every other view living in this body (kept alive, never disposed here).
    for (const child of Array.from(this.body.children)) {
      if (child instanceof HTMLElement)
        child.hidden = placeholder ? child !== placeholder : child !== view?.element;
    }
    const moved = !!view && !detached && lastBody.get(view) !== this.body;
    if (view && !detached) lastBody.set(view, this.body);
    // In its own window now: back here later counts as a move.
    else if (view) lastBody.delete(view);
    const reshown = !!view && view !== this.shown;
    if (view !== this.shown) {
      this.shown?.onHide?.();
      this.shown = view;
      view?.onShow?.();
      this.scheduleResize();
    }
    // Shown here for the first time, moved in from another group, or back in front of its
    // group's other tabs (hidden, Chromium dropped its offsets; D370): offsets back (D190).
    if (view && !detached && (moved || reshown)) scrollMemory.restore(view.element);
    this.renderActions(active);
  }

  /**
   * The active tab's actions, and split only where it does something: a tab that can be
   * duplicated, or one that can move out of a group with other tabs.
   */
  /** After the dock's tree was rebuilt (a split): re-parenting dropped the offsets (D370). */
  restoreScroll(): void {
    if (this.shown && this.shown.element.parentElement === this.body)
      scrollMemory.restore(this.shown.element);
  }

  private renderActions(active: TabRef | undefined): void {
    const dock = this.deps.dock;
    const descriptor = active ? dock.descriptor(active) : undefined;
    const view = active ? dock.view(active) : undefined;
    const state = view?.serialize() ?? active?.viewState ?? null;
    const actions = active
      ? [...(descriptor?.actions?.(state) ?? []), ...(view?.actions?.() ?? [])]
      : [];
    const canDuplicate = !!active && (descriptor?.duplicate?.(state) ?? null) !== null;
    this.split.hidden = !active || (!canDuplicate && this.node.tabs.length < 2);
    const key = JSON.stringify(actions);
    if (key === this.actionsKey) return;
    this.actionsKey = key;
    this.viewActions.replaceChildren(
      ...actions.map((a) => {
        const b = h(
          "button",
          {
            class: a.dropdown ? "icon-button dock-action-dropdown" : "icon-button",
            type: "button",
            "aria-label": a.title,
            ...(a.dropdown && { "aria-haspopup": "menu" }),
          },
          a.iconImage ? imageIcon(a.iconImage) : icon(a.icon),
        );
        setTooltip(b, a.title, a.command);
        // "$tab" in an action's input stands for the tab it belongs to (swap-in-place actions).
        const tabId = active?.id;
        const input = Object.fromEntries(
          Object.entries((a.input ?? {}) as Record<string, unknown>).map(([k, v]) => [
            k,
            v === "$tab" ? tabId : v,
          ]),
        );
        b.addEventListener("click", () => {
          if (!a.dropdown) return this.deps.run(a.command, input);
          const r = b.getBoundingClientRect();
          this.deps.run(a.command, { ...input, x: Math.round(r.left), y: Math.round(r.bottom) });
        });
        return b;
      }),
    );
  }

  private note: HTMLElement | null = null;

  /** "Shown in its own window" with Show window / Bring back (D101). */
  private detachedNote(tab: TabRef): HTMLElement {
    if (!this.note) {
      const show = h("button", { class: "button button-secondary", type: "button" }, "Show window");
      const back = h("button", { class: "button button-primary", type: "button" }, "Bring back");
      show.addEventListener("click", () =>
        this.deps.run("layout.focusWindow", { tabId: this.note?.dataset.tabId }),
      );
      back.addEventListener("click", () =>
        this.deps.run("layout.returnFromWindow", { tabId: this.note?.dataset.tabId }),
      );
      this.note = h(
        "div",
        { class: "empty-state dock-detached" },
        icon("app-window"),
        h("div", { class: "empty-state-title" }, "Open in its own window"),
        h(
          "div",
          { class: "empty-state-text" },
          "This tab is in a separate window. Commands, agents and DevTools still reach it.",
        ),
        h("div", { class: "empty-state-actions" }, show, back),
      );
      this.store.add(toDisposable(() => this.note?.remove()));
    }
    this.note.dataset.tabId = tab.id;
    return this.note;
  }

  /** Rects used for drop-zone hit testing. */
  tabRects(): { tabId: string; rect: DOMRect }[] {
    return Array.from(this.tabsHost.querySelectorAll<HTMLElement>(".dock-tab")).map((el) => ({
      tabId: el.dataset.tabId ?? "",
      rect: el.getBoundingClientRect(),
    }));
  }

  private renderTabs(node: GroupNode): void {
    const { dock } = this.deps;
    const options = dock.tabOptions.peek();
    // How the strip is laid out (D279): tabs on a side, the close button's side, no close button.
    const side =
      options.placement === "top" || !node.tabs.some((t) => dock.isEditorLike(t))
        ? undefined
        : options.placement;
    this.side = side;
    if (side) this.element.dataset.tabPlacement = side;
    else delete this.element.dataset.tabPlacement;
    this.element.dataset.tabAction = options.actionLocation;
    this.element.classList.toggle("is-close-hidden", !options.closeButton);
    const tabs = node.tabs.map((tab: TabRef) => {
      const isActive = tab.id === node.activeTabId;
      const dirty = dock.isDirty(tab);
      const title = dock.title(tab);
      const descriptor = dock.descriptor(tab);
      // Getting ready (a terminal's shell starting): a spinner in the icon's place.
      const tabIcon = !descriptor
        ? null
        : dock.isBusy(tab)
          ? h("span", { class: "dock-tab-busy", role: "img", "aria-label": "Starting" })
          : (descriptor.iconElement?.(tab.viewState) ?? icon(descriptor.icon(tab.viewState)));
      const tint = descriptor?.tint?.(tab.viewState);
      const resource = descriptor?.resource?.(tab.viewState);
      const found = resource ? this.deps.decorations?.get(resource) : undefined;
      // workbench.editor.decorations.colors / .badges (VS Code's): either can be turned off.
      const deco = found && {
        ...found,
        color: options.decorationColors ? found.color : undefined,
        badge: options.decorationBadges ? found.badge : undefined,
      };
      if (tabIcon && tint) tabIcon.style.color = `var(--file-icon-${tint})`;
      const el = h(
        "div",
        {
          class: {
            "dock-tab": true,
            "is-active": isActive,
            "is-dirty": dirty,
            "is-preview": tab.preview === true,
            "is-pinned": tab.pinned === true,
            "is-struck": deco?.strike === true,
            "is-working": descriptor?.working?.(tab.viewState) === true,
          },
          role: "tab",
          tabindex: isActive ? 0 : -1,
          "aria-selected": String(isActive),
          dataset: { tabId: tab.id, viewType: tab.viewType },
        },
        tabIcon,
        h(
          "span",
          {
            class: "dock-tab-label",
            style: deco?.color ? { color: `var(${deco.color})` } : undefined,
          },
          h("span", { class: "dock-tab-text" }, title),
          // As wide as the title in the active tab's weight: activating a tab never widens it.
          h("span", { class: "dock-tab-sizer", "aria-hidden": "true" }, title),
        ),
        deco?.badge
          ? h(
              "span",
              {
                class: "dock-tab-badge",
                style: deco.color ? { color: `var(${deco.color})` } : undefined,
              },
              deco.badge,
            )
          : null,
        h(
          "button",
          {
            class: tab.pinned ? "dock-tab-close dock-tab-unpin" : "dock-tab-close",
            type: "button",
            tabindex: -1,
            "aria-label": tab.pinned
              ? `Unpin ${title}`
              : dirty
                ? `${title}, unsaved. Close`
                : `Close ${title}`,
          },
          h("span", { class: "dock-tab-dirty", "aria-hidden": "true" }),
          icon(tab.pinned ? "pin" : "x"),
        ),
      );
      const tip = descriptor?.tooltip?.(tab.viewState) ?? title;
      setTooltip(el, deco?.tooltip ? `${tip} · ${deco.tooltip}` : tip);
      return el;
    });
    // Pinned tabs on a row of their own above the others (workbench.editor.pinnedTabsOnSeparateRow),
    // each row scrolling by itself; tabs on the side are one column either way.
    const pinnedCount = node.tabs.filter((t) => t.pinned).length;
    const rows = !side && options.pinnedOnSeparateRow && pinnedCount > 0;
    this.element.classList.toggle("has-pinned-row", rows);
    if (rows)
      this.tabsHost.replaceChildren(
        h("div", { class: "dock-tabs-row is-pinned-row" }, ...tabs.slice(0, pinnedCount)),
        h("div", { class: "dock-tabs-row" }, ...tabs.slice(pinnedCount)),
      );
    else this.tabsHost.replaceChildren(...tabs);
    this.syncOverflow();
    this.revealActiveTab();
  }

  /** Scrolls the strip (only the strip — never its ancestors) so the active tab is visible. */
  private revealActiveTab(): void {
    const active = this.tabsHost.querySelector<HTMLElement>(".dock-tab.is-active");
    if (!active) return;
    // Its row, or the strip: the offset parent (position: relative).
    const host = active.parentElement ?? this.tabsHost;
    if (this.vertical) {
      const top = active.offsetTop;
      if (top < host.scrollTop) host.scrollTop = top;
      else if (top + active.offsetHeight > host.scrollTop + host.clientHeight)
        host.scrollTop = top + active.offsetHeight - host.clientHeight;
      return;
    }
    const left = active.offsetLeft;
    if (left < host.scrollLeft) host.scrollLeft = left;
    else if (left + active.offsetWidth > host.scrollLeft + host.clientWidth)
      host.scrollLeft = left + active.offsetWidth - host.clientWidth;
  }

  private syncOverflow(): void {
    const rows = Array.from(this.tabsHost.querySelectorAll<HTMLElement>(".dock-tabs-row"));
    const over = (el: HTMLElement) =>
      this.vertical ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1;
    this.strip.classList.toggle(
      "is-overflowing",
      (rows.length ? rows : [this.tabsHost]).some(over),
    );
    this.revealActiveTab();
  }

  private actionButton(
    name: "columns-2" | "maximize-2",
    label: string,
    command: string,
    extra: object = {},
  ): HTMLElement {
    const button = h(
      "button",
      { class: "icon-button", type: "button", "aria-label": label },
      icon(name),
    );
    setTooltip(button, label, command);
    this.store.add(
      on(button, "click", () => this.deps.run(command, { groupId: this.node.id, ...extra })),
    );
    return button;
  }

  private focusIfNeeded(focusView = true): void {
    if (this.deps.dock.focusedGroupId.peek() !== this.node.id) {
      this.deps.run("layout.focusGroup", { groupId: this.node.id, focusView });
    }
  }

  private scheduleResize(): void {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.shown?.onResize?.());
  }

  dispose(): void {
    this.store.dispose();
    this.element.remove();
  }
}

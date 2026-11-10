// The workbench shell (DESIGN.md §10): title bar, activity bar, the fixed left sidebar, the dock
// (everything else) and the status bar. Paints synchronously with no IPC so the shell appears
// immediately (PLAN §13). Panels float as cards on `--bg-app` (or sit flush, per setting).

import type { ContextKeyService } from "../core/context/index";
import type { Dispatcher } from "../core/dispatcher/index";
import { h, on } from "../core/dom/index";
import type { Platform } from "../core/keybindings/index";
import { type LayoutModel, SIDEBAR_LIMITS } from "../core/layout/index";
import { type Disposable, DisposableStore, toDisposable } from "../core/lifecycle/index";
import { effect, type ReadonlySignal } from "../core/reactive/index";
import { type IconName, icon, imageIcon } from "../ui/Icon";
import { type MenuItem, showContextMenu } from "../ui/Menu";
import { Sash } from "../ui/Sash";
import { setTooltip } from "../ui/Tooltip";
import { badgeText, dropIndex, orderViews } from "./activityOrder";
import { DockDragController } from "./dock/dnd";
import { IframeLayer } from "./dock/iframeLayer";
import { keepRightWidth } from "./dock/keepRightWidth";
import { DockRenderer } from "./dock/render";
import type { DockService } from "./dock/service";
import type { KeyboardService } from "./keyboard";
import type { FileDecorationService } from "./services";
import { StatusBar } from "./statusbar";
import { TitleBar, type TitleBarDeps } from "./titlebar";
import { ViewContainer, type ViewRegistry } from "./views";

/** Pointer travel (px) before pressing an activity bar icon becomes a drag (editor tabs' too). */
const ACTIVITY_DRAG_THRESHOLD = 4;

/** A view's activity bar icon: its own image (D260), else its icon. */
function activityIcon(view: { icon: IconName; iconImage?(): string | null }): Element {
  const url = view.iconImage?.();
  return url ? imageIcon(url) : icon(view.icon);
}

import type { NewTabTool } from "./dock/newTab";

export interface WorkbenchDeps {
  platform: Platform;
  dispatcher: Dispatcher;
  context: ContextKeyService;
  layout: LayoutModel;
  views: ViewRegistry;
  keyboard: KeyboardService;
  dock: DockService;
  title: ReadonlySignal<string>;
  workspaceName: ReadonlySignal<string | null>;
  regions: TitleBarDeps["regions"];
  decorations: FileDecorationService;
  /** Extensions' tools for New tab (D181). */
  tools?(): readonly NewTabTool[];
}

export class Workbench implements Disposable {
  private readonly store = new DisposableStore();
  readonly root: HTMLElement;
  readonly sidebar: HTMLElement;
  readonly statusBar: StatusBar;
  readonly titleBar: TitleBar;
  readonly dockRenderer: DockRenderer;
  readonly drag: DockDragController;
  readonly iframes: IframeLayer;

  constructor(
    host: HTMLElement,
    private readonly deps: WorkbenchDeps,
  ) {
    const { layout } = deps;
    const run = (command: string, input: unknown = {}) =>
      void deps.dispatcher.execute(command, input).catch(() => {});
    const runForResult = (command: string, input: unknown = {}) =>
      deps.dispatcher.execute(command, input);
    this.root = h("div", { class: "workbench", "data-platform": deps.platform });
    host.appendChild(this.root);
    this.store.add(toDisposable(() => this.root.remove()));

    this.titleBar = this.store.add(new TitleBar(this.root, { ...deps, run }));

    const activityBar = h("nav", {
      class: "activitybar",
      "aria-label": "Views",
      "data-part": "activitybar",
    });
    this.sidebar = h("aside", {
      class: "panel sidebar",
      "data-part": "sidebar",
      "aria-label": "Primary side bar",
    });
    const dockHost = h("div", { class: "dock-host", "data-part": "dock" });
    const main = h("div", { class: "workbench-main" }, activityBar, this.sidebar);
    this.root.appendChild(main);
    const sidebarSash = this.sidebarSash(main);
    main.appendChild(dockHost);
    // The agent's column keeps its pixel width when the window or sidebar changes (D164).
    this.store.add(keepRightWidth(dockHost, deps.dock));

    // A movable view's header drags onto the dock (D233); the controller exists by then.
    this.store.add(
      new ViewContainer(this.sidebar, deps.views, deps.dispatcher, (id, down, source) =>
        this.drag.arm({ kind: "view", viewId: id }, down, source, deps.views.get(id)?.title ?? id),
      ),
    );

    // Overlays for drag and drop (preview rectangle, caret) and the iframe layer sit above the dock.
    const dndOverlay = h("div", { class: "dock-overlay" });
    document.body.appendChild(dndOverlay);
    this.store.add(toDisposable(() => dndOverlay.remove()));
    this.iframes = this.store.add(new IframeLayer(this.root));
    // Any layout change (a tab moved, a region shown, a group maximized) may move a page.
    const iframes = this.iframes;
    this.store.add(
      effect(() => {
        deps.dock.root.value;
        deps.dock.focusedGroupId.value;
        iframes.wake();
        return undefined;
      }),
    );

    let drag: DockDragController | undefined;
    this.dockRenderer = this.store.add(
      new DockRenderer(dockHost, deps.dock, {
        run,
        context: deps.context,
        decorations: deps.decorations,
        label: (command) => deps.keyboard.labelFor(command),
        ...(deps.tools && { tools: deps.tools }),
        onTabPointerDown: (tabId, event, el) => {
          const found = deps.dock.findTab(tabId);
          const ref = found?.group.tabs[found.index];
          // A group's only tab is the whole group: drag it as the group (the lifted window).
          const groupEl = found && this.dockRenderer?.group(found.group.id)?.element;
          if (found && found.group.tabs.length === 1 && groupEl) {
            drag?.arm({ kind: "group", groupId: found.group.id }, event, groupEl, "");
            return;
          }
          if (ref)
            drag?.arm(
              { kind: "tab", tabId, viewType: ref.viewType },
              event,
              el,
              deps.dock.title(ref),
            );
        },
        onGroupPointerDown: (groupId, event, el) =>
          drag?.arm({ kind: "group", groupId }, event, el, ""),
      }),
    );
    drag = this.store.add(
      new DockDragController({
        renderer: this.dockRenderer,
        overlay: dndOverlay,
        run,
        runForResult,
      }),
    );
    this.drag = drag;

    this.statusBar = this.store.add(new StatusBar(this.root, deps.dispatcher));

    this.store.add(
      effect(() => {
        this.root.style.setProperty("--sidebar-width", `${layout.sidebarSize.value}px`);
        const visible = layout.sidebarVisible.value;
        // Sidebar on the right: the same elements, reversed by CSS order (no re-creation).
        this.root.dataset.sidebar = layout.sidebarSide.value;
        this.sidebar.hidden = !visible;
        sidebarSash.element.hidden = !visible && !this.sashDragging;
        deps.context.set("sidebarVisible", visible);
        return undefined;
      }),
    );

    this.renderActivityBar(activityBar);
    this.trackFocus();
  }

  private run(command: string, input: unknown = {}): void {
    void this.deps.dispatcher.execute(command, input).catch(() => {});
  }

  /** Shows the sidebar with `viewId` active. */
  showSidebarView(viewId: string, focus = true): boolean {
    const { views } = this.deps;
    // A view moved into the dock (D233): its tab.
    if (views.inDock.peek().has(viewId)) return views.dockHost?.reveal(viewId, focus) ?? false;
    // A view docked as a section (hidden from the activity bar): its home view, expanded.
    const home = views.sectionHost(viewId);
    if (home) {
      views.setSection(viewId, { collapsed: false });
      views.activate(home);
      this.deps.layout.sidebarVisible.value = true;
      if (focus) requestAnimationFrame(() => views.focus(viewId));
      return true;
    }
    const view = views.activate(viewId);
    if (!view) return false;
    this.deps.layout.sidebarVisible.value = true;
    if (focus) requestAnimationFrame(() => this.deps.views.focus(viewId));
    return true;
  }

  /** The dock's rendered size in px. */
  dockSize(): { width: number; height: number } {
    const r = this.dockRenderer.element.getBoundingClientRect();
    return { width: Math.round(r.width), height: Math.round(r.height) };
  }

  sidebarHasFocus(): boolean {
    return this.sidebar.contains(document.activeElement);
  }

  /** The sidebar's splitter is being dragged (it stays while a drag collapses the sidebar). */
  private sashDragging = false;

  private sidebarSash(host: HTMLElement): Sash {
    const { layout } = this.deps;
    let startSize = 0;
    let startVisible = true;
    const sash: Sash = this.store.add(
      new Sash(host, {
        orientation: "vertical",
        onStart: () => {
          startSize = layout.sidebarSize.peek();
          startVisible = layout.sidebarVisible.peek();
          this.sashDragging = true;
        },
        // Live preview while dragging; the final width goes through the command (audited).
        // On the right, dragging left makes it wider. Like VS Code, dragging well past the
        // minimum width (under half of it) collapses the sidebar; dragging back brings it back.
        onDrag: (delta) => {
          const size = startSize + (layout.sidebarSide.peek() === "right" ? -delta : delta);
          if (size < SIDEBAR_LIMITS.min / 2) {
            if (layout.sidebarVisible.peek()) layout.sidebarVisible.value = false;
            return;
          }
          if (!layout.sidebarVisible.peek()) layout.sidebarVisible.value = true;
          layout.resizeSidebar(size);
        },
        onEnd: () => {
          this.sashDragging = false;
          const visible = layout.sidebarVisible.peek();
          sash.element.hidden = !visible;
          if (visible !== startVisible) {
            // Shown or hidden by the drag: recorded as the toggle command.
            layout.sidebarVisible.value = startVisible;
            this.run("layout.toggleSidebar");
          }
          if (visible) this.run("layout.setSidebarWidth", { width: layout.sidebarSize.peek() });
          else layout.resizeSidebar(startSize);
        },
        onReset: () => this.run("layout.setSidebarWidth", { width: SIDEBAR_LIMITS.default }),
      }),
    );
    return sash;
  }

  private renderActivityBar(bar: HTMLElement): void {
    const items = this.store.add(new DisposableStore());
    const top = h("div", { class: "activitybar-top" });
    const settings = h(
      "button",
      {
        class: "activitybar-item activitybar-settings",
        type: "button",
        "aria-label": "Manage",
        "aria-haspopup": "menu",
      },
      icon("settings"),
    );
    setTooltip(settings, "Manage");
    // VS Code's Manage menu (settings, themes, density…; extensions/workbench/manageMenu.ts).
    this.store.add(
      on(
        settings,
        "click",
        () => void this.deps.dispatcher.execute("workbench.showManageMenu", {}).catch(() => {}),
      ),
    );
    // VS Code's Accounts above the gear (extensions/accounts).
    const accounts = h(
      "button",
      {
        class: "activitybar-item activitybar-accounts",
        type: "button",
        "aria-label": "Accounts",
        "aria-haspopup": "menu",
      },
      icon("circle-user-round"),
    );
    setTooltip(accounts, "Accounts");
    this.store.add(
      on(
        accounts,
        "click",
        () => void this.deps.dispatcher.execute("accounts.showMenu", {}).catch(() => {}),
      ),
    );
    // The drop line of an icon drag; it sits on the bar (not in the list, which re-renders).
    const dropLine = h("div", { class: "activitybar-drop-line", hidden: true });
    bar.append(top, h("div", { class: "activitybar-bottom" }, accounts, settings), dropLine);
    // More views than fit: the list scrolls with the tab strip's always-visible thin scrollbar
    // (DESIGN.md §10.5); a hairline marks the pinned Accounts / Settings, and the active view is
    // kept in view.
    const syncOverflow = () => {
      top.classList.toggle("is-overflowing", top.scrollHeight > top.clientHeight + 1);
      if (this.activityDrag) return;
      top
        .querySelector<HTMLElement>(".activitybar-item.is-active")
        ?.scrollIntoView({ block: "nearest" });
    };
    const overflow = new ResizeObserver(syncOverflow);
    overflow.observe(top);
    this.store.add({ dispose: () => overflow.disconnect() });
    this.store.add(
      on(bar, "contextmenu", (e) => {
        e.preventDefault();
        this.activityMenu(e.clientX, e.clientY, null);
      }),
    );
    this.store.add(
      effect(() => {
        items.clear();
        const activeId = this.deps.views.active.value;
        const visible = this.deps.layout.sidebarVisible.value;
        const hidden = this.deps.views.hidden.value;
        const unavailable = this.deps.views.unavailable.value;
        const busy = this.deps.views.busy.value;
        const badges = this.deps.views.badges.value;
        const order = this.deps.views.order.value;
        // A view moved into a dock tab (D233) has its tab instead of an icon.
        const inDock = this.deps.views.inDock.value;
        const buttons = orderViews(this.deps.views.all.value, order)
          .filter(
            (view) =>
              !view.sectionOnly &&
              !inDock.has(view.id) &&
              ((!hidden.has(view.id) && !unavailable.has(view.id)) || view.id === activeId),
          )
          .map((view) => {
            const isActive = visible && view.id === activeId;
            // VS Code's badges: work running in a view you aren't looking at shows a spinning
            // progress badge; otherwise the view's count (unsaved files, changes…), if any.
            const working = busy.has(view.id) && !isActive;
            const badge = badges.get(view.id);
            const mark = working
              ? h("span", { class: "activitybar-badge is-progress" }, icon("refresh-cw"))
              : badge
                ? h(
                    "span",
                    {
                      class: {
                        "activitybar-badge": true,
                        "is-wide": badgeText(badge.count).length > 3,
                      },
                    },
                    badgeText(badge.count),
                  )
                : null;
            const button = h(
              "button",
              {
                class: {
                  "activitybar-item": true,
                  "is-active": isActive,
                  "is-busy": working,
                  "is-drag-source": this.activityDrag === view.id,
                },
                type: "button",
                "data-view-id": view.id,
                "aria-label": working
                  ? `${view.title} (busy)`
                  : badge
                    ? `${view.title} (${badge.tooltip || badge.count})`
                    : view.title,
                "aria-busy": String(busy.has(view.id)),
                "aria-pressed": String(isActive),
              },
              activityIcon(view),
              mark,
            );
            setTooltip(
              button,
              working
                ? `${view.title} · ${busy.get(view.id) || "working"}`
                : badge?.tooltip
                  ? `${view.title} · ${badge.tooltip}`
                  : view.title,
              view.command,
            );
            items.add(
              on(button, "click", (e) => {
                // The click that ends an icon drag isn't a click on the icon (keyboard clicks,
                // detail 0, never follow a drag).
                if (this.activityDragEnded && e.detail > 0) {
                  this.activityDragEnded = false;
                  return;
                }
                void this.deps.dispatcher.execute("view.toggle", { id: view.id }).catch(() => {});
              }),
            );
            items.add(
              on(button, "pointerdown", (e) => {
                if (e.button === 0) this.armActivityDrag(view.id, e, top, dropLine);
              }),
            );
            items.add(
              on(button, "contextmenu", (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.activityMenu(e.clientX, e.clientY, view.id);
              }),
            );
            return button;
          });
        top.replaceChildren(...buttons);
        syncOverflow();
        return undefined;
      }),
    );
  }

  /** The view whose activity bar icon is being dragged (it renders as the drag source). */
  private activityDrag: string | null = null;
  /** An icon drag just dropped: the click that follows its pointerup is swallowed. */
  private activityDragEnded = false;
  private readonly activityDragStore = this.store.add(new DisposableStore());

  /**
   * Arms an icon drag on pointerdown, like editor tabs: it starts once the pointer moves a few
   * px (so a plain click still activates the view); a line shows where the icon goes, the list
   * scrolls when the pointer nears its ends, and the drop runs `view.move`. Escape cancels.
   */
  private armActivityDrag(
    viewId: string,
    down: PointerEvent,
    list: HTMLElement,
    line: HTMLElement,
  ): void {
    const drag = this.activityDragStore;
    drag.clear();
    this.activityDragEnded = false;
    const startY = down.clientY;
    const startX = down.clientX;
    const bar = line.parentElement;
    let started = false;
    let pointerY = startY;
    let target: { before: string | null } | null = null;
    let scrollFrame = 0;
    const itemsNow = () =>
      [...list.querySelectorAll<HTMLElement>(".activitybar-item[data-view-id]")].map((el) => ({
        id: el.dataset.viewId ?? "",
        rect: el.getBoundingClientRect(),
      }));
    const place = () => {
      const items = itemsNow();
      const listRect = list.getBoundingClientRect();
      const i = dropIndex(
        items.map((it) => it.rect.top + it.rect.height / 2),
        pointerY,
      );
      const from = items.findIndex((it) => it.id === viewId);
      // Dropping into its own slot (just above or below itself) changes nothing.
      if (!bar || i === from || i === from + 1) {
        target = null;
        line.hidden = true;
        return;
      }
      const prev = items[i - 1]?.rect;
      const next = items[i]?.rect;
      const y =
        prev && next ? (prev.bottom + next.top) / 2 : next ? next.top - 2 : (prev?.bottom ?? 0) + 2;
      // The line stays inside the list's visible part (the rest scrolls out of sight).
      const clamped = Math.min(Math.max(y, listRect.top + 1), listRect.bottom - 1);
      const barRect = bar.getBoundingClientRect();
      const anchor = next ?? prev;
      line.style.top = `${clamped - barRect.top - 1}px`;
      if (anchor) {
        line.style.left = `${anchor.left - barRect.left}px`;
        line.style.width = `${anchor.width}px`;
      }
      line.hidden = false;
      target = { before: items[i]?.id ?? null };
    };
    // Near the list's top or bottom edge the list scrolls (wheel events don't reach it while
    // dragging: everything ignores the pointer then).
    const autoScroll = () => {
      scrollFrame = 0;
      const rect = list.getBoundingClientRect();
      const edge = Math.min(24, rect.height / 4);
      const step = pointerY < rect.top + edge ? -6 : pointerY > rect.bottom - edge ? 6 : 0;
      if (!step) return;
      const before = list.scrollTop;
      list.scrollTop += step;
      if (list.scrollTop === before) return;
      place();
      scrollFrame = requestAnimationFrame(autoScroll);
    };
    const finish = (commit: boolean) => {
      const go = commit && started ? target : null;
      // A pointerup over the icon (even after Escape) may still click it; the next pointerdown
      // clears this.
      if (started) this.activityDragEnded = true;
      drag.clear();
      if (go) {
        const input: { id: string; before?: string } = { id: viewId };
        if (go.before) input.before = go.before;
        void this.deps.dispatcher.execute("view.move", input).catch(() => {});
      }
    };
    drag.add(
      on(window, "pointermove", (e) => {
        pointerY = e.clientY;
        if (!started) {
          if (Math.hypot(e.clientX - startX, e.clientY - startY) < ACTIVITY_DRAG_THRESHOLD) return;
          started = true;
          this.activityDrag = viewId;
          list
            .querySelector(`.activitybar-item[data-view-id="${CSS.escape(viewId)}"]`)
            ?.classList.add("is-drag-source");
          document.body.classList.add("is-dragging");
        }
        place();
        if (!scrollFrame) scrollFrame = requestAnimationFrame(autoScroll);
      }),
    );
    drag.add(on(window, "pointerup", () => finish(true)));
    drag.add(on(window, "pointercancel", () => finish(false)));
    // The mouse let go in another window (Alt+Tab mid-drag): no pointerup arrives here, and the
    // next click would drop the icon. Leaving the window ends the drag.
    drag.add(on(window, "blur", () => finish(false)));
    drag.add(
      on(document, "visibilitychange", () => {
        if (document.visibilityState === "hidden") finish(false);
      }),
    );
    drag.add(
      on(
        window,
        "keydown",
        (e) => {
          if (e.key === "Escape" && started) {
            e.preventDefault();
            e.stopPropagation();
            finish(false);
          }
        },
        { capture: true },
      ),
    );
    drag.add(
      toDisposable(() => {
        if (scrollFrame) cancelAnimationFrame(scrollFrame);
        line.hidden = true;
        if (this.activityDrag === viewId) {
          this.activityDrag = null;
          for (const el of list.querySelectorAll(".activitybar-item.is-drag-source"))
            el.classList.remove("is-drag-source");
        }
        if (started) document.body.classList.remove("is-dragging");
      }),
    );
  }

  /** Right-click on the activity bar: hide this icon, its own items, and every view's visibility. */
  private activityMenu(x: number, y: number, viewId: string | null): void {
    const { views, dispatcher } = this.deps;
    const exec = (command: string, input: unknown = {}) =>
      void dispatcher.execute(command, input).catch(() => {});
    const view = viewId ? views.get(viewId) : undefined;
    const hidden = views.hidden.peek();
    const items: MenuItem[] = [];
    if (view) {
      items.push({
        label: `Hide "${view.title}"`,
        icon: "eye-off",
        run: () => exec("view.setHidden", { id: view.id, hidden: true }),
      });
      for (const [i, m] of (view.menu?.() ?? []).entries())
        items.push({
          label: m.label,
          destructive: m.danger,
          separatorBefore: i === 0 || m.separatorBefore,
          run: () => exec(m.command, m.input ?? {}),
        });
    }
    const unavailable = views.unavailable.peek();
    // In the bar's order (workbench.activityBar.order).
    // A view that only lives as a section (Source control's Graph) has no icon to show or hide.
    const listed = orderViews(views.all.peek(), views.order.peek()).filter((v) => !v.sectionOnly);
    for (const [i, v] of listed.entries()) {
      // A view kept off the bar until it has something (Testing without tests) isn't shown, so
      // it isn't checked; checking it keeps it on the bar (D162).
      const away = unavailable.has(v.id) && !!v.alwaysShowSetting;
      items.push({
        label: v.title,
        checked: !hidden.has(v.id) && !away,
        separatorBefore: i === 0 && items.length > 0,
        run: () => {
          if (away && v.alwaysShowSetting) {
            exec("settings.set", { key: v.alwaysShowSetting, value: true });
            if (hidden.has(v.id)) exec("view.setHidden", { id: v.id, hidden: false });
          } else exec("view.setHidden", { id: v.id, hidden: !hidden.has(v.id) });
        },
      });
    }
    if (hidden.size)
      items.push({
        label: "Show all",
        icon: "eye",
        separatorBefore: true,
        run: () => exec("view.setHidden", { all: true, hidden: false }),
      });
    items.push({
      label:
        this.deps.layout.sidebarSide.peek() === "right"
          ? "Move sidebar left"
          : "Move sidebar right",
      icon: "arrow-left-right",
      separatorBefore: true,
      run: () => exec("layout.toggleSidebarPosition"),
    });
    showContextMenu(x, y, items);
  }

  private trackFocus(): void {
    const update = () => {
      const part = (document.activeElement?.closest?.("[data-part]") as HTMLElement | null)?.dataset
        .part;
      if (part === "sidebar" || part === "dock") this.deps.layout.focusedPart.value = part;
      const active = document.activeElement as HTMLElement | null;
      // A text field (search box, commit message…) or an editor's text, as VS Code's inputFocus:
      // its own undo and clipboard keys win over the explorer's, and an extension's plain-letter
      // keys (Jupyter Keymap's A / B in a notebook: `!inputFocus`) don't fire while typing in a
      // notebook cell. The terminal's input isn't one (its keys are the shell's, D192).
      const inputFocus =
        !!active &&
        !active.closest(".xterm") &&
        (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
      this.deps.context.setMany({
        focusedPart: part ?? null,
        sideBarFocus: part === "sidebar",
        // The file tree itself (workspace undo answers there, not in other sidebar views).
        explorerFocus: !!active?.closest(".explorer-tree"),
        dockFocus: part === "dock",
        inputFocus,
      });
    };
    this.store.add(on(this.root, "focusin", update));
    this.store.add(on(this.root, "focusout", () => queueMicrotask(update)));
  }

  dispose(): void {
    this.store.dispose();
  }
}

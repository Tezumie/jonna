// The DevTools shell under (or beside) a browser tab's page: Elements, Console, Network, Sources,
// Performance, Application — created on first use — with error/warning counts on Console, a dock-side toggle
// and close. The browser view owns its size (sash) and visibility. The tabs fit the width
// (D147): icon and name, then shorter names, then icons (the selected one keeps its name), and
// past that they scroll like editor tabs (wheel, a thin scrollbar, the selected one kept in view).
import { h, on } from "../../../core/dom/index";
import { DisposableStore, toDisposable } from "../../../core/lifecycle/index";
import { effect } from "../../../core/reactive/index";
import { type IconName, icon } from "../../../ui/Icon";
import { setTooltip } from "../../../ui/Tooltip";
import { problemCounts } from "../page";
import { ApplicationPanel } from "./application";
import type { DevtoolsHost, DevtoolsPanel } from "./common";
import { ConsolePanel } from "./console";
import { ElementsPanel } from "./elements";
import { NetworkPanel } from "./network";
import { PerformancePanel } from "./performance";
import { SourcesPanel } from "./sources";

export type DevtoolsTab =
  | "elements"
  | "console"
  | "network"
  | "sources"
  | "performance"
  | "application";
export const DEVTOOLS_TABS: [DevtoolsTab, string][] = [
  ["elements", "Elements"],
  ["console", "Console"],
  ["network", "Network"],
  ["sources", "Sources"],
  ["performance", "Performance"],
  ["application", "Application"],
];

/** Each tab's icon and shorter name (for narrow DevTools). */
const TAB_LOOK: Record<DevtoolsTab, { icon: IconName; short: string }> = {
  elements: { icon: "code", short: "Elements" },
  console: { icon: "square-terminal", short: "Console" },
  network: { icon: "arrow-left-right", short: "Network" },
  sources: { icon: "file-code", short: "Sources" },
  performance: { icon: "zap", short: "Perf" },
  application: { icon: "app-window", short: "App" },
};

/** How much of each tab shows, from widest to narrowest. */
const FIT_MODES = ["full", "short", "icons"] as const;

export interface DevtoolsChrome {
  /** Dock under the page or beside it. */
  toggleSide(): void;
  close(): void;
  side(): "bottom" | "right";
  /** Device size (responsive mode) on/off. */
  toggleDevice(): void;
  deviceOn(): boolean;
}

export class Devtools {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly body: HTMLElement;
  private readonly tablist: HTMLElement;
  private readonly tabButtons = new Map<DevtoolsTab, HTMLButtonElement>();
  private readonly panels = new Map<DevtoolsTab, DevtoolsPanel>();
  active: DevtoolsTab = "console";
  private visible = false;
  private deviceButton: HTMLElement | undefined;
  private chrome: DevtoolsChrome | undefined;

  /** The device button shows whether device mode is on. */
  syncDevice(): void {
    this.deviceButton?.classList.toggle("is-active", this.chrome?.deviceOn() ?? false);
    this.deviceButton?.setAttribute("aria-pressed", String(this.chrome?.deviceOn() ?? false));
  }

  constructor(
    private readonly host: DevtoolsHost,
    chrome: DevtoolsChrome,
  ) {
    const s = this.store;
    const tabs = DEVTOOLS_TABS.map(([id, label]) => {
      const look = TAB_LOOK[id];
      const b = h(
        "button",
        {
          class: "dt-tab",
          type: "button",
          role: "tab",
          "aria-selected": "false",
          "aria-label": label,
          "data-tab": id,
        },
        icon(look.icon),
        h("span", { class: "dt-tab-label is-full" }, label),
        h("span", { class: "dt-tab-label is-short" }, look.short),
      );
      setTooltip(b, label);
      s.add(on(b, "click", () => this.show(id)));
      this.tabButtons.set(id, b);
      return b;
    });
    const badge = h("span", { class: "dt-badges" });
    this.tabButtons.get("console")?.append(badge);
    s.add(
      effect(() => {
        host.page.console.value;
        host.page.network.value;
        const { errors, warnings } = problemCounts(host.page);
        badge.replaceChildren(
          ...(errors ? [h("span", { class: "dt-badge is-error" }, String(errors))] : []),
          ...(warnings ? [h("span", { class: "dt-badge is-warn" }, String(warnings))] : []),
        );
        return undefined;
      }),
    );
    const side = h("button", { class: "icon-button dt-icon", type: "button" }, icon("panel-right"));
    const sync = () =>
      side.replaceChildren(icon(chrome.side() === "bottom" ? "panel-right" : "panel-bottom"));
    setTooltip(side, "Dock to the side / bottom");
    s.add(
      on(side, "click", () => {
        chrome.toggleSide();
        sync();
      }),
    );
    sync();
    const device = h(
      "button",
      { class: "icon-button dt-icon", type: "button" },
      icon("monitor-smartphone"),
    );
    this.deviceButton = device;
    setTooltip(device, "Device size (responsive mode)");
    s.add(on(device, "click", () => chrome.toggleDevice()));
    this.chrome = chrome;
    this.syncDevice();
    const close = h("button", { class: "icon-button dt-icon", type: "button" }, icon("x"));
    setTooltip(close, "Close DevTools");
    s.add(on(close, "click", () => chrome.close()));
    this.body = h("div", { class: "dt-body" });
    this.tablist = h("div", { class: "dt-tablist", role: "tablist", "data-fit": "full" }, ...tabs);
    this.element = h(
      "div",
      { class: "devtools" },
      h(
        "div",
        { class: "dt-tabs" },
        // Tabs scroll on their own when DevTools is narrow; dock side and close stay visible.
        this.tablist,
        device,
        side,
        close,
      ),
      this.body,
    );
    // The wheel scrolls the tabs sideways when they overflow (as editor tabs do).
    s.add(
      on(
        this.tablist,
        "wheel",
        (e) => {
          const list = this.tablist;
          if (list.scrollWidth <= list.clientWidth || e.deltaX !== 0) return;
          e.preventDefault();
          list.scrollLeft += e.deltaY;
        },
        { passive: false },
      ),
    );
    let width = -1;
    const observer = new ResizeObserver(() => {
      const w = this.tablist.clientWidth;
      if (w === width) return;
      width = w;
      this.fitTabs();
    });
    observer.observe(this.tablist);
    s.add(toDisposable(() => observer.disconnect()));
    s.add({
      dispose: () => {
        for (const p of this.panels.values()) p.dispose();
      },
    });
  }

  /** The widest look of the tabs that fits; past icons only, the strip scrolls. */
  private fitTabs(): void {
    const list = this.tablist;
    for (const mode of FIT_MODES) {
      list.dataset.fit = mode;
      if (list.scrollWidth <= list.clientWidth + 1) break;
    }
    this.revealActive();
  }

  /** Keeps the selected tab in view in a scrolling strip. */
  private revealActive(): void {
    const b = this.tabButtons.get(this.active);
    const list = this.tablist;
    if (!b || list.scrollWidth <= list.clientWidth) return;
    const left = b.offsetLeft;
    if (left < list.scrollLeft) list.scrollLeft = left;
    else if (left + b.offsetWidth > list.scrollLeft + list.clientWidth)
      list.scrollLeft = left + b.offsetWidth - list.clientWidth;
  }

  private create(tab: DevtoolsTab): DevtoolsPanel {
    switch (tab) {
      case "elements":
        return new ElementsPanel(this.host);
      case "console":
        return new ConsolePanel(this.host);
      case "network":
        return new NetworkPanel(this.host);
      case "sources":
        return new SourcesPanel(this.host);
      case "performance":
        return new PerformancePanel(this.host);
      case "application":
        return new ApplicationPanel(this.host);
    }
  }

  /** The panel for `tab`, created if needed (without showing it). */
  panel<T extends DevtoolsPanel>(tab: DevtoolsTab): T {
    let p = this.panels.get(tab);
    if (!p) {
      p = this.create(tab);
      this.panels.set(tab, p);
    }
    return p as T;
  }

  show(tab: DevtoolsTab): void {
    const previous = this.panels.get(this.active);
    if (tab !== this.active && this.visible) previous?.onHide?.();
    this.active = tab;
    const panel = this.panel(tab);
    for (const [id, b] of this.tabButtons) b.setAttribute("aria-selected", String(id === tab));
    // In icons-only mode the selected tab shows its name: the fit may change.
    if (this.tablist.dataset.fit !== "full") this.fitTabs();
    else this.revealActive();
    if (panel.element.parentElement !== this.body) this.body.replaceChildren(panel.element);
    if (this.visible) panel.onShow?.();
  }

  /** The DevTools area became visible or hidden. */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    const panel = this.panels.get(this.active);
    if (visible) {
      if (!panel) this.show(this.active);
      else panel.onShow?.();
    } else panel?.onHide?.();
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** The page loaded a new document: Elements and Sources start over when shown. */
  pageChanged(): void {
    const elements = this.panels.get("elements") as ElementsPanel | undefined;
    const sources = this.panels.get("sources") as SourcesPanel | undefined;
    if (this.visible && this.active === "elements") void elements?.reload();
    else if (elements) void elements.reload();
    if (this.visible && this.active === "sources") void sources?.load();
  }

  dispose(): void {
    this.store.dispose();
  }
}

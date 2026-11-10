// Title bar (DESIGN.md §10.1): a three-column grid that never overflows the window, plus a fixed
// column for the window controls. Left: the logo and the menu bar (the folder name is in the status bar); when the menu
// bar doesn't fit, it collapses into an app menu ☰ shown in the logo's place. Center: the command
// field, which shrinks first (down to COMMAND_MIN_WIDTH) so the menus stay as long as possible, then
// to an icon. Right: layout toggles (shown on hover). Everything except buttons is a drag region.
import type { ContextKeyService } from "../core/context/index";
import type { Dispatcher } from "../core/dispatcher/index";
import { h, on } from "../core/dom/index";
import { isTauri } from "../core/ipc/invoke";
import { windowIpc } from "../core/ipc/system";
import type { Platform } from "../core/keybindings/index";
import type { LayoutModel } from "../core/layout/index";
import { type Disposable, DisposableStore, toDisposable } from "../core/lifecycle/index";
import { effect, type ReadonlySignal } from "../core/reactive/index";
import { type IconName, icon } from "../ui/Icon";
import { logo } from "../ui/Logo";
import { setTooltip } from "../ui/Tooltip";
import type { KeyboardService } from "./keyboard";

/** Room kept after the menu items before they give way to ☰. */
const LEFT_SLACK = 24;
/** The command field shrinks to this before the menu bar collapses. */
const COMMAND_MIN_WIDTH = 180;
const COMMAND_MAX_WIDTH = 560;

/** Top-level menus in the menu bar; `ui.showMenu { menu }` renders each one. */
export const MENU_BAR: readonly { id: string; label: string }[] = [
  { id: "file", label: "File" },
  { id: "edit", label: "Edit" },
  { id: "selection", label: "Selection" },
  { id: "view", label: "View" },
  { id: "go", label: "Go" },
  { id: "git", label: "Git" },
  { id: "terminal", label: "Terminal" },
  { id: "help", label: "Help" },
];

export interface TitleBarDeps {
  platform: Platform;
  dispatcher: Dispatcher;
  /** `canNavigateBack` / `canNavigateForward` / `navigationControlLocation` (D279). */
  context: ContextKeyService;
  layout: LayoutModel;
  keyboard: KeyboardService;
  title: ReadonlySignal<string>;
  workspaceName: ReadonlySignal<string | null>;
  /** Whether the dock's bottom / right regions currently show (title-bar toggles). */
  regions: { bottom: ReadonlySignal<boolean>; right: ReadonlySignal<boolean> };
  run(command: string, input?: unknown): void;
}

export class TitleBar implements Disposable {
  private readonly store = new DisposableStore();
  /** The command field (the quick input anchors under it). */
  readonly commandField: HTMLElement;

  constructor(
    host: HTMLElement,
    private readonly deps: TitleBarDeps,
  ) {
    const appMenu = this.iconButton("menu", "Application menu", "ui.showAppMenu", "titlebar-menu");
    const brand = h("span", { class: "titlebar-logo", "aria-hidden": "true" }, logo(16));
    const menubar = h(
      "div",
      { class: "titlebar-menubar", role: "menubar" },
      MENU_BAR.map(({ id, label }) => {
        const item = h(
          "button",
          { class: "titlebar-menu-item", type: "button", role: "menuitem", "data-menu": id },
          label,
        );
        this.store.add(
          on(item, "click", () =>
            deps.run("ui.showMenu", { menu: id, anchor: `[data-menu="${id}"]` }),
          ),
        );
        // While a menu bar menu is open, hovering another title switches to it.
        this.store.add(
          on(item, "pointerenter", () => {
            const current = menubar.querySelector(".titlebar-menu-item.is-open");
            if (current && current !== item)
              deps.run("ui.showMenu", { menu: id, anchor: `[data-menu="${id}"]`, hover: true });
          }),
        );
        return item;
      }),
    );

    const shortcut = h("kbd", null);
    this.commandField = h(
      "button",
      { class: "titlebar-command", type: "button", "aria-label": "Search files and commands" },
      icon("search"),
      h("span", { class: "titlebar-command-label" }, "Search files and commands"),
      shortcut,
    );
    // VS Code's command center: quick open (files; `>` for commands), Ctrl/Cmd+P.
    this.store.add(on(this.commandField, "click", () => deps.run("quickOpen.show")));
    this.store.add(
      effect(() => {
        deps.keyboard.rulesVersion.value;
        shortcut.textContent = deps.keyboard.labelFor("quickOpen.show") ?? "";
        shortcut.hidden = !shortcut.textContent;
        return undefined;
      }),
    );

    // Go back / Go forward beside the command field, as VS Code's command center has them (D279);
    // workbench.navigationControl.location can move them to the tab strips instead.
    const back = this.iconButton(
      "arrow-left",
      "Go back",
      "workbench.navigateBack",
      "titlebar-nav-button",
    );
    const forward = this.iconButton(
      "arrow-right",
      "Go forward",
      "workbench.navigateForward",
      "titlebar-nav-button",
    );
    const nav = h("div", { class: "titlebar-nav" }, back, forward);
    const syncNav = () => {
      nav.hidden = deps.context.get("navigationControlLocation") !== "titleBar";
      back.toggleAttribute("disabled", deps.context.get("canNavigateBack") !== true);
      forward.toggleAttribute("disabled", deps.context.get("canNavigateForward") !== true);
    };
    syncNav();
    this.store.add(
      deps.context.onDidChange((keys) => {
        if (
          keys.some(
            (k) =>
              k === "canNavigateBack" ||
              k === "canNavigateForward" ||
              k === "navigationControlLocation",
          )
        )
          syncNav();
      }),
    );

    const toggles: [ReadonlySignal<boolean>, HTMLElement, IconName][] = [
      [
        deps.layout.sidebarVisible,
        this.iconButton("panel-left", "Toggle sidebar", "layout.toggleSidebar"),
        "panel-left",
      ],
      [
        deps.regions.bottom,
        this.iconButton("panel-bottom", "Toggle bottom region", "layout.toggleBottomRegion"),
        "panel-bottom",
      ],
      [
        deps.regions.right,
        this.iconButton("panel-right", "Toggle right region", "layout.toggleRightRegion"),
        "panel-right",
      ],
    ];
    const controls =
      deps.platform === "mac"
        ? []
        : [
            this.iconButton("minus", "Minimize", "window.minimize", "window-control"),
            this.maximizeButton(),
            this.iconButton("x", "Close", "window.close", "window-control is-close"),
          ];
    const title = h("div", { class: "titlebar-title", "aria-live": "polite" });
    const element = h(
      "header",
      { class: "titlebar", "data-tauri-drag-region": true },
      h("div", { class: "titlebar-left", "data-tauri-drag-region": true }, brand, appMenu, menubar),
      h(
        "div",
        { class: "titlebar-center", "data-tauri-drag-region": true },
        nav,
        this.commandField,
      ),
      h(
        "div",
        { class: "titlebar-right", "data-tauri-drag-region": true },
        h(
          "div",
          { class: "titlebar-toggles" },
          toggles.map(([, el]) => el),
        ),
      ),
      h("div", { class: "window-controls" }, controls),
      title,
    );
    host.appendChild(element);
    this.store.add(toDisposable(() => element.remove()));

    this.store.add(
      effect(() => {
        // The folder's name is in the status bar (D132); the full title goes to the OS window.
        document.title = deps.title.value;
        title.textContent = deps.title.value;
        return undefined;
      }),
    );
    // Space is given up in this order (DESIGN.md §10.1): the command field shrinks toward
    // COMMAND_MIN_WIDTH, then the menu items collapse into ☰ (in the logo's place), then the
    // command field becomes an icon. Measured, not breakpoints: label widths depend on font/locale.
    const left = element.querySelector<HTMLElement>(".titlebar-left");
    const right = element.querySelector<HTMLElement>(".titlebar-toggles");
    const windowControls = element.querySelector<HTMLElement>(".window-controls");
    if (left && right && windowControls) {
      let natural = 0;
      const fit = () => {
        const collapsed = left.classList.contains("is-menubar-collapsed");
        if (!collapsed) natural = menubar.offsetWidth;
        if (natural === 0) return; // not laid out yet
        const gap = 8;
        const width = element.clientWidth - windowControls.offsetWidth - gap * 3;
        const lead = Math.max(brand.offsetWidth, appMenu.offsetWidth, 28);
        const leftNeeded = lead + natural + LEFT_SLACK;
        const rightNeeded = right.scrollWidth;
        const centered = Math.min(COMMAND_MAX_WIDTH, width - Math.max(leftNeeded, rightNeeded) * 2);
        let columns: string | null;
        if (centered >= COMMAND_MIN_WIDTH) {
          // Room for everything with the field in the middle of the window.
          columns = `minmax(0, 1fr) ${Math.floor(centered)}px minmax(0, 1fr) auto`;
        } else if (width - leftNeeded - rightNeeded >= COMMAND_MIN_WIDTH) {
          // The field gives way first: it shrinks and moves off-center, the menus stay.
          columns = `${leftNeeded}px minmax(0, 1fr) ${rightNeeded}px auto`;
        } else columns = null; // menus collapse into ☰ (CSS default columns)
        left.classList.toggle("is-menubar-collapsed", columns === null);
        if (columns) element.style.gridTemplateColumns = columns;
        else element.style.removeProperty("grid-template-columns");
      };
      const observer = new ResizeObserver(fit);
      observer.observe(element);
      this.store.add(toDisposable(() => observer.disconnect()));
    }
    // Toggled on = filled glyph on a raised fill (DESIGN.md §9; never an accent color).
    this.store.add(
      effect(() => {
        // The buttons follow the layout left to right (D119): with the sidebar on the right, its
        // toggle is the rightmost (panel-right) and the right region's — now the column left of
        // the sidebar — gets an inner-column glyph, so each button sits where its part is.
        const side = deps.layout.sidebarSide.value;
        const strip = toggles[0]?.[1].parentElement;
        const ordered = side === "right" ? [toggles[1], toggles[2], toggles[0]] : toggles;
        if (strip) strip.replaceChildren(...ordered.flatMap((t) => (t ? [t[1]] : [])));
        for (const [visible, el, base] of toggles) {
          const name: IconName =
            side !== "right"
              ? base
              : base === "panel-left"
                ? "panel-right"
                : base === "panel-right"
                  ? "panel-inner-right"
                  : base;
          el.classList.toggle("is-sidebar-right", base === "panel-left" && side === "right");
          const isOn = visible.value;
          el.classList.toggle("is-on", isOn);
          el.setAttribute("aria-pressed", String(isOn));
          el.replaceChildren(icon(isOn ? (`${name}-on` as IconName) : name));
        }
        return undefined;
      }),
    );
  }

  /** Maximize ↔ restore glyph follows the window state (Windows/Linux caption convention). */
  private maximizeButton(): HTMLElement {
    const button = this.iconButton("square", "Maximize", "window.toggleMaximize", "window-control");
    if (!isTauri()) return button;
    const sync = () =>
      void Promise.all([windowIpc.isMaximized(), windowIpc.isFullscreen()])
        .then(([max, full]) => {
          button.replaceChildren(icon(max ? "window-restore" : "square"));
          setTooltip(button, max ? "Restore" : "Maximize");
          button.setAttribute("aria-label", max ? "Restore" : "Maximize");
          // Full screen has no minimize / maximize / close, as in VS Code (D387).
          button.closest(".window-controls")?.classList.toggle("is-fullscreen", full);
        })
        .catch(() => {});
    sync();
    void windowIpc
      .onResized(sync)
      .then((d) => this.store.add(d))
      .catch(() => {});
    return button;
  }

  private iconButton(name: IconName, label: string, command: string, extraClass = ""): HTMLElement {
    const el = h(
      "button",
      { class: `icon-button titlebar-button ${extraClass}`, type: "button", "aria-label": label },
      icon(name),
    );
    setTooltip(el, label, command);
    this.store.add(on(el, "click", () => this.deps.run(command)));
    return el;
  }

  dispose(): void {
    this.store.dispose();
  }
}

// Sidebar views (explorer now; search, source control, extensions later). The sidebar is the only
// fixed panel (docs/dock.md); it shows one active view at a time. Views are created lazily on first
// show and kept alive. Header: sentence-case title, actions revealed on hover (DESIGN.md §10).
import type { Dispatcher } from "../core/dispatcher/index";
import { h, on } from "../core/dom/index";
import { type Disposable, DisposableStore, toDisposable } from "../core/lifecycle/index";
import { batch, effect, type Signal, signal } from "../core/reactive/index";
import { type IconName, icon } from "../ui/Icon";
import { type MenuItem, showContextMenu } from "../ui/Menu";
import { Sash } from "../ui/Sash";
import { setTooltip } from "../ui/Tooltip";
import { scrollMemory } from "./scrollMemory";
import { ViewTitles } from "./viewTitles";

export interface ViewAction {
  command: string;
  icon: IconName;
  title: string;
  /** Opens a menu: the command gets `{ x, y }`, the button's bottom-left corner. */
  menu?: boolean;
  /** Drawn as a narrow ▾ against the action before it (VS Code's "+ ▾"); use with `menu`. */
  dropdown?: boolean;
  /**
   * Text beside the icon, read reactively (D220: the Graph's branch filter shows "Auto" or
   * "All"), as VS Code's labeled view actions.
   */
  label?: () => string;
  /** The command's input (default `{}`): an extension file system section's own scheme (D234). */
  input?: unknown;
}

/** A header button for a view action (icon, its label if any), running it on click. */
function actionButton(
  action: ViewAction,
  store: DisposableStore,
  run: (command: string, input: unknown) => void,
): HTMLButtonElement {
  const button = h(
    "button",
    {
      class: action.label
        ? "icon-button view-action-labeled"
        : action.dropdown
          ? "icon-button view-action-dropdown"
          : "icon-button",
      type: "button",
      "aria-label": action.title,
      ...(action.menu && { "aria-haspopup": "menu" }),
    },
    icon(action.icon),
  );
  const label = action.label;
  if (label) {
    const text = h("span", { class: "view-action-label" });
    button.append(text);
    store.add(
      effect(() => {
        const value = label();
        text.textContent = value;
        button.setAttribute("aria-label", value ? `${action.title} (${value})` : action.title);
        return undefined;
      }),
    );
  }
  setTooltip(button, action.title, action.command);
  store.add(
    on(button, "click", () => {
      const r = button.getBoundingClientRect();
      run(action.command, action.menu ? { x: r.left, y: r.bottom + 2 } : (action.input ?? {}));
    }),
  );
  return button;
}

export interface ViewMenuItem {
  label: string;
  /** A command and its input (menus run commands, AGENTS.md rule 6). */
  command: string;
  input?: unknown;
  separatorBefore?: boolean;
  danger?: boolean;
}

export interface ViewInstance extends Disposable {
  focus?(): void;
}

export interface ViewDescriptor {
  id: string;
  title: string;
  icon: IconName;
  /**
   * An image URL drawn instead of `icon` in the activity bar once there is one (read reactively):
   * an extension's own icon file, as a mask in the icon color like VS Code's (D260).
   */
  iconImage?(): string | null;
  /** Command that shows this view (its keybinding appears in the activity bar tooltip). */
  command?: string;
  /** Buttons in the view header; each runs a command. */
  actions?: ViewAction[];
  /** Extra items for the activity bar icon's right-click menu (e.g. an extension's uninstall). */
  menu?(): ViewMenuItem[];
  /**
   * While hidden from the activity bar, the view lives on as a collapsible, resizable section at
   * the bottom of this view instead (VS Code's Outline under the Explorer, D129).
   */
  sectionOf?: string;
  /** Where it sits among the sections of the same view, top to bottom (default 0; ties: as registered). */
  sectionOrder?: number;
  /**
   * Always a section of `sectionOf`, never an activity bar icon (Source control's Graph, D210):
   * whatever workbench.activityBar.hidden says.
   */
  sectionOnly?: boolean;
  /** The section's state before the user changes it (default: collapsed, 240 px). */
  sectionDefault?: Partial<SectionState>;
  /**
   * Whether the section shows now (read reactively): Source control's Graph only with a
   * repository, so it doesn't squeeze the "No repository" page (D254). Absent: always.
   */
  sectionWhen?(): boolean;
  /**
   * The boolean setting that keeps this view on the activity bar while it has nothing to show
   * (Testing's `testing.alwaysShow`): checking the view in the activity bar menu turns it on (D162).
   */
  alwaysShowSetting?: string;
  /**
   * Can move into a dock tab and back (VS Code's movable views): `view.moveView`, dragging its
   * header onto the dock, or its tab back onto the sidebar. Where it is persists with the dock.
   */
  movable?: boolean;
  create(host: HTMLElement): ViewInstance;
}

/** Reveals a view that lives in a dock tab (set by movableViews.ts). */
export interface DockedViewHost {
  reveal(id: string, focus: boolean): boolean;
}

export interface ViewBadge {
  count: number;
  /** "3 unsaved files" */
  tooltip: string;
}

/** A docked section's state (collapsed by default; height in px while expanded). */
export interface SectionState {
  collapsed: boolean;
  height: number;
}

export const DEFAULT_SECTION: SectionState = { collapsed: true, height: 240 };
const MIN_SECTION_PX = 80;
/** What the view above a section keeps at least. */
const MIN_MAIN_PX = 100;

export class ViewRegistry implements Disposable {
  readonly all: Signal<readonly ViewDescriptor[]> = signal<readonly ViewDescriptor[]>([]);
  readonly active: Signal<string | null> = signal<string | null>(null);
  /** Views hidden from the activity bar (workbench.activityBar.hidden); still reachable by command. */
  readonly hidden: Signal<ReadonlySet<string>> = signal<ReadonlySet<string>>(new Set());
  /**
   * The user's activity bar order (workbench.activityBar.order, `view.move`): view ids, possibly
   * naming views not registered now; views it doesn't name come after, as registered.
   */
  readonly order: Signal<readonly string[]> = signal<readonly string[]>([]);
  /**
   * Views with nothing to show here yet, kept off the activity bar until they have (VS Code shows
   * Testing only once tests are found). Still reachable by command.
   */
  readonly unavailable: Signal<ReadonlySet<string>> = signal<ReadonlySet<string>>(new Set());

  /** Puts view `id`'s activity bar icon back (true) or keeps it off (false). */
  setAvailable(id: string, available: boolean): void {
    const current = this.unavailable.peek();
    if (current.has(id) === !available) return;
    const next = new Set(current);
    if (available) next.delete(id);
    else next.add(id);
    this.unavailable.value = next;
  }
  private readonly focusRequests = new Map<string, () => void>();
  /** Views with work in progress (VS Code's progress line), view id → what's running. */
  readonly busy: Signal<ReadonlyMap<string, string>> = signal<ReadonlyMap<string, string>>(
    new Map(),
  );
  private readonly running = new Map<string, string[]>();
  /**
   * Numbers on activity-bar icons (VS Code's badges): the explorer's unsaved files, source
   * control's changes… view id → count and what it counts (the tooltip).
   */
  readonly badges: Signal<ReadonlyMap<string, ViewBadge>> = signal<ReadonlyMap<string, ViewBadge>>(
    new Map(),
  );

  /** Sets (count > 0) or clears view `id`'s badge. */
  setBadge(id: string, count: number, tooltip = ""): void {
    const current = this.badges.peek().get(id);
    if (count <= 0 ? !current : current?.count === count && current.tooltip === tooltip) return;
    const next = new Map(this.badges.peek());
    if (count > 0) next.set(id, { count, tooltip });
    else next.delete(id);
    this.badges.value = next;
  }
  /**
   * Titles set from code (VS Code's TreeView.title / description): the header shows the title
   * instead of the descriptor's, with the description beside it in a quieter color.
   */
  readonly titles = new ViewTitles();

  /** Docked sections' state by view id (persisted per workspace by the workbench extension). */
  readonly sections: Signal<ReadonlyMap<string, SectionState>> = signal<
    ReadonlyMap<string, SectionState>
  >(new Map());

  /**
   * Movable views that live in a dock tab now, not in the sidebar (derived from the dock's tabs
   * by movableViews.ts).
   */
  readonly inDock: Signal<ReadonlySet<string>> = signal<ReadonlySet<string>>(new Set());
  /** Reveals a view that's in the dock (null until the dock side is set up). */
  dockHost: DockedViewHost | null = null;

  /** The view `id` is docked into as a section right now (null: it has its own icon, or it's in a dock tab). */
  sectionHost(id: string, hidden = this.hidden.peek()): string | null {
    if (this.inDock.peek().has(id)) return null;
    const view = this.get(id);
    return view?.sectionOf && (view.sectionOnly || hidden.has(id)) && this.get(view.sectionOf)
      ? view.sectionOf
      : null;
  }

  section(id: string, sections = this.sections.peek()): SectionState {
    return sections.get(id) ?? { ...DEFAULT_SECTION, ...this.get(id)?.sectionDefault };
  }

  setSection(id: string, patch: Partial<SectionState>): void {
    const next = new Map(this.sections.peek());
    next.set(id, { ...this.section(id), ...patch });
    this.sections.value = next;
  }

  /**
   * Marks `id` busy until the returned disposable is disposed: a 2px progress line at the top of
   * the view and a busy mark on its activity-bar icon. Shown after a short delay, so quick
   * operations don't flash it.
   */
  progress(id: string, title = "", delayMs = 150): Disposable {
    let shown = false;
    const timer = setTimeout(() => {
      shown = true;
      const list = this.running.get(id) ?? [];
      list.push(title);
      this.running.set(id, list);
      this.publish();
    }, delayMs);
    return toDisposable(() => {
      clearTimeout(timer);
      if (!shown) return;
      const list = this.running.get(id) ?? [];
      const i = list.indexOf(title);
      if (i >= 0) list.splice(i, 1);
      if (list.length) this.running.set(id, list);
      else this.running.delete(id);
      this.publish();
    });
  }

  private publish(): void {
    const next = new Map<string, string>();
    for (const [id, titles] of this.running) next.set(id, titles[titles.length - 1] ?? "");
    this.busy.value = next;
  }

  register(view: ViewDescriptor): Disposable {
    if (this.all.peek().some((v) => v.id === view.id))
      throw new Error(`View already registered: ${view.id}`);
    batch(() => {
      this.all.value = [...this.all.peek(), view];
      if (this.active.peek() === null) this.active.value = view.id;
    });
    return toDisposable(() => {
      this.all.value = this.all.peek().filter((v) => v !== view);
      if (this.active.peek() === view.id) this.active.value = this.all.peek()[0]?.id ?? null;
    });
  }

  get(id: string): ViewDescriptor | undefined {
    return this.all.peek().find((v) => v.id === id);
  }

  activate(id: string): ViewDescriptor | undefined {
    const view = this.get(id);
    if (view) this.active.value = id;
    return view;
  }

  focus(id: string): void {
    this.focusRequests.get(id)?.();
  }

  /** @internal ViewContainer registers how to focus its views. */
  setFocusHandler(id: string, fn: () => void): Disposable {
    // The latest handler wins; disposing it restores the previous one (a view docked as a
    // section has a second instance while it's there).
    const previous = this.focusRequests.get(id);
    this.focusRequests.set(id, fn);
    return toDisposable(() => {
      if (this.focusRequests.get(id) !== fn) return;
      if (previous) this.focusRequests.set(id, previous);
      else this.focusRequests.delete(id);
    });
  }

  dispose(): void {
    this.focusRequests.clear();
  }
}

/** Renders the sidebar's active view with its header. */
export class ViewContainer implements Disposable {
  private readonly store = new DisposableStore();
  private readonly instances = new Map<
    string,
    { host: HTMLElement; view: ViewInstance; store: DisposableStore }
  >();
  private readonly header: HTMLElement;
  private readonly body: HTMLElement;
  private readonly headerStore = this.store.add(new DisposableStore());

  constructor(
    host: HTMLElement,
    private readonly registry: ViewRegistry,
    private readonly dispatcher: Dispatcher,
    /** Starts dragging a movable view's header toward the dock (the dock's drag controller). */
    private readonly dragView?: (id: string, down: PointerEvent, source: HTMLElement) => void,
  ) {
    this.header = h("div", { class: "view-header" });
    this.body = h("div", { class: "view-body" });
    const progress = h("div", {
      class: "progress-line view-progress",
      hidden: true,
      role: "progressbar",
    });
    host.append(this.header, progress, this.body);
    this.store.add(toDisposable(() => progress.remove()));
    this.store.add(
      effect(() => {
        const activeId = this.registry.active.value;
        const title = activeId !== null ? this.registry.busy.value.get(activeId) : undefined;
        progress.hidden = title === undefined;
        this.body.setAttribute("aria-busy", String(title !== undefined));
        if (title) progress.setAttribute("aria-label", title);
        return undefined;
      }),
    );
    this.store.add(
      toDisposable(() => {
        this.header.remove();
        this.body.remove();
      }),
    );
    this.store.add(effect(() => this.render()));
  }

  private render(): undefined {
    const views = this.registry.all.value;
    const activeId = this.registry.active.value;
    const hidden = this.registry.hidden.value;
    const sections = this.registry.sections.value;
    const inDock = this.registry.inDock.value;
    // A section whose view moved into the dock goes, whichever view it was under.
    for (const [key, section] of this.sections)
      if (inDock.has(key)) {
        section.store.dispose();
        this.sections.delete(key);
      }
    const active =
      views.find((v) => v.id === activeId && !inDock.has(v.id)) ??
      views.find((v) => !inDock.has(v.id));
    this.renderHeader(active);
    if (!active) return undefined;
    // A view moved into the dock lives in its tab: its sidebar instance goes.
    for (const [id, inst] of this.instances)
      if (inDock.has(id)) {
        this.store.delete(inst.store);
        this.instances.delete(id);
      }
    let entry = this.instances.get(active.id);
    if (!entry) {
      const viewHost = h("div", { class: "view", "data-view": active.id });
      const main = h("div", { class: "view-main" });
      viewHost.appendChild(main);
      this.body.appendChild(viewHost);
      const store = this.store.add(new DisposableStore());
      const view = active.create(main);
      entry = { host: viewHost, view, store };
      this.instances.set(active.id, entry);
      store.add(view);
      store.add(toDisposable(() => viewHost.remove()));
      const id = active.id;
      store.add(scrollMemory.track(viewHost, () => `sidebar:${id}`));
      store.add(this.registry.setFocusHandler(active.id, () => view.focus?.()));
    }
    for (const [id, inst] of this.instances) inst.host.hidden = id !== active.id;
    scrollMemory.restore(entry.host);
    // Sections: views docked under the active one (hidden from the activity bar).
    const docked = views
      .filter((v) => this.registry.sectionHost(v.id, hidden) === active.id)
      .filter((v) => v.sectionWhen?.() !== false)
      .map((v, i) => ({ v, i }))
      .sort((a, b) => (a.v.sectionOrder ?? 0) - (b.v.sectionOrder ?? 0) || a.i - b.i)
      .map(({ v }) => v);
    for (const [key, section] of this.sections) {
      if (section.hostId === active.id && !docked.some((v) => v.id === key)) {
        section.store.dispose();
        this.sections.delete(key);
      }
    }
    for (const view of docked) {
      let section = this.sections.get(view.id);
      if (!section || section.hostId !== active.id) {
        section?.store.dispose();
        section = this.createSection(view, active.id, entry.host);
        this.sections.set(view.id, section);
      }
      section.update(this.registry.section(view.id, sections));
    }
    // In order, whenever they were created; moved only when out of order (moving an element
    // resets its scroll and blurs what's focused in it).
    const wanted = docked.flatMap((v) => {
      const s = this.sections.get(v.id);
      return s ? [s.element] : [];
    });
    const now = [...entry.host.children].filter((el) => wanted.includes(el as HTMLElement));
    if (now.length !== wanted.length || now.some((el, i) => el !== wanted[i]))
      for (const el of wanted) entry.host.appendChild(el);
    for (const view of docked) this.sections.get(view.id)?.syncEdge();
    return undefined;
  }

  private readonly sections = new Map<string, DockedSection>();

  /** A collapsible section at the bottom of `host`: header, sash above it, the view's body. */
  private createSection(view: ViewDescriptor, hostId: string, host: HTMLElement): DockedSection {
    const store = new DisposableStore();
    const run = (command: string, input: unknown) =>
      void this.dispatcher.execute(command, input).catch(() => {});
    const chevron = h("span", { class: "view-section-chevron" });
    const sectionTitle = h("span", { class: "view-section-title" }, view.title);
    const header = h(
      "button",
      { class: "view-section-header", type: "button", "data-section": view.id },
      chevron,
      sectionTitle,
    );
    store.add(
      effect(() => {
        const description = this.registry.titles.descriptionOf(view.id);
        sectionTitle.replaceChildren(
          this.registry.titles.titleOf(view),
          ...(description ? [h("span", { class: "view-description" }, description)] : []),
        );
        return undefined;
      }),
    );
    // The view's own header buttons, on the section header while it's expanded (shown on hover).
    const actions = h(
      "div",
      { class: "view-actions view-section-actions" },
      (view.actions ?? []).map((action) => actionButton(action, store, run)),
    );
    const headerRow = h("div", { class: "view-section-head" }, header, actions);
    const body = h("div", { class: "view-section-body" });
    const element = h(
      "div",
      { class: "view-section", "data-section-id": view.id },
      headerRow,
      body,
    );
    /**
     * The section a drag of this one's top edge resizes: itself when open; when collapsed, the
     * first open section below it (VS Code: the edge above a collapsed Outline resizes the open
     * Timeline under it).
     */
    const resizeTarget = (): { id: string; body: HTMLElement; header: HTMLElement } | null => {
      for (let el: Element | null = element; el; el = el.nextElementSibling) {
        if (!el.classList.contains("view-section") || el.classList.contains("is-collapsed"))
          continue;
        const id = (el as HTMLElement).dataset.sectionId;
        const b = el.querySelector<HTMLElement>(":scope > .view-section-body");
        const hd = el.querySelector<HTMLElement>(":scope > .view-section-head");
        if (id && b && hd) return { id, body: b, header: hd };
      }
      return null;
    };
    let target: ReturnType<typeof resizeTarget> = null;
    const sash = store.add(
      new Sash(element, {
        orientation: "horizontal",
        onStart: () => {
          target = resizeTarget();
          startHeight = target?.body.getBoundingClientRect().height ?? 0;
        },
        onDrag: (delta) => {
          if (!target) return;
          // Room for the main view, every section's header and the other open sections.
          let headers = 0;
          for (const el of host.querySelectorAll<HTMLElement>(":scope > .view-section"))
            headers +=
              el.querySelector<HTMLElement>(":scope > .view-section-head")?.offsetHeight ?? 0;
          const others = [...host.querySelectorAll<HTMLElement>(":scope > .view-section")]
            .filter(
              (el) => el.dataset.sectionId !== target?.id && !el.classList.contains("is-collapsed"),
            )
            .reduce(
              (sum, el) =>
                sum +
                (el.querySelector<HTMLElement>(":scope > .view-section-body")?.offsetHeight ?? 0),
              0,
            );
          const max = Math.max(MIN_SECTION_PX, host.clientHeight - MIN_MAIN_PX - headers - others);
          const height = Math.round(Math.min(max, Math.max(MIN_SECTION_PX, startHeight - delta)));
          target.body.style.height = `${height}px`;
          pending = height;
        },
        onEnd: () => {
          // The drag's result, as a command (view.resizeSection).
          if (pending !== null && target)
            run("view.resizeSection", { id: target.id, height: pending });
          pending = null;
          target = null;
        },
        onReset: () => {
          const t = resizeTarget();
          if (t)
            run("view.resizeSection", {
              id: t.id,
              height: this.registry.get(t.id)?.sectionDefault?.height ?? DEFAULT_SECTION.height,
            });
        },
      }),
    );
    let startHeight = 0;
    let pending: number | null = null;
    element.prepend(sash.element);
    host.appendChild(element);
    store.add(toDisposable(() => element.remove()));
    // A click toggles; dragging a movable view's header past the threshold moves it to the dock
    // (the drag controller arms on pointerdown and only starts once the pointer travels).
    let dragged = false;
    const press = store.add(new DisposableStore());
    store.add(
      on(header, "pointerdown", (e) => {
        dragged = false;
        press.clear();
        if (e.button !== 0 || !view.movable || !this.dragView) return;
        const startX = e.clientX;
        const startY = e.clientY;
        press.add(
          on(window, "pointermove", (m) => {
            if (Math.hypot(m.clientX - startX, m.clientY - startY) >= 4) dragged = true;
          }),
        );
        press.add(on(window, "pointerup", () => press.clear()));
        this.dragView(view.id, e, header);
      }),
    );
    store.add(
      on(header, "click", () => {
        if (dragged) {
          dragged = false;
          return;
        }
        run("view.toggleSection", { id: view.id });
      }),
    );
    store.add(
      on(header, "contextmenu", (e) => {
        e.preventDefault();
        const collapsed = this.registry.section(view.id).collapsed;
        store.add(
          showContextMenu(e.clientX, e.clientY, [
            {
              label: collapsed ? "Expand" : "Collapse",
              icon: collapsed ? "chevron-down" : "chevron-right",
              run: () => run("view.toggleSection", { id: view.id }),
            },
            ...(view.movable
              ? [
                  {
                    label: "Move to the dock",
                    icon: "panel-bottom" as const,
                    separatorBefore: true,
                    run: () => run("view.moveView", { id: view.id, to: "dock" }),
                  },
                ]
              : []),
            ...(view.sectionOnly
              ? []
              : [
                  {
                    label: "Show in activity bar",
                    icon: "eye" as const,
                    separatorBefore: true,
                    run: () => run("view.setHidden", { id: view.id, hidden: false }),
                  },
                ]),
          ]),
        );
      }),
    );
    let instance: ViewInstance | null = null;
    store.add(toDisposable(() => instance?.dispose()));
    const update = (state: SectionState) => {
      element.classList.toggle("is-collapsed", state.collapsed);
      header.setAttribute("aria-expanded", String(!state.collapsed));
      chevron.replaceChildren(icon(state.collapsed ? "chevron-right" : "chevron-down"));
      sash.hidden = state.collapsed;
      body.hidden = state.collapsed;
      actions.hidden = state.collapsed;
      // Clamped when shown: the sidebar may have got shorter since the size was saved.
      const max = Math.max(MIN_SECTION_PX, host.clientHeight - MIN_MAIN_PX - header.offsetHeight);
      body.style.height = `${host.clientHeight ? Math.min(state.height, max) : state.height}px`;
      // Created on first expand: a collapsed section costs nothing.
      if (!state.collapsed && !instance) {
        instance = view.create(body);
        store.add(this.registry.setFocusHandler(view.id, () => instance?.focus?.()));
      }
    };
    // A collapsed section keeps its edge while an open one is below it (resizeTarget); run after
    // every section has updated.
    const syncEdge = () => {
      sash.hidden = element.classList.contains("is-collapsed") && !resizeTarget();
    };
    return { hostId, store, update, element, syncEdge };
  }
  private renderHeader(active: ViewDescriptor | undefined): void {
    this.headerStore.clear();
    const actions = h(
      "div",
      { class: "view-actions" },
      (active?.actions ?? []).map((action) =>
        actionButton(action, this.headerStore, (command, input) => {
          void this.dispatcher.execute(command, input).catch(() => {});
        }),
      ),
    );
    const title = h("h2", { class: "view-title" }, active?.title ?? "");
    this.header.replaceChildren(title, actions);
    // A title and description its code set (VS Code's TreeView.title / description).
    if (active)
      this.headerStore.add(
        effect(() => {
          const description = this.registry.titles.descriptionOf(active.id);
          title.replaceChildren(
            this.registry.titles.titleOf(active),
            ...(description ? [h("span", { class: "view-description" }, description)] : []),
          );
          return undefined;
        }),
      );
    // A movable view's title drags it onto the dock (VS Code drags a view by its title).
    const dragView = this.dragView;
    if (active?.movable && dragView)
      this.headerStore.add(
        on(title, "pointerdown", (e) => {
          if (e.button === 0) dragView(active.id, e, title);
        }),
      );
    // Right-click the title (D190, as VS Code's view titles): the view's own actions, hiding it,
    // and the sidebar's place. Every view has it, extensions' too.
    this.headerStore.add(
      on(this.header, "contextmenu", (e) => {
        e.preventDefault();
        if (!active) return;
        const exec = (command: string, input: unknown = {}) =>
          void this.dispatcher.execute(command, input).catch(() => {});
        const items: MenuItem[] = (active.actions ?? [])
          .filter((a) => !a.menu)
          .map((a) => ({
            label: a.title,
            icon: a.icon,
            run: () => exec(a.command, a.input ?? {}),
          }));
        for (const [i, m] of (active.menu?.() ?? []).entries())
          items.push({
            label: m.label,
            destructive: m.danger,
            separatorBefore: i === 0 || m.separatorBefore,
            run: () => exec(m.command, m.input ?? {}),
          });
        if (active.movable)
          items.push({
            label: "Move to the dock",
            icon: "panel-bottom",
            separatorBefore: items.length > 0,
            run: () => exec("view.moveView", { id: active.id, to: "dock" }),
          });
        items.push(
          {
            label: `Hide "${active.title}" from the activity bar`,
            icon: "eye-off",
            separatorBefore: items.length > 0,
            run: () => exec("view.setHidden", { id: active.id, hidden: true }),
          },
          {
            label: "Hide sidebar",
            icon: "panel-left",
            run: () => exec("layout.toggleSidebar"),
          },
          {
            label: "Move sidebar to the other side",
            icon: "arrow-left-right",
            run: () => exec("layout.toggleSidebarPosition"),
          },
        );
        this.headerStore.add(showContextMenu(e.clientX, e.clientY, items));
      }),
    );
  }

  dispose(): void {
    for (const section of this.sections.values()) section.store.dispose();
    this.sections.clear();
    this.store.dispose();
  }
}

interface DockedSection {
  hostId: string;
  store: DisposableStore;
  update(state: SectionState): void;
  element: HTMLElement;
  /** Shows or hides the top edge (a collapsed section resizes the open one below it). */
  syncEdge(): void;
}

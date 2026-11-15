// The sidebar views' registry: what extensions contribute (a descriptor that can create the view)
// and the views' shared state (active, hidden, order, badges, progress, sections). It never mounts
// anything: ViewContainer (views.ts) does, on a screen. DOM-free.
import { type Disposable, toDisposable } from "../core/lifecycle/index";
import { batch, type Signal, signal } from "../core/reactive/index";
import type { IconName } from "../ui/Icon";
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

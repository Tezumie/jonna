// Dock view types (docs/dock.md §2). Extensions register a descriptor per view type; the dock
// creates one live instance per tab (lazily, when the tab is first shown) and keeps it alive —
// across moves between groups — until the tab closes.
import type { Json, Placement } from "../../core/dock/index";
import type { Event } from "../../core/events/index";
import { type Disposable, toDisposable } from "../../core/lifecycle/index";
import type { IconName } from "../../ui/Icon";

export interface DockViewContext {
  readonly tabId: string;
  /** Ask the dock to persist a new view state (e.g. the editor's path after a rename). */
  updateState(state: Json): void;
  /** Close this tab (e.g. a terminal whose process exited and the user pressed a key). */
  close(): void;
  /** Pin a preview tab (the user edited it). */
  pin(): void;
  /** Briefly flash the tab (visual terminal bell). */
  flash(): void;
}

/**
 * A button a tab adds to its group's toolbar while it is the active tab (left of the group's own
 * ⋯ / split / maximize), e.g. a terminal's "New terminal" or a Markdown file's "Open preview".
 * It runs a dispatcher command, like every other button.
 */
export interface TabAction {
  icon: IconName;
  /** An image URL drawn instead of `icon` (an extension's own icon file, D262). */
  iconImage?: string;
  title: string;
  command: string;
  /** The command's input; a value "$tab" is replaced by the id of the tab the action belongs to. */
  input?: unknown;
  /**
   * A narrow ▾ beside the action before it (the terminal's "+ ▾" profile menu): the command gets
   * `x` / `y`, the button's bottom left, to open its menu there.
   */
  dropdown?: boolean;
}

export interface DockView extends Disposable {
  /** The view's root element; the dock moves it between groups instead of recreating it. */
  readonly element: HTMLElement;
  update?(state: Json): void;
  onShow?(): void;
  /** The tab was double-clicked; true if the view handled it (else it's kept open, "pinned"). */
  onTabDoubleClick?(): boolean;
  onHide?(): void;
  /** Called after the view's slot changed size or moved to another group. */
  onResize?(): void;
  /** The view's element moved into another window (an auxiliary window, or back). */
  onWindowChanged?(win: Window): void;
  focus?(): void;
  serialize(): Json;
  /** False for transient tabs that should not come back after a restart. */
  persist?(): boolean;
  /** Shown in the tab instead of the descriptor's title (e.g. a terminal's process title). */
  title?(): string;
  /** Dirty dot in the tab. */
  isDirty?(): boolean;
  /**
   * Still getting ready (a terminal whose shell hasn't drawn its prompt yet): the tab shows a
   * spinner instead of its icon, so a blank view says what it's doing. Fire onDidChange when it
   * changes.
   */
  busy?(): boolean;
  /** Toolbar actions that depend on the live view (fire onDidChange when they change). */
  actions?(): TabAction[];
  /** Fires when title, dirty state or actions changed. */
  readonly onDidChange?: Event<void>;
  /** Asked before the tab closes (unsaved changes). Return false to keep it open. */
  confirmClose?(): Promise<boolean>;
}

export interface DockViewDescriptor {
  type: string;
  title(state: Json): string;
  icon(state: Json): IconName;
  /**
   * A custom tab icon element (e.g. the app logo on the welcome tab, a chat's agent faces) instead
   * of `icon`; undefined: `icon`.
   */
  iconElement?(state: Json): HTMLElement | undefined;
  /** Working now (a chat whose agent is answering): the tab's title shimmers (D401). */
  working?(state: Json): boolean;
  /** `--file-icon-<tint>` color for the tab icon (DESIGN.md §9). */
  tint?(state: Json): string | undefined;
  /** The file the tab shows (absolute path), for git colors and badges on the tab. */
  resource?(state: Json): string | undefined;
  /** Tab tooltip (default: the title), e.g. the file's full path. */
  tooltip?(state: Json): string;
  /** At most one tab of this type (e.g. "agent" for now, "problems" later). */
  singleton?: boolean;
  /**
   * A new preview tab replaces only previews of the same kind in its group (default: one kind for
   * every view, VS Code's single preview). The channel and the thread tabs have kinds of their own
   * so one doesn't close the other (D244).
   */
  previewKind?: string;
  /** Where a new tab of this type goes when no placement is given. */
  defaultPlacement?: Placement;
  /** Editor-like: counts for "the main region never disappears" (docs/dock.md §5). */
  editorLike?: boolean;
  /** Toolbar actions for tabs of this type (see TabAction); the live view's own come after. */
  actions?(state: Json): TabAction[];
  /** Can it move into a window of its own (`layout.moveToNewWindow`, D101)? */
  detachable?: boolean;
  /** Can `layout.splitActive` duplicate it (open the same content in a new group)? */
  duplicate?(state: Json): Json | null;
  create(state: Json, ctx: DockViewContext): DockView;
}

export class DockViewRegistry {
  private readonly descriptors = new Map<string, DockViewDescriptor>();

  register(descriptor: DockViewDescriptor): Disposable {
    if (this.descriptors.has(descriptor.type))
      throw new Error(`View type already registered: ${descriptor.type}`);
    this.descriptors.set(descriptor.type, descriptor);
    return toDisposable(() => this.descriptors.delete(descriptor.type));
  }

  get(type: string): DockViewDescriptor | undefined {
    return this.descriptors.get(type);
  }

  types(): string[] {
    return [...this.descriptors.keys()].sort();
  }
}

/** A minimal JSON object reader for view states (they come from disk and agents). */
export function stateField(state: Json, key: string): Json | undefined {
  return state !== null && typeof state === "object" && !Array.isArray(state)
    ? state[key]
    : undefined;
}

// The "terminal" dock view: a tab with one or more terminals side by side (D209, VS Code's
// terminal groups). Each terminal is a TerminalPane (pane.ts); a sash between two resizes them
// (split.ts has the math). Splitting adds a pane after the active one, closing one keeps the
// others, "Unsplit" moves a pane into a tab of its own with its shell still running. The tab's
// title is the group's (the panes' titles joined). Sets `terminalFocus` and
// `terminalSplitPaneActive`.
import type { Json } from "../../core/dock/index";
import { h } from "../../core/dom/index";
import { Emitter } from "../../core/events/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { Sash } from "../../ui/Sash";
import type {
  DockView,
  DockViewContext,
  DockViewDescriptor,
  TabAction,
} from "../../workbench/dock/views";
import { stateField } from "../../workbench/dock/views";
import { type PaneOwner, TerminalPane } from "./pane";
import type { TerminalInstance } from "./service";
import {
  groupTitle,
  normalizeSizes,
  orientationFor,
  paneRestoreKey,
  parseGroupState,
  resizeAtSash,
  type SplitOrientation,
  serializeGroup,
  sizesAfterAdd,
  sizesAfterRemove,
  withoutPty,
} from "./split";
import {
  TERMINAL_COLORS,
  TERMINAL_ICONS,
  type TerminalColor,
  type TerminalIcon,
  type TerminalViewHost,
} from "./viewHost";

export type { TerminalPane } from "./pane";
export type { TerminalColor, TerminalIcon, TerminalViewHost } from "./viewHost";
export { TERMINAL_COLORS, TERMINAL_ICONS } from "./viewHost";

/** Panes on their way into a new tab, with the group's sizes and active pane. */
export interface PaneHandoff {
  panes: TerminalPane[];
  sizes: number[];
  active: number;
}

/**
 * Panes on their way from one tab to a new one ("Unsplit", a hidden terminal shown again,
 * D217): the new tab's state names the key, its view takes the panes (and their running shells)
 * instead of starting new ones.
 */
const handoff = new Map<string, PaneHandoff>();
let nextHandoff = 1;

/**
 * Parks panes for the tab about to open with the returned state. Nobody picking them up within
 * 10 s (the tab couldn't open) calls `unclaimed`, so they aren't left running unseen.
 */
export function handOffPanes(group: PaneHandoff, unclaimed: (group: PaneHandoff) => void): Json {
  const key = `handoff-${nextHandoff++}`;
  handoff.set(key, group);
  setTimeout(() => {
    if (handoff.get(key) === group) {
      handoff.delete(key);
      unclaimed(group);
    }
  }, 10_000);
  return { adopt: key };
}

const colorOf = (state: Json): TerminalColor | undefined => {
  const c = stateField(state, "color");
  return TERMINAL_COLORS.find((x) => x === c);
};
const iconOf = (state: Json): TerminalIcon | undefined => {
  const i = stateField(state, "icon");
  return TERMINAL_ICONS.find((x) => x === i);
};

export function terminalViewDescriptor(host: TerminalViewHost): DockViewDescriptor {
  return {
    type: "terminal",
    title: () => "Terminal",
    icon: (state) => iconOf(state) ?? "square-terminal",
    tint: (state) => {
      const c = colorOf(state);
      return c ? `term-${c}` : undefined;
    },
    defaultPlacement: "bottom",
    duplicate: (state) => withoutPty(state),
    create: (state, ctx) => new TerminalView(state, ctx, host),
  };
}

export class TerminalView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly changed = this.store.add(new Emitter<void>());
  readonly onDidChange = this.changed.event;
  /** The terminals of this tab, in order (left to right, or top to bottom). */
  readonly panes: TerminalPane[] = [];
  private sizes: number[] = [];
  private activeIndex = 0;
  private visible = false;
  private orientation: SplitOrientation = "row";
  private readonly sashes = this.store.add(new DisposableStore());
  private readonly owner: PaneOwner;
  /** Resolves when the first terminal's shell runs (rejects if it couldn't start). */
  readonly ready: Promise<TerminalInstance>;

  constructor(
    state: Json,
    private readonly ctx: DockViewContext,
    private readonly host: TerminalViewHost,
  ) {
    this.element = h("div", { class: "terminal-view is-row" });
    const tab = this;
    this.owner = {
      get tabId() {
        return tab.ctx.tabId;
      },
      paneChanged: () => this.save(),
      paneFocused: (pane) => this.paneFocused(pane),
      flash: () => this.ctx.flash(),
      paneCount: () => this.panes.length,
      isVisible: () => this.visible,
    };
    host.tabs.set(ctx.tabId, this);
    // Only our own entry: a tab restored with the same id may already have replaced it.
    this.store.add({
      dispose: () => {
        if (host.tabs.get(ctx.tabId) === this) host.tabs.delete(ctx.tabId);
      },
    });
    const adopt = stateField(state, "adopt");
    const moved = typeof adopt === "string" ? handoff.get(adopt) : undefined;
    if (moved && typeof adopt === "string") {
      handoff.delete(adopt);
      for (const pane of moved.panes) {
        pane.rehome(this.owner);
        this.panes.push(pane);
      }
      this.sizes = normalizeSizes(moved.sizes, this.panes.length);
      this.activeIndex = Math.max(0, Math.min(this.panes.length - 1, moved.active));
      // The tab's own state from now on (the hand-off key means nothing after this).
      queueMicrotask(() => this.save());
    } else {
      const group = parseGroupState(state);
      group.panes.forEach((p, i) => {
        this.panes.push(new TerminalPane(p, this.owner, host, paneRestoreKey(ctx.tabId, i)));
      });
      this.sizes = group.sizes;
      this.activeIndex = group.active;
    }
    const first = this.panes[0];
    // Another terminal tab dropped on this one's middle joins it as splits (VS Code drags a
    // terminal onto another to split, D232); near the edges the dock splits as for any tab.
    this.store.add(
      host.tabDropTarget(
        this.element,
        (tab) => tab.viewType === "terminal" && tab.tabId !== ctx.tabId,
        (tabId) => {
          const ids = (host.tabs.get(tabId)?.panes ?? []).flatMap((p) =>
            p.instance ? [p.instance.id] : [],
          );
          const into = this.active.instance?.id;
          if (ids.length && into !== undefined) host.run("terminal.join", { ids, into });
        },
      ),
    );
    this.ready = first ? first.ready : Promise.reject(new Error("No terminal in the tab"));
    this.ready.catch(() => {});
    this.layout();
  }

  /** The pane the keyboard and the toolbar act on. */
  get active(): TerminalPane {
    const pane = this.panes[this.activeIndex] ?? this.panes[0];
    if (!pane) throw new Error("No terminal in the tab");
    return pane;
  }

  /** The active pane's terminal. */
  get instance(): TerminalInstance | undefined {
    return this.panes[this.activeIndex]?.instance;
  }

  get tabId(): string {
    return this.ctx.tabId;
  }

  /** Adds a terminal after `after` (default: the active one), focused; resolves once it runs. */
  split(state: Json, after = this.activeIndex, focus = true): TerminalPane {
    const at = Math.max(0, Math.min(this.panes.length, after + 1));
    // A new pane's saved-output key is past the existing ones (it has no saved output anyway).
    const pane = new TerminalPane(
      state,
      this.owner,
      this.host,
      paneRestoreKey(this.ctx.tabId, 1000 + this.panes.length),
    );
    this.panes.splice(at, 0, pane);
    this.sizes = sizesAfterAdd(this.panes.length - 1);
    this.activeIndex = at;
    this.layout();
    this.save();
    if (focus) pane.focus();
    return pane;
  }

  /** Closes one terminal (its shell is killed); the last one closes the tab. */
  removePane(pane: TerminalPane): void {
    const index = this.panes.indexOf(pane);
    if (index < 0) return;
    if (this.panes.length === 1) {
      this.host.run("layout.closeTab", { tabId: this.ctx.tabId });
      return;
    }
    const hadFocus = pane.element.contains(document.activeElement);
    this.panes.splice(index, 1);
    pane.dispose();
    this.sizes = sizesAfterRemove(this.sizes, index);
    if (this.activeIndex >= index) this.activeIndex = Math.max(0, this.activeIndex - 1);
    if (this.activeIndex >= this.panes.length) this.activeIndex = this.panes.length - 1;
    this.layout();
    this.save();
    this.syncSplitKey();
    if (hadFocus) this.active.focus();
  }

  /**
   * Takes a pane out of this tab for another one ("Unsplit"): returns the state the new tab is
   * opened with; its view picks the pane up, shell and all.
   */
  detachPane(pane: TerminalPane): Json | null {
    if (!this.takePane(pane)) return null;
    return handOffPanes({ panes: [pane], sizes: [1], active: 0 }, () => pane.dispose());
  }

  /**
   * Takes one pane out of a split tab, its shell still running (Unsplit, Join, hiding one pane;
   * D229): the caller gives it a new owner. False when it isn't here or is the last one (the
   * caller takes the whole tab then: `detachAll`).
   */
  takePane(pane: TerminalPane): boolean {
    const index = this.panes.indexOf(pane);
    if (index < 0 || this.panes.length < 2) return false;
    const hadFocus = pane.element.contains(document.activeElement);
    this.panes.splice(index, 1);
    pane.element.remove();
    this.sizes = sizesAfterRemove(this.sizes, index);
    if (this.activeIndex > index) this.activeIndex--;
    if (this.activeIndex >= this.panes.length) this.activeIndex = this.panes.length - 1;
    this.layout();
    this.save();
    this.syncSplitKey();
    if (hadFocus) this.active.focus();
    return true;
  }

  /**
   * Panes from other tabs joined into this one after the active pane (VS Code's "Join
   * terminals", D229), shells still running; the panes share the space equally again.
   */
  adoptPanes(panes: readonly TerminalPane[], focus = false): void {
    if (!panes.length) return;
    const at = Math.min(this.panes.length, this.activeIndex + 1);
    for (const pane of panes) pane.rehome(this.owner);
    this.panes.splice(at, 0, ...panes);
    this.sizes = sizesAfterAdd(this.panes.length - 1);
    this.activeIndex = at + panes.length - 1;
    this.layout();
    this.save();
    if (focus) this.active.focus();
  }

  /**
   * Takes every pane out of the tab, shells still running ("Hide terminal", D217): the caller
   * keeps them and closes the now empty tab.
   */
  detachAll(): PaneHandoff {
    const group = { panes: this.panes.splice(0), sizes: [...this.sizes], active: this.activeIndex };
    // A removed element doesn't always report its focus leaving.
    if (this.element.contains(document.activeElement))
      this.host.context.set("terminalFocus", false);
    for (const pane of group.panes) pane.element.remove();
    this.sizes = [];
    this.activeIndex = 0;
    this.sashes.clear();
    this.element.replaceChildren();
    this.host.context.set("terminalSplitPaneActive", false);
    return group;
  }

  /** Focuses pane `index` (wraps nothing; see split.ts neighbourPane). */
  focusPane(index: number): TerminalPane | undefined {
    const pane = this.panes[index];
    if (!pane) return undefined;
    this.activeIndex = index;
    pane.focus();
    this.save();
    return pane;
  }

  get activePaneIndex(): number {
    return this.activeIndex;
  }

  /** The panes' sizes (fractions), for ide://terminals. */
  paneSizes(): readonly number[] {
    return this.sizes;
  }

  /** New sizes (terminal.resizePane), saved with the tab. */
  setSizes(sizes: readonly number[]): void {
    if (sizes.length !== this.panes.length) return;
    this.sizes = normalizeSizes(sizes, this.panes.length);
    this.applySizes();
    this.save();
  }

  private paneFocused(pane: TerminalPane): void {
    const index = this.panes.indexOf(pane);
    if (index >= 0 && index !== this.activeIndex) {
      this.activeIndex = index;
      this.save();
    }
    this.syncSplitKey();
  }

  /** `terminalSplitPaneActive` (VS Code's): the focused terminal has a neighbour (Alt+arrows move). */
  private syncSplitKey(): void {
    if (this.element.contains(document.activeElement) || this.panes.length < 2)
      this.host.context.set(
        "terminalSplitPaneActive",
        this.panes.length > 1 && this.element.contains(document.activeElement),
      );
  }

  /** Lays the panes out with a sash between each two (rebuilt on every split and close). */
  private layout(): void {
    this.sashes.clear();
    const children: HTMLElement[] = [];
    this.panes.forEach((pane, i) => {
      pane.element.style.flex = `${this.sizes[i] ?? 1} 1 0px`;
      children.push(pane.element);
    });
    this.element.replaceChildren(...children);
    for (let i = 0; i < this.panes.length - 1; i++) {
      const next = this.panes[i + 1];
      if (!next) continue;
      let start: number[] = [...this.sizes];
      const sash = this.sashes.add(
        new Sash(this.element, {
          orientation: this.orientation === "row" ? "vertical" : "horizontal",
          onStart: () => {
            start = [...this.sizes];
          },
          onDrag: (delta) => {
            const box = this.element.getBoundingClientRect();
            const total =
              (this.orientation === "row" ? box.width : box.height) - (this.panes.length - 1);
            this.sizes = resizeAtSash(start, i, delta, total);
            this.applySizes();
          },
          onEnd: () => {
            this.save();
            for (const p of this.panes) p.onResize();
          },
          onReset: () => {
            this.sizes = sizesAfterAdd(this.panes.length - 1);
            this.applySizes();
            this.save();
          },
        }),
      );
      sash.element.classList.add("terminal-sash");
      this.element.insertBefore(sash.element, next.element);
    }
    this.element.classList.toggle("is-split", this.panes.length > 1);
    if (this.visible) for (const p of this.panes) p.onResize();
    this.changed.fire();
  }

  private applySizes(): void {
    this.panes.forEach((pane, i) => {
      pane.element.style.flex = `${this.sizes[i] ?? 1} 1 0px`;
    });
    for (const p of this.panes) p.onResize();
  }

  /** A pane's shell is still starting: the tab shows a spinner (DockView.busy). */
  busy(): boolean {
    return this.panes.some((p) => p.starting);
  }

  private save(): void {
    if (this.store.isDisposed) return;
    this.ctx.updateState(this.serialize());
    this.changed.fire();
  }

  /** New terminal, profiles, split, clear and kill in the group toolbar (VS Code's terminal panel). */
  actions(): TabAction[] {
    const id = this.instance?.id;
    return [
      { icon: "plus", title: "New terminal", command: "terminal.create" },
      // VS Code's "+ ▾": the profiles, the default one, terminal settings.
      {
        icon: "chevron-down",
        title: "Launch profile…",
        command: "terminal.profileMenu",
        dropdown: true,
      },
      ...(id !== undefined
        ? [
            {
              // The terminal's own split glyph (D217): this split adds a shell to the tab,
              // unlike the editor's split.
              icon: "terminal-split" as const,
              title: `Split terminal${this.host.keybinding("terminal.split") ? ` (${this.host.keybinding("terminal.split")})` : ""}`,
              command: "terminal.split",
              input: { id },
            },
            {
              icon: "ban" as const,
              title: "Clear terminal",
              command: "terminal.clear",
              input: { id },
            },
            {
              icon: "trash-2" as const,
              title: "Kill terminal",
              command: "terminal.kill",
              input: { id },
            },
            // VS Code's panel ×: the tab goes, its shells keep running (the ▾ menu shows it again).
            {
              icon: "x" as const,
              title: "Hide terminal (keeps running)",
              command: "terminal.hide",
              input: { id },
            },
          ]
        : []),
    ];
  }

  title(): string {
    return this.panes.length > 1
      ? groupTitle(this.panes.map((p) => p.title()))
      : (this.panes[0]?.title() ?? "Terminal");
  }

  /** How the panes are laid out: "row" side by side, "column" stacked. */
  get splitOrientation(): SplitOrientation {
    return this.orientation;
  }

  onShow(): void {
    this.visible = true;
    this.onResize();
  }

  onHide(): void {
    this.visible = false;
  }

  onResize(): void {
    if (!this.visible) return;
    const box = this.element.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) {
      const next = orientationFor(box.width, box.height, this.host.splitDirection());
      if (next !== this.orientation) {
        this.orientation = next;
        this.element.classList.toggle("is-row", next === "row");
        this.element.classList.toggle("is-column", next === "column");
        if (this.panes.length > 1) this.layout();
      }
    }
    for (const p of this.panes) p.onResize();
  }

  /** Double-clicking the tab renames the active terminal (VS Code). */
  onTabDoubleClick(): boolean {
    const t = this.instance;
    if (!t) return false;
    this.host.run("terminal.rename", { id: t.id });
    return true;
  }

  focus(): void {
    this.panes[this.activeIndex]?.focus();
  }

  /** A tab of transient terminals only (an extension's, D388) isn't restored. */
  persist(): boolean {
    return this.panes.some((p) => !p.transient);
  }

  serialize(): Json {
    return serializeGroup(
      this.panes.map((p) => p.serialize()),
      this.activeIndex,
      this.sizes,
    );
  }

  dispose(): void {
    for (const p of this.panes.splice(0)) p.dispose();
    this.store.dispose();
    // The tab's element goes too (a closed folder's terminals were left in the page).
    this.element.remove();
  }
}

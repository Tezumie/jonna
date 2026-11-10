// Drag and drop for dock tabs and files from the explorer (docs/dock.md §4). Computes drop zones
// (tab strip insertion, group center, group edges, dock edges), animates one preview rectangle
// between them, and commits through `layout.moveTab` / `layout.openView` — the same commands
// keyboard and agents use.
import { dropIndex, type Side, type TabTarget } from "../../core/dock/index";
import { h, on } from "../../core/dom/index";
import { type Disposable, DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { GroupLift } from "./lift";
import type { DockRenderer } from "./render";

const THRESHOLD = 4;
const DOCK_EDGE = 16;
/** Over a tab strip at the dock's top, only this close to the edge splits the whole dock up. */
const TOP_EDGE_OVER_STRIP = 4;
/** How far above the dock (title bar, menus) a dragged tab still lands in the strip below. */
const HEADER_REACH = 48;
/** Where in a strip a tab dropped from above the dock is taken to be (px below its top). */
const STRIP_PROBE = 10;

export type DragPayload =
  | { kind: "tab"; tabId: string; viewType: string }
  /** Explorer rows: `paths` when several are dragged (the selection); folders allowed (D190). */
  | { kind: "file"; path: string; paths?: string[] }
  | { kind: "group"; groupId: string }
  /** A movable sidebar view dragged by its header (D233): dropped on the dock, it becomes a tab. */
  | { kind: "view"; viewId: string }
  /**
   * Things a sidebar list opens as tabs (D377: chats from the Chats list): each an open tab to
   * move there, or a view to open there.
   */
  | { kind: "views"; items: ({ tabId: string } | { viewType: string; state: unknown })[] };

type Zone =
  | { kind: "target"; target: FileDropTarget; rect: DOMRect }
  | { kind: "tabTarget"; target: TabDropTarget; rect: DOMRect }
  | { kind: "insert"; groupId: string; index: number; caret: DOMRect; strip: DOMRect }
  | { kind: "center"; groupId: string; rect: DOMRect }
  | { kind: "split"; groupId: string; side: Side; rect: DOMRect }
  | { kind: "root"; side: Side; rect: DOMRect };

/** An element that takes files dragged from the explorer (the agent chat attaches them, D131). */
interface FileDropTarget {
  element: HTMLElement;
  drop(path: string): void;
}

/**
 * An element inside a tab that takes another dock tab dropped on its middle (a terminal joins
 * the dragged terminal as a split, D232); its group's edges still split the dock.
 */
interface TabDropTarget {
  element: HTMLElement;
  accepts(tab: { tabId: string; viewType: string }): boolean;
  drop(tabId: string): void;
}

export interface DragDeps {
  renderer: DockRenderer;
  overlay: HTMLElement;
  run(command: string, input: unknown): void;
  /** The same, with the command's result (where several things dropped together went). */
  runForResult?(command: string, input: unknown): Promise<unknown>;
}

/**
 * Whether a pointer last seen at (x, y) left through the window's edge. The last event before
 * leaving can be a few pixels inside; a native child view in the middle of the window (the
 * browser pane) doesn't count.
 */
export function leftWindow(
  x: number,
  y: number,
  width: number,
  height: number,
  margin = 24,
): boolean {
  return x <= margin || y <= margin || x >= width - margin || y >= height - margin;
}

export class DockDragController implements Disposable {
  private readonly store = new DisposableStore();
  private readonly drag = this.store.add(new DisposableStore());
  private readonly preview: HTMLElement;
  private readonly caret: HTMLElement;
  private readonly fileTargets = new Set<FileDropTarget>();
  private readonly tabTargets = new Set<TabDropTarget>();

  constructor(private readonly deps: DragDeps) {
    this.preview = h("div", { class: "dock-drop-preview", hidden: true });
    this.caret = h("div", { class: "dock-drop-caret", hidden: true });
    deps.overlay.append(this.preview, this.caret);
    this.store.add(
      toDisposable(() => {
        this.preview.remove();
        this.caret.remove();
      }),
    );
  }

  /**
   * Arms a drag on pointerdown; it starts after the pointer moves THRESHOLD px. A tab or file drag
   * shows a label ghost; a group drag (`source` = the group element) lifts the live group itself.
   */
  arm(payload: DragPayload, down: PointerEvent, source: HTMLElement, label: string): void {
    this.drag.clear();
    const startX = down.clientX;
    const startY = down.clientY;
    let ghost: HTMLElement | undefined;
    let lift: GroupLift | undefined;
    let zone: Zone | undefined;
    const finish = (commit: boolean) => {
      const go = commit && zone ? zone : undefined;
      if (lift) {
        const l = lift;
        lift = undefined;
        l.end(go ? () => this.commit(payload, go) : undefined);
      } else if (ghost && go) this.commit(payload, go);
      this.drag.clear();
    };
    this.drag.add(
      on(window, "pointermove", (e) => {
        if (!ghost && !lift) {
          if (Math.hypot(e.clientX - startX, e.clientY - startY) < THRESHOLD) return;
          if (payload.kind === "group") {
            document.body.classList.add("is-dragging", "is-dragging-group");
            lift = new GroupLift(source, this.deps.renderer.element, { x: startX, y: startY });
          } else ghost = this.startGhost(source, label);
        }
        if (lift) lift.move(e.clientX, e.clientY);
        if (ghost) ghost.style.transform = `translate(${e.clientX + 8}px, ${e.clientY + 8}px)`;
        zone = this.zoneAt(e.clientX, e.clientY, payload);
        this.showZone(zone);
      }),
    );
    this.drag.add(on(window, "pointerup", () => finish(true)));
    // Explorer files dragged out of the window go to other apps as a real OS drag (D200; Zed
    // 1.15, VS Code). Inside the window the drag stays ours (tabs, the tree, the chat).
    if (payload.kind === "file")
      this.drag.add(
        on(document, "mouseout", (e) => {
          if (!ghost || e.relatedTarget !== null || !(e.buttons & 1)) return;
          if (!leftWindow(e.clientX, e.clientY, window.innerWidth, window.innerHeight)) return;
          const paths = payload.paths ?? [payload.path];
          finish(false);
          // The tree's own move drag ends too (it listens for pointercancel).
          window.dispatchEvent(new PointerEvent("pointercancel"));
          this.deps.run("explorer.dragOut", { paths });
        }),
      );
    this.drag.add(on(window, "pointercancel", () => finish(false)));
    this.drag.add(
      on(
        window,
        "keydown",
        (e) => {
          if (e.key === "Escape" && (ghost || lift)) {
            e.preventDefault();
            e.stopPropagation();
            finish(false);
          }
        },
        { capture: true },
      ),
    );
    this.drag.add(
      toDisposable(() => {
        ghost?.remove();
        lift?.end();
        source.classList.remove("is-drag-source");
        document.body.classList.remove("is-dragging", "is-dragging-group");
        this.preview.hidden = true;
        this.caret.hidden = true;
        this.preview.classList.remove("is-visible");
      }),
    );
  }

  private startGhost(source: HTMLElement, label: string): HTMLElement {
    source.classList.add("is-drag-source");
    document.body.classList.add("is-dragging");
    const ghost = h("div", { class: "dock-drag-ghost" }, label);
    document.body.appendChild(ghost);
    return ghost;
  }

  /** Files dragged from the explorer and dropped on `element` go to `drop` (not to an editor). */
  addFileTarget(element: HTMLElement, drop: (path: string) => void): Disposable {
    const target = { element, drop };
    this.fileTargets.add(target);
    return toDisposable(() => this.fileTargets.delete(target));
  }

  /** Dock tabs dropped on the middle of `element` go to `drop` when `accepts` takes them. */
  addTabTarget(
    element: HTMLElement,
    accepts: TabDropTarget["accepts"],
    drop: TabDropTarget["drop"],
  ): Disposable {
    const target = { element, accepts, drop };
    this.tabTargets.add(target);
    return toDisposable(() => this.tabTargets.delete(target));
  }

  private tabTargetAt(
    x: number,
    y: number,
    payload: DragPayload,
    outsideDock = false,
  ): Zone | undefined {
    if (payload.kind !== "tab") return undefined;
    for (const target of this.tabTargets) {
      // Targets outside the dock (the sidebar takes back a moved view, D233) are checked before
      // the dock's zones; those inside only in a group's middle.
      if (outsideDock === this.deps.renderer.element.contains(target.element)) continue;
      if (!target.element.isConnected || !target.element.offsetParent) continue;
      const rect = target.element.getBoundingClientRect();
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
      if (target.accepts(payload)) return { kind: "tabTarget", target, rect };
    }
    return undefined;
  }

  private zoneAt(x: number, pointerY: number, payload: DragPayload): Zone | undefined {
    let y = pointerY;
    if (payload.kind === "file")
      for (const target of this.fileTargets) {
        if (!target.element.isConnected || !target.element.offsetParent) continue;
        const rect = target.element.getBoundingClientRect();
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)
          return { kind: "target", target, rect };
      }
    const outside = this.tabTargetAt(x, y, payload, true);
    if (outside) return outside;
    const dockRect = this.deps.renderer.element.getBoundingClientRect();
    // Above the dock (the title bar, the menus): a tab there goes into the tab strip below it,
    // so reordering along the top doesn't need a steady hand (D189).
    if (
      payload.kind === "tab" &&
      y < dockRect.top &&
      y >= dockRect.top - HEADER_REACH &&
      x >= dockRect.left &&
      x <= dockRect.right
    )
      y = dockRect.top + STRIP_PROBE;
    if (x < dockRect.left || x > dockRect.right || y < dockRect.top || y > dockRect.bottom)
      return undefined;
    // Dock edges: split at the root (full height/width). Along the top, only the dock's very
    // edge does it: just below are tab strips, where a dragged tab is being reordered.
    const overStrip = this.deps.renderer.allGroupElements().some((g) => {
      const r = g.strip.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
    const edges: [Side, number][] = [
      ["left", x - dockRect.left],
      ["right", dockRect.right - x],
      ["top", y - dockRect.top],
      ["bottom", dockRect.bottom - y],
    ];
    const edge = edges
      .filter(([side, d]) => d < (side === "top" && overStrip ? TOP_EDGE_OVER_STRIP : DOCK_EDGE))
      .sort((a, b) => a[1] - b[1])[0];
    if (edge) return { kind: "root", side: edge[0], rect: sideRect(dockRect, edge[0], 0.3) };

    for (const group of this.deps.renderer.allGroupElements()) {
      // A lifted group is under the pointer wherever it goes; it is never its own target.
      if (payload.kind === "group" && group.id === payload.groupId) continue;
      const strip = group.strip.getBoundingClientRect();
      const body = group.body.getBoundingClientRect();
      if (x >= strip.left && x <= strip.right && y >= strip.top && y <= strip.bottom) {
        const tabs = group
          .tabRects()
          .filter((t) => !(payload.kind === "tab" && t.tabId === payload.tabId));
        // In rows (a pinned row above the others) or in a column (tabs on the side, D279).
        const vertical = group.vertical;
        const index = dropIndex(
          tabs.map((t) => t.rect),
          x,
          y,
          vertical,
        );
        const all = group.tabRects();
        const before = tabs[index]?.rect;
        const last = all[all.length - 1]?.rect;
        let caret: DOMRect;
        if (vertical) {
          const caretY = before ? before.top : last ? last.bottom : strip.top;
          caret = new DOMRect(strip.left + 4, caretY - 1, strip.width - 8, 2);
        } else {
          // Beside the tab it lands before, or after the last tab of the row the pointer is in.
          const row = before ?? last;
          const caretX = before ? before.left : last ? last.right : strip.left;
          caret = row
            ? new DOMRect(caretX - 1, row.top + 2, 2, row.height - 4)
            : new DOMRect(caretX - 1, strip.top + 4, 2, strip.height - 8);
        }
        // Indices are in the target group's own list; moveTab accounts for the source slot.
        const realIndex = before
          ? all.findIndex((t) => t.tabId === tabs[index]?.tabId)
          : all.length;
        return { kind: "insert", groupId: group.id, index: realIndex, caret, strip };
      }
      if (x >= body.left && x <= body.right && y >= body.top && y <= body.bottom) {
        const rx = (x - body.left) / body.width;
        const ry = (y - body.top) / body.height;
        const sides: [Side, number][] = [
          ["left", rx],
          ["right", 1 - rx],
          ["top", ry],
          ["bottom", 1 - ry],
        ];
        const near = sides.filter(([, d]) => d < 0.25).sort((a, b) => a[1] - b[1])[0];
        if (near)
          return {
            kind: "split",
            groupId: group.id,
            side: near[0],
            rect: sideRect(body, near[0], 0.5),
          };
        return this.tabTargetAt(x, y, payload) ?? { kind: "center", groupId: group.id, rect: body };
      }
    }
    return undefined;
  }

  private showZone(zone: Zone | undefined): void {
    if (!zone) {
      this.preview.classList.remove("is-visible");
      this.caret.hidden = true;
      return;
    }
    if (zone.kind === "insert") {
      place(this.caret, zone.caret);
      this.caret.hidden = false;
      this.preview.classList.remove("is-visible");
      return;
    }
    this.caret.hidden = true;
    const firstShow = this.preview.hidden;
    this.preview.hidden = false;
    if (firstShow) this.preview.classList.add("is-instant");
    place(this.preview, zone.rect);
    // Force the first position without animation, then animate between zones (DESIGN §8.3).
    if (firstShow) void this.preview.offsetWidth;
    this.preview.classList.remove("is-instant");
    this.preview.classList.add("is-visible");
  }

  private commit(payload: DragPayload, zone: Zone): void {
    if (zone.kind === "target") {
      if (payload.kind === "file")
        for (const path of payload.paths ?? [payload.path]) zone.target.drop(path);
      return;
    }
    if (zone.kind === "tabTarget") {
      if (payload.kind === "tab") zone.target.drop(payload.tabId);
      return;
    }
    const to: TabTarget =
      zone.kind === "insert"
        ? { groupId: zone.groupId, index: zone.index }
        : zone.kind === "center"
          ? { groupId: zone.groupId }
          : zone.kind === "split"
            ? { groupId: zone.groupId, split: zone.side }
            : { root: zone.side };
    if (payload.kind === "tab") this.deps.run("layout.moveTab", { tabId: payload.tabId, to });
    else if (payload.kind === "group")
      this.deps.run("layout.moveGroup", { groupId: payload.groupId, to });
    else if (payload.kind === "view")
      this.deps.run("view.moveView", { id: payload.viewId, to: "dock", placement: to });
    else if (payload.kind === "views") void this.dropViews(payload.items, to);
    else
      this.deps.run("editor.openPaths", { paths: payload.paths ?? [payload.path], placement: to });
  }

  /**
   * Several dropped together (D377) go to one place (D379): the first makes the split or takes the
   * slot, the others join its group after it, in order (one split each, or reversed, before).
   */
  private async dropViews(
    items: Extract<DragPayload, { kind: "views" }>["items"],
    to: TabTarget,
  ): Promise<void> {
    const place = (item: (typeof items)[number], target: TabTarget) =>
      "tabId" in item
        ? { command: "layout.moveTab", input: { tabId: item.tabId, to: target } }
        : {
            command: "layout.openView",
            input: { viewType: item.viewType, state: item.state, placement: target },
          };
    const run = this.deps.runForResult;
    if (!run || items.length < 2) {
      for (const item of items) {
        const p = place(item, to);
        this.deps.run(p.command, p.input);
      }
      return;
    }
    let target = to;
    for (const [i, item] of items.entries()) {
      const p = place(item, target);
      const result = (await run(p.command, p.input).catch(() => null)) as {
        groupId?: string | null;
      } | null;
      const groupId = result?.groupId;
      if (!groupId) continue;
      target =
        "index" in to && "groupId" in to && to.index !== undefined
          ? { groupId, index: to.index + i + 1 }
          : { groupId };
    }
  }

  dispose(): void {
    this.store.dispose();
  }
}

function sideRect(r: DOMRect, side: Side, f: number): DOMRect {
  if (side === "left") return new DOMRect(r.left, r.top, r.width * f, r.height);
  if (side === "right") return new DOMRect(r.right - r.width * f, r.top, r.width * f, r.height);
  if (side === "top") return new DOMRect(r.left, r.top, r.width, r.height * f);
  return new DOMRect(r.left, r.bottom - r.height * f, r.width, r.height * f);
}

function place(el: HTMLElement, r: DOMRect): void {
  el.style.transform = `translate(${r.left}px, ${r.top}px)`;
  el.style.width = `${r.width}px`;
  el.style.height = `${r.height}px`;
}

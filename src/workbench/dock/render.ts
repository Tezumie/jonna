// Renders the dock tree. Structure (splits, which groups, hidden/maximized) is rebuilt only when
// it changes; otherwise only sizes and group contents update, so focused editors are never
// re-parented by an unrelated change. Splitters follow DESIGN.md §10 and docs/dock.md §5.

import type { DockNode } from "../../core/dock/index";
import * as dock from "../../core/dock/index";
import { h, on } from "../../core/dom/index";
import { type Disposable, DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { type GroupDeps, GroupElement } from "./group";
import { dragPair } from "./keepRightWidth";
import type { DockService } from "./service";

const MIN_WIDTH = 160;
const MIN_HEIGHT = 80;

export class DockRenderer implements Disposable {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly groups = new Map<string, GroupElement>();
  private readonly structure = this.store.add(new DisposableStore());
  /** Cells by split path + child index, for size updates without a rebuild. */
  private cells = new Map<string, HTMLElement>();
  private structureKey = "";

  constructor(
    host: HTMLElement,
    private readonly dock: DockService,
    private readonly deps: Omit<GroupDeps, "dock">,
  ) {
    this.element = h("div", { class: "dock", "aria-label": "Editor and panel area" });
    host.appendChild(this.element);
    this.store.add(toDisposable(() => this.element.remove()));
    this.store.add(
      effect(() => {
        const root = dock.root.value;
        const focused = dock.focusedGroupId.value;
        dock.decorations.value;
        dock.detached.value;
        dock.tabOptions.value;
        this.deps.decorations?.revision.value;
        this.render(root, focused);
        return undefined;
      }),
    );
    this.store.add(
      dock.onDidRequestFlash((tabId) => {
        const el = this.element.querySelector<HTMLElement>(
          `.dock-tab[data-tab-id="${CSS.escape(tabId)}"]`,
        );
        if (!el) return;
        el.classList.remove("is-bell");
        void el.offsetWidth;
        el.classList.add("is-bell");
      }),
    );
    this.store.add(
      dock.onDidRequestFocus((tabId) => {
        requestAnimationFrame(() => dock.liveView(tabId)?.focus?.());
      }),
    );
  }

  group(id: string): GroupElement | undefined {
    return this.groups.get(id);
  }

  allGroupElements(): GroupElement[] {
    return [...this.groups.values()].filter((g) => g.element.isConnected);
  }

  private render(root: DockNode, focused: string | null): void {
    const maximized = dock.allGroups(root).find((g) => g.maximized && !g.hidden);
    const key = JSON.stringify(this.shape(maximized ?? root));
    const rebuilt = key !== this.structureKey;
    if (rebuilt) {
      this.structureKey = key;
      this.structure.clear();
      this.cells = new Map();
      this.element.replaceChildren(this.build(maximized ?? root, []));
    } else {
      this.applySizes(maximized ?? root, []);
    }
    const live = new Set<string>();
    for (const node of dock.allGroups(root)) {
      if (node.hidden || (maximized && node !== maximized)) continue;
      live.add(node.id);
      const group = this.groupElement(node.id);
      group.update(node, node.id === focused, node === maximized);
      if (rebuilt) group.restoreScroll();
    }
    for (const [id, group] of this.groups) {
      if (!dock.findGroup(root, id)) {
        group.dispose();
        this.groups.delete(id);
      } else if (!live.has(id)) {
        group.element.remove();
      }
    }
  }

  /** Structural fingerprint: directions, child order, group ids (not sizes, tabs or focus). */
  private shape(node: DockNode): unknown {
    if (node.kind === "group") return node.hidden ? null : node.id;
    return [node.direction, node.children.map((c) => this.shape(c))];
  }

  private groupElement(id: string): GroupElement {
    let group = this.groups.get(id);
    if (!group) {
      const node = dock.findGroup(this.dock.root.peek(), id);
      if (!node) throw new Error(`No group ${id}`);
      group = new GroupElement(node, { ...this.deps, dock: this.dock });
      this.groups.set(id, group);
    }
    return group;
  }

  private build(node: DockNode, path: number[]): HTMLElement {
    if (node.kind === "group") return this.groupElement(node.id).element;
    const split = h("div", { class: `dock-split is-${node.direction}` });
    const visible = node.children.map((c, i) => ({ c, i })).filter(({ c }) => dock.isVisible(c));
    visible.forEach(({ c, i }, n) => {
      if (n > 0)
        split.appendChild(
          this.sash(
            node.direction,
            path,
            visible.map((v) => v.i),
            n,
          ),
        );
      const cell = h("div", { class: "dock-cell" }, this.build(c, [...path, i]));
      this.cells.set(`${path.join(".")}/${i}`, cell);
      split.appendChild(cell);
    });
    this.applySizes(node, path);
    return split;
  }

  private applySizes(node: DockNode, path: number[]): void {
    if (node.kind === "group") return;
    const total =
      node.children.reduce(
        (sum, c, i) => sum + (dock.isVisible(c) ? (node.sizes[i] ?? 0) : 0),
        0,
      ) || 1;
    node.children.forEach((child, i) => {
      const cell = this.cells.get(`${path.join(".")}/${i}`);
      if (cell) cell.style.flex = `${(node.sizes[i] ?? 0) / total} 1 0`;
      this.applySizes(child, [...path, i]);
    });
  }

  /** Splitter between visible children `n-1` and `n` (indices into the split's children). */
  private sash(
    direction: "row" | "column",
    path: number[],
    visibleIndices: number[],
    n: number,
  ): HTMLElement {
    const sash = h("div", {
      class: `dock-sash is-${direction}`,
      role: "separator",
      "aria-orientation": direction === "row" ? "vertical" : "horizontal",
    });
    const horizontal = direction === "row";
    this.structure.add(
      on(sash, "pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        sash.setPointerCapture(e.pointerId);
        sash.classList.add("is-active");
        document.body.classList.add(horizontal ? "is-resizing-vertical" : "is-resizing-horizontal");
        const cells = visibleIndices.map(
          (i) => this.cells.get(`${path.join(".")}/${i}`) as HTMLElement,
        );
        const sizes = cells.map((c) =>
          horizontal ? c.getBoundingClientRect().width : c.getBoundingClientRect().height,
        );
        const min = horizontal ? MIN_WIDTH : MIN_HEIGHT;
        const start = horizontal ? e.clientX : e.clientY;
        const a = n - 1;
        let current = [...sizes];
        const move = (ev: PointerEvent) => {
          const delta = (horizontal ? ev.clientX : ev.clientY) - start;
          current = [...sizes];
          [current[a], current[n]] = dragPair(sizes[a] ?? 0, sizes[n] ?? 0, delta, min);
          // Live preview by flex only; the tree is committed on release (no re-render per move).
          const sum = current.reduce((x, y) => x + y, 0);
          cells.forEach((c, i) => {
            c.style.flex = `${(current[i] ?? 0) / sum} 1 0`;
          });
        };
        // In the structure's store: a rebuild mid-drag (a tab closing on its own, an agent opening
        // one) removes this sash, and its pointerup never comes; the body's resize class (every
        // element click-through) must not stay on. The old path no longer applies then: no commit.
        const drag = this.structure.add(
          toDisposable(() => {
            sash.removeEventListener("pointermove", move);
            sash.removeEventListener("pointerup", end);
            sash.removeEventListener("pointercancel", end);
            sash.classList.remove("is-active");
            document.body.classList.remove("is-resizing-vertical", "is-resizing-horizontal");
          }),
        );
        const end = () => {
          this.structure.delete(drag);
          this.commitSizes(path, visibleIndices, current);
        };
        sash.addEventListener("pointermove", move);
        sash.addEventListener("pointerup", end);
        sash.addEventListener("pointercancel", end);
      }),
    );
    this.structure.add(on(sash, "dblclick", () => this.deps.run("layout.equalize", { path })));
    return sash;
  }

  /** Converts visible pixel sizes back to fractions (hidden children keep theirs). */
  private commitSizes(path: number[], visibleIndices: number[], px: number[]): void {
    const node = dock.nodeAt(this.dock.root.peek(), path);
    if (node?.kind !== "split") return;
    const visibleShare = visibleIndices.reduce((sum, i) => sum + (node.sizes[i] ?? 0), 0);
    const pxTotal = px.reduce((a, b) => a + b, 0) || 1;
    const sizes = [...node.sizes];
    visibleIndices.forEach((childIndex, k) => {
      sizes[childIndex] = ((px[k] ?? 0) / pxTotal) * visibleShare;
    });
    this.deps.run("layout.setSplitSizes", { path, sizes });
  }

  dispose(): void {
    for (const group of this.groups.values()) group.dispose();
    this.groups.clear();
    this.store.dispose();
  }
}

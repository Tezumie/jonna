// The agent's column keeps its width in pixels when the dock grows or shrinks (the window is
// maximized or resized, the sidebar shown or hidden), like VS Code's secondary side bar: the
// editor area takes the difference (D164). Only a top-level row whose last column holds the
// agent (or the "right" region group) is adjusted; other arrangements keep their proportions.
// Also the splitter's own math (dragPair, used by render.ts), kept here as it's DOM-free.

import type { DockNode } from "../../core/dock/index";
import * as dock from "../../core/dock/index";
import { type Disposable, toDisposable } from "../../core/lifecycle/index";
import type { DockService } from "./service";

/** The right column never takes more or less than this share of the dock. */
const MIN_SHARE = 0.08;
const MAX_SHARE = 0.6;

function holdsAgent(node: DockNode): boolean {
  return dock
    .allGroups(node)
    .some((g) => g.id === "right" || g.tabs.some((t) => t.viewType === "agent"));
}

/**
 * The new sizes of `root`'s row so its last column is `wantedPx` wide at `width` (default: the
 * pixels it had at `prevWidth`), within MIN_SHARE…MAX_SHARE of the dock.
 */
export function keptRightSizes(
  root: DockNode,
  prevWidth: number,
  width: number,
  wantedPx?: number,
): number[] | null {
  if (root.kind !== "split" || root.direction !== "row" || root.children.length < 2) return null;
  if (!(prevWidth > 0) || !(width > 0) || Math.abs(width - prevWidth) < 2) return null;
  const last = root.children[root.children.length - 1];
  if (!last || !holdsAgent(last)) return null;
  const share = root.sizes[root.sizes.length - 1] ?? 0;
  if (!(share > 0 && share < 1)) return null;
  const px = wantedPx !== undefined && wantedPx > 0 ? wantedPx : share * prevWidth;
  const next = Math.min(MAX_SHARE, Math.max(MIN_SHARE, px / width));
  if (!Number.isFinite(next)) return null;
  const restBefore = 1 - share;
  const rest = 1 - next;
  return [...root.sizes.slice(0, -1).map((s) => (s / restBefore) * rest), next];
}

/** The width (px) a layout's sizes were made for, by dock (applyBaseLayout tells, D174). */
const assumed = new WeakMap<DockService, (width: number) => void>();

/**
 * Says `service`'s sizes were just chosen for a dock `width` px wide (the base layout sizes the
 * agent for the width it's about to have): the next resize starts from there instead of scaling
 * that share a second time.
 */
export function assumeDockWidth(service: DockService, width: number): void {
  assumed.get(service)?.(width);
}

export function keepRightWidth(host: HTMLElement, service: DockService): Disposable {
  let last = host.clientWidth;
  /**
   * The right column's width as the user (or a layout) left it, in px: kept through a window
   * that got too narrow for it (the clamp), so it comes back when the window widens (D174).
   */
  let wanted: number | null = null;
  /** The share this applied last; a different one means someone else sized the column. */
  let applied: number | null = null;
  const observer = new ResizeObserver(() => {
    const width = host.clientWidth;
    const prev = last;
    last = width;
    const root = service.root.peek();
    const share = root.kind === "split" ? (root.sizes[root.sizes.length - 1] ?? 0) : 0;
    if (applied === null || Math.abs(share - applied) > 1e-6) wanted = share * prev;
    const sizes = keptRightSizes(root, prev, width, wanted ?? undefined);
    if (sizes) {
      applied = sizes[sizes.length - 1] ?? null;
      service.setSplitSizes([], sizes);
    }
  });
  observer.observe(host);
  assumed.set(service, (width) => {
    last = width;
    applied = null;
  });
  return toDisposable(() => {
    observer.disconnect();
    assumed.delete(service);
  });
}

/**
 * The two sizes either side of a splitter dragged by `delta` px: neither goes below `min`, or
 * below what it is now when it's already smaller (a small window). Clamping both to `min` when
 * they didn't fit snapped the first to `pair - min` on any move, and below zero when the pair was
 * under `min` (a negative size the command then refused).
 */
export function dragPair(a: number, b: number, delta: number, min: number): [number, number] {
  const pair = a + b;
  const first = Math.min(pair - Math.min(min, b), Math.max(Math.min(min, a), a + delta));
  return [first, pair - first];
}

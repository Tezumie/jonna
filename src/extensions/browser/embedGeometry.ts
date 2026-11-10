// Where a site shown inside a tab goes (DOM-free, tested): the tab's page area in physical
// pixels, and whether anything the IDE draws on top (a menu, a dialog, the quick input) covers
// it — a native webview is always drawn above the IDE's page, so it hides while covered.
import type { EmbedBounds } from "../../core/ipc/browser";

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The area in physical pixels (CSS pixels × devicePixelRatio, which includes the IDE's zoom). */
export function physicalBounds(box: Box, devicePixelRatio: number): EmbedBounds {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const x = Math.round(box.left * dpr);
  const y = Math.round(box.top * dpr);
  // From rounded edges, so neighbouring areas meet without a gap.
  return {
    x,
    y,
    width: Math.max(0, Math.round((box.left + box.width) * dpr) - x),
    height: Math.max(0, Math.round((box.top + box.height) * dpr) - y),
  };
}

/** Whether two boxes share any area (touching edges don't count). */
export function overlaps(a: Box, b: Box): boolean {
  return (
    a.width > 0 &&
    a.height > 0 &&
    b.width > 0 &&
    b.height > 0 &&
    a.left < b.left + b.width &&
    b.left < a.left + a.width &&
    a.top < b.top + b.height &&
    b.top < a.top + a.height
  );
}

/** Where the webview should be: hidden (no area, the tab not shown, or covered) or placed. */
export interface Placement {
  visible: boolean;
  bounds: EmbedBounds;
  zoom: number;
}

export function placement(
  area: Box | null,
  covers: readonly Box[],
  devicePixelRatio: number,
  zoom: number,
): Placement {
  const hidden: Placement = { visible: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, zoom };
  if (!area || area.width < 1 || area.height < 1) return hidden;
  if (covers.some((c) => overlaps(c, area)))
    return { ...hidden, bounds: physicalBounds(area, devicePixelRatio) };
  return { visible: true, bounds: physicalBounds(area, devicePixelRatio), zoom };
}

/** Equal placements need no new call to the webview. */
export function samePlacement(a: Placement | null, b: Placement): boolean {
  if (!a || a.visible !== b.visible) return false;
  if (!b.visible) return true;
  return (
    a.zoom === b.zoom &&
    a.bounds.x === b.bounds.x &&
    a.bounds.y === b.bounds.y &&
    a.bounds.width === b.bounds.width &&
    a.bounds.height === b.bounds.height
  );
}

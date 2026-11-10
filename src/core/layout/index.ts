// Fixed-part layout model: the left sidebar (visibility, width) and which part has focus.
// Everything else lives in the dock tree (src/core/dock). DOM-free and serializable
// (persisted per workspace). The workbench renders from these signals.
import { batch, type Signal, signal } from "../reactive/index";

export type PartId = "sidebar" | "dock";

export interface LayoutSnapshot {
  version: 2;
  sidebar: { visible: boolean; size: number };
}

export const SIDEBAR_LIMITS = { min: 170, max: 800, default: 260 } as const;

export function clampSidebar(size: number): number {
  const { min, max } = SIDEBAR_LIMITS;
  return Math.round(
    Math.min(max, Math.max(min, Number.isFinite(size) ? size : SIDEBAR_LIMITS.default)),
  );
}

export class LayoutModel {
  readonly sidebarVisible: Signal<boolean> = signal(true);
  /** Which side the activity bar and sidebar are on (workbench.sideBar.location). */
  readonly sidebarSide: Signal<"left" | "right"> = signal<"left" | "right">("left");
  readonly sidebarSize: Signal<number> = signal<number>(SIDEBAR_LIMITS.default);
  /** Part that last had keyboard focus. */
  readonly focusedPart: Signal<PartId> = signal<PartId>("dock");

  resizeSidebar(size: number): void {
    this.sidebarSize.value = clampSidebar(size);
  }

  snapshot(): LayoutSnapshot {
    return {
      version: 2,
      sidebar: { visible: this.sidebarVisible.peek(), size: this.sidebarSize.peek() },
    };
  }

  /** Applies a stored snapshot (v1 snapshots from M1 carry the same sidebar fields). */
  restore(data: unknown): void {
    if (!isRecord(data) || (data.version !== 1 && data.version !== 2)) return;
    const sidebar = data.sidebar;
    if (!isRecord(sidebar)) return;
    batch(() => {
      if (typeof sidebar.visible === "boolean") this.sidebarVisible.value = sidebar.visible;
      if (typeof sidebar.size === "number") this.resizeSidebar(sidebar.size);
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

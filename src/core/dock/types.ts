// The dock tree (docs/dock.md §1): an n-ary split tree of tab groups, plain JSON so it can be
// persisted, exposed at ide://layout and edited by commands. DOM-free.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type SplitDirection = "row" | "column";
export type Side = "left" | "right" | "top" | "bottom";
export type Placement = "main" | "bottom" | "right";

export interface TabRef {
  id: string;
  viewType: string;
  viewState: Json;
  /** A preview (transient) tab: replaced by the next preview opened in its group; pinned on edit. */
  preview?: true;
  /**
   * Pinned (VS Code's sticky tabs, D279): kept first in its group, ahead of the others; Close
   * others / to the right / saved and the tab limit leave it.
   */
  pinned?: true;
}

export interface GroupNode {
  kind: "group";
  id: string;
  tabs: TabRef[];
  activeTabId: string | null;
  /** Fills the dock; other groups are hidden until restored. */
  maximized?: boolean;
  /** Temporarily hidden (Ctrl+J, title-bar region toggles); keeps its size for restore. */
  hidden?: boolean;
}

export interface SplitNode {
  kind: "split";
  direction: SplitDirection;
  children: DockNode[];
  /** Fractions of the parent, one per child, summing to 1. */
  sizes: number[];
}

export type DockNode = SplitNode | GroupNode;

/** A rectangle in unit space (the whole dock is 0,0 → 1,1). */
export interface UnitRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type TabTarget =
  | { groupId: string; index?: number }
  | { groupId: string; split: Side }
  | { root: Side };

export const SIDE_DIRECTION: Record<Side, SplitDirection> = {
  left: "row",
  right: "row",
  top: "column",
  bottom: "column",
};

/** Sides that put the new node after the target (right/bottom). */
export const SIDE_AFTER: Record<Side, boolean> = {
  left: false,
  right: true,
  top: false,
  bottom: true,
};

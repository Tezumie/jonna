// Moving tabs (what drag and drop and `layout.moveTab` do), geometry for directional focus and
// placement hints, and (de)serialization. DOM-free.
import {
  addTab,
  allGroups,
  findGroup,
  findTab,
  normalize,
  removeGroup,
  setHidden,
  setMaximized,
  splitGroup,
  splitRoot,
} from "./tree";
import type {
  DockNode,
  GroupNode,
  Json,
  Placement,
  Side,
  TabRef,
  TabTarget,
  UnitRect,
} from "./types";

/**
 * Moves a tab to another group (at an index), into a new split next to a group, or to a dock edge.
 * `newGroupId` names the group created by a split. Returns the new root, or the same tree if the
 * move is a no-op (e.g. splitting a group off itself when it holds only that tab).
 */
export function moveTab(
  root: DockNode,
  tabId: string,
  to: TabTarget,
  newGroupId: string,
  fraction = 0.5,
): DockNode {
  const found = findTab(root, tabId);
  if (!found) throw new Error(`No tab ${tabId}`);
  const tab = structuredClone(found.group.tabs[found.index] as TabRef);
  const sourceId = found.group.id;

  if ("root" in to) {
    const newGroup: GroupNode = { kind: "group", id: newGroupId, tabs: [tab], activeTabId: tab.id };
    const edged = splitRoot(detach(root, tabId, true), to.root, newGroup, fraction);
    return normalize(edged) ?? edged;
  }

  if ("split" in to) {
    if (to.groupId === sourceId && found.group.tabs.length === 1) return root;
    const newGroup: GroupNode = { kind: "group", id: newGroupId, tabs: [tab], activeTabId: tab.id };
    // Detach but keep the emptied source group, so the target still exists for the split;
    // normalization then drops the empty group.
    const split = splitGroup(detach(root, tabId, true), to.groupId, to.split, newGroup, fraction);
    return normalize(split) ?? split;
  }

  const target = findGroup(root, to.groupId);
  if (!target) throw new Error(`No group ${to.groupId}`);
  let index = to.index ?? target.tabs.length;
  if (target.id === sourceId) {
    // Reorder within a group: account for the tab's own slot.
    if (index > found.index) index -= 1;
    if (index === found.index) return activate(root, tabId);
  }
  const without = detach(root, tabId, true);
  const added = addTab(without, target.id, tab, index);
  return normalize(added) ?? added;
}

/**
 * Moves a whole group (what dragging a group by its tab strip does): into another group (its tabs
 * join that group's strip at `index`, the moved group's active tab becomes active), next to a group
 * (`split`), or to a dock edge (`root`). The group keeps its id, tabs, active tab and size share is
 * recomputed with `fraction`. Returns the same tree for no-ops (onto itself, the only group to an edge).
 */
export function moveGroup(
  root: DockNode,
  groupId: string,
  to: TabTarget,
  fraction = 0.5,
): DockNode {
  const source = findGroup(root, groupId);
  if (!source) throw new Error(`No group ${groupId}`);
  if ("groupId" in to && to.groupId === groupId) return root;
  const moved: GroupNode = {
    kind: "group",
    id: source.id,
    tabs: structuredClone(source.tabs),
    activeTabId: source.activeTabId,
  };
  if ("root" in to) {
    if (allGroups(root).filter((g) => !g.hidden).length < 2) return root;
    const edged = splitRoot(removeGroup(root, groupId), to.root, moved, fraction);
    return normalize(edged) ?? edged;
  }
  if (!findGroup(root, to.groupId)) throw new Error(`No group ${to.groupId}`);
  const without = removeGroup(root, groupId);
  if ("split" in to) {
    const split = splitGroup(without, to.groupId, to.split, moved, fraction);
    return normalize(split) ?? split;
  }
  let next = without;
  const target = findGroup(next, to.groupId);
  let index = to.index ?? target?.tabs.length ?? 0;
  for (const tab of moved.tabs) next = addTab(next, to.groupId, tab, index++, false);
  if (moved.activeTabId) next = activate(next, moved.activeTabId);
  return normalize(next) ?? next;
}

/** Removes a tab, optionally keeping an emptied group in place (so it can still be a split target). */
function detach(root: DockNode, tabId: string, keepEmpty = false): DockNode {
  const next = structuredClone(root);
  const found = findTab(next, tabId);
  if (!found) return next;
  found.group.tabs.splice(found.index, 1);
  if (found.group.activeTabId === tabId) {
    found.group.activeTabId =
      (found.group.tabs[found.index] ?? found.group.tabs[found.index - 1])?.id ?? null;
  }
  return keepEmpty ? next : (normalize(next) ?? next);
}

function activate(root: DockNode, tabId: string): DockNode {
  const next = structuredClone(root);
  const found = findTab(next, tabId);
  if (found) found.group.activeTabId = tabId;
  return next;
}

// ---- Geometry ---------------------------------------------------------------------

/** Unit-space rectangles of every visible group (hidden groups give their space to siblings). */
export function layoutRects(root: DockNode): Map<string, UnitRect> {
  const rects = new Map<string, UnitRect>();
  const maximized = allGroups(root).find((g) => g.maximized && !g.hidden);
  if (maximized) {
    rects.set(maximized.id, { x: 0, y: 0, w: 1, h: 1 });
    return rects;
  }
  const visit = (node: DockNode, rect: UnitRect) => {
    if (node.kind === "group") {
      if (!node.hidden) rects.set(node.id, rect);
      return;
    }
    const visible = node.children.map((c) => isVisible(c));
    const total = node.sizes.reduce((sum, s, i) => sum + (visible[i] ? s : 0), 0) || 1;
    let offset = 0;
    node.children.forEach((child, i) => {
      if (!visible[i]) return;
      const share = (node.sizes[i] ?? 0) / total;
      const childRect =
        node.direction === "row"
          ? { x: rect.x + offset * rect.w, y: rect.y, w: share * rect.w, h: rect.h }
          : { x: rect.x, y: rect.y + offset * rect.h, w: rect.w, h: share * rect.h };
      offset += share;
      visit(child, childRect);
    });
  };
  visit(root, { x: 0, y: 0, w: 1, h: 1 });
  return rects;
}

/** True if any group under `node` is visible. */
export function isVisible(node: DockNode): boolean {
  return node.kind === "group" ? !node.hidden : node.children.some(isVisible);
}

const EPS = 1e-6;

/** The group next to `groupId` in a direction (overlapping span, nearest center), if any. */
export function neighborGroup(root: DockNode, groupId: string, side: Side): string | undefined {
  const rects = layoutRects(root);
  const from = rects.get(groupId);
  if (!from) return undefined;
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  let best: { id: string; dist: number } | undefined;
  for (const [id, r] of rects) {
    if (id === groupId) continue;
    const horizontal = side === "left" || side === "right";
    const adjacent =
      side === "left"
        ? Math.abs(r.x + r.w - from.x) < EPS
        : side === "right"
          ? Math.abs(from.x + from.w - r.x) < EPS
          : side === "top"
            ? Math.abs(r.y + r.h - from.y) < EPS
            : Math.abs(from.y + from.h - r.y) < EPS;
    const overlaps = horizontal
      ? r.y < from.y + from.h - EPS && r.y + r.h > from.y + EPS
      : r.x < from.x + from.w - EPS && r.x + r.w > from.x + EPS;
    if (!adjacent || !overlaps) continue;
    const dist = horizontal ? Math.abs(r.y + r.h / 2 - cy) : Math.abs(r.x + r.w / 2 - cx);
    if (!best || dist < best.dist) best = { id, dist };
  }
  return best?.id;
}

/**
 * Resolves a placement hint to an existing group: the group with that id if it still exists,
 * else a group in that region. Returns undefined when the region is empty (caller creates it).
 */
export function resolvePlacement(
  root: DockNode,
  placement: Placement,
  isEditorish: (t: TabRef) => boolean,
): GroupNode | undefined {
  const byId = findGroup(root, placement);
  if (byId) return byId;
  const groups = allGroups(root);
  const rects = layoutRects(root);
  const area = (g: GroupNode) => {
    const r = rects.get(g.id);
    return r ? r.w * r.h : 0;
  };
  const main = mainGroup(root, isEditorish);
  if (placement === "main") return main;
  const candidates = groups.filter((g) => {
    const r = rects.get(g.id);
    if (!r || g === main) return false;
    return placement === "bottom"
      ? r.y > EPS && Math.abs(r.y + r.h - 1) < EPS
      : r.x > EPS && Math.abs(r.x + r.w - 1) < EPS;
  });
  return candidates.sort((a, b) => area(b) - area(a))[0];
}

/**
 * Groups in the "bottom" or "right" region (title-bar toggles, Ctrl+J): measured as if nothing were
 * hidden, so hidden groups still count. Right = touches the dock's top and right edges but not its
 * left; bottom = touches the bottom edge but not the top. Groups with editor-like tabs never count.
 */
export function regionGroups(
  root: DockNode,
  region: "bottom" | "right",
  isEditorish: (t: TabRef) => boolean,
): GroupNode[] {
  const rects = layoutRects(
    setHidden(
      setMaximized(root, null),
      allGroups(root).map((g) => g.id),
      false,
    ),
  );
  return allGroups(root).filter((g) => {
    const r = rects.get(g.id);
    if (!r || g.tabs.some(isEditorish)) return false;
    const right = r.x > EPS && Math.abs(r.x + r.w - 1) < EPS && r.y < EPS;
    if (region === "right") return right;
    return !right && r.y > EPS && Math.abs(r.y + r.h - 1) < EPS;
  });
}

/** The largest group holding editor-like tabs, else the largest group. */
export function mainGroup(
  root: DockNode,
  isEditorish: (t: TabRef) => boolean,
): GroupNode | undefined {
  const rects = layoutRects(root);
  const area = (g: GroupNode) => {
    const r = rects.get(g.id);
    return r ? r.w * r.h : 0;
  };
  const groups = allGroups(root).filter((g) => !g.hidden);
  const editorGroups = groups.filter((g) => g.tabs.some(isEditorish));
  return [...(editorGroups.length > 0 ? editorGroups : groups)].sort(
    (a, b) => area(b) - area(a),
  )[0];
}

// ---- Serialization -------------------------------------------------------------------

/** Validates untrusted JSON (persisted state) into a dock tree, or null if malformed. */
export function deserialize(value: unknown): DockNode | null {
  const groupIds = new Set<string>();
  const tabIds = new Set<string>();
  const parse = (v: unknown): DockNode | null => {
    if (typeof v !== "object" || v === null) return null;
    const o = v as Record<string, unknown>;
    if (o.kind === "group") {
      if (typeof o.id !== "string" || groupIds.has(o.id) || !Array.isArray(o.tabs)) return null;
      groupIds.add(o.id);
      const tabs: TabRef[] = [];
      for (const t of o.tabs) {
        const tr = t as Record<string, unknown> | null;
        if (
          !tr ||
          typeof tr.id !== "string" ||
          typeof tr.viewType !== "string" ||
          tabIds.has(tr.id)
        )
          return null;
        tabIds.add(tr.id);
        tabs.push({
          id: tr.id,
          viewType: tr.viewType,
          viewState: (tr.viewState ?? null) as Json,
          ...(tr.preview === true ? { preview: true as const } : {}),
          ...(tr.pinned === true ? { pinned: true as const } : {}),
        });
      }
      const group: GroupNode = {
        kind: "group",
        id: o.id,
        tabs,
        activeTabId: typeof o.activeTabId === "string" ? o.activeTabId : null,
      };
      if (o.hidden === true) group.hidden = true;
      return group;
    }
    if (o.kind === "split") {
      if ((o.direction !== "row" && o.direction !== "column") || !Array.isArray(o.children))
        return null;
      const children = o.children.map(parse);
      if (children.some((c) => c === null) || children.length === 0) return null;
      const sizes =
        Array.isArray(o.sizes) &&
        o.sizes.length === children.length &&
        // Finite too: JSON's 1e999 parses to Infinity, which would make every rect NaN.
        o.sizes.every((s) => typeof s === "number" && Number.isFinite(s) && s > 0)
          ? (o.sizes as number[])
          : children.map(() => 1 / children.length);
      return { kind: "split", direction: o.direction, children: children as DockNode[], sizes };
    }
    return null;
  };
  const root = parse(value);
  return root ? normalize(root, true) : null;
}

/** The tree as plain JSON (it already is; this documents the contract and drops transient flags). */
export function serialize(root: DockNode): Json {
  const strip = (node: DockNode): Json =>
    node.kind === "group"
      ? {
          kind: "group",
          id: node.id,
          tabs: node.tabs.map((t) => ({
            id: t.id,
            viewType: t.viewType,
            viewState: t.viewState,
            ...(t.preview ? { preview: true as const } : {}),
            ...(t.pinned ? { pinned: true as const } : {}),
          })),
          activeTabId: node.activeTabId,
          ...(node.hidden ? { hidden: true } : {}),
        }
      : {
          kind: "split",
          direction: node.direction,
          sizes: node.sizes,
          children: node.children.map(strip),
        };
  return strip(root);
}

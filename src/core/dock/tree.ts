// Pure tree operations on the dock. Every function returns a new root (inputs are never
// mutated) that is normalized: no empty or single-child splits, no row inside a row, sizes sum to 1.
import {
  type DockNode,
  type GroupNode,
  SIDE_AFTER,
  SIDE_DIRECTION,
  type Side,
  type SplitNode,
  type TabRef,
} from "./types";

const clone = <T>(node: T): T => structuredClone(node);

// ---- Queries ----------------------------------------------------------------

/** All groups in reading order (depth-first). */
export function allGroups(root: DockNode): GroupNode[] {
  if (root.kind === "group") return [root];
  return root.children.flatMap(allGroups);
}

export function findGroup(root: DockNode, groupId: string): GroupNode | undefined {
  return allGroups(root).find((g) => g.id === groupId);
}

export function findTab(
  root: DockNode,
  tabId: string,
): { group: GroupNode; index: number } | undefined {
  for (const group of allGroups(root)) {
    const index = group.tabs.findIndex((t) => t.id === tabId);
    if (index >= 0) return { group, index };
  }
  return undefined;
}

export function allTabs(root: DockNode): TabRef[] {
  return allGroups(root).flatMap((g) => g.tabs);
}

/**
 * Whether a group on screen (not hidden) has a tab other than `except`: the dock still shows
 * something, so the welcome tab isn't needed to fill it (D368).
 */
export function hasShownTab(root: DockNode, except?: string): boolean {
  return allGroups(root).some((g) => !g.hidden && g.tabs.some((t) => t.id !== except));
}

/** Parent split and index of a node with `groupId`, or undefined for the root. */
function parentOf(
  root: DockNode,
  groupId: string,
): { parent: SplitNode; index: number } | undefined {
  if (root.kind === "group") return undefined;
  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i] as DockNode;
    if (child.kind === "group" && child.id === groupId) return { parent: root, index: i };
    const deeper = parentOf(child, groupId);
    if (deeper) return deeper;
  }
  return undefined;
}

// ---- Normalization ------------------------------------------------------------

/** Flattens same-direction splits, drops empty groups/splits, collapses single children, fixes sizes. */
export function normalize(node: DockNode, keepEmptyGroups = false): DockNode | null {
  if (node.kind === "group") {
    if (node.tabs.length === 0 && !keepEmptyGroups) return null;
    pinnedFirst(node);
    if (node.activeTabId === null || !node.tabs.some((t) => t.id === node.activeTabId)) {
      node.activeTabId = node.tabs[0]?.id ?? null;
    }
    return node;
  }
  const children: DockNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const size = node.sizes[i] ?? 1 / node.children.length;
    const n = normalize(child, keepEmptyGroups);
    if (!n) return;
    if (n.kind === "split" && n.direction === node.direction) {
      // Flatten: a row inside a row becomes siblings, scaled by the inner node's share.
      n.children.forEach((c, j) => {
        children.push(c);
        sizes.push(size * (n.sizes[j] ?? 0));
      });
    } else {
      children.push(n);
      sizes.push(size);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0] as DockNode;
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return { kind: "split", direction: node.direction, children, sizes: sizes.map((s) => s / total) };
}

/** Normalizes, keeping one (empty) group if everything was removed. */
function finish(root: DockNode, fallbackGroupId: string): DockNode {
  return normalize(root) ?? { kind: "group", id: fallbackGroupId, tabs: [], activeTabId: null };
}

// ---- Tab operations ------------------------------------------------------------

export function addTab(
  root: DockNode,
  groupId: string,
  tab: TabRef,
  index?: number,
  activate = true,
): DockNode {
  const next = clone(root);
  const group = findGroup(next, groupId);
  if (!group) throw new Error(`No group ${groupId}`);
  if (findTab(next, tab.id)) throw new Error(`Tab ${tab.id} already exists`);
  const at =
    index === undefined ? group.tabs.length : Math.max(0, Math.min(index, group.tabs.length));
  group.tabs.splice(at, 0, tab);
  pinnedFirst(group);
  if (activate || group.activeTabId === null) group.activeTabId = tab.id;
  return next;
}

/** Pinned tabs ahead of the others, each set in its own order (D279). */
function pinnedFirst(group: GroupNode): void {
  if (!group.tabs.some((t) => t.pinned)) return;
  group.tabs = [...group.tabs.filter((t) => t.pinned), ...group.tabs.filter((t) => !t.pinned)];
}

/**
 * Pins a tab (it moves to the end of the pinned ones and stops being a preview) or unpins it
 * (it moves to the start of the others), as VS Code does.
 */
export function setTabPinned(root: DockNode, tabId: string, pinned: boolean): DockNode {
  const next = clone(root);
  const found = findTab(next, tabId);
  if (!found) return next;
  const { group, index } = found;
  const tab = group.tabs[index] as TabRef;
  if (!!tab.pinned === pinned) return next;
  group.tabs.splice(index, 1);
  const count = group.tabs.filter((t) => t.pinned).length;
  if (pinned) {
    tab.pinned = true;
    delete tab.preview;
  } else delete tab.pinned;
  group.tabs.splice(count, 0, tab);
  return next;
}

/** Removes a tab; an emptied group disappears and its siblings share the space. */
export function removeTab(root: DockNode, tabId: string): DockNode {
  const next = clone(root);
  const found = findTab(next, tabId);
  if (!found) return next;
  const { group, index } = found;
  group.tabs.splice(index, 1);
  if (group.activeTabId === tabId) {
    // Activate the neighbor to the right, else to the left (VS Code behavior).
    group.activeTabId = (group.tabs[index] ?? group.tabs[index - 1])?.id ?? null;
  }
  return finish(next, group.id);
}

export function setActiveTab(root: DockNode, tabId: string): DockNode {
  const next = clone(root);
  const found = findTab(next, tabId);
  if (found) {
    found.group.activeTabId = tabId;
    found.group.hidden = false;
  }
  return next;
}

export function updateTabState(
  root: DockNode,
  tabId: string,
  viewState: TabRef["viewState"],
): DockNode {
  const next = clone(root);
  const found = findTab(next, tabId);
  if (found) (found.group.tabs[found.index] as TabRef).viewState = viewState;
  return next;
}

// ---- Group operations ----------------------------------------------------------

/** Removes a whole group (all its tabs). Siblings share its space proportionally. */
export function removeGroup(root: DockNode, groupId: string): DockNode {
  const next = clone(root);
  const group = findGroup(next, groupId);
  if (!group) return next;
  group.tabs = [];
  return finish(next, groupId);
}

/**
 * Places `newGroup` on `side` of the group `targetId`, taking `fraction` of the target's space.
 * Joins the parent split when it already runs in that direction (no nested row-in-row).
 */
export function splitGroup(
  root: DockNode,
  targetId: string,
  side: Side,
  newGroup: GroupNode,
  fraction = 0.5,
): DockNode {
  const next = clone(root);
  const direction = SIDE_DIRECTION[side];
  const after = SIDE_AFTER[side];
  const f = clampFraction(fraction);
  const located = parentOf(next, targetId);
  if (located && located.parent.direction === direction) {
    const { parent, index } = located;
    const share = parent.sizes[index] ?? 0;
    parent.sizes[index] = share * (1 - f);
    const at = after ? index + 1 : index;
    parent.children.splice(at, 0, newGroup);
    parent.sizes.splice(at, 0, share * f);
    return finish(next, newGroup.id);
  }
  const target = findGroup(next, targetId);
  if (!target) throw new Error(`No group ${targetId}`);
  const pair: SplitNode = {
    kind: "split",
    direction,
    children: after ? [clone(target), newGroup] : [newGroup, clone(target)],
    sizes: after ? [1 - f, f] : [f, 1 - f],
  };
  return finish(replaceGroup(next, targetId, pair), newGroup.id);
}

/** Places `newGroup` along a whole edge of the dock (full height or width). */
export function splitRoot(
  root: DockNode,
  side: Side,
  newGroup: GroupNode,
  fraction = 0.3,
): DockNode {
  const next = clone(root);
  const direction = SIDE_DIRECTION[side];
  const after = SIDE_AFTER[side];
  const f = clampFraction(fraction);
  if (next.kind === "split" && next.direction === direction) {
    next.sizes = next.sizes.map((s) => s * (1 - f));
    if (after) {
      next.children.push(newGroup);
      next.sizes.push(f);
    } else {
      next.children.unshift(newGroup);
      next.sizes.unshift(f);
    }
    return finish(next, newGroup.id);
  }
  const wrapped: SplitNode = {
    kind: "split",
    direction,
    children: after ? [next, newGroup] : [newGroup, next],
    sizes: after ? [1 - f, f] : [f, 1 - f],
  };
  return finish(wrapped, newGroup.id);
}

function replaceGroup(root: DockNode, groupId: string, replacement: DockNode): DockNode {
  if (root.kind === "group") return root.id === groupId ? replacement : root;
  root.children = root.children.map((c) => replaceGroup(c, groupId, replacement));
  return root;
}

function clampFraction(f: number): number {
  return Math.min(0.9, Math.max(0.1, Number.isFinite(f) ? f : 0.5));
}

// ---- Sizes ----------------------------------------------------------------------

/** Sets a group's share of its parent (0.05–0.95); siblings keep their relative proportions. */
export function resizeGroup(root: DockNode, groupId: string, fraction: number): DockNode {
  const next = clone(root);
  const located = parentOf(next, groupId);
  if (!located) return next;
  const { parent, index } = located;
  const f = Math.min(0.95, Math.max(0.05, fraction));
  const others = 1 - (parent.sizes[index] ?? 0);
  parent.sizes = parent.sizes.map((s, i) =>
    i === index ? f : others > 0 ? (s / others) * (1 - f) : (1 - f) / (parent.sizes.length - 1),
  );
  return next;
}

/** Replaces the sizes of the split at `path` (child indices from the root). */
export function setSplitSizes(
  root: DockNode,
  path: readonly number[],
  sizes: readonly number[],
): DockNode {
  const next = clone(root);
  const node = nodeAt(next, path);
  if (node?.kind !== "split" || sizes.length !== node.children.length) return next;
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  node.sizes = sizes.map((s) => s / total);
  return next;
}

export function nodeAt(root: DockNode, path: readonly number[]): DockNode | undefined {
  let node: DockNode | undefined = root;
  for (const i of path) node = node?.kind === "split" ? node.children[i] : undefined;
  return node;
}

/** Makes every split's children equal (double-click a splitter, `layout.equalize`). */
export function equalize(root: DockNode, path?: readonly number[]): DockNode {
  const next = clone(root);
  const visit = (node: DockNode) => {
    if (node.kind !== "split") return;
    node.sizes = node.children.map(() => 1 / node.children.length);
    if (!path) node.children.forEach(visit);
  };
  const start = path ? nodeAt(next, path) : next;
  if (start) visit(start);
  return next;
}

// ---- Flags ------------------------------------------------------------------------

export function setMaximized(root: DockNode, groupId: string | null): DockNode {
  const next = clone(root);
  for (const g of allGroups(next)) {
    if (g.id === groupId) g.maximized = true;
    else delete g.maximized;
  }
  return next;
}

export function setHidden(root: DockNode, groupIds: readonly string[], hidden: boolean): DockNode {
  const next = clone(root);
  for (const g of allGroups(next)) {
    if (!groupIds.includes(g.id)) continue;
    if (hidden) g.hidden = true;
    else delete g.hidden;
  }
  return next;
}

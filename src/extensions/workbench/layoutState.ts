// `ide://layout` (docs/dock.md §8): the dock tree with per-group tabs, sizes in px and focus, plus
// the sidebar. Also returned by `layout.getTree`.
import { type DockNode, layoutRects } from "../../core/dock/index";
import type { WorkbenchServices } from "../../workbench/services";

export interface LayoutGroupInfo {
  id: string;
  tabs: { id: string; viewType: string; title: string; dirty: boolean }[];
  activeTabId: string | null;
  focused: boolean;
  hidden: boolean;
  /** Rendered size in CSS px (0×0 when hidden or another group is maximized). */
  size: { width: number; height: number };
}

type TreeJson =
  | { kind: "group"; id: string }
  | { kind: "split"; direction: "row" | "column"; sizes: number[]; children: TreeJson[] };

/** `size` is the dock's rendered size in px (group sizes are fractions of it). */
export function layoutTree(services: WorkbenchServices, size: { width: number; height: number }) {
  const { dock, layout, views } = services;
  const root = dock.root.peek();
  const rects = layoutRects(root);
  const { width, height } = size;
  const groups: LayoutGroupInfo[] = [];
  const shape = (node: DockNode): TreeJson => {
    if (node.kind === "split") {
      return {
        kind: "split",
        direction: node.direction,
        sizes: node.sizes.map((x) => Math.round(x * 1000) / 1000),
        children: node.children.map(shape),
      };
    }
    const r = rects.get(node.id);
    groups.push({
      id: node.id,
      tabs: node.tabs.map((t) => ({
        id: t.id,
        viewType: t.viewType,
        title: dock.title(t),
        dirty: dock.isDirty(t),
      })),
      activeTabId: node.activeTabId,
      focused: dock.focusedGroupId.peek() === node.id,
      hidden: node.hidden === true,
      size: { width: Math.round((r?.w ?? 0) * width), height: Math.round((r?.h ?? 0) * height) },
    });
    return { kind: "group", id: node.id };
  };
  const tree = shape(root);
  return {
    focusedGroupId: dock.focusedGroupId.peek(),
    maximizedGroupId: dock.maximizedGroupId(),
    groups,
    tree,
    /** Tabs shown in a window of their own (layout.moveToNewWindow). */
    detached: [...dock.detached.peek()],
    regions: {
      bottom: dock.regionGroups("bottom").map((g) => g.id),
      right: dock.regionGroups("right").map((g) => g.id),
    },
    sidebar: {
      visible: layout.sidebarVisible.peek(),
      side: layout.sidebarSide.peek(),
      width: layout.sidebarSize.peek(),
      activeView: views.active.peek(),
      /** Views docked as sections under another (hidden from the activity bar), e.g. Outline. */
      sections: views.all
        .peek()
        .filter((v) => views.sectionHost(v.id))
        .map((v) => ({ id: v.id, in: views.sectionHost(v.id), ...views.section(v.id) })),
      /** Activity-bar badges (unsaved files, pending changes), view id → count and meaning. */
      badges: Object.fromEntries(views.badges.peek()),
      /** Views with work running (their progress line / badge), view id → what. */
      busy: Object.fromEntries(views.busy.peek()),
    },
    viewTypes: dock.views.types(),
  };
}

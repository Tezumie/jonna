// Sidebar views moved into the dock (VS Code's movable views, docs/dock.md §10). A moved view is a
// dock tab of type SIDEBAR_VIEW_TYPE whose state names the view, so where it is persists with the
// dock and closing the tab puts it back in the sidebar. DOM-free; the tab, the commands and the
// drag live in movableViews.ts.
import type { Json, TabRef } from "../core/dock/index";

/** The dock view type that hosts a sidebar view (`{ id }`). */
export const SIDEBAR_VIEW_TYPE = "sidebarView";

/** The view id a sidebar-view tab's state names, if any. */
export function movedViewId(state: Json): string | null {
  if (state === null || typeof state !== "object" || Array.isArray(state)) return null;
  const id = state.id;
  return typeof id === "string" && id ? id : null;
}

/** The ids of the views that sit in dock tabs, from the dock's tabs. */
export function movedViewIds(tabs: readonly TabRef[]): Set<string> {
  const ids = new Set<string>();
  for (const tab of tabs) {
    if (tab.viewType !== SIDEBAR_VIEW_TYPE) continue;
    const id = movedViewId(tab.viewState);
    if (id) ids.add(id);
  }
  return ids;
}

/** The tab that holds view `id`, if it's in the dock. */
export function tabOfMovedView(tabs: readonly TabRef[], id: string): TabRef | undefined {
  return tabs.find((t) => t.viewType === SIDEBAR_VIEW_TYPE && movedViewId(t.viewState) === id);
}

/** Whether two sets hold the same ids (to keep a signal from firing for nothing). */
export function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** Where `view.moveView` sends a view when `to` isn't given: the other place. */
export function moveDestination(
  inDock: boolean,
  to: "sidebar" | "dock" | undefined,
): "sidebar" | "dock" {
  return to ?? (inDock ? "sidebar" : "dock");
}

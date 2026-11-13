// The layout a window starts from when there's nothing to restore (D163): no folder at startup, a
// folder closed, a folder opened for the first time. Which one is the user's choice
// (workbench.defaultLayout, D424; core/layout/startLayout.ts): by default the sidebar at its
// default width (Chats without a folder — the welcome tab already offers Open folder — the
// explorer with one, D164), the welcome tab, the agent on the right a little wider than the
// sidebar. No terminal: it used to open one for a folder; it starts when asked for now (D424).
import { SIDEBAR_LIMITS } from "../core/layout/index";
import { type StartLayoutPlan, startLayoutOf, startLayoutPlan } from "../core/layout/startLayout";
import { assumeDockWidth } from "./dock/keepRightWidth";
import type { WorkbenchServices } from "./services";

/** The agent column's width in the base layout (px); the explorer's is SIDEBAR_LIMITS.default. */
export const BASE_AGENT_PX = 380;

/** The plan for the layout the user chose. */
export function chosenStartLayout(
  settings: WorkbenchServices["settings"],
  folder: boolean,
): StartLayoutPlan {
  return startLayoutPlan(startLayoutOf(settings.peek("workbench.defaultLayout")), folder);
}

export function applyBaseLayout(
  services: Pick<WorkbenchServices, "layout" | "dock" | "settings">,
  options: {
    /** A folder was opened (for the first time): else none is open. */
    folder: boolean;
    /** Puts `view` in the sidebar (each caller's way: with or without focus). */
    showSidebar: (view: string) => void;
  },
): StartLayoutPlan {
  const { layout, dock, settings } = services;
  const plan = chosenStartLayout(settings, options.folder);
  // Shown first only when it stays shown: a sidebar about to hide doesn't flash.
  if (plan.sidebarVisible) layout.sidebarVisible.value = true;
  layout.resizeSidebar(SIDEBAR_LIMITS.default);
  options.showSidebar(plan.sidebar);
  // After the view is chosen: showing a view shows the sidebar.
  layout.sidebarVisible.value = plan.sidebarVisible;
  // The dock's width once the sidebar has its default width (the DOM may not have caught up).
  const main = document.querySelector<HTMLElement>(".workbench-main");
  const bar = document.querySelector<HTMLElement>(".activitybar")?.offsetWidth ?? 48;
  const sidebar = plan.sidebarVisible ? SIDEBAR_LIMITS.default : 0;
  const width = (main?.clientWidth || window.innerWidth) - bar - sidebar;
  const share = width > 0 ? Math.min(0.45, Math.max(0.2, BASE_AGENT_PX / width)) : 0.3;
  dock.resetToDefault(plan.main, plan.bottom, plan.right, share);
  // The share is for the width the dock is about to have: the next resize mustn't scale it again.
  if (width > 0) assumeDockWidth(dock, width);
  return plan;
}

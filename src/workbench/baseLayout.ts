// The layout a window starts from when there's nothing to restore (D163): no folder at startup, a
// folder closed, a folder opened for the first time. Always the same: the sidebar at its default
// width (Chats without a folder — the welcome tab already offers Open folder — the explorer with
// one, D164), the welcome tab, the agent on the right a little wider than the sidebar, and a
// terminal only for a folder.
import { SIDEBAR_LIMITS } from "../core/layout/index";
import { assumeDockWidth } from "./dock/keepRightWidth";
import type { WorkbenchServices } from "./services";

/** The agent column's width in the base layout (px); the explorer's is SIDEBAR_LIMITS.default. */
export const BASE_AGENT_PX = 380;

export function applyBaseLayout(
  services: Pick<WorkbenchServices, "layout" | "dock">,
  options: { terminal: boolean; showSidebar: () => void },
): void {
  const { layout, dock } = services;
  layout.sidebarVisible.value = true;
  layout.resizeSidebar(SIDEBAR_LIMITS.default);
  options.showSidebar();
  // The dock's width once the sidebar has its default width (the DOM may not have caught up).
  const main = document.querySelector<HTMLElement>(".workbench-main");
  const bar = document.querySelector<HTMLElement>(".activitybar")?.offsetWidth ?? 48;
  const width = (main?.clientWidth || window.innerWidth) - bar - SIDEBAR_LIMITS.default;
  const share = width > 0 ? Math.min(0.45, Math.max(0.2, BASE_AGENT_PX / width)) : 0.3;
  dock.resetToDefault(["welcome"], options.terminal ? ["terminal"] : [], ["agent"], share);
  // The share is for the width the dock is about to have: the next resize mustn't scale it again.
  if (width > 0) assumeDockWidth(dock, width);
}

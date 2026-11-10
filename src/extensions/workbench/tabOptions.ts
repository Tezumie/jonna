// Tab settings → the dock (D279): VS Code's workbench.editor.decorations.*, tabActionLocation,
// tabActionCloseVisibility, pinnedTabsOnSeparateRow, limit.*, focusRecentEditorAfterClose, and
// our workbench.editor.tabPlacement. Also the `activeEditorIsPinned` context key (the Pin / Unpin
// key).

import { allTabs } from "../../core/dock/index";
import type { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { DEFAULT_TAB_OPTIONS, type TabOptions } from "../../workbench/dock/model";
import type { WorkbenchServices } from "../../workbench/services";

export function registerTabOptions(sub: DisposableStore, services: WorkbenchServices): void {
  const { context, dock, settings } = services;
  sub.add(
    effect(() => {
      const bool = (key: string, fallback: boolean) => {
        const v = settings.get<unknown>(key);
        return typeof v === "boolean" ? v : fallback;
      };
      const d = DEFAULT_TAB_OPTIONS;
      const placement = settings.get<unknown>("workbench.editor.tabPlacement");
      const value = settings.get<unknown>("workbench.editor.limit.value");
      const next: TabOptions = {
        decorationColors: bool("workbench.editor.decorations.colors", d.decorationColors),
        decorationBadges: bool("workbench.editor.decorations.badges", d.decorationBadges),
        actionLocation:
          settings.get<unknown>("workbench.editor.tabActionLocation") === "left" ? "left" : "right",
        closeButton: bool("workbench.editor.tabActionCloseVisibility", d.closeButton),
        pinnedOnSeparateRow: bool(
          "workbench.editor.pinnedTabsOnSeparateRow",
          d.pinnedOnSeparateRow,
        ),
        placement: placement === "left" || placement === "right" ? placement : "top",
        limit: {
          enabled: bool("workbench.editor.limit.enabled", d.limit.enabled),
          value: typeof value === "number" && value >= 1 ? Math.floor(value) : d.limit.value,
          perEditorGroup: bool("workbench.editor.limit.perEditorGroup", d.limit.perEditorGroup),
          excludeDirty: bool("workbench.editor.limit.excludeDirty", d.limit.excludeDirty),
        },
        focusRecentAfterClose: bool(
          "workbench.editor.focusRecentEditorAfterClose",
          d.focusRecentAfterClose,
        ),
      };
      const before = dock.tabOptions.peek();
      if (JSON.stringify(before) === JSON.stringify(next)) return undefined;
      dock.tabOptions.value = next;
      // A limit turned on or lowered applies now, as in VS Code.
      if (JSON.stringify(before.limit) !== JSON.stringify(next.limit)) dock.applyTabLimit();
      return undefined;
    }),
  );
  sub.add(
    effect(() => {
      const root = dock.root.value;
      const groupId = dock.focusedGroupId.value;
      const group = groupId ? dock.findGroup(groupId) : undefined;
      const active = allTabs(root).find((t) => t.id === group?.activeTabId);
      context.set("activeEditorIsPinned", active?.pinned === true);
      return undefined;
    }),
  );
}

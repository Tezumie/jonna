// Tab housekeeping commands behind the tab context menu: close others / to the right / saved /
// all, pin and unpin, and copy a tab's file path. Each close asks about unsaved editors like
// layout.closeTab, and leaves pinned tabs (VS Code's sticky tabs, D279).

import { clipboardIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { displayPath } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";

export function registerTabCommands(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, dock, workspace } = services;
  const register: typeof dispatcher.register = (command) =>
    sub.add(dispatcher.register({ category: "View", ...command }));
  const locate = (tabId: string | undefined) => {
    const id = tabId ?? dock.focusedGroup()?.activeTabId;
    const found = id ? dock.findTab(id) : undefined;
    if (!id || !found) throw new Error("No tab.");
    return { id, group: found.group, index: found.index };
  };
  /** VS Code's "Copy relative path": the OS's separator; the folder's name first, of several. */
  const relativeText = (path: string) => {
    if (workspace.folders.peek().length <= 1) return displayPath(workspace.root.peek() ?? "", path);
    const rel = workspace.relative(path);
    return /^[A-Za-z]:[\\/]|^\\\\/.test(path) ? rel.replaceAll("/", "\\") : rel;
  };
  const closeAll = async (ids: readonly string[]) => {
    let closed = 0;
    for (const id of ids) if (await dock.closeTab(id)) closed++;
    return { closed };
  };

  register({
    id: "layout.reopenClosedTab",
    title: "Reopen closed tab",
    description: "Reopens the most recently closed editor tab (files, previews, diffs, pages).",
    input: s.empty(),
    effects: [],
    run: () => {
      const tabId = dock.reopenClosedTab();
      if (!tabId) throw new Error("No closed tab to reopen.");
      return { tabId };
    },
  });
  register({
    id: "layout.closeOtherTabs",
    title: "Close other tabs",
    description: "Closes every tab in the group except `tabId` (default: the active tab).",
    input: s.object({ tabId: s.string().optional() }),
    effects: ["write"],
    run: ({ tabId }) => {
      const { id, group } = locate(tabId);
      return closeAll(group.tabs.filter((t) => t.id !== id && !t.pinned).map((t) => t.id));
    },
  });
  register({
    id: "layout.closeTabsToRight",
    title: "Close tabs to the right",
    description: "Closes the tabs after `tabId` (default: the active tab) in its group.",
    input: s.object({ tabId: s.string().optional() }),
    effects: ["write"],
    run: ({ tabId }) => {
      const { group, index } = locate(tabId);
      return closeAll(
        group.tabs
          .slice(index + 1)
          .filter((t) => !t.pinned)
          .map((t) => t.id),
      );
    },
  });
  register({
    id: "layout.closeSavedTabs",
    title: "Close saved tabs",
    description: "Closes the tabs without unsaved changes in a group (default: the focused group).",
    input: s.object({ groupId: s.string().optional() }),
    effects: [],
    run: ({ groupId }) => {
      const group = groupId ? dock.findGroup(groupId) : dock.focusedGroup();
      if (!group) throw new Error("No group.");
      return closeAll(group.tabs.filter((t) => !dock.isDirty(t) && !t.pinned).map((t) => t.id));
    },
  });
  register({
    id: "layout.closeAllTabs",
    title: "Close all tabs",
    description:
      "Closes a group's tabs (default: the focused group) except pinned ones; when only pinned tabs are left, closes those too (VS Code's Close all).",
    input: s.object({ groupId: s.string().optional() }),
    effects: ["write"],
    run: ({ groupId }) => {
      const group = groupId ? dock.findGroup(groupId) : dock.focusedGroup();
      if (!group) throw new Error("No group.");
      const unpinned = group.tabs.filter((t) => !t.pinned);
      return closeAll((unpinned.length ? unpinned : group.tabs).map((t) => t.id));
    },
  });
  register({
    id: "layout.pinEditor",
    title: "Pin tab",
    description:
      "Pins a tab (default: the active tab): it moves to the front of its group with the other pinned tabs, and Close others / to the right / saved / all and the tab limit leave it (VS Code's Pin). Not the same as layout.pinTab, which keeps a preview tab open.",
    input: s.object({ tabId: s.string().optional() }),
    effects: [],
    run: ({ tabId }) => {
      const { id } = locate(tabId);
      dock.setTabPinned(id, true);
      return { pinned: id };
    },
  });
  register({
    id: "layout.unpinEditor",
    title: "Unpin tab",
    description:
      "Unpins a pinned tab (default: the active tab); it moves to just after the pinned tabs.",
    input: s.object({ tabId: s.string().optional() }),
    effects: [],
    run: ({ tabId }) => {
      const { id } = locate(tabId);
      dock.setTabPinned(id, false);
      return { unpinned: id };
    },
  });
  register({
    id: "layout.copyTabPath",
    title: "Copy path of tab",
    description: "Copies the file path of a tab (absolute, or relative to the workspace).",
    input: s.object({ tabId: s.string().optional(), relative: s.boolean().optional() }),
    effects: [],
    agent: "hidden",
    run: async ({ tabId, relative }) => {
      const { id, group } = locate(tabId);
      const tab = group.tabs.find((t) => t.id === id);
      const path = tab ? dock.descriptor(tab)?.resource?.(tab.viewState) : undefined;
      if (!path) throw new Error("This tab doesn't show a file.");
      // With several folders, relative to the file's folder with its name first (D251).
      const text = relative ? relativeText(path) : path;
      await clipboardIpc.writeText(text);
      return { copied: text };
    },
  });
}

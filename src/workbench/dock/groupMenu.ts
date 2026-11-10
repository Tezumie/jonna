// The group menu: the strip's ⋯ button and a right-click on the strip's empty area. New tab (what
// can open here), split in four directions, new file, every tab of the group, maximize, close.
// Every item runs a command (layout.newTab, layout.splitActive, layout.closeGroup…).
import type { GroupNode } from "../../core/dock/index";
import type { Disposable } from "../../core/lifecycle/index";
import { type MenuAnchor, type MenuItem, showMenu } from "../../ui/Menu";
import type { GroupDeps } from "./group";
import { availableEntries } from "./newTab";

export function showGroupMenu(deps: GroupDeps, node: GroupNode, at: MenuAnchor): Disposable {
  const { dock } = deps;
  const key = (command: string) => deps.label(command);
  const groupId = node.id;
  const run =
    (command: string, input: unknown = {}) =>
    () =>
      deps.run(command, input);
  const active = node.tabs.find((t) => t.id === node.activeTabId);
  const state = active ? (dock.liveView(active.id)?.serialize() ?? active.viewState) : null;
  const canDuplicate = !!active && (dock.descriptor(active)?.duplicate?.(state) ?? null) !== null;
  const canSplit = !!active && (canDuplicate || node.tabs.length > 1);
  const maximized = node.maximized === true;

  // The IDE's own, then every extension's tool (searchable once the list is long).
  const tools = deps.tools?.() ?? [];
  const newTab: MenuItem[] = [
    ...availableEntries((type) => !!dock.views.get(type)).map((e) => ({
      label: e.label,
      icon: e.icon,
      logo: e.logo,
      keybinding: e.shortcutOf ? key(e.shortcutOf) : undefined,
      run: run("layout.newTab", { groupId, kind: e.kind }),
    })),
    ...tools.map((t, i) => ({
      label: t.label,
      icon: t.icon,
      separatorBefore: i === 0,
      run: run("layout.newTab", { groupId, tool: t.command, toolInput: t.input }),
    })),
  ];
  const items: MenuItem[] = [
    {
      label: "New tab",
      icon: "plus",
      submenu: newTab,
      // Everything with a page of its own, so a search box once it's more than a glance (D185).
      searchable: newTab.length > 10,
    },
    {
      label: "Split",
      icon: "columns-2",
      disabled: !canSplit,
      submenu: (
        [
          ["up", "Split up", "rows-2"],
          ["down", "Split down", "rows-2"],
          ["left", "Split left", "columns-2"],
          ["right", "Split right", "columns-2"],
        ] as const
      ).map(([direction, label, glyph]) => ({
        label,
        icon: glyph,
        keybinding: direction === "right" ? key("layout.splitActive") : undefined,
        run: run("layout.splitActive", { groupId, direction }),
      })),
    },
    {
      label: "New file…",
      icon: "file-plus",
      keybinding: key("explorer.newFile"),
      run: run("layout.newTab", { groupId, kind: "file" }),
    },
  ];
  if (node.tabs.length > 0)
    items.push({
      label: "Tabs",
      icon: "list-tree",
      separatorBefore: true,
      submenu: node.tabs.map((tab) => ({
        label: `${dock.title(tab)}${dock.isDirty(tab) ? " ●" : ""}`,
        checked: tab.id === node.activeTabId,
        run: run("layout.focusTab", { tabId: tab.id }),
      })),
      searchable: node.tabs.length > 8,
    });
  items.push(
    {
      label: maximized ? "Restore group" : "Maximize group",
      icon: maximized ? "minimize-2" : "maximize-2",
      separatorBefore: node.tabs.length === 0,
      keybinding: key("layout.toggleMaximize"),
      run: run("layout.toggleMaximize", { groupId }),
    },
    {
      label: "Close saved tabs",
      icon: "check-check",
      separatorBefore: true,
      disabled: node.tabs.length === 0,
      run: run("layout.closeSavedTabs", { groupId }),
    },
    {
      label: "Close group",
      icon: "x",
      keybinding: key("layout.closeGroup"),
      run: run("layout.closeGroup", { groupId }),
    },
  );
  return showMenu(at, items, "Group actions");
}

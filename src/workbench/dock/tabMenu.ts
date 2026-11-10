// The tab context menu (right-click on a tab): close variants, path actions for file tabs,
// reopen with, chat, reveal, split/maximize — VS Code's order. Every item is a command.
import type { TabRef } from "../../core/dock/index";
import { type MenuItem, showContextMenu } from "../../ui/Menu";
import type { GroupDeps } from "./group";

export function showTabMenu(
  deps: GroupDeps,
  tab: TabRef,
  tabs: readonly TabRef[],
  x: number,
  y: number,
): void {
  const { dock } = deps;
  const run =
    (command: string, input: unknown = {}) =>
    () =>
      deps.run(command, input);
  const key = (command: string) => deps.label(command);
  const index = tabs.findIndex((t) => t.id === tab.id);
  const resource = dock.descriptor(tab)?.resource?.(tab.viewState);
  const focusThen = (command: string, input: unknown) => () => {
    deps.run("layout.focusTab", { tabId: tab.id });
    deps.run(command, input);
  };
  // VS Code's groups and order: close · paths · reopen with · chat · reveal · keep open · split.
  const groups: MenuItem[][] = [
    [
      {
        label: "Close",
        icon: "x",
        keybinding: key("layout.closeTab"),
        run: run("layout.closeTab", { tabId: tab.id }),
      },
      {
        label: "Close others",
        icon: "circle-x",
        disabled: tabs.length < 2,
        run: run("layout.closeOtherTabs", { tabId: tab.id }),
      },
      {
        label: "Close to the right",
        icon: "arrow-right-to-line",
        disabled: index === tabs.length - 1,
        run: run("layout.closeTabsToRight", { tabId: tab.id }),
      },
      { label: "Close saved", icon: "check-check", run: run("layout.closeSavedTabs", {}) },
      { label: "Close all", icon: "list-x", run: run("layout.closeAllTabs", {}) },
    ],
  ];
  if (resource) {
    groups.push(
      [
        {
          label: "Copy path",
          icon: "clipboard-copy",
          run: run("layout.copyTabPath", { tabId: tab.id }),
        },
        {
          label: "Copy relative path",
          icon: "clipboard-copy",
          run: run("layout.copyTabPath", { tabId: tab.id, relative: true }),
        },
      ],
      [
        {
          label: "Reopen editor with…",
          icon: "file-symlink",
          run: run("editor.reopenWith", { path: resource }),
        },
      ],
      [
        {
          label: "Add file to chat",
          icon: "agent",
          run: run("agent.addContext", { paths: [resource] }),
        },
      ],
      [
        {
          label: "Reveal in file manager",
          icon: "folder-search",
          run: run("explorer.revealInOs", { path: resource }),
        },
        {
          label: "Reveal in explorer view",
          icon: "locate",
          run: run("explorer.reveal", { path: resource }),
        },
        ...(tab.viewType === "editor"
          ? [
              {
                label: "Open changes",
                icon: "git-compare" as const,
                run: run("editor.openDiff", { path: resource }),
              },
            ]
          : []),
      ],
    );
  }
  groups.push([
    ...(tab.preview
      ? [
          {
            label: "Keep open",
            icon: "check" as const,
            run: run("layout.pinTab", { tabId: tab.id }),
          },
        ]
      : []),
    tab.pinned
      ? {
          label: "Unpin",
          icon: "pin-off" as const,
          keybinding: key("layout.unpinEditor"),
          run: run("layout.unpinEditor", { tabId: tab.id }),
        }
      : {
          label: "Pin",
          icon: "pin" as const,
          keybinding: key("layout.pinEditor"),
          run: run("layout.pinEditor", { tabId: tab.id }),
        },
  ]);
  groups.push([
    {
      label: "Split right",
      icon: "columns-2",
      run: focusThen("layout.splitActive", { direction: "right" }),
    },
    {
      label: "Split down",
      icon: "rows-2",
      run: focusThen("layout.splitActive", { direction: "down" }),
    },
    { label: "Maximize group", icon: "maximize-2", run: focusThen("layout.toggleMaximize", {}) },
    ...(dock.descriptor(tab)?.detachable
      ? [
          {
            label: dock.detached.peek().has(tab.id)
              ? "Move back into the main window"
              : "Move into new window",
            icon: "app-window" as const,
            run: run(
              dock.detached.peek().has(tab.id)
                ? "layout.returnFromWindow"
                : "layout.moveToNewWindow",
              { tabId: tab.id },
            ),
          },
        ]
      : []),
  ]);
  const items = groups.flatMap((g, i) =>
    g.map((it, j) => ({ ...it, separatorBefore: i > 0 && j === 0 })),
  );
  showContextMenu(x, y, items);
}

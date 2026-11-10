// Split terminals (D209, VS Code's terminal groups): `terminal.split` puts a new terminal beside
// one in the same tab, `terminal.splitToNewGroup` opens it in a new dock group beside the tab
// (the behaviour before D209), `terminal.unsplit` moves one into a tab of its own (its shell
// keeps running), `terminal.focusNextPane` / `focusPreviousPane` (Alt+Right / Alt+Left, and
// Up / Down for stacked panes) and `terminal.resizePane`.
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { isHiddenTabId } from "./hidden";
import { neighbourPane, resizeAtSash } from "./split";
import type { TerminalPane, TerminalView } from "./view";

export interface SplitCommandHost {
  tabs: Map<string, TerminalView>;
  /** The terminal for `id`, else the most recent one (a new one when `create`). */
  target(id: number | undefined, create: boolean): Promise<TerminalPane>;
}

/** How far terminal.resizePane moves the sash (a share of the tab). */
const RESIZE_STEP = 0.05;

export function registerSplitCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  host: SplitCommandHost,
): void {
  const { dispatcher, dock } = services;
  const idInput = s
    .integer()
    .describe("Terminal id from ide://terminals (default: the most recent terminal)")
    .optional();
  const groupOf = (pane: TerminalPane): TerminalView => {
    const tab = host.tabs.get(pane.tabId);
    if (!tab)
      throw new Error(
        isHiddenTabId(pane.tabId)
          ? "That terminal is hidden: show it first (terminal.showHidden { id })."
          : "That terminal's tab is gone.",
      );
    return tab;
  };
  const describe = async (tab: TerminalView, pane: TerminalPane) => {
    const t = await pane.ready;
    return {
      id: t.id,
      tabId: tab.tabId,
      pane: tab.panes.indexOf(pane),
      panes: tab.panes.length,
      title: tab.title(),
    };
  };
  /** The focused terminal's tab when the keyboard is in one, else the target's. */
  const focusedPane = async (id: number | undefined): Promise<TerminalPane> => {
    if (id === undefined)
      for (const tab of host.tabs.values())
        for (const pane of tab.panes)
          if (pane.element.contains(document.activeElement)) return pane;
    return host.target(id, false);
  };

  sub.add(
    dispatcher.register({
      id: "terminal.split",
      title: "Split terminal",
      category: "Terminal",
      description:
        "Starts a new terminal beside one (default: the focused or most recent terminal) in the same tab, VS Code's split terminal: same folder and profile, a sash between them. Returns the new terminal's id and how many the tab now has.",
      input: s.object({
        id: idInput,
        profile: s
          .string()
          .describe("Terminal profile for the new one (default: the same)")
          .optional(),
      }),
      effects: ["exec"],
      run: async ({ id, profile }) => {
        const from = id === undefined ? await focusedPane(undefined).catch(() => null) : null;
        const pane = from ?? (await host.target(id, true));
        const tab = groupOf(pane);
        await pane.ready.catch(() => undefined);
        const state = pane.serialize();
        const base =
          state && typeof state === "object" && !Array.isArray(state)
            ? (state as Record<string, unknown>)
            : {};
        const cwd = pane.currentCwd();
        const next = tab.split(
          {
            ...(cwd && { cwd }),
            ...((profile ?? base.profile) ? { profile: String(profile ?? base.profile) } : {}),
          },
          tab.panes.indexOf(pane),
        );
        return describe(tab, next);
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "terminal.splitToNewGroup",
      title: "Split terminal into a new group",
      category: "Terminal",
      description:
        "Opens a new terminal (same folder) in a new dock group beside a terminal's tab, instead of inside the tab.",
      input: s.object({ id: idInput }),
      effects: ["exec"],
      run: async ({ id }) => {
        const pane = await host.target(id, true);
        const t = await pane.ready;
        const group = dock.findTab(pane.tabId)?.group;
        const tabId = dock.openView(
          "terminal",
          { cwd: t.cwd.peek() },
          group ? { groupId: group.id, split: "right" } : "bottom",
          true,
        );
        const created = host.tabs.get(tabId);
        const ready = created ? await created.ready.catch(() => undefined) : undefined;
        return { id: ready?.id ?? null, tabId };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "terminal.unsplit",
      title: "Unsplit terminal",
      category: "Terminal",
      description:
        "Moves a terminal out of a split tab into a tab of its own next to it; its shell keeps running.",
      input: s.object({ id: idInput }),
      effects: [],
      run: async ({ id }) => {
        const pane = await focusedPane(id);
        const tab = groupOf(pane);
        const t = await pane.ready;
        const state = tab.detachPane(pane);
        if (!state) return { id: t.id, tabId: tab.tabId, moved: false };
        const at = dock.findTab(tab.tabId);
        const tabId = dock.openView(
          "terminal",
          state,
          at ? { groupId: at.group.id, index: at.index + 1 } : "bottom",
          true,
        );
        return { id: t.id, tabId, moved: true };
      },
    }),
  );
  // Join (D229, VS Code's terminal.join / joinActiveTab): terminals from other tabs move into
  // one tab as splits, shells still running; a tab left empty closes. Also how a terminal moves
  // from one split tab to another (VS Code drags it in its tabs list).
  const joinInto = async (tab: TerminalView, panes: readonly TerminalPane[], focus: boolean) => {
    const moved: TerminalPane[] = [];
    for (const pane of panes) {
      if (pane.tabId === tab.tabId || moved.includes(pane)) continue;
      const from = groupOf(pane);
      if (from.takePane(pane)) moved.push(pane);
      else {
        // The last terminal of its tab: the tab goes, the pane comes along.
        moved.push(...from.detachAll().panes);
        await dock.closeTab(from.tabId, true).catch(() => {});
      }
    }
    tab.adoptPanes(moved, focus);
    return moved;
  };
  sub.add(
    dispatcher.register({
      id: "terminal.join",
      title: "Join terminals…",
      category: "Terminal",
      description:
        "Moves terminals from other tabs into one terminal's tab as splits (VS Code's Join terminals), their shells still running; a tab left with no terminal closes. `ids`: the terminals to move (with no ids the user picks one, or all the others); `into`: the terminal whose tab they join (default: the focused or most recent one). Returns the tab and its terminals.",
      input: s.object({
        ids: s
          .array(s.integer())
          .describe("Terminal ids from ide://terminals to move into the tab")
          .optional(),
        into: s
          .integer()
          .describe("A terminal of the tab they join (default: the focused or most recent one)")
          .optional(),
      }),
      effects: [],
      run: async ({ ids, into }) => {
        const target = await focusedPane(into);
        const tab = groupOf(target);
        let panes: TerminalPane[];
        if (ids) {
          panes = [];
          for (const id of ids) {
            const pane = await host.target(id, false);
            if (pane.instance?.id !== id) throw new Error(`No terminal with id ${id}`);
            groupOf(pane);
            panes.push(pane);
          }
        } else {
          const others = [...host.tabs.values()]
            .filter((t) => t !== tab)
            .flatMap((t) => t.panes)
            .filter((p) => p.instance);
          if (!others.length) throw new Error("There are no terminals in other tabs to join.");
          const all = "*all";
          const picked = await services.quickInput.pick(
            [
              ...others.map((p) => ({
                id: String(p.instance?.id),
                label: p.title(),
                description: `terminal ${p.instance?.id}`,
                icon: p.icon ?? ("square-terminal" as const),
              })),
              ...(others.length > 1
                ? [{ id: all, label: "All other terminals", icon: "terminal-split" as const }]
                : []),
            ],
            { placeholder: `Join a terminal into "${tab.title()}"` },
          );
          if (!picked) return { tabId: tab.tabId, joined: [] };
          panes =
            picked.id === all ? others : others.filter((p) => String(p.instance?.id) === picked.id);
        }
        const moved = await joinInto(tab, panes, ids === undefined);
        const terminals = await Promise.all(tab.panes.map((p) => p.ready.then((t) => t.id)));
        return {
          tabId: tab.tabId,
          joined: moved.flatMap((p) => (p.instance ? [p.instance.id] : [])),
          terminals,
          title: tab.title(),
        };
      },
    }),
  );
  for (const [command, title, direction] of [
    ["terminal.focusNextPane", "Focus next terminal in group", 1],
    ["terminal.focusPreviousPane", "Focus previous terminal in group", -1],
  ] as const)
    sub.add(
      dispatcher.register({
        id: command,
        title,
        category: "Terminal",
        description: `Moves the keyboard focus to the ${direction > 0 ? "next" : "previous"} terminal in a split tab (wraps around).`,
        input: s.object({ id: idInput }),
        effects: [],
        run: async ({ id }) => {
          const pane = await focusedPane(id);
          const tab = groupOf(pane);
          const index = neighbourPane(tab.panes.length, tab.panes.indexOf(pane), direction);
          const next = tab.focusPane(index) ?? pane;
          return describe(tab, next);
        },
      }),
    );
  sub.add(
    dispatcher.register({
      id: "terminal.resizePane",
      title: "Resize terminal",
      category: "Terminal",
      description:
        "Moves the sash next to a terminal of a split tab: `grow` widens (or heightens) it by a step, `shrink` narrows it.",
      input: s.object({
        id: idInput,
        change: s.enum(["grow", "shrink"] as const),
      }),
      effects: [],
      agent: "hidden",
      run: async ({ id, change }) => {
        const pane = await focusedPane(id);
        const tab = groupOf(pane);
        const index = tab.panes.indexOf(pane);
        if (tab.panes.length < 2) return { sizes: [1] };
        // The sash after the pane (or before the last one), moved by a step of 1000 "px".
        const sash = index < tab.panes.length - 1 ? index : index - 1;
        const sign = (change === "grow" ? 1 : -1) * (sash === index ? 1 : -1);
        const sizes = resizeAtSash(tab.paneSizes(), sash, sign * RESIZE_STEP * 1000, 1000, 50);
        tab.setSizes(sizes);
        return { sizes: tab.paneSizes() };
      },
    }),
  );
}

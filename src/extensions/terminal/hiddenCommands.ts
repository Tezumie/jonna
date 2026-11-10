// Hidden terminals (D217, VS Code's detach / "Attach to session" and its panel ×): "Hide
// terminal" (the × in the terminal toolbar, the context menu) takes a terminal tab out of the
// dock with its shells still running; agents' terminal tools keep working on it by id
// (terminal.readOutput, sendText, runCommand, kill…). "Show hidden terminal" (the ▾ menu's
// "Hidden terminals", the palette) opens a tab that adopts the same panes again, where the tab
// was. Hidden terminals end with the folder. They are saved with it (m7.12): after a page reload
// they come back hidden with their processes, after a restart with their output and a new shell.
import type { Json } from "../../core/dock/index";
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import type { MenuItem } from "../../ui/Menu";
import type { OpenPlacement } from "../../workbench/dock/service";
import type { WorkbenchServices } from "../../workbench/services";
import {
  type HiddenGroup,
  HiddenTerminals,
  hiddenRestoreKey,
  hiddenTabId,
  parseSavedHidden,
} from "./hidden";
import type { PaneOwner } from "./pane";
import { groupTitle } from "./split";
import { handOffPanes, type TerminalPane, type TerminalView } from "./view";

export interface HiddenCommandHost {
  tabs: Map<string, TerminalView>;
  /** The pane of terminal `id` (visible or hidden). */
  paneOf(id: number): TerminalPane | undefined;
  /** The focused terminal, else the most recent terminal tab's active one. */
  defaultPane(): TerminalPane | undefined;
  /** A pane for a hidden terminal restored with the folder (its process, or a new shell). */
  createPane(state: Json, owner: PaneOwner, restoreKey: string): TerminalPane;
}

export interface HiddenTerminalsApi {
  /** Where a hidden pane sits (its group's place in the list), or undefined when it's in a tab. */
  info(
    pane: TerminalPane,
  ): { index: number; panes: number; active: boolean; title: string } | undefined;
  /** Kills a hidden pane (terminal.kill); false when it isn't hidden. */
  kill(pane: TerminalPane): boolean;
  /** Opens its tab again (terminal.focus on a hidden terminal). */
  show(pane: TerminalPane, focus: boolean): string | undefined;
  /** Shows the most recently hidden tab (Ctrl+` with no terminal tab open); its tab id. */
  showLatest(focus: boolean): string | undefined;
  /** For ide://terminals. */
  state(): { ids: number[]; title: string; hiddenAt: string }[];
  /** The ▾ menu's part. */
  menu(): MenuItem[];
  /** Hidden panes by the key their screen is saved under (outputs.ts saves them). */
  panesForSave(): (readonly [string, TerminalPane])[];
}

export function registerHiddenTerminals(
  sub: DisposableStore,
  services: WorkbenchServices,
  host: HiddenCommandHost,
): HiddenTerminalsApi {
  const { dispatcher, dock, workspace, quickInput } = services;
  const hidden = new HiddenTerminals<TerminalPane>();
  const ids = (group: HiddenGroup<TerminalPane>) =>
    group.panes.flatMap((p) => (p.instance ? [p.instance.id] : []));
  const titleOf = (group: HiddenGroup<TerminalPane>) =>
    group.panes.length > 1
      ? groupTitle(group.panes.map((p) => p.title()))
      : (group.panes[0]?.title() ?? "Terminal");
  /** What a hidden pane reports to: no tab, never on screen. */
  const ownerFor = (group: HiddenGroup<TerminalPane>): PaneOwner => ({
    tabId: hiddenTabId(group.key),
    paneChanged: () => {},
    paneFocused: () => {},
    flash: () => {},
    paneCount: () => group.panes.length,
    isVisible: () => false,
  });
  const disposeAll = () => {
    for (const pane of hidden.clear()) pane.dispose();
  };
  sub.add({ dispose: disposeAll });
  // A folder closing ends its terminals; the hidden ones too (VS Code ends them with the window).
  sub.add(workspace.onDidClose(disposeAll));
  // Saved with the folder (m7.12, VS Code's persistent sessions): a reload takes their processes
  // back (Rust keeps them for a while), a restart starts new shells under their saved output.
  const persistent = () =>
    services.settings.peek<boolean>("terminal.enablePersistentSessions") !== false;
  sub.add(
    services.persistence.register("terminal.hidden", {
      save: () =>
        persistent()
          ? hidden
              .list()
              // An extension's transient terminals (hideFromUser, D388) aren't kept.
              .filter((g) => g.panes.some((p) => !p.transient))
              .map((g) => ({
                panes: g.panes.map((p) => p.serialize() ?? {}),
                sizes: g.sizes,
                active: g.active,
                hiddenAt: g.hiddenAt,
                place: g.place,
              }))
          : [],
      restore: (data) => {
        if (!persistent()) return;
        parseSavedHidden(data).forEach((saved, gi) => {
          // An owner until the group exists (the panes call it only once their shell runs).
          const waiting: PaneOwner = {
            tabId: hiddenTabId("restoring"),
            paneChanged: () => {},
            paneFocused: () => {},
            flash: () => {},
            paneCount: () => saved.panes.length,
            isVisible: () => false,
          };
          const panes = saved.panes.map((state, i) =>
            host.createPane(state, waiting, hiddenRestoreKey(gi, i)),
          );
          const group = hidden.add(panes, saved.sizes, saved.active, saved.place, saved.hiddenAt);
          const owner = ownerFor(group);
          for (const p of group.panes) p.rehome(owner);
          // One that couldn't start is dropped (nothing to show again).
          for (const p of group.panes)
            p.ready.catch(() => {
              if (hidden.removePane(p)) p.dispose();
            });
        });
      },
    }),
  );

  const hide = async (pane: TerminalPane, onlyThis: boolean) => {
    const tab = host.tabs.get(pane.tabId);
    if (!tab) throw new Error("That terminal's tab is gone.");
    const tabId = tab.tabId;
    const at = dock.findTab(tabId);
    // One terminal of a split tab (VS Code's detach session acts on one terminal, D229): the
    // others stay; shown again, it comes back in a tab of its own after this one.
    if (onlyThis && tab.takePane(pane)) {
      const group = hidden.add(
        [pane],
        [1],
        0,
        at ? { groupId: at.group.id, index: at.index + 1 } : null,
      );
      pane.rehome(ownerFor(group));
      return group;
    }
    const detached = tab.detachAll();
    const group = hidden.add(
      detached.panes,
      detached.sizes,
      detached.active,
      at ? { groupId: at.group.id, index: at.index } : null,
    );
    const owner = ownerFor(group);
    for (const p of group.panes) p.rehome(owner);
    await dock.closeTab(tabId, true);
    return group;
  };

  const show = (group: HiddenGroup<TerminalPane>, focus: boolean): string | undefined => {
    if (!hidden.take(group.key)) return undefined;
    // Back where the tab was, else beside the most recent terminal, else at the bottom.
    const place = group.place;
    const was = place ? dock.findGroup(place.groupId) : undefined;
    const near = dock.recentTab((t) => t.viewType === "terminal");
    const nearGroup = near ? dock.findTab(near.id)?.group : undefined;
    const placement: OpenPlacement =
      was && place
        ? { groupId: was.id, index: place.index }
        : nearGroup
          ? { groupId: nearGroup.id }
          : "bottom";
    const state = handOffPanes(
      { panes: group.panes, sizes: group.sizes, active: group.active },
      () => {
        // The tab didn't open: hidden again, still running.
        const owner = ownerFor(group);
        for (const p of group.panes) p.rehome(owner);
        hidden.restore(group);
      },
    );
    const tabId = dock.openView("terminal", state, placement, focus);
    const ref = dock.findTab(tabId);
    if (ref?.group.hidden) dock.setGroupsHidden([ref.group.id], false);
    // The view takes the panes now, even in a group that isn't drawn yet.
    const tab = ref?.group.tabs[ref.index];
    if (tab) dock.view(tab);
    if (focus) {
      dock.activateTab(tabId, true);
      host.tabs.get(tabId)?.focus();
    }
    return tabId;
  };

  const idInput = s
    .integer()
    .describe(
      "Terminal id from ide://terminals (any terminal of the tab; default: the focused or most recent one)",
    )
    .optional();

  sub.add(
    dispatcher.register({
      id: "terminal.hide",
      title: "Hide terminal",
      category: "Terminal",
      description:
        "Hides a terminal's tab (and the terminals split beside it) without ending them, VS Code's panel × / detach: the shells keep running, are listed under `hidden` in ide://terminals, and every terminal tool still works on them by id (terminal.readOutput, sendText, runCommand, kill). terminal.showHidden brings the tab back. `onlyThis`: in a split tab, hide just this terminal; the others stay.",
      input: s.object({
        id: idInput,
        onlyThis: s
          .boolean()
          .describe("Hide only this terminal of a split tab (default: the whole tab)")
          .optional(),
      }),
      effects: [],
      run: async ({ id, onlyThis }) => {
        const pane = id !== undefined ? host.paneOf(id) : host.defaultPane();
        if (!pane)
          throw new Error(id !== undefined ? `No terminal with id ${id}` : "No terminal to hide.");
        const already = hidden.groupOf(pane);
        const group = already ?? (await hide(pane, onlyThis === true));
        return {
          ids: ids(group),
          title: titleOf(group),
          alreadyHidden: !!already,
          hiddenCount: hidden.size,
          note: "Still running. Show it again with terminal.showHidden { id }; end it with terminal.kill { id }.",
        };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "terminal.showHidden",
      title: "Show hidden terminal…",
      category: "Terminal",
      description:
        "Shows a hidden terminal's tab again (VS Code's attach to session), where it was: `id` names one (any terminal of the hidden tab), `all` shows every hidden one; with neither, the only hidden terminal, or a picker when there are several. Returns the tab ids.",
      input: s.object({
        id: idInput,
        all: s.boolean().describe("Show every hidden terminal").optional(),
      }),
      effects: [],
      run: async ({ id, all }) => {
        let groups: HiddenGroup<TerminalPane>[];
        if (id !== undefined) {
          const pane = host.paneOf(id);
          if (!pane) throw new Error(`No terminal with id ${id}`);
          const group = hidden.groupOf(pane);
          if (!group) {
            // Not hidden: it's already in a tab; just reveal it.
            await dispatcher.execute("terminal.focus", { id });
            return { shown: [], note: `Terminal ${id} isn't hidden; focused its tab.` };
          }
          groups = [group];
        } else {
          const list = hidden.list();
          if (!list.length) throw new Error("No hidden terminals.");
          if (all || list.length === 1) groups = [...list];
          else {
            const picked = await quickInput.pick(
              list.map((g) => ({
                id: g.key,
                label: titleOf(g),
                description: ids(g).length ? `terminal ${ids(g).join(", ")}` : "",
                icon: g.panes[0]?.icon ?? ("square-terminal" as const),
              })),
              { placeholder: "Show a hidden terminal" },
            );
            const group = picked ? hidden.get(picked.id) : undefined;
            if (!group) return { shown: [] };
            groups = [group];
          }
        }
        const shown = groups.map((g, i) => ({
          ids: ids(g),
          tabId: show(g, i === groups.length - 1) ?? null,
        }));
        return { shown, hiddenCount: hidden.size };
      },
    }),
  );

  return {
    info: (pane) => {
      const group = hidden.groupOf(pane);
      if (!group) return undefined;
      const index = group.panes.indexOf(pane);
      return {
        index,
        panes: group.panes.length,
        active: group.active === index,
        title: titleOf(group),
      };
    },
    kill: (pane) => {
      if (!hidden.removePane(pane)) return false;
      pane.dispose();
      return true;
    },
    show: (pane, focus) => {
      const group = hidden.groupOf(pane);
      return group ? show(group, focus) : undefined;
    },
    showLatest: (focus) => {
      const latest = hidden.list()[0];
      return latest ? show(latest, focus) : undefined;
    },
    panesForSave: () =>
      hidden
        .list()
        .flatMap((g, gi) => g.panes.map((p, i) => [hiddenRestoreKey(gi, i), p] as const)),
    state: () =>
      hidden.list().map((g) => ({
        ids: ids(g),
        title: titleOf(g),
        hiddenAt: new Date(g.hiddenAt).toISOString(),
      })),
    menu: () => {
      const list = hidden.list();
      if (!list.length) return [];
      const run = (input: unknown) => () =>
        void dispatcher.execute("terminal.showHidden", input).catch(() => {});
      return [
        {
          label: `Hidden terminals (${list.length})`,
          icon: "eye-off",
          separatorBefore: true,
          submenu: [
            ...list.map((g) => {
              const first = ids(g)[0];
              return {
                label: titleOf(g),
                icon: g.panes[0]?.icon ?? ("square-terminal" as const),
                run: run(first !== undefined ? { id: first } : { all: true }),
              };
            }),
            {
              label: "Show all hidden terminals",
              icon: "eye",
              separatorBefore: true,
              run: run({ all: true }),
            },
          ],
        },
      ];
    },
  };
}

// `layout.*` commands for the dock tree (docs/dock.md §7): the only way the UI, keybindings and
// agents change it. Every drag-and-drop and tab click runs one of these. Sidebar, regions and
// panel toggles: regionCommands.ts.
import type { Side, TabTarget } from "../../core/dock/index";
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import {
  availableEntries,
  NEW_TAB_KINDS,
  type NewTabKind,
  viewTypeOf,
} from "../../workbench/dock/newTab";
import type { OpenPlacement } from "../../workbench/dock/service";
import { toolsOf } from "../../workbench/extensionFeatures";
import type { WorkbenchServices } from "../../workbench/services";
import { editorFolder } from "../tasks/chooseFolder";

const SIDES = ["left", "right", "top", "bottom"] as const;
const DIRECTIONS = ["left", "right", "up", "down"] as const;
type Direction = (typeof DIRECTIONS)[number];
const toSide = (d: Direction): Side => (d === "up" ? "top" : d === "down" ? "bottom" : d);

const tabTarget = s.union(
  s.object({
    groupId: s.string().describe("Target group id (ide://layout)"),
    index: s
      .integer({ min: 0 })
      .describe("Insert position in the tab strip (default: end)")
      .optional(),
  }),
  s.object({
    groupId: s.string(),
    split: s.enum(SIDES).describe("Split the group and put the tab on this side"),
  }),
  s.object({
    root: s.enum(SIDES).describe("Split the whole dock (full height/width) on this side"),
  }),
);
const placement = s.union(
  s
    .enum(["main", "bottom", "right"] as const)
    .describe("Region hint: the nearest group there, created if missing"),
  tabTarget,
);

export function registerLayoutCommands(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, dock } = services;
  const register: typeof dispatcher.register = (command) =>
    sub.add(dispatcher.register({ category: "View", ...command }));
  const groupOrFocused = (groupId: string | undefined) => {
    const group = groupId ? dock.findGroup(groupId) : dock.focusedGroup();
    if (!group) throw new Error(groupId ? `No group ${groupId}` : "No group is focused.");
    return group;
  };

  register({
    id: "layout.openView",
    title: "Open view",
    description:
      "Opens a view as a dock tab (editor, terminal, agent, welcome…). A singleton view that is already open is revealed instead. `placement` is a region hint or an exact target; default is the view type's own region.",
    input: s.object({
      viewType: s
        .string()
        .describe(
          `View type, one of: ${"editor, terminal, agent, welcome"} (see ide://layout viewTypes)`,
        ),
      state: s
        .unknown()
        .describe("View state, e.g. { path } for an editor or { cwd } for a terminal")
        .optional(),
      placement: placement.optional(),
      focus: s.boolean().describe("Focus the new tab (default true)").optional(),
    }),
    effects: [],
    agent: "core",
    palette: false,
    run: ({ viewType, state, placement: where, focus }) => {
      const tabId = dock.openView(
        viewType,
        (state ?? null) as never,
        where as OpenPlacement | undefined,
        focus ?? true,
      );
      if (viewType !== "welcome" && dock.isEditorLike({ id: tabId, viewType, viewState: null }))
        for (const t of dock.tabs("welcome")) void dock.closeTab(t.id, true);
      return { tabId, groupId: dock.findTab(tabId)?.group.id ?? null };
    },
  });
  register({
    id: "layout.moveTab",
    title: "Move tab",
    description:
      "Moves a tab into a group, into a new split next to a group, or to an edge of the dock — the same operation drag and drop performs.",
    input: s.object({ tabId: s.string().describe("Tab id (ide://layout)"), to: tabTarget }),
    effects: [],
    agent: "core",
    palette: false,
    run: ({ tabId, to }) => {
      dock.moveTab(tabId, to as TabTarget);
      return { groupId: dock.findTab(tabId)?.group.id ?? null };
    },
  });
  register({
    id: "layout.moveGroup",
    title: "Move group",
    description:
      "Moves a whole group with all its tabs: into another group's tab strip, into a new split next to a group, or to an edge of the dock — what dragging a group by its tab strip does.",
    input: s.object({ groupId: s.string().describe("Group id (ide://layout)"), to: tabTarget }),
    effects: [],
    agent: "core",
    palette: false,
    run: ({ groupId, to }) => {
      dock.moveGroup(groupId, to as TabTarget);
      return { groupId: dock.findGroup(groupId) ? groupId : null };
    },
  });
  register({
    id: "layout.splitActive",
    title: "Split group",
    description:
      "Splits the focused group (or `groupId`): the active tab is duplicated into the new group when its view supports it (editors, terminals), otherwise moved there.",
    input: s.object({
      direction: s.enum(DIRECTIONS).describe("Where the new group goes (default right)").optional(),
      groupId: s.string().optional(),
    }),
    effects: [],
    run: ({ direction, groupId }) => {
      const group = groupOrFocused(groupId);
      const tab = group.tabs.find((t) => t.id === group.activeTabId);
      if (!tab) throw new Error("The group has no tab to split.");
      const side: Side = toSide(direction ?? "right");
      const duplicate = dock
        .descriptor(tab)
        ?.duplicate?.(dock.liveView(tab.id)?.serialize() ?? tab.viewState);
      if (duplicate !== undefined && duplicate !== null) {
        const id = dock.openView(tab.viewType, duplicate, { groupId: group.id, split: side });
        return { tabId: id };
      }
      if (group.tabs.length < 2)
        throw new Error("This tab can't be duplicated, and it is the group's only tab.");
      dock.moveTab(tab.id, { groupId: group.id, split: side });
      return { tabId: tab.id };
    },
  });
  register({
    id: "layout.focusGroup",
    title: "Focus group",
    description: "Focuses the group next to the focused one in a direction, or a group by id.",
    input: s.object({
      direction: s.enum(DIRECTIONS).optional(),
      groupId: s.string().optional(),
      focusView: s
        .boolean()
        .describe("Move keyboard focus into the group's active view (default true)")
        .optional(),
    }),
    effects: [],
    palette: false,
    run: ({ direction, groupId, focusView }) => {
      if (groupId) return dock.focusGroup(groupId, focusView ?? true);
      if (!direction) throw new Error("Pass a direction or a groupId.");
      const from = dock.focusedGroup();
      const next = from && dock.neighbor(from.id, toSide(direction));
      if (next) dock.focusGroup(next, focusView ?? true);
    },
  });
  for (const d of DIRECTIONS) {
    register({
      id: `layout.focusGroup.${d}`,
      title: `Focus group ${d === "up" ? "above" : d === "down" ? "below" : `on the ${d}`}`,
      description: `Focuses the group ${d === "up" ? "above" : d === "down" ? "below" : `to the ${d} of`} the focused one.`,
      input: s.empty(),
      effects: [],
      agent: "hidden",
      run: (_i, ctx) => ctx.execute("layout.focusGroup", { direction: d }),
    });
    register({
      id: `layout.moveTabToGroup.${d}`,
      title: `Move tab ${d === "up" ? "up" : d === "down" ? "down" : d}`,
      description: `Moves the active tab to the group ${d === "up" ? "above" : d === "down" ? "below" : `on the ${d}`} (splitting if there is none).`,
      input: s.empty(),
      effects: [],
      agent: "hidden",
      run: (_i, ctx) => ctx.execute("layout.moveTabToGroup", { direction: d }),
    });
  }
  register({
    id: "layout.focusTab",
    title: "Focus tab",
    description: "Activates a tab and focuses its view.",
    input: s.object({ tabId: s.string(), focus: s.boolean().optional() }),
    effects: [],
    palette: false,
    run: ({ tabId, focus }) => {
      if (!dock.findTab(tabId)) throw new Error(`No tab ${tabId}`);
      dock.activateTab(tabId, focus ?? true);
    },
  });
  register({
    id: "layout.pinTab",
    title: "Keep tab open",
    description:
      "Turns a preview (italic) tab into a normal tab so the next preview doesn't replace it.",
    input: s.object({ tabId: s.string().optional(), doubleClick: s.boolean().optional() }),
    effects: [],
    run: ({ tabId, doubleClick }) => {
      const id = tabId ?? dock.focusedGroup()?.activeTabId;
      if (!id) return;
      // A double-clicked tab: the view may use it (a terminal renames itself).
      if (doubleClick && dock.liveView(id)?.onTabDoubleClick?.()) return;
      dock.pinTab(id);
    },
  });
  register({
    id: "layout.moveTabToGroup",
    title: "Move tab to group",
    description:
      "Moves the active tab of the focused group to the neighboring group in a direction; splits the dock that way if there is no group there.",
    input: s.object({ direction: s.enum(DIRECTIONS), tabId: s.string().optional() }),
    effects: [],
    palette: false,
    run: ({ direction, tabId }) => {
      const from = tabId ? dock.findTab(tabId)?.group : dock.focusedGroup();
      const id = tabId ?? from?.activeTabId;
      if (!from || !id) throw new Error("No tab to move.");
      const next = dock.neighbor(from.id, toSide(direction));
      dock.moveTab(id, next ? { groupId: next } : { groupId: from.id, split: toSide(direction) });
      return { groupId: dock.findTab(id)?.group.id ?? null };
    },
  });
  register({
    id: "layout.closeTab",
    title: "Close tab",
    description:
      "Closes a tab (default: the active tab of the focused group). Editors with unsaved changes ask Save / Don't save / Cancel.",
    input: s.object({ tabId: s.string().optional() }),
    effects: ["write"],
    agent: "core",
    run: async ({ tabId }) => {
      const id = tabId ?? dock.focusedGroup()?.activeTabId;
      if (!id) throw new Error("No tab to close.");
      return { closed: await dock.closeTab(id) };
    },
  });
  register({
    id: "layout.closeGroup",
    title: "Close group",
    description:
      "Closes every tab in a group (default: the focused group), asking about unsaved editors.",
    input: s.object({ groupId: s.string().optional() }),
    effects: ["write"],
    run: async ({ groupId }) => ({ closed: await dock.closeGroup(groupOrFocused(groupId).id) }),
  });
  register({
    id: "layout.toggleMaximize",
    title: "Toggle maximize group",
    description:
      "Maximizes a group to fill the dock (default: the focused group), or restores the layout.",
    input: s.object({ groupId: s.string().optional() }),
    effects: [],
    run: ({ groupId }) => {
      dock.toggleMaximize(groupId);
      return { maximizedGroupId: dock.maximizedGroupId() };
    },
  });
  register({
    id: "layout.resizeGroup",
    title: "Resize group",
    description:
      "Sets a group's share of its parent split (0.05–0.95); siblings share the rest proportionally.",
    input: s.object({
      groupId: s.string(),
      size: s.number({ min: 0, max: 1 }).describe("Fraction of the parent split"),
    }),
    effects: [],
    palette: false,
    run: ({ groupId, size }) => dock.resizeGroup(groupId, size),
  });
  register({
    id: "layout.setSplitSizes",
    title: "Set split sizes",
    description:
      "Sets all child sizes of the split at `path` (child indices from the root). Used by splitter drags.",
    input: s.object({ path: s.array(s.integer({ min: 0 })), sizes: s.array(s.number({ min: 0 })) }),
    effects: [],
    agent: "hidden",
    palette: false,
    run: ({ path, sizes }) => dock.setSplitSizes(path, sizes),
  });
  register({
    id: "layout.equalize",
    title: "Equalize group sizes",
    description: "Gives every group equal space (or only the children of the split at `path`).",
    input: s.object({ path: s.array(s.integer({ min: 0 })).optional() }),
    effects: [],
    run: ({ path }) => dock.equalize(path),
  });
  register({
    id: "layout.reset",
    title: "Reset layout",
    description:
      "Restores the default arrangement (editors main, terminals bottom, agent right), keeping every open tab.",
    input: s.empty(),
    effects: [],
    run: () => dock.reset(),
  });
  register({
    id: "layout.nextTab",
    title: "Next tab",
    description: "Activates the next tab in the focused group (wraps).",
    input: s.empty(),
    effects: [],
    run: () => cycle(1),
  });
  register({
    id: "layout.previousTab",
    title: "Previous tab",
    description: "Activates the previous tab in the focused group (wraps).",
    input: s.empty(),
    effects: [],
    run: () => cycle(-1),
  });
  register({
    id: "layout.newTab",
    title: "New tab…",
    description:
      "Opens something in a group (default: the focused group): `kind` file (asks for a name), open (quick open), terminal, browser, agent, problems, settings, keybindings, models (AI models), docs, debugConsole or welcome. Without `kind`, asks with a picker.",
    input: s.object({
      groupId: s.string().optional(),
      kind: s.enum(NEW_TAB_KINDS).optional(),
      tool: s
        .string()
        .describe("An extension tool's command (View → Tools lists them), run in this group")
        .optional(),
      toolInput: s.unknown().optional(),
    }),
    effects: [],
    run: async ({ groupId, kind, tool, toolInput }, ctx) => {
      const group = groupOrFocused(groupId);
      let chosen: NewTabKind | undefined = kind;
      let toolCommand = tool;
      let toolArgs = toolInput;
      if (!chosen && !toolCommand) {
        const tools = toolsOf(services.extensionFeatures, services.context);
        const picked = await services.quickInput.pick(
          [
            ...availableEntries((type) => !!dock.views.get(type)).map((e) => ({
              id: e.kind,
              label: e.label,
              icon: e.icon,
              keybinding: e.shortcutOf ? services.keyboard.labelFor(e.shortcutOf) : undefined,
            })),
            ...tools.map((t, i) => ({ id: `tool:${i}`, label: t.label, icon: t.icon })),
          ],
          { placeholder: "Open in this group" },
        );
        const index = picked?.id.startsWith("tool:") ? Number(picked.id.slice(5)) : -1;
        if (index >= 0) {
          toolCommand = tools[index]?.command;
          toolArgs = tools[index]?.input;
        } else chosen = picked?.id as NewTabKind | undefined;
      }
      // Commands that open "in the active group" (new file, quick open) need the group focused.
      if (toolCommand) {
        dock.focusGroup(group.id, false);
        await ctx.execute(toolCommand, toolArgs ?? {});
        return { tabId: null };
      }
      if (!chosen) return { tabId: null };
      dock.focusGroup(group.id, false);
      if (chosen === "file") {
        await dispatcher.execute("explorer.newFile", {});
        return { tabId: null };
      }
      if (chosen === "open") {
        await dispatcher.execute("quickOpen.show", {});
        return { tabId: null };
      }
      // A new terminal starts in the editor's folder of a multi-root workspace (D251), else the
      // first folder.
      const root =
        (services.workspace.folders.peek().length > 1 ? editorFolder(services) : undefined) ??
        services.workspace.root.peek();
      const state =
        chosen === "terminal"
          ? root
            ? { cwd: root }
            : {}
          : chosen === "settings"
            ? { scope: "user" }
            : null;
      const viewType = viewTypeOf(chosen);
      if (!dock.views.get(viewType)) throw new Error(`Nothing here opens "${chosen}".`);
      const tabId = dock.openView(viewType, state as never, { groupId: group.id }, true);
      // Singletons (agent, problems…) are revealed where they are; bring them here.
      if (dock.findTab(tabId)?.group.id !== group.id && dock.findGroup(group.id))
        dock.moveTab(tabId, { groupId: group.id });
      return { tabId };
    },
  });
  const cycle = (step: 1 | -1) => {
    const group = dock.focusedGroup();
    if (!group || group.tabs.length === 0) return;
    const i = group.tabs.findIndex((t) => t.id === group.activeTabId);
    const next = group.tabs[(i + step + group.tabs.length) % group.tabs.length];
    if (next) dock.activateTab(next.id, true);
  };
}

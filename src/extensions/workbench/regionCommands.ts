// Region-level commands: the fixed sidebar, the title-bar region toggles (bottom/right), the panel
// toggle (Ctrl/Cmd+J), the agent (Ctrl/Cmd+L), `layout.getTree` and sidebar views (`view.*`).
import { SIDEBAR_LIMITS } from "../../core/layout/index";
import type { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { mergeOrder, moveInOrder, orderViews, parseOrder } from "../../workbench/activityOrder";
import type { Region } from "../../workbench/dock/service";
import type { WorkbenchServices } from "../../workbench/services";
import type { Workbench } from "../../workbench/workbench";
import { layoutTree } from "./layoutState";

export function registerRegionCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  workbench: Workbench,
): void {
  const { dispatcher, dock, layout } = services;
  const register: typeof dispatcher.register = (command) =>
    sub.add(dispatcher.register({ category: "View", ...command }));
  // ---- Sidebar and regions ------------------------------------------------------------
  register({
    id: "layout.toggleSidebar",
    title: "Toggle sidebar",
    description: "Shows or hides the left sidebar (explorer). See ide://layout sidebar.",
    input: s.empty(),
    effects: [],
    run: () => {
      const hadFocus = workbench.sidebarHasFocus();
      layout.sidebarVisible.value = !layout.sidebarVisible.peek();
      if (!layout.sidebarVisible.peek() && hadFocus) focusMain();
    },
  });
  // Zen mode: only the editors — sidebar, activity bar, status bar and the bottom/right regions go
  // away, and come back as they were.
  let zen: { sidebar: boolean; bottom: boolean; right: boolean } | null = null;
  register({
    id: "layout.toggleZenMode",
    title: "Toggle zen mode",
    description:
      "Hides everything but the editors (sidebar, activity bar, status bar, panels, agent), or brings them back as they were.",
    input: s.empty(),
    effects: [],
    run: () => {
      const root = document.querySelector(".workbench");
      if (!zen) {
        zen = {
          sidebar: layout.sidebarVisible.peek(),
          bottom: dock.regionVisible("bottom").peek(),
          right: dock.regionVisible("right").peek(),
        };
        layout.sidebarVisible.value = false;
        if (zen.bottom) dock.toggleRegion("bottom");
        if (zen.right) dock.toggleRegion("right");
        root?.classList.add("is-zen");
        services.context.set("zenMode", true);
        focusMain();
        return { zen: true };
      }
      const was = zen;
      zen = null;
      layout.sidebarVisible.value = was.sidebar;
      if (was.bottom && !dock.regionVisible("bottom").peek()) dock.toggleRegion("bottom");
      if (was.right && !dock.regionVisible("right").peek()) dock.toggleRegion("right");
      root?.classList.remove("is-zen");
      services.context.set("zenMode", false);
      return { zen: false };
    },
  });
  register({
    id: "layout.setSidebarWidth",
    title: "Set sidebar width",
    description: `Sets the sidebar width in CSS px (clamped to ${SIDEBAR_LIMITS.min}–${SIDEBAR_LIMITS.max}).`,
    input: s.object({ width: s.integer({ min: 0 }).describe("Width in CSS px") }),
    effects: [],
    palette: false,
    run: ({ width }) => {
      layout.resizeSidebar(width);
      return { width: layout.sidebarSize.peek() };
    },
  });
  const focusMain = () => {
    const recent = dock.recentTab(dock.isEditorLike) ?? dock.activeTab();
    if (recent) dock.activateTab(recent.id, true);
  };
  const openDefault = (
    region: Region,
    execute: (id: string, input?: unknown) => Promise<unknown>,
  ) => (region === "bottom" ? execute("terminal.create") : execute("layout.focusAgent"));
  register({
    id: "layout.toggleRegion",
    title: "Toggle region",
    description:
      "Hides the groups in the bottom or right region of the dock, or restores them at their previous size. With nothing there, opens a terminal (bottom) or the agent (right).",
    input: s.object({ region: s.enum(["bottom", "right"] as const) }),
    effects: [],
    palette: false,
    run: async ({ region }, ctx) => {
      if (!dock.toggleRegion(region)) await openDefault(region, ctx.execute);
    },
  });
  register({
    id: "layout.toggleBottomRegion",
    title: "Toggle bottom region",
    description:
      "Hides or restores the groups at the bottom of the dock (opens a terminal if there are none).",
    input: s.empty(),
    effects: [],
    agent: "hidden",
    run: (_i, ctx) => ctx.execute("layout.toggleRegion", { region: "bottom" }),
  });
  register({
    id: "layout.toggleRightRegion",
    title: "Toggle right region",
    description:
      "Hides or restores the groups on the right of the dock (opens the agent if there are none).",
    input: s.empty(),
    effects: [],
    agent: "hidden",
    run: (_i, ctx) => ctx.execute("layout.toggleRegion", { region: "right" }),
  });
  register({
    id: "layout.togglePanel",
    title: "Toggle panel",
    description:
      "Hides the group holding the most recent non-editor tab (terminal, problems, output), or restores it at the same size. Opens a terminal at the bottom if there is none.",
    input: s.empty(),
    effects: [],
    run: async (_i, ctx) => {
      const tab = dock.recentTab((t) => !dock.isEditorLike(t) && t.viewType !== "agent");
      const group = tab && dock.findTab(tab.id)?.group;
      if (!tab || !group) {
        await ctx.execute("terminal.create");
        return;
      }
      // A group that also holds editors is never hidden; toggle between the tab and the last editor.
      if (group.tabs.some(dock.isEditorLike)) {
        const editor = dock.recentTab((t) => dock.isEditorLike(t) && t.id !== tab.id);
        const showing = group.activeTabId === tab.id && dock.focusedGroupId.peek() === group.id;
        dock.activateTab(showing && editor ? editor.id : tab.id, true);
        return;
      }
      if (group.hidden) {
        dock.setGroupsHidden([group.id], false);
        dock.activateTab(tab.id, true);
      } else {
        const hadFocus = dock.focusedGroupId.peek() === group.id;
        dock.setGroupsHidden([group.id], true);
        if (hadFocus) focusMain();
      }
    },
  });
  register({
    id: "layout.focusAgent",
    title: "Focus agent",
    description: "Focuses the most recent agent session tab, opening one on the right if needed.",
    input: s.empty(),
    effects: [],
    run: () => {
      const recent = dock.recentTab((t) => t.viewType === "agent");
      if (recent) dock.activateTab(recent.id, true);
      const tabId = recent?.id ?? dock.openView("agent", null, "right", true);
      const group = dock.findTab(tabId)?.group;
      if (group?.hidden) dock.setGroupsHidden([group.id], false);
    },
  });
  register({
    id: "layout.getTree",
    title: "Get layout tree",
    description: "Returns the dock tree and sidebar state (same as the ide://layout state path).",
    input: s.empty(),
    effects: [],
    agent: "core",
    palette: false,
    run: () => layoutTree(services, workbench.dockSize()),
  });

  // ---- Sidebar views -------------------------------------------------------------------
  const viewInput = s.object({ id: s.string().describe("Sidebar view id, e.g. explorer.view") });
  register({
    id: "view.show",
    title: "Show sidebar view",
    description: "Shows and focuses a sidebar view by id (opening the sidebar if hidden).",
    input: viewInput,
    effects: [],
    palette: false,
    run: ({ id }) => {
      if (!workbench.showSidebarView(id)) throw new Error(`Unknown view "${id}"`);
    },
  });
  register({
    id: "view.toggleSection",
    title: "Expand or collapse a sidebar section",
    description:
      "Expands or collapses a view docked as a section at the bottom of another (a view with a home view, e.g. outline.view under the Explorer, while its activity bar icon is hidden). `collapsed` sets it; without it, toggles.",
    input: s.object({
      id: s.string().describe("Sidebar view id, e.g. outline.view"),
      collapsed: s.boolean().optional(),
    }),
    effects: [],
    palette: false,
    run: ({ id, collapsed }) => {
      const { views } = services;
      if (!views.sectionHost(id)) throw new Error(`"${id}" isn't shown as a section.`);
      const next = collapsed ?? !views.section(id).collapsed;
      views.setSection(id, { collapsed: next });
      if (!next) requestAnimationFrame(() => views.focus(id));
      return { collapsed: next };
    },
  });
  register({
    id: "view.resizeSection",
    title: "Resize a sidebar section",
    description:
      "Sets the height of a view docked as a section (outline.view under the Explorer, scm.graph under Source control…), as dragging the edge above it does; kept per workspace. The sidebar keeps room for the view above, so a tall height is clamped when shown.",
    input: s.object({
      id: s.string().describe("Sidebar view id, e.g. scm.graph"),
      height: s.integer({ min: 80, max: 4000 }).describe("Height in px"),
    }),
    effects: [],
    palette: false,
    run: ({ id, height }) => {
      const { views } = services;
      if (!views.sectionHost(id)) throw new Error(`"${id}" isn't shown as a section.`);
      views.setSection(id, { height });
      return { height };
    },
  });
  register({
    id: "view.toggle",
    title: "Toggle sidebar view",
    description:
      "Shows a sidebar view, or hides the sidebar if that view is already showing (activity bar behavior).",
    input: viewInput,
    effects: [],
    palette: false,
    run: ({ id }) => {
      if (layout.sidebarVisible.peek() && services.views.active.peek() === id)
        layout.sidebarVisible.value = false;
      else if (!workbench.showSidebarView(id)) throw new Error(`Unknown view "${id}"`);
    },
  });

  // Activity bar icons the user hid (right-click → Hide); the views stay reachable by command.
  const { settings, views } = services;
  sub.add(
    effect(() => {
      settings.version.value;
      layout.sidebarSide.value =
        settings.peek<string>("workbench.sideBar.location") === "right" ? "right" : "left";
      return undefined;
    }),
  );
  register({
    id: "layout.toggleSidebarPosition",
    title: "Move sidebar to the other side",
    description:
      "Moves the activity bar and sidebar between the left and right of the window (workbench.sideBar.location).",
    input: s.object({ side: s.enum(["left", "right"] as const).optional() }),
    effects: [],
    run: async ({ side }) => {
      const next = side ?? (layout.sidebarSide.peek() === "right" ? "left" : "right");
      await settings.update(
        "workbench.sideBar.location",
        next === "left" ? undefined : next,
        "user",
      );
      layout.sidebarSide.value = next;
      return { side: next };
    },
  });
  sub.add(
    effect(() => {
      settings.version.value;
      const list = settings.peek<unknown>("workbench.activityBar.hidden");
      views.hidden.value = new Set(
        Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [],
      );
      return undefined;
    }),
  );
  register({
    id: "view.setHidden",
    title: "Hide or show an activity bar icon",
    description:
      "Hides (or shows again) a sidebar view's activity bar icon; `all` with hidden: false shows every icon. Stored in workbench.activityBar.hidden.",
    input: s.object({
      id: s.string().describe("Sidebar view id").optional(),
      all: s.boolean().optional(),
      hidden: s.boolean(),
    }),
    effects: [],
    palette: false,
    run: async ({ id, all, hidden }) => {
      const current = [...views.hidden.peek()];
      const next = all
        ? hidden
          ? views.all.peek().map((v) => v.id)
          : []
        : hidden
          ? [...new Set([...current, id ?? ""])].filter(Boolean)
          : current.filter((x) => x !== id);
      await settings.update("workbench.activityBar.hidden", next, "user");
      // Hiding the view the sidebar shows switches to the first one still shown (VS Code);
      // with none left, the sidebar closes.
      const active = views.active.peek();
      if (hidden && active && next.includes(active)) {
        const other = orderViews(views.all.peek(), views.order.peek()).find(
          (v) => !next.includes(v.id),
        );
        if (other) await dispatcher.execute("view.show", { id: other.id });
        else await dispatcher.execute("layout.toggleSidebar");
      }
      return { hidden: next };
    },
  });

  // The activity bar's icon order: a user setting like workbench.activityBar.hidden (global, not
  // per workspace, so the bar looks the same in every folder; VS Code keeps it per profile).
  // workbench.activityBar.order (extension.json, D169) → the registry's order.
  sub.add(
    effect(() => {
      settings.version.value;
      const next = parseOrder(settings.peek<unknown>("workbench.activityBar.order"));
      const current = views.order.peek();
      if (next.length !== current.length || next.some((id, i) => id !== current[i]))
        views.order.value = next;
      return undefined;
    }),
  );
  register({
    id: "view.move",
    title: "Move an activity bar icon",
    description:
      "Moves a sidebar view's activity bar icon to just before another view's icon (`before`), or to the end without it (what dragging an icon does). Stored in workbench.activityBar.order; returns the new order of view ids.",
    input: s.object({
      id: s.string().describe("Sidebar view id to move, e.g. search.view"),
      before: s
        .string()
        .describe("Sidebar view id it goes before; omit to move it to the end")
        .optional(),
    }),
    effects: [],
    palette: false,
    run: async ({ id, before }) => {
      if (!views.get(id)) throw new Error(`Unknown view "${id}"`);
      if (before !== undefined && !views.get(before)) throw new Error(`Unknown view "${before}"`);
      const registered = views.all.peek().map((v) => v.id);
      // The full current order (including views registered later and ones not loaded now), so
      // the move doesn't reshuffle anything else.
      const merged = mergeOrder(views.order.peek(), registered);
      const next = moveInOrder(merged, id, before);
      views.order.value = next;
      await settings.update("workbench.activityBar.order", next, "user");
      return { order: next };
    },
  });
}

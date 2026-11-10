// Movable sidebar views (VS Code's "Move view", D233): a view whose descriptor says `movable` can
// leave the sidebar for a dock tab and come back. The tab (type SIDEBAR_VIEW_TYPE, state `{ id }`)
// hosts the view's own instance, so where a view is persists with the dock, per workspace, and
// closing the tab returns it to the sidebar. `view.moveView` does the move; dragging a view's
// header onto the dock or its tab onto the sidebar runs it too. State: ide://views/moved.
import type { Json, TabRef } from "../core/dock/index";
import { h } from "../core/dom/index";
import { type Disposable, DisposableStore, toDisposable } from "../core/lifecycle/index";
import { batch, effect } from "../core/reactive/index";
import { s } from "../core/schema/index";
import type { OpenPlacement } from "./dock/service";
import type { DockView, TabAction } from "./dock/views";
import {
  moveDestination,
  movedViewId,
  movedViewIds,
  SIDEBAR_VIEW_TYPE,
  sameIds,
  tabOfMovedView,
} from "./movedViews";
import type { WorkbenchServices } from "./services";
import type { ViewDescriptor, ViewInstance } from "./views";

const SIDES = ["left", "right", "top", "bottom"] as const;

/** Where in the dock a moved view goes: a region hint or an exact target (as layout.openView). */
const placementSchema = s.union(
  s
    .enum(["main", "bottom", "right"] as const)
    .describe("Region hint: the nearest group there, created if missing"),
  s.object({
    groupId: s.string().describe("Target group id (ide://layout)"),
    index: s.integer({ min: 0 }).optional(),
  }),
  s.object({ groupId: s.string(), split: s.enum(SIDES) }),
  s.object({ root: s.enum(SIDES).describe("Split the whole dock on this side") }),
);

export function registerMovableViews(
  services: WorkbenchServices,
  sidebar: HTMLElement,
): Disposable {
  const store = new DisposableStore();
  const { dock, views, dispatcher, quickInput } = services;

  const allTabs = (): TabRef[] => dock.tabs(SIDEBAR_VIEW_TYPE);

  // Which views are in the dock follows the dock's tabs (restored, closed, moved by agents).
  store.add(
    effect(() => {
      dock.root.value;
      const next = movedViewIds(allTabs());
      if (!sameIds(next, views.inDock.peek())) views.inDock.value = next;
      return undefined;
    }),
  );

  views.dockHost = {
    reveal: (id, focus) => {
      const tab = tabOfMovedView(allTabs(), id);
      if (!tab) return false;
      const group = dock.findTab(tab.id)?.group;
      if (group?.hidden) dock.setGroupsHidden([group.id], false);
      dock.activateTab(tab.id, focus);
      return true;
    },
  };
  store.add(
    toDisposable(() => {
      views.dockHost = null;
    }),
  );

  /** The view's header buttons as the tab's toolbar, then "Move back to the sidebar". */
  const tabActions = (state: Json): TabAction[] => {
    const id = movedViewId(state);
    const view = id ? views.get(id) : undefined;
    return [
      ...(view?.actions ?? []).map((a) => ({
        icon: a.icon,
        title: a.title,
        command: a.command,
        // A ▾ menu stays one in the dock (it gets the button's place to open at).
        ...(a.dropdown && { dropdown: true }),
      })),
      ...(id
        ? [
            {
              icon: "panel-left" as const,
              title: "Move back to the sidebar",
              command: "view.moveView",
              input: { id, to: "sidebar" },
            },
          ]
        : []),
    ];
  };

  store.add(
    dock.views.register({
      type: SIDEBAR_VIEW_TYPE,
      title: (state) => {
        const id = movedViewId(state);
        return (id && views.get(id)?.title) || id || "View";
      },
      icon: (state) => {
        const id = movedViewId(state);
        return (id && views.get(id)?.icon) || "panel-left";
      },
      defaultPlacement: "bottom",
      actions: tabActions,
      create: (state) => createDockedView(services, movedViewId(state) ?? ""),
    }),
  );

  // A moved view's tab dropped on the sidebar goes back there (VS Code drags a view back).
  store.add(
    services.tabDropTarget(
      sidebar,
      (tab) => tab.viewType === SIDEBAR_VIEW_TYPE,
      (tabId) => {
        const found = dock.findTab(tabId);
        const id = movedViewId(found?.group.tabs[found.index]?.viewState ?? null);
        if (id) void dispatcher.execute("view.moveView", { id, to: "sidebar" }).catch(() => {});
      },
    ),
  );

  const movable = (): ViewDescriptor[] => views.all.peek().filter((v) => v.movable);

  store.add(
    dispatcher.register({
      id: "view.moveView",
      title: "Move view",
      category: "View",
      description:
        "Moves a movable sidebar view (movable: true in ide://views/moved, e.g. scm.graph, Source control's Graph) between the sidebar and a dock tab, as dragging its header does. `to` picks the place (default: the other one); `placement` is where in the dock (default the bottom region; a region hint or an exact target as layout.openView). Closing the tab also returns it to the sidebar. Persisted with the dock, per workspace. Without `id` (palette), asks which view.",
      input: s.object({
        id: s.string().describe("Sidebar view id, e.g. scm.graph").optional(),
        to: s.enum(["sidebar", "dock"] as const).optional(),
        placement: placementSchema.optional(),
      }),
      effects: [],
      run: async ({ id, to, placement }, ctx) => {
        let viewId = id;
        if (!viewId) {
          if (ctx.caller.kind !== "user") throw new Error("`id` is required.");
          const inDock = views.inDock.peek();
          const picked = await quickInput.pick(
            movable().map((v) => ({
              id: v.id,
              label: v.title,
              icon: v.icon,
              description: inDock.has(v.id) ? "In the dock → sidebar" : "In the sidebar → dock",
            })),
            { placeholder: "Move which view?" },
          );
          if (!picked) return null;
          viewId = picked.id;
        }
        const view = views.get(viewId);
        if (!view) throw new Error(`Unknown view "${viewId}"`);
        if (!view.movable) throw new Error(`"${viewId}" can't move out of the sidebar.`);
        const inDock = views.inDock.peek().has(viewId);
        const dest = moveDestination(inDock, to);
        const tab = tabOfMovedView(allTabs(), viewId);
        if (dest === "sidebar") {
          if (tab) await dock.closeTab(tab.id, true);
          // Back where it was: its section expanded, or its own view.
          const shown = await dispatcher.execute("view.show", { id: viewId }).then(
            () => true,
            () => false,
          );
          return { id: viewId, location: "sidebar", shown };
        }
        if (tab) {
          // Already in the dock: move the tab, or just reveal it.
          if (placement && typeof placement !== "string")
            dock.moveTab(tab.id, placement as Parameters<typeof dock.moveTab>[1]);
          else dock.activateTab(tab.id, true);
          return { id: viewId, location: "dock", tabId: tab.id };
        }
        let tabId = "";
        batch(() => {
          tabId = dock.openView(
            SIDEBAR_VIEW_TYPE,
            { id: viewId },
            (placement as OpenPlacement | undefined) ?? "bottom",
            true,
          );
          // A view that had the sidebar to itself hands it to the next one.
          if (views.active.peek() === viewId) {
            const next = views.all.peek().find((v) => v.id !== viewId && !v.sectionOnly);
            views.active.value = next?.id ?? null;
          }
        });
        return { id: viewId, location: "dock", tabId };
      },
    }),
  );

  store.add(
    services.state.register("ide://views/moved", {
      description:
        "Sidebar views that can move into the dock (view.moveView) and the ones in a dock tab now (view id, tab id, group id).",
      get: () => {
        const tabs = allTabs();
        return {
          movable: movable().map((v) => v.id),
          inDock: tabs.flatMap((t) => {
            const id = movedViewId(t.viewState);
            return id ? [{ id, tabId: t.id, groupId: dock.findTab(t.id)?.group.id ?? null }] : [];
          }),
        };
      },
    }),
  );
  return store;
}

/**
 * A dock tab hosting sidebar view `id`. The view may register after the tab is restored (its
 * extension activates later) or go away (a folder without git): the tab waits and says so.
 */
function createDockedView(services: WorkbenchServices, id: string): DockView {
  const { views } = services;
  const store = new DisposableStore();
  const element = h("div", { class: "sidebar-view-tab", "data-view": id });
  const body = h("div", { class: "view-main" });
  const empty = h(
    "div",
    { class: "empty-state" },
    h("p", { class: "empty-state-text" }, "This view isn't available in this folder."),
  );
  element.append(body, empty);
  const instance = store.add(new DisposableStore());
  let live: { descriptor: ViewDescriptor; view: ViewInstance } | null = null;
  store.add(
    effect(() => {
      const descriptor = views.all.value.find((v) => v.id === id);
      if (descriptor && live?.descriptor !== descriptor) {
        instance.clear();
        body.replaceChildren();
        const view = descriptor.create(body);
        live = { descriptor, view };
        instance.add(view);
        instance.add(views.setFocusHandler(id, () => view.focus?.()));
      } else if (!descriptor && live) {
        instance.clear();
        body.replaceChildren();
        live = null;
      }
      empty.hidden = !!live;
      body.hidden = !live;
      return undefined;
    }),
  );
  return {
    element,
    focus: () => live?.view.focus?.(),
    serialize: () => ({ id }),
    dispose: () => {
      store.dispose();
      element.remove();
    },
  };
}

// Tabs in windows of their own (D101): `layout.moveToNewWindow` moves a tab's live view into an
// auxiliary window (the tab stays in its group as a placeholder), `layout.returnFromWindow`
// brings it back, closing the window brings it back too, closing the tab closes the window.
// The view keeps running in the main window's code, so commands, agents and DevTools work as
// before.
import type { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { AuxWindow } from "../../workbench/auxWindow";
import { scrollMemory } from "../../workbench/scrollMemory";
import type { WorkbenchServices } from "../../workbench/services";

export function registerAuxCommands(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, dock, auxWindows } = services;
  const windows = new Map<string, AuxWindow>();
  const register: typeof dispatcher.register = (command) =>
    sub.add(dispatcher.register({ category: "View", ...command }));

  const setDetached = (tabId: string, on: boolean) => {
    const next = new Set(dock.detached.peek());
    if (on) next.add(tabId);
    else next.delete(tabId);
    dock.detached.value = next;
  };

  /** Moves the view back into its group and closes the window. */
  const bringBack = (tabId: string, focus: boolean) => {
    const aux = windows.get(tabId);
    if (!aux) return false;
    windows.delete(tabId);
    const found = dock.findTab(tabId);
    const tab = found?.group.tabs[found.index];
    const view = tab ? dock.liveView(tab.id) : undefined;
    // Take the element out first, so it survives the window's teardown.
    if (view) document.adoptNode(view.element);
    setDetached(tabId, false); // the group re-renders and appends the view again
    view?.onWindowChanged?.(window);
    aux.dispose();
    if (tab && focus) dock.activateTab(tab.id, true);
    return true;
  };

  register({
    id: "layout.moveToNewWindow",
    title: "Move tab into new window",
    description:
      "Shows a tab (default: the active one) in a window of its own — e.g. the browser with its toolbar and DevTools. The tab keeps its place as a placeholder; commands and agents reach it as before. Browser tabs can move (more view types later).",
    input: s.object({
      tabId: s.string().describe("Tab id (ide://layout)").optional(),
      width: s.integer({ min: 320 }).optional(),
      height: s.integer({ min: 240 }).optional(),
    }),
    effects: [],
    run: async ({ tabId, width, height }) => {
      const found = tabId ? dock.findTab(tabId) : undefined;
      const tab = tabId ? found?.group.tabs[found.index] : dock.activeTab();
      if (!tab) throw new Error(tabId ? `No tab ${tabId}.` : "No tab is active.");
      if (windows.has(tab.id)) {
        windows.get(tab.id)?.focus();
        return { tabId: tab.id, window: windows.get(tab.id)?.label ?? null };
      }
      if (!dock.descriptor(tab)?.detachable)
        throw new Error(`A ${tab.viewType} tab can't move into its own window yet.`);
      const view = dock.view(tab);
      if (!view) throw new Error("The tab has no view.");
      const rect = view.element.getBoundingClientRect();
      const aux = await auxWindows.create({
        title: dock.title(tab),
        width: width ?? Math.max(800, Math.round(rect.width)),
        height: height ?? Math.max(600, Math.round(rect.height)),
      });
      windows.set(tab.id, aux);
      setDetached(tab.id, true);
      aux.host.append(aux.window.document.adoptNode(view.element));
      view.element.hidden = false;
      view.onWindowChanged?.(aux.window);
      view.onShow?.();
      requestAnimationFrame(() => {
        view.onResize?.();
        // Adopting the element dropped its scroll offsets (D190).
        scrollMemory.restore(view.element);
      });
      aux.window.addEventListener("resize", () => view.onResize?.());
      sub.add(aux.onDidClose(() => bringBack(tab.id, false)));
      aux.focus();
      return { tabId: tab.id, window: aux.label };
    },
  });
  register({
    id: "layout.returnFromWindow",
    title: "Move tab back into the main window",
    description: "Brings a tab shown in its own window back into its group and closes the window.",
    input: s.object({ tabId: s.string().optional() }),
    effects: [],
    run: ({ tabId }) => {
      const id = tabId ?? [...windows.keys()].pop();
      if (!id || !bringBack(id, true)) throw new Error("No tab is in a window of its own.");
      return { tabId: id };
    },
  });
  register({
    id: "layout.returnAllWindows",
    title: "Move all tabs back into the main window",
    description:
      "Brings every tab shown in a window of its own back into its group and closes those windows (e.g. one the agent opened that you can't find).",
    input: s.empty(),
    effects: [],
    run: () => {
      const ids = [...windows.keys()];
      for (const id of ids) bringBack(id, false);
      return { returned: ids.length };
    },
  });
  register({
    id: "layout.focusWindow",
    title: "Show the tab's window",
    description: "Brings the window a tab was moved into to the front.",
    input: s.object({ tabId: s.string().optional() }),
    effects: [],
    palette: false,
    run: ({ tabId }) => {
      const aux = tabId ? windows.get(tabId) : [...windows.values()].pop();
      if (!aux) throw new Error("No tab is in a window of its own.");
      aux.focus();
      return { focused: true };
    },
  });

  // Keep the window's title in step with the tab, and close it when its tab closes.
  sub.add(
    effect(() => {
      dock.root.value;
      dock.decorations.value;
      for (const [id, aux] of Array.from(windows)) {
        const found = dock.findTab(id);
        const tab = found?.group.tabs[found.index];
        if (!tab) {
          windows.delete(id);
          setDetached(id, false);
          aux.dispose();
        } else aux.setTitle(dock.title(tab));
      }
      return undefined;
    }),
  );
  sub.add({
    dispose: () => {
      for (const id of Array.from(windows.keys())) bringBack(id, false);
    },
  });
}

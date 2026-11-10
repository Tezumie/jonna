// Go back / Go forward (VS Code's workbench.action.navigateBack / navigateForward, D279): the
// places the cursor was across files (core/navigation), recorded from the editors' cursor moves
// and activations, stepped through with Alt+← / Alt+→, the mouse's back / forward buttons, the
// Go menu and the ← → buttons (in the title bar, or at the start of each tab strip:
// workbench.navigationControl.*). Context keys `canNavigateBack`, `canNavigateForward` and
// `navigationControlLocation`; state `ide://navigation`.

import { on } from "../../core/dom/index";
import type { DisposableStore } from "../../core/lifecycle/index";
import { NavigationHistory, type NavLocation } from "../../core/navigation/history";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";

/** Where the ← → buttons are: VS Code's place by default, or each tab strip's start. */
export type NavigationControlLocation = "titleBar" | "tabBar";

/** How long a step waits to see its editor report the place it opened (then moves count again). */
const ARRIVAL_MS = 1000;

export interface Navigation {
  /** An editor showing `path` became active or moved its cursor (1-based line and column). */
  record(path: string, line: number, column: number): void;
}

export function registerNavigation(sub: DisposableStore, services: WorkbenchServices): Navigation {
  const { dispatcher, context, settings, state, workspace } = services;
  const history = new NavigationHistory();
  let arrival: ReturnType<typeof setTimeout> | undefined;
  sub.add({ dispose: () => clearTimeout(arrival) });

  const publish = () => {
    context.setMany({
      canNavigateBack: history.canGoBack,
      canNavigateForward: history.canGoForward,
    });
  };
  publish();

  const go = async (direction: "back" | "forward"): Promise<NavLocation | null> => {
    // A place that can't be opened any more (the file was deleted) is dropped and the step tries
    // the next one.
    for (;;) {
      const target = direction === "back" ? history.back() : history.forward();
      publish();
      if (!target) return null;
      clearTimeout(arrival);
      arrival = setTimeout(() => history.landed(), ARRIVAL_MS);
      try {
        await dispatcher.execute("editor.openFile", {
          path: target.path,
          line: target.line,
          column: target.column,
        });
        return target;
      } catch {
        history.remove(target.path);
        publish();
      }
    }
  };

  const result = (target: NavLocation | null) => ({
    moved: target !== null,
    ...(target && { path: workspace.relative(target.path), line: target.line }),
    canGoBack: history.canGoBack,
    canGoForward: history.canGoForward,
  });

  sub.add(
    dispatcher.register({
      id: "workbench.navigateBack",
      title: "Go back",
      category: "Go",
      description:
        "Goes back to the previous place the cursor was (another file, or far away in the same one), like a browser's back button (VS Code's Go back, Alt+Left).",
      input: s.empty(),
      effects: [],
      run: async () => result(await go("back")),
    }),
  );
  sub.add(
    dispatcher.register({
      id: "workbench.navigateForward",
      title: "Go forward",
      category: "Go",
      description:
        "Goes forward again after workbench.navigateBack (VS Code's Go forward, Alt+Right).",
      input: s.empty(),
      effects: [],
      run: async () => result(await go("forward")),
    }),
  );
  sub.add(
    dispatcher.register({
      id: "workbench.clearNavigationHistory",
      title: "Clear editor history",
      category: "Go",
      description: "Forgets the places Go back and Go forward step through.",
      input: s.empty(),
      effects: [],
      run: () => {
        history.clear();
        publish();
      },
    }),
  );

  // The mouse's back and forward buttons (VS Code's): no page history to step through here.
  sub.add(
    on(window, "mouseup", (e) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      void dispatcher
        .execute(e.button === 3 ? "workbench.navigateBack" : "workbench.navigateForward", {})
        .catch(() => {});
    }),
  );
  sub.add(
    on(window, "mousedown", (e) => {
      if (e.button === 3 || e.button === 4) e.preventDefault();
    }),
  );

  // Where the buttons are, for the title bar and the tab strips.
  sub.add(
    effect(() => {
      const enabled = settings.get<boolean>("workbench.navigationControl.enabled") !== false;
      const location =
        settings.get<NavigationControlLocation>("workbench.navigationControl.location") === "tabBar"
          ? "tabBar"
          : "titleBar";
      context.set("navigationControlLocation", enabled ? location : "hidden");
      return undefined;
    }),
  );
  // Another folder: its places don't apply.
  sub.add(
    workspace.onDidClose(() => {
      history.clear();
      publish();
    }),
  );

  sub.add(
    state.register("ide://navigation", {
      description:
        "The editor history Go back / Go forward step through: places (path, 1-based line and column) and the current index.",
      get: () => {
        const { entries, index } = history.snapshot();
        return {
          index,
          entries: entries.map((e) => ({ ...e, path: workspace.relative(e.path) })),
          canGoBack: history.canGoBack,
          canGoForward: history.canGoForward,
        };
      },
    }),
  );

  return {
    record: (path, line, column) => {
      if (path.startsWith("virtual:")) return;
      const before = `${history.canGoBack}${history.canGoForward}`;
      history.record({ path, line, column });
      if (`${history.canGoBack}${history.canGoForward}` !== before) publish();
    },
  };
}

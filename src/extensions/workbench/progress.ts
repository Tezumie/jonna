// The progress line for commands that take a while (D118), like VS Code's: file operations show
// it on the explorer, extension installs on the Extensions view, searches on Search — at the top
// of the view, or as a moving mark on its activity-bar icon when another view is shown.
// Git shows its own (from git.busy, on the Source control view).
import type { Disposable, DisposableStore } from "../../core/lifecycle/index";
import type { WorkbenchServices } from "../../workbench/services";

/** Command id → the view whose progress line it drives. */
const COMMAND_VIEWS: [RegExp, string][] = [
  [/^explorer\.(paste|move|duplicate|delete|importDropped|refresh)$/, "explorer.view"],
  [/^workspace\.(closeFolder|undo|redo)$/, "explorer.view"],
  [
    /^extensions\.(installFromFolder|loadUnpacked|uninstall|remove|loadFromWorkspace|reload|enable|disable|create)$/,
    "extensions.view",
  ],
  [/^search\.(run|replaceAll)$/, "search.view"],
];

export function viewForCommand(id: string): string | undefined {
  return COMMAND_VIEWS.find(([re]) => re.test(id))?.[1];
}

export function registerCommandProgress(sub: DisposableStore, services: WorkbenchServices): void {
  const running = new Map<number, Disposable>();
  sub.add(
    services.events.on("command.started", ({ id, execution }) => {
      const view = viewForCommand(id);
      if (view) running.set(execution, services.views.progress(view, id));
    }),
  );
  sub.add(
    services.events.on("command.executed", ({ execution }) => {
      running.get(execution)?.dispose();
      running.delete(execution);
    }),
  );
  sub.add({
    dispose: () => {
      for (const d of running.values()) d.dispose();
    },
  });
}

// Starting with extensions off (D204, VS Code's --disable-extensions): "Restart with extensions
// off" sets a one-shot flag the next start reads (src-tauri/src/diagnostics) and restarts; the
// command-line flag does the same for one start. While off, no installed or bundled extension
// runs (the extension manager checks), the status bar says so, and "Restart normally" goes back.
import { type SessionInfo, sessionIpc } from "../../core/ipc/diagnostics";
import type { DisposableStore } from "../../core/lifecycle/index";
import { signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";

export function registerSafeMode(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, notifications, statusBar, state } = services;
  const info = signal<SessionInfo | null>(null);
  const refresh = async () => {
    info.value = await sessionIpc.info().catch(() => null);
    return info.peek();
  };
  let disposed = false;
  sub.add({ dispose: () => (disposed = true) });

  const restart = async (extensionsOff: boolean | null): Promise<{ restarting: boolean }> => {
    // Unsaved changes: the same question as closing the window.
    if (!(await services.workspace.confirmClose("window"))) return { restarting: false };
    await services.persistence.flush();
    const restarting = await sessionIpc.relaunch(extensionsOff, true);
    await refresh();
    if (!restarting)
      notifications.show(
        "info",
        extensionsOff === true
          ? "The next start runs with extensions off."
          : "The next start runs with extensions on.",
      );
    return { restarting };
  };

  sub.add(
    dispatcher.register({
      id: "help.restartWithExtensionsOff",
      title: "Restart with extensions off",
      category: "Help",
      description:
        "Restarts the IDE for one session without running any installed or bundled extension (VS Code's --disable-extensions), to tell whether an extension causes a problem. Unsaved files are asked about first.",
      input: s.empty(),
      effects: ["write"],
      agent: "hidden",
      run: () => restart(true),
    }),
  );
  sub.add(
    dispatcher.register({
      id: "help.restartNormally",
      title: "Restart with extensions on",
      category: "Help",
      description:
        "Restarts the IDE with extensions running again, after a start with extensions off. Unsaved files are asked about first.",
      input: s.empty(),
      effects: ["write"],
      agent: "hidden",
      // A session started with --disable-extensions repeats its arguments on restart: the flag
      // "on" overrides them once.
      run: async () => restart(info.peek()?.extensionsOff === "commandLine" ? false : null),
    }),
  );
  sub.add(
    dispatcher.register({
      id: "help.clearNextStart",
      title: "Clear the next start's extensions setting",
      category: "Help",
      description:
        "Undoes a pending 'next start with extensions off/on' without restarting (the next start is a normal one).",
      input: s.empty(),
      effects: ["write"],
      palette: false,
      run: async () => {
        await sessionIpc.relaunch(null, false);
        return { nextStart: (await refresh())?.nextStart ?? null };
      },
    }),
  );

  sub.add(
    statusBar.add({
      id: "help.extensionsOff",
      name: "Extensions off",
      alignment: "left",
      priority: 90,
      text: () => (info.value?.extensionsOff ? "$(blocks) Extensions off" : ""),
      tooltip: () => "This session runs without extensions. Click to restart with them on.",
      command: "help.restartNormally",
    }),
  );
  sub.add(
    state.register("ide://safeMode", {
      description:
        "Whether this session runs with extensions off (and why: commandLine = --disable-extensions, restart = Restart with extensions off), and whether the next start is set to differ (nextStart: off / on).",
      get: async () => {
        const now = await refresh();
        return {
          extensionsOff: !!now?.extensionsOff,
          reason: now?.extensionsOff ?? null,
          nextStart: now?.nextStart ?? null,
        };
      },
    }),
  );

  void refresh().then((now) => {
    if (disposed || !now?.extensionsOff) return;
    notifications.show(
      "warning",
      "Extensions are off for this session: installed and bundled extensions don't run.",
      {
        title: "Extensions off",
        actions: [
          {
            label: "Restart normally",
            run: () => void dispatcher.execute("help.restartNormally").catch(() => {}),
          },
        ],
      },
    );
  });
}

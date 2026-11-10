// Task terminals (D134): `services.taskTerminals.run` starts a task's process in a terminal tab
// the way VS Code does — the process itself, not typed into a shell; " *  Executing task" above
// its output and the exit code below; "press any key to close". Terminals are reused as
// tasks.json's `presentation.panel` says: "shared" (a finished task's terminal, this task's
// first), "dedicated" (this task's own) or "new". The tasks extension reads the output for
// problem matchers.
import { Emitter } from "../../core/events/index";
import { ptyIpc, type RunSpec } from "../../core/ipc/process";
import type { Disposable, DisposableStore } from "../../core/lifecycle/index";
import { parseWslPath } from "../../core/paths/wsl";
import { effect } from "../../core/reactive/index";
import type { OpenPlacement } from "../../workbench/dock/service";
import type { TaskExecution, WorkbenchServices } from "../../workbench/services";
import type { TerminalProfiles } from "./profileCommands";
import {
  type AutomationShell,
  parseAutomationProfile,
  profilePlatform,
  profileTaskShell,
} from "./profiles";
import type { TerminalInstance, TerminalService } from "./service";
import type { TerminalPane, TerminalView } from "./view";

export function registerTaskTerminals(
  sub: DisposableStore,
  services: WorkbenchServices,
  terminals: TerminalService,
  views: Map<string, TerminalPane>,
  tabs: Map<string, TerminalView>,
  profiles: Pick<TerminalProfiles, "defaultProfile" | "peekDefaultProfile">,
): void {
  const { dock, workspace } = services;
  const finished = (v: TerminalPane) => !!v.instance && v.instance.exitCode.peek() !== null;
  /** A task's pane alone in its tab (one split beside a shell isn't reused: that would close the shell). */
  // A hidden one (D217, no tab) isn't reused either: its tab can't be replaced.
  const alone = (v: TerminalPane) => tabs.get(v.tabId)?.panes.length === 1;

  const reveal = (tabId: string, focus: boolean) => {
    const group = dock.findTab(tabId)?.group;
    if (group?.hidden) dock.setGroupsHidden([group.id], false);
    dock.activateTab(tabId, focus);
  };

  // The automation profile (D209, VS Code's terminal.integrated.automationProfile.<platform>):
  // the shell a shell task (or a debug launch's command) runs in when it names none. Without
  // one, the default terminal profile's shell, arguments and env (VS Code's rule); without that
  // either, the IDE's own default shell. A WSL folder's tasks run in Linux: the linux automation
  // profile there, else bash (Rust), never a Windows profile.
  const platform = profilePlatform(services.platform);
  const automationFor = (folder: string | undefined) => {
    const wsl = services.platform === "windows" && !!folder && !!parseWslPath(folder);
    const shell = parseAutomationProfile(
      services.settings.peek<unknown>(`terminal.automationProfile.${wsl ? "linux" : platform}`),
    );
    return { wsl, shell };
  };
  const taskShell = async (folder: string | undefined): Promise<AutomationShell | null> => {
    const { wsl, shell } = automationFor(folder);
    if (shell || wsl) return shell;
    return profileTaskShell(await profiles.defaultProfile().catch(() => null));
  };

  /** Resolves with the exit code (-1: its tab closed while it ran). */
  const exitedOf = (t: TerminalInstance) =>
    new Promise<number>((resolve) => {
      t.store.add({ dispose: () => resolve(t.exitCode.peek() ?? -1) });
      t.store.add(
        effect(() => {
          const code = t.exitCode.value;
          if (code !== null) resolve(code);
          return undefined;
        }),
      );
    });

  // A task's terminal taken back after a window reload (m7.12): its process kept running, so the
  // tasks extension links it to the task again. The output from now on (what came before the
  // reload is on the screen, not replayed to matchers); kept for a listener that comes later.
  const reattached = new Emitter<{ label: string; execution: TaskExecution }>();
  const taken: { label: string; execution: TaskExecution }[] = [];
  sub.add(reattached);
  const adopt = (pane: TerminalPane, label: string, t: TerminalInstance) => {
    let history = "";
    const output = new Emitter<string>();
    t.store.add(output);
    t.store.add(
      terminals.onDidWrite(({ id, text }) => {
        if (id !== t.id) return;
        history = (history + text).slice(-500_000);
        output.fire(text);
      }),
    );
    const execution: TaskExecution = {
      terminalId: t.id,
      tabId: pane.tabId,
      onOutput: (listener) => {
        if (history) listener(history);
        return output.event(listener);
      },
      exited: exitedOf(t),
      kill: () => {
        if (t.exitCode.peek() === null) void ptyIpc.kill(t.id).catch(() => {});
      },
      reveal: (focus: boolean) => reveal(pane.tabId, focus),
    };
    const entry = { label, execution };
    taken.push(entry);
    void execution.exited.then(() => {
      const at = taken.indexOf(entry);
      if (at >= 0) taken.splice(at, 1);
    });
    reattached.fire(entry);
  };
  sub.add(
    terminals.onDidCreate((t) => {
      if (!t.reattached) return;
      // The pane learns its instance when create resolves (after this event): match it then.
      for (const pane of views.values()) {
        const label = pane.restoredTask;
        if (!label || pane.instance) continue;
        void pane.ready.then(
          (instance) => {
            if (instance === t) adopt(pane, label, t);
          },
          () => {},
        );
      }
    }),
  );
  const onDidReattach = (
    listener: (e: { label: string; execution: TaskExecution }) => void,
  ): Disposable => {
    for (const e of [...taken]) listener(e);
    return reattached.event(listener);
  };

  Object.assign(services.taskTerminals, {
    onDidReattach,
    automationShell: (folder?: string) => {
      const { wsl, shell } = automationFor(folder ?? workspace.root.peek() ?? undefined);
      if (shell || wsl) return shell?.executable ?? (wsl ? "bash" : null);
      return profileTaskShell(profiles.peekDefaultProfile())?.executable ?? null;
    },
    run: async ({ label, spec: given, cwd, presentation }): Promise<TaskExecution> => {
      const root = workspace.root.peek();
      // Tasks pass their own folder's cwd (D251); a relative one (an extension's task) is the
      // workspace's.
      const dir = cwd && root ? workspace.resolve(cwd) : (cwd ?? root ?? undefined);
      const shell = given.kind === "shell" && !given.shell ? await taskShell(dir) : null;
      const spec: RunSpec = shell
        ? {
            ...given,
            shell: { executable: shell.executable, args: shell.args },
            ...((given.env || Object.keys(shell.env).length) && {
              env: { ...shell.env, ...given.env },
            }),
          }
        : given;
      const entries = [...views.values()].filter((v) => v.task !== null && alone(v));
      const own = entries.find((v) => v.task === label && finished(v))?.tabId;
      const reuse =
        presentation.panel === "new"
          ? undefined
          : presentation.panel === "dedicated"
            ? own
            : (own ?? entries.find((v) => finished(v))?.tabId);
      const at = reuse ? dock.findTab(reuse) : undefined;
      const near = dock.recentTab((t) => t.viewType === "terminal");
      const nearGroup = near ? dock.findTab(near.id)?.group : undefined;
      const placement: OpenPlacement = at
        ? { groupId: at.group.id, index: at.index + 1 }
        : nearGroup && !nearGroup.hidden
          ? { groupId: nearGroup.id }
          : "bottom";
      // Output from the moment the process starts: a quick task can print (and end) before its
      // terminal is ready, and whoever listens later gets what came so far first.
      let terminalId = -1;
      const early: { id: number; text: string }[] = [];
      let history = "";
      const output = new Emitter<string>();
      const deliver = (text: string) => {
        history += text;
        if (history.length > 1_000_000) history = history.slice(-500_000);
        output.fire(text);
      };
      const tap = terminals.onDidWrite(({ id, text }) => {
        if (terminalId === -1) early.push({ id, text });
        else if (id === terminalId) deliver(text);
      });
      const tabId = dock.openView(
        "terminal",
        { ...(dir && { cwd: dir }), name: label, task: label, run: { ...spec } },
        placement,
        presentation.focus,
      );
      if (reuse) void dock.closeTab(reuse, true);
      const ref = dock.findTab(tabId);
      const tab = ref?.group.tabs[ref.index];
      const view = tab ? (dock.view(tab) as TerminalView | undefined) : undefined;
      if (!view) {
        tap.dispose();
        throw new Error("Terminal view unavailable");
      }
      const t = await view.ready.catch((err: unknown) => {
        tap.dispose();
        throw err;
      });
      terminalId = t.id;
      for (const e of early.splice(0)) if (e.id === t.id) deliver(e.text);
      if (presentation.reveal === "always" || presentation.focus) reveal(tabId, presentation.focus);

      t.store.add(output);
      t.store.add(tap);
      // A tab closed while the task runs ends it.
      const exited = exitedOf(t);
      // Its own pane only, when the user split a shell beside it (D209).
      if (presentation.close)
        void exited.then(() => {
          const group = tabs.get(tabId);
          const pane = group?.panes.find((p) => p.instance?.id === t.id);
          if (group && pane && group.panes.length > 1) group.removePane(pane);
          else void dock.closeTab(tabId, true).catch(() => {});
        });
      return {
        terminalId: t.id,
        tabId,
        onOutput: (listener) => {
          if (history) listener(history);
          return output.event(listener);
        },
        exited,
        kill: () => {
          if (t.exitCode.peek() === null) void ptyIpc.kill(t.id).catch(() => {});
        },
        reveal: (focus: boolean) => reveal(tabId, focus),
      };
    },
  } satisfies WorkbenchServices["taskTerminals"]);
  sub.add({
    dispose: () => {
      for (const v of views.values())
        if (v.task && !finished(v) && alone(v)) void dock.closeTab(v.tabId, true);
    },
  });
}

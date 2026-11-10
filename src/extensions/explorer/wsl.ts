// "Open WSL folder…" and the status bar's "WSL: Ubuntu" (D192, Windows): pick a distribution and a
// folder in it; the IDE opens it through Windows' path to it, and terminals, tasks, the agent's
// commands and git run inside the distribution (src-tauri/src/wsl.rs).
import { dialogIpc, wslIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { parseWslPath } from "../../core/paths/wsl";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";

export function registerWslCommands(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, quickInput, statusBar, workspace, notifications } = services;
  const windows = services.platform === "windows";
  // Registered everywhere (the extension's manifest lists it), usable on Windows only.
  sub.add(
    dispatcher.register({
      id: "workspace.openWslFolder",
      when: "isWindows",
      title: "Open WSL folder…",
      category: "File",
      description:
        "Opens a folder inside a WSL distribution (Windows): terminals, tasks, the agent's commands and git then run in Linux. `distro` and `path` (a Linux path) skip the pickers.",
      input: s.object({
        distro: s.string().optional(),
        path: s.string().describe("A Linux path, e.g. /home/me/project").optional(),
      }),
      effects: ["read"],
      agent: "hidden",
      run: async ({ distro, path }) => {
        if (!windows) throw new Error("WSL folders open on Windows only.");
        let name = distro;
        if (!name) {
          const list = await wslIpc.distros();
          if (!list.length) {
            notifications.show(
              "info",
              "No WSL distribution is installed. Install one with `wsl --install` in PowerShell, then try again.",
            );
            return { opened: null };
          }
          const picked =
            list.length === 1
              ? list[0]
              : await quickInput
                  .pick(
                    list.map((d) => ({ id: d.name, label: d.name })),
                    { placeholder: "Open a folder in which WSL distribution?" },
                  )
                  .then((p) => (p ? { name: p.id } : undefined));
          name = picked?.name;
        }
        if (!name) return { opened: null };
        let target: string | null;
        if (path)
          target = `\\\\wsl.localhost\\${name}\\${path.replace(/^\/+/, "").replaceAll("/", "\\")}`;
        else {
          const home = await wslIpc.home(name);
          target = await dialogIpc.pickFolder(`Open a folder in ${name}`, home);
        }
        if (!target) return { opened: null };
        if (!parseWslPath(target)) {
          notifications.show("warning", "That folder isn't inside WSL: opening it as usual.");
        }
        return { opened: await workspace.open(target) };
      },
    }),
  );

  // Where the folder is: "WSL: Ubuntu" at the left of the status bar, like VS Code's remote
  // indicator; clicking it opens another WSL folder.
  sub.add(
    statusBar.add({
      id: "workspace.wsl",
      name: "WSL",
      alignment: "left",
      priority: 100,
      text: () => {
        const root = workspace.root.value;
        const at = root ? parseWslPath(root) : null;
        return at ? `$(terminal) WSL: ${at.distro}` : "";
      },
      tooltip: () =>
        "This folder is in WSL: terminals, tasks and git run in Linux. Click to open another WSL folder.",
      command: "workspace.openWslFolder",
    }),
  );
}

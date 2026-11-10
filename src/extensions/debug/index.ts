// Run and debug (D143): VS Code's debugger workflow — F5 starts the selected launch.json
// configuration (or runs the active file), F9 or a click in the editor's margin toggles a
// breakpoint, F10 / F11 / Shift+F11 step, Shift+F5 stops — with the "Run and debug" sidebar
// (view.ts), the debug console (console.ts), `ide://debug` and commands for agents. Sessions:
// controller.ts; debuggers: cdp.ts (Node) and session.ts (DAP adapters).
// Split by responsibility: configurations.ts (launch.json, the picker), runCommands.ts (start,
// step, stop, restart), inspectCommands.ts (watches, variables, evaluate), debugState.ts
// (ide://debug); this file wires them with the view, the status bar and persistence.
import type { BuiltinExtension } from "../../core/extensions/index";
import { fsIpc } from "../../core/ipc/fs";
import { joinPath } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { ensureWorkspaceFolder } from "../../workbench/workspaceFolder";
import { chooseFolder } from "../tasks/chooseFolder";
import { registerBreakpointCommands } from "./breakpointCommands";
import { refLabel } from "./compounds";
import { debugConfigurations } from "./configurations";
import { debugConsoleDescriptor } from "./console";
import { registerConsolePicker } from "./consolePicker";
import { DebugController } from "./controller";
import { registerDebugState } from "./debugState";
import { disassemblyDescriptor } from "./disassembly";
import manifest from "./extension.json";
import { registerDebugExtensionEvents } from "./extensionEvents";
import { registerInlineValues } from "./inlineValuesView";
import { registerInspectCommands } from "./inspectCommands";
import { LAUNCH_TEMPLATE, type LaunchConfig } from "./launch";
import { registerRunCommands } from "./runCommands";
import { registerSessionCommands } from "./sessionCommands";
import { registerFloatingToolbar } from "./toolbar";
import { DebugView } from "./view";
import { Watches } from "./watches";

export const debugExtension: BuiltinExtension<WorkbenchServices> = {
  manifest,
  activate({ subscriptions: sub, services }) {
    const { dispatcher, views, dock, workspace, context, persistence } = services;
    const debug = new DebugController(services, sub);
    const watches = new Watches(debug, sub);
    const register: typeof dispatcher.register = (c) =>
      sub.add(dispatcher.register({ category: "Debug", ...c }));
    const configs = debugConfigurations(services);
    const { root, rel, abs, activeEditor, launchFiles, configurations, choices } = configs;

    let view: DebugView | undefined;
    sub.add(
      views.register({
        id: "debug.view",
        title: "Run and debug",
        icon: "bug-play",
        command: "debug.showView",
        // launch.json's gear sits beside the configuration list (one place, as in VS Code).
        actions: [
          { command: "debug.showConsole", icon: "square-terminal", title: "Debug console" },
        ],
        create(host) {
          view = new DebugView(host, services, debug, choices, watches);
          return view;
        },
      }),
    );
    sub.add(dock.views.register(debugConsoleDescriptor(services, debug)));
    sub.add(dock.views.register(disassemblyDescriptor(services, debug)));
    registerFloatingToolbar(
      sub,
      services,
      debug,
      (command) =>
        void dispatcher.execute(command, {}).catch((err: unknown) => {
          services.notifications.show("error", err instanceof Error ? err.message : String(err));
        }),
    );

    // ---- Context keys, status bar, breakpoints in the editor ----
    sub.add(
      effect(() => {
        const st = debug.state.value;
        // What the focused session's debugger can do (VS Code's context keys of the same names).
        const caps = debug.focused.value?.capabilities.value;
        context.setMany({
          inDebugMode: debug.sessions.value.length > 0,
          debugState: st,
          stepIntoTargetsSupported: caps?.stepInTargets === true,
          restartFrameSupported: caps?.restartFrame === true,
        });
        return undefined;
      }),
    );
    // The editor's menu while paused (VS Code's "debug" group): Step into target where the
    // debugger lists them.
    sub.add(
      services.extensionFeatures.addMenus([
        {
          owner: manifest.id,
          location: "editor/context",
          command: "debug.stepIntoTarget",
          title: "Step into target",
          when: "debugState == 'stopped' && stepIntoTargetsSupported",
        },
      ]),
    );
    const inlineValues = registerInlineValues(sub, services, debug);
    sub.add(
      services.statusBar.add({
        id: "debug.status",
        name: "Debugging",
        alignment: "left",
        priority: 40,
        text: () => {
          const st = debug.state.value;
          const name = debug.focused.value?.name ?? "";
          const more = debug.sessions.value.length - 1;
          const label = more > 0 ? `${name} (+${more})` : name;
          return st === "inactive"
            ? ""
            : st === "stopped"
              ? `$(pause) ${label}`
              : `$(bug-play) ${label}`;
        },
        tooltip: () => (debug.state.value === "stopped" ? "Paused (F5 continues)" : "Debugging"),
        command: "debug.showView",
      }),
    );
    sub.add(
      services.debugMarks.onGutterClick(({ path, line }) => debug.breakpoints.toggle(path, line)),
    );

    // Values on hover while paused (side-effect free; an object shows its first properties).
    sub.add(
      effect(() => {
        const paused = debug.state.value === "stopped";
        services.debugMarks.hover.value = paused
          ? async ({ expression }) => {
              const session = debug.active;
              if (!session || debug.state.peek() !== "stopped") return null;
              try {
                const r = await session.evaluate(expression, debug.frameId(), "hover");
                if (!r.ref) return { value: r.value };
                const vars = await session.variables(r.ref).catch(() => []);
                return {
                  value: r.value,
                  children: vars.slice(0, 20).map((v) => ({ name: v.name, value: v.value })),
                  more: vars.length > 20,
                };
              } catch {
                // Not defined here, or it would have had side effects: no hover.
                return null;
              }
            }
          : null;
        return undefined;
      }),
    );

    // ---- Persistence ----
    sub.add(
      persistence.register("debug", {
        save: () => ({
          ...debug.breakpoints.save(),
          ...debug.other.save(),
          watches: watches.save(),
        }),
        restore: (data) => {
          debug.breakpoints.restore(data);
          debug.other.restore(data);
          watches.restore((data as { watches?: unknown } | null)?.watches);
        },
      }),
    );
    let first = true;
    sub.add(
      effect(() => {
        debug.breakpoints.list.value;
        debug.breakpoints.uncaught.value;
        debug.breakpoints.caught.value;
        debug.other.functions.value;
        debug.other.filterChoices.value;
        debug.other.filters.value;
        watches.expressions.value;
        if (first) first = false;
        else persistence.scheduleSave();
        return undefined;
      }),
    );
    sub.add(
      workspace.onDidClose(() => {
        void debug.stopAll();
        debug.breakpoints.restore(undefined);
        debug.other.restore(undefined);
        watches.restore([]);
      }),
    );

    // ---- Commands ----
    // Start, step, stop, restart (runCommands.ts); the session's own commands (sessionCommands.ts).
    const sessionCommands = registerSessionCommands(sub, services, debug, {
      abs,
      rel,
      root,
      launchFiles,
      reloadView: () => void view?.reload(),
    });
    registerRunCommands(sub, services, debug, { configs, sessionCommands, view: () => view });
    registerDebugExtensionEvents(sub, services, debug);

    // Breakpoints (breakpointCommands.ts).
    const { out: bpOut } = registerBreakpointCommands(sub, services, debug, {
      abs,
      rel,
      activeEditor,
    });
    // Run to cursor, changing values, watches, frames, variables, evaluate (inspectCommands.ts).
    registerInspectCommands(sub, services, debug, watches, configs);

    register({
      id: "debug.listConfigurations",
      title: "List launch configurations",
      description:
        "The launch.json configurations (name, type, request, program), compounds and the active file's default one. In a multi-root workspace every folder's (named 'Launch (folder)', with a `folder` field) and the workspace file's.",
      input: s.empty(),
      effects: ["read"],
      when: "workspaceOpen",
      agent: "discoverable",
      run: async () => {
        const { list, file, compounds } = await configurations();
        const multi = workspace.folders.peek().length > 1;
        const out = (c: LaunchConfig) => ({
          name: c.name,
          ...(c.folderName !== undefined && { folder: c.folderName }),
          type: c.type,
          request: c.request,
          source: c.source,
          ...(c.program ? { program: rel(c.program) } : {}),
        });
        return {
          configurations: list.map(out),
          compounds: compounds.map((c) => ({
            name: c.name,
            configurations: multi && c.refs ? c.refs.map(refLabel) : c.configurations,
            stopAll: c.stopAll,
            ...(c.preLaunchTask ? { preLaunchTask: c.preLaunchTask } : {}),
            ...(c.presentation && { presentation: c.presentation }),
          })),
          activeFile: file ? out(file) : null,
        };
      },
    });
    register({
      id: "debug.openLaunchJson",
      title: "Open launch.json",
      description:
        "Opens the folder's launch.json (the IDE's own folder first, then .vscode), creating one in the IDE's folder with a starter configuration when there is none. In a multi-root workspace `folder` (a folder's name or path) says which; without it, the active editor's folder, else asks.",
      input: s.object({
        folder: s.string().describe("Workspace folder (name or path; multi-root)").optional(),
      }),
      effects: ["write"],
      when: "workspaceOpen",
      run: async ({ folder }, ctx) => {
        const r = await chooseFolder(services, folder, {
          placeholder: "Select the workspace folder to open launch.json of",
        });
        if (!r) return { path: null, created: false };
        const files = launchFiles(r);
        for (const [path] of files)
          if (
            await fsIpc.stat(path).then(
              () => true,
              () => false,
            )
          ) {
            await ctx.execute("editor.openFile", { path });
            return { path: rel(path), created: false };
          }
        // New files go in the IDE's own workspace folder, never a .vscode it would have to create (D189).
        const path = joinPath(await ensureWorkspaceFolder(r), "launch.json");
        await fsIpc.write(path, new TextEncoder().encode(LAUNCH_TEMPLATE), "user");
        await ctx.execute("editor.openFile", { path });
        void view?.reload();
        return { path: rel(path), created: true };
      },
    });
    register({
      id: "debug.showView",
      title: "Show run and debug",
      description: "Shows the Run and debug view.",
      input: s.empty(),
      effects: [],
      agent: "discoverable",
      run: async (_input, ctx) => {
        await ctx.execute("view.show", { id: "debug.view" });
        view?.focus();
      },
    });
    register({
      id: "debug.showConsole",
      title: "Show debug console",
      description: "Opens the debug console tab.",
      input: s.empty(),
      effects: [],
      agent: "discoverable",
      run: () => {
        dock.openView("debugConsole", null, "bottom", true);
      },
    });
    register({
      id: "debug.clearConsole",
      title: "Clear debug console",
      description:
        "Empties the debug console shown (one session's, D209); `all` empties every session's.",
      input: s.object({ all: s.boolean().optional() }),
      effects: [],
      run: ({ all }) => debug.clearConsole(all === true),
    });
    registerConsolePicker(register, services, debug);
    sub.add(registerDebugState(services, debug, watches, { rel, bpOut, inlineValues }));
  },
};

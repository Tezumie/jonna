// Starting and stepping (D143): debug.start / runWithoutDebugging (a configuration, a compound,
// a file or a whole configuration), the step commands, Stop and Restart, the preLaunchTask /
// postDebugTask hooks, and opening the debug console as VS Code's debug.openDebugConsole says.
import { openerIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { editorFolder } from "../tasks/chooseFolder";
import { findCompound, findConfig, resolveCompound } from "./compounds";
import type { DebugConfigurations } from "./configurations";
import type { DebugController, SessionKind } from "./controller";
import type { LaunchConfig } from "./launch";
import type { registerSessionCommands } from "./sessionCommands";
import { COMPOUND_PREFIX, type DebugView } from "./view";

export function registerRunCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  debug: DebugController,
  deps: {
    configs: DebugConfigurations;
    sessionCommands: ReturnType<typeof registerSessionCommands>;
    /** The Run and debug view, once created (its selected configuration). */
    view(): DebugView | undefined;
  },
): void {
  const { dispatcher, dock, settings, trust } = services;
  const { configurations, givenConfig, resolveConfig } = deps.configs;
  const { sessionCommands } = deps;
  const register: typeof dispatcher.register = (c) =>
    sub.add(dispatcher.register({ category: "Debug", ...c }));

  // The console opens as VS Code's does (debug.openDebugConsole).
  let consoleOpened = false;
  sub.add(
    effect(() => {
      const lines = debug.console.value;
      if (!debug.sessions.peek().length || consoleOpened) return undefined;
      const when = settings.peek<string>("debug.openDebugConsole") ?? "openOnFirstOutput";
      if (when === "openOnFirstOutput" && lines.at(-1)?.kind === "output") {
        consoleOpened = true;
        dock.openView("debugConsole", null, "bottom", false);
      }
      return undefined;
    }),
  );

  const startInput = s.object({
    name: s
      .string()
      .describe("A launch.json configuration's name; default: the one selected, or the active file")
      .optional(),
    program: s
      .string()
      .describe(
        "Debug this file instead (a .js/.ts or .py file; uses the defaults for its language)",
      )
      .optional(),
    configuration: s
      .unknown()
      .describe(
        "A whole launch configuration (launch.json's shape: type, request, program, args…) to start instead, e.g. Testing's Debug test",
      )
      .optional(),
    compound: s
      .string()
      .describe(
        "A launch.json compound's name: starts each of its configurations, each its own session",
      )
      .optional(),
    // VS Code's DebugSessionOptions (extensions' startDebugging, D295).
    parentSession: s
      .string()
      .describe("A running session's id to start under (its child; it ends with it)")
      .optional(),
    lifecycleManagedByParent: s
      .boolean()
      .describe("Restarted and stopped with its parent session")
      .optional(),
    consoleMode: s
      .enum(["separate", "mergeWithParent"] as const)
      .describe("mergeWithParent: its output goes to the parent session's console")
      .optional(),
    noDebug: s.boolean().describe("Run without debugging").optional(),
    folder: s
      .string()
      .describe("The workspace folder whose launch.json has the configuration `name`")
      .optional(),
  });
  /** Runs a task by label, looked up in `folder` (the configuration's) first (D251). */
  const runTask = async (label: string, what: string, folder?: string) => {
    const r = (await dispatcher.execute("tasks.run", {
      label,
      wait: true,
      ...(folder && { folder }),
    })) as {
      exitCode?: number;
    };
    if (r?.exitCode !== undefined && r.exitCode !== 0)
      throw new Error(`The ${what} "${label}" failed (exit code ${r.exitCode}).`);
  };
  const openConsole = () => {
    if (debug.sessions.peek().length) return;
    consoleOpened = false;
    if ((settings.peek<string>("debug.openDebugConsole") ?? "") === "openOnSessionStart") {
      consoleOpened = true;
      dock.openView("debugConsole", null, "bottom", false);
    }
  };
  /**
   * Starts one configuration in VS Code's order (D295): extensions' resolveDebugConfiguration on
   * it as written, its variables, the preLaunchTask, late variables, then
   * resolveDebugConfigurationWithSubstitutedVariables; the adapter's presence last. A resolver
   * that cancels ends it quietly (null).
   */
  const startOne = async (
    given: LaunchConfig,
    noDebug: boolean,
    caller: { kind: string },
    opts: { parentId?: string; compound?: string; kind?: SessionKind } = {},
  ) => {
    // A restart resolves again from the configuration as written.
    const config = await debug.resolveConfiguration({ ...given, resolved: false });
    if (!config) return null;
    if (config.preLaunchTask)
      await runTask(config.preLaunchTask, "preLaunchTask", config.workspaceFolder);
    const late = await sessionCommands.resolveLate(config, caller.kind === "user");
    const ready = await debug.resolveSubstituted(late);
    if (!ready) return null;
    await sessionCommands.checkAdapter(ready, caller.kind === "user");
    openConsole();
    return debug.start(ready, noDebug, opts);
  };
  const start = async (
    input: {
      name?: string;
      program?: string;
      configuration?: unknown;
      compound?: string;
      parentSession?: string;
      lifecycleManagedByParent?: boolean;
      consoleMode?: "separate" | "mergeWithParent";
      noDebug?: boolean;
      folder?: string;
    },
    caller: { kind: string },
    runWithoutDebugging: boolean,
  ) => {
    // Under a running session (VS Code's parentSession): its noDebug unless told otherwise.
    const parent =
      input.parentSession !== undefined ? debug.session(input.parentSession) : undefined;
    if (input.parentSession !== undefined && !parent)
      throw new Error(`No running session ${input.parentSession}.`);
    const noDebug = input.noDebug ?? (parent ? parent.noDebug : runWithoutDebugging);
    const under = parent
      ? {
          parentId: parent.id,
          // Its console and lifecycle are the parent's (VS Code's mergeWithParent).
          ...((input.consoleMode === "mergeWithParent" || input.lifecycleManagedByParent) && {
            kind: "child" as const,
          }),
        }
      : {};
    const what = noDebug ? "Running" : "Debugging";
    if (caller.kind === "test" && trust.state.peek() === "unknown")
      throw new Error(`${what} needs a trusted folder (workspace.setTrust).`);
    await trust.require(what);
    // The view's selection, when the user started from the keyboard.
    const selected =
      input.name !== undefined || input.program || input.configuration || input.compound
        ? undefined
        : deps.view()?.selectedConfig();
    const { list, compounds } = await configurations();
    const compoundName =
      input.compound ??
      (selected?.startsWith(COMPOUND_PREFIX)
        ? selected.slice(COMPOUND_PREFIX.length)
        : undefined) ??
      (input.name &&
      !list.some((c) => c.name === input.name || c.plainName === input.name) &&
      compounds.some((c) => c.name === input.name || c.plainName === input.name)
        ? input.name
        : undefined);
    if (compoundName !== undefined) {
      const compound = findCompound(
        compounds,
        compoundName,
        caller.kind === "user" ? editorFolder(services) : undefined,
      );
      if (!compound)
        throw new Error(
          `No compound "${compoundName}" in launch.json (debug.listConfigurations lists them).`,
        );
      const configs = resolveCompound(compound, list);
      if (compound.preLaunchTask)
        await runTask(compound.preLaunchTask, "compound's preLaunchTask", compound.workspaceFolder);
      const id = debug.registerCompound(compound.name, compound.stopAll);
      // Each configuration's own preLaunchTask runs first; then they start side by side.
      const started = await Promise.allSettled(
        configs.map((c) => startOne(c, noDebug, caller, { compound: id })),
      );
      const failed = started.flatMap((r, i) =>
        r.status === "rejected"
          ? [
              `${configs[i]?.name}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
            ]
          : [],
      );
      if (failed.length === configs.length) throw new Error(failed.join("\n"));
      for (const f of failed) services.notifications.show("error", f);
      if (!noDebug && caller.kind === "user")
        void dispatcher.execute("view.show", { id: "debug.view" }).catch(() => {});
      return {
        compound: compound.name,
        sessions: started.flatMap((r) =>
          r.status === "fulfilled" && r.value ? [{ id: r.value.id, name: r.value.name }] : [],
        ),
        state: debug.state.peek(),
      };
    }
    const config =
      input.configuration !== undefined
        ? await givenConfig(input.configuration)
        : await resolveConfig(
            input.name ?? (selected?.startsWith(COMPOUND_PREFIX) ? undefined : selected),
            input.program,
            caller.kind === "user",
            input.folder,
          );
    const rs = await startOne(config, noDebug, caller, under);
    if (!noDebug && caller.kind === "user")
      void dispatcher.execute("view.show", { id: "debug.view" }).catch(() => {});
    return {
      name: config.name,
      type: config.type,
      state: debug.state.peek(),
      ...(rs ? { session: rs.id, sessionName: rs.name } : {}),
    };
  };
  debug.hooks = {
    variables: (folder) => deps.configs.variables(folder),
    runTask: (label, folder) => runTask(label, "postDebugTask", folder),
    openExternal: (url) => openerIpc.openUrl(url),
    startByName: async (name, parentId) => {
      const { list } = await configurations();
      // The parent's folder's first (D251: serverReadyAction names one of its own folder).
      const parent = debug.sessions.peek().find((x) => x.id === parentId);
      const c = findConfig(list, name, parent?.config.workspaceFolder);
      if (!c) throw new Error(`No launch configuration "${name}".`);
      await startOne(c, false, { kind: "user" }, { parentId });
    },
  };
  register({
    id: "debug.start",
    title: "Start debugging",
    description:
      "Starts debugging a launch.json configuration (by name), a compound (`compound`: several configurations, each its own session), a file (`program`), or the selected configuration / active file. Sessions already running keep running. Node runs in a terminal tab (its child processes and workers are debugged too); Python needs debugpy. Returns once the program runs, with its session id; read ide://debug for where it stopped.",
    input: startInput,
    effects: ["exec"],
    when: "workspaceOpen",
    agent: "discoverable",
    run: (input, ctx) => start(input, ctx.caller, false),
  });
  register({
    id: "debug.runWithoutDebugging",
    title: "Run without debugging",
    description:
      'Runs a configuration or file like debug.start, without breakpoints: a session with Stop and Restart (its output in its terminal, or in the debug console with "console": "internalConsole").',
    input: startInput,
    effects: ["exec"],
    when: "workspaceOpen",
    run: (input, ctx) => start(input, ctx.caller, true),
  });

  const sessionInput = s
    .string()
    .describe("A session's id or name (ide://debug sessions); default: the focused session")
    .optional();
  const stepCommand = (
    id: string,
    title: string,
    how: "resume" | "next" | "stepIn" | "stepOut" | "pause",
    when: string,
  ) =>
    register({
      id,
      title,
      description: `${title} (while debugging): the focused session's selected thread, or \`session\` / \`threadId\`.${how === "resume" || how === "pause" ? "" : ' Steps one instruction while the disassembly view has the focus, or with `granularity: "instruction"` (debuggers that support it: lldb-dap, GDB…).'}`,
      input: s.object({
        session: sessionInput,
        threadId: s.integer().describe("A thread of that session (ide://debug threads)").optional(),
        granularity: s
          .enum(["statement", "line", "instruction"] as const)
          .describe("How far a step goes (default: a statement)")
          .optional(),
      }),
      effects: ["exec"],
      when,
      agent: "discoverable",
      run: async ({ session, threadId, granularity }) => {
        await debug.step(how, {
          ...(session !== undefined ? { session } : {}),
          ...(threadId !== undefined ? { threadId } : {}),
          ...(granularity !== undefined ? { granularity } : {}),
        });
        return { state: debug.state.peek() };
      },
    });
  stepCommand("debug.continue", "Continue", "resume", "inDebugMode");
  stepCommand("debug.pause", "Pause", "pause", "inDebugMode");
  stepCommand("debug.stepOver", "Step over", "next", "debugState == 'stopped'");
  stepCommand("debug.stepInto", "Step into", "stepIn", "debugState == 'stopped'");
  stepCommand("debug.stepOut", "Step out", "stepOut", "debugState == 'stopped'");
  register({
    id: "debug.stop",
    title: "Stop debugging",
    description:
      "Ends a debug session and its program (default: the focused one), with its child sessions; for a compound with stopAll, every session it started.",
    input: s.object({ session: sessionInput }),
    effects: ["exec"],
    when: "inDebugMode",
    agent: "discoverable",
    run: async ({ session }) => {
      await debug.stop(session);
      return { state: debug.state.peek(), sessions: debug.sessions.peek().length };
    },
  });
  register({
    id: "debug.restart",
    title: "Restart debugging",
    description:
      "Stops a session (default: the focused one) and starts the same configuration again.",
    input: s.object({ session: sessionInput }),
    effects: ["exec"],
    when: "inDebugMode",
    run: async ({ session }, ctx) => {
      let rs = debug.sessionFor(session);
      // A child (a worker, a child process) restarts with the program it belongs to.
      while (rs.parentId) {
        const parent = debug.session(rs.parentId);
        if (!parent) break;
        rs = parent;
      }
      const { config, noDebug, compound } = rs;
      const compoundInfo = compound ? debug.compoundInfo(compound) : undefined;
      // Only this session: a compound's stopAll is for Stop, not Restart (the other sessions
      // were stopped and never started again).
      await debug.stop(rs.id, { alone: true });
      // Its compound ends with its last session: the restarted one is still in it (stopAll).
      if (compound && compoundInfo) debug.keepCompound(compound, compoundInfo);
      await startOne(config, noDebug, ctx.caller, compound ? { compound } : {});
      return { state: debug.state.peek() };
    },
  });
}

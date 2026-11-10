// The debugger's commands added in D204: sessions and threads (focus, select, stop all), function
// and data breakpoints, the adapter's exception filters and the exception widget's details, the
// JavaScript debug terminal, "Add configuration…", the process picker (`${command:pickProcess}`),
// loaded scripts, the disassembly view and instruction breakpoints, installing a missing debug adapter, and the browser pane as a
// target (Windows). The older ones are in index.ts and breakpointCommands.ts.
import { fsIpc } from "../../core/ipc/fs";
import { debugSocketIpc, execIpc } from "../../core/ipc/process";
import type { DisposableStore } from "../../core/lifecycle/index";
import { joinPath } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { parseJsonc } from "../../core/settings/jsonc";
import type { WorkbenchServices } from "../../workbench/services";
import { ensureWorkspaceFolder } from "../../workbench/workspaceFolder";
import { chooseFolder, editorFolder } from "../tasks/chooseFolder";
import { lateVariables, substituteLate } from "../tasks/tasks";
import type { DebugController } from "./controller";
import { currentInstruction, disassemblyState } from "./disassembly";
import { exceptionWidget } from "./exceptionInfo";
import { allSnippets, providedSnippets } from "./extensionAdapters";
import { type LaunchConfig, toConfig } from "./launch";
import { sameAddress } from "./otherBreakpoints";
import { parseProcesses, processChoices } from "./processes";
import { CONFIG_SNIPPETS, insertSnippet } from "./snippets";

export interface SessionCommandHelpers {
  abs(p: string): string;
  rel(p: string): string;
  root(): string | null;
  /** launch.json files, highest precedence first: [path, label]. */
  launchFiles(root: string): [string, string][];
  reloadView(): void;
}

export function registerSessionCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  debug: DebugController,
  helpers: SessionCommandHelpers,
): {
  /** `${command:pickProcess}` and friends, asked now (the user picks). */
  resolveLate(config: LaunchConfig, user: boolean): Promise<LaunchConfig>;
  /** Throws (offering the install) when the configuration's debug adapter isn't installed. */
  checkAdapter(config: LaunchConfig, user: boolean): Promise<void>;
} {
  const { dispatcher, quickInput, notifications, settings, dock, platform } = services;
  const register: typeof dispatcher.register = (c) =>
    sub.add(dispatcher.register({ category: "Debug", ...c }));
  const sessionInput = s
    .string()
    .describe("A session's id or name (ide://debug sessions); default: the focused session")
    .optional();

  // ---- Sessions and threads ----
  register({
    id: "debug.focusSession",
    title: "Focus debug session",
    description:
      "Makes a session the one the toolbar, Variables, Watch and the debug console act on (several can run at once).",
    input: s.object({ session: s.string().describe("Its id or name (ide://debug sessions)") }),
    effects: [],
    when: "inDebugMode",
    agent: "discoverable",
    run: async ({ session }) => {
      debug.focus(session);
      const rs = debug.sessionFor(session);
      const t = rs.threadId.peek();
      if (rs.state.peek() === "stopped" && t !== null) await debug.selectThread(rs.id, t);
      return { session: rs.id, name: rs.name, state: rs.state.peek() };
    },
  });
  register({
    id: "debug.selectThread",
    title: "Select thread",
    description:
      "Shows a thread of a session in the call stack (its frames, its variables); continue, step and pause then act on it.",
    input: s.object({ session: sessionInput, threadId: s.integer() }),
    effects: [],
    when: "inDebugMode",
    agent: "discoverable",
    run: async ({ session, threadId }) => {
      const rs = debug.sessionFor(session);
      await debug.selectThread(rs.id, threadId);
      return { session: rs.id, threadId, frames: rs.frames.peek().length };
    },
  });
  register({
    id: "debug.stopAll",
    title: "Stop all debug sessions",
    description: "Ends every debug session and their programs.",
    input: s.empty(),
    effects: ["exec"],
    when: "inDebugMode",
    agent: "discoverable",
    run: async () => {
      await debug.stopAll();
      return { sessions: debug.sessions.peek().length };
    },
  });

  // ---- Function and data breakpoints ----
  register({
    id: "debug.addFunctionBreakpoint",
    title: "Add function breakpoint…",
    description:
      "Stops when a function by this name is called (`render`, `Cart.total`). With `edit`, asks for that breakpoint's condition or hit count instead. Kept per folder.",
    input: s.object({
      name: s.string().describe("The function's name").optional(),
      condition: s.string().optional(),
      hitCondition: s.string().describe('"5", ">5", "%3"').optional(),
      edit: s.enum(["condition", "hitCondition"] as const).optional(),
    }),
    effects: ["write"],
    agent: "discoverable",
    run: async ({ name, condition, hitCondition, edit }) => {
      const n =
        name ??
        (await quickInput.prompt({
          prompt: "Function to break on",
          placeholder: "e.g. render, Cart.total",
        }));
      if (!n?.trim()) return { added: false };
      if (edit) {
        const f = debug.other.functions.peek().find((x) => x.name === n);
        if (!f) throw new Error(`No function breakpoint "${n}".`);
        const value = await quickInput.prompt({
          prompt: edit === "condition" ? `Break on ${n} when` : `Break on ${n} after hits`,
          value: f[edit] ?? "",
        });
        if (value === undefined) return { added: false };
        debug.other.updateFunction(f.id, { [edit]: value });
        return { name: n, [edit]: value };
      }
      const f = debug.other.addFunction(n, {
        ...(condition ? { condition } : {}),
        ...(hitCondition ? { hitCondition } : {}),
      });
      return { added: true, name: f.name };
    },
  });
  register({
    id: "debug.removeFunctionBreakpoint",
    title: "Remove function breakpoint",
    description: "Removes a function breakpoint by its function's name.",
    input: s.object({ name: s.string() }),
    effects: ["write"],
    agent: "discoverable",
    run: ({ name }) => {
      const f = debug.other.functions.peek().find((x) => x.name === name);
      if (f) debug.other.removeFunction(f.id);
      return { removed: !!f };
    },
  });
  register({
    id: "debug.setFunctionBreakpointEnabled",
    title: "Enable or disable a function breakpoint",
    description: "Turns a function breakpoint on or off (it stays in the list).",
    input: s.object({ name: s.string(), enabled: s.boolean() }),
    effects: ["write"],
    agent: "hidden",
    run: ({ name, enabled }) => {
      const f = debug.other.functions.peek().find((x) => x.name === name);
      if (!f) throw new Error(`No function breakpoint "${name}".`);
      debug.other.updateFunction(f.id, { enabled });
      return { name, enabled };
    },
  });
  register({
    id: "debug.addDataBreakpoint",
    title: "Break on value change",
    description:
      "While paused: stops when a variable's value changes (a data breakpoint), where the debugger supports them (lldb-dap, GDB…; not Node). `container` is the ref of its scope or object (debug.variables); default: the paused frame's scope that has it.",
    input: s.object({
      name: s.string(),
      container: s.integer({ min: 1 }).optional(),
      accessType: s.enum(["write", "read", "readWrite"] as const).optional(),
    }),
    effects: ["exec"],
    when: "debugState == 'stopped'",
    agent: "discoverable",
    run: async ({ name, container, accessType }) => {
      let target = container;
      if (target === undefined) {
        const session = debug.active;
        for (const scope of debug.scopes.peek()) {
          if (scope.expensive || !session) continue;
          const vars = await session.variables(scope.ref).catch(() => []);
          if (vars.some((v) => v.name === name)) {
            target = scope.ref;
            break;
          }
        }
        if (target === undefined) throw new Error(`No variable "${name}" in the paused frame.`);
      }
      const d = await debug.addDataBreakpoint(target, name, accessType ?? "write");
      return { id: d.id, description: d.description, accessType: d.accessType };
    },
  });
  register({
    id: "debug.removeDataBreakpoint",
    title: "Remove data breakpoint",
    description: "Removes a data breakpoint (its id from ide://debug dataBreakpoints).",
    input: s.object({ id: s.integer() }),
    effects: ["write"],
    agent: "hidden",
    run: ({ id }) => {
      debug.other.removeData(id);
      return { removed: true };
    },
  });
  register({
    id: "debug.setDataBreakpointEnabled",
    title: "Enable or disable a data breakpoint",
    description: "Turns a data breakpoint on or off.",
    input: s.object({ id: s.integer(), enabled: s.boolean() }),
    effects: ["write"],
    agent: "hidden",
    run: ({ id, enabled }) => {
      debug.other.updateData(id, { enabled });
      return { id, enabled };
    },
  });

  // ---- Exceptions ----
  register({
    id: "debug.setExceptionFilter",
    title: "Set an exception filter",
    description:
      "Turns one of the debug adapter's exception filters on or off (debugpy's raised / uncaught / userUnhandled, GDB's throw / catch…; ide://debug exceptionFilters lists them), with a condition where it supports one. With `editCondition`, asks for the condition.",
    input: s.object({
      filter: s.string(),
      enabled: s.boolean().optional(),
      condition: s.string().optional(),
      editCondition: s.boolean().optional(),
    }),
    effects: ["write"],
    agent: "discoverable",
    run: async ({ filter, enabled, condition, editCondition }) => {
      let cond = condition;
      if (editCondition) {
        const def = debug.other.filters.peek().find((f) => f.filter === filter);
        cond = await quickInput.prompt({
          prompt: `Break on ${def?.label ?? filter} when`,
          ...(def?.conditionDescription ? { placeholder: def.conditionDescription } : {}),
          value: debug.other.filterChoices.peek()[filter]?.condition ?? "",
        });
        if (cond === undefined) return { changed: false };
      }
      debug.other.setFilter(filter, {
        ...(enabled !== undefined ? { enabled } : editCondition ? { enabled: true } : {}),
        ...(cond !== undefined ? { condition: cond } : {}),
      });
      return { filter, enabled: debug.other.filterOn(filter), condition: cond ?? null };
    },
  });
  register({
    id: "debug.exceptionInfo",
    title: "Exception details",
    description:
      "While paused on an exception: what was thrown — its type, message and stack (what the editor's exception widget shows).",
    input: s.empty(),
    effects: ["read"],
    when: "debugState == 'stopped'",
    agent: "discoverable",
    run: () => {
      const ex = debug.focused.peek()?.exception.peek();
      if (!ex) return { exception: null };
      return { exception: { ...ex, widget: exceptionWidget(ex) } };
    },
  });

  // ---- JavaScript debug terminal ----
  register({
    id: "debug.createJavaScriptDebugTerminal",
    title: "JavaScript debug terminal",
    description:
      "Opens a terminal in which every Node program started (node app.js, npm run dev, Jest, Vitest) is debugged automatically, each as its own session, child processes included.",
    input: s.object({
      cwd: s
        .string()
        .describe("Working directory (default: the folder; multi-root: the editor's folder)")
        .optional(),
    }),
    effects: ["exec"],
    when: "workspaceOpen",
    agent: "discoverable",
    run: async ({ cwd }) => {
      let tabId: string | null = null;
      const env = await debug.debugTerminalEnv(
        () => tabId === null || dock.findTab(tabId) !== undefined,
        sub,
      );
      // A multi-root workspace's editor's folder, else the first (D251).
      const dir = cwd
        ? helpers.abs(cwd)
        : ((services.workspace.folders.peek().length > 1 ? editorFolder(services) : undefined) ??
          helpers.root() ??
          null);
      tabId = dock.openView(
        "terminal",
        { ...(dir ? { cwd: dir } : {}), env, name: "JavaScript debug terminal" },
        "bottom",
        true,
      );
      return { tabId };
    },
  });

  // ---- Add configuration ----
  register({
    id: "debug.addConfiguration",
    title: "Add configuration…",
    description:
      "Adds a starter configuration to launch.json (Node, npm, attach, process picker, Python, LLDB, GDB, Go, .NET, Chrome, Edge, or a compound), creating the file in the IDE's folder when there is none, and opens it. In a multi-root workspace `folder` (a folder's name or path) says whose launch.json; without it, the active editor's folder, else asks.",
    input: s.object({
      snippet: s
        .string()
        .describe(`One of: ${CONFIG_SNIPPETS.map((c) => c.label).join("; ")}`)
        .optional(),
      folder: s.string().describe("Workspace folder (name or path; multi-root)").optional(),
    }),
    effects: ["write"],
    when: "workspaceOpen",
    agent: "discoverable",
    run: async ({ snippet, folder }, ctx) => {
      const r = await chooseFolder(services, folder, {
        placeholder: "Select the workspace folder to add the configuration to",
      });
      if (!r) return { added: false };
      // Extensions' debuggers add theirs (D233), and their providers' configurations (for the
      // folder whose launch.json gets them).
      const declared = allSnippets(services);
      const snippets = [...declared, ...(await providedSnippets(services, declared, r))];
      let chosen = snippet ? snippets.find((c) => c.label === snippet) : undefined;
      if (snippet && !chosen) throw new Error(`No configuration snippet "${snippet}".`);
      if (!chosen) {
        const picked = await quickInput.pick(
          snippets.map((c) => ({ id: c.label, label: c.label, description: c.description })),
          { placeholder: "Select a configuration to add" },
        );
        if (!picked) return { added: false };
        chosen = snippets.find((c) => c.label === picked.id);
      }
      if (!chosen) return { added: false };
      let path: string | null = null;
      for (const [p] of helpers.launchFiles(r))
        if (
          await fsIpc.stat(p).then(
            () => true,
            () => false,
          )
        ) {
          path = p;
          break;
        }
      const text = path
        ? await fsIpc.read(path).then(
            (b) => new TextDecoder().decode(b),
            () => "",
          )
        : "";
      const next = insertSnippet(text, chosen);
      if (next === null || !parseJsonc(next).ok)
        throw new Error(
          "launch.json couldn't be read as JSON: fix it, or add the configuration by hand.",
        );
      const target = path ?? joinPath(await ensureWorkspaceFolder(r), "launch.json");
      await fsIpc.write(target, new TextEncoder().encode(next), "user");
      await ctx.execute("editor.openFile", { path: target });
      helpers.reloadView();
      return { added: true, path: helpers.rel(target), snippet: chosen.label };
    },
  });

  // ---- Processes ----
  const pickProcess = async (filter?: string): Promise<number | null> => {
    const listing = await debugSocketIpc.listProcesses();
    const all = processChoices(parseProcesses(listing.format, listing.text));
    const rows = filter
      ? all.filter((p) =>
          `${p.label} ${p.description}`.toLowerCase().includes(filter.toLowerCase()),
        )
      : all;
    const picked = await quickInput.pick(
      rows.map((p) => ({ id: String(p.pid), label: p.label, description: p.description })),
      { placeholder: "Pick the process to attach to" },
    );
    return picked ? Number(picked.id) : null;
  };
  register({
    id: "debug.listProcesses",
    title: "List processes",
    description:
      "The processes on this machine (pid, name, command line, and the inspector port a Node process was started with), Node ones first: for attaching (`processId` in an attach configuration).",
    input: s.object({ filter: s.string().describe("Text in the name or command line").optional() }),
    effects: ["read"],
    agent: "discoverable",
    run: async ({ filter }) => {
      const listing = await debugSocketIpc.listProcesses();
      const all = processChoices(parseProcesses(listing.format, listing.text));
      const rows = filter
        ? all.filter((p) =>
            `${p.label} ${p.description}`.toLowerCase().includes(filter.toLowerCase()),
          )
        : all;
      return {
        processes: rows.slice(0, 200).map((p) => ({
          pid: p.pid,
          name: p.label,
          command: p.description,
          ...(p.port !== null ? { inspectorPort: p.port } : {}),
          node: p.node,
        })),
      };
    },
  });
  register({
    id: "debug.pickProcess",
    title: "Attach to Node process…",
    description:
      "Picks a running Node process and attaches the debugger to it (VS Code's \"Attach to Node process\"): it's asked to open its inspector when it wasn't started with --inspect.",
    input: s.empty(),
    effects: ["exec"],
    when: "workspaceOpen",
    run: async (_input, ctx) => {
      const pid = await pickProcess();
      if (pid === null) return { attached: false };
      const config = toConfig(
        { name: `Process ${pid}`, type: "node", request: "attach", processId: pid },
        "process picker",
        {
          workspaceFolder: helpers.root() ?? "",
          pathSeparator: platform === "windows" ? "\\" : "/",
        },
      );
      if (!config) return { attached: false };
      void ctx;
      const rs = await debug.start(config);
      return { attached: true, session: rs?.id ?? null, pid };
    },
  });
  const resolveLate = async (config: LaunchConfig, user: boolean): Promise<LaunchConfig> => {
    const names = new Set(lateVariables(JSON.stringify(config.raw)));
    const pick = [...names].find((n) => /^command:(extension\.)?pickProcess$/i.test(n));
    if (!pick) return config;
    if (!user)
      throw new Error(
        `"${config.name}" asks for a process (\${command:pickProcess}): set "processId" (debug.listProcesses lists them).`,
      );
    const pid = await pickProcess();
    if (pid === null) throw new Error("Cancelled.");
    const values = new Map([[pick, String(pid)]]);
    const fill = (v: unknown): unknown =>
      typeof v === "string"
        ? /^\$\{command:(extension\.)?pickProcess\}$/i.test(v)
          ? pid
          : substituteLate(v, values)
        : Array.isArray(v)
          ? v.map(fill)
          : v && typeof v === "object"
            ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]))
            : v;
    return { ...config, raw: fill(config.raw) as Record<string, unknown> };
  };

  // ---- Installing a missing adapter ----
  const checkAdapter = async (config: LaunchConfig, user: boolean): Promise<void> => {
    const adapter = debug.adapterOf(config);
    // An extension's adapter (`connect`): the extension makes the connection, and its command is
    // only the debugger's label ("Memo debugger"), not a program to look for on PATH.
    if (
      adapter.kind !== "dap" ||
      adapter.connect ||
      /[\\/]/.test(adapter.command) ||
      adapter.adapterId === "debugpy"
    )
      return;
    const [present] = await execIpc.installed([adapter.command]).catch(() => [true]);
    if (present !== false) return;
    const message = `${adapter.command} isn't installed: to debug ${config.type}, ${adapter.install ?? `install ${adapter.command}`}.`;
    if (user && adapter.installCommand)
      notifications.show("info", message, {
        actions: [
          {
            label: "Install",
            run: () =>
              void dispatcher
                .execute("debug.installAdapter", { type: config.type })
                .catch((err: unknown) =>
                  notifications.show("error", err instanceof Error ? err.message : String(err)),
                ),
          },
        ],
      });
    throw new Error(message);
  };
  register({
    id: "debug.installAdapter",
    title: "Install debug adapter…",
    description:
      "Installs the debugger a configuration type needs when it can be installed with a command (Go: Delve with `go install`), in a terminal.",
    input: s.object({ type: s.string().describe('A launch.json "type", e.g. go') }),
    effects: ["exec"],
    run: async ({ type }) => {
      const config = toConfig({ name: type, type, request: "launch" }, "install", {
        workspaceFolder: helpers.root() ?? "",
        pathSeparator: "/",
      });
      if (!config) throw new Error(`Not a configuration type: ${type}`);
      const adapter = debug.adapterOf(config);
      if (adapter.kind !== "dap" || !adapter.installCommand)
        throw new Error(
          adapter.kind === "dap" && adapter.install
            ? `Install it yourself: ${adapter.install}.`
            : `Nothing to install for ${type}.`,
        );
      const r = (await dispatcher.execute("terminal.runCommand", {
        command: adapter.installCommand,
        timeoutMs: 15 * 60_000,
      })) as { exitCode?: number | null } | null;
      return { command: adapter.installCommand, exitCode: r?.exitCode ?? null };
    },
  });

  // ---- Loaded scripts, disassembly ----
  register({
    id: "debug.loadedScripts",
    title: "Loaded scripts…",
    description:
      "The scripts the focused session has loaded (name, path or where it came from); the user picks one to open.",
    input: s.object({ filter: s.string().optional() }),
    effects: ["read"],
    when: "inDebugMode",
    agent: "discoverable",
    run: async ({ filter }, ctx) => {
      const session = debug.active;
      const list = (await session?.loadedSources?.().catch(() => [])) ?? [];
      const rows = filter
        ? list.filter((x) =>
            `${x.name} ${x.path ?? x.origin ?? ""}`.toLowerCase().includes(filter.toLowerCase()),
          )
        : list;
      if (ctx.caller.kind === "user") {
        const picked = await quickInput.pick(
          rows
            .filter((x) => x.path)
            .map((x) => ({
              id: x.path ?? "",
              label: x.name,
              description: helpers.rel(x.path ?? ""),
            })),
          { placeholder: "Open a loaded script" },
        );
        if (picked) await ctx.execute("editor.openFile", { path: picked.id });
      }
      return {
        scripts: rows.slice(0, 300).map((x) => ({
          name: x.name,
          ...(x.path ? { path: helpers.rel(x.path) } : { origin: x.origin ?? "" }),
        })),
      };
    },
  });
  register({
    id: "debug.openDisassembly",
    title: "Open disassembly view",
    description:
      "While paused, with a native debugger that can disassemble (lldb-dap, GDB): opens the disassembly view on the selected frame's instruction (more load as it scrolls; a click in its margin sets an instruction breakpoint; F10 / F11 step one instruction while it has the focus). Returns the lines around the current instruction.",
    input: s.empty(),
    effects: ["read"],
    when: "debugState == 'stopped'",
    agent: "discoverable",
    run: async () => {
      const rs = debug.sessionFor();
      if (!rs.session?.disassemble || !rs.capabilities.peek().disassemble)
        throw new Error(`This debugger (${rs.config.type}) can't disassemble.`);
      const at = currentInstruction(debug);
      if (!at) throw new Error("The selected frame has no instruction address.");
      dock.openView("disassembly", null, "main", true);
      // The view loads on its own; wait for its first answer (agents read the lines).
      for (let i = 0; i < 50 && disassemblyState.peek()?.at !== at; i++)
        await new Promise((r) => setTimeout(r, 100));
      const state = disassemblyState.peek();
      return { at, instructions: state?.rows ?? 0, around: state?.around ?? [] };
    },
  });
  const instructionInput = s.object({
    address: s
      .string()
      .describe("The instruction's address (default: the paused frame's)")
      .optional(),
  });
  register({
    id: "debug.toggleInstructionBreakpoint",
    title: "Toggle instruction breakpoint",
    description:
      "Adds or removes a breakpoint on one machine instruction (the disassembly view's margin), for debuggers that support them (lldb-dap, GDB…). Kept while the IDE runs.",
    input: instructionInput,
    effects: ["write"],
    agent: "discoverable",
    run: ({ address }) => {
      const a = address ?? currentInstruction(debug);
      if (!a) throw new Error("No address: pass `address`, or pause in a native program.");
      const rs = debug.focused.peek();
      const added = debug.other.toggleInstruction(a);
      if (added && rs && !rs.capabilities.peek().instructionBreakpoints)
        notifications.show(
          "info",
          `This debugger (${rs.config.type}) doesn't take instruction breakpoints: kept for one that does.`,
        );
      return { address: a, added };
    },
  });
  register({
    id: "debug.setInstructionBreakpointEnabled",
    title: "Enable or disable an instruction breakpoint",
    description: "Turns an instruction breakpoint on or off (it stays in the list).",
    input: s.object({ address: s.string(), enabled: s.boolean() }),
    effects: ["write"],
    agent: "hidden",
    run: ({ address, enabled }) => {
      const b = debug.other.instructions.peek().find((x) => sameAddress(x.address, address));
      if (!b) throw new Error(`No instruction breakpoint at ${address}.`);
      debug.other.updateInstruction(b.id, { enabled });
      return { address, enabled };
    },
  });

  // ---- The browser pane (Windows: WebView2's DevTools port) ----
  sub.add(
    effect(() => {
      settings.version.value;
      const port = settings.peek<number>("debug.browserPane.debuggingPort") ?? 0;
      if (platform === "windows")
        void debugSocketIpc
          .setPanePort(Number.isInteger(port) && port > 0 && port < 65536 ? port : 0)
          .catch(() => {});
      return undefined;
    }),
  );
  register({
    id: "debug.attachToBrowserPane",
    title: "Debug the browser pane",
    description:
      "Attaches the debugger to the page open in the IDE's browser pane, with breakpoints in its scripts (Windows: WebView2 with debug.browserPane.debuggingPort set and the IDE restarted; Linux and macOS webviews can't be debugged this way — use a Chrome or Edge configuration).",
    input: s.object({
      tab: s.string().describe("A browser tab's id (ide://browser); default: the first").optional(),
      folder: s
        .string()
        .describe(
          "Workspace folder the page's scripts come from (name or path; multi-root; default: the active editor's)",
        )
        .optional(),
    }),
    effects: ["exec"],
    when: "workspaceOpen",
    agent: "discoverable",
    run: async ({ tab, folder }) => {
      if (platform !== "windows")
        throw new Error(
          'Only on Windows: WebView2 can open a debugging port; WebKitGTK (Linux) and WKWebView (macOS) can\'t. Debug the page in Chrome or Edge instead (a "chrome" or "msedge" configuration).',
        );
      const port = settings.peek<number>("debug.browserPane.debuggingPort") ?? 0;
      if (!port)
        throw new Error(
          "Set debug.browserPane.debuggingPort (e.g. 9333) and restart the IDE: WebView2 opens the port when it starts.",
        );
      const snap = await services.state.get("ide://browser").catch(() => null);
      const tabs = (snap?.value ?? []) as { tab: string; url: string; frameOrigin?: string }[];
      const t = tab ? tabs.find((x) => x.tab === tab) : tabs.find((x) => x.frameOrigin);
      if (!t?.frameOrigin)
        throw new Error("No page is open in the browser pane (browser.open opens one).");
      // The page's scripts map to a folder's files (D251): the one named, else the active
      // editor's (the project being worked on), else the first. Nothing is asked: an attach
      // works without it, only breakpoints need the right folder.
      const webRoot = folder?.trim()
        ? await chooseFolder(services, folder, { placeholder: "" })
        : services.workspace.folders.peek().length > 1
          ? editorFolder(services)
          : undefined;
      const root = webRoot ?? helpers.root() ?? "";
      const config = toConfig(
        {
          name: `Browser pane: ${t.url}`,
          type: "msedge",
          request: "attach",
          port,
          url: t.frameOrigin,
          browserPane: true,
          webRoot: root,
        },
        "browser pane",
        { workspaceFolder: root, pathSeparator: "\\" },
      );
      if (!config) throw new Error("Couldn't make the configuration.");
      const rs = await debug.start(config);
      return { session: rs?.id ?? null, url: t.url };
    },
  });

  return { resolveLate, checkAdapter };
}

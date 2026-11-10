// Launch configurations (D143): VS Code's launch.json — `.vscode/launch.json` and the IDE's own
// `<workspaceFolderName>/launch.json` — with the same variables as tasks (`${workspaceFolder}`,
// `${file}`…), plus a configuration made up for the active file when there is none. Which
// debugger runs a configuration (`adapterFor`):
//   node / pwa-node     Node's inspector (cdp.ts): `node --inspect-brk`, in a terminal; or
//                       "request": "attach" to a process started with --inspect ("port",
//                       default 9229, "address", or "websocketAddress")
//   python / debugpy    `python -m debugpy.adapter` (pip install debugpy)
//   lldb-dap / lldb     `lldb-dap` (LLVM's; C, C++, Rust, Swift)
//   gdb                 `gdb --interpreter=dap` (GDB 14+)
//   chrome / msedge     Chrome or Edge over the DevTools protocol (browser.ts): "url",
//                       "webRoot", "pathMapping"; or "request": "attach" with "port"
//   go                  Delve, `dlv dap --listen=127.0.0.1:<port>` in a terminal, DAP over TCP
//                       (D204; go install github.com/go-delve/delve/cmd/dlv@latest)
//   coreclr / dotnet    netcoredbg (MIT), `netcoredbg --interpreter=vscode` (D204)
//   java                not built in: Microsoft's java-debug runs inside the Java language
//                       server (D204) — a clear message says so
//   anything else       a `debugAdapter: { command, args }` in the configuration
// DOM-free and tested.
import type { DebugAdapterConnection } from "../../workbench/extensionRegistries";
import { substitute, type Variables } from "../tasks/tasks";

export interface LaunchConfig {
  name: string;
  type: string;
  request: "launch" | "attach";
  program?: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  stopOnEntry: boolean;
  /** Node: the runtime ("node", "bun"…) and its arguments. */
  runtimeExecutable?: string;
  runtimeArgs: string[];
  /** Where the program's input and output go. */
  console: "integratedTerminal" | "internalConsole";
  /** A task to run (and wait for) first. */
  preLaunchTask?: string;
  /** A task to run once the session ended (D204). */
  postDebugTask?: string;
  /** A debug adapter to start for a type the IDE doesn't know. */
  debugAdapter?: { command: string; args: string[] };
  /** Every property, variables filled in (passed on to debug adapters as is). */
  raw: Record<string, unknown>;
  /**
   * The configuration as written, variables not filled in: what extensions' resolvers get first
   * (VS Code's unresolved configuration), resolved again on Restart.
   */
  unresolved?: Record<string, unknown>;
  /** Extensions' resolvers have run on it (resolution.ts): not again before it starts. */
  resolved?: boolean;
  /** "launch.json", ".vscode/launch.json" or "active file". */
  source: string;
  /**
   * The workspace folder it belongs to (D251): its launch.json's; the active file's (else the
   * first) for the workspace file's, given and made-up ones. Its default cwd and `${workspaceFolder}`.
   */
  workspaceFolder?: string;
  /** In a multi-root workspace, the name of the folder whose launch.json has it. */
  folderName?: string;
  /** Its name as written, when `name` has the folder's name added ("Launch" of "Launch (api)"). */
  plainName?: string;
  /**
   * The adapter's own configuration for a child session it asked for (DAP `startDebugging`):
   * sent to the adapter as it is, without the IDE's defaults (args, stopOnEntry, console).
   */
  verbatim?: boolean;
}

export type Adapter =
  | { kind: "cdp" }
  | { kind: "browser" }
  | {
      kind: "dap";
      command: string;
      args: string[];
      adapterId: string;
      /** What to do when it's missing (shown in the error). */
      install?: string;
      /** A command that installs it (debug.installAdapter runs it in a terminal). */
      installCommand?: string;
      /**
       * The adapter listens on a port instead of speaking over stdio (Delve): `{port}` in `args`
       * is replaced by a free one, and the IDE connects there.
       */
      listen?: boolean;
      /** Environment variables for the adapter's process (debugpy's bundled copy, D295). */
      env?: Record<string, string>;
      /**
       * An extension's adapter (D233, extensionAdapters.ts): it makes the connection itself;
       * `exited` when the adapter goes away; `sessionId` the session it serves.
       */
      connect?(exited: () => void, sessionId: string): Promise<DebugAdapterConnection>;
    };

/** The programs the built-in adapters run (settings, else the usual names on PATH). */
export interface AdapterTools {
  python: string;
  lldbDap: string;
  gdb: string;
  dlv?: string;
  netcoredbg?: string;
}

const NODE_TYPES = new Set(["node", "pwa-node", "node2", "bun"]);
const PYTHON_TYPES = new Set(["python", "debugpy"]);
const LLDB_TYPES = new Set(["lldb-dap", "lldb", "lldb-vscode", "codelldb"]);

/** Fills variables into every string inside `value`. */
function fill(value: unknown, v: Variables): unknown {
  if (typeof value === "string") return substitute(value, v);
  if (Array.isArray(value)) return value.map((x) => fill(x, v));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, fill(x, v)]));
  return value;
}

const strings = (x: unknown): string[] =>
  Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
const str = (x: unknown): string | undefined => (typeof x === "string" && x.trim() ? x : undefined);

/** One configuration from its JSON (null when it lacks a name or type). */
export function toConfig(json: unknown, source: string, v: Variables): LaunchConfig | null {
  if (!json || typeof json !== "object") return null;
  const raw = fill(json, v) as Record<string, unknown>;
  const name = str(raw.name);
  const type = str(raw.type);
  if (!name || !type) return null;
  const env: Record<string, string> = {};
  if (raw.env && typeof raw.env === "object")
    for (const [k, x] of Object.entries(raw.env)) if (typeof x === "string") env[k] = x;
  const adapter = raw.debugAdapter as { command?: unknown; args?: unknown } | undefined;
  const program = str(raw.program);
  const cwd = str(raw.cwd);
  const runtimeExecutable = str(raw.runtimeExecutable);
  const preLaunchTask = str(raw.preLaunchTask);
  const postDebugTask = str(raw.postDebugTask);
  const debugAdapterCommand = str(adapter?.command);
  return {
    name,
    type,
    request: raw.request === "attach" ? "attach" : "launch",
    ...(program ? { program } : {}),
    args: strings(raw.args),
    ...(cwd ? { cwd } : {}),
    env,
    stopOnEntry: raw.stopOnEntry === true,
    ...(runtimeExecutable ? { runtimeExecutable } : {}),
    runtimeArgs: strings(raw.runtimeArgs),
    console: raw.console === "internalConsole" ? "internalConsole" : "integratedTerminal",
    ...(preLaunchTask ? { preLaunchTask } : {}),
    ...(postDebugTask ? { postDebugTask } : {}),
    ...(debugAdapterCommand
      ? { debugAdapter: { command: debugAdapterCommand, args: strings(adapter?.args) } }
      : {}),
    raw,
    unresolved: json as Record<string, unknown>,
    source,
  };
}

/** launch.json's `configurations` (invalid ones skipped). */
export function parseLaunchJson(json: unknown, source: string, v: Variables): LaunchConfig[] {
  const list = (json as { configurations?: unknown } | null)?.configurations;
  if (!Array.isArray(list)) return [];
  return list.flatMap((c) => toConfig(c, source, v) ?? []);
}

/**
 * The configuration of a child session a debug adapter asked for (DAP `startDebugging`), as VS
 * Code makes it: the adapter's configuration with the parent's type, so the same debugger runs it
 * (a new adapter process, e.g. debugpy's `connect` to its subprocess). The parent's adapter
 * settings (`debugAdapter`, debugpy's `python`, Delve's `dlvToolPath`) come along when the
 * adapter didn't name its own. Variables aren't filled in: the adapter's values are final.
 */
export function childLaunchConfig(
  parent: LaunchConfig,
  configuration: Record<string, unknown>,
  request: "launch" | "attach",
): LaunchConfig {
  const inherited: Record<string, unknown> = {};
  for (const key of ["debugAdapter", "python", "dlvToolPath"])
    if (configuration[key] === undefined && parent.raw[key] !== undefined)
      inherited[key] = parent.raw[key];
  const raw: Record<string, unknown> = {
    ...inherited,
    ...configuration,
    type: parent.type,
    request,
    name: str(configuration.name) ?? `${parent.name}: child`,
  };
  const made = toConfig(raw, "startDebugging", { workspaceFolder: "", pathSeparator: "/" });
  // toConfig only fails without a name or type, and both are set above.
  const base = made ?? { ...parent, args: [], env: {}, runtimeArgs: [] };
  // The raw configuration stays the adapter's own (toConfig filled variables into its copy).
  return { ...base, name: String(raw.name), raw, source: "startDebugging", verbatim: true };
}

/** A configuration for running the file itself (F5 with no launch.json), or null. */
export function configForFile(file: string, v: Variables): LaunchConfig | null {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  const base = file.split(/[\\/]/).pop() ?? file;
  if (["js", "mjs", "cjs", "ts", "mts", "cts"].includes(ext))
    return toConfig(
      {
        name: `Run ${base}`,
        type: "node",
        request: "launch",
        program: file,
        cwd: v.workspaceFolder,
      },
      "active file",
      v,
    );
  if (ext === "py")
    return toConfig(
      {
        name: `Run ${base}`,
        type: "debugpy",
        request: "launch",
        program: file,
        cwd: v.workspaceFolder,
        console: "integratedTerminal",
        justMyCode: true,
      },
      "active file",
      v,
    );
  return null;
}

/** Which debugger runs `config`; throws with what to set up when none fits. */
export function adapterFor(config: LaunchConfig, tools: AdapterTools): Adapter {
  if (config.debugAdapter) return { kind: "dap", adapterId: config.type, ...config.debugAdapter };
  const type = config.type.toLowerCase();
  if (NODE_TYPES.has(type)) return { kind: "cdp" };
  if (PYTHON_TYPES.has(type))
    return {
      kind: "dap",
      adapterId: "debugpy",
      command: str(config.raw.python) ?? tools.python,
      args: ["-m", "debugpy.adapter"],
      install: "pip install debugpy",
    };
  if (LLDB_TYPES.has(type))
    return {
      kind: "dap",
      adapterId: "lldb-dap",
      command: tools.lldbDap,
      args: [],
      install: "install LLVM (lldb-dap)",
    };
  if (type === "gdb" || type === "cppdbg")
    return {
      kind: "dap",
      adapterId: "gdb",
      command: tools.gdb,
      args: ["--interpreter=dap"],
      install: "install GDB 14 or newer",
    };
  // Chrome / Edge (D196, browser.ts): the page over the DevTools protocol.
  if (/^(pwa-)?(chrome|msedge|edge)$/.test(type)) return { kind: "browser" };
  // Go (D204): Delve's DAP server, which listens on a port.
  if (type === "go")
    return {
      kind: "dap",
      adapterId: "go",
      command: str(config.raw.dlvToolPath) ?? tools.dlv ?? "dlv",
      args: ["dap", "--listen=127.0.0.1:{port}"],
      listen: true,
      install: "install Delve (go install github.com/go-delve/delve/cmd/dlv@latest)",
      installCommand: "go install github.com/go-delve/delve/cmd/dlv@latest",
    };
  // .NET (D204): netcoredbg (MIT), VS Code's protocol over stdio.
  if (type === "coreclr" || type === "dotnet" || type === "netcoredbg")
    return {
      kind: "dap",
      adapterId: "coreclr",
      command: tools.netcoredbg ?? "netcoredbg",
      args: ["--interpreter=vscode"],
      install:
        "install netcoredbg (github.com/Samsung/netcoredbg/releases) and put it on PATH or in the debug.netcoredbgPath setting",
    };
  if (type === "java")
    throw new Error(
      `Java debugging isn't built in: Microsoft's java-debug runs inside the Java language server (Eclipse JDT LS) as a plugin. Start your program with -agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=5005 and attach a DAP adapter for JDWP with "debugAdapter": { "command": "…", "args": [] }.`,
    );
  throw new Error(
    `No debugger for type "${config.type}". Add "debugAdapter": { "command": "…", "args": [] } to the configuration.`,
  );
}

/** The launch request's arguments for a DAP adapter (our own keys dropped). */
export function dapLaunchArguments(config: LaunchConfig): Record<string, unknown> {
  const {
    debugAdapter: _a,
    preLaunchTask: _t,
    postDebugTask: _p,
    serverReadyAction: _s,
    ...rest
  } = config.raw;
  if (config.verbatim) return rest;
  return {
    ...rest,
    ...(config.cwd ? { cwd: config.cwd } : {}),
    ...(config.program ? { program: config.program } : {}),
    args: config.args,
    stopOnEntry: config.stopOnEntry,
    // netcoredbg and the C# extension's name for it.
    ...(/^(coreclr|dotnet|netcoredbg)$/i.test(config.type)
      ? { stopAtEntry: config.stopOnEntry }
      : {}),
    // Delve: "debug" (build and run the package) unless the configuration says otherwise.
    ...(config.type.toLowerCase() === "go" && !rest.mode ? { mode: "debug" } : {}),
    console: config.console,
  };
}

export const LAUNCH_TEMPLATE = `{
  // Run and debug (F5). Same format as VS Code: \${workspaceFolder}, \${file}… are filled in.
  // "type": node (Node's inspector), debugpy (pip install debugpy), lldb-dap, gdb (14+), go
  // (Delve), coreclr (netcoredbg), chrome / msedge, or any debug adapter with
  // "debugAdapter": { "command": "…", "args": [] }. "Debug: Add configuration…" adds more;
  // "compounds" start several configurations together.
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run current file",
      "type": "node",
      "request": "launch",
      "program": "\${file}",
      "cwd": "\${workspaceFolder}"
    }
  ],
  "compounds": []
}
`;

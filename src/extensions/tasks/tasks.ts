// Tasks, VS Code's format: `.vscode/tasks.json` (and the IDE's own `<workspaceFolderName>/tasks.json`,
// and the user's tasks.json) plus package.json scripts found automatically ("npm: dev", with the
// project's package manager). Parsing, variable substitution and the command line are DOM-free
// and tested. `${input:…}` and `${command:…}` are left for run time (they may ask).
import type { RunSpec } from "../../core/ipc/process";
import { isAbsolute, isWithin, resolveInRoot } from "../../core/paths/index";
import { parseWslPath } from "../../core/paths/wsl";
import { folderOf } from "../../core/workspace/workspaceFile";
import type { TaskPresentation } from "../../workbench/services";

export const DEFAULT_PRESENTATION: TaskPresentation = {
  reveal: "always",
  focus: false,
  panel: "shared",
  clear: false,
  close: false,
};

export interface TaskDefinition {
  label: string;
  /** The full command line, as shown (and as a shell runs it). */
  command: string;
  /** What the terminal runs: the command line through a shell, or a program and its args. */
  spec: RunSpec;
  cwd?: string;
  /** "build" / "test" group; `isDefault` marks the one Ctrl/Cmd+Shift+B runs. */
  group?: { kind: string; isDefault: boolean };
  /** Keeps running (watchers, dev servers). */
  background: boolean;
  dependsOn: string[];
  /** Run dependencies one after another ("sequence") or all at once (VS Code's default). */
  dependsOrder: "parallel" | "sequence";
  /** Where it came from: ".vscode/tasks.json", "package.json", "Makefile"… */
  source: string;
  /** A detected task's folder, workspace-relative ("" the root; detect.ts). */
  folder?: string;
  /**
   * The workspace folder it belongs to (D251), absolute: its tasks.json's or build file's folder;
   * for user and workspace-file tasks the one their variables were filled in for. Its default
   * cwd, relative cwd and problem matchers' relative paths are this folder's.
   */
  workspaceFolder?: string;
  /** The name of the workspace folder whose files define it (not set for user tasks). */
  folderName?: string;
  /** The label as written, when `label` has the folder's name added ("build" of "build (api)"). */
  name?: string;
  /** The tasks.json (or workspace file) it comes from. */
  file?: string;
  /** Its file's `inputs` (what its `${input:…}` ask). */
  inputs?: TaskInput[];
  detail?: string;
  /** tasks.json `problemMatcher` as written ("$tsc", objects, a list); see problemMatchers.ts. */
  problemMatcher?: unknown;
  presentation: TaskPresentation;
  /** `runOptions.runOn: "folderOpen"`: runs when the folder opens (once allowed). */
  runOnFolderOpen: boolean;
  /** Left out of "Run task…" (still runnable as a dependency or by label). */
  hide: boolean;
}

/** tasks.json `inputs`: what `${input:id}` asks for. */
export interface TaskInput {
  id: string;
  type: "promptString" | "pickString" | "command";
  description: string;
  default?: string;
  options?: { label: string; value: string }[];
  password?: boolean;
  command?: string;
  args?: unknown;
}

export interface Variables {
  /** The folder `${workspaceFolder}` means: the config file's folder (D251). */
  workspaceFolder: string;
  /**
   * The workspace's folders (D251): `${workspaceFolder:Name}`, `${fileWorkspaceFolder}`. Without
   * them, the one folder `workspaceFolder` (named after its basename).
   */
  folders?: readonly { name: string; path: string }[];
  file?: string;
  lineNumber?: number;
  pathSeparator: string;
  /** For `${env:NAME}` (left as is when missing). */
  env?: Readonly<Record<string, string>>;
  /** For `${config:key}` (a setting's value). */
  config?: (key: string) => unknown;
}

const lastSep = (p: string) => Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
const baseOf = (p: string) => p.split(/[\\/]/).pop() ?? "";
/** `file` relative to `folder` (OS separators kept), or null when it isn't inside. */
const relativeTo = (folder: string, file: string): string | null =>
  folder && isWithin(folder, file) ? file.slice(folder.length).replace(/^[\\/]/, "") : null;

/** Folder-scoped variables VS Code takes a folder's name for: `${workspaceFolder:api}`. */
const SCOPED = new Set([
  "workspaceFolder",
  "workspaceRoot",
  "workspaceFolderBasename",
  "relativeFile",
  "relativeFileDirname",
]);

/**
 * `${workspaceFolder}`, `${file}`, `${fileDirname}`, `${relativeFile}`, `${fileWorkspaceFolder}`,
 * `${workspaceFolder:Name}`… (unknown ones stay). `${relativeFile}` is relative to the config's
 * folder, else to the file's own folder (D251).
 */
export function substitute(text: string, v: Variables): string {
  if (!text.includes("${")) return text;
  const sep = v.pathSeparator;
  const file = v.file ?? "";
  const dir = file ? file.slice(0, lastSep(file)) : "";
  const base = file ? file.slice(lastSep(file) + 1) : "";
  const folders =
    v.folders ??
    (v.workspaceFolder ? [{ name: baseOf(v.workspaceFolder), path: v.workspaceFolder }] : []);
  const fileFolder = file ? folderOf(folders, file)?.path : undefined;
  const relOf = (folder: string) =>
    relativeTo(folder, file) ?? (fileFolder ? relativeTo(fileFolder, file) : null) ?? file;
  const relDir = (rel: string) => (lastSep(rel) >= 0 ? rel.slice(0, lastSep(rel)) : "");
  const rel = file ? relOf(v.workspaceFolder) : "";
  const map: Record<string, string> = {
    workspaceFolder: v.workspaceFolder,
    workspaceRoot: v.workspaceFolder,
    workspaceFolderBasename: baseOf(v.workspaceFolder),
    file,
    fileWorkspaceFolder: fileFolder ?? v.workspaceFolder,
    fileWorkspaceFolderBasename: baseOf(fileFolder ?? v.workspaceFolder),
    fileDirname: dir,
    fileBasename: base,
    fileBasenameNoExtension: base.replace(/\.[^.]*$/, ""),
    fileExtname: base.includes(".") ? base.slice(base.lastIndexOf(".")) : "",
    relativeFile: rel,
    relativeFileDirname: relDir(rel),
    lineNumber: v.lineNumber ? String(v.lineNumber) : "",
    cwd: v.workspaceFolder,
    pathSeparator: sep,
    "/": sep,
  };
  const scoped = (variable: string, folderName: string): string | undefined => {
    const folder = folders.find((f) => f.name === folderName)?.path;
    if (folder === undefined) return undefined;
    switch (variable) {
      case "workspaceFolderBasename":
        return baseOf(folder);
      case "relativeFile":
        return file ? relOf(folder) : "";
      case "relativeFileDirname":
        return file ? relDir(relOf(folder)) : "";
      default:
        return folder;
    }
  };
  return text.replace(/\$\{([^}]+)\}/g, (whole, name: string) => {
    if (name.startsWith("env:")) return v.env?.[name.slice(4)] ?? (v.env ? "" : whole);
    if (name.startsWith("config:") && v.config) {
      const value = v.config(name.slice(7));
      return value === undefined || value === null ? "" : String(value);
    }
    const colon = name.indexOf(":");
    if (colon > 0 && SCOPED.has(name.slice(0, colon)))
      return scoped(name.slice(0, colon), name.slice(colon + 1)) ?? whole;
    return map[name] ?? whole;
  });
}

/**
 * Where a task runs (D251): its `cwd` (a relative one is its workspace folder's, as in VS Code),
 * else its folder; undefined leaves it to the terminal (the first folder).
 */
export function taskCwd(cwd: string | undefined, folder: string | undefined): string | undefined {
  if (!cwd) return folder;
  return folder && !isAbsolute(cwd) ? resolveInRoot(folder, cwd) : cwd;
}

/** The `${input:id}` and `${command:id}` names in `text`, in order. */
export function lateVariables(text: string): string[] {
  return [...text.matchAll(/\$\{((?:input|command):[^}]+)\}/g)].map((m) => m[1] ?? "");
}

/** Replaces `${input:id}` / `${command:id}` with their values (unknown ones stay). */
export function substituteLate(text: string, values: ReadonlyMap<string, string>): string {
  return text.replace(/\$\{((?:input|command):[^}]+)\}/g, (whole, name: string) =>
    values.has(name) ? (values.get(name) ?? "") : whole,
  );
}

/** tasks.json `inputs` (invalid entries are skipped). */
export function parseInputs(value: unknown): TaskInput[] {
  const list = (value as { inputs?: unknown } | null)?.inputs;
  if (!Array.isArray(list)) return [];
  const out: TaskInput[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string") continue;
    const type =
      r.type === "pickString" || r.type === "command" ? r.type : ("promptString" as const);
    const options = Array.isArray(r.options)
      ? r.options.flatMap((o) =>
          typeof o === "string"
            ? [{ label: o, value: o }]
            : o && typeof o === "object" && typeof (o as { value?: unknown }).value === "string"
              ? [
                  {
                    label: String(
                      (o as { label?: unknown }).label ?? (o as { value: string }).value,
                    ),
                    value: (o as { value: string }).value,
                  },
                ]
              : [],
        )
      : undefined;
    out.push({
      id: r.id,
      type,
      description: typeof r.description === "string" ? r.description : r.id,
      ...(typeof r.default === "string" && { default: r.default }),
      ...(options && { options }),
      ...(r.password === true && { password: true }),
      ...(typeof r.command === "string" && { command: r.command }),
      ...(r.args !== undefined && { args: r.args }),
    });
  }
  return out;
}

function parsePresentation(raw: unknown, base: TaskPresentation): TaskPresentation {
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(v as T) ? (v as T) : fallback;
  return {
    reveal: pick(r.reveal, ["always", "silent", "never"] as const, base.reveal),
    focus: typeof r.focus === "boolean" ? r.focus : base.focus,
    panel: pick(r.panel, ["shared", "dedicated", "new"] as const, base.panel),
    clear: typeof r.clear === "boolean" ? r.clear : base.clear,
    close: typeof r.close === "boolean" ? r.close : base.close,
  };
}

function stringRecord(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>))
    if (typeof x === "string" || typeof x === "number") out[k] = String(x);
  return out;
}

export type TaskShellKind = "posix" | "pwsh" | "cmd";

/**
 * The platform a folder's tasks run on: Linux for a folder inside WSL opened from Windows (its
 * tasks run in the distribution, so tasks.json's `linux` blocks apply, as in VS Code's WSL
 * window), else the IDE's own.
 */
export function taskPlatform(
  platform: "windows" | "mac" | "linux",
  folder: string | null | undefined,
): "windows" | "mac" | "linux" {
  // A WSL folder, or a remote one (D252: on a Windows host only a remote window has POSIX
  // paths; the server runs on Linux): the task runs there, so its `linux` block applies.
  const remote = /^\/(?!\/)/.test(folder ?? "");
  return platform === "windows" && folder && (parseWslPath(folder) || remote) ? "linux" : platform;
}

/**
 * The shell a shell task's command line goes to: `options.shell.executable`, else the default one
 * (PowerShell on Windows, the login shell elsewhere).
 */
export function taskShellKind(
  executable: string | undefined,
  platform: "windows" | "mac" | "linux",
): TaskShellKind {
  const name = (executable ?? "")
    .split(/[\\/]/)
    .pop()
    ?.toLowerCase()
    .replace(/\.exe$/, "");
  if (name === "cmd") return "cmd";
  if (name === "pwsh" || name === "powershell") return "pwsh";
  if (name) return "posix";
  return platform === "windows" ? "pwsh" : "posix";
}

/** PowerShell reads the typographic single quotes as quotes too (‘ ’ ‚ ‛). */
const PWSH_SINGLE_QUOTES = /['‘’‚‛]/g;

/**
 * One argument of a shell task, quoted for its shell (VS Code's "strong" quoting): a file name
 * that `${file}` puts there (`$(cmd).py`, `it’s.ts`) stays one literal argument. Double quotes
 * would leave `$(…)` and `` `…` `` to run in bash and PowerShell.
 */
export function quoteTaskArg(arg: string, kind: TaskShellKind): string {
  switch (kind) {
    case "posix":
      return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
    case "pwsh":
      // No leading @ (splatting) or commas (an array) unquoted.
      return /^[\w%+=:./\\-]+$/.test(arg) ? arg : `'${arg.replace(PWSH_SINGLE_QUOTES, "$&$&")}'`;
    case "cmd":
      return /^[\w+:./\\-]+$/.test(arg) ? arg : `"${arg.replaceAll('"', '""')}"`;
  }
}

const looksBackground = (command: string) =>
  /\b(dev|serve|start|watch|preview)\b|--watch\b|\bnodemon\b|http\.server/.test(command);

/** Tasks from a parsed tasks.json object (invalid entries are skipped). */
export function parseTasksJson(
  value: unknown,
  source: string,
  v: Variables,
  platform: "windows" | "mac" | "linux",
  /** The shell a task without `options.shell` runs in (the automation profile, D209). */
  defaultShell?: string | null,
): TaskDefinition[] {
  if (!value || typeof value !== "object") return [];
  const platformKey = platform === "windows" ? "windows" : platform === "mac" ? "osx" : "linux";
  // Top-level options / presentation apply to every task (and their own platform block).
  const top = value as Record<string, unknown>;
  const topAll = { ...top, ...((top[platformKey] as Record<string, unknown> | undefined) ?? {}) };
  const tasks = top.tasks;
  if (!Array.isArray(tasks)) return [];
  const topPresentation = parsePresentation(topAll.presentation, DEFAULT_PRESENTATION);
  const topOptions = (topAll.options ?? {}) as Record<string, unknown>;
  const out: TaskDefinition[] = [];
  for (const raw of tasks) {
    if (!raw || typeof raw !== "object") continue;
    // Platform blocks override the task's own fields, like VS Code.
    const base = raw as Record<string, unknown>;
    const t = { ...base, ...((base[platformKey] as Record<string, unknown> | undefined) ?? {}) };
    const options = { ...topOptions, ...((t.options ?? {}) as Record<string, unknown>) };
    const isProcess = t.type === "process";
    let command = "";
    let spec: RunSpec = { kind: "shell", command: "" };
    const argValue = (a: unknown) =>
      substitute(
        typeof a === "string"
          ? a
          : typeof a === "object" && a && "value" in a
            ? String((a as { value: unknown }).value)
            : String(a),
        v,
      );
    if (t.type === "npm" && typeof t.script === "string") {
      command = `npm run ${t.script}`;
      spec = { kind: "shell", command };
    } else if (typeof t.command === "string" || Array.isArray(t.command)) {
      // A command given as a list of parts is one command line (VS Code's quoted form).
      const program = Array.isArray(t.command)
        ? t.command.map((c) => argValue(c)).join(" ")
        : substitute(t.command, v);
      const args = Array.isArray(t.args) ? t.args.map(argValue) : [];
      const shellExecutable = (options.shell as { executable?: unknown } | undefined)?.executable;
      const kind = taskShellKind(
        typeof shellExecutable === "string" ? shellExecutable : (defaultShell ?? undefined),
        platform,
      );
      command = [program, ...args.map((a) => quoteTaskArg(a, kind))].join(" ");
      spec = isProcess ? { kind: "process", command: program, args } : { kind: "shell", command };
    }
    const label =
      typeof t.label === "string"
        ? t.label
        : typeof t.taskName === "string"
          ? t.taskName
          : t.type === "npm" && typeof t.script === "string"
            ? `npm: ${t.script}`
            : command;
    const dependsOn =
      typeof t.dependsOn === "string"
        ? [t.dependsOn]
        : Array.isArray(t.dependsOn)
          ? t.dependsOn.flatMap((d) =>
              typeof d === "string"
                ? [d]
                : d && typeof d === "object" && typeof (d as { label?: unknown }).label === "string"
                  ? [(d as { label: string }).label]
                  : [],
            )
          : [];
    if (!label || (!command && !dependsOn.length)) continue;
    const g = t.group;
    const group =
      typeof g === "string"
        ? { kind: g, isDefault: false }
        : g && typeof g === "object" && typeof (g as { kind?: unknown }).kind === "string"
          ? {
              kind: (g as { kind: string }).kind,
              isDefault: (g as { isDefault?: unknown }).isDefault === true,
            }
          : undefined;
    const npmPath = t.type === "npm" && typeof t.path === "string" ? t.path : undefined;
    const cwdRaw = typeof options.cwd === "string" ? options.cwd : npmPath;
    const cwd = cwdRaw ? substitute(cwdRaw, v) : undefined;
    const env = stringRecord(options.env);
    const shellOption = options.shell as { executable?: unknown; args?: unknown } | undefined;
    if (spec.command) {
      if (env)
        spec.env = Object.fromEntries(Object.entries(env).map(([k, x]) => [k, substitute(x, v)]));
      if (!isProcess && typeof shellOption?.executable === "string")
        spec.shell = {
          executable: shellOption.executable,
          args: Array.isArray(shellOption.args)
            ? shellOption.args.filter((a): a is string => typeof a === "string")
            : [],
        };
    }
    const runOptions = t.runOptions as { runOn?: unknown } | undefined;
    out.push({
      label,
      command,
      spec,
      ...(cwd && { cwd }),
      ...(group && { group }),
      background:
        t.isBackground === true || (t.isBackground === undefined && looksBackground(command)),
      dependsOn,
      dependsOrder: t.dependsOrder === "sequence" ? "sequence" : "parallel",
      source,
      ...(typeof t.detail === "string" && { detail: t.detail }),
      ...(t.problemMatcher !== undefined && { problemMatcher: t.problemMatcher }),
      presentation: parsePresentation(t.presentation, topPresentation),
      runOnFolderOpen: runOptions?.runOn === "folderOpen",
      hide: t.hide === true,
    });
  }
  return out;
}

/** "npm: <script>" tasks from package.json, run with the project's package manager. */
export function scriptTasks(pkg: unknown, lockfiles: readonly string[]): TaskDefinition[] {
  const scripts = (pkg as { scripts?: unknown } | null)?.scripts;
  if (!scripts || typeof scripts !== "object") return [];
  const manager = lockfiles.includes("pnpm-lock.yaml")
    ? "pnpm"
    : lockfiles.includes("yarn.lock")
      ? "yarn"
      : lockfiles.includes("bun.lockb") || lockfiles.includes("bun.lock")
        ? "bun"
        : "npm";
  return Object.entries(scripts as Record<string, unknown>)
    .filter(([, body]) => typeof body === "string")
    .map(([name, body]) => {
      const command =
        manager === "npm"
          ? `npm run ${name}`
          : `${manager} ${manager === "bun" ? "run " : ""}${name}`;
      return { name, body, command };
    })
    .map(({ name, body, command }) => ({
      label: `${manager}: ${name}`,
      command,
      spec: { kind: "shell" as const, command },
      background: looksBackground(`${name} ${body as string}`),
      dependsOn: [],
      dependsOrder: "parallel" as const,
      presentation: DEFAULT_PRESENTATION,
      runOnFolderOpen: false,
      hide: false,
      source: "package.json",
      detail: body as string,
      ...(name === "build" && { group: { kind: "build", isDefault: false } }),
      ...(name === "test" && { group: { kind: "test", isDefault: false } }),
    }));
}

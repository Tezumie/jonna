// The checks the extensions host applies to what an extension's workbench providers answer
// (D233): provided tasks (runtimeTerminals.ts), source control state and its rows
// (runtimeScm.ts, scmSection.ts), debug adapter descriptors (runtimeDebugAdapters.ts), sessions
// and when getSession asks the user (runtimeAuth.ts), file system schemes
// (runtimeFileSystems.ts). DOM-free and unit-tested.
import type { DebugAdapterDescriptor, ScmWire } from "../../core/extensions/rpcScmDebug";
import { relativeTo } from "../../core/extensions/rpcWorkspace";
import type { RunSpec } from "../../core/ipc/process";
import { globToRegExp } from "../../core/paths/glob";
import { basename, dirname, joinPath, relativePath } from "../../core/paths/index";
import {
  type AuthSession,
  type ContributedTask,
  SCM_TONES,
  type ScmGroup,
  type ScmProviderEntry,
  type ScmResource,
  type ScmState,
  type ScmTone,
  uriScheme,
} from "../../workbench/extensionRegistries";
import type { TaskPresentation } from "../../workbench/services";
import type { HostTreeItem } from "./treeView";

/** An object from the worker, before it's checked. */
type ProviderWire = Record<string, unknown>;

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

// ---- Tasks and terminals -----------------------------------------------------------------------

/** `env` from an extension: names of letters, digits and _, string values. */
export function checkEnv(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("env must be an object.");
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 200) throw new Error("env has too many variables.");
  const env: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (typeof v !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
      throw new Error(`env.${k}: names are letters, digits and _, values strings.`);
    env[k] = v;
  }
  return env;
}

const REVEALS = ["always", "silent", "never"] as const;
const PANELS = ["shared", "dedicated", "new"] as const;

/**
 * A provided task as the tasks extension gets it, or a reason it's refused. `custom` registers a
 * custom execution's pseudoterminal and returns its key.
 */
export function checkTask(
  raw: unknown,
  type: string,
  context: {
    source: string;
    owner: string;
    granted(permission: string): boolean;
    cwd(path: unknown): string;
    custom(key: string): string;
  },
): ContributedTask | string {
  const t = (raw && typeof raw === "object" ? raw : {}) as ProviderWire;
  const name = str(t.name, 100).trim();
  if (!name) return "a task needs a name";
  const label = `${type}: ${name}`;
  const e = (t.execution && typeof t.execution === "object" ? t.execution : {}) as ProviderWire;
  let spec: RunSpec;
  let command: string;
  if (e.kind === "custom") {
    if (!context.granted("terminal"))
      return `${label}: a custom task needs the "terminal" permission`;
    if (typeof e.key !== "string") return `${label}: bad custom execution`;
    spec = { kind: "process", command: name, virtual: context.custom(e.key) };
    command = name;
  } else if (e.kind === "shell" || e.kind === "process") {
    if (!context.granted("shell")) return `${label}: running programs needs the "shell" permission`;
    const program = str(e.kind === "shell" ? e.commandLine : e.process, 8000).trim();
    if (!program) return `${label}: nothing to run`;
    const args = Array.isArray(e.args)
      ? e.args.filter((a): a is string => typeof a === "string")
      : [];
    let env: Record<string, string> | undefined;
    try {
      env = checkEnv(e.env);
    } catch (err) {
      return `${label}: ${err instanceof Error ? err.message : String(err)}`;
    }
    // A shell of its own (VS Code's `options.executable` / `shellArgs`, D261).
    const shellOf = (e.shell && typeof e.shell === "object" ? e.shell : {}) as ProviderWire;
    const executable = str(shellOf.executable, 500).trim();
    const shellArgs = Array.isArray(shellOf.args)
      ? shellOf.args.filter((a): a is string => typeof a === "string").slice(0, 20)
      : undefined;
    const shell = executable
      ? { executable, ...(shellArgs?.length && { args: shellArgs }) }
      : undefined;
    spec =
      e.kind === "shell"
        ? { kind: "shell", command: program, ...(env && { env }), ...(shell && { shell }) }
        : { kind: "process", command: program, args, ...(env && { env }) };
    command = [program, ...args].join(" ");
  } else return `${label}: execution.kind is "shell", "process" or "custom"`;
  let cwd: string | undefined;
  if (e.cwd !== undefined) {
    try {
      cwd = context.cwd(e.cwd);
    } catch (err) {
      return `${label}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const g = t.group as ProviderWire | string | undefined;
  const group =
    g === "build" || g === "test"
      ? { kind: g, isDefault: false }
      : g && typeof g === "object" && (g.kind === "build" || g.kind === "test")
        ? { kind: g.kind, isDefault: g.isDefault === true }
        : undefined;
  const p = (
    t.presentation && typeof t.presentation === "object" ? t.presentation : {}
  ) as ProviderWire;
  const presentation: Partial<TaskPresentation> = {
    ...(REVEALS.includes(p.reveal as never) && { reveal: p.reveal as TaskPresentation["reveal"] }),
    ...(PANELS.includes(p.panel as never) && { panel: p.panel as TaskPresentation["panel"] }),
    ...(typeof p.focus === "boolean" && { focus: p.focus }),
    ...(typeof p.clear === "boolean" && { clear: p.clear }),
    ...(typeof p.close === "boolean" && { close: p.close }),
  };
  return {
    owner: context.owner,
    label,
    source: context.source,
    ...(typeof t.detail === "string" && t.detail && { detail: t.detail.slice(0, 300) }),
    spec,
    command,
    ...(cwd && { cwd }),
    ...(group && { group }),
    background: t.isBackground === true,
    ...(t.problemMatchers !== undefined && { problemMatcher: t.problemMatchers }),
    ...(Object.keys(presentation).length && { presentation }),
  };
}

// ---- Source control ----------------------------------------------------------------------------

const MAX_GROUPS = 20;
const MAX_RESOURCES = 5000;

/**
 * A source control's state from the worker, checked: `path` resolves a resource (in the folder,
 * or a URI of `ownSchemes`), `ownCommand` says whether a command is the extension's.
 */
export function checkScmState(
  wire: Partial<ScmWire>,
  context: {
    path(path: unknown): string;
    ownSchemes: readonly string[];
    ownCommand(id: string): boolean;
  },
): ScmState {
  const resource = (raw: unknown): ScmResource[] => {
    const r = (raw && typeof raw === "object" ? raw : {}) as ProviderWire;
    let path: string;
    const scheme = typeof r.path === "string" ? uriScheme(r.path) : null;
    if (scheme) {
      if (!context.ownSchemes.includes(scheme)) return [];
      path = String(r.path);
    } else
      try {
        path = context.path(r.path);
      } catch {
        return [];
      }
    const d = (
      r.decorations && typeof r.decorations === "object" ? r.decorations : {}
    ) as ProviderWire;
    const c = (
      r.command && typeof r.command === "object" ? r.command : null
    ) as ProviderWire | null;
    const command =
      c && typeof c.command === "string" && context.ownCommand(c.command)
        ? { id: c.command, ...(c.input !== undefined && { input: c.input }) }
        : undefined;
    const letter = str(d.letter, 2);
    return [
      {
        path,
        ...(letter && { letter }),
        ...(typeof d.tooltip === "string" && d.tooltip && { tooltip: d.tooltip.slice(0, 500) }),
        ...(d.strikeThrough === true && { strikeThrough: true }),
        ...(d.faded === true && { faded: true }),
        ...(SCM_TONES.includes(d.tone as ScmTone) && { tone: d.tone as ScmTone }),
        ...(command && { command }),
      },
    ];
  };
  let total = 0;
  const groups: ScmGroup[] = [];
  for (const raw of (Array.isArray(wire.groups) ? wire.groups : []).slice(0, MAX_GROUPS)) {
    const id = str(raw?.id, 60);
    if (!id || groups.some((g) => g.id === id)) continue;
    const list = (Array.isArray(raw.resources) ? raw.resources : []).slice(
      0,
      MAX_RESOURCES - total,
    );
    const resources = list.flatMap(resource);
    total += resources.length;
    groups.push({
      id,
      label: str(raw.label, 100) || id,
      hideWhenEmpty: raw.hideWhenEmpty === true,
      resources,
    });
  }
  const accept =
    wire.accept &&
    typeof wire.accept.command === "string" &&
    context.ownCommand(wire.accept.command)
      ? {
          id: wire.accept.command,
          title: str(wire.accept.title, 40) || "Accept",
          ...(wire.accept.input !== undefined && { input: wire.accept.input }),
        }
      : null;
  return {
    groups,
    input: {
      value: str(wire.input?.value, 100_000),
      placeholder: str(wire.input?.placeholder, 200),
      visible: wire.input?.visible !== false,
    },
    count:
      typeof wire.count === "number" && Number.isFinite(wire.count)
        ? Math.max(0, Math.min(1_000_000, Math.trunc(wire.count)))
        : null,
    accept,
  };
}

/** The theme color (a token) of a resource's tone. */
export const TONE_COLORS: Record<ScmTone, string> = {
  added: "--diff-added-fg",
  renamed: "--diff-added-fg",
  untracked: "--diff-added-fg",
  modified: "--git-modified-fg",
  deleted: "--diff-removed-fg",
  conflict: "--status-warning-fg",
  ignored: "--fg-subtle",
};

/** The section's rows: groups (that show) at the top, their resources under them. */
export function scmRows(
  entry: Pick<ScmProviderEntry, "key" | "rootPath" | "state">,
  parent: HostTreeItem | undefined,
): HostTreeItem[] {
  const state = entry.state.peek();
  if (!parent)
    return state.groups
      .filter((g) => g.resources.length || !g.hideWhenEmpty)
      .map((g) => ({
        id: `g:${g.id}`,
        label: g.label,
        description: String(g.resources.length),
        collapsible: true,
      }));
  const groupId = parent.id.slice(2);
  const group = state.groups.find((g) => g.id === groupId);
  return (group?.resources ?? []).map((r: ScmResource, index) => {
    const isUri = uriScheme(r.path) !== null;
    const dir = isUri ? dirname(r.path.slice(r.path.indexOf(":") + 1)) : dirname(r.path);
    const shown = entry.rootPath && !isUri ? relativePath(entry.rootPath, dir) : dir;
    return {
      id: `r:${groupId}:${index}`,
      label: basename(r.path),
      ...(shown && shown !== "." && shown !== "/" && { description: shown }),
      ...(r.tooltip && { tooltip: r.tooltip }),
      icon: "file",
      ...(r.letter && { badge: r.letter }),
      ...(r.tone && { badgeColor: TONE_COLORS[r.tone] }),
      ...(r.strikeThrough && { struck: true }),
      ...(r.faded && { faded: true }),
      command: {
        id: "extensions.scmOpenResource",
        input: { key: entry.key, group: groupId, index },
      },
    };
  });
}

// ---- Debug adapters ----------------------------------------------------------------------------

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * What the factory answered, checked: the executable's program and arguments, a local port, or
 * an inline adapter. Throws with what's wrong.
 */
export function checkDescriptor(
  raw: unknown,
): Exclude<DebugAdapterDescriptor, { kind: "inline" }> | { kind: "inline" } {
  const d = (raw && typeof raw === "object" ? raw : {}) as ProviderWire;
  if (d.kind === "inline") return { kind: "inline" };
  if (d.kind === "server") {
    const port = typeof d.port === "number" ? Math.trunc(d.port) : 0;
    if (port < 1 || port > 65535) throw new Error("A server adapter needs a port (1-65535).");
    const host = typeof d.host === "string" && d.host ? d.host : "127.0.0.1";
    if (!LOCAL_HOSTS.has(host)) throw new Error("A server adapter listens on this computer only.");
    return { kind: "server", port, host };
  }
  if (d.kind === "executable") {
    const command = typeof d.command === "string" ? d.command.trim() : "";
    if (!command || command.length > 1000)
      throw new Error("An executable adapter needs a command.");
    const args = Array.isArray(d.args) ? d.args : [];
    if (args.length > 500 || !args.every((a) => typeof a === "string"))
      throw new Error("args must be a list of strings.");
    const env = checkEnv(d.env);
    return {
      kind: "executable",
      command,
      args: args as string[],
      ...(typeof d.cwd === "string" && { cwd: d.cwd }),
      ...(env && { env }),
    };
  }
  throw new Error('A debug adapter descriptor\'s kind is "executable", "server" or "inline".');
}

/** At most this many configurations per provider join "Add configuration…". */
const MAX_PROVIDED_CONFIGURATIONS = 20;

/**
 * What a provider's provideDebugConfigurations answered, as "Add configuration…" entries: objects
 * with a `name`, of the provider's own type (forced), `request` "launch" unless it says "attach";
 * at most 20, each under 20 000 characters of JSON. Others are dropped.
 */
export function checkProvidedConfigurations(
  raw: unknown,
  type: string,
  from: string,
): { label: string; description: string; body: Record<string, unknown> }[] {
  if (!Array.isArray(raw)) return [];
  const out: { label: string; description: string; body: Record<string, unknown> }[] = [];
  for (const item of raw) {
    if (out.length >= MAX_PROVIDED_CONFIGURATIONS) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const c = item as Record<string, unknown>;
    const name = typeof c.name === "string" ? c.name.trim().slice(0, 200) : "";
    if (!name) continue;
    const body: Record<string, unknown> = {
      ...c,
      name,
      type,
      request: c.request === "attach" ? "attach" : "launch",
    };
    const json = JSON.stringify(body);
    if (json === undefined || json.length > 20_000) continue;
    out.push({ label: name, description: from, body });
  }
  return out;
}

// ---- Authentication ----------------------------------------------------------------------------

/** A session from an extension, checked (null when it isn't one). */
export function checkSession(raw: unknown): AuthSession | null {
  const s = (raw && typeof raw === "object" ? raw : {}) as ProviderWire;
  const account = (s.account && typeof s.account === "object" ? s.account : {}) as ProviderWire;
  if (typeof s.id !== "string" || !s.id || s.id.length > 200) return null;
  if (typeof s.accessToken !== "string" || s.accessToken.length > 64 * 1024) return null;
  const accountId = typeof account.id === "string" ? account.id.slice(0, 200) : "";
  const label = typeof account.label === "string" ? account.label.slice(0, 200) : "";
  if (!accountId && !label) return null;
  return {
    id: s.id,
    accessToken: s.accessToken,
    account: { id: accountId || label, label: label || accountId },
    scopes: (Array.isArray(s.scopes) ? s.scopes : [])
      .filter((x): x is string => typeof x === "string")
      .slice(0, 50),
  };
}

/**
 * What getSession does for a requester: hand over a session, ask the user about one, sign in
 * (asking first when it's another extension's provider), or answer nothing.
 */
export function sessionDecision(
  options: {
    mine: boolean;
    silent: boolean;
    createIfNone: boolean;
    forceNewSession: boolean;
  },
  session: AuthSession | undefined,
  allowed: (session: AuthSession) => boolean,
): "give" | "ask" | "signIn" | "askSignIn" | "none" {
  if (session && !options.forceNewSession) {
    if (options.mine || allowed(session)) return "give";
    return options.silent ? "none" : "ask";
  }
  if (!(options.createIfNone || options.forceNewSession) || options.silent) return "none";
  return options.mine ? "signIn" : "askSignIn";
}

// ---- File systems ------------------------------------------------------------------------------

/** Schemes the IDE uses itself (or the web does): never an extension's. */
const RESERVED_SCHEMES = new Set([
  "file",
  "http",
  "https",
  "ws",
  "wss",
  "data",
  "blob",
  "about",
  "javascript",
  "mailto",
  "untitled",
  "virtual",
  "ghpr",
  "quickdiffbase",
  "testexpected",
  "testactual",
  "notebook",
  "notebook-cell",
  "vscode",
  "ide",
  "output",
  "search",
  "tauri",
  "asset",
  "ipc",
]);

/**
 * A path part that is a `.git` folder: also as Windows opens it, `.git.` / `.git ` (trailing dots
 * and spaces dropped) and by its short name `GIT~1` (D261: extensions can't write there).
 */
export function isGitFolderName(part: string): boolean {
  const name = part.replace(/[. ]+$/, "").toLowerCase();
  return name === ".git" || /^git~\d+$/.test(name);
}

/** Whether `scheme` may be an extension's ("" when it may, else why not). */
export function schemeProblem(scheme: string): string {
  if (!/^[a-z_][a-z0-9_+.-]{1,30}$/.test(scheme))
    return "a scheme is 2-31 lower-case letters, digits, _ + . -, starting with a letter or _";
  if (RESERVED_SCHEMES.has(scheme) || scheme.startsWith("agent") || scheme.startsWith("git"))
    return `"${scheme}" is the IDE's own`;
  return "";
}

// ---- ide.env and findFiles (D234, runtimeEnv.ts) ----

/** Whether `url` is a web address an extension may open (no file:, javascript: or app links). */
export function openableUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:";
  } catch {
    return false;
  }
}

/** The index's relative paths that match `include` and not `exclude`, at most `max`. */
export function matchFiles(
  paths: readonly string[],
  include: string,
  exclude: string | undefined,
  max: number,
): string[] {
  const inc = globToRegExp(include || "**");
  const exc = exclude ? globToRegExp(exclude) : null;
  const out: string[] = [];
  for (const p of paths) {
    if (!inc.test(p) || exc?.test(p)) continue;
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

/** A file index entry: relative to the first folder, or (D251) to its `root` for other folders. */
export interface WorkspaceIndexItem {
  path: string;
  root?: string;
}

/**
 * findFiles over every folder (D251): absolute paths of the index's files whose path relative to
 * their folder matches `include` (or, for a RelativePattern, relative to its base) and not
 * `exclude` (relative to their folder), at most `max`. With one folder it's `matchFiles` joined
 * to the folder, as it always was.
 */
export function matchWorkspaceFiles(
  items: readonly WorkspaceIndexItem[],
  primary: string,
  include: string | { base: string; pattern: string },
  exclude: string | undefined,
  max: number,
): string[] {
  const relative = typeof include !== "string";
  const inc = globToRegExp((relative ? include.pattern : include) || "**");
  const exc = exclude ? globToRegExp(exclude) : null;
  const out: string[] = [];
  for (const item of items) {
    const full = joinPath(item.root ?? primary, item.path);
    const tested = relative ? relativeTo(include.base, full) : item.path;
    if (tested === null || !inc.test(tested) || exc?.test(item.path)) continue;
    out.push(full);
    if (out.length >= max) break;
  }
  return out;
}

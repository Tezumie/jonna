// What extensions plug into the workbench's own features (D233), beside the language providers
// of extensionFeatures.ts: terminals they made, task providers (the tasks extension's list),
// source controls (the Source control view), debug adapters (the debug extension's launch),
// authentication providers and file systems for a URI scheme (the editor and the explorer).
// The extensions host fills these; each feature reads them, so neither imports the other. Every
// entry has an owner (the extension's id): stopping it removes what it added. DOM-free and
// unit-tested.
import { Emitter, type Event } from "../core/events/index";
import type { RunSpec } from "../core/ipc/process";
import type { Disposable } from "../core/lifecycle/index";
import { toDisposable } from "../core/lifecycle/index";
import type { Transport } from "../core/lsp/jsonrpc";
import { type Signal, signal } from "../core/reactive/index";
import type { TaskPresentation } from "./services";
import type { SavedPanel } from "./webviewPanelRestore";

/** A signal list of owned entries; `add` returns what takes the entry out again. */
/** A webview panel an extension's code opened (`ide.ui.createWebviewPanel`), for state. */
export interface WebviewPanelEntry {
  owner: string;
  id: string;
  viewType: string;
  title(): string;
  tabId(): string | null;
  /** What's saved to bring it back after a restart; null: it can't come back (no serializer). */
  saved?(): SavedPanel | null;
}

export class OwnedList<T extends { owner: string }> {
  readonly all: Signal<readonly T[]> = signal<readonly T[]>([]);

  add(entry: T): Disposable {
    this.all.value = [...this.all.peek(), entry];
    return toDisposable(() => {
      this.all.value = this.all.peek().filter((x) => x !== entry);
    });
  }

  of(owner: string): T[] {
    return this.all.peek().filter((x) => x.owner === owner);
  }
}

/** Waits at most `ms` for an extension's answer (a slow one mustn't hold the whole list). */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} didn't answer within ${ms / 1000} s.`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// ---- Terminals -------------------------------------------------------------------------------

/** A terminal an extension made (ide.terminals.create). */
export interface ContributedTerminal {
  owner: string;
  /** The extension's handle id. */
  id: string;
  name: string;
  kind: "pseudoterminal" | "shell";
}

// ---- Tasks -----------------------------------------------------------------------------------

/** A task an extension provides, already checked by the host (the tasks extension fills in the rest). */
export interface ContributedTask {
  owner: string;
  /** "<type>: <name>", as VS Code lists provided tasks. */
  label: string;
  /** Where it came from: the extension's name. */
  source: string;
  detail?: string;
  /** What the terminal runs; a custom execution's spec names its pseudoterminal (`virtual`). */
  spec: RunSpec;
  /** The command line shown. */
  command: string;
  cwd?: string;
  group?: { kind: string; isDefault: boolean };
  background: boolean;
  problemMatcher?: unknown;
  presentation?: Partial<TaskPresentation>;
}

export interface TaskProviderEntry {
  owner: string;
  /** The task type it provides (declared in the manifest's `taskDefinitions`). */
  type: string;
  provide(): Promise<ContributedTask[]>;
  /** A tasks.json entry of its type, made runnable (VS Code's resolveTask); null to drop it. */
  resolve?(definition: Record<string, unknown>): Promise<ContributedTask | null>;
}

/** How long one provider may take to list its tasks. */
const PROVIDE_MS = 10_000;

export class TaskProviderRegistry extends OwnedList<TaskProviderEntry> {
  /**
   * Every provider's tasks, then the tasks.json entries (`taskFiles`: each file's parsed JSON)
   * of a provided type, resolved by their provider. A provider that fails or is slow is skipped.
   * `onError` hears why.
   */
  async tasks(
    taskFiles: readonly unknown[] = [],
    onError: (message: string) => void = () => {},
  ): Promise<ContributedTask[]> {
    const providers = this.all.peek();
    if (!providers.length) return [];
    const out: ContributedTask[] = [];
    const lists = await Promise.all(
      providers.map((p) =>
        withTimeout(p.provide(), PROVIDE_MS, `The ${p.type} task provider`).catch(
          (err: unknown) => {
            onError(err instanceof Error ? err.message : String(err));
            return [];
          },
        ),
      ),
    );
    for (const list of lists) out.push(...list);
    for (const entry of tasksJsonEntries(taskFiles)) {
      const provider = providers.find((p) => p.type === entry.type && p.resolve);
      if (!provider?.resolve) continue;
      const resolved = await withTimeout(
        provider.resolve(entry),
        PROVIDE_MS,
        `The ${provider.type} task provider`,
      ).catch((err: unknown) => {
        onError(err instanceof Error ? err.message : String(err));
        return null;
      });
      if (!resolved) continue;
      // The tasks.json entry's own label and group win (the user wrote them).
      const label = typeof entry.label === "string" && entry.label ? entry.label : resolved.label;
      out.push({ ...resolved, label });
    }
    return out;
  }
}

/** tasks.json entries (from each file's parsed JSON) that have a `type` string. */
export function tasksJsonEntries(
  files: readonly unknown[],
): (Record<string, unknown> & { type: string })[] {
  const out: (Record<string, unknown> & { type: string })[] = [];
  for (const file of files) {
    const tasks =
      file && typeof file === "object" ? (file as { tasks?: unknown }).tasks : undefined;
    if (!Array.isArray(tasks)) continue;
    for (const t of tasks)
      if (t && typeof t === "object" && typeof (t as { type?: unknown }).type === "string")
        out.push(t as Record<string, unknown> & { type: string });
  }
  return out;
}

// ---- Source control --------------------------------------------------------------------------

/** How a resource's letter is colored (the theme's git colors). */
export type ScmTone =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "conflict"
  | "untracked"
  | "ignored";

export const SCM_TONES: readonly ScmTone[] = [
  "added",
  "modified",
  "deleted",
  "renamed",
  "conflict",
  "untracked",
  "ignored",
];

/** VS Code's SourceControlResourceState. */
export interface ScmResource {
  /** Absolute (in the open folder) or a URI of a registered file system. */
  path: string;
  /** One or two characters after the name ("M", "A"). */
  letter?: string;
  tooltip?: string;
  strikeThrough?: boolean;
  faded?: boolean;
  tone?: ScmTone;
  /** The extension's own command, run on click with `input` (default: the file opens). */
  command?: { id: string; input?: unknown };
}

export interface ScmGroup {
  id: string;
  label: string;
  /** Left out while it has no resources. */
  hideWhenEmpty: boolean;
  resources: readonly ScmResource[];
}

export interface ScmState {
  groups: readonly ScmGroup[];
  input: { value: string; placeholder: string; visible: boolean };
  /** The badge's count (VS Code's `count`); null: the resources are counted. */
  count: number | null;
  /** What the commit button and Ctrl+Enter run (VS Code's acceptInputCommand). */
  accept: { id: string; title: string; input?: unknown } | null;
}

export interface ScmProviderEntry {
  owner: string;
  /** Unique: "<owner>/<its id>". */
  key: string;
  label: string;
  /** Its folder, when it has one (quick diff asks only about files under it). */
  rootPath: string | null;
  state: Signal<ScmState>;
  /** The user typed in the input box. */
  setInput(value: string): void;
  accept(): Promise<void>;
  /** A resource was clicked. */
  open(resource: ScmResource): Promise<void>;
  /** VS Code's quickDiffProvider: the original text of `path`, null when it has none. */
  original?(path: string): Promise<string | null>;
}

export const EMPTY_SCM_STATE: ScmState = {
  groups: [],
  input: { value: "", placeholder: "", visible: true },
  count: null,
  accept: null,
};

/** The badge count of a provider: its own count, else every resource. */
export function scmCount(state: ScmState): number {
  if (state.count !== null) return Math.max(0, state.count);
  return state.groups.reduce((n, g) => n + g.resources.length, 0);
}

export class SourceControlRegistry extends OwnedList<ScmProviderEntry> {
  /** Everything pending across extensions' source controls (the activity badge adds it). */
  count(): number {
    return this.all.value.reduce((n, p) => n + scmCount(p.state.value), 0);
  }

  /** The original text from the first provider that has one for `path` (quick diff). */
  async original(
    path: string,
    within: (root: string, path: string) => boolean,
  ): Promise<string | null> {
    for (const p of this.all.peek()) {
      if (!p.original || (p.rootPath && !within(p.rootPath, path))) continue;
      const text = await p.original(path).catch(() => null);
      if (text !== null) return text;
    }
    return null;
  }
}

// ---- Debug adapters --------------------------------------------------------------------------

/** A connection to an extension's debug adapter (DAP bodies without framing). */
export interface DebugAdapterConnection {
  transport: Transport;
  kill(): Promise<void>;
}

export interface DebugAdapterEntry {
  owner: string;
  /** The launch configuration `type` it debugs (declared in the manifest's `debuggers`). */
  type: string;
  label: string;
  /**
   * Starts (or connects to) the adapter for one session; `exited` when it goes away. `session`:
   * the debugger's own session (its id is the one `debug.customRequest` and the session events
   * use, so the extension's DebugSession is the same object everywhere).
   */
  connect(
    configuration: Record<string, unknown>,
    exited: () => void,
    session?: DebugAdapterSessionInfo,
  ): Promise<DebugAdapterConnection>;
  /** "Add configuration…" entries (the manifest's `configurationSnippets`). */
  snippets: readonly { label: string; description: string; body: Record<string, unknown> }[];
  /**
   * Starts the extension and waits for its adapter: false when it doesn't supply one (a type the
   * IDE debugs itself then runs on the built-in adapter).
   */
  ready?(): Promise<boolean>;
  /**
   * More entries its code provides when "Add configuration…" asks (VS Code's
   * provideDebugConfigurations); none while it has no provider. `folder`: the open folder.
   */
  provideConfigurations?(
    folder: string | null,
  ): Promise<{ label: string; description: string; body: Record<string, unknown> }[]>;
}

/** The session an extension's adapter is started for. */
export interface DebugAdapterSessionInfo {
  id: string;
  name: string;
  /** The session it was started under (a child process, a DAP startDebugging). */
  parentId?: string;
}

/** A configuration resolver step (VS Code's DebugConfigurationProvider resolve methods). */
export type DebugConfigResolver = (
  folder: string | null,
  configuration: Record<string, unknown>,
) => Promise<unknown>;

/**
 * One extension's part in starting a debug session, whatever debugger runs it (VS Code's
 * activateDebuggers and configuration providers): its activation on the debug events, and the
 * resolve steps of the configuration providers its code registered.
 */
export interface DebugResolverEntry {
  owner: string;
  /** Starts the extension when its activation events include `event`; resolves once it ran. */
  activate(event: string): Promise<void>;
  /**
   * Its providers' steps for exactly `type` ("*" for those registered for every type), in the
   * order they were registered: "resolve" (resolveDebugConfiguration, variables not filled in
   * yet) or "substituted" (resolveDebugConfigurationWithSubstitutedVariables).
   */
  resolvers(step: "resolve" | "substituted", type: string): DebugConfigResolver[];
}

export class DebugResolverRegistry extends OwnedList<DebugResolverEntry> {
  /**
   * VS Code's activateDebuggers(event, type): `event`, "onDebug" and `event:type`, every
   * extension that has one of them, awaited together.
   */
  async activate(event: string, type?: string): Promise<void> {
    const events = [event, "onDebug", ...(type ? [`${event}:${type}`] : [])];
    await Promise.all(
      this.all.peek().flatMap((e) => events.map((ev) => e.activate(ev).catch(() => undefined))),
    );
  }

  /** Every extension's resolvers of `step` for `type`, in the extensions' order. */
  resolvers(step: "resolve" | "substituted", type: string): DebugConfigResolver[] {
    return this.all.peek().flatMap((e) => e.resolvers(step, type));
  }
}

export class DebugAdapterRegistry extends OwnedList<DebugAdapterEntry> {
  /** The newest adapter for `type` (an extension's own registration wins over its placeholder). */
  get(type: string): DebugAdapterEntry | undefined {
    const all = this.all.peek();
    for (let i = all.length - 1; i >= 0; i--) if (all[i]?.type === type) return all[i];
    return undefined;
  }
}

// ---- Authentication --------------------------------------------------------------------------

/** VS Code's AuthenticationSession. */
export interface AuthSession {
  id: string;
  accessToken: string;
  account: { id: string; label: string };
  scopes: readonly string[];
}

export interface AuthProviderEntry {
  owner: string;
  /** Unique among providers ("github-enterprise"). */
  id: string;
  label: string;
  supportsMultipleAccounts: boolean;
  /** The signed-in sessions (with `scopes`: those that have them all). */
  sessions(scopes?: readonly string[]): Promise<AuthSession[]>;
  /** Signs in (the provider asks the user however it does). */
  createSession(scopes: readonly string[]): Promise<AuthSession>;
  removeSession(sessionId: string): Promise<void>;
  /** Fires when its sessions change (a sign-in elsewhere, a token refreshed). */
  onDidChange: Event<void>;
}

export class AuthProviderRegistry extends OwnedList<AuthProviderEntry> {
  get(id: string): AuthProviderEntry | undefined {
    return this.all.peek().find((p) => p.id === id);
  }
}

/** Whether `session` has every scope asked for (order doesn't matter). */
export function hasScopes(session: AuthSession, scopes: readonly string[]): boolean {
  return scopes.every((s) => session.scopes.includes(s));
}

// ---- File systems ----------------------------------------------------------------------------

export interface FileSystemStat {
  kind: "file" | "dir";
  size: number;
  mtimeMs: number;
  readonly: boolean;
}

export interface FileSystemChange {
  path: string;
  kind: "created" | "changed" | "deleted";
}

/** VS Code's FileSystemProvider for one scheme; paths are `<scheme>:/a/b`. */
export interface FileSystemEntry {
  owner: string;
  scheme: string;
  /** The explorer section's title. */
  label: string;
  readonly: boolean;
  stat(path: string): Promise<FileSystemStat>;
  readDirectory(path: string): Promise<{ name: string; kind: "file" | "dir" }[]>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  createDirectory(path: string): Promise<void>;
  delete(path: string, recursive: boolean): Promise<void>;
  rename(from: string, to: string, overwrite: boolean): Promise<void>;
  /** Changes it reports (its own `watch`), already for paths of its scheme. */
  onDidChange: Event<readonly FileSystemChange[]>;
}

/** `scheme:/…` with a scheme of 2-31 characters (a Windows drive, "C:", is never one). */
const URI = /^([a-z_][a-z0-9_+.-]{1,30}):\/(?!\/)/i;

/** The scheme of a `scheme:/path` string, lower-case; null for file paths. */
export function uriScheme(path: string): string | null {
  const m = URI.exec(path);
  return m?.[1] ? m[1].toLowerCase() : null;
}

/** The path part of a URI ("/a/b"), normalized: no ".", "..", doubled or trailing slashes. */
export function uriPath(uri: string): string {
  const scheme = uriScheme(uri);
  const rest = scheme ? uri.slice(scheme.length + 1) : uri;
  const parts: string[] = [];
  for (const part of rest.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** `scheme:/path`, normalized. */
export function makeUri(scheme: string, path: string): string {
  return `${scheme}:${uriPath(path)}`;
}

/** The URI of `name` inside folder `uri`. */
export function childUri(uri: string, name: string): string {
  const scheme = uriScheme(uri) ?? "";
  const base = uriPath(uri);
  return `${scheme}:${base === "/" ? "" : base}/${name}`;
}

/** The folder of a URI ("memfs:/a/b.txt" → "memfs:/a"; the root is its own). */
export function parentUri(uri: string): string {
  const scheme = uriScheme(uri) ?? "";
  const path = uriPath(uri);
  const at = path.lastIndexOf("/");
  return `${scheme}:${at <= 0 ? "/" : path.slice(0, at)}`;
}

/** Why `name` can't be a file name in a provider's folder (a name, never a path), or null. */
export function fileNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Give a name.";
  if (trimmed === "." || trimmed === "..") return `"${trimmed}" isn't a name.`;
  if (/[\\/]/.test(trimmed)) return "A name can't contain / or \\.";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what's refused
  if (/[\u0000-\u001f]/.test(trimmed)) return "A name can't contain control characters.";
  if (trimmed.length > 255) return "The name is too long.";
  return null;
}

export class FileSystemRegistry extends OwnedList<FileSystemEntry> {
  private readonly changes = new Emitter<readonly FileSystemChange[]>();
  /** Every provider's reported changes (open editors reload, D234). */
  readonly onDidChangeFiles: Event<readonly FileSystemChange[]> = this.changes.event;
  private readonly wanted = new Emitter<string>();
  /**
   * A scheme nobody serves yet was asked for (a restored tab of "memfs:/a.txt"): extensions that
   * activate on `onFileSystem:<scheme>` start (D234).
   */
  readonly onWillNeedScheme: Event<string> = this.wanted.event;

  /** The provider serving `path`, when it's a URI of a registered scheme. */
  get(path: string): FileSystemEntry | undefined {
    const scheme = uriScheme(path);
    return scheme ? this.all.peek().find((p) => p.scheme === scheme) : undefined;
  }

  /** Whether `path` is served by an extension's file system. */
  owns(path: string): boolean {
    return this.get(path) !== undefined;
  }

  /** A provider reported changes (already checked to be of its scheme). */
  fireChanges(changes: readonly FileSystemChange[]): void {
    if (changes.length) this.changes.fire(changes);
  }

  /**
   * The provider of `path`'s scheme, waiting up to `ms` for an extension to register it (asking
   * the ones that activate on `onFileSystem:<scheme>` to start); undefined if none does.
   */
  async whenServed(path: string, ms: number): Promise<FileSystemEntry | undefined> {
    const scheme = uriScheme(path);
    if (!scheme) return undefined;
    const now = this.get(path);
    if (now) return now;
    const deadline = Date.now() + ms;
    for (let tick = 0; Date.now() < deadline; tick++) {
      // Asked again each second: extensions still loading (tabs are restored first) hear it too.
      if (tick % 10 === 0) this.wanted.fire(scheme);
      await new Promise((r) => setTimeout(r, 100));
      const found = this.get(path);
      if (found) return found;
    }
    return undefined;
  }
}

/**
 * The window's one file-system registry: the editor's file service reads it without the
 * workbench services (ExtensionFeatures holds the same object).
 */
export const fileSystems = new FileSystemRegistry();

/**
 * One extension's debug adapter tracker for a session (D258, VS Code's DebugAdapterTracker):
 * told every DAP message the IDE sends the adapter and every one the adapter sends, then the end.
 */
export interface DebugTrackerHandle {
  willReceive(message: unknown): void;
  didSend(message: unknown): void;
  willStop(): void;
  exit(code?: number): void;
}

export interface DebugTrackerEntry {
  owner: string;
  /** A debug type, or "*" for every session. */
  type: string;
  create(session: { id: string; type: string; name: string }): Promise<DebugTrackerHandle | null>;
}

export class DebugTrackerRegistry extends OwnedList<DebugTrackerEntry> {
  /** The trackers for a starting session (an extension that fails is left out). */
  async start(session: { id: string; type: string; name: string }): Promise<DebugTrackerHandle[]> {
    const entries = this.all.peek().filter((e) => e.type === "*" || e.type === session.type);
    const handles = await Promise.all(
      entries.map((e) => withTimeout(e.create(session), 3000, e.owner).catch(() => null)),
    );
    return handles.filter((h): h is DebugTrackerHandle => h !== null);
  }
}

/** A DAP transport whose messages the trackers see (parsed once, sent on as they were). */
export function trackedTransport(
  transport: Transport & { close?(): void },
  trackers: readonly DebugTrackerHandle[],
): Transport & { close?(): void } {
  if (!trackers.length) return transport;
  const parse = (body: string): unknown => {
    try {
      return JSON.parse(body);
    } catch {
      return undefined;
    }
  };
  const received = new Emitter<string>();
  transport.onMessage((body) => {
    const message = parse(body);
    if (message !== undefined) for (const t of trackers) t.didSend(message);
    received.fire(body);
  });
  return {
    send: (body) => {
      const message = parse(body);
      if (message !== undefined) for (const t of trackers) t.willReceive(message);
      transport.send(body);
    },
    onMessage: received.event,
    ...(transport.close && {
      close: () => {
        for (const t of trackers) t.willStop();
        transport.close?.();
      },
    }),
  };
}

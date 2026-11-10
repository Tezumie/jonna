// The worker side of `ide.scm` and `ide.debug` (D233). A source control (VS Code's
// `scm.createSourceControl`): resource groups of resource states, an input box, an accept
// command, a count and quick diff's original texts; its changes reach the host as one snapshot
// per tick. Debug adapters (VS Code's DebugAdapterDescriptorFactory): an executable, a server
// port, or an adapter the extension runs itself (inline), whose DAP messages cross the RPC. The
// host calls back through "provider" calls. DOM-free, unit-tested.
import type { Disposable } from "./rpc";
import type { OnCall, Request } from "./rpcTerminals";

type Answer<T> = T | null | undefined | Promise<T | null | undefined>;

export interface ResourceDecorations {
  /** One or two characters after the name ("M"). */
  letter?: string;
  tooltip?: string;
  strikeThrough?: boolean;
  faded?: boolean;
  /** The theme's color for it. */
  tone?: "added" | "modified" | "deleted" | "renamed" | "conflict" | "untracked" | "ignored";
}

/** VS Code's SourceControlResourceState. */
export interface ResourceState {
  /** A file in the open folder (relative or absolute), or a URI of the extension's file system. */
  path: string;
  decorations?: ResourceDecorations;
  /** One of the extension's commands, run on click (default: the file opens). */
  command?: { command: string; input?: unknown };
}

export interface SourceControlResourceGroup {
  readonly id: string;
  label: string;
  hideWhenEmpty: boolean;
  resourceStates: ResourceState[];
  dispose(): void;
}

export interface SourceControlInputBox {
  value: string;
  placeholder: string;
  visible: boolean;
  /** The user typed in it. */
  onDidChange(listener: (value: string) => void): Disposable;
}

export interface SourceControl {
  readonly id: string;
  readonly label: string;
  readonly inputBox: SourceControlInputBox;
  /** The badge's number (default: every resource). */
  count: number | undefined;
  /** What the commit button runs: one of the extension's commands, with `input` (default { value }). */
  acceptInputCommand: { command: string; title?: string; input?: unknown } | undefined;
  /** The text a file is compared with in the editor's change bars. */
  quickDiffProvider: { provideOriginal(path: string): Answer<string> } | undefined;
  createResourceGroup(id: string, label: string): SourceControlResourceGroup;
  dispose(): void;
}

export interface ScmApi {
  createSourceControl(options: { id: string; label: string; rootPath?: string }): SourceControl;
}

/** A DAP message (request, response or event) as an object. */
/** VS Code's DebugAdapterTracker (D258): every method optional. */
export interface DebugAdapterTracker {
  onWillStartSession?(): void;
  onWillReceiveMessage?(message: unknown): void;
  onDidSendMessage?(message: unknown): void;
  onWillStopSession?(): void;
  onError?(error: Error): void;
  onExit?(code: number | undefined, signal: string | undefined): void;
}

export type DapMessage = Record<string, unknown>;

/** An adapter the extension runs in its worker (VS Code's DebugAdapterInlineImplementation). */
export interface InlineDebugAdapter {
  handleMessage(message: DapMessage): void;
  dispose?(): void;
}

export type DebugAdapterDescriptor =
  | {
      kind: "executable";
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
    }
  /** An adapter already listening on this computer. */
  | { kind: "server"; port: number; host?: string }
  /** `start` gets `send` (messages to the IDE) and returns the adapter. */
  | { kind: "inline"; start(send: (message: DapMessage) => void): InlineDebugAdapter };

export interface DebugSessionInfo {
  id: string;
  type: string;
  name: string;
  configuration: Record<string, unknown>;
  /** The session it runs under (D295). */
  parentSession?: string;
}

export interface DebugAdapterDescriptorFactory {
  createDebugAdapterDescriptor(session: DebugSessionInfo): Answer<DebugAdapterDescriptor>;
}

/** VS Code's DebugConfigurationProvider: its resolve step (D234) and its starter configurations. */
export interface DebugConfigurationProvider {
  /**
   * The configuration about to start, before its adapter is asked: return it with defaults filled
   * in or changed, or null / undefined to cancel the launch. Without it the configuration starts
   * as written.
   */
  resolveDebugConfiguration?(
    configuration: Record<string, unknown>,
    folder?: string | null,
  ): Answer<Record<string, unknown>>;
  /**
   * VS Code's second step (D295): the configuration with its variables filled in, after the
   * preLaunchTask ran; null / undefined cancels the launch.
   */
  resolveDebugConfigurationWithSubstitutedVariables?(
    configuration: Record<string, unknown>,
    folder?: string | null,
  ): Answer<Record<string, unknown>>;
  /**
   * Configurations to offer in "Add configuration…" (VS Code's provideDebugConfigurations):
   * each needs `name`; its `type` is yours. `folder` is the open folder.
   */
  provideDebugConfigurations?(folder: string | null): Answer<Record<string, unknown>[]>;
}

/**
 * When a provider's configurations are asked for (VS Code's DebugConfigurationProviderTriggerKind):
 * "initial" (default) when a launch.json is written or added to ("Add configuration…"), "dynamic"
 * as well when the user picks a configuration to start without one in launch.json.
 */
export type DebugConfigurationProviderTriggerKind = "initial" | "dynamic";

/** A breakpoint as the debugger has it (ide://debug's breakpoints). */
export interface DebugBreakpoint {
  id: number;
  /** "line" (in a file), "function" or "data". */
  kind?: string;
  /** Workspace-relative (line breakpoints). */
  path?: string;
  line?: number;
  enabled?: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  verified?: boolean;
}

/** A debug session (VS Code's DebugSession, without its methods: ide.debug has them). */
export interface DebugSessionSummary {
  id: string;
  name: string;
  type: string;
  /** Its configuration as resolved (D295; in session events). */
  configuration?: Record<string, unknown>;
  /** The id of the session it runs under. */
  parentSession?: string;
  /** Its configuration's folder. */
  workspaceFolder?: string;
}

/** VS Code's DebugSessionOptions, as the IDE takes them. */
export interface DebugStartOptions {
  /** The id of the session to start under (its child in the call stack, ended with it). */
  parentSession?: string;
  /** VS Code's lifecycleManagedByParent: restarted and stopped with its parent. */
  lifecycleManagedByParent?: boolean;
  /** "separate" (default) or "mergeWithParent": its output in the parent's console. */
  consoleMode?: "separate" | "mergeWithParent";
  noDebug?: boolean;
  suppressDebugToolbar?: boolean;
  suppressDebugStatusbar?: boolean;
  suppressDebugView?: boolean;
  suppressSaveBeforeStart?: boolean;
  /** The folder a configuration name is looked up in. */
  folder?: string;
}

/** A function breakpoint (ide://debug's functionBreakpoints). */
export interface DebugFunctionBreakpoint {
  name: string;
  enabled: boolean;
  condition?: string;
  hitCondition?: string;
}

/** The thread or frame in focus (VS Code's activeStackItem). */
export interface DebugStackItem {
  session: DebugSessionSummary;
  threadId: number;
  /** Set for a frame (while stopped). */
  frameId?: number;
}

export interface DebugApi {
  // ---- D255: VS Code's breakpoints and session API ----
  /** Every breakpoint ("fs.read"). */
  breakpoints(): Promise<DebugBreakpoint[]>;
  /** Adds line breakpoints (or replaces one at the same line); "fs.write". */
  addBreakpoints(
    list: {
      path: string;
      line: number;
      condition?: string;
      hitCondition?: string;
      logMessage?: string;
      /** False: added disabled. */
      enabled?: boolean;
    }[],
  ): Promise<void>;
  /** Removes breakpoints by id ("fs.write"). */
  removeBreakpoints(ids: number[]): Promise<void>;
  /** The focused session, or null ("fs.read"). */
  activeDebugSession(): Promise<DebugSessionSummary | null>;
  /** Every running session ("fs.read"). */
  debugSessions(): Promise<DebugSessionSummary[]>;
  /**
   * Starts a launch.json configuration by name, or a whole configuration ("shell", trusted
   * folder): VS Code's startDebugging. Resolves with the new session's id (none: a resolver
   * cancelled it). `options`: VS Code's DebugSessionOptions (`parentSession` an id).
   */
  startDebugging(
    configuration: string | Record<string, unknown>,
    options?: DebugStartOptions,
  ): Promise<{ session?: string }>;
  /** Function breakpoints ("fs.read"). */
  functionBreakpoints(): Promise<DebugFunctionBreakpoint[]>;
  /** Adds function breakpoints ("fs.write"). */
  addFunctionBreakpoints(list: DebugFunctionBreakpoint[]): Promise<void>;
  /** Removes function breakpoints by their functions' names ("fs.write"). */
  removeFunctionBreakpoints(names: string[]): Promise<void>;
  /** A line breakpoint as session `sessionId` placed it (DAP's Breakpoint), or null. */
  protocolBreakpoint(sessionId: string, id: number): Promise<Record<string, unknown> | null>;
  /** Writes to the debug console (VS Code's activeDebugConsole.append). */
  appendToConsole(text: string): Promise<void>;
  /** An event of a session's adapter's own (VS Code's onDidReceiveDebugSessionCustomEvent). */
  onDidReceiveCustomEvent(
    listener: (e: { session: DebugSessionSummary; event: string; body: unknown }) => void,
  ): Disposable;
  /** The focused thread or frame changed (null: none). */
  onDidChangeActiveStackItem(listener: (item: DebugStackItem | null) => void): Disposable;
  /** Stops one session, or every one ("shell"). */
  stopDebugging(sessionId?: string): Promise<void>;
  /** A Debug Adapter Protocol request to a session (default: the focused one); "shell". */
  customRequest(
    command: string,
    args?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown>;
  onDidStartDebugSession(listener: (session: DebugSessionSummary) => void): Disposable;
  onDidTerminateDebugSession(listener: (session: DebugSessionSummary) => void): Disposable;
  onDidChangeActiveDebugSession(
    listener: (session: DebugSessionSummary | null) => void,
  ): Disposable;
  onDidChangeBreakpoints(listener: () => void): Disposable;
  /** `type` must be in the manifest's `debuggers` (D234). */
  registerDebugConfigurationProvider(
    type: string,
    provider: DebugConfigurationProvider,
    triggerKind?: DebugConfigurationProviderTriggerKind,
  ): Disposable;
  /**
   * Watches sessions' DAP messages (D258, VS Code's registerDebugAdapterTrackerFactory): `type` a
   * debug type or "*"; the tracker is told what the IDE sends the adapter and what it sends back.
   */
  registerDebugAdapterTrackerFactory(
    type: string,
    factory: {
      createDebugAdapterTracker(session: {
        id: string;
        type: string;
        name: string;
      }): DebugAdapterTracker | null | undefined | Promise<DebugAdapterTracker | null | undefined>;
    },
  ): Disposable;
  /** `type` must be in the manifest's `debuggers`. */
  registerDebugAdapterDescriptorFactory(
    type: string,
    factory: DebugAdapterDescriptorFactory,
  ): Disposable;
}

/** The state a source control sends to the host. */
export interface ScmWire {
  id: string;
  label: string;
  rootPath?: string;
  input: { value: string; placeholder: string; visible: boolean };
  count: number | null;
  accept: { command: string; title?: string; input?: unknown } | null;
  quickDiff: boolean;
  groups: { id: string; label: string; hideWhenEmpty: boolean; resources: ResourceState[] }[];
}

export function createScmDebugApis(
  request: Request,
  on: OnCall,
  onEvent: (type: string, listener: (payload: unknown) => void) => Disposable,
): { scm: ScmApi; debug: DebugApi } {
  let scmSeq = 0;
  const scm: ScmApi = {
    createSourceControl(options) {
      const id = `scm${++scmSeq}`;
      let disposed = false;
      let scheduled = false;
      let value = "";
      let placeholder = "";
      let visible = true;
      let count: number | undefined;
      let accept: SourceControl["acceptInputCommand"];
      let quickDiff: SourceControl["quickDiffProvider"];
      const inputListeners = new Set<(value: string) => void>();
      const groups: (SourceControlResourceGroup & { disposed: boolean })[] = [];

      const snapshot = (): ScmWire => ({
        id,
        label: String(options?.label ?? options?.id ?? ""),
        ...(typeof options?.rootPath === "string" && { rootPath: options.rootPath }),
        input: { value, placeholder, visible },
        count: typeof count === "number" ? count : null,
        accept: accept ? { ...accept } : null,
        quickDiff: quickDiff !== undefined,
        groups: groups
          .filter((g) => !g.disposed)
          .map((g) => ({
            id: g.id,
            label: g.label,
            hideWhenEmpty: g.hideWhenEmpty,
            resources: Array.isArray(g.resourceStates) ? [...g.resourceStates] : [],
          })),
      });
      // Every change in a tick becomes one update (setting resources one group at a time).
      const changed = () => {
        if (disposed || scheduled) return;
        scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          if (!disposed) void request("scm.update", snapshot()).catch(() => {});
        });
      };

      const offInput = on(`${id}.input`, (args: { value?: unknown }) => {
        value = String(args?.value ?? "");
        for (const l of [...inputListeners]) l(value);
        return null;
      });
      const offOriginal = on(`${id}.original`, async (args: { path?: unknown }) => {
        if (!quickDiff) return null;
        const text = await quickDiff.provideOriginal(String(args?.path ?? ""));
        return typeof text === "string" ? text : null;
      });

      const inputBox: SourceControlInputBox = {
        get value() {
          return value;
        },
        set value(v) {
          value = String(v ?? "");
          changed();
        },
        get placeholder() {
          return placeholder;
        },
        set placeholder(v) {
          placeholder = String(v ?? "");
          changed();
        },
        get visible() {
          return visible;
        },
        set visible(v) {
          visible = v !== false;
          changed();
        },
        onDidChange(listener) {
          inputListeners.add(listener);
          return { dispose: () => inputListeners.delete(listener) };
        },
      };

      const control: SourceControl = {
        id: String(options?.id ?? id),
        label: String(options?.label ?? ""),
        inputBox,
        get count() {
          return count;
        },
        set count(v) {
          count = v;
          changed();
        },
        get acceptInputCommand() {
          return accept;
        },
        set acceptInputCommand(v) {
          accept = v;
          changed();
        },
        get quickDiffProvider() {
          return quickDiff;
        },
        set quickDiffProvider(v) {
          quickDiff = v;
          changed();
        },
        createResourceGroup(groupId, label) {
          let groupLabel = String(label ?? "");
          let hide = false;
          let states: ResourceState[] = [];
          const group = {
            id: String(groupId),
            disposed: false,
            get label() {
              return groupLabel;
            },
            set label(v: string) {
              groupLabel = String(v ?? "");
              changed();
            },
            get hideWhenEmpty() {
              return hide;
            },
            set hideWhenEmpty(v: boolean) {
              hide = v === true;
              changed();
            },
            get resourceStates() {
              return states;
            },
            set resourceStates(v: ResourceState[]) {
              states = Array.isArray(v) ? v : [];
              changed();
            },
            dispose() {
              group.disposed = true;
              changed();
            },
          };
          groups.push(group);
          changed();
          return group;
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          offInput();
          offOriginal();
          inputListeners.clear();
          void request("scm.dispose", { id }).catch(() => {});
        },
      };
      // Registered at once (empty), so the view shows it while the extension fills it.
      void request("scm.update", snapshot()).catch((err: unknown) => {
        console.error(err instanceof Error ? err.message : String(err));
      });
      return control;
    },
  };

  /** Inline adapters by the host's session id. */
  const inline = new Map<string, InlineDebugAdapter>();
  /** Sessions whose inline adapter may send (from its start on, until the host disposes it). */
  const live = new Set<string>();
  on("debug.message", (args: { sessionId?: unknown; message?: unknown }) => {
    const adapter = inline.get(String(args?.sessionId));
    const message = args?.message;
    if (adapter && message && typeof message === "object")
      adapter.handleMessage(message as DapMessage);
    return null;
  });
  on("debug.dispose", (args: { sessionId?: unknown }) => {
    const sessionId = String(args?.sessionId);
    const adapter = inline.get(sessionId);
    inline.delete(sessionId);
    live.delete(sessionId);
    adapter?.dispose?.();
    return null;
  });

  let debugSeq = 0;
  const run = (id: string, input: unknown) => request("commands.execute", { id, input });
  const debugState = () =>
    request<{
      session?: string | null;
      sessions?: { id: string; name: string; type?: string }[];
      breakpoints?: DebugBreakpoint[];
      functionBreakpoints?: DebugFunctionBreakpoint[];
    }>("state.get", { path: "ide://debug" });
  const summary = (s: { id: string; name: string; type?: string }): DebugSessionSummary => ({
    id: s.id,
    name: s.name,
    type: s.type ?? "",
  });
  const debug: DebugApi = {
    breakpoints: async () => (await debugState()).breakpoints ?? [],
    addBreakpoints: async (list) => {
      for (const { enabled, ...b } of list) {
        const added = (await run("debug.setBreakpoint", b)) as { id?: unknown } | null;
        // A disabled one is added, then turned off (VS Code's SourceBreakpoint.enabled).
        if (enabled === false && typeof added?.id === "number")
          await run("debug.setBreakpointEnabled", { id: added.id, enabled: false });
      }
    },
    removeBreakpoints: async (ids) => {
      for (const id of ids) await run("debug.removeBreakpoint", { id });
    },
    activeDebugSession: async () => {
      const st = await debugState();
      const s = st.sessions?.find((x) => x.id === st.session);
      return s ? summary(s) : null;
    },
    debugSessions: async () => ((await debugState()).sessions ?? []).map(summary),
    startDebugging: async (configuration, options = {}) =>
      (await run("debug.start", {
        ...(typeof configuration === "string" ? { name: configuration } : { configuration }),
        ...(options.parentSession && { parentSession: options.parentSession }),
        ...(options.lifecycleManagedByParent && { lifecycleManagedByParent: true }),
        ...(options.consoleMode && { consoleMode: options.consoleMode }),
        ...(options.noDebug !== undefined && { noDebug: options.noDebug }),
        ...(options.folder && { folder: options.folder }),
      })) as { session?: string },
    functionBreakpoints: async () => (await debugState()).functionBreakpoints ?? [],
    addFunctionBreakpoints: async (list) => {
      for (const b of list) {
        await run("debug.addFunctionBreakpoint", {
          name: b.name,
          ...(b.condition && { condition: b.condition }),
          ...(b.hitCondition && { hitCondition: b.hitCondition }),
        });
        if (b.enabled === false)
          await run("debug.setFunctionBreakpointEnabled", { name: b.name, enabled: false });
      }
    },
    removeFunctionBreakpoints: async (names) => {
      for (const name of names) await run("debug.removeFunctionBreakpoint", { name });
    },
    protocolBreakpoint: async (sessionId, id) =>
      ((await run("debug.protocolBreakpoint", { session: sessionId, id })) ?? null) as Record<
        string,
        unknown
      > | null,
    appendToConsole: async (text) => {
      await run("debug.appendToConsole", { text });
    },
    onDidReceiveCustomEvent: (listener) =>
      onEvent("debug.didReceiveCustomEvent", (p) =>
        listener(p as { session: DebugSessionSummary; event: string; body: unknown }),
      ),
    onDidChangeActiveStackItem: (listener) =>
      onEvent("debug.didChangeActiveStackItem", (p) =>
        listener((p ?? null) as DebugStackItem | null),
      ),
    stopDebugging: async (sessionId) => {
      await run(
        sessionId ? "debug.stop" : "debug.stopAll",
        sessionId ? { session: sessionId } : {},
      );
    },
    customRequest: (command, args, sessionId) =>
      run("debug.customRequest", {
        command,
        ...(args && { arguments: args }),
        ...(sessionId && { session: sessionId }),
      }),
    onDidStartDebugSession: (listener) =>
      onEvent("debug.didStartSession", (p) => listener(p as DebugSessionSummary)),
    onDidTerminateDebugSession: (listener) =>
      onEvent("debug.didTerminateSession", (p) => listener(p as DebugSessionSummary)),
    onDidChangeActiveDebugSession: (listener) =>
      onEvent("debug.didChangeActiveSession", (p) =>
        listener((p ?? null) as DebugSessionSummary | null),
      ),
    onDidChangeBreakpoints: (listener) => onEvent("debug.didChangeBreakpoints", () => listener()),
    registerDebugConfigurationProvider(type, provider, triggerKind = "initial") {
      const id = `debugConfig${++debugSeq}`;
      const off = on(
        id,
        async (args: { op?: unknown; configuration?: unknown; folder?: unknown }) => {
          // "Add configuration…" asks for starters; a launch asks to resolve (the D234 shape).
          const folder = typeof args?.folder === "string" ? args.folder : null;
          if (args?.op === "provide") {
            const list = await provider.provideDebugConfigurations?.(folder);
            return Array.isArray(list) ? list : [];
          }
          const configuration = (args?.configuration ?? {}) as Record<string, unknown>;
          // D295: the two steps apart, in VS Code's order (the host runs them).
          if (args?.op === "resolveSubstituted") {
            if (!provider.resolveDebugConfigurationWithSubstitutedVariables) return configuration;
            return (
              (await provider.resolveDebugConfigurationWithSubstitutedVariables(
                { ...configuration },
                folder,
              )) ?? null
            );
          }
          if (!provider.resolveDebugConfiguration) return configuration;
          return (await provider.resolveDebugConfiguration({ ...configuration }, folder)) ?? null;
        },
      );
      void request("debug.registerConfigurationProvider", {
        id,
        type: String(type),
        resolves: typeof provider.resolveDebugConfiguration === "function",
        resolvesSubstituted:
          typeof provider.resolveDebugConfigurationWithSubstitutedVariables === "function",
        provides: typeof provider.provideDebugConfigurations === "function",
        trigger: triggerKind === "dynamic" ? "dynamic" : "initial",
      }).catch((err: unknown) => {
        off();
        console.error(err instanceof Error ? err.message : String(err));
      });
      return {
        dispose: () => {
          off();
          void request("debug.unregister", { id }).catch(() => {});
        },
      };
    },
    registerDebugAdapterTrackerFactory(type, factory) {
      const id = `tracker${++debugSeq}`;
      const live = new Map<string, DebugAdapterTracker>();
      let next = 0;
      const offCreate = on(
        id,
        async (args: { session?: { id: string; type: string; name: string } }) => {
          const session = args?.session ?? { id: "", type: String(type), name: "" };
          const tracker = await factory.createDebugAdapterTracker(session);
          if (!tracker) return null;
          const key = `t${++next}`;
          live.set(key, tracker);
          tracker.onWillStartSession?.();
          return key;
        },
      );
      const offEvent = on(
        `${id}.event`,
        (args: { tracker?: string; kind?: string; message?: unknown; code?: number }) => {
          const tracker = live.get(String(args?.tracker ?? ""));
          if (!tracker) return null;
          if (args.kind === "willReceive") tracker.onWillReceiveMessage?.(args.message);
          else if (args.kind === "didSend") tracker.onDidSendMessage?.(args.message);
          else if (args.kind === "willStop") tracker.onWillStopSession?.();
          else if (args.kind === "exit") {
            tracker.onExit?.(args.code, undefined);
            live.delete(String(args.tracker));
          }
          return null;
        },
      );
      void request("debug.registerTracker", { id, type: String(type) }).catch(() => {});
      return {
        dispose: () => {
          offCreate();
          offEvent();
          live.clear();
          void request("debug.unregisterTracker", { id }).catch(() => {});
        },
      };
    },
    registerDebugAdapterDescriptorFactory(type, factory) {
      const id = `debug${++debugSeq}`;
      const off = on(id, async (args: { sessionId?: unknown; session?: unknown }) => {
        const sessionId = String(args?.sessionId ?? "");
        const session = (args?.session ?? {}) as DebugSessionInfo;
        const descriptor = await factory.createDebugAdapterDescriptor(session);
        if (!descriptor) return null;
        if (descriptor.kind !== "inline") return descriptor;
        if (typeof descriptor.start !== "function")
          throw new Error("An inline debug adapter needs start(send).");
        live.add(sessionId);
        const adapter = descriptor.start((message) => {
          if (live.has(sessionId))
            void request("debug.send", { sessionId, message }).catch(() => {});
        });
        if (!adapter || typeof adapter.handleMessage !== "function") {
          live.delete(sessionId);
          throw new Error("An inline debug adapter needs handleMessage(message).");
        }
        inline.set(sessionId, adapter);
        return { kind: "inline" };
      });
      void request("debug.register", { id, type: String(type) }).catch((err: unknown) => {
        off();
        console.error(err instanceof Error ? err.message : String(err));
      });
      return {
        dispose: () => {
          off();
          void request("debug.unregister", { id }).catch(() => {});
        },
      };
    },
  };

  return { scm, debug };
}

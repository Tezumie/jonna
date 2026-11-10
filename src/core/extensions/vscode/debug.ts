// The `vscode` shim's `debug` (D257) on the IDE's `ide.debug`: adapter descriptor factories
// (executables, servers, adapters in the extension's own code), configuration providers (both
// resolve steps, D295), sessions and their events (one DebugSession object per session id: the
// factory's, the events', activeDebugSession and customRequest's, with its resolved configuration
// and parent), custom events, the active stack item, the debug console, breakpoints (line and
// function ones, kept for VS Code's synchronous `debug.breakpoints`), `startDebugging` with
// VS Code's options. A debugger its package.json declares with a `program` and no factory gets one
// that starts that program, as VS Code does. DOM-free and unit-tested.

import type { WorkerApi } from "../rpc";
import type { DebugStartOptions } from "../rpcScmDebug";
import { pathOf, uriOf } from "./convert";
import { pathKey } from "./document";
import { DebugStackFrame, DebugThread } from "./extraTypes";
import { Disposable, EventEmitter, Location, NONE_TOKEN, Position, Uri } from "./types";
import {
  type Breakpoint,
  DebugAdapterExecutable,
  DebugAdapterInlineImplementation,
  DebugAdapterNamedPipeServer,
  DebugAdapterServer,
  DebugConfigurationProviderTriggerKind,
  FunctionBreakpoint,
  SourceBreakpoint,
} from "./workbenchTypes";

type SessionInfo = {
  id: string;
  name: string;
  type: string;
  configuration?: Record<string, unknown>;
  parentSession?: string;
  workspaceFolder?: string;
};
type IdeBreakpoint = Awaited<ReturnType<WorkerApi["debug"]["breakpoints"]>>[number];
type IdeFunctionBreakpoint = Awaited<ReturnType<WorkerApi["debug"]["functionBreakpoints"]>>[number];
type Folder = { uri: Uri; name: string; index: number };

/** VS Code's DebugSession over one of the IDE's sessions. */
export interface ShimDebugSession {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly configuration: Record<string, unknown>;
  readonly workspaceFolder: unknown;
  readonly parentSession: ShimDebugSession | undefined;
  customRequest(command: string, args?: unknown): Promise<unknown>;
  getDebugProtocolBreakpoint(breakpoint: Breakpoint): Promise<unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** VS Code's DebugSessionOptions as the IDE's start options (a parent DebugSession by its id). */
export function startOptionsOf(value: unknown): DebugStartOptions {
  if (!isRecord(value)) return {};
  // A DebugSession given directly (VS Code's older signature: parentSession).
  if (typeof value.id === "string" && typeof value.customRequest === "function")
    return { parentSession: value.id };
  const parent = isRecord(value.parentSession) ? value.parentSession.id : undefined;
  const consoleMode = value.consoleMode === 1 ? "mergeWithParent" : undefined;
  return {
    ...(typeof parent === "string" && { parentSession: parent }),
    ...(value.lifecycleManagedByParent === true && { lifecycleManagedByParent: true }),
    ...(consoleMode && { consoleMode }),
    ...(typeof value.noDebug === "boolean" && { noDebug: value.noDebug }),
    ...(value.suppressDebugToolbar === true && { suppressDebugToolbar: true }),
    ...(value.suppressDebugStatusbar === true && { suppressDebugStatusbar: true }),
    ...(value.suppressDebugView === true && { suppressDebugView: true }),
    ...(value.suppressSaveBeforeStart === true && { suppressSaveBeforeStart: true }),
  };
}

export function createDebug(
  ide: WorkerApi,
  options: {
    packageJSON: Record<string, unknown>;
    extensionPath: string;
    folders: () => readonly Folder[] | undefined;
    /** An absolute path for the IDE's workspace-relative one (breakpoints' paths). */
    absolute: (path: string) => string;
    unsupported: (name: string) => void;
  },
) {
  const sessions = new Map<string, ShimDebugSession>();
  /** Sessions whose configuration is a stand-in (type, name, request) until one is known. */
  const guessed = new WeakSet<ShimDebugSession>();
  const factories = new Set<string>();
  let active: ShimDebugSession | undefined;
  let activeStackItem: DebugThread | DebugStackFrame | undefined;
  let breakpoints: Breakpoint[] = [];
  /** The IDE's id of a line breakpoint; a function breakpoint's key is its function's name. */
  const ideIds = new WeakMap<Breakpoint, number>();

  const onDidStartDebugSession = new EventEmitter<unknown>();
  const onDidTerminateDebugSession = new EventEmitter<unknown>();
  const onDidChangeActiveDebugSession = new EventEmitter<unknown>();
  const onDidReceiveDebugSessionCustomEvent = new EventEmitter<unknown>();
  const onDidChangeActiveStackItem = new EventEmitter<unknown>();
  const onDidChangeBreakpoints = new EventEmitter<{
    added: readonly Breakpoint[];
    removed: readonly Breakpoint[];
    changed: readonly Breakpoint[];
  }>();

  const folderOf = (path: string | null | undefined) =>
    (path ? options.folders()?.find((f) => pathKey(pathOf(f.uri)) === pathKey(path)) : undefined) ??
    options.folders()?.[0];

  function sessionOf(info: SessionInfo): ShimDebugSession {
    const known = sessions.get(info.id);
    if (known) {
      // Made first from what didn't carry the configuration (a tracker's session, an event): the
      // stand-in gives way to the real one when an event brings it.
      const k = known as { configuration: Record<string, unknown> };
      if (info.configuration && (guessed.has(known) || !Object.keys(k.configuration).length)) {
        k.configuration = info.configuration;
        guessed.delete(known);
      }
      return known;
    }
    const session = {
      id: info.id,
      type: info.type,
      name: info.name,
      configuration: info.configuration ?? {
        type: info.type,
        name: info.name,
        request: "launch",
      },
      get workspaceFolder() {
        return folderOf(info.workspaceFolder);
      },
      get parentSession() {
        return info.parentSession ? sessions.get(info.parentSession) : undefined;
      },
      customRequest: (command: string, args?: unknown) =>
        ide.debug.customRequest(command, isRecord(args) ? args : undefined, info.id),
      getDebugProtocolBreakpoint: async (breakpoint: Breakpoint) => {
        const id = ideIds.get(breakpoint);
        if (id === undefined) return undefined;
        return (await ide.debug.protocolBreakpoint(info.id, id).catch(() => null)) ?? undefined;
      },
    };
    sessions.set(info.id, session);
    if (!info.configuration) guessed.add(session);
    return session;
  }

  ide.debug.onDidStartDebugSession((s) => onDidStartDebugSession.fire(sessionOf(s)));
  ide.debug.onDidTerminateDebugSession((s) => {
    const session = sessionOf(s);
    sessions.delete(s.id);
    onDidTerminateDebugSession.fire(session);
  });
  ide.debug.onDidChangeActiveDebugSession((s) => {
    active = s ? sessionOf(s) : undefined;
    onDidChangeActiveDebugSession.fire(active);
  });
  ide.debug.onDidReceiveCustomEvent((e) =>
    onDidReceiveDebugSessionCustomEvent.fire({
      session: sessionOf(e.session),
      event: e.event,
      body: e.body,
    }),
  );
  ide.debug.onDidChangeActiveStackItem((item) => {
    activeStackItem = item
      ? item.frameId !== undefined
        ? new DebugStackFrame(sessionOf(item.session), item.threadId, item.frameId)
        : new DebugThread(sessionOf(item.session), item.threadId)
      : undefined;
    onDidChangeActiveStackItem.fire(activeStackItem);
  });

  /** The extension's own objects from addBreakpoints, until the IDE lists them (D261). */
  let added: Breakpoint[] = [];
  /** The IDE's breakpoints as VS Code's, the same objects for the same breakpoints. */
  const refreshBreakpoints = async () => {
    const [lines, functions] = await Promise.all([
      ide.debug.breakpoints().catch(() => [] as IdeBreakpoint[]),
      ide.debug.functionBreakpoints().catch(() => [] as IdeFunctionBreakpoint[]),
    ]);
    const keyOf = (b: Breakpoint) =>
      b instanceof FunctionBreakpoint ? `f:${b.functionName}` : `l:${ideIds.get(b)}`;
    const before = new Map(breakpoints.map((b) => [keyOf(b), b]));
    const next: Breakpoint[] = [];
    const newOnes: Breakpoint[] = [];
    const changed: Breakpoint[] = [];
    const take = (key: string, fresh: Breakpoint) => {
      const old = before.get(key);
      if (old && sameBreakpoint(old, fresh)) {
        next.push(old);
        before.delete(key);
        return;
      }
      next.push(fresh);
      if (old) {
        changed.push(fresh);
        before.delete(key);
      } else newOnes.push(fresh);
    };
    for (const b of lines) {
      let fresh = toBreakpoint(b, options.absolute);
      if (!fresh) continue;
      // One it added itself: its own object, so `removeBreakpoints(it)` works and it's in
      // `breakpoints` (D261).
      if (!before.has(`l:${b.id}`) && fresh instanceof SourceBreakpoint) {
        const at = fresh.location;
        const own = added.find(
          (x) =>
            x instanceof SourceBreakpoint &&
            pathKey(pathOf(x.location.uri)) === pathKey(pathOf(at.uri)) &&
            x.location.range.start.line === at.range.start.line,
        );
        if (own) {
          added = added.filter((x) => x !== own);
          fresh = own;
        }
      }
      ideIds.set(fresh, b.id);
      take(`l:${b.id}`, fresh);
    }
    for (const f of functions) {
      let fresh: Breakpoint = new FunctionBreakpoint(
        f.name,
        f.enabled !== false,
        f.condition,
        f.hitCondition,
      );
      const own = added.find((x) => x instanceof FunctionBreakpoint && x.functionName === f.name);
      if (own && !before.has(`f:${f.name}`) && sameBreakpoint(own, fresh)) {
        added = added.filter((x) => x !== own);
        fresh = own;
      }
      take(`f:${f.name}`, fresh);
    }
    const removed = [...before.values()];
    breakpoints = next;
    if (newOnes.length || removed.length || changed.length)
      onDidChangeBreakpoints.fire({ added: newOnes, removed, changed });
  };
  ide.debug.onDidChangeBreakpoints(() => void refreshBreakpoints());

  const descriptorOf = (d: unknown) => {
    if (d instanceof DebugAdapterExecutable)
      return {
        kind: "executable" as const,
        command: d.command,
        args: d.args,
        ...(d.options?.cwd && { cwd: d.options.cwd }),
        ...(d.options?.env && { env: d.options.env }),
      };
    if (d instanceof DebugAdapterServer)
      return { kind: "server" as const, port: d.port, ...(d.host && { host: d.host }) };
    if (d instanceof DebugAdapterInlineImplementation) {
      const impl = d.implementation;
      return {
        kind: "inline" as const,
        start: (send: (message: Record<string, unknown>) => void) => {
          const sub = impl.onDidSendMessage((m) => send(m as Record<string, unknown>));
          return {
            handleMessage: (message: Record<string, unknown>) => impl.handleMessage(message),
            dispose: () => {
              sub.dispose();
              impl.dispose?.();
            },
          };
        },
      };
    }
    if (d instanceof DebugAdapterNamedPipeServer)
      options.unsupported("DebugAdapterNamedPipeServer");
    return undefined;
  };

  /** The adapter VS Code starts for a debugger its package.json gives a `program` (and runtime). */
  const declaredExecutable = (type: string): DebugAdapterExecutable | undefined => {
    const contributes = isRecord(options.packageJSON.contributes)
      ? options.packageJSON.contributes
      : {};
    const list = Array.isArray(contributes.debuggers) ? contributes.debuggers : [];
    const d = list.find((x) => isRecord(x) && x.type === type);
    if (!isRecord(d) || typeof d.program !== "string") return undefined;
    const program = pathOf(Uri.joinPath(Uri.file(options.extensionPath), d.program));
    const args = Array.isArray(d.args)
      ? d.args.filter((a): a is string => typeof a === "string")
      : [];
    const runtime =
      typeof d.runtime === "string" ? d.runtime : /\.[cm]?js$/.test(program) ? "node" : undefined;
    return runtime
      ? new DebugAdapterExecutable(runtime, [program, ...args])
      : new DebugAdapterExecutable(program, args);
  };

  const registerFactory = (
    type: string,
    factory: { createDebugAdapterDescriptor(session: unknown, executable: unknown): unknown },
  ) => {
    factories.add(type);
    const handle = ide.debug.registerDebugAdapterDescriptorFactory(type, {
      createDebugAdapterDescriptor: async (info) =>
        descriptorOf(
          await factory.createDebugAdapterDescriptor(sessionOf(info), declaredExecutable(type)),
        ),
    });
    return new Disposable(() => {
      factories.delete(type);
      handle.dispose();
    });
  };

  const consoleAppend = (text: string) =>
    void ide.debug.appendToConsole(text).catch(() => {
      options.unsupported("debug.activeDebugConsole");
    });

  return {
    ready: refreshBreakpoints,
    /** After activation: declared debuggers with a program and no factory get one (VS Code's). */
    afterActivate() {
      const contributes = isRecord(options.packageJSON.contributes)
        ? options.packageJSON.contributes
        : {};
      const list = Array.isArray(contributes.debuggers) ? contributes.debuggers : [];
      for (const d of list) {
        if (!isRecord(d) || typeof d.type !== "string" || factories.has(d.type)) continue;
        const executable = declaredExecutable(d.type);
        if (executable)
          registerFactory(d.type, { createDebugAdapterDescriptor: (_s, e) => e ?? executable });
      }
    },
    api: {
      get activeDebugSession() {
        return active;
      },
      activeDebugConsole: {
        append: (value: string) => consoleAppend(String(value)),
        appendLine: (value: string) => consoleAppend(`${String(value)}\n`),
      },
      get breakpoints() {
        return breakpoints;
      },
      get activeStackItem() {
        return activeStackItem;
      },
      onDidStartDebugSession: onDidStartDebugSession.event,
      onDidTerminateDebugSession: onDidTerminateDebugSession.event,
      onDidChangeActiveDebugSession: onDidChangeActiveDebugSession.event,
      onDidChangeBreakpoints: onDidChangeBreakpoints.event,
      onDidReceiveDebugSessionCustomEvent: onDidReceiveDebugSessionCustomEvent.event,
      onDidChangeActiveStackItem: onDidChangeActiveStackItem.event,
      registerDebugAdapterDescriptorFactory: registerFactory,
      registerDebugConfigurationProvider: (
        type: string,
        provider: {
          provideDebugConfigurations?(folder: unknown, token: unknown): unknown;
          resolveDebugConfiguration?(folder: unknown, config: unknown, token: unknown): unknown;
          resolveDebugConfigurationWithSubstitutedVariables?(
            folder: unknown,
            config: unknown,
            token: unknown,
          ): unknown;
        },
        triggerKind?: DebugConfigurationProviderTriggerKind,
      ) => {
        // VS Code's two steps stay apart (D295): the IDE runs every extension's first step, fills
        // in variables, runs the preLaunchTask, then every second step.
        const resolve = provider.resolveDebugConfiguration?.bind(provider);
        const substituted =
          provider.resolveDebugConfigurationWithSubstitutedVariables?.bind(provider);
        const handle = ide.debug.registerDebugConfigurationProvider(
          type,
          {
            ...(resolve && {
              resolveDebugConfiguration: async (config, folder) => {
                const c = await resolve(folderOf(folder), config, NONE_TOKEN);
                return isRecord(c) ? c : null;
              },
            }),
            ...(substituted && {
              resolveDebugConfigurationWithSubstitutedVariables: async (config, folder) => {
                const c = await substituted(folderOf(folder), config, NONE_TOKEN);
                return isRecord(c) ? c : null;
              },
            }),
            ...(provider.provideDebugConfigurations && {
              provideDebugConfigurations: async (folder) => {
                const list = await provider.provideDebugConfigurations?.(
                  folderOf(folder),
                  NONE_TOKEN,
                );
                return Array.isArray(list) ? list.filter(isRecord) : null;
              },
            }),
          },
          triggerKind === DebugConfigurationProviderTriggerKind.Dynamic ? "dynamic" : "initial",
        );
        return new Disposable(() => handle.dispose());
      },
      /** D258: the IDE's trackers have VS Code's methods; the session is the shim's. */
      registerDebugAdapterTrackerFactory: (
        type: string,
        factory: { createDebugAdapterTracker(session: unknown): unknown },
      ) => {
        const handle = ide.debug.registerDebugAdapterTrackerFactory(type, {
          createDebugAdapterTracker: async (s) =>
            ((await factory.createDebugAdapterTracker(sessionOf(s))) ?? null) as never,
        });
        return new Disposable(() => handle.dispose());
      },
      /**
       * VS Code's startDebugging(folder, nameOrConfiguration, parentSessionOrOptions): true once
       * the session runs; false when it failed or a resolver cancelled it.
       */
      startDebugging: async (
        folder: unknown,
        nameOrConfiguration: string | Record<string, unknown>,
        parentSessionOrOptions?: unknown,
      ) => {
        const start = startOptionsOf(parentSessionOrOptions);
        const folderPath =
          isRecord(folder) && folder.uri instanceof Uri ? pathOf(folder.uri) : undefined;
        try {
          const r = await ide.debug.startDebugging(nameOrConfiguration, {
            ...start,
            ...(folderPath && { folder: folderPath }),
          });
          // A compound answers with its sessions.
          const sessions = (r as { sessions?: unknown } | undefined)?.sessions;
          return typeof r?.session === "string" || (Array.isArray(sessions) && sessions.length > 0);
        } catch {
          return false;
        }
      },
      stopDebugging: (session?: { id: string }) => ide.debug.stopDebugging(session?.id),
      addBreakpoints: (list: readonly Breakpoint[]) => {
        const source = list.filter((b): b is SourceBreakpoint => b instanceof SourceBreakpoint);
        const functions = list.filter(
          (b): b is FunctionBreakpoint => b instanceof FunctionBreakpoint,
        );
        added.push(...source, ...functions);
        void Promise.all([
          source.length &&
            ide.debug.addBreakpoints(
              source.map((b) => ({
                path: pathOf(b.location.uri),
                line: b.location.range.start.line + 1,
                ...(b.condition && { condition: b.condition }),
                ...(b.hitCondition && { hitCondition: b.hitCondition }),
                ...(b.logMessage && { logMessage: b.logMessage }),
                ...(b.enabled === false && { enabled: false }),
              })),
            ),
          functions.length &&
            ide.debug.addFunctionBreakpoints(
              functions.map((b) => ({
                name: b.functionName,
                enabled: b.enabled !== false,
                ...(b.condition && { condition: b.condition }),
                ...(b.hitCondition && { hitCondition: b.hitCondition }),
              })),
            ),
        ]).then(refreshBreakpoints, () => {});
      },
      removeBreakpoints: (list: readonly Breakpoint[]) => {
        const ids = list.map((b) => ideIds.get(b)).filter((id): id is number => id !== undefined);
        const names = list
          .filter((b): b is FunctionBreakpoint => b instanceof FunctionBreakpoint)
          .map((b) => b.functionName);
        void Promise.all([
          ids.length && ide.debug.removeBreakpoints(ids),
          names.length && ide.debug.removeFunctionBreakpoints(names),
        ]).then(refreshBreakpoints, () => {});
      },
      asDebugSourceUri: (source: { path?: string }) => uriOf(source.path ?? ""),
    },
  };
}

function toBreakpoint(
  b: IdeBreakpoint,
  absolute: (path: string) => string,
): Breakpoint | undefined {
  if (b.kind && b.kind !== "source" && b.kind !== "line") return undefined;
  if (!b.path || !b.line) return undefined;
  return new SourceBreakpoint(
    new Location(uriOf(absolute(b.path)), new Position(Math.max(0, b.line - 1), 0)),
    b.enabled !== false,
    b.condition,
    b.hitCondition,
    b.logMessage,
  );
}

function sameBreakpoint(a: Breakpoint, b: Breakpoint): boolean {
  const same =
    a.enabled === b.enabled &&
    a.condition === b.condition &&
    a.hitCondition === b.hitCondition &&
    a.logMessage === b.logMessage;
  if (a instanceof FunctionBreakpoint && b instanceof FunctionBreakpoint)
    return same && a.functionName === b.functionName;
  if (!(a instanceof SourceBreakpoint) || !(b instanceof SourceBreakpoint)) return false;
  return (
    same &&
    a.location.uri.toString() === b.location.uri.toString() &&
    a.location.range.isEqual(b.location.range)
  );
}

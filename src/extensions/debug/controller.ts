// The debugger's state and its sessions (D143; several at once since D204, as in VS Code): starts
// a configuration with the right debugger (launch.ts → launchers.ts), follows stops per thread
// (call stack, the stopped line, the exception widget, variables), the session the toolbar acts
// on ("focused"), stepping (by instruction from the disassembly view), compounds' stopAll, and the
// debug console. Breakpoints are kept in step by breakpointSync.ts; sessions started under another
// (child processes, workers, serverReadyAction, DAP startDebugging) by childSessions.ts; one
// session's state is runningSession.ts. The views (view.ts, callStack.ts, console.ts) and the
// commands (index.ts, sessionCommands.ts) only read and drive this.

import { Emitter } from "../../core/events/index";
import { BUILT_IN_DEBUG_TYPES } from "../../core/extensions/manifestWorkbench";
import type { DisposableStore } from "../../core/lifecycle/index";
import {
  batch,
  computed,
  effect,
  type ReadonlySignal,
  type Signal,
  signal,
} from "../../core/reactive/index";
import type { TaskExecution, WorkbenchServices } from "../../workbench/services";
import { wantsChildAttach } from "./autoAttach";
import { BreakpointSync } from "./breakpointSync";
import { BreakpointStore } from "./breakpoints";
import { ChildSessions, type ControllerHooks, type SessionHost } from "./childSessions";
import { sessionsToStop } from "./compounds";
import {
  type ConsoleChoice,
  type ConsoleLine,
  consoleChoices,
  consoleKeyOf,
  DebugConsoles,
} from "./consoleSessions";
import { exceptionWidget } from "./exceptionInfo";
import { extensionAdapter } from "./extensionAdapters";
import { type Adapter, type AdapterTools, adapterFor, type LaunchConfig, toConfig } from "./launch";
import { isPackageManager, type LaunchTarget, SessionLaunchers } from "./launchers";
import { OtherBreakpoints } from "./otherBreakpoints";
import { builtInPythonSetup } from "./pythonDebug";
import {
  hasResolvers,
  type ResolverSource,
  resolveByProviders,
  resolveWithSubstitutedVariables,
} from "./resolution";
import { type DebugState, RunningSession, type SessionKind, type StopInfo } from "./runningSession";
import type {
  DebugSession,
  Scope,
  SessionSetup,
  StackFrame,
  StepInTarget,
  SteppingGranularity,
  StoppedEvent,
} from "./session";
import {
  focusAfter,
  pickThread,
  threadsAfterContinue,
  threadsAfterStop,
  uniqueName,
} from "./sessionModel";
import { breakpointsHit, triggeredBy } from "./triggers";

export type { ControllerHooks } from "./childSessions";
export type { ConsoleLine } from "./consoleSessions";
export type { DebugState, SessionKind, StopInfo } from "./runningSession";
export { RunningSession } from "./runningSession";

/** The types the built-in Python debugger runs. */
const PYTHON_TYPES = /^(python|debugpy)$/i;
/** For a configuration whose variables are already filled in (nothing left to replace). */
const NO_VARS = { workspaceFolder: "", pathSeparator: "/" };

export class DebugController implements SessionHost {
  readonly breakpoints = new BreakpointStore();
  /** Function, data and instruction breakpoints, exception filters (D204). */
  readonly other = new OtherBreakpoints();
  /** Every session, in the order they started. */
  readonly sessions: Signal<readonly RunningSession[]> = signal([]);
  readonly focusedId: Signal<string | null> = signal(null);
  readonly focused: ReadonlySignal<RunningSession | null> = computed(() => {
    const id = this.focusedId.value;
    return this.sessions.value.find((s) => s.id === id) ?? null;
  });
  /** The focused session's state ("inactive" with none). */
  readonly state: ReadonlySignal<DebugState> = computed(
    () => this.focused.value?.state.value ?? "inactive",
  );
  readonly config: ReadonlySignal<LaunchConfig | null> = computed(
    () => this.focused.value?.config ?? null,
  );
  /** Why the focused session stopped ("breakpoint", "step", "exception"…). */
  readonly stopInfo: ReadonlySignal<StopInfo | null> = computed(
    () => this.focused.value?.stopInfo.value ?? null,
  );
  readonly frames: ReadonlySignal<readonly StackFrame[]> = computed(
    () => this.focused.value?.frames.value ?? [],
  );
  readonly frameIndex: ReadonlySignal<number> = computed(
    () => this.focused.value?.frameIndex.value ?? 0,
  );
  readonly scopes: ReadonlySignal<readonly Scope[]> = computed(
    () => this.focused.value?.scopes.value ?? [],
  );
  /** The debug console per session (D209): every line, the console shown and its lines. */
  readonly consoles = new DebugConsoles();
  readonly console: Signal<readonly ConsoleLine[]> = this.consoles.lines;
  /** Bumped when a frame was selected (a stop, the user's choice, another session): watches re-evaluate. */
  readonly frameVersion: Signal<number> = signal(0);
  /**
   * Steps go by instruction (VS Code: while the disassembly view has the focus); the view sets
   * it, agents pass `granularity` instead.
   */
  readonly instructionStepping: Signal<boolean> = signal(false);
  /** Compounds running, by id: their name and stopAll. */
  private readonly compounds = new Map<string, { name: string; stopAll: boolean }>();
  /**
   * Continued events per session (all threads, and per thread): a stop still loading its stack
   * when its thread resumes is dropped, or it would show "stopped" while the program runs.
   */
  private readonly resumes = new WeakMap<
    RunningSession,
    { all: number; thread: Map<number, number> }
  >();
  private counter = 0;
  readonly launchers: SessionLaunchers;
  readonly sync: BreakpointSync;
  private readonly children: ChildSessions;
  hooks: ControllerHooks = {
    runTask: async () => {},
    openExternal: async () => {},
    startByName: async () => {},
  };
  private readonly attached = new Emitter<RunningSession>();
  /** A session got its debugger (before it starts the program): its events can be followed. */
  readonly onDidAttachDebugger = this.attached.event;

  constructor(
    readonly services: WorkbenchServices,
    sub: DisposableStore,
  ) {
    this.launchers = new SessionLaunchers(services);
    this.sync = new BreakpointSync(this.breakpoints, this.other, this.sessions);
    this.children = new ChildSessions(this);
    const { debugMarks } = services;
    sub.add(
      effect(() => {
        debugMarks.breakpoints.value = this.breakpoints.glyphs(this.sessions.value.length > 0);
        return undefined;
      }),
    );
    sub.add(debugMarks.onDidMove(({ path, lines }) => this.breakpoints.moveLines(path, lines)));
    // The console shown follows the focused session (VS Code's picker does the same).
    sub.add(
      effect(() => {
        const focused = this.focused.value;
        if (focused) this.consoles.selected.value = this.consoleKey(focused);
        return undefined;
      }),
    );
    // The stopped line follows the focused session's selected frame.
    sub.add(
      effect(() => {
        const frame = this.frames.value[this.frameIndex.value];
        debugMarks.execution.value =
          this.state.value === "stopped" && frame?.path
            ? { path: frame.path, line: frame.line }
            : null;
        return undefined;
      }),
    );
    // The exception widget: under the line the focused session stopped at on an exception.
    sub.add(
      effect(() => {
        const rs = this.focused.value;
        const ex = rs?.exception.value ?? null;
        const frames = rs?.frames.value ?? [];
        const top = frames.find((f) => f.path);
        debugMarks.exception.value =
          rs && ex && top?.path && rs.state.value === "stopped"
            ? { path: top.path, line: top.line, ...exceptionWidget(ex) }
            : null;
        return undefined;
      }),
    );
    // Watches and Variables follow focus changes too.
    sub.add(
      effect(() => {
        this.focusedId.value;
        this.frameVersion.value = this.frameVersion.peek() + 1;
        return undefined;
      }),
    );
    // Breakpoint changes go to every running session.
    const toRunning = (signalRead: () => unknown, send: (rs: RunningSession) => unknown) =>
      sub.add(
        effect(() => {
          signalRead();
          for (const rs of this.sessions.peek())
            if (rs.session && rs.state.peek() !== "starting") void send(rs);
          return undefined;
        }),
      );
    toRunning(
      () => this.breakpoints.list.value,
      (rs) => this.sync.sync(rs),
    );
    toRunning(
      () => this.other.functions.value,
      (rs) => this.sync.syncFunctions(rs),
    );
    toRunning(
      () => this.other.data.value,
      (rs) => this.sync.syncData(rs),
    );
    toRunning(
      () => this.other.instructions.value,
      (rs) => this.sync.syncInstructions(rs),
    );
    sub.add(
      effect(() => {
        this.breakpoints.uncaught.value;
        this.breakpoints.caught.value;
        this.other.filterChoices.value;
        for (const rs of this.sessions.peek()) if (rs.session) void this.sync.applyExceptions(rs);
        return undefined;
      }),
    );
    sub.add({ dispose: () => void this.stopAll() });
    sub.add({ dispose: () => this.attached.dispose() });
  }

  /** The focused session's debugger. */
  get active(): DebugSession | null {
    return this.focused.peek()?.session ?? null;
  }

  /** The terminal the focused session's program runs in. */
  get programTerminal(): TaskExecution | null {
    return this.focused.peek()?.terminal ?? null;
  }

  session(id: string): RunningSession | undefined {
    return this.sessions.peek().find((s) => s.id === id);
  }

  /** A session by id or name (default: the focused one); throws when there's none. */
  sessionFor(idOrName?: string): RunningSession {
    const list = this.sessions.peek();
    const rs =
      idOrName === undefined
        ? this.focused.peek()
        : (list.find((s) => s.id === idOrName) ??
          list.find((s) => s.name === idOrName) ??
          // "child.js" for "child.js [4242]", "Worker:" for a worker.
          list.find((s) => s.name.startsWith(idOrName)));
    if (!rs)
      throw new Error(
        idOrName === undefined
          ? "No debug session is running (F5 starts one)."
          : `No debug session "${idOrName}". Sessions: ${list.map((s) => `${s.id} (${s.name})`).join(", ") || "none"}.`,
      );
    return rs;
  }

  // ---- Console ----

  print(line: ConsoleLine): void {
    this.consoles.print(line);
  }

  /** A line in `rs`'s console (its parent's for a child process or worker). */
  printFor(rs: RunningSession, line: ConsoleLine): void {
    this.consoles.print({
      ...line,
      session: rs.name,
      sessionId: this.consoleKey(rs),
      source: rs.id,
    });
  }

  /** The console `rs` writes to (D209). */
  consoleKey(rs: RunningSession): string {
    const list = this.sessions.peek();
    return consoleKeyOf(rs.id, list.includes(rs) ? list : [...list, rs]);
  }

  /** The consoles to pick from (the picker, ide://debug); reactive inside an effect. */
  consoleList(): ConsoleChoice[] {
    return consoleChoices(
      this.sessions.value,
      this.console.value,
      (id) => this.compoundInfo(id)?.name ?? id,
    );
  }

  /** Clears the console shown (`all`: every session's). */
  clearConsole(all = false): void {
    this.consoles.clear(all);
  }

  // ---- Starting ----

  private tools(): AdapterTools {
    const { settings, platform } = this.services;
    return {
      python:
        settings.peek<string>("debug.pythonPath") ||
        (platform === "windows" ? "python" : "python3"),
      lldbDap: settings.peek<string>("debug.lldbDapPath") || "lldb-dap",
      gdb: settings.peek<string>("debug.gdbPath") || "gdb",
      dlv: settings.peek<string>("debug.dlvPath") || "dlv",
      netcoredbg: settings.peek<string>("debug.netcoredbgPath") || "netcoredbg",
    };
  }

  /** Which debugger runs `config` (throws with what to install). */
  adapterOf(config: LaunchConfig) {
    // An extension's debugger for its own type (D233).
    return extensionAdapter(this.services, config) ?? adapterFor(config, this.tools());
  }

  /**
   * Like adapterOf, for a launch: a type the IDE debugs itself that an installed extension also
   * contributes (debugpy) runs on the extension's adapter once it supplies one, as in VS Code,
   * else on the built-in one. The built-in Python debugger gets the folder's interpreter, its
   * .env and debugpy's bundled copy (pythonDebug.ts, D295): the configuration may change.
   */
  private async launchAdapter(
    config: LaunchConfig,
    parentId?: string,
  ): Promise<{ adapter: Adapter; config: LaunchConfig }> {
    const own = extensionAdapter(this.services, config, parentId);
    if (own && !BUILT_IN_DEBUG_TYPES.test(config.type)) return { adapter: own, config };
    if (own) {
      const entry = this.services.extensionFeatures.debugAdapters.get(config.type);
      if (!entry?.ready || (await entry.ready())) return { adapter: own, config };
      this.services.notifications.show(
        "info",
        `The ${entry.owner} extension didn't start its "${config.type}" debugger: the built-in one runs this.`,
      );
    }
    return this.builtInAdapter(config);
  }

  /** The IDE's own debugger for `config` (Python's set up as VS Code's debugpy extension does). */
  private async builtInAdapter(
    config: LaunchConfig,
  ): Promise<{ adapter: Adapter; config: LaunchConfig }> {
    const tools = this.tools();
    if (config.debugAdapter || !PYTHON_TYPES.test(config.type))
      return { adapter: adapterFor(config, tools), config };
    const setup = await builtInPythonSetup(this.services, config, tools.python);
    const adapter = adapterFor(setup.config, { ...tools, python: setup.python });
    return {
      adapter:
        adapter.kind === "dap" && setup.adapterEnv
          ? { ...adapter, env: setup.adapterEnv }
          : adapter,
      config: setup.config,
    };
  }

  // ---- Resolving (resolution.ts, D295: VS Code's order) ----

  private resolverSource(): ResolverSource {
    const registry = this.services.extensionFeatures.debugResolvers;
    return {
      activate: (type) => registry.activate("onDebugResolve", type),
      resolvers: (step, type) => registry.resolvers(step, type),
    };
  }

  /**
   * Extensions' resolveDebugConfiguration on the configuration as written (its type's providers,
   * then "*"; again while one changes the type), then its variables filled in. Null: a resolver
   * cancelled. Without resolvers it's the configuration as it was (variables already in).
   */
  async resolveConfiguration(config: LaunchConfig): Promise<LaunchConfig | null> {
    const source = this.resolverSource();
    await source.activate(config.type);
    const unresolved = config.unresolved ?? config.raw;
    const typeOf = (c: Record<string, unknown>) => (typeof c.type === "string" ? c.type : "");
    if (!hasResolvers(source, "resolve", typeOf(unresolved))) return config;
    const folder = config.workspaceFolder ?? null;
    const resolved = await resolveByProviders(structuredClone(unresolved), folder, source);
    if (!resolved) return null;
    return this.remake(config, resolved, !config.verbatim);
  }

  /** resolveDebugConfigurationWithSubstitutedVariables (after the preLaunchTask). Null: cancelled. */
  async resolveSubstituted(config: LaunchConfig): Promise<LaunchConfig | null> {
    const source = this.resolverSource();
    if (!hasResolvers(source, "substituted", config.type)) return { ...config, resolved: true };
    const resolved = await resolveWithSubstitutedVariables(
      structuredClone(config.raw),
      config.workspaceFolder ?? null,
      source,
    );
    if (!resolved) return null;
    const next = await this.remake(config, resolved, false);
    return next && { ...next, resolved: true };
  }

  /** Both steps, for a configuration started without the run commands (a child, a picker). */
  private async resolveAll(config: LaunchConfig): Promise<LaunchConfig | null> {
    const first = await this.resolveConfiguration(config);
    return first && this.resolveSubstituted(first);
  }

  /**
   * `config` again from a resolver's answer (`fill`: its variables filled in); what the IDE
   * knows about it (folder, source, the name shown) stays, the written form stays unresolved.
   */
  private async remake(
    config: LaunchConfig,
    json: Record<string, unknown>,
    fill: boolean,
  ): Promise<LaunchConfig | null> {
    const vars = (fill && (await this.hooks.variables?.(config.workspaceFolder))) || {
      workspaceFolder: config.workspaceFolder ?? this.services.workspace.root.peek() ?? "",
      pathSeparator: this.services.platform === "windows" ? "\\" : "/",
    };
    // Without filling in, `substitute` finds nothing to replace in strings without "${".
    const made = fill
      ? toConfig(json, config.source, vars)
      : toConfig(json, config.source, NO_VARS);
    if (!made) throw new Error("The resolved configuration needs a name and a type.");
    const writtenName = typeof config.unresolved?.name === "string" ? config.unresolved.name : "";
    const renamed = typeof json.name === "string" && json.name !== writtenName;
    return {
      ...made,
      ...(fill ? {} : { raw: json }),
      unresolved: config.unresolved ?? config.raw,
      name: renamed ? made.name : config.name,
      ...(!renamed && config.plainName !== undefined && { plainName: config.plainName }),
      ...(config.folderName !== undefined && { folderName: config.folderName }),
      ...(config.workspaceFolder !== undefined && { workspaceFolder: config.workspaceFolder }),
      ...(config.verbatim && { verbatim: true }),
    };
  }

  /** A running compound's id, for `start`'s `compound` (stopAll is looked up there). */
  registerCompound(name: string, stopAll: boolean): string {
    const id = `c${++this.counter}`;
    this.compounds.set(id, { name, stopAll });
    return id;
  }

  /** A running compound's name and stopAll (undefined once its last session ended). */
  compoundInfo(id: string): { name: string; stopAll: boolean } | undefined {
    return this.compounds.get(id);
  }

  /**
   * Puts compound `id` back after its last session ended (D207: restarting that session kept
   * the compound id but lost its stopAll).
   */
  keepCompound(id: string, info: { name: string; stopAll: boolean }): void {
    if (!this.compounds.has(id)) this.compounds.set(id, { ...info });
  }

  /** What a new session gets before its program runs (breakpointSync.ts). */
  setupFor(rs: RunningSession): SessionSetup {
    return this.sync.setupFor(rs);
  }

  /** Adds `rs` to the sessions (focused when asked, or when it's the only one). */
  add(rs: RunningSession, focus: boolean): void {
    batch(() => {
      this.sessions.value = [...this.sessions.peek(), rs];
      if (focus || !this.focusedId.peek()) this.focusedId.value = rs.id;
    });
  }

  newSession(
    config: LaunchConfig,
    opts: {
      parentId?: string | null;
      compound?: string | null;
      noDebug?: boolean;
      kind?: SessionKind;
      name?: string;
    },
  ): RunningSession {
    const name = uniqueName(
      opts.name ?? config.name,
      this.sessions.peek().map((s) => s.name),
    );
    return new RunningSession(
      `s${++this.counter}`,
      name,
      config,
      opts.parentId ?? null,
      opts.compound ?? null,
      opts.noDebug ?? false,
      opts.kind ?? "launch",
    );
  }

  /**
   * Starts `config` as a new session (others keep running); resolves once it runs. Node without
   * debugging is a session too (its output, Stop and Restart), as in VS Code.
   */
  async start(
    given: LaunchConfig,
    noDebug = false,
    opts: {
      parentId?: string;
      compound?: string;
      keepWhenParentEnds?: boolean;
      kind?: SessionKind;
    } = {},
  ): Promise<RunningSession | null> {
    const first = this.services.workspace.root.peek();
    if (!first) throw new Error("Open a folder to debug.");
    // Extensions' resolvers, unless the run commands already ran them (D295); one that
    // cancels ends the launch quietly, as in VS Code.
    const resolved = given.resolved ? given : await this.resolveAll(given);
    if (!resolved) return null;
    // The configuration's own folder (D251): the browser's webRoot and profile, the adapter's cwd.
    const root = resolved.workspaceFolder ?? first;
    const { adapter, config } = await this.launchAdapter(resolved, opts.parentId);
    const rs = this.newSession(config, { ...opts, noDebug });
    rs.keepWhenParentEnds = opts.keepWhenParentEnds === true;
    this.add(rs, !opts.parentId);
    this.printFor(rs, {
      kind: "info",
      text: `${noDebug ? "Running" : "Debugging"} “${rs.name}”`,
    });
    const target: LaunchTarget = {
      setTerminal: (t) => {
        rs.terminal = t;
        this.children.watchServerReady(rs, t);
      },
      env: {},
      startDebugging: (configuration, request) =>
        this.children.startDebugging(rs, configuration, request),
    };
    try {
      let session: DebugSession;
      if (adapter.kind === "cdp") {
        const launcher = config.request === "launch" && isPackageManager(config.runtimeExecutable);
        // Child processes (and a package manager's scripts) register through the bootloader.
        if (
          !noDebug &&
          (launcher ||
            (config.request === "launch" && wantsChildAttach(config.raw, config.runtimeExecutable)))
        )
          target.env = await this.children.watchRegistrations(
            rs,
            rs.id,
            undefined,
            undefined,
            config.env,
          );
        if (launcher) {
          session = this.launchers.launcher(config, target);
          rs.kind = "launcher";
        } else if (noDebug) {
          session = this.launchers.process(config, target);
          rs.kind = "process";
        } else session = this.launchers.node(config, this.setupFor(rs), target);
      } else if (adapter.kind === "browser") {
        if (noDebug) throw new Error("A browser configuration runs with debugging: press F5.");
        session = this.launchers.browser(config, this.setupFor(rs), root, target);
      } else
        session = await this.launchers.dap(
          config,
          adapter,
          this.setupFor(rs),
          root,
          noDebug,
          target,
          rs.id,
        );
      await this.run(rs, session);
      return rs;
    } catch (err) {
      await rs.session?.stop().catch(() => {});
      // Stopped while starting: the failure is stop's doing.
      if (rs.stopRequested) return rs;
      this.ended(rs, true);
      throw err;
    }
  }

  /** Wires and starts `session` for `rs`; marks it running. */
  async run(rs: RunningSession, session: DebugSession): Promise<void> {
    if (rs.ended) {
      await session.stop().catch(() => {});
      return;
    }
    rs.session = session;
    this.wire(rs, session);
    this.attached.fire(rs);
    this.sync.markSent(rs);
    await session.start();
    if (rs.ended) return;
    rs.capabilities.value = session.capabilities();
    if (rs.state.peek() === "starting") rs.state.value = "running";
    if (rs.inspectable) {
      // Its process id (child processes find their parent session by it), and its threads.
      void this.refreshThreads(rs);
      // (A program busy at startup may answer late: don't hold the rest for it.)
      if (rs.pid === undefined)
        rs.pid =
          (await Promise.race([
            session.pid?.().catch(() => null) ?? Promise.resolve(null),
            new Promise<null>((r) => setTimeout(() => r(null), 2000)),
          ])) ?? undefined;
    }
    // Changes made while it started.
    this.sync.syncAll(rs);
  }

  private wire(rs: RunningSession, session: DebugSession): void {
    const s = rs.store;
    s.add(session.onStopped((e) => void this.onStopped(rs, e)));
    s.add(session.onContinued((e) => this.onContinued(rs, e)));
    s.add(
      session.onOutput((o) => {
        if (rs.ended) return;
        this.printFor(rs, {
          kind: "output",
          text: o.text,
          ...(o.category === "stderr" ? { stderr: true } : {}),
        });
        this.children.feedOutput(rs, o.text);
      }),
    );
    s.add(session.onBreakpoints(({ path, results }) => this.sync.placed(rs, path, results)));
    s.add(session.onTerminated(() => this.ended(rs)));
    if (session.onThread) s.add(session.onThread(() => void this.refreshThreads(rs)));
    if (session.onChild)
      s.add(session.onChild((child) => void this.children.startWorker(rs, child)));
    const fn = (
      session as { onFunctionBreakpoints?: (l: (v: boolean[]) => void) => { dispose(): void } }
    ).onFunctionBreakpoints;
    if (fn)
      s.add(fn((verified) => this.sync.functionsPlaced(verified.map((v) => ({ verified: v })))));
  }

  /**
   * The environment for a JavaScript debug terminal (D204): every Node program started in it is
   * debugged as its own session, while `alive()` (the terminal is open).
   */
  debugTerminalEnv(alive: () => boolean, store: DisposableStore): Promise<Record<string, string>> {
    return this.children.watchRegistrations(null, null, alive, store);
  }

  // ---- Stops, threads, frames ----

  private async onStopped(rs: RunningSession, e: StoppedEvent): Promise<void> {
    const session = rs.session;
    if (!session || rs.ended) return;
    // Breakpoints waiting for the one hit go out first, before anything can resume (VS Code's
    // order); without the debugger's ids, the stop's line says which once the stack is known.
    if (e.hitBreakpointIds?.length) this.trigger(rs, e, null);
    const resumes = this.resumeMark(rs, e.threadId);
    const stale = () => rs.ended || this.resumeMark(rs, e.threadId) !== resumes;
    const listed = await session.threads().catch(() => null);
    const frames = await session.stackTrace(e.threadId).catch(() => [] as StackFrame[]);
    if (stale()) return;
    if (!e.hitBreakpointIds?.length) this.trigger(rs, e, frames[0] ?? null);
    await this.dropTemporary(rs);
    const threads = threadsAfterStop(rs.threads.peek(), listed, e).map((t) =>
      t.id === e.threadId ? { ...t, frames } : t,
    );
    let exception = e.exception ?? null;
    if (!exception && e.reason === "exception" && session.exceptionInfo)
      exception = await session.exceptionInfo(e.threadId).catch(() => null);
    if (stale()) return;
    const first = Math.max(
      0,
      frames.findIndex((f) => f.path),
    );
    batch(() => {
      rs.threads.value = threads;
      rs.threadId.value = e.threadId;
      rs.frames.value = frames;
      rs.frameIndex.value = first;
      rs.stopInfo.value = {
        reason: e.reason,
        threadId: e.threadId,
        ...(e.text ? { text: e.text } : {}),
      };
      rs.exception.value = exception;
      rs.state.value = "stopped";
      // The session that stopped gets the focus (VS Code's).
      this.focusedId.value = rs.id;
    });
    if (e.reason === "exception" && (e.text || exception))
      this.printFor(rs, {
        kind: "error",
        text: `Paused on exception: ${e.text ?? exception?.description ?? exception?.exceptionId ?? ""}`,
      });
    await this.selectFrame(first, true, rs);
  }

  /** Sets the triggered breakpoints whose trigger `e` hit in `rs` (triggers.ts). */
  private trigger(rs: RunningSession, e: StoppedEvent, top: StackFrame | null): void {
    const list = this.breakpoints.list.peek();
    const hit = breakpointsHit(list, { ...e, path: top?.path ?? null, line: top?.line });
    const ids = triggeredBy(list, hit, rs.id);
    if (!ids.length) return;
    this.breakpoints.markTriggered(rs.id, ids);
    // (The breakpoint effect skips a session still starting: a stop can come before that ends.)
    void this.sync.sync(rs);
  }

  /** How often `threadId` of `rs` resumed (on its own or with all threads). */
  private resumeMark(rs: RunningSession, threadId: number): string {
    const r = this.resumes.get(rs);
    return `${r?.all ?? 0}:${r?.thread.get(threadId) ?? 0}`;
  }

  private onContinued(rs: RunningSession, e: { threadId?: number; all: boolean }): void {
    if (rs.ended) return;
    const r = this.resumes.get(rs) ?? { all: 0, thread: new Map<number, number>() };
    this.resumes.set(rs, r);
    if (e.all || e.threadId === undefined) r.all += 1;
    else r.thread.set(e.threadId, (r.thread.get(e.threadId) ?? 0) + 1);
    const threads = threadsAfterContinue(rs.threads.peek(), e);
    const current = rs.threadId.peek();
    const stillStopped = threads.find((t) => t.id === current)?.stopped === true;
    const other = threads.find((t) => t.stopped);
    batch(() => {
      rs.threads.value = threads;
      rs.state.value = other ? "stopped" : "running";
      if (!stillStopped) {
        rs.stopInfo.value = null;
        rs.frames.value = [];
        rs.scopes.value = [];
        rs.exception.value = null;
      }
    });
    // Another thread is still stopped: show it.
    if (!stillStopped && other) void this.selectThread(rs.id, other.id);
  }

  /** The debugger's thread list now (stopped states kept). */
  private async refreshThreads(rs: RunningSession): Promise<void> {
    const listed = await rs.session?.threads().catch(() => null);
    if (!listed || rs.ended) return;
    const known = rs.threads.peek();
    rs.threads.value = listed.map(
      (t) =>
        known.find((k) => k.id === t.id) ?? {
          id: t.id,
          name: t.name,
          stopped: false,
          frames: null,
        },
    );
    if (rs.threadId.peek() === null) rs.threadId.value = pickThread(rs.threads.peek(), null);
  }

  /** Shows thread `threadId` of session `id`: its stack (loaded when stopped), its top frame. */
  async selectThread(id: string, threadId: number): Promise<void> {
    const rs = this.sessionFor(id);
    const session = rs.session;
    const thread = rs.threads.peek().find((t) => t.id === threadId);
    if (!thread) throw new Error(`No thread ${threadId} in “${rs.name}”.`);
    batch(() => {
      this.focusedId.value = rs.id;
      rs.threadId.value = threadId;
    });
    if (!thread.stopped || !session) {
      batch(() => {
        rs.frames.value = [];
        rs.scopes.value = [];
        rs.stopInfo.value = null;
      });
      return;
    }
    const frames = thread.frames ?? (await session.stackTrace(threadId).catch(() => []));
    if (rs.ended || rs.threadId.peek() !== threadId) return;
    const first = Math.max(
      0,
      frames.findIndex((f) => f.path),
    );
    batch(() => {
      rs.threads.value = rs.threads.peek().map((t) => (t.id === threadId ? { ...t, frames } : t));
      rs.frames.value = frames;
      rs.frameIndex.value = first;
      rs.stopInfo.value = {
        reason: thread.reason ?? "pause",
        threadId,
        ...(thread.text ? { text: thread.text } : {}),
      };
    });
    await this.selectFrame(first, true, rs);
  }

  /** The thread's stack, loaded for the call stack when its row opens. */
  async loadThreadFrames(id: string, threadId: number): Promise<void> {
    const rs = this.session(id);
    const thread = rs?.threads.peek().find((t) => t.id === threadId);
    if (!rs?.session || !thread?.stopped || thread.frames) return;
    const frames = await rs.session.stackTrace(threadId).catch(() => []);
    if (rs.ended) return;
    rs.threads.value = rs.threads.peek().map((t) => (t.id === threadId ? { ...t, frames } : t));
  }

  /** Focuses session `id` (the toolbar, console and Variables follow it). */
  focus(id: string): void {
    const rs = this.sessionFor(id);
    this.focusedId.value = rs.id;
  }

  /** Shows frame `index` of the focused session (or `rs`): its line, its scopes in Variables. */
  async selectFrame(index: number, reveal = true, rs = this.focused.peek()): Promise<void> {
    const frame = rs?.frames.peek()[index];
    const session = rs?.session;
    if (!rs || !frame || !session) return;
    rs.frameIndex.value = index;
    if (reveal && frame.path)
      await this.services.dispatcher
        .execute("editor.openFile", { path: frame.path, line: frame.line, column: frame.column })
        .catch(() => {});
    const scopes = await session.scopes(frame.id).catch(() => []);
    if (!rs.ended && rs.frameIndex.peek() === index && rs.frames.peek()[index] === frame) {
      rs.scopes.value = scopes;
      this.frameVersion.value = this.frameVersion.peek() + 1;
    }
  }

  /** The focused session's selected frame id while stopped (evaluations run there). */
  frameId(): number | undefined {
    const rs = this.focused.peek();
    return rs && rs.state.peek() === "stopped"
      ? rs.frames.peek()[rs.frameIndex.peek()]?.id
      : undefined;
  }

  /** The thread commands act on in `rs`. */
  private thread(rs: RunningSession): number {
    return rs.threadId.peek() ?? rs.stopInfo.peek()?.threadId ?? rs.threads.peek()[0]?.id ?? 1;
  }

  /** Runs to `line` of `path` (VS Code's "Run to cursor"), then stops there. */
  async runTo(path: string, line: number): Promise<void> {
    const rs = this.sessionFor();
    const session = rs.session;
    if (!session || rs.state.peek() !== "stopped") throw new Error("The program isn't paused.");
    await rs.syncing;
    if (session.runTo && (await session.runTo(this.thread(rs), path, line))) return;
    // A temporary breakpoint beside the file's own, removed at the next stop.
    const list = this.sync.enabledByPath(rs).get(path) ?? [];
    if (!list.some((b) => b.line === line)) {
      await session.setBreakpoints(path, [...list, { line }]);
      rs.temporary = path;
    }
    await session.resume(this.thread(rs));
  }

  /** The file a temporary breakpoint was added to gets its own breakpoints back. */
  private async dropTemporary(rs: RunningSession): Promise<void> {
    const path = rs.temporary;
    if (!path) return;
    rs.temporary = null;
    rs.sent.delete(path);
    await this.sync.sync(rs);
  }

  /** Sets a variable (of a scope or an object, `container`) to an expression's value. */
  async setVariable(container: number, name: string, expression: string) {
    const rs = this.sessionFor();
    if (!rs.session || rs.state.peek() !== "stopped") throw new Error("The program isn't paused.");
    const r = await rs.session.setVariable(container, name, expression, this.frameId());
    // Values shown elsewhere may depend on it.
    this.frameVersion.value = this.frameVersion.peek() + 1;
    return r;
  }

  /**
   * Continue, step or pause: the focused session's selected thread, or `opts`' session and
   * thread (a row of the call stack). Steps go by instruction while the disassembly view has
   * the focus (`instructionStepping`) or with `granularity`, where the debugger can.
   */
  async step(
    how: "resume" | "next" | "stepIn" | "stepOut" | "pause",
    opts: { session?: string; threadId?: number; granularity?: SteppingGranularity } = {},
  ): Promise<void> {
    const rs = this.sessionFor(opts.session);
    const session = rs.session;
    if (!session) throw new Error(`“${rs.name}” is still starting.`);
    const threadId = opts.threadId ?? this.thread(rs);
    const thread = rs.threads.peek().find((t) => t.id === threadId);
    if (how === "pause") {
      if (thread ? thread.stopped : rs.state.peek() !== "running") return;
      await session.pause(threadId);
      return;
    }
    if (thread ? !thread.stopped : rs.state.peek() !== "stopped")
      throw new Error("The program isn't paused.");
    await rs.syncing;
    if (how === "resume") {
      await session.resume(threadId);
      return;
    }
    const granularity =
      opts.granularity ?? (this.instructionStepping.peek() ? "instruction" : undefined);
    await session[how](threadId, granularity);
  }

  /**
   * The calls on the line session `id` (default: the focused one) stopped at, to step into one
   * (VS Code's Step into target): asked for its top frame.
   */
  async stepInTargets(id?: string): Promise<StepInTarget[]> {
    const rs = this.sessionFor(id);
    const session = rs.session;
    if (!session?.stepInTargets || !rs.capabilities.peek().stepInTargets)
      throw new Error(
        `This debugger (${rs.config.type}) can't list step-in targets. Debug adapters that report supportsStepInTargetsRequest can (debugpy, lldb-dap, GDB).`,
      );
    if (rs.state.peek() !== "stopped") throw new Error("The program isn't paused.");
    const frame = rs.frames.peek()[0];
    return frame ? session.stepInTargets(frame.id) : [];
  }

  /** Steps into target `targetId` (from `stepInTargets`) on session `id`'s stopped thread. */
  async stepInTarget(targetId: number, id?: string): Promise<void> {
    const rs = this.sessionFor(id);
    const session = rs.session;
    if (!session?.stepInTarget || !rs.capabilities.peek().stepInTargets)
      throw new Error(`This debugger (${rs.config.type}) can't step into a chosen call.`);
    if (rs.state.peek() !== "stopped") throw new Error("The program isn't paused.");
    await rs.syncing;
    await session.stepInTarget(this.thread(rs), targetId);
  }

  /**
   * Runs frame `index` of a stopped thread again from its start (VS Code's Restart frame):
   * the focused session's selected thread, or `opts`' session and thread.
   */
  async restartFrame(
    index: number,
    opts: { session?: string; threadId?: number } = {},
  ): Promise<StackFrame> {
    const rs = this.sessionFor(opts.session);
    const session = rs.session;
    if (!session?.restartFrame || !rs.capabilities.peek().restartFrame)
      throw new Error(
        `This debugger (${rs.config.type}) can't restart frames. Node and browsers can, and debug adapters that report supportsRestartFrame.`,
      );
    const threadId = opts.threadId ?? this.thread(rs);
    const thread = rs.threads.peek().find((t) => t.id === threadId);
    if (thread ? !thread.stopped : rs.state.peek() !== "stopped")
      throw new Error("The program isn't paused.");
    const frames = threadId === rs.threadId.peek() ? rs.frames.peek() : (thread?.frames ?? []);
    const frame = frames[index];
    if (!frame) throw new Error(`No frame ${index} in the call stack.`);
    if (frame.canRestart === false) throw new Error(`“${frame.name}” can't be restarted.`);
    await rs.syncing;
    await session.restartFrame(threadId, frame.id);
    return frame;
  }

  /** Evaluates in session `id` (default: the focused one), in its selected frame while paused. */
  async evaluate(expression: string, id?: string): Promise<{ value: string; ref: number }> {
    const rs = this.sessionFor(id);
    if (!rs.session) throw new Error(`“${rs.name}” is still starting.`);
    const frame =
      rs.state.peek() === "stopped" ? rs.frames.peek()[rs.frameIndex.peek()]?.id : undefined;
    return rs.session.evaluate(expression, frame);
  }

  /** A data breakpoint on `name` of `container` (a scope's or object's ref) in the focused session. */
  async addDataBreakpoint(
    container: number,
    name: string,
    accessType: "read" | "write" | "readWrite" = "write",
  ) {
    const rs = this.sessionFor();
    const session = rs.session;
    if (!session?.dataBreakpointInfo || !rs.capabilities.peek().dataBreakpoints)
      throw new Error(
        `This debugger (${rs.config.type}) can't break on value changes. Debug adapters that can: lldb-dap, GDB, and others that report supportsDataBreakpoints.`,
      );
    const info = await session.dataBreakpointInfo(container, name, this.frameId());
    if (!info.dataId) throw new Error(info.description || `“${name}” can't be watched.`);
    const types = info.accessTypes ?? ["write"];
    const type = (types.includes(accessType) ? accessType : (types[0] ?? "write")) as
      | "read"
      | "write"
      | "readWrite";
    return this.other.addData({
      dataId: info.dataId,
      description: info.description,
      accessType: type,
      sessionId: rs.id,
    });
  }

  // ---- Stopping ----

  /**
   * Stops session `id` (default: the focused one), its children, and its compound with stopAll.
   * `alone`: not the rest of its compound (a restart of one session leaves the others running).
   */
  async stop(id?: string, opts: { alone?: boolean } = {}): Promise<void> {
    const list = this.sessions.peek();
    if (!list.length) return;
    const start = id === undefined ? this.focused.peek() : this.sessionFor(id);
    if (!start) return;
    const ids = sessionsToStop(
      start.id,
      list,
      (c) => !opts.alone && (this.compounds.get(c)?.stopAll ?? false),
    );
    // Children first: a parent's end would otherwise cut them off without a stop.
    await Promise.all(
      ids
        .reverse()
        .map((sid) => this.session(sid))
        .filter((rs): rs is RunningSession => rs !== undefined)
        .map((rs) => this.stopOne(rs)),
    );
  }

  /** Stops every session. */
  async stopAll(): Promise<void> {
    await Promise.all(this.sessions.peek().map((rs) => this.stopOne(rs)));
  }

  private async stopOne(rs: RunningSession): Promise<void> {
    if (rs.ended) return;
    rs.ended = true;
    rs.stopRequested = true;
    const session = rs.session;
    this.ended(rs, false, true);
    await session?.stop().catch(() => {});
  }

  /** `rs` ended: it leaves the list, its children end with it, focus moves on. */
  ended(rs: RunningSession, failed = false, stopped = false): void {
    if (!this.sessions.peek().includes(rs)) return;
    rs.ended = true;
    rs.store.dispose();
    const children = this.sessions.peek().filter((c) => c.parentId === rs.id);
    const keys = [...rs.placed.keys()];
    batch(() => {
      this.sessions.value = this.sessions.peek().filter((s) => s !== rs);
      for (const c of children) if (c.keepWhenParentEnds) c.parentId = null;
      if (this.focusedId.peek() === rs.id)
        this.focusedId.value = focusAfter(
          [rs, ...this.sessions.peek()].map((s) => ({
            id: s.id,
            parentId: s.parentId,
            stopped: s.state.peek() === "stopped",
          })),
          rs.id,
        );
      this.other.sessionEnded(rs.id);
      this.breakpoints.sessionEnded(rs.id);
      if (!this.sessions.peek().length) {
        this.breakpoints.clearVerification();
        this.other.clearVerification();
      } else for (const key of keys) this.sync.verify(key);
    });
    for (const c of children) if (!c.keepWhenParentEnds) void this.stopOne(c);
    if (rs.compound && !this.sessions.peek().some((s) => s.compound === rs.compound))
      this.compounds.delete(rs.compound);
    if (!failed || stopped)
      this.printFor(rs, {
        kind: "info",
        text:
          this.sessions.peek().length || rs.parentId
            ? `Session ended: ${rs.name}`
            : "Session ended",
      });
    // postDebugTask: after a top-level session the user started.
    if (!failed && !rs.parentId && rs.config.postDebugTask && rs.kind !== "child")
      void this.hooks
        .runTask(rs.config.postDebugTask, rs.config.workspaceFolder)
        .catch((err: unknown) =>
          this.print({
            kind: "error",
            text: `postDebugTask "${rs.config.postDebugTask}": ${err instanceof Error ? err.message : String(err)}`,
          }),
        );
  }
}

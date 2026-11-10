// A debug session (D143): what the IDE asks of any debugger — run, stop at breakpoints, step,
// show the call stack and variables, evaluate — and the Debug Adapter Protocol implementation of
// it (`DapSession`), for adapters spoken to over stdio (debugpy, lldb-dap, gdb, custom ones).
// Node runs through its own inspector instead (cdp.ts), behind the same interface. DOM-free.
import { Emitter, type Event } from "../../core/events/index";
import type { Transport } from "../../core/lsp/jsonrpc";
import {
  type ExceptionDetails,
  type ExceptionFilter,
  fromDapExceptionInfo,
  parseExceptionFilters,
} from "./exceptionInfo";

export interface SourceBreakpoint {
  /**
   * The IDE's breakpoint id (not sent to the debugger): a stop's `hitBreakpointIds` name the
   * breakpoints by it (triggered breakpoints wait for one, triggers.ts).
   */
  id?: number;
  line: number;
  condition?: string;
  /** "5", ">5", "%3"… (breakpoints.ts `parseHitCondition`). */
  hitCondition?: string;
  /** A logpoint's message, `{expression}`s filled in. */
  logMessage?: string;
}

/** Which exceptions stop the program. */
export interface ExceptionStops {
  uncaught: boolean;
  /** Every exception, caught or not. */
  caught: boolean;
}

export interface BreakpointResult {
  verified: boolean;
  /** Where it was placed (may differ from the line asked for). */
  line?: number;
  message?: string;
}

export interface StackFrame {
  id: number;
  name: string;
  /** Absolute path; null for code without a file (internals, eval). */
  path: string | null;
  line: number;
  column: number;
  /** Where its instruction is (native debuggers; the disassembly starts there). */
  instructionPointerReference?: string;
  /** False when the debugger says this frame can't be restarted (DAP `canRestart`). */
  canRestart?: boolean;
}

/** A call the debugger can step into from the current line (DAP `StepInTarget`). */
export interface StepInTarget {
  id: number;
  label: string;
  /** Where the call is, when the debugger says (1-based). */
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

/** A function breakpoint (DAP `setFunctionBreakpoints`; Node: by the function's name). */
export interface FunctionBreakpointSpec {
  name: string;
  condition?: string;
  hitCondition?: string;
}

/** A data breakpoint: stop when a value changes (DAP `setDataBreakpoints`). */
export interface DataBreakpointSpec {
  dataId: string;
  accessType?: "read" | "write" | "readWrite";
  condition?: string;
  hitCondition?: string;
}

/** What the debugger can do beyond the basics (DAP capabilities; fixed for Node). */
export interface DebugCapabilities {
  functionBreakpoints: boolean;
  dataBreakpoints: boolean;
  exceptionInfo: boolean;
  /** The adapter's own exception filters (empty: caught / uncaught as for Node). */
  exceptionFilters: ExceptionFilter[];
  /** Filters take conditions (`filterOptions`). */
  exceptionFilterOptions: boolean;
  loadedSources: boolean;
  disassemble: boolean;
  /** `setInstructionBreakpoints` (the disassembly view's breakpoints). */
  instructionBreakpoints: boolean;
  /** Steps by instruction (`granularity: "instruction"`), for the disassembly view. */
  steppingGranularity: boolean;
  /** Lists the calls on the current line to step into one (`supportsStepInTargetsRequest`). */
  stepInTargets: boolean;
  /** Runs a frame again from its start (`supportsRestartFrame`). */
  restartFrame: boolean;
}

export const NO_CAPABILITIES: DebugCapabilities = {
  functionBreakpoints: false,
  dataBreakpoints: false,
  exceptionInfo: false,
  exceptionFilters: [],
  exceptionFilterOptions: false,
  loadedSources: false,
  disassemble: false,
  instructionBreakpoints: false,
  steppingGranularity: false,
  stepInTargets: false,
  restartFrame: false,
};

/** How far a step goes: a statement (default), a line, or one machine instruction. */
export type SteppingGranularity = "statement" | "line" | "instruction";

export interface LoadedSource {
  name: string;
  /** Absolute path, or null (internal / generated). */
  path: string | null;
  /** Where it came from (a URL, "node:internal…"), for sources without a file. */
  origin?: string;
}

export interface Instruction {
  address: string;
  instruction: string;
  bytes?: string;
  symbol?: string;
  /** Source position, when the adapter knows it. */
  path?: string;
  line?: number;
}

/** Another target a session found (a Node worker thread): debugged as a child session. */
export interface ChildTarget {
  name: string;
  /** Connects to it; messages and the end come through the callbacks. */
  connect(
    onMessage: (body: string) => void,
    onClose: (reason: string) => void,
  ): { send(body: string): void; close(): void };
}

export interface Scope {
  name: string;
  ref: number;
  /** Loaded only when opened (globals). */
  expensive: boolean;
  /** The lines it covers in the frame's file, when the debugger says (1-based). */
  line?: number;
  endLine?: number;
}

export interface Variable {
  name: string;
  value: string;
  type?: string;
  /** > 0: has children (`variables(ref)`). */
  ref: number;
}

export interface StoppedEvent {
  reason: string;
  threadId: number;
  description?: string;
  /** An exception's message. */
  text?: string;
  /** Every thread stopped (DAP `allThreadsStopped`). */
  allThreadsStopped?: boolean;
  /** What was thrown, when the debugger said with the stop (Node's inspector). */
  exception?: ExceptionDetails;
  /** The IDE's ids (`SourceBreakpoint.id`) of the breakpoints that were hit (DAP `hitBreakpointIds`). */
  hitBreakpointIds?: number[];
}

/** Running again: one thread, or all of them (DAP's default). */
export interface ContinuedEvent {
  threadId?: number;
  all: boolean;
}

export interface OutputEvent {
  category: "stdout" | "stderr" | "console" | "important";
  text: string;
}

export interface DebugSession {
  readonly onStopped: Event<StoppedEvent>;
  readonly onContinued: Event<ContinuedEvent>;
  /** A thread started or exited (DAP `thread`). */
  readonly onThread?: Event<{ reason: string; threadId: number }>;
  /** A worker thread to debug as a child session (Node). */
  readonly onChild?: Event<ChildTarget>;
  readonly onOutput: Event<OutputEvent>;
  /** The debuggee ended or the connection closed (fires once). */
  readonly onTerminated: Event<void>;
  /** The debugger placed (or moved) breakpoints of `path` after they were set. */
  readonly onBreakpoints: Event<{ path: string; results: BreakpointResult[] }>;
  /**
   * An event the Debug Adapter Protocol doesn't define (the adapter's own: debugpy's
   * `debugpyAttach`, Jupyter's kernel debugger's): VS Code's onDidReceiveDebugSessionCustomEvent.
   */
  readonly onCustomEvent?: Event<{ event: string; body: Record<string, unknown> }>;

  /** Starts the debuggee; breakpoints and exception settings are sent before it runs. */
  start(): Promise<void>;
  setBreakpoints(path: string, breakpoints: SourceBreakpoint[]): Promise<BreakpointResult[]>;
  setExceptionStops(stops: ExceptionStops): Promise<void>;
  threads(): Promise<{ id: number; name: string }[]>;
  stackTrace(threadId: number): Promise<StackFrame[]>;
  scopes(frameId: number): Promise<Scope[]>;
  variables(ref: number): Promise<Variable[]>;
  /** Sets variable `name` of scope or object `container` to the value of `expression`. */
  setVariable(
    container: number,
    name: string,
    expression: string,
    frameId?: number,
  ): Promise<{ value: string; ref: number }>;
  /**
   * Runs to `line` of `path` and stops there (VS Code's "Run to cursor"); false when the
   * debugger can't do it itself (the controller then uses a temporary breakpoint).
   */
  runTo?(threadId: number, path: string, line: number): Promise<boolean>;
  /**
   * Evaluates in the frame (stopped) or globally; throws with the error's text. `context`:
   * typed in the console ("repl", default), a watch, or a hover.
   */
  evaluate(
    expression: string,
    frameId?: number,
    context?: "repl" | "watch" | "hover",
  ): Promise<{ value: string; ref: number }>;
  resume(threadId: number): Promise<void>;
  /** `granularity`: where the debugger supports it (`steppingGranularity`); else ignored. */
  next(threadId: number, granularity?: SteppingGranularity): Promise<void>;
  stepIn(threadId: number, granularity?: SteppingGranularity): Promise<void>;
  stepOut(threadId: number, granularity?: SteppingGranularity): Promise<void>;
  /** The calls of frame `frameId`'s line to step into (`capabilities().stepInTargets`). */
  stepInTargets?(frameId: number): Promise<StepInTarget[]>;
  /** Steps into one of `stepInTargets`' calls. */
  stepInTarget?(threadId: number, targetId: number): Promise<void>;
  /** Runs frame `frameId` again from its start (`capabilities().restartFrame`). */
  restartFrame?(threadId: number, frameId: number): Promise<void>;
  pause(threadId: number): Promise<void>;
  /** Ends the debuggee and the session. */
  stop(): Promise<void>;
  /** A DAP request of the caller's (D255, VS Code's customRequest); DAP debuggers only. */
  customRequest?(command: string, args: Record<string, unknown>): Promise<unknown>;

  // ---- D204: what DebugCapabilities says the debugger supports ----
  capabilities(): DebugCapabilities;
  setFunctionBreakpoints?(list: FunctionBreakpointSpec[]): Promise<BreakpointResult[]>;
  /** Whether `name` in `container` (a scope's or object's ref) can have a data breakpoint. */
  dataBreakpointInfo?(
    container: number,
    name: string,
    frameId?: number,
  ): Promise<{ dataId: string | null; description: string; accessTypes?: string[] }>;
  setDataBreakpoints?(list: DataBreakpointSpec[]): Promise<BreakpointResult[]>;
  /** Breakpoints on instructions, by address (the whole list each time, as DAP's). */
  setInstructionBreakpoints?(list: { instructionReference: string }[]): Promise<BreakpointResult[]>;
  /** What was thrown, while stopped on an exception. */
  exceptionInfo?(threadId: number): Promise<ExceptionDetails | null>;
  /** The adapter's exception filters on (instead of setExceptionStops). */
  setExceptionFilters?(args: ExceptionFilterArgs): Promise<void>;
  loadedSources?(): Promise<LoadedSource[]>;
  disassemble?(
    memoryReference: string,
    instructionOffset: number,
    count: number,
  ): Promise<Instruction[]>;
  /** The debuggee's process id, when known (Node: asked once it runs). */
  pid?(): Promise<number | null>;
}

/** DAP `setExceptionBreakpoints` arguments. */
export interface ExceptionFilterArgs {
  filters: string[];
  filterOptions?: { filterId: string; condition?: string }[];
}

/** How a session gets what it needs before the debuggee runs. */
export interface SessionSetup {
  /** Every breakpoint to set, by absolute path. */
  breakpoints(): ReadonlyMap<string, SourceBreakpoint[]>;
  exceptionStops(): ExceptionStops;
  /** Function breakpoints (D204). */
  functionBreakpoints?(): FunctionBreakpointSpec[];
  /** The adapter's exception filters to turn on, once its capabilities are known (null: none). */
  exceptionFilters?(caps: DebugCapabilities): ExceptionFilterArgs | null;
}

// ---- Debug Adapter Protocol -------------------------------------------------------------------

interface DapMessage {
  seq: number;
  type: "request" | "response" | "event";
  command?: string;
  event?: string;
  request_seq?: number;
  success?: boolean;
  message?: string;
  body?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
}

/** Requests the adapter sends us (`runInTerminal`, `startDebugging`). */
export type ReverseRequestHandler = (
  command: string,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export class DapConnection {
  private seq = 1;
  private readonly pending = new Map<
    number,
    { resolve(b: Record<string, unknown>): void; reject(e: Error): void; command: string }
  >();
  private readonly events = new Emitter<{ event: string; body: Record<string, unknown> }>();
  readonly onEvent = this.events.event;
  private closed = false;

  constructor(
    private readonly transport: Transport,
    private readonly reverse: ReverseRequestHandler,
  ) {
    transport.onMessage((body) => this.receive(body));
  }

  request<T = Record<string, unknown>>(
    command: string,
    args?: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("The debugger isn't running."));
    const seq = this.seq++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`The debugger didn't answer "${command}".`));
      }, timeoutMs);
      this.pending.set(seq, {
        command,
        resolve: (b) => {
          clearTimeout(timer);
          resolve(b as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.write({
        seq,
        type: "request",
        command,
        ...(args === undefined ? {} : { arguments: args }),
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error("The debugger stopped."));
    this.pending.clear();
    this.events.dispose();
  }

  private write(message: Omit<DapMessage, "seq"> & { seq?: number }): void {
    if (this.closed) return;
    this.transport.send(JSON.stringify({ seq: message.seq ?? this.seq++, ...message }));
  }

  private receive(body: string): void {
    let msg: DapMessage;
    try {
      msg = JSON.parse(body) as DapMessage;
    } catch {
      return;
    }
    if (msg.type === "response" && msg.request_seq !== undefined) {
      const p = this.pending.get(msg.request_seq);
      if (!p) return;
      this.pending.delete(msg.request_seq);
      if (msg.success) p.resolve(msg.body ?? {});
      else {
        const format = (msg.body?.error as { format?: string } | undefined)?.format;
        p.reject(new Error(format ?? msg.message ?? `${p.command} failed`));
      }
    } else if (msg.type === "event" && msg.event) {
      this.events.fire({ event: msg.event, body: msg.body ?? {} });
    } else if (msg.type === "request" && msg.command) {
      const command = msg.command;
      this.reverse(command, msg.arguments ?? {}).then(
        (b) =>
          this.write({
            type: "response",
            request_seq: msg.seq,
            command,
            success: true,
            body: b,
          }),
        (err: unknown) =>
          this.write({
            type: "response",
            request_seq: msg.seq,
            command,
            success: false,
            message: err instanceof Error ? err.message : String(err),
          }),
      );
    }
  }
}

const OUTPUT_CATEGORIES = new Set(["stdout", "stderr", "console", "important"]);

/** The events the Debug Adapter Protocol defines: any other is the adapter's own (custom). */
export const DAP_EVENTS: ReadonlySet<string> = new Set([
  "initialized",
  "stopped",
  "continued",
  "exited",
  "terminated",
  "thread",
  "output",
  "breakpoint",
  "module",
  "loadedSource",
  "process",
  "capabilities",
  "progressStart",
  "progressUpdate",
  "progressEnd",
  "invalidated",
  "memory",
]);

export class DapSession implements DebugSession {
  private readonly stopped = new Emitter<StoppedEvent>();
  readonly onStopped = this.stopped.event;
  private readonly continued = new Emitter<ContinuedEvent>();
  readonly onContinued = this.continued.event;
  private readonly threadEvents = new Emitter<{ reason: string; threadId: number }>();
  readonly onThread = this.threadEvents.event;
  private readonly output = new Emitter<OutputEvent>();
  readonly onOutput = this.output.event;
  private readonly terminated = new Emitter<void>();
  readonly onTerminated = this.terminated.event;
  private readonly bpEvents = new Emitter<{ path: string; results: BreakpointResult[] }>();
  readonly onBreakpoints = this.bpEvents.event;
  private readonly customEvents = new Emitter<{ event: string; body: Record<string, unknown> }>();
  readonly onCustomEvent = this.customEvents.event;
  private caps: Record<string, unknown> = {};
  private ended = false;
  /** Breakpoint ids the adapter gave, per path (for `breakpoint` events). */
  private readonly ids = new Map<number, string>();
  /** The adapter's breakpoint ids → the IDE's (`SourceBreakpoint.id`), for `hitBreakpointIds`. */
  private readonly clientIds = new Map<number, number>();
  /** The latest results per path, with their ids, so a `breakpoint` event can update one. */
  private readonly placed = new Map<string, { id?: number; result: BreakpointResult }[]>();

  customRequest(command: string, args: Record<string, unknown>): Promise<unknown> {
    return this.dap.request(command, args);
  }

  constructor(
    private readonly dap: DapConnection,
    private readonly options: {
      adapterId: string;
      request: "launch" | "attach";
      arguments: Record<string, unknown>;
      setup: SessionSetup;
      /** Ends the adapter process. */
      kill(): Promise<void>;
      /** The client answers `startDebugging` (child sessions; launchers.ts handles it). */
      startDebugging?: boolean;
    },
  ) {
    dap.onEvent(({ event, body }) => this.handle(event, body));
  }

  /** The adapter process ended. */
  adapterExited(): void {
    this.end();
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    this.dap.close();
    this.terminated.fire();
  }

  private handle(event: string, body: Record<string, unknown>): void {
    if (!DAP_EVENTS.has(event)) {
      this.customEvents.fire({ event, body });
      return;
    }
    switch (event) {
      case "stopped":
        this.stopped.fire({
          reason: String(body.reason ?? "pause"),
          threadId: Number(body.threadId ?? 0),
          ...(typeof body.description === "string" ? { description: body.description } : {}),
          ...(typeof body.text === "string" ? { text: body.text } : {}),
          ...(body.allThreadsStopped === true ? { allThreadsStopped: true } : {}),
          ...this.hitIds(body.hitBreakpointIds),
        });
        break;
      case "continued":
        this.continued.fire({
          ...(typeof body.threadId === "number" ? { threadId: body.threadId } : {}),
          all: body.allThreadsContinued !== false,
        });
        break;
      case "thread":
        if (typeof body.threadId === "number")
          this.threadEvents.fire({ reason: String(body.reason ?? ""), threadId: body.threadId });
        break;
      case "output": {
        const category = String(body.category ?? "console");
        if (category === "telemetry") break;
        this.output.fire({
          category: (OUTPUT_CATEGORIES.has(category)
            ? category
            : "console") as OutputEvent["category"],
          text: String(body.output ?? ""),
        });
        break;
      }
      case "breakpoint": {
        const bp = body.breakpoint as
          | { id?: number; verified?: boolean; line?: number; message?: string }
          | undefined;
        if (bp?.id !== undefined) this.updateBreakpoint(bp.id, body.reason, bp);
        break;
      }
      case "terminated":
      case "exited":
        if (event === "terminated") {
          void this.dap.request("disconnect", { terminateDebuggee: true }, 2000).catch(() => {});
          this.end();
          void this.options.kill();
        }
        break;
    }
  }

  /**
   * Applies a `breakpoint` event to the one breakpoint it names. Re-sending the file's list
   * instead made some adapters answer with another event, and so on forever.
   */
  private updateBreakpoint(
    id: number,
    reason: unknown,
    bp: { verified?: boolean; line?: number; message?: string },
  ): void {
    const path = this.ids.get(id);
    const placed = path !== undefined ? this.placed.get(path) : undefined;
    if (path === undefined || !placed) return;
    const at = placed.findIndex((p) => p.id === id);
    const old = placed[at];
    if (!old) return;
    // Keep the list aligned with the file's breakpoints: a removed one just stops being verified.
    const line = bp.line ?? old.result.line;
    const result: BreakpointResult =
      reason === "removed"
        ? { verified: false }
        : {
            verified: bp.verified ?? old.result.verified,
            ...(line !== undefined ? { line } : {}),
            ...(bp.message ? { message: bp.message } : {}),
          };
    placed[at] = { id, result };
    this.bpEvents.fire({ path, results: placed.map((p) => p.result) });
  }

  /** The adapter's hit breakpoint ids as the IDE's (those it knows). */
  private hitIds(raw: unknown): { hitBreakpointIds?: number[] } {
    if (!Array.isArray(raw)) return {};
    const ids = raw
      .map((id) => (typeof id === "number" ? this.clientIds.get(id) : undefined))
      .filter((id): id is number => id !== undefined);
    return ids.length ? { hitBreakpointIds: ids } : {};
  }

  capabilities(): DebugCapabilities {
    const c = this.caps;
    return {
      functionBreakpoints: c.supportsFunctionBreakpoints === true,
      dataBreakpoints: c.supportsDataBreakpoints === true,
      exceptionInfo: c.supportsExceptionInfoRequest === true,
      exceptionFilters: parseExceptionFilters(c.exceptionBreakpointFilters),
      exceptionFilterOptions: c.supportsExceptionFilterOptions === true,
      loadedSources: c.supportsLoadedSourcesRequest === true,
      disassemble: c.supportsDisassembleRequest === true,
      instructionBreakpoints: c.supportsInstructionBreakpoints === true,
      steppingGranularity: c.supportsSteppingGranularity === true,
      stepInTargets: c.supportsStepInTargetsRequest === true,
      restartFrame: c.supportsRestartFrame === true,
    };
  }

  async start(): Promise<void> {
    // Settles on `initialized`, or fails if the adapter ends first: one that answers launch and
    // then exits would otherwise leave start() (and debug.start) waiting forever. Listened for
    // before `initialize` goes out: the event can arrive in the same tick as its answer (or, from
    // some adapters, before it), and a listener added after the await missed it and hung.
    const initialized = new Promise<void>((resolve, reject) => {
      if (this.ended) {
        reject(new Error("The debug adapter ended before it was ready."));
        return;
      }
      const done = (): void => {
        sub.dispose();
        endSub.dispose();
      };
      const sub = this.dap.onEvent(({ event }) => {
        if (event !== "initialized") return;
        done();
        resolve();
      });
      const endSub = this.onTerminated(() => {
        done();
        reject(new Error("The debug adapter ended before it was ready."));
      });
    });
    // Handled through the race below; this keeps an unawaited rejection from being reported.
    initialized.catch(() => {});
    this.caps = await this.dap.request("initialize", {
      clientID: "ide",
      clientName: "IDE",
      adapterID: this.options.adapterId,
      locale: "en",
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: "path",
      supportsVariableType: true,
      supportsRunInTerminalRequest: true,
      supportsProgressReporting: false,
      supportsStartDebuggingRequest: this.options.startDebugging === true,
    });
    // Some adapters answer launch only after configurationDone: don't wait for it yet.
    const launched = this.dap.request(
      this.options.request,
      this.options.arguments,
      // Launching can take a while (building, a slow interpreter).
      120_000,
    );
    let launchError: Error | null = null;
    launched.catch((e: Error) => {
      launchError = e;
    });
    await Promise.race([initialized, launched.then(() => initialized)]);
    if (launchError) throw launchError;
    for (const [path, list] of this.options.setup.breakpoints())
      await this.setBreakpoints(path, list).catch(() => {});
    const fns = this.options.setup.functionBreakpoints?.() ?? [];
    if (fns.length && this.caps.supportsFunctionBreakpoints)
      await this.setFunctionBreakpoints(fns).catch(() => {});
    const filters = this.options.setup.exceptionFilters?.(this.capabilities());
    if (filters) await this.setExceptionFilters(filters).catch(() => {});
    else await this.setExceptionStops(this.options.setup.exceptionStops()).catch(() => {});
    if (this.caps.supportsConfigurationDoneRequest) await this.dap.request("configurationDone");
    await launched;
  }

  async setBreakpoints(path: string, breakpoints: SourceBreakpoint[]): Promise<BreakpointResult[]> {
    const caps = this.caps;
    const body = await this.dap.request<{
      breakpoints?: { id?: number; verified?: boolean; line?: number; message?: string }[];
    }>("setBreakpoints", {
      source: { path, name: path.split(/[\\/]/).pop() },
      breakpoints: breakpoints.map((b) => ({
        line: b.line,
        ...(caps.supportsConditionalBreakpoints && b.condition ? { condition: b.condition } : {}),
        ...(caps.supportsHitConditionalBreakpoints && b.hitCondition
          ? { hitCondition: b.hitCondition }
          : {}),
        ...(caps.supportsLogPoints && b.logMessage ? { logMessage: b.logMessage } : {}),
      })),
      lines: breakpoints.map((b) => b.line),
    });
    // The file's old ids are gone with its old breakpoints; forget them so the map doesn't grow.
    for (const [id, owner] of this.ids)
      if (owner === path) {
        this.ids.delete(id);
        this.clientIds.delete(id);
      }
    const placed = (body.breakpoints ?? []).map((b, i) => {
      if (b.id !== undefined) {
        this.ids.set(b.id, path);
        const own = breakpoints[i]?.id;
        if (own !== undefined) this.clientIds.set(b.id, own);
      }
      const result: BreakpointResult = {
        verified: b.verified === true,
        ...(b.line !== undefined ? { line: b.line } : {}),
        ...(b.message ? { message: b.message } : {}),
      };
      return { ...(b.id !== undefined ? { id: b.id } : {}), result };
    });
    if (placed.length) this.placed.set(path, placed);
    else this.placed.delete(path);
    const results = placed.map((p) => p.result);
    this.bpEvents.fire({ path, results });
    return results;
  }

  async setExceptionStops(stops: ExceptionStops): Promise<void> {
    const filters = (this.caps.exceptionBreakpointFilters ?? []) as { filter: string }[];
    if (!filters.length) return;
    // Adapters name them their own way: debugpy "uncaught" / "raised", GDB and LLDB "throw"…
    const uncaught = filters.find((f) => /uncaught|unhandled/i.test(f.filter));
    const caught = filters.find((f) => f !== uncaught && /raised|all|caught|throw/i.test(f.filter));
    const on = [
      ...(stops.uncaught && uncaught ? [uncaught.filter] : []),
      ...(stops.caught && caught ? [caught.filter] : []),
    ];
    await this.dap.request("setExceptionBreakpoints", { filters: on });
  }

  async threads(): Promise<{ id: number; name: string }[]> {
    const body = await this.dap.request<{ threads?: { id: number; name: string }[] }>("threads");
    return body.threads ?? [];
  }

  async stackTrace(threadId: number): Promise<StackFrame[]> {
    const body = await this.dap.request<{
      stackFrames?: {
        id: number;
        name: string;
        line: number;
        column: number;
        source?: { path?: string };
        instructionPointerReference?: string;
        canRestart?: boolean;
      }[];
    }>("stackTrace", { threadId, startFrame: 0, levels: 200 });
    return (body.stackFrames ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      path: f.source?.path ?? null,
      line: f.line,
      column: f.column,
      ...(f.instructionPointerReference
        ? { instructionPointerReference: f.instructionPointerReference }
        : {}),
      ...(f.canRestart === false ? { canRestart: false } : {}),
    }));
  }

  async scopes(frameId: number): Promise<Scope[]> {
    const body = await this.dap.request<{
      scopes?: {
        name: string;
        variablesReference: number;
        expensive?: boolean;
        line?: number;
        endLine?: number;
      }[];
    }>("scopes", { frameId });
    return (body.scopes ?? []).map((s) => ({
      name: s.name,
      ref: s.variablesReference,
      expensive: s.expensive === true,
      ...(typeof s.line === "number" ? { line: s.line } : {}),
      ...(typeof s.endLine === "number" ? { endLine: s.endLine } : {}),
    }));
  }

  async variables(ref: number): Promise<Variable[]> {
    const body = await this.dap.request<{
      variables?: { name: string; value: string; type?: string; variablesReference: number }[];
    }>("variables", { variablesReference: ref });
    return (body.variables ?? []).map((v) => ({
      name: v.name,
      value: v.value,
      ...(v.type ? { type: v.type } : {}),
      ref: v.variablesReference,
    }));
  }

  async setVariable(
    container: number,
    name: string,
    expression: string,
  ): Promise<{ value: string; ref: number }> {
    if (!this.caps.supportsSetVariable) throw new Error("This debugger can't change variables.");
    const body = await this.dap.request<{ value: string; variablesReference?: number }>(
      "setVariable",
      { variablesReference: container, name, value: expression },
    );
    return { value: body.value, ref: body.variablesReference ?? 0 };
  }

  async evaluate(
    expression: string,
    frameId?: number,
    context: "repl" | "watch" | "hover" = "repl",
  ): Promise<{ value: string; ref: number }> {
    const body = await this.dap.request<{ result: string; variablesReference: number }>(
      "evaluate",
      { expression, context, ...(frameId !== undefined ? { frameId } : {}) },
    );
    return { value: body.result, ref: body.variablesReference };
  }

  resume(threadId: number): Promise<void> {
    return this.go("continue", threadId);
  }

  next(threadId: number, granularity?: SteppingGranularity): Promise<void> {
    return this.go("next", threadId, granularity);
  }

  stepIn(threadId: number, granularity?: SteppingGranularity): Promise<void> {
    return this.go("stepIn", threadId, granularity);
  }

  stepOut(threadId: number, granularity?: SteppingGranularity): Promise<void> {
    return this.go("stepOut", threadId, granularity);
  }

  async stepInTargets(frameId: number): Promise<StepInTarget[]> {
    if (!this.caps.supportsStepInTargetsRequest) return [];
    const body = await this.dap.request<{ targets?: StepInTarget[] }>("stepInTargets", {
      frameId,
    });
    return (body.targets ?? [])
      .filter((t) => typeof t.id === "number" && typeof t.label === "string")
      .map((t) => ({
        id: t.id,
        label: t.label,
        ...(typeof t.line === "number" ? { line: t.line } : {}),
        ...(typeof t.column === "number" ? { column: t.column } : {}),
        ...(typeof t.endLine === "number" ? { endLine: t.endLine } : {}),
        ...(typeof t.endColumn === "number" ? { endColumn: t.endColumn } : {}),
      }));
  }

  async stepInTarget(threadId: number, targetId: number): Promise<void> {
    this.continued.fire({ threadId, all: false });
    await this.dap.request("stepIn", { threadId, targetId });
  }

  async restartFrame(threadId: number, frameId: number): Promise<void> {
    if (!this.caps.supportsRestartFrame) throw new Error("This debugger can't restart frames.");
    // The adapter stops again at the frame's start (a `stopped` event, reason "restart").
    this.continued.fire({ threadId, all: false });
    await this.dap.request("restartFrame", { frameId });
  }

  /** Running again: said first, since the next stop can arrive before the answer. */
  private async go(
    command: string,
    threadId: number,
    granularity?: SteppingGranularity,
  ): Promise<void> {
    // `continue` resumes every thread unless the adapter's answer says otherwise; a step moves
    // its thread (adapters that resume the others report it with their own `continued`).
    this.continued.fire({ threadId, all: command === "continue" });
    await this.dap.request(command, {
      threadId,
      ...(granularity && this.caps.supportsSteppingGranularity ? { granularity } : {}),
    });
  }

  async setFunctionBreakpoints(list: FunctionBreakpointSpec[]): Promise<BreakpointResult[]> {
    if (!this.caps.supportsFunctionBreakpoints) return list.map(() => ({ verified: false }));
    const body = await this.dap.request<{
      breakpoints?: { verified?: boolean; line?: number; message?: string }[];
    }>("setFunctionBreakpoints", {
      breakpoints: list.map((b) => ({
        name: b.name,
        ...(this.caps.supportsConditionalBreakpoints && b.condition
          ? { condition: b.condition }
          : {}),
        ...(this.caps.supportsHitConditionalBreakpoints && b.hitCondition
          ? { hitCondition: b.hitCondition }
          : {}),
      })),
    });
    return (body.breakpoints ?? []).map((b) => ({
      verified: b.verified === true,
      ...(b.line !== undefined ? { line: b.line } : {}),
      ...(b.message ? { message: b.message } : {}),
    }));
  }

  async dataBreakpointInfo(
    container: number,
    name: string,
    frameId?: number,
  ): Promise<{ dataId: string | null; description: string; accessTypes?: string[] }> {
    if (!this.caps.supportsDataBreakpoints)
      return { dataId: null, description: "This debugger can't break on value changes." };
    const body = await this.dap.request<{
      dataId?: string | null;
      description?: string;
      accessTypes?: string[];
    }>("dataBreakpointInfo", {
      variablesReference: container,
      name,
      ...(frameId !== undefined ? { frameId } : {}),
    });
    return {
      dataId: body.dataId ?? null,
      description: body.description ?? name,
      ...(body.accessTypes ? { accessTypes: body.accessTypes } : {}),
    };
  }

  async setDataBreakpoints(list: DataBreakpointSpec[]): Promise<BreakpointResult[]> {
    if (!this.caps.supportsDataBreakpoints) return list.map(() => ({ verified: false }));
    const body = await this.dap.request<{
      breakpoints?: { verified?: boolean; message?: string }[];
    }>("setDataBreakpoints", { breakpoints: list });
    return (body.breakpoints ?? []).map((b) => ({
      verified: b.verified === true,
      ...(b.message ? { message: b.message } : {}),
    }));
  }

  async setInstructionBreakpoints(
    list: { instructionReference: string }[],
  ): Promise<BreakpointResult[]> {
    if (!this.caps.supportsInstructionBreakpoints) return list.map(() => ({ verified: false }));
    const body = await this.dap.request<{
      breakpoints?: { verified?: boolean; message?: string }[];
    }>("setInstructionBreakpoints", { breakpoints: list });
    return (body.breakpoints ?? []).map((b) => ({
      verified: b.verified === true,
      ...(b.message ? { message: b.message } : {}),
    }));
  }

  async exceptionInfo(threadId: number): Promise<ExceptionDetails | null> {
    if (!this.caps.supportsExceptionInfoRequest) return null;
    const body = await this.dap.request("exceptionInfo", { threadId }, 5000);
    return fromDapExceptionInfo(body);
  }

  async setExceptionFilters(args: ExceptionFilterArgs): Promise<void> {
    if (!parseExceptionFilters(this.caps.exceptionBreakpointFilters).length) return;
    await this.dap.request("setExceptionBreakpoints", { ...args });
  }

  async loadedSources(): Promise<LoadedSource[]> {
    if (!this.caps.supportsLoadedSourcesRequest) return [];
    const body = await this.dap.request<{
      sources?: { name?: string; path?: string; origin?: string }[];
    }>("loadedSources", {});
    return (body.sources ?? []).map((src) => ({
      name: src.name ?? src.path?.split(/[\\/]/).pop() ?? "?",
      path: src.path ?? null,
      ...(src.origin ? { origin: src.origin } : {}),
    }));
  }

  async disassemble(
    memoryReference: string,
    instructionOffset: number,
    count: number,
  ): Promise<Instruction[]> {
    if (!this.caps.supportsDisassembleRequest) return [];
    const body = await this.dap.request<{
      instructions?: {
        address: string;
        instruction: string;
        instructionBytes?: string;
        symbol?: string;
        location?: { path?: string };
        line?: number;
      }[];
    }>("disassemble", {
      memoryReference,
      instructionOffset,
      instructionCount: count,
      resolveSymbols: true,
    });
    return (body.instructions ?? []).map((i) => ({
      address: i.address,
      instruction: i.instruction,
      ...(i.instructionBytes ? { bytes: i.instructionBytes } : {}),
      ...(i.symbol ? { symbol: i.symbol } : {}),
      ...(i.location?.path ? { path: i.location.path } : {}),
      ...(i.line !== undefined ? { line: i.line } : {}),
    }));
  }

  async pause(threadId: number): Promise<void> {
    await this.dap.request("pause", { threadId });
  }

  async stop(): Promise<void> {
    if (!this.ended)
      await this.dap
        .request(
          "disconnect",
          { terminateDebuggee: this.options.request === "launch", restart: false },
          3000,
        )
        .catch(() => {});
    this.end();
    await this.options.kill();
  }
}

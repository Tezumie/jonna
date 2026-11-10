// One debug session as the controller keeps it (D204): its state, threads, the stopped thread's
// frames and scopes, what its debugger can do, and what was last sent to it. The controller
// (controller.ts) and its helpers (breakpointSync.ts, childSessions.ts) change these.
import { DisposableStore } from "../../core/lifecycle/index";
import { type Signal, signal } from "../../core/reactive/index";
import type { TaskExecution } from "../../workbench/services";
import type { ExceptionDetails } from "./exceptionInfo";
import type { LaunchConfig } from "./launch";
import {
  type BreakpointResult,
  type DebugCapabilities,
  type DebugSession,
  NO_CAPABILITIES,
  type Scope,
  type StackFrame,
} from "./session";
import type { ThreadRow } from "./sessionModel";

export type DebugState = "inactive" | "starting" | "running" | "stopped";

export interface StopInfo {
  reason: string;
  threadId: number;
  text?: string;
}

/** How a session came to be. */
export type SessionKind =
  | "launch"
  /** A Node child process that registered (auto-attach) or a debug terminal's program. */
  | "child"
  | "worker"
  /** A package manager's script: nothing to inspect, its Node processes are its children. */
  | "launcher"
  /** A program run without debugging (Node): its output, Stop and Restart, nothing to inspect. */
  | "process"
  /** A session the debug adapter asked for (DAP `startDebugging`: debugpy's subprocesses). */
  | "adapterChild";

/** One debug session and what's known of it. */
export class RunningSession {
  readonly state: Signal<DebugState> = signal("starting");
  readonly threads: Signal<readonly ThreadRow[]> = signal([]);
  /** The thread the toolbar and the call stack's selection act on. */
  readonly threadId: Signal<number | null> = signal(null);
  /** That thread's call stack while stopped. */
  readonly frames: Signal<readonly StackFrame[]> = signal([]);
  readonly frameIndex: Signal<number> = signal(0);
  readonly scopes: Signal<readonly Scope[]> = signal([]);
  readonly stopInfo: Signal<StopInfo | null> = signal(null);
  readonly exception: Signal<ExceptionDetails | null> = signal(null);
  readonly capabilities: Signal<DebugCapabilities> = signal(NO_CAPABILITIES);
  session: DebugSession | null = null;
  terminal: TaskExecution | null = null;
  pid: number | undefined;
  /** What each path's breakpoints were last sent as (to send only changes). */
  readonly sent = new Map<string, string>();
  /**
   * The ids of the breakpoints last sent per path key, in order: the debugger's results line up
   * with them (a triggered breakpoint still waiting isn't among them).
   */
  readonly sentIds = new Map<string, number[]>();
  sentFunctions = "";
  sentData = "";
  sentInstructions = "";
  /** The breakpoint update under way (stepping waits for it: a fast program could outrun it). */
  syncing: Promise<void> = Promise.resolve();
  /** A "run to line" breakpoint added for adapters that can't do it themselves. */
  temporary: string | null = null;
  /** Ended or being stopped: its events are ignored. */
  ended = false;
  /** The user (or a compound's stopAll) stopped it: a failing start is that, not an error. */
  stopRequested = false;
  /** A child that stays when its parent ends (serverReadyAction without killOnServerStop). */
  keepWhenParentEnds = false;
  /** Placed breakpoints per path key, for verification across sessions. */
  readonly placed = new Map<string, BreakpointResult[]>();
  readonly store = new DisposableStore();

  constructor(
    readonly id: string,
    readonly name: string,
    readonly config: LaunchConfig,
    public parentId: string | null,
    readonly compound: string | null,
    readonly noDebug: boolean,
    public kind: SessionKind,
  ) {}

  /** Nothing to inspect: no breakpoints, threads or stack (a script runner, a plain run). */
  get inspectable(): boolean {
    return this.kind !== "launcher" && this.kind !== "process";
  }
}

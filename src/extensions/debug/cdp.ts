// Node debugging through its inspector (D143): the program runs as `node --inspect-brk` in a
// terminal tab (input and output there, as with VS Code's "integratedTerminal"), the IDE connects
// to the WebSocket it prints (Rust: src-tauri/src/debug, local addresses only) and speaks the
// Chrome DevTools Protocol, behind the same `DebugSession` as DAP adapters. Breakpoints are set
// by URL before the program's first line runs, so they bind as scripts load; TypeScript run with
// Node's type stripping keeps its line numbers.
//
// Source maps (D145, sourcemap.ts): a script with one (tsx, ts-node, `tsc` output, bundles)
// pauses before it runs (`beforeScriptWithSourceMapExecution`, as VS Code's debugger does) while
// breakpoints in its sources are placed at their generated positions; stops and call stacks are
// shown at the source lines. Maps load only when needed (a breakpoint, a stack frame), and those
// under node_modules only for a breakpoint there.
//
// D204: worker threads come through the program's own inspector (the NodeWorker domain) and are
// debugged as child sessions (`onChild`); child processes register through the auto-attach
// bootloader (autoAttach.ts) and connect like any inspector. Function breakpoints find the
// function's declaration in the loaded scripts (or the function itself, when its name evaluates
// globally); scripts parsed later are searched as they're parsed (D280: a pause before every
// script made V8 fail a check and end the program).
// An exception stop carries what was thrown (the exception widget). DOM-free (the socket and the
// terminal come in through `CdpHost`).
import { Emitter } from "../../core/events/index";
import { parseHitCondition } from "./breakpoints";
import { type ExceptionDetails, fromCdpException } from "./exceptionInfo";
import { captureProgramOutput } from "./programOutput";
import type {
  BreakpointResult,
  ChildTarget,
  ContinuedEvent,
  DebugCapabilities,
  DebugSession,
  ExceptionStops,
  FunctionBreakpointSpec,
  LoadedSource,
  OutputEvent,
  Scope,
  SessionSetup,
  SourceBreakpoint,
  StackFrame,
  StoppedEvent,
  Variable,
} from "./session";
import { dataUrlText, SourceMap } from "./sourcemap";

export interface CdpSocket {
  send(body: string): void;
  close(): void;
}

export interface CdpHost {
  /** Starts the program; resolves with the inspector's ws:// address. */
  launch(): Promise<{
    url: string;
    kill(): void;
    exited: Promise<number>;
    /**
     * The program's output, when it goes to the debug console ("internalConsole",
     * `outputCapture: "std"`: run with pipes, programProcess.ts): a listener gets what came so
     * far first; `stderr` tells the streams apart.
     */
    output?(listener: (chunk: string, stderr: boolean) => void): { dispose(): void };
  }>;
  connect(
    url: string,
    onMessage: (body: string) => void,
    onClose: (reason: string) => void,
  ): Promise<CdpSocket>;
  /** A source map file's text (null when unreadable or outside the folder). */
  readFile(path: string): Promise<string | null>;
  /** File paths are case-insensitive (Windows, macOS). */
  caseInsensitive: boolean;
  windows: boolean;
  stopOnEntry: boolean;
  /**
   * Stopping ends the process (`process.exit()` through the inspector): for processes the
   * debugger attached to on its own (auto-attached children, a debug terminal's programs), which
   * have no terminal of their own to kill.
   */
  exitOnStop?: boolean;
  /** Not a Node main thread (a worker): no NodeWorker domain of its own. */
  worker?: boolean;
  /**
   * A page in a browser (D196) rather than a Node program: scripts come from http(s) URLs, mapped
   * to the project's files here; navigating doesn't end the session; console messages go to
   * the debug console.
   */
  page?: BrowserPage;
}

/** What debugging a browser page adds to `CdpHost` (browser.ts). */
export interface BrowserPage {
  /** A script's URL → the file it comes from (null: not one of the project's). */
  scriptPath(url: string): string | null;
  /** setBreakpointByUrl's `urlRegex` for the scripts of `path`. */
  urlRegex(path: string): string;
  /** A source map at an http(s) URL (a dev server on this machine), or null. */
  fetchText(url: string): Promise<string | null>;
  /** Once breakpoints are set: open the page (so they're there when it loads). */
  afterStart(
    send: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  ): Promise<void>;
}

interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
}

interface CallFrame {
  callFrameId: string;
  functionName: string;
  location: { scriptId: string; lineNumber: number; columnNumber?: number };
  url: string;
  scopeChain: {
    type: string;
    name?: string;
    object: RemoteObject;
    startLocation?: { scriptId: string; lineNumber: number };
    endLocation?: { scriptId: string; lineNumber: number };
  }[];
  this: RemoteObject;
  /** False when V8 can't restart this frame (async frames, the bottom one). */
  canBeRestarted?: boolean;
}

/**
 * Where a function named `name` ("render", "Cart.total", "obj.method") is declared in `source`:
 * the position just inside its body (0-based line and column), for each declaration found.
 * Covers `function name(`, `name = function` / arrow functions, `name: function`, and class or
 * object methods (`name(…) {`). Calls (`name(…);`) don't count: a method needs its `{` after the
 * parameter list on the same statement.
 */
export function findFunctionDeclarations(
  source: string,
  name: string,
): { line: number; column: number }[] {
  const last = name.split(".").pop() ?? name;
  if (!/^[A-Za-z_$][\w$]*$/.test(last)) return [];
  const id = last.replace(/\$/g, "\\$");
  const patterns = [
    new RegExp(`\\bfunction\\s*\\*?\\s*${id}\\s*\\(`, "g"),
    new RegExp(
      `(?:^|[^\\w$])${id}\\s*[:=]\\s*(?:async\\s+)?(?:function\\b[^(]*\\(|(?:\\([^()]*\\)|[A-Za-z_$][\\w$]*)\\s*=>)`,
      "g",
    ),
    new RegExp(
      `(?:^|[\\s;{},])(?:(?:static|async|get|set)\\s+)*\\*?${id}\\s*\\([^()]*(?:\\([^()]*\\)[^()]*)*\\)\\s*\\{`,
      "g",
    ),
  ];
  const found = new Set<number>();
  for (const re of patterns)
    for (const m of source.matchAll(re)) {
      const from = (m.index ?? 0) + m[0].length;
      // Into the body: after the `{` (or the arrow, for an expression body).
      let at = from;
      if (!m[0].trimEnd().endsWith("{") && !m[0].trimEnd().endsWith("=>")) {
        const brace = source.indexOf("{", from);
        if (brace < 0) continue;
        at = brace + 1;
      }
      // Skip to the first character of the body's first statement.
      while (at < source.length && /\s/.test(source[at] ?? "")) at++;
      found.add(at);
    }
  return [...found]
    .sort((a, b) => a - b)
    .map((offset) => {
      const before = source.slice(0, offset);
      const line = before.split("\n").length - 1;
      return { line, column: offset - (before.lastIndexOf("\n") + 1) };
    });
}

/**
 * "Debugger listening on ws://…" in the program's output (ANSI codes stripped). Only once the
 * address has ended (a line break or space after it): captured output comes as it's written,
 * so a chunk can end inside it.
 */
export function inspectorUrl(output: string): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
  const plain = output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  // A terminal narrower than the line wraps it, maybe inside the address (Windows 10's ConPTY
  // breaks it with a line break, D253: a compound's two sessions side by side). Node's address
  // ends in a UUID: with the breaks taken out, a whole one is the whole address.
  const joined = plain.replace(/[\r\n]+/g, "");
  const node =
    /Debugger listening on (ws:\/\/[\w.:[\]-]+:\d+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(
      joined,
    )?.[1];
  if (node) return node;
  return /Debugger listening on (ws:\/\/[^\s]+)\s/.exec(plain)?.[1] ?? null;
}

/**
 * The inspector's port from a "Debugger listening on ws://127.0.0.1:<port>/…" line, even one cut
 * or garbled after the port: its targets list (`/json/list`) then gives the address.
 */
export function inspectorPort(output: string): number | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
  const plain = output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/[\r\n]+/g, "");
  const m = /Debugger listening on ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{2,5})\//.exec(
    plain,
  );
  return m ? Number(m[1]) : null;
}

/** file:///a/b%20c.js (or a bare path) → the path. */
export function urlToPath(url: string, windows: boolean): string | null {
  if (!url) return null;
  if (!url.startsWith("file://"))
    return url.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(url) ? url : null;
  const rest = url.slice("file://".length);
  // A stray "%" in a URL a page or source map wrote: kept as written rather than thrown on.
  let path = rest;
  try {
    path = decodeURIComponent(rest);
  } catch {}
  if (!windows) return path;
  // A UNC path's host comes before the first slash ("file://server/share/a.js", Node's form).
  if (!path.startsWith("/") && !/^[a-zA-Z]:/.test(path)) return `\\\\${path.replace(/\//g, "\\")}`;
  return path.replace(/^\/([a-zA-Z]:)/, "$1").replace(/\//g, "\\");
}

/** The path → file URL, as Node writes it (each segment percent-encoded). */
export function pathToUrl(path: string, windows: boolean): string {
  const slash = windows ? path.replace(/\\/g, "/") : path;
  const parts = slash
    .split("/")
    .map((seg, i) => (i === 0 && /^[a-zA-Z]:$/.test(seg) ? seg : encodeURIComponent(seg)));
  const joined = parts.join("/");
  // UNC (\\server\share\a.js): the server is the URL's host, as Node writes it.
  if (windows && joined.startsWith("//")) return `file:${joined}`;
  return `file://${joined.startsWith("/") ? "" : "/"}${joined}`;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** A regex for the scripts of `path` (its file URL or the bare path; case-insensitive if asked). */
export function scriptUrlRegex(path: string, windows: boolean, caseInsensitive: boolean): string {
  const fold = (s: string) =>
    caseInsensitive
      ? [...s]
          .map((c) =>
            c.toLowerCase() !== c.toUpperCase() ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c,
          )
          .join("")
      : s;
  const asUrl = fold(escapeRegex(pathToUrl(path, windows)));
  const asPath = fold(escapeRegex(path));
  return `^(?:${asUrl}|${asPath})$`;
}

/** A value as the variables view shows it. */
export function describe(o: RemoteObject): string {
  if (o.type === "undefined") return "undefined";
  if (o.unserializableValue !== undefined) return o.unserializableValue;
  if (o.type === "string") return JSON.stringify(o.value);
  if (o.type === "number" || o.type === "boolean") return String(o.value);
  if (o.type === "bigint") return o.description ?? `${String(o.value)}n`;
  if (o.subtype === "null") return "null";
  if (o.type === "function") {
    const first = (o.description ?? "ƒ").split("\n")[0] ?? "ƒ";
    return first.length > 80 ? `${first.slice(0, 79)}…` : first;
  }
  return o.description ?? o.className ?? o.type;
}

/** The global function logpoints call (Runtime.addBinding: reported, not printed). */
const LOG_BINDING = "__ideLogpoint";

/** A logpoint's message as a JS expression: `{expr}` parts formatted, the rest literal. */
export function logMessageExpression(message: string): string {
  const literal = (t: string) =>
    t.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  const value = (expr: string) =>
    `\${(() => { try { const v = (${expr}); return typeof v === "object" && v !== null ? (() => { try { return JSON.stringify(v); } catch { return String(v); } })() : String(v); } catch (e) { return "<" + (e && e.message) + ">"; } })()}`;
  let out = "";
  let last = 0;
  for (const m of message.matchAll(/\{([^{}]+)\}/g)) {
    out += literal(message.slice(last, m.index)) + value(m[1] ?? "");
    last = (m.index ?? 0) + m[0].length;
  }
  return `\`${out + literal(message.slice(last))}\``;
}

/**
 * The inspector condition for a breakpoint: its condition, then its hit count (counted only when
 * the condition holds, as in VS Code), then — for a logpoint — the message, never stopping.
 * Null for a plain breakpoint.
 */
export function cdpCondition(bp: SourceBreakpoint, key: string): string | null {
  const parts: string[] = [];
  if (bp.condition) parts.push(`(${bp.condition})`);
  const hit = bp.hitCondition ? parseHitCondition(bp.hitCondition) : null;
  if (hit) {
    const k = JSON.stringify(key);
    const count = `((globalThis.__ideHits ??= {})[${k}] = (globalThis.__ideHits[${k}] ?? 0) + 1)`;
    parts.push(
      hit.op === "%"
        ? `(${count} % ${hit.n} === 0)`
        : `(${count} ${hit.op === "==" ? "===" : hit.op} ${hit.n})`,
    );
  }
  if (bp.logMessage) {
    const msg = logMessageExpression(bp.logMessage);
    parts.push(
      `(((m) => typeof ${LOG_BINDING} === "function" ? ${LOG_BINDING}(m) : console.log(m))(${msg}), false)`,
    );
  }
  return parts.length ? parts.join(" && ") : null;
}

const SCOPE_NAMES: Record<string, string> = {
  local: "Local",
  closure: "Closure",
  block: "Block",
  catch: "Catch",
  script: "Script",
  module: "Module",
  global: "Global",
  with: "With",
  eval: "Eval",
};

export class CdpSession implements DebugSession {
  private readonly stopped = new Emitter<StoppedEvent>();
  readonly onStopped = this.stopped.event;
  private readonly continued = new Emitter<ContinuedEvent>();
  readonly onContinued = this.continued.event;
  private readonly children = new Emitter<ChildTarget>();
  readonly onChild = this.children.event;
  /** Worker sessions tunnelled through this inspector, by NodeWorker session id. */
  private readonly workers = new Map<
    string,
    { onMessage(body: string): void; onClose(reason: string): void }
  >();
  /** What the last exception stop threw. */
  private lastException: ExceptionDetails | null = null;
  /** A frame restart is under way: the next pause is its "restart" stop. */
  private restarting = false;
  /** Function breakpoints asked for, and the inspector's ids for each. */
  private functionBps: FunctionBreakpointSpec[] = [];
  private readonly functionIds = new Map<string, string[]>();
  /** Scripts already searched for function breakpoints (scriptId → searched for which list). */
  private readonly searched = new Map<string, string>();
  private readonly output = new Emitter<OutputEvent>();
  readonly onOutput = this.output.event;
  private readonly terminated = new Emitter<void>();
  readonly onTerminated = this.terminated.event;
  private readonly bpEvents = new Emitter<{ path: string; results: BreakpointResult[] }>();
  readonly onBreakpoints = this.bpEvents.event;

  private socket: CdpSocket | null = null;
  private process: { kill(): void; exited: Promise<number> } | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve(v: unknown): void; reject(e: Error): void }
  >();
  private frames: CallFrame[] = [];
  /** Variable references → inspector object ids (valid while stopped). */
  private handles = new Map<number, string>();
  private nextHandle = 1;
  /** Per path: the inspector's breakpoint ids (one per script when mapped), and their lines. */
  private readonly placed = new Map<
    string,
    { ids: string[]; line: number; resolved: number | null }[]
  >();
  private ended = false;
  /** scriptId → URL (call frames' own `url` is often empty). */
  private readonly scripts = new Map<string, string>();
  /** scriptId → its sourceMappingURL. */
  private readonly mapUrls = new Map<string, string>();
  /** scriptId → its source map, loaded once when needed. */
  private readonly maps = new Map<string, Promise<SourceMap | null>>();
  /** The breakpoints asked for, by path (set again when a script with that source loads). */
  private readonly wanted = new Map<string, SourceBreakpoint[]>();
  /** Paths (by key) that are sources of a loaded map: their breakpoints go through it. */
  private readonly mapped = new Set<string>();
  /**
   * Per path with breakpoints set by URL: a breakpoint on its first line. ES modules get no
   * "before a script with a source map runs" pause (tsx, ts-node's ESM loader), so this one
   * stops each such script before its code runs; one that turns out to have a map then gets
   * its breakpoints placed through it.
   */
  private readonly guards = new Map<string, string>();
  private started = false;

  constructor(
    private readonly host: CdpHost,
    private readonly setup: SessionSetup,
  ) {}

  private send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const socket = this.socket;
    if (!socket || this.ended) return Promise.reject(new Error("The debugger isn't running."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  private receive(body: string): void {
    let msg: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message: string };
    };
    try {
      msg = JSON.parse(body);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result ?? {});
      return;
    }
    const params = msg.params ?? {};
    switch (msg.method) {
      case "Debugger.paused":
        this.paused(
          params as {
            callFrames: CallFrame[];
            reason: string;
            hitBreakpoints?: string[];
            data?: RemoteObject;
          },
        );
        break;
      case "Debugger.scriptParsed": {
        const sp = params as { scriptId: string; url: string; sourceMapURL?: string };
        if (sp.url) this.scripts.set(sp.scriptId, sp.url);
        if (sp.sourceMapURL) this.mapUrls.set(sp.scriptId, sp.sourceMapURL);
        // Function breakpoints in each script as it's parsed (D280: no pause before every
        // script, which made V8 fail a check and end the program, worker threads running).
        if (this.functionBps.length) void this.placeFunctionBreakpoints([sp.scriptId]);
        break;
      }
      case "Debugger.resumed":
        this.frames = [];
        this.handles.clear();
        this.scopeRefs.clear();
        this.continued.fire({ all: true });
        break;
      case "NodeWorker.attachedToWorker": {
        const w = params as {
          sessionId: string;
          workerInfo?: { title?: string; url?: string; workerId?: string };
        };
        const sessionId = w.sessionId;
        const title =
          w.workerInfo?.title || w.workerInfo?.url || `worker ${w.workerInfo?.workerId ?? ""}`;
        this.children.fire({
          name: title.replace(/^file:\/\/.*[\\/]/, ""),
          connect: (onMessage, onClose) => {
            this.workers.set(sessionId, { onMessage, onClose });
            return {
              send: (body) =>
                void this.send("NodeWorker.sendMessageToWorker", {
                  sessionId,
                  message: body,
                }).catch(() => {}),
              close: () => {
                this.workers.delete(sessionId);
                void this.send("NodeWorker.detach", { sessionId }).catch(() => {});
              },
            };
          },
        });
        break;
      }
      case "NodeWorker.receivedMessageFromWorker": {
        const m = params as { sessionId: string; message: string };
        this.workers.get(m.sessionId)?.onMessage(m.message);
        break;
      }
      case "NodeWorker.detachedFromWorker": {
        const d = params as { sessionId: string };
        const w = this.workers.get(d.sessionId);
        this.workers.delete(d.sessionId);
        w?.onClose("the worker ended");
        break;
      }
      case "Debugger.breakpointResolved":
        this.resolved(params as { breakpointId: string; location: { lineNumber: number } });
        break;
      case "Runtime.bindingCalled": {
        const b = params as { name: string; payload: string };
        if (b.name === LOG_BINDING)
          this.output.fire({ category: "console", text: `${b.payload}\n` });
        break;
      }
      case "Runtime.exceptionThrown": {
        const d = (params as { exceptionDetails?: { exception?: RemoteObject; text?: string } })
          .exceptionDetails;
        this.output.fire({
          category: "stderr",
          text: `${d?.exception?.description ?? d?.text ?? "Uncaught exception"}\n`,
        });
        break;
      }
      case "Runtime.executionContextDestroyed":
        // The program finished; Node waits for the debugger to let go before it exits. (A page
        // destroys its contexts on every navigation: it goes on.)
        if (this.started && !this.host.page) this.end("the program finished");
        break;
      case "Runtime.consoleAPICalled": {
        // A page's console goes to the debug console (a Node program's is in its terminal, and
        // copied from there with "internalConsole": programOutput.ts).
        if (!this.host.page) break;
        const c = params as { type: string; args: RemoteObject[] };
        const text = c.args
          .map((a) => (a.type === "string" ? String(a.value) : describe(a)))
          .join(" ");
        this.output.fire({
          category: c.type === "error" || c.type === "warning" ? "stderr" : "stdout",
          text: `${text}\n`,
        });
        break;
      }
      case "Inspector.detached":
      case "Target.targetDestroyed":
        if (this.host.page) this.end("the page was closed");
        break;
    }
  }

  private paused(p: {
    callFrames: CallFrame[];
    reason: string;
    hitBreakpoints?: string[];
    data?: RemoteObject;
  }): void {
    // A script with a source map is about to run: place its breakpoints first.
    if (p.reason === "instrumentation") {
      const data = p.data as unknown as { scriptId?: string } | undefined;
      const scriptId = data?.scriptId ?? "";
      void this.beforeMappedScript(scriptId)
        .then(() => this.placeFunctionBreakpoints([scriptId]))
        .finally(() => void this.send("Debugger.resume").catch(() => {}));
      return;
    }
    this.frames = p.callFrames;
    this.handles.clear();
    this.scopeRefs.clear();
    // Only a first-line guard was hit: map the script's breakpoints if it has a map, go on.
    const guardIds = new Set(this.guards.values());
    const hits = p.hitBreakpoints ?? [];
    if (hits.length && hits.every((id) => guardIds.has(id))) {
      const scriptId = p.callFrames[0]?.location.scriptId ?? "";
      void this.beforeMappedScript(scriptId)
        .then(() => this.placeFunctionBreakpoints([scriptId]))
        .finally(() => void this.send("Debugger.resume").catch(() => {}));
      return;
    }
    const hit = hits.some((id) => !guardIds.has(id));
    // --inspect-brk stops before the first line, already inside the entry script (no
    // instrumentation pause for it): place breakpoints in the sources of the scripts loaded so
    // far, then go on unless asked to stop there.
    if (p.reason === "Break on start" && !hit) {
      void (async () => {
        for (const scriptId of [...this.mapUrls.keys()]) await this.beforeMappedScript(scriptId);
        // The entry script had no "before it runs" pause either: function breakpoints in it.
        await this.placeFunctionBreakpoints([...this.scripts.keys()]);
        if (this.host.stopOnEntry) this.stopped.fire({ reason: "entry", threadId: 1 });
        else await this.send("Debugger.resume").catch(() => {});
      })();
      return;
    }
    const fnIds = new Set([...this.functionIds.values()].flat());
    const restarted = this.restarting;
    this.restarting = false;
    const reason = hit
      ? hits.some((id) => fnIds.has(id))
        ? "function breakpoint"
        : "breakpoint"
      : p.reason === "exception" || p.reason === "promiseRejection"
        ? "exception"
        : p.reason === "Break on start"
          ? "entry"
          : restarted
            ? "restart"
            : p.reason === "other"
              ? "step"
              : p.reason;
    const hitBreakpointIds = hit ? this.hitIds(hits) : [];
    this.lastException =
      reason === "exception" && p.data
        ? fromCdpException(p.data, (p.data as { uncaught?: boolean }).uncaught === true)
        : null;
    this.stopped.fire({
      reason,
      threadId: 1,
      ...(reason === "exception" && p.data ? { text: describe(p.data) } : {}),
      ...(this.lastException ? { exception: this.lastException } : {}),
      ...(hitBreakpointIds.length ? { hitBreakpointIds } : {}),
    });
  }

  /** The IDE's ids of the line breakpoints behind the inspector's breakpoint ids `hits`. */
  private hitIds(hits: readonly string[]): number[] {
    const out: number[] = [];
    for (const [path, list] of this.placed) {
      const wanted = this.wanted.get(path) ?? [];
      list.forEach((entry, i) => {
        const id = wanted[i]?.id;
        if (id !== undefined && entry.ids.some((x) => hits.includes(x))) out.push(id);
      });
    }
    return out;
  }

  private resolved(p: { breakpointId: string; location: { lineNumber: number } }): void {
    for (const [path, list] of this.placed) {
      const b = list.find((x) => x.ids.includes(p.breakpointId));
      if (!b) continue;
      b.resolved = p.location.lineNumber + 1;
      this.bpEvents.fire({ path, results: this.results(list) });
      return;
    }
  }

  /** A script or source URL → a file path (a page's URLs through its mapping). */
  private pathOf(url: string): string | null {
    return this.host.page?.scriptPath(url) ?? urlToPath(url, this.host.windows);
  }

  private urlRegexFor(path: string): string {
    return (
      this.host.page?.urlRegex(path) ??
      scriptUrlRegex(path, this.host.windows, this.host.caseInsensitive)
    );
  }

  private key(path: string): string {
    return this.host.caseInsensitive ? path.replace(/\//g, "\\").toLowerCase() : path;
  }

  /** A script's source map, loaded once (null: none, unreadable, or not a file script). */
  private mapOf(scriptId: string): Promise<SourceMap | null> {
    let hit = this.maps.get(scriptId);
    if (!hit) {
      hit = this.loadMap(scriptId).catch(() => null);
      this.maps.set(scriptId, hit);
    }
    return hit;
  }

  private async loadMap(scriptId: string): Promise<SourceMap | null> {
    const ref = this.mapUrls.get(scriptId);
    const script = this.scripts.get(scriptId) ?? "";
    if (!ref) return null;
    const toPath = (url: string) => this.pathOf(url);
    const scriptUrl =
      script.startsWith("file:") || (this.host.page && /^https?:/.test(script))
        ? script
        : (() => {
            const p = urlToPath(script, this.host.windows);
            return p ? pathToUrl(p, this.host.windows) : null;
          })();
    if (!scriptUrl) return null;
    let text: string | null;
    let base: string;
    if (ref.startsWith("data:")) {
      text = dataUrlText(ref);
      base = scriptUrl;
    } else {
      base = new URL(ref, scriptUrl).href;
      if (this.host.page && /^https?:/.test(base)) text = await this.host.page.fetchText(base);
      else {
        const path = urlToPath(base, this.host.windows);
        text = path ? await this.host.readFile(path) : null;
      }
    }
    if (!text) return null;
    return new SourceMap(JSON.parse(text), base, toPath, (p) => this.key(p));
  }

  /** Before a script with a source map runs: breakpoints in its sources are placed in it. */
  private async beforeMappedScript(scriptId: string): Promise<void> {
    if (!this.wanted.size || !scriptId) return;
    const url = this.scripts.get(scriptId) ?? "";
    const wanted = [...this.wanted.keys()];
    // Dependencies' maps only matter for a breakpoint inside node_modules.
    if (/[\\/]node_modules[\\/]/.test(url) && !wanted.some((p) => /[\\/]node_modules[\\/]/.test(p)))
      return;
    const map = await this.mapOf(scriptId);
    if (!map) return;
    for (const path of wanted)
      if (map.hasSource(path)) {
        this.mapped.add(this.key(path));
        await this.setBreakpoints(path, this.wanted.get(path) ?? []).catch(() => {});
      }
  }

  /** Adds (or removes) `path`'s first-line guard. */
  private async setGuard(path: string, on: boolean, urlRegex?: string): Promise<void> {
    const old = this.guards.get(path);
    if (on && old) return;
    if (old) {
      this.guards.delete(path);
      await this.send("Debugger.removeBreakpoint", { breakpointId: old }).catch(() => {});
    }
    if (!on || !urlRegex) return;
    const r = await this.send<{ breakpointId: string }>("Debugger.setBreakpointByUrl", {
      lineNumber: 0,
      columnNumber: 0,
      urlRegex,
    }).catch(() => null);
    if (r) this.guards.set(path, r.breakpointId);
  }

  /** The scripts whose maps have `path` among their sources (maps already loaded). */
  private async scriptsWith(path: string): Promise<{ scriptId: string; map: SourceMap }[]> {
    const out: { scriptId: string; map: SourceMap }[] = [];
    for (const scriptId of this.maps.keys()) {
      const map = await this.mapOf(scriptId);
      if (map?.hasSource(path)) out.push({ scriptId, map });
    }
    return out;
  }

  private results(list: { resolved: number | null }[]): BreakpointResult[] {
    return list.map((b) =>
      b.resolved === null ? { verified: false } : { verified: true, line: b.resolved },
    );
  }

  /** The program's own output in the debug console (stdout and stderr), until it exits. */
  private captureOutput(
    output: NonNullable<Awaited<ReturnType<CdpHost["launch"]>>["output"]>,
    exited: Promise<number>,
  ): void {
    captureProgramOutput(output, exited, (text, stderr) =>
      this.output.fire({ category: stderr ? "stderr" : "stdout", text }),
    );
  }

  async start(): Promise<void> {
    const proc = await this.host.launch();
    this.process = proc;
    // Stop pressed while launching: stop() had no process to kill yet, so kill it here.
    if (this.isEnded()) {
      proc.kill();
      throw new Error("The debugger stopped.");
    }
    if (proc.output) this.captureOutput(proc.output, proc.exited);
    void proc.exited.then((code) => this.end(`the program exited (code ${code})`));
    try {
      this.socket = await this.host.connect(
        proc.url,
        (body) => this.receive(body),
        (reason) => this.end(`the debugger connection closed: ${reason}`),
      );
    } catch (err) {
      proc.kill();
      throw err;
    }
    // Ended while connecting (stop, or the program exited): end() ran before the socket existed.
    if (this.isEnded()) {
      this.socket.close();
      proc.kill();
      throw new Error("The debugger stopped.");
    }
    await this.send("Runtime.enable");
    await this.send("Debugger.enable", { maxScriptsCacheSize: 10_000_000 });
    for (const [path, list] of this.setup.breakpoints())
      await this.setBreakpoints(path, list).catch(() => {});
    await this.send("Runtime.addBinding", { name: LOG_BINDING }).catch(() => {});
    await this.setExceptionStops(this.setup.exceptionStops()).catch(() => {});
    await this.send("Debugger.setInstrumentationBreakpoint", {
      instrumentation: "beforeScriptWithSourceMapExecution",
    }).catch(() => {});
    const fns = this.setup.functionBreakpoints?.() ?? [];
    if (fns.length) await this.setFunctionBreakpoints(fns).catch(() => {});
    // Worker threads, each waiting until its own session has set breakpoints.
    if (!this.host.page && !this.host.worker)
      await this.send("NodeWorker.enable", { waitForDebuggerOnStart: true }).catch(() => {});
    // Attached to a running program: its scripts are loaded already.
    for (const scriptId of [...this.mapUrls.keys()]) await this.beforeMappedScript(scriptId);
    this.started = true;
    await this.send("Runtime.runIfWaitingForDebugger").catch(() => {});
    if (this.host.page)
      await this.host.page.afterStart((method, params) => this.send(method, params));
  }

  /** A method, not a field read, so TS doesn't narrow `ended` across the awaits in start(). */
  private isEnded(): boolean {
    return this.ended;
  }

  private end(why?: string): void {
    if (this.ended) return;
    this.ended = true;
    if (why) this.output.fire({ category: "console", text: `Ended: ${why}\n` });
    for (const p of this.pending.values()) p.reject(new Error("The debugger stopped."));
    this.pending.clear();
    for (const w of [...this.workers.values()]) w.onClose("the program ended");
    this.workers.clear();
    this.socket?.close();
    // A browser the IDE started goes with its page (it would hold its profile, and the next
    // launch would hand off to it and exit). Attached ones aren't the IDE's: kill is a no-op.
    if (this.host.page) this.process?.kill();
    this.terminated.fire();
  }

  async setBreakpoints(path: string, breakpoints: SourceBreakpoint[]): Promise<BreakpointResult[]> {
    if (breakpoints.length) this.wanted.set(path, breakpoints);
    else this.wanted.delete(path);
    for (const old of this.placed.get(path) ?? [])
      for (const id of old.ids)
        await this.send("Debugger.removeBreakpoint", { breakpointId: id }).catch(() => {});
    const list: { ids: string[]; line: number; resolved: number | null }[] = [];
    this.placed.set(path, list);
    // A source of a loaded map: placed in each script generated from it.
    if (this.mapped.has(this.key(path))) {
      await this.setGuard(path, false);
      const scripts = await this.scriptsWith(path);
      for (const b of breakpoints) {
        const entry = { ids: [] as string[], line: b.line, resolved: null as number | null };
        list.push(entry);
        for (const { scriptId, map } of scripts) {
          const at = map.generated(path, b.line - 1);
          if (!at) continue;
          const condition = cdpCondition(b, `${path}:${b.line}`);
          try {
            const r = await this.send<{
              breakpointId: string;
              actualLocation: { lineNumber: number; columnNumber?: number };
            }>("Debugger.setBreakpoint", {
              location: { scriptId, lineNumber: at.line, columnNumber: at.col },
              ...(condition !== null ? { condition } : {}),
            });
            entry.ids.push(r.breakpointId);
            const back = map.original(
              r.actualLocation.lineNumber,
              r.actualLocation.columnNumber ?? 0,
            );
            entry.resolved = back ? back.line + 1 : at.sourceLine + 1;
          } catch {
            // Not placeable in this script.
          }
        }
      }
      const results = this.results(list);
      this.bpEvents.fire({ path, results });
      return results;
    }
    const urlRegex = this.urlRegexFor(path);
    // (A breakpoint on line 1 would be the same spot: none then.)
    await this.setGuard(
      path,
      breakpoints.length > 0 && !breakpoints.some((b) => b.line === 1),
      urlRegex,
    );
    for (const b of breakpoints) {
      try {
        const r = await this.send<{ breakpointId: string; locations: { lineNumber: number }[] }>(
          "Debugger.setBreakpointByUrl",
          {
            lineNumber: b.line - 1,
            urlRegex,
            columnNumber: 0,
            ...(cdpCondition(b, `${path}:${b.line}`) !== null
              ? { condition: cdpCondition(b, `${path}:${b.line}`) }
              : {}),
          },
        );
        const at = r.locations[0];
        list.push({ ids: [r.breakpointId], line: b.line, resolved: at ? at.lineNumber + 1 : null });
      } catch {
        list.push({ ids: [], line: b.line, resolved: null });
      }
    }
    const results = this.results(list);
    this.bpEvents.fire({ path, results });
    return results;
  }

  async setExceptionStops(stops: ExceptionStops): Promise<void> {
    await this.send("Debugger.setPauseOnExceptions", {
      state: stops.caught ? "all" : stops.uncaught ? "uncaught" : "none",
    });
  }

  async threads(): Promise<{ id: number; name: string }[]> {
    return [{ id: 1, name: "Main thread" }];
  }

  async stackTrace(): Promise<StackFrame[]> {
    return Promise.all(
      this.frames.map(async (f, i) => {
        const generated = {
          id: i,
          name: f.functionName || "(anonymous)",
          path: this.pathOf(f.url || this.scripts.get(f.location.scriptId) || ""),
          line: f.location.lineNumber + 1,
          column: (f.location.columnNumber ?? 0) + 1,
          ...(f.canBeRestarted === false ? { canRestart: false } : {}),
        };
        // Shown where it is in the source (TypeScript…), when the script has a map.
        const map = this.mapUrls.has(f.location.scriptId)
          ? await this.mapOf(f.location.scriptId)
          : null;
        const at = map?.original(f.location.lineNumber, f.location.columnNumber ?? 0);
        return at
          ? { ...generated, path: at.path, line: at.line + 1, column: at.col + 1 }
          : generated;
      }),
    );
  }

  private handle(objectId: string): number {
    const ref = this.nextHandle++;
    this.handles.set(ref, objectId);
    return ref;
  }

  /** Scope handles → where the scope is (variables in it are set through the frame). */
  private readonly scopeRefs = new Map<number, { frame: number; scope: number }>();

  /** An evaluation result as an argument for another call. */
  private static argument(o: RemoteObject): Record<string, unknown> {
    if (o.objectId) return { objectId: o.objectId };
    if (o.unserializableValue !== undefined) return { unserializableValue: o.unserializableValue };
    return o.type === "undefined" ? {} : { value: o.value };
  }

  async setVariable(
    container: number,
    name: string,
    expression: string,
    frameId?: number,
  ): Promise<{ value: string; ref: number }> {
    const frame = this.frames[frameId ?? 0];
    const evaluated = await this.send<{
      result: RemoteObject;
      exceptionDetails?: { exception?: RemoteObject; text?: string };
    }>(
      frame ? "Debugger.evaluateOnCallFrame" : "Runtime.evaluate",
      frame ? { callFrameId: frame.callFrameId, expression } : { expression },
    );
    if (evaluated.exceptionDetails) {
      const text =
        evaluated.exceptionDetails.exception?.description ??
        evaluated.exceptionDetails.text ??
        "Error";
      throw new Error(text.split("\n")[0] ?? text);
    }
    const arg = CdpSession.argument(evaluated.result);
    const scope = this.scopeRefs.get(container);
    const target = this.frames[scope?.frame ?? -1];
    if (scope && target) {
      await this.send("Debugger.setVariableValue", {
        scopeNumber: scope.scope,
        variableName: name,
        newValue: arg,
        callFrameId: target.callFrameId,
      });
    } else {
      const objectId = this.handles.get(container);
      if (!objectId)
        throw new Error("That value can't be changed any more (the program moved on).");
      await this.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function (k, v) { this[k] = v; }",
        arguments: [{ value: name }, arg],
      });
    }
    const o = evaluated.result;
    return {
      value: describe(o),
      ref: o.objectId && o.type === "object" && o.subtype !== "null" ? this.handle(o.objectId) : 0,
    };
  }

  async runTo(_threadId: number, path: string, line: number): Promise<boolean> {
    let location: { scriptId: string; lineNumber: number; columnNumber?: number } | null = null;
    for (const { scriptId, map } of this.mapped.has(this.key(path))
      ? await this.scriptsWith(path)
      : []) {
      const at = map.generated(path, line - 1);
      if (at) {
        location = { scriptId, lineNumber: at.line, columnNumber: at.col };
        break;
      }
    }
    if (!location) {
      const re = new RegExp(this.urlRegexFor(path));
      const scriptId = [...this.scripts].find(
        ([id, url]) => re.test(url) && !this.mapUrls.has(id),
      )?.[0];
      if (scriptId) location = { scriptId, lineNumber: line - 1 };
    }
    if (!location) return false;
    this.frames = [];
    this.handles.clear();
    this.scopeRefs.clear();
    this.continued.fire({ all: true });
    await this.send("Debugger.continueToLocation", { location, targetCallFrames: "any" });
    return true;
  }

  async scopes(frameId: number): Promise<Scope[]> {
    const frame = this.frames[frameId];
    if (!frame) return [];
    return frame.scopeChain.flatMap((s, scope) => {
      if (!s.object.objectId) return [];
      const ref = this.handle(s.object.objectId);
      this.scopeRefs.set(ref, { frame: frameId, scope });
      // The lines it covers, where they are the file's own (a script without a source map).
      const start = s.startLocation;
      const end = s.endLocation;
      const range =
        start && end && !this.mapUrls.has(start.scriptId)
          ? { line: start.lineNumber + 1, endLine: end.lineNumber + 1 }
          : {};
      return [
        { name: SCOPE_NAMES[s.type] ?? s.type, ref, expensive: s.type === "global", ...range },
      ];
    });
  }

  async variables(ref: number): Promise<Variable[]> {
    const objectId = this.handles.get(ref);
    if (!objectId) return [];
    const r = await this.send<{
      result: { name: string; value?: RemoteObject; enumerable?: boolean }[];
    }>("Runtime.getProperties", { objectId, ownProperties: true, generatePreview: false });
    return r.result
      .filter((p) => p.value && p.name !== "__proto__")
      .map((p) => {
        const v = p.value as RemoteObject;
        return {
          name: p.name,
          value: describe(v),
          type: v.subtype ?? v.type,
          ref:
            v.objectId && v.type === "object" && v.subtype !== "null" ? this.handle(v.objectId) : 0,
        };
      });
  }

  async evaluate(
    expression: string,
    frameId?: number,
    context: "repl" | "watch" | "hover" = "repl",
  ): Promise<{ value: string; ref: number }> {
    const frame = frameId !== undefined ? this.frames[frameId] : undefined;
    // Hovering must not change the program: V8 refuses evaluations with side effects.
    const quiet = context === "hover" ? { throwOnSideEffect: true, silent: true } : {};
    const r = await this.send<{
      result: RemoteObject;
      exceptionDetails?: { exception?: RemoteObject; text?: string };
    }>(
      frame ? "Debugger.evaluateOnCallFrame" : "Runtime.evaluate",
      frame
        ? { callFrameId: frame.callFrameId, expression, generatePreview: false, ...quiet }
        : { expression, includeCommandLineAPI: true, replMode: true, ...quiet },
    );
    if (r.exceptionDetails) {
      // The message, not the stack through the evaluation's own frames.
      const text = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "Error";
      throw new Error(text.split("\n")[0] ?? text);
    }
    const o = r.result;
    return {
      value: describe(o),
      ref: o.objectId && o.type === "object" && o.subtype !== "null" ? this.handle(o.objectId) : 0,
    };
  }

  /** Running again: said first, since the next stop can arrive before the answer. */
  private go(method: string): Promise<void> {
    this.frames = [];
    this.handles.clear();
    this.scopeRefs.clear();
    this.continued.fire({ all: true });
    return this.send(method).then(() => undefined);
  }

  resume(): Promise<void> {
    return this.go("Debugger.resume");
  }
  next(): Promise<void> {
    return this.go("Debugger.stepOver");
  }
  stepIn(): Promise<void> {
    return this.go("Debugger.stepInto");
  }
  stepOut(): Promise<void> {
    return this.go("Debugger.stepOut");
  }
  pause(): Promise<void> {
    return this.send("Debugger.pause").then(() => undefined);
  }

  /**
   * Runs a frame again from its start (VS Code's Restart frame; js-debug does the same): V8
   * resumes and pauses at the function's first statement ("StepInto" mode, V8 10.4+).
   */
  async restartFrame(_threadId: number, frameId: number): Promise<void> {
    const frame = this.frames[frameId];
    if (!frame) throw new Error("That frame is gone (the program moved on).");
    if (frame.canBeRestarted === false) throw new Error("This frame can't be restarted.");
    this.restarting = true;
    try {
      await this.send("Debugger.restartFrame", {
        callFrameId: frame.callFrameId,
        mode: "StepInto",
      });
    } catch (err) {
      this.restarting = false;
      throw err;
    }
  }

  async stop(): Promise<void> {
    // A process the debugger attached to by itself ends with its session (VS Code's "terminate").
    if (this.host.exitOnStop && !this.ended) {
      const exited = this.send("Runtime.evaluate", { expression: "process.exit()" }).catch(
        () => {},
      );
      await Promise.race([exited, new Promise((r) => setTimeout(r, 1000))]);
    }
    this.end();
    this.process?.kill();
  }

  capabilities(): DebugCapabilities {
    return {
      functionBreakpoints: true,
      dataBreakpoints: false,
      exceptionInfo: true,
      exceptionFilters: [],
      exceptionFilterOptions: false,
      loadedSources: true,
      disassemble: false,
      instructionBreakpoints: false,
      steppingGranularity: false,
      stepInTargets: false,
      restartFrame: true,
    };
  }

  async exceptionInfo(): Promise<ExceptionDetails | null> {
    return this.lastException;
  }

  async pid(): Promise<number | null> {
    if (this.host.page) return null;
    const r = await this.send<{ result: RemoteObject }>("Runtime.evaluate", {
      expression: "process.pid",
      silent: true,
    }).catch(() => null);
    return typeof r?.result.value === "number" ? r.result.value : null;
  }

  async loadedSources(): Promise<LoadedSource[]> {
    const out: LoadedSource[] = [];
    const seen = new Set<string>();
    for (const url of this.scripts.values()) {
      if (seen.has(url)) continue;
      seen.add(url);
      const path = this.pathOf(url);
      const name = (path ?? url).split(/[\\/]/).pop() || url;
      out.push({ name, path, ...(path ? {} : { origin: url }) });
    }
    return out.sort((a, b) => (a.path ?? a.origin ?? "").localeCompare(b.path ?? b.origin ?? ""));
  }

  /** Scripts worth searching for a function's declaration: the program's own. */
  private searchable(scriptId: string): boolean {
    const url = this.scripts.get(scriptId) ?? "";
    if (!url || url.startsWith("node:") || /^(evalmachine|internal)/.test(url)) return false;
    const wantsDeps = this.functionBps.some((f) => f.name.includes("node_modules"));
    return wantsDeps || !/[\\/]node_modules[\\/]/.test(url);
  }

  async setFunctionBreakpoints(list: FunctionBreakpointSpec[]): Promise<BreakpointResult[]> {
    for (const ids of this.functionIds.values())
      for (const id of ids)
        await this.send("Debugger.removeBreakpoint", { breakpointId: id }).catch(() => {});
    this.functionIds.clear();
    this.searched.clear();
    // Scripts parsed later get them as they're parsed (Debugger.scriptParsed).
    this.functionBps = list;
    // A function reachable by its name from the global scope: break on its calls directly.
    for (const f of list) {
      const r = await this.send<{ result: RemoteObject }>("Runtime.evaluate", {
        expression: f.name,
        silent: true,
        throwOnSideEffect: true,
      }).catch(() => null);
      if (r?.result.type !== "function" || !r.result.objectId) continue;
      const condition = cdpCondition({ line: 0, ...f }, `fn:${f.name}`);
      const set = await this.send<{ breakpointId: string }>(
        "Debugger.setBreakpointOnFunctionCall",
        {
          objectId: r.result.objectId,
          ...(condition !== null ? { condition } : {}),
        },
      ).catch(() => null);
      if (set) this.functionIds.set(f.name, [set.breakpointId]);
    }
    await this.placeFunctionBreakpoints([...this.scripts.keys()]);
    return list.map((f) => ({ verified: (this.functionIds.get(f.name)?.length ?? 0) > 0 }));
  }

  /** Searches `scriptIds` for the function breakpoints' declarations and breaks there. */
  private async placeFunctionBreakpoints(scriptIds: string[]): Promise<void> {
    const list = this.functionBps;
    if (!list.length) return;
    const key = JSON.stringify(list);
    let changed = false;
    for (const scriptId of scriptIds) {
      if (this.searched.get(scriptId) === key || !this.searchable(scriptId)) continue;
      this.searched.set(scriptId, key);
      const src = await this.send<{ scriptSource: string }>("Debugger.getScriptSource", {
        scriptId,
      }).catch(() => null);
      if (!src) continue;
      for (const f of list) {
        for (const at of findFunctionDeclarations(src.scriptSource, f.name)) {
          const condition = cdpCondition({ line: 0, ...f }, `fn:${f.name}`);
          const r = await this.send<{ breakpointId: string }>("Debugger.setBreakpoint", {
            location: { scriptId, lineNumber: at.line, columnNumber: at.column },
            ...(condition !== null ? { condition } : {}),
          }).catch(() => null);
          if (!r) continue;
          this.functionIds.set(f.name, [...(this.functionIds.get(f.name) ?? []), r.breakpointId]);
          changed = true;
        }
      }
    }
    if (changed)
      this.functionPlaced.fire(list.map((f) => (this.functionIds.get(f.name)?.length ?? 0) > 0));
  }

  private readonly functionPlaced = new Emitter<boolean[]>();
  /** Function breakpoints placed later (a script that declares one loaded): verified per entry. */
  readonly onFunctionBreakpoints = this.functionPlaced.event;
}

// The worker a workflow script runs in (D338): no DOM, no IPC, and — locked down as an
// extension's worker is (lockdown.ts) — no network, storage or code loading. The script sees only
// what's injected: agent() (each call goes to the window, which runs it as a subagent),
// parallel(), pipeline(), phase(), log() and args. Date.now(), Math.random() and new Date() throw,
// as in Claude Code: they'd make a resumed run differ from the first. Built as a separate
// classic script (build.mjs) and started by the agent's workflow runner (extensions/agent/
// workflows.ts), which ends it when the run ends.
import {
  type FromWorkflowWorker,
  parallel,
  pipeline,
  type ToWorkflowWorker,
} from "../core/agent/workflow";
import { loadsModules } from "../core/extensions/sandbox";
import { lockCodeGeneration, lockdown } from "./lockdown";

const scope = self as unknown as Record<string, unknown> & {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (e: MessageEvent) => void): void;
};
const post = scope.postMessage.bind(scope) as (message: FromWorkflowWorker) => void;
/**
 * A Node worker thread only (workers/node/scope.ts): compiles the script in a context of its
 * own, since a thread has no worker sandbox from the engine. Read once and taken off the
 * global; a page's worker has none and makes the function itself.
 */
const compileIsolated = scope.compileIsolated as
  | ((
      params: readonly string[],
      body: string,
      globals: Readonly<Record<string, unknown>>,
      filename: string,
    ) => (...values: unknown[]) => Promise<unknown>)
  | undefined;
delete scope.compileIsolated;
/** What the script names: its parameters, in the order they are passed. */
const PARAMS = [
  "agent",
  "parallel",
  "pipeline",
  "phase",
  "log",
  "args",
  "budget",
  "workflow",
  "console",
] as const;
/** An error of this realm or of the script's own (a context of its own has its own Error). */
const isError = (err: unknown): err is Error =>
  err instanceof Error ||
  (typeof err === "object" && err !== null && "message" in err && "stack" in err);
const waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
let nextCall = 1;
let started = false;

scope.addEventListener("message", (e: MessageEvent) => {
  const data = e.data as ToWorkflowWorker;
  if (data?.t === "start" && !started) {
    started = true;
    void run(data.body, data.args);
  } else if (data?.t === "agent") {
    const w = waiting.get(data.id);
    waiting.delete(data.id);
    if (!w) return;
    if (data.ok) w.resolve(JSON.parse(data.value) as unknown);
    else w.reject(new Error(data.error));
  }
});

function text(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (isError(a)) return a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ")
    .slice(0, 2000);
}

/** agent(prompt, opts): the window runs it; its answer (or null when it failed) comes back. */
function agent(prompt: unknown, opts?: unknown): Promise<unknown> {
  const id = nextCall++;
  let encoded = "{}";
  try {
    encoded = JSON.stringify(opts ?? {}) ?? "{}";
  } catch {
    return Promise.reject(new TypeError("agent()'s options must be plain data (JSON)."));
  }
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    post({ t: "agent", id, prompt, opts: encoded });
  });
}

/** What would make a resumed run differ from the first: refused (pass times in `args`). */
function lockNondeterminism(): void {
  const refuse = (what: string) => () => {
    throw new Error(
      `${what} isn't available in a workflow script (a resumed run must make the same calls): pass times in args, vary prompts by index.`,
    );
  };
  const RealDate = Date;
  try {
    Object.defineProperty(RealDate, "now", { value: refuse("Date.now()") });
    Object.defineProperty(Math, "random", { value: refuse("Math.random()") });
    const guarded = new Proxy(RealDate, {
      construct(target, args, newTarget) {
        if (!args.length) refuse("new Date()")();
        return Reflect.construct(target, args, newTarget) as object;
      },
      apply() {
        return refuse("Date()")();
      },
    });
    Object.defineProperty(scope, "Date", { value: guarded, configurable: false, writable: false });
  } catch {
    /* already locked */
  }
}

async function run(body: string, argsJson: string): Promise<void> {
  const log = (...args: unknown[]) => post({ t: "log", text: text(args) });
  const console = { log, info: log, warn: log, error: log, debug: log };
  scope.console = console;
  lockdown();
  try {
    if (loadsModules(body))
      throw new Error("Workflow scripts can't load code with import(): write everything inline.");
    const args = JSON.parse(argsJson) as unknown;
    // The script's body runs as an async function: `await` and `return` at its top level.
    let script: (...values: unknown[]) => Promise<unknown>;
    if (compileIsolated) {
      // In a context of its own: the locks first, so what it is handed is already locked. It
      // gets the timers (functions only), and this realm's Date and Math, which refuse what
      // would make a resumed run differ; its own would not.
      lockCodeGeneration("Workflow scripts can't create code at run time.");
      lockNondeterminism();
      const globals: Record<string, unknown> = {};
      for (const name of [
        "Date",
        "Math",
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "queueMicrotask",
        "structuredClone",
        "URL",
        "URLSearchParams",
        "TextEncoder",
        "TextDecoder",
        "atob",
        "btoa",
        "AbortController",
      ])
        if (scope[name] !== undefined) globals[name] = scope[name];
      script = compileIsolated(PARAMS, body, globals, "workflow.js");
    } else {
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
        ...params: string[]
      ) => (...values: unknown[]) => Promise<unknown>;
      script = new AsyncFunction(...PARAMS, `"use strict";\n${body}\n//# sourceURL=workflow.js`);
      lockCodeGeneration("Workflow scripts can't create code at run time.");
      lockNondeterminism();
    }
    const result = await script(
      agent,
      parallel,
      pipeline,
      (title: unknown) => post({ t: "phase", title: String(title).slice(0, 80) }),
      (...values: unknown[]) => post({ t: "log", text: text(values) }),
      args,
      { total: null, spent: () => 0, remaining: () => Number.POSITIVE_INFINITY },
      () => {
        throw new Error("workflow() isn't available here: run the other script as its own run.");
      },
      console,
    );
    let out: string;
    try {
      out =
        result === undefined ? "undefined" : (JSON.stringify(result, null, 2) ?? String(result));
    } catch {
      out = String(result);
    }
    post({ t: "done", result: out });
  } catch (err) {
    // The script's own line: the body keeps its lines, after the one "use strict" line.
    const stack = isError(err) ? (err.stack ?? "") : "";
    const line = /workflow\.js:(\d+)/.exec(stack)?.[1];
    const message = isError(err) ? err.message : String(err);
    post({
      t: "error",
      error: `${err instanceof SyntaxError || (isError(err) && err.name === "SyntaxError") ? "SyntaxError: " : ""}${message}${line ? ` (line ${Number(line) - 3})` : ""}`,
    });
  }
}

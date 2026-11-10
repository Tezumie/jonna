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
      if (a instanceof Error) return a.message;
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
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...params: string[]
    ) => (...values: unknown[]) => Promise<unknown>;
    const script = new AsyncFunction(
      "agent",
      "parallel",
      "pipeline",
      "phase",
      "log",
      "args",
      "budget",
      "workflow",
      "console",
      `"use strict";\n${body}\n//# sourceURL=workflow.js`,
    );
    lockCodeGeneration("Workflow scripts can't create code at run time.");
    lockNondeterminism();
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
    const stack = err instanceof Error ? (err.stack ?? "") : "";
    const line = /workflow\.js:(\d+)/.exec(stack)?.[1];
    const message = err instanceof Error ? err.message : String(err);
    post({
      t: "error",
      error: `${err instanceof SyntaxError ? "SyntaxError: " : ""}${message}${line ? ` (line ${Number(line) - 3})` : ""}`,
    });
  }
}

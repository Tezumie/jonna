// Workflow scripts (D338, Claude Code's Workflow tool): a plain JavaScript script that runs
// subagents deterministically — `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `args`.
// It starts with `export const meta = {...}`, a pure literal (name, description, phases) that is
// parsed here, never run, so the user is asked with what it says before any of the script runs.
// The script itself runs in a locked-down worker (src/workers/workflow.worker.ts); its agent()
// calls come back to the window, where `WorkflowRuntime` runs them as background subagents within
// the run's limits and caches their results by call, so a re-run of an edited script (resume)
// only runs the calls that changed. DOM-free and tested.

import {
  DEFAULT_MAX_EDITING,
  FileClaims,
  maxEditingAgents,
  type WorkflowWorktree,
  worktreeLines,
  worktreeResult,
} from "./workflowEditing";

// ---- meta: a pure literal ------------------------------------------------------------------

export interface WorkflowPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases: WorkflowPhase[];
}

export type ParsedWorkflow =
  | { ok: true; meta: WorkflowMeta; body: string }
  | { ok: false; error: string };

/** A JSON-like value a literal can hold. */
export type LiteralValue =
  | string
  | number
  | boolean
  | null
  | LiteralValue[]
  | { [key: string]: LiteralValue };

class LiteralError extends Error {}

/**
 * Reads a JavaScript literal (objects, arrays, strings, numbers, true / false / null, comments,
 * unquoted keys, trailing commas) from `text` at `start`. Anything else — a variable, a call, a
 * spread, `${…}` in a template — is refused: meta is read, never evaluated.
 */
export function readLiteral(text: string, start: number): { value: LiteralValue; end: number } {
  let i = start;
  const where = () => {
    const before = text.slice(0, i);
    const line = before.split("\n").length;
    return `line ${line}`;
  };
  const fail = (what: string): never => {
    throw new LiteralError(`${what} (${where()})`);
  };
  const skip = () => {
    for (;;) {
      const c = text[i];
      if (c === undefined) return;
      if (/\s/.test(c)) i++;
      else if (text.startsWith("//", i)) {
        const nl = text.indexOf("\n", i);
        i = nl < 0 ? text.length : nl + 1;
      } else if (text.startsWith("/*", i)) {
        const close = text.indexOf("*/", i + 2);
        if (close < 0) fail("an unclosed comment");
        i = close + 2;
      } else return;
    }
  };
  const ESCAPES: Record<string, string> = {
    n: "\n",
    r: "\r",
    t: "\t",
    b: "\b",
    f: "\f",
    v: "\v",
    "0": "\0",
  };
  const str = (): string => {
    const quote = text[i] as string;
    i++;
    let out = "";
    for (;;) {
      const c = text[i];
      if (c === undefined) return fail("an unclosed string");
      if (c === quote) {
        i++;
        return out;
      }
      if (quote === "`" && c === "$" && text[i + 1] === "{")
        fail("a template with ${…} in meta: it must be a pure literal");
      if (quote !== "`" && (c === "\n" || c === "\r")) fail("a line break inside a string");
      if (c === "\\") {
        const e = text[i + 1];
        if (e === undefined) return fail("an unclosed string");
        if (e === "u") {
          const braced = /^\{([0-9a-fA-F]{1,6})\}/.exec(text.slice(i + 2));
          const plain = /^[0-9a-fA-F]{4}/.exec(text.slice(i + 2));
          // Past U+10FFFF fromCodePoint throws a RangeError, not the "bad meta" answer.
          if (braced?.[1] && Number.parseInt(braced[1], 16) <= 0x10ffff) {
            out += String.fromCodePoint(Number.parseInt(braced[1], 16));
            i += 2 + braced[0].length;
          } else if (plain) {
            out += String.fromCharCode(Number.parseInt(plain[0], 16));
            i += 6;
          } else fail("a bad \\u escape");
          continue;
        }
        if (e === "x") {
          const hex = /^[0-9a-fA-F]{2}/.exec(text.slice(i + 2));
          if (!hex) fail("a bad \\x escape");
          out += String.fromCharCode(Number.parseInt((hex as RegExpExecArray)[0], 16));
          i += 4;
          continue;
        }
        // A line continuation.
        if (e === "\n") {
          i += 2;
          continue;
        }
        if (e === "\r") {
          i += text[i + 2] === "\n" ? 3 : 2;
          continue;
        }
        out += ESCAPES[e] ?? e;
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
  };
  const ident = (): string | null => {
    const m = /^[A-Za-z_$][\w$]*/.exec(text.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };
  const value = (depth: number): LiteralValue => {
    if (depth > 40) fail("meta nested too deep");
    skip();
    const c = text[i];
    if (c === undefined) return fail("meta ends early");
    if (c === "{") {
      i++;
      const obj: { [key: string]: LiteralValue } = {};
      for (;;) {
        skip();
        if (text[i] === "}") {
          i++;
          return obj;
        }
        if (text.startsWith("...", i)) fail("a spread in meta: it must be a pure literal");
        let key: string;
        const k = text[i];
        if (k === '"' || k === "'") key = str();
        else if (k !== undefined && /[0-9]/.test(k)) key = String(num());
        else if (k === "[") return fail("a computed key in meta: it must be a pure literal");
        else {
          const name = ident();
          if (name === null) return fail(`an unexpected "${k ?? ""}" in meta`);
          key = name;
        }
        skip();
        if (text[i] !== ":")
          fail(
            `"${key}" without a value: meta must be a pure literal (no shorthand properties or methods)`,
          );
        i++;
        obj[key] = value(depth + 1);
        skip();
        if (text[i] === ",") i++;
        else if (text[i] !== "}") fail(`an unexpected "${text[i] ?? ""}" after "${key}" in meta`);
      }
    }
    if (c === "[") {
      i++;
      const arr: LiteralValue[] = [];
      for (;;) {
        skip();
        if (text[i] === "]") {
          i++;
          return arr;
        }
        if (text.startsWith("...", i)) fail("a spread in meta: it must be a pure literal");
        arr.push(value(depth + 1));
        skip();
        if (text[i] === ",") i++;
        else if (text[i] !== "]") fail(`an unexpected "${text[i] ?? ""}" in a list in meta`);
      }
    }
    if (c === '"' || c === "'" || c === "`") return str();
    if (c === "-" || c === "+" || c === "." || /[0-9]/.test(c)) return num();
    const word = ident();
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    if (word === null) return fail(`an unexpected "${c}" in meta`);
    return fail(`"${word}" in meta: it must be a pure literal (no variables or calls)`);
  };
  const num = (): number => {
    const m =
      /^[+-]?(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)/.exec(
        text.slice(i),
      );
    if (!m) return fail("a bad number in meta");
    i += m[0].length;
    const raw = m[0].replace(/_/g, "");
    const sign = raw.startsWith("-") ? -1 : 1;
    const bare = raw.replace(/^[+-]/, "");
    const n = /^0[xXbBoO]/.test(bare) ? Number(bare) : Number.parseFloat(bare);
    if (!Number.isFinite(n)) fail("a bad number in meta");
    return sign * n;
  };
  const v = value(0);
  return { value: v, end: i };
}

const META_START = /^export\s+const\s+meta\s*=\s*/;

/** Skips white space and comments at the start of the script. */
function leadingTrivia(source: string): number {
  let i = 0;
  for (;;) {
    const rest = source.slice(i);
    const ws = /^\s+/.exec(rest);
    if (ws) {
      i += ws[0].length;
      continue;
    }
    if (rest.startsWith("//")) {
      const nl = rest.indexOf("\n");
      i = nl < 0 ? source.length : i + nl + 1;
      continue;
    }
    if (rest.startsWith("/*")) {
      const close = rest.indexOf("*/");
      if (close < 0) return source.length;
      i += close + 2;
      continue;
    }
    return i;
  }
}

/** Longest script read (characters). */
export const MAX_SCRIPT_CHARS = 200_000;

/**
 * Splits a workflow script into its meta (read as a literal, checked) and the body that runs.
 * The body keeps the meta's lines as blank lines, so the worker's errors name the script's lines.
 */
export function parseWorkflowScript(source: string): ParsedWorkflow {
  if (source.length > MAX_SCRIPT_CHARS)
    return { ok: false, error: `The script is too long (at most ${MAX_SCRIPT_CHARS} characters).` };
  const at = leadingTrivia(source);
  const head = META_START.exec(source.slice(at));
  if (!head)
    return {
      ok: false,
      error:
        "The script must begin with `export const meta = {...}`: a literal with its name, description and phases.",
    };
  let literal: { value: LiteralValue; end: number };
  try {
    literal = readLiteral(source, at + head[0].length);
  } catch (err) {
    if (err instanceof LiteralError) return { ok: false, error: `Bad meta: ${err.message}.` };
    throw err;
  }
  let end = literal.end;
  const after = /^[ \t]*;?/.exec(source.slice(end));
  end += after?.[0].length ?? 0;
  const checked = checkMeta(literal.value);
  if (typeof checked === "string") return { ok: false, error: `Bad meta: ${checked}` };
  const skipped = source.slice(0, end).replace(/[^\n]/g, "");
  return { ok: true, meta: checked, body: `${skipped}${source.slice(end)}` };
}

/** The meta's shape: an error, or the meta. */
export function checkMeta(value: LiteralValue): WorkflowMeta | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "meta must be an object.";
  const name = value.name;
  const description = value.description;
  if (typeof name !== "string" || !name.trim()) return "`name` is required (a string).";
  if (name.length > 80) return "`name` is longer than 80 characters.";
  if (typeof description !== "string" || !description.trim())
    return "`description` is required (a one-line string).";
  const phases: WorkflowPhase[] = [];
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) return "`phases` must be a list of { title, detail? }.";
    for (const p of value.phases) {
      if (!p || typeof p !== "object" || Array.isArray(p) || typeof p.title !== "string")
        return "each phase must be { title, detail? } with a string title.";
      phases.push({
        title: p.title,
        ...(typeof p.detail === "string" && { detail: p.detail }),
        ...(typeof p.model === "string" && { model: p.model }),
      });
    }
  }
  return {
    name: name.trim(),
    description: description.trim().replace(/\s+/g, " ").slice(0, 300),
    ...(typeof value.whenToUse === "string" && { whenToUse: value.whenToUse }),
    phases,
  };
}

// ---- parallel and pipeline (also bundled into the worker) -----------------------------------

/** Items one parallel() or pipeline() call takes at most. */
export const MAX_FAN_OUT = 4096;

/**
 * Runs thunks concurrently (at most `limit` at once) and waits for all of them: a barrier. One
 * that throws gives null; the call itself never rejects for that.
 */
export async function parallel(
  thunks: unknown,
  opts?: { limit?: number } | null,
): Promise<unknown[]> {
  if (!Array.isArray(thunks)) throw new TypeError("parallel() takes a list of functions.");
  if (thunks.length > MAX_FAN_OUT)
    throw new RangeError(`parallel() takes at most ${MAX_FAN_OUT} items (got ${thunks.length}).`);
  const limit =
    typeof opts?.limit === "number" && opts.limit >= 1 ? Math.floor(opts.limit) : thunks.length;
  const out: unknown[] = new Array(thunks.length).fill(null);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const at = next++;
      if (at >= thunks.length) return;
      const thunk = thunks[at];
      try {
        out[at] = typeof thunk === "function" ? await (thunk as () => unknown)() : null;
      } catch {
        out[at] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, thunks.length) }, worker));
  return out;
}

type Stage = (previous: unknown, item: unknown, index: number) => unknown;

/**
 * Runs each item through every stage on its own (no barrier between stages): item A can be in
 * stage 3 while B is in stage 1. Each stage gets (previous result, the item, its index); the
 * first gets the item as its previous result. A stage that throws makes that item null and skips
 * its remaining stages.
 */
export async function pipeline(items: unknown, ...stages: unknown[]): Promise<unknown[]> {
  if (!Array.isArray(items)) throw new TypeError("pipeline() takes a list of items first.");
  if (items.length > MAX_FAN_OUT)
    throw new RangeError(`pipeline() takes at most ${MAX_FAN_OUT} items (got ${items.length}).`);
  if (stages.some((s) => typeof s !== "function"))
    throw new TypeError("pipeline()'s stages must be functions.");
  return Promise.all(
    items.map(async (item, index) => {
      let value: unknown = item;
      try {
        for (const stage of stages as Stage[]) value = await stage(value, item, index);
        return value;
      } catch {
        return null;
      }
    }),
  );
}

// ---- agent() calls: options, cache, limits ---------------------------------------------------

/** What a script passes to agent(). */
export interface WorkflowAgentOptions {
  label?: string;
  phase?: string;
  /** A JSON Schema the answer must match: agent() then returns the parsed object. */
  schema?: Record<string, unknown>;
  model?: string;
  /** Narrows the tools it gets (names, as the agent's tools are named). */
  tools?: string[];
  /** A subagent to run (its name, as delegate takes it); default: general. */
  agentType?: string;
  effort?: string;
  /** D351: "worktree" runs it as a helper in a git worktree of its own, where it may edit. */
  isolation?: "worktree";
  /** D351: the files an editing agent will change (two such agents never work on the same ones at once). */
  files?: string[];
}

/** agent()'s options as given → the ones used (anything else is dropped). */
export function agentOptions(raw: unknown): WorkflowAgentOptions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const text = (v: unknown, max: number) =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
  const label = text(o.label, 80);
  const phase = text(o.phase, 80);
  const model = text(o.model, 120);
  const agentType = text(o.agentType, 60);
  const effort = text(o.effort, 20);
  const schema =
    o.schema && typeof o.schema === "object" && !Array.isArray(o.schema)
      ? (o.schema as Record<string, unknown>)
      : undefined;
  const tools = Array.isArray(o.tools)
    ? o.tools.filter((t): t is string => typeof t === "string" && !!t.trim())
    : undefined;
  const isolation = o.isolation === "worktree" ? ("worktree" as const) : undefined;
  const files =
    isolation && Array.isArray(o.files)
      ? o.files
          .filter((f): f is string => typeof f === "string" && !!f.trim())
          .slice(0, 100)
          .map((f) => f.trim())
      : undefined;
  return {
    ...(label && { label }),
    ...(phase && { phase }),
    ...(schema && { schema }),
    ...(model && { model }),
    ...(tools && { tools }),
    ...(agentType && { agentType }),
    ...(effort && { effort }),
    ...(isolation && { isolation }),
    ...(files?.length && { files }),
  };
}

/** JSON with object keys sorted: the same value always gives the same text. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(",")}}`;
}

/**
 * What a call is cached by: its prompt and the options that change its answer (schema, model,
 * tools, subagent, effort). The label and phase only change how it's shown.
 */
export function agentCallKey(prompt: string, opts: WorkflowAgentOptions): string {
  const { label: _label, phase: _phase, ...rest } = opts;
  return stableJson({ prompt, ...rest });
}

/** A finished call's result, kept with its run for a later resume. */
export interface CachedCall {
  key: string;
  value: unknown;
}

/**
 * Earlier results by call (resume): each is used once, in order, so a script that makes the same
 * call twice gets both results back.
 */
export class CallCache {
  private readonly byKey = new Map<string, unknown[]>();

  constructor(calls: readonly CachedCall[] = []) {
    for (const c of calls) {
      const list = this.byKey.get(c.key) ?? [];
      list.push(c.value);
      this.byKey.set(c.key, list);
    }
  }

  /** The next unused result of `key`, if any. */
  take(key: string): { value: unknown } | null {
    const list = this.byKey.get(key);
    if (!list?.length) return null;
    return { value: list.shift() };
  }

  get size(): number {
    let n = 0;
    for (const l of this.byKey.values()) n += l.length;
    return n;
  }
}

/** Waits for a free slot: at most `max` holders at once. */
export class Limiter {
  private active = 0;
  private readonly waiting: { resolve: () => void; reject: (e: Error) => void }[] = [];
  private closed: Error | null = null;

  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.closed) throw this.closed;
    if (this.active >= this.max)
      await new Promise<void>((resolve, reject) => this.waiting.push({ resolve, reject }));
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiting.shift()?.resolve();
    };
  }

  /** Refuses every waiter and later acquire. */
  close(reason: Error): void {
    this.closed = reason;
    for (const w of this.waiting.splice(0)) w.reject(reason);
  }

  get running(): number {
    return this.active;
  }
}

// ---- the run's model ------------------------------------------------------------------------

export type WorkflowAgentStatus = "queued" | "running" | "done" | "failed" | "cached" | "stopped";

export interface WorkflowAgentRecord {
  /** 1, 2, … in the order the script called agent(). */
  n: number;
  label: string;
  phase: string | null;
  status: WorkflowAgentStatus;
  startedAt?: number;
  endedAt?: number;
  inputTokens: number;
  outputTokens: number;
  /** Dollars, when the model's price is known. */
  cost: number | null;
  /** Why it failed. */
  error?: string;
  /** Its background subagent's id while it runs (to stop it). */
  backgroundId?: string;
  /** D351: an editing agent's worktree (set when its helper starts, its changes when it ends). */
  worktree?: WorkflowWorktree;
}

export interface WorkflowLimits {
  /** agent() calls a run may start (cached ones don't count). */
  maxAgents: number;
  /** Agents working at once. */
  concurrency: number;
  /** The whole run's wall-clock cap. */
  timeoutMs: number;
  /** D351: agents with isolation "worktree" a run may start. */
  maxEditing?: number;
}

export const DEFAULT_LIMITS: WorkflowLimits = {
  maxAgents: 10,
  concurrency: 4,
  timeoutMs: 30 * 60_000,
  maxEditing: DEFAULT_MAX_EDITING,
};

/** Limits from settings values, each kept in a sane range. */
export function workflowLimits(raw: {
  maxAgents?: unknown;
  concurrency?: unknown;
  timeoutMinutes?: unknown;
  maxEditing?: unknown;
}): WorkflowLimits {
  const int = (v: unknown, def: number, min: number, max: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : def;
  return {
    maxAgents: int(raw.maxAgents, DEFAULT_LIMITS.maxAgents, 1, 200),
    concurrency: int(raw.concurrency, DEFAULT_LIMITS.concurrency, 1, 16),
    timeoutMs: int(raw.timeoutMinutes, DEFAULT_LIMITS.timeoutMs / 60_000, 1, 24 * 60) * 60_000,
    maxEditing: maxEditingAgents(raw.maxEditing),
  };
}

/** What runs one agent: its answer (text), or null when it failed or was stopped. */
export type AgentRunner = (
  prompt: string,
  opts: WorkflowAgentOptions,
  record: WorkflowAgentRecord,
) => Promise<string | null>;

/**
 * One run's agent() calls: the cache first, then the limits (agent count, concurrency), then the
 * runner; a schema's answer is parsed and checked, asked once more when it isn't valid. Records
 * every call for the progress card and keeps each result for a later resume.
 */
export class WorkflowRuntime {
  readonly agents: WorkflowAgentRecord[] = [];
  /** Finished calls' results, in the order they finished (a resume's cache). */
  readonly results: CachedCall[] = [];
  private readonly limiter: Limiter;
  private readonly claims = new FileClaims();
  private started = 0;
  private editingStarted = 0;
  /**
   * D351: the script's text has editing calls the user was told about (editingCalls); without
   * them, a call with isolation "worktree" is refused.
   */
  allowEditing = false;
  private stopReason: string | null = null;
  /** The phase() the script is in. */
  phase: string | null = null;

  constructor(
    private readonly limits: WorkflowLimits,
    private readonly runner: AgentRunner,
    private readonly cache: CallCache = new CallCache(),
    private readonly changed: () => void = () => {},
  ) {
    this.limiter = new Limiter(limits.concurrency);
  }

  get stopped(): boolean {
    return this.stopReason !== null;
  }

  /** agent() started live (not from the cache). */
  get liveCount(): number {
    return this.started;
  }

  stop(reason: string): void {
    if (this.stopReason !== null) return;
    this.stopReason = reason;
    this.limiter.close(new Error(reason));
    this.claims.close(new Error(reason));
    for (const a of this.agents)
      if (a.status === "queued" || a.status === "running") {
        a.status = "stopped";
        a.endedAt ??= Date.now();
      }
    this.changed();
  }

  /**
   * One agent() call. Resolves with its text (or parsed object with a schema), null when it
   * failed; rejects when the run is stopped or out of agents (the script can't go on).
   */
  async call(prompt: unknown, rawOpts: unknown): Promise<unknown> {
    if (this.stopReason !== null) throw new Error(this.stopReason);
    if (typeof prompt !== "string" || !prompt.trim())
      throw new TypeError("agent() takes a prompt (a string) first.");
    const opts = agentOptions(rawOpts);
    if (opts.schema) {
      const problem = schemaProblem(opts.schema);
      if (problem) throw new TypeError(`agent()'s schema: ${problem}`);
    }
    const editing = opts.isolation === "worktree";
    if (editing && !this.allowEditing)
      throw new Error(
        "agent() with isolation: 'worktree' needs that option written in the script as a literal, so the user is told which agents edit before it runs.",
      );
    const key = agentCallKey(prompt, opts);
    const record: WorkflowAgentRecord = {
      n: this.agents.length + 1,
      label: opts.label ?? prompt.trim().split("\n")[0]?.slice(0, 60) ?? "agent",
      phase: opts.phase ?? this.phase,
      status: "queued",
      inputTokens: 0,
      outputTokens: 0,
      cost: null,
    };
    const cached = this.cache.take(key);
    if (cached) {
      record.status = "cached";
      this.agents.push(record);
      this.results.push({ key, value: cached.value });
      this.changed();
      return cached.value;
    }
    if (this.started >= this.limits.maxAgents)
      throw new Error(
        `The workflow reached its limit of ${this.limits.maxAgents} agents (agent.workflows.maxAgents).`,
      );
    if (editing && this.editingStarted >= (this.limits.maxEditing ?? DEFAULT_MAX_EDITING))
      throw new Error(
        `The workflow reached its limit of ${this.limits.maxEditing ?? DEFAULT_MAX_EDITING} editing agents (agent.workflows.maxEditingAgents).`,
      );
    this.started++;
    if (editing) this.editingStarted++;
    this.agents.push(record);
    this.changed();
    let release: () => void;
    // An editing agent waits first for its files to be free, then for a slot.
    let unclaim: () => void = () => {};
    try {
      if (editing) unclaim = await this.claims.acquire(opts.files ?? []);
      release = await this.limiter.acquire();
    } catch (err) {
      unclaim();
      record.status = "stopped";
      throw err;
    }
    try {
      if (this.stopReason !== null) throw new Error(this.stopReason);
      record.status = "running";
      record.startedAt = Date.now();
      this.changed();
      const answer = opts.schema
        ? await this.structured(prompt, opts, record, opts.schema)
        : await this.runner(prompt, opts, record);
      // An editing agent's answer comes with its branch and changes, whatever it said.
      const value =
        answer !== null && record.worktree ? worktreeResult(answer, record.worktree) : answer;
      if (this.stopReason !== null) {
        record.status = "stopped";
        return null;
      }
      record.endedAt = Date.now();
      if (value === null) {
        record.status = "failed";
        record.error ??= "it ended without an answer";
        return null;
      }
      record.status = "done";
      this.results.push({ key, value });
      return value;
    } finally {
      release();
      unclaim();
      this.changed();
    }
  }

  /** A schema's answer: parsed and checked, asked once more when it isn't valid JSON for it. */
  private async structured(
    prompt: string,
    opts: WorkflowAgentOptions,
    record: WorkflowAgentRecord,
    schema: Record<string, unknown>,
  ): Promise<unknown> {
    let ask = `${prompt}\n\n${schemaInstruction(schema)}`;
    // Asked again, an editing agent would start over in a second worktree: it gets one try.
    const attempts = opts.isolation === "worktree" ? 1 : 2;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const text = await this.runner(ask, opts, record);
      if (text === null || this.stopReason !== null) return null;
      const parsed = parseJsonAnswer(text);
      const issues = parsed.ok ? schemaIssues(parsed.value, schema) : [parsed.error];
      if (!issues.length) return parsed.ok ? parsed.value : null;
      record.error = `its answer didn't match the schema: ${issues.slice(0, 3).join("; ")}`;
      ask = `${prompt}\n\n${schemaInstruction(schema)}\n\nYour last answer was not valid: ${issues
        .slice(0, 5)
        .join("; ")}. Answer again with only the JSON.`;
    }
    return null;
  }
}

// ---- schemas -------------------------------------------------------------------------------

/** What a subagent with a schema is told about its answer. */
export function schemaInstruction(schema: Record<string, unknown>): string {
  return `Your final answer is data for a program, not a message: reply with ONLY a JSON value matching this JSON Schema (no prose, no code fence):\n${JSON.stringify(schema)}`;
}

/** An answer's JSON: the whole text, a fenced block, or the outermost {…} / […] in it. */
export function parseJsonAnswer(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const tries: string[] = [text.trim()];
  const fence = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(text);
  if (fence?.[1]) tries.push(fence[1].trim());
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const a = text.indexOf(open);
    const b = text.lastIndexOf(close);
    if (a >= 0 && b > a) tries.push(text.slice(a, b + 1));
  }
  for (const t of tries)
    try {
      return { ok: true, value: JSON.parse(t) as unknown };
    } catch {}
  return { ok: false, error: "it isn't JSON" };
}

const TYPES = ["object", "array", "string", "number", "integer", "boolean", "null"];

/** Why a schema can't be used (as Claude Code requires: an object at the root), or null. */
export function schemaProblem(schema: Record<string, unknown>): string | null {
  if (schema.type !== "object") return 'its root must be { type: "object", properties: {...} }.';
  const props = schema.properties;
  if (props !== undefined && (typeof props !== "object" || props === null || Array.isArray(props)))
    return "`properties` must be an object.";
  const required = schema.required;
  if (required !== undefined) {
    if (!Array.isArray(required)) return "`required` must be a list.";
    const known = Object.keys((props as Record<string, unknown>) ?? {});
    const missing = required.filter((r) => typeof r !== "string" || !known.includes(r));
    if (missing.length) return `required names properties it doesn't have: ${missing.join(", ")}.`;
  }
  return null;
}

/**
 * A value checked against a JSON Schema (the subset models use: type, properties, required,
 * additionalProperties: false, items, enum, const, anyOf / oneOf, minimum / maximum, min/maxItems,
 * min/maxLength). The issues, empty when it matches.
 */
export function schemaIssues(value: unknown, schema: unknown, path = ""): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const s = schema as Record<string, unknown>;
  const at = path || "(answer)";
  const out: string[] = [];
  const kind =
    value === null
      ? "null"
      : Array.isArray(value)
        ? "array"
        : typeof value === "number" && Number.isInteger(value)
          ? "integer"
          : typeof value;
  const fits = (t: string) =>
    t === kind || (t === "number" && kind === "integer") || (t === "integer" && kind === "integer");
  if (s.type !== undefined) {
    const types = (Array.isArray(s.type) ? s.type : [s.type]).filter(
      (t): t is string => typeof t === "string" && TYPES.includes(t),
    );
    if (types.length && !types.some(fits)) return [`${at}: expected ${types.join(" or ")}`];
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => stableJson(e) === stableJson(value)))
    out.push(`${at}: expected one of ${JSON.stringify(s.enum)}`);
  if ("const" in s && stableJson(s.const) !== stableJson(value))
    out.push(`${at}: expected ${JSON.stringify(s.const)}`);
  for (const key of ["anyOf", "oneOf"] as const) {
    const options = s[key];
    if (Array.isArray(options) && !options.some((o) => !schemaIssues(value, o, path).length))
      out.push(`${at}: matches none of its ${options.length} allowed shapes`);
  }
  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) out.push(`${at}: below ${s.minimum}`);
    if (typeof s.maximum === "number" && value > s.maximum) out.push(`${at}: above ${s.maximum}`);
  }
  if (typeof value === "string") {
    if (typeof s.minLength === "number" && value.length < s.minLength)
      out.push(`${at}: shorter than ${s.minLength}`);
    if (typeof s.maxLength === "number" && value.length > s.maxLength)
      out.push(`${at}: longer than ${s.maxLength}`);
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems)
      out.push(`${at}: fewer than ${s.minItems} items`);
    if (typeof s.maxItems === "number" && value.length > s.maxItems)
      out.push(`${at}: more than ${s.maxItems} items`);
    if (s.items && typeof s.items === "object")
      value.forEach((v, i) => {
        out.push(...schemaIssues(v, s.items, `${path}/${i}`));
      });
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    const props =
      s.properties && typeof s.properties === "object"
        ? (s.properties as Record<string, unknown>)
        : {};
    if (Array.isArray(s.required))
      for (const r of s.required)
        if (typeof r === "string" && o[r] === undefined) out.push(`${path}/${r}: required`);
    for (const [k, v] of Object.entries(o)) {
      if (k in props) out.push(...schemaIssues(v, props[k], `${path}/${k}`));
      else if (s.additionalProperties === false) out.push(`${path}/${k}: not allowed`);
      else if (s.additionalProperties && typeof s.additionalProperties === "object")
        out.push(...schemaIssues(v, s.additionalProperties, `${path}/${k}`));
    }
  }
  return out;
}

// ---- what the chat is told ------------------------------------------------------------------

export function formatTokens(n: number): string {
  return n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}k`
      : String(n);
}

/** The run's usage in a few words ("3 agents · 12.4k tokens · $0.02"). */
export function usageLine(agents: readonly WorkflowAgentRecord[]): string {
  const live = agents.filter((a) => a.status !== "cached");
  const cached = agents.length - live.length;
  const tokens = agents.reduce((n, a) => n + a.inputTokens + a.outputTokens, 0);
  const costs = agents.map((a) => a.cost).filter((c): c is number => c !== null);
  const cost = costs.reduce((n, c) => n + c, 0);
  return [
    `${live.length} agent${live.length === 1 ? "" : "s"}`,
    cached ? `${cached} cached` : "",
    tokens ? `${formatTokens(tokens)} tokens` : "",
    costs.length && cost > 0 ? `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Characters of the result the automatic message carries at most. */
export const RESULT_CHARS = 12_000;

/** The automatic message a finished (or failed, stopped) run sends its chat. */
export function workflowEndText(run: {
  id: string;
  name: string;
  status: "done" | "failed" | "stopped";
  error?: string;
  result?: string;
  agents: readonly WorkflowAgentRecord[];
  durationMs: number;
  logs?: readonly string[];
}): string {
  const head =
    run.status === "done"
      ? `Workflow ${run.id} (${run.name}) finished`
      : run.status === "stopped"
        ? `Workflow ${run.id} (${run.name}) was stopped`
        : `Workflow ${run.id} (${run.name}) failed`;
  const failed = run.agents.filter((a) => a.status === "failed");
  const lines = [
    `${head} after ${shortMs(run.durationMs)}: ${usageLine(run.agents)}.${run.error ? ` ${run.error}` : ""}`,
  ];
  if (failed.length)
    lines.push(
      `Agents that failed (they returned null): ${failed
        .slice(0, 8)
        .map((a) => `${a.label}${a.error ? ` (${a.error})` : ""}`)
        .join("; ")}.`,
    );
  if (run.logs?.length) lines.push(`Its log:\n${run.logs.slice(-20).join("\n")}`);
  lines.push(...worktreeLines(run.agents));
  if (run.status === "done") {
    const result = run.result ?? "undefined";
    lines.push(
      `Its result:\n${result.length > RESULT_CHARS ? `${result.slice(0, RESULT_CHARS)}\n… [${result.length - RESULT_CHARS} more characters cut]` : result}`,
    );
  }
  lines.push(
    `To re-run it with changes, call run_workflow with resume_from: "${run.id}" (and the edited script): unchanged agent() calls return their cached results.`,
  );
  return lines.join("\n\n");
}

export function shortMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ---- the worker's messages ------------------------------------------------------------------

/** To the worker: the script's body and args; an agent() call's outcome. */
export type ToWorkflowWorker =
  | { t: "start"; body: string; args: string }
  | { t: "agent"; id: number; ok: true; value: string }
  | { t: "agent"; id: number; ok: false; error: string };

/** From the worker: an agent() call, phase(), log(), and how the script ended. */
export type FromWorkflowWorker =
  | { t: "agent"; id: number; prompt: unknown; opts: string }
  | { t: "phase"; title: string }
  | { t: "log"; text: string }
  | { t: "done"; result: string }
  | { t: "error"; error: string };

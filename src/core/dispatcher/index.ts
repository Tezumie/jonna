// The dispatcher: every action in the IDE is a command run through this one pipeline (PLAN §6):
//   look up → check `when` → validate input → caller checks (permissions/commandGuards) →
//   authorize(caller, effects) → run
//   → validate output (dev) → audit log → emit `command.executed`.
// UI, keybindings, the palette, tests and (later) agents/MCP/extensions all call `execute()`.
import type { ContextKeyService } from "../context/index";
import { type Disposable, toDisposable } from "../lifecycle/index";
import { callerRefusal } from "../permissions/commandGuards";
import type { PermissionPolicy } from "../permissions/index";
import { formatIssues, type Schema } from "../schema/index";
import { fitToBudget } from "../state/budget";
import {
  type AuditEntry,
  type Caller,
  type CommandContext,
  CommandError,
  type CommandExecutedEvent,
  type CommandInfo,
  type CommandSpec,
  type CommandStatus,
  callerLabel,
  type Effect,
  USER,
} from "./types";

export * from "./types";

export interface DispatcherEvents {
  "command.executed": CommandExecutedEvent;
  "command.registered": { id: string };
  /** A command passed its checks (input, permission) and is about to run. */
  "command.started": { id: string; caller: Caller; execution: number };
}

/** Anything that can emit the dispatcher's events (an EventBus with a superset of events works). */
export interface DispatcherEventSink {
  emit<K extends keyof DispatcherEvents>(type: K, value: DispatcherEvents[K]): void;
}

export interface DispatcherDeps {
  context: ContextKeyService;
  permissions: PermissionPolicy;
  events: DispatcherEventSink;
  /** Persists one audit entry (Rust appends to logs/audit.jsonl). Failures are logged, not thrown. */
  audit: (entry: AuditEntry) => Promise<void> | void;
  /** Validate outputs too (dev builds). */
  validateOutput?: boolean;
  now?: () => number;
}

const ID_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
const AUDIT_INPUT_BUDGET = 1_000;
const AUDIT_OUTPUT_BUDGET = 500;

/** A registered command with types erased; inputs are validated before `run` sees them. */
interface RegisteredCommand {
  info: Omit<CommandInfo, "enabled">;
  input: Schema<unknown, boolean>;
  output: Schema<unknown, boolean> | undefined;
  confirm: ((input: unknown) => string) | undefined;
  run: (input: unknown, ctx: CommandContext) => Promise<unknown>;
}

export class Dispatcher implements Disposable {
  private readonly commands = new Map<string, RegisteredCommand>();
  private readonly now: () => number;

  constructor(private readonly deps: DispatcherDeps) {
    this.now = deps.now ?? (() => performance.now());
  }

  register<I, O>(spec: CommandSpec<I, O>): Disposable {
    if (!ID_PATTERN.test(spec.id)) {
      throw new Error(`Invalid command id "${spec.id}": use "namespace.verb" (camelCase segments)`);
    }
    if (this.commands.has(spec.id)) throw new Error(`Command already registered: ${spec.id}`);
    if (!spec.description.trim()) throw new Error(`Command ${spec.id} needs a description`);
    const entry: RegisteredCommand = {
      info: {
        id: spec.id,
        title: spec.title,
        category: spec.category,
        description: spec.description,
        effects: Object.freeze([...spec.effects]),
        when: spec.when,
        agent: spec.agent ?? "discoverable",
        palette: spec.palette ?? true,
        inputSchema: spec.input.json,
      },
      input: spec.input as Schema<unknown, boolean>,
      output: spec.output as Schema<unknown, boolean> | undefined,
      confirm: spec.confirm ? (input) => spec.confirm?.(input as I) ?? "" : undefined,
      run: async (input, ctx) => spec.run(input as I, ctx),
    };
    this.commands.set(spec.id, entry);
    this.deps.events.emit("command.registered", { id: spec.id });
    return toDisposable(() => {
      if (this.commands.get(spec.id) === entry) this.commands.delete(spec.id);
    });
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  info(id: string): CommandInfo | undefined {
    const cmd = this.commands.get(id);
    return cmd ? { ...cmd.info, enabled: this.deps.context.matches(cmd.info.when) } : undefined;
  }

  /** All commands, sorted by id, with `enabled` evaluated against current context keys. */
  list(): CommandInfo[] {
    return [...this.commands.values()]
      .map((cmd) => ({ ...cmd.info, enabled: this.deps.context.matches(cmd.info.when) }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** True if `{}` is valid input, i.e. the command can run without arguments. */
  acceptsEmptyInput(id: string): boolean {
    return this.commands.get(id)?.input.validate({}).ok ?? false;
  }

  /** Runs a command through the full pipeline. Throws `CommandError` on any failure. */
  private executions = 0;

  async execute<O = unknown>(id: string, input: unknown = {}, caller: Caller = USER): Promise<O> {
    const start = this.now();
    const execution = ++this.executions;
    const cmd = this.commands.get(id);
    const effects: readonly Effect[] = cmd?.info.effects ?? [];
    const finish = (status: CommandStatus, error?: string, output?: unknown): void => {
      const durationMs = Math.round((this.now() - start) * 100) / 100;
      void this.audit({
        ts: new Date().toISOString(),
        id,
        caller: callerLabel(caller),
        effects,
        status,
        durationMs,
        input: fitToBudget(input, AUDIT_INPUT_BUDGET).value,
        ...(output !== undefined && { output: fitToBudget(output, AUDIT_OUTPUT_BUDGET).value }),
        ...(error !== undefined && { error }),
      });
      this.deps.events.emit("command.executed", {
        id,
        caller,
        status,
        durationMs,
        execution,
        ...(error !== undefined && { error }),
      });
    };
    const fail = (status: CommandStatus, error: CommandError): never => {
      finish(status, error.message);
      throw error;
    };

    if (!cmd) return fail("notFound", new CommandError("NotFound", id, `Unknown command "${id}"`));
    if (!this.deps.context.matches(cmd.info.when)) {
      return fail(
        "disabled",
        new CommandError(
          "Disabled",
          id,
          `"${id}" is not available now (requires: ${cmd.info.when})`,
        ),
      );
    }
    const parsed = cmd.input.validate(input);
    if (!parsed.ok) {
      return fail(
        "invalid",
        new CommandError(
          "InvalidInput",
          id,
          `Invalid input for "${id}": ${formatIssues(parsed.issues)}`,
        ),
      );
    }
    // Inputs only the user may give (an engine command that runs IDE commands as the user…).
    const refusal = callerRefusal(id, parsed.value, caller);
    if (refusal) return fail("denied", new CommandError("Denied", id, refusal));
    let decision: Awaited<ReturnType<PermissionPolicy["authorize"]>>;
    try {
      decision = await this.deps.permissions.authorize({
        caller,
        commandId: id,
        title: cmd.info.title,
        effects,
        confirmMessage: cmd.confirm?.(parsed.value),
        agent: cmd.info.agent,
        input: parsed.value,
      });
    } catch (err) {
      // A prompt that failed (its panel closed…) is a refusal, typed and audited like one.
      const message = err instanceof Error ? err.message : String(err);
      return fail("denied", new CommandError("Denied", id, message, { cause: err }));
    }
    if (decision !== "allow") {
      return fail(
        "denied",
        new CommandError("Denied", id, `Not permitted: "${id}" for ${callerLabel(caller)}`),
      );
    }

    const ctx: CommandContext = {
      caller,
      execute: (nextId, nextInput) => this.execute(nextId, nextInput, caller),
    };
    let result: unknown;
    this.deps.events.emit("command.started", { id, caller, execution });
    try {
      result = await cmd.run(parsed.value, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail("error", new CommandError("Failed", id, message, { cause: err }));
    }
    if (this.deps.validateOutput && cmd.output) {
      const out = cmd.output.validate(result);
      if (!out.ok) {
        return fail(
          "error",
          new CommandError(
            "InvalidOutput",
            id,
            `Invalid output from "${id}": ${formatIssues(out.issues)}`,
          ),
        );
      }
    }
    finish("ok", undefined, result);
    return result as O;
  }

  private async audit(entry: AuditEntry): Promise<void> {
    try {
      await this.deps.audit(entry);
    } catch (err) {
      console.warn("audit log write failed", err);
    }
  }

  dispose(): void {
    this.commands.clear();
  }
}

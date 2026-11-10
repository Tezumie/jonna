import type { AnySchema, Schema } from "../schema/index";

/** What a command may do. Drives the permission policy (PLAN §6). */
export type Effect = "read" | "write" | "exec" | "network" | "destructive";

/** Who is calling. Every execution knows its caller (PLAN §2.2). */
export type Caller =
  | { kind: "user" }
  | { kind: "test" }
  | { kind: "agent"; session: string }
  | { kind: "acp"; agent: string; session: string }
  | { kind: "ext"; id: string }
  | { kind: "mcp"; client: string };

export const USER: Caller = Object.freeze({ kind: "user" });

export function callerLabel(caller: Caller): string {
  switch (caller.kind) {
    case "user":
    case "test":
      return caller.kind;
    case "agent":
      return `agent:${caller.session}`;
    case "acp":
      return `acp:${caller.agent}:${caller.session}`;
    case "ext":
      return `ext:${caller.id}`;
    case "mcp":
      return `mcp:${caller.client}`;
  }
}

export interface CommandContext {
  readonly caller: Caller;
  /** Runs another command as the same caller (so permissions and audit stay attributed). */
  execute<O = unknown>(id: string, input?: unknown): Promise<O>;
}

export interface CommandSpec<I, O> {
  /** "namespace.verb", e.g. "editor.openFile". */
  id: string;
  /** Palette label. */
  title: string;
  /** Palette group, e.g. "File", "View". */
  category?: string;
  /** For humans AND models: what it does and when to use it. */
  description: string;
  input: Schema<I, boolean>;
  output?: Schema<O, boolean>;
  effects: Effect[];
  /** Context-key precondition; the command is disabled when false. */
  when?: string;
  /** Visibility to agents. Default "discoverable". */
  agent?: "core" | "discoverable" | "hidden";
  /** Shown in the palette (default true). */
  palette?: boolean;
  examples?: { input: I; note?: string }[];
  /** Confirmation text for `destructive` commands run by the user ("Delete 'a.ts'?"). */
  confirm?(input: I): string;
  run(input: I, ctx: CommandContext): Promise<O> | O;
}

export interface CommandInfo {
  id: string;
  title: string;
  category: string | undefined;
  description: string;
  effects: readonly Effect[];
  when: string | undefined;
  agent: "core" | "discoverable" | "hidden";
  palette: boolean;
  inputSchema: AnySchema["json"];
  /** True if `when` currently holds. */
  enabled: boolean;
}

export type CommandStatus = "ok" | "error" | "denied" | "invalid" | "disabled" | "notFound";

export interface CommandExecutedEvent {
  id: string;
  caller: Caller;
  status: CommandStatus;
  durationMs: number;
  error?: string;
  /** Pairs this event with its `command.started` (one number per execute call). */
  execution: number;
}

export interface AuditEntry {
  ts: string;
  id: string;
  caller: string;
  effects: readonly Effect[];
  status: CommandStatus;
  durationMs: number;
  /** Input, truncated to a small budget. */
  input?: unknown;
  /** Result, truncated to a small budget (successful runs only). */
  output?: unknown;
  error?: string;
}

export type CommandErrorCode =
  | "NotFound"
  | "Disabled"
  | "InvalidInput"
  | "Denied"
  | "Failed"
  | "InvalidOutput";

export class CommandError extends Error {
  constructor(
    readonly code: CommandErrorCode,
    readonly commandId: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CommandError";
  }
}

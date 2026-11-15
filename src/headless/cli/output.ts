// How a one-shot run ends for whoever started it: the exit code, and the result as text, as one
// JSON object (`--output-format json`) or as the last line of the event stream (`stream-json`).
// Pure.
import { redactSecrets } from "../../core/diagnostics/redact";
import type { PermissionDecision, RunResult, SessionEvent, SessionUsage } from "../run";

export const EXIT = {
  ok: 0,
  /** The task failed: the model or a tool failed, or a limit stopped it. */
  failed: 1,
  /** Bad usage or configuration. */
  usage: 2,
  /** A permission was refused. */
  refused: 3,
  /** Interrupted (Ctrl+C). */
  interrupted: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * The exit code of a finished run. A failure or a limit: 1. Interrupted: 130. The agent answered
 * but something it asked for was refused (by the policy, the deny list or the person): 3, since
 * the task couldn't be done as asked. An answer that couldn't be saved to its chat (`unsaved`:
 * someone else saved the chat meanwhile): 1, since a later --resume won't have this turn. Else 0.
 */
export function exitCodeOf(
  result: Pick<RunResult, "reason" | "denied">,
  unsaved = false,
): ExitCode {
  switch (result.reason) {
    case "cancelled":
      return EXIT.interrupted;
    case "error":
    case "max_steps":
    case "timeout":
    case "max_cost":
    case "stopped":
      return EXIT.failed;
    case "end":
      if (unsaved) return EXIT.failed;
      return result.denied.length > 0 ? EXIT.refused : EXIT.ok;
  }
}

/**
 * What to say when the chat was saved by someone else (a window, another run) while this run
 * worked on it: the stored chat is kept as they left it, so this run's turn is not in it.
 */
export function unsavedNote(session: string): string {
  return `The chat ${session} was saved by another window or run while this one worked on it. The saved chat was kept as it is: this run's turn is NOT in it (what the run changed on disk stays). Use one chat from one place at a time, or give each run a chat of its own.`;
}

/** Why a run ended, in a sentence, when it didn't simply answer; null when it did. */
export function endNote(result: Pick<RunResult, "reason" | "error" | "denied">): string | null {
  switch (result.reason) {
    case "end":
      return result.denied.length
        ? `Refused: ${result.denied.map(deniedLine).join("; ")}. Allow it with --allow or --permission-mode.`
        : null;
    case "error":
      return `The run failed: ${redactSecrets(result.error ?? "the model or the provider failed")}`;
    case "max_steps":
      return "Stopped at the step limit with work left (raise --max-steps, or --continue).";
    case "timeout":
      return "Stopped at the time limit (--timeout).";
    case "max_cost":
      return "Stopped at the cost limit (--max-cost).";
    case "cancelled":
      return "Interrupted.";
    case "stopped":
      return "The run was stopped.";
  }
}

const deniedLine = (d: PermissionDecision): string =>
  `${d.code ?? d.tool ?? d.title}${d.rule ? ` (denied by ${d.rule})` : ""}`;

/** The result object of `json`, and the last line of `stream-json`. */
export interface ResultRecord {
  type: "result";
  /** The run exited 0. */
  ok: boolean;
  exitCode: number;
  /** The chat's id (continue it with `--resume`); null when the run never started. */
  session: string | null;
  /** The answer. */
  text: string;
  /** `end`, `error`, `max_steps`, `timeout`, `max_cost`, `cancelled`, `stopped`; or why it never ran: `usage`, `config`. */
  reason: string;
  error?: string;
  usage: SessionUsage | null;
  steps: number;
  cost: number | null;
  denied: PermissionDecision[];
  /** Files whose edits wait for review (`--review`). */
  pending: string[];
  /** The turn isn't in the saved chat: someone else saved the chat while the run worked. */
  unsaved?: true;
  durationMs: number;
}

export function resultRecord(result: RunResult, durationMs: number, unsaved = false): ResultRecord {
  const exitCode = exitCodeOf(result, unsaved);
  return {
    type: "result",
    ok: exitCode === 0,
    exitCode,
    session: result.session,
    text: result.text,
    reason: result.reason,
    ...(result.error && { error: redactSecrets(result.error) }),
    usage: result.usage,
    steps: result.steps,
    cost: result.cost,
    denied: result.denied,
    pending: result.pending,
    ...(unsaved && { unsaved: true as const }),
    durationMs,
  };
}

/** The result of a run that never started (bad usage, no model, no host…). */
export function failureRecord(
  reason: "usage" | "config" | "error" | "cancelled",
  exitCode: number,
  error: string,
  durationMs: number,
): ResultRecord {
  return {
    type: "result",
    ok: false,
    exitCode,
    session: null,
    text: "",
    reason,
    error: redactSecrets(error),
    usage: null,
    steps: 0,
    cost: null,
    denied: [],
    pending: [],
    durationMs,
  };
}

/** One line of `stream-json`: an event of the chat, or the result. Never contains a newline. */
export function jsonLine(value: SessionEvent | ResultRecord): string {
  return `${JSON.stringify(value.type === "result" ? value : eventWithoutSecrets(value))}\n`;
}

/**
 * An event as it is printed. The texts of a failure (the chat's error, a notice, a turn that
 * failed) are a provider's, an MCP server's or another agent's own words, and some repeat the
 * request they refused, key and all: secrets are taken out of those. What the model wrote and
 * what tools were given and answered stay as they are.
 */
export function eventWithoutSecrets(event: SessionEvent): SessionEvent {
  switch (event.type) {
    case "error":
      return { ...event, message: redactSecrets(event.message) };
    case "notice":
      return {
        ...event,
        text: redactSecrets(event.text),
        ...(event.detail !== undefined && { detail: redactSecrets(event.detail) }),
      };
    case "turn.end":
      return event.error ? { ...event, error: redactSecrets(event.error) } : event;
    default:
      return event;
  }
}

/** `json`: the result alone, on one line. */
export function jsonResult(record: ResultRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/** `text`: the answer, ending in exactly one newline (nothing when there is no answer). */
export function textResult(result: Pick<RunResult, "text">): string {
  const text = result.text.replace(/\s+$/, "");
  return text ? `${text}\n` : "";
}

/** Dollars, short: "$0.0123", "$1.20"; "" when the price isn't known. */
export function money(cost: number | null | undefined): string {
  if (cost === null || cost === undefined) return "";
  if (cost === 0) return "$0.00";
  return cost < 0.1 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

/** A count of tokens, short: 950, 12.3k, 1.2M. */
export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

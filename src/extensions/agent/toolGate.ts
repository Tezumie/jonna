// Checks before each agent tool call: per-category auto-approve (autoApprove.ts, D204) asks
// before reading or writing the paths the user protected; the risky-folder guard (riskyGuard.ts,
// D213) asks before the agent works in Downloads and before it changes another agent's config.
// Registered by the agent extension; the session runs them in order before the tool, and the
// first non-null outcome replaces the call (denied).
import type { ToolOutcome } from "../../core/agent/loop";
import { type Disposable, toDisposable } from "../../core/lifecycle/index";

export interface ToolGateContext {
  /** The chat's id. */
  session: string;
  name: string;
  args: Record<string, unknown>;
  ask: (request: {
    title: string;
    heading: string;
    code: string;
    kind: "tool";
    detail?: string;
    always?: string;
    evenWithFullAccess?: boolean;
  }) => Promise<"once" | "always" | "deny">;
  /** A note in the chat ("Always" saved as a pattern, D207). */
  note?: (text: string) => void;
}

export type ToolGate = (ctx: ToolGateContext) => Promise<ToolOutcome | null>;

let gates: ToolGate[] = [];

/** Adds a gate (`first`: before the others, for safety checks). */
export function addToolGate(gate: ToolGate, at: "first" | "last" = "last"): Disposable {
  gates = at === "first" ? [gate, ...gates] : [...gates, gate];
  return toDisposable(() => {
    gates = gates.filter((g) => g !== gate);
  });
}

export async function runToolGate(ctx: ToolGateContext): Promise<ToolOutcome | null> {
  for (const gate of [...gates]) {
    const outcome = await gate(ctx).catch(() => null);
    if (outcome) return outcome;
  }
  return null;
}

// The permission hook between validation and execution. M1 policy: the user may do anything
// (destructive commands ask for confirmation); every other caller is denied by default.
// The full matrix from PLAN §6 (agents → changesets, ask-per-domain, …) arrives with agents in M4.
import type { Caller, Effect } from "../dispatcher/types";
import { IDE_CONTROL_GRANT, isIdeControl } from "./ideControl";

export type Decision = "allow" | "deny";

export interface AuthorizeRequest {
  caller: Caller;
  commandId: string;
  title: string;
  effects: readonly Effect[];
  /** Confirmation text from the command's `confirm(input)`, if any. */
  confirmMessage: string | undefined;
  /** The command's agent visibility ("hidden" commands are UI-only). */
  agent?: "core" | "discoverable" | "hidden";
  /** The validated input (an agent's terminal command line is checked against the denylist). */
  input?: unknown;
  /**
   * An agent changing the IDE itself (layout, views, settings, extensions, D176): asked even in
   * full-access mode; "Allow for this chat" covers all of it.
   */
  ideControl?: boolean;
}

export interface PermissionPolicy {
  authorize(request: AuthorizeRequest): Promise<Decision>;
}

export type ConfirmFn = (message: string, title: string) => Promise<boolean>;

export function createM1Policy(confirm: ConfirmFn): PermissionPolicy {
  return {
    async authorize(request) {
      if (request.caller.kind !== "user") return "deny";
      if (request.effects.includes("destructive")) {
        const message = request.confirmMessage ?? `Run "${request.title}"? This cannot be undone.`;
        return (await confirm(message, request.title)) ? "allow" : "deny";
      }
      return "allow";
    },
  };
}

export interface M2PolicyOptions {
  /** User confirmation for destructive commands. */
  confirm: ConfirmFn;
  /** Asks the user whether an MCP client may run a command (title, client, effects). */
  askMcp(request: AuthorizeRequest & { client: string }): Promise<"once" | "session" | "deny">;
  /** True while a `--run-test-script` run is active: `caller: test` may do anything. */
  testMode(): boolean;
  /**
   * Asks the user (inline, in the agent's conversation) whether an agent may run a command that
   * changes something. Without it, agents may only read.
   */
  askAgent?(request: AuthorizeRequest & { session: string }): Promise<"once" | "session" | "deny">;
  /**
   * Requests an agent must always be asked about, whatever was granted (a protection the user
   * turned on, e.g. browser actions; D179): no read-only shortcut and no session grant.
   */
  agentAlwaysAsks?(request: AuthorizeRequest): boolean;
  /**
   * Decides for a third-party extension (M6, D102): the extensions host checks the command
   * against the permissions the user granted at install. Without it, extensions are denied.
   */
  authorizeExtension?(request: AuthorizeRequest & { extension: string }): Promise<Decision>;
}

/**
 * M2 policy: the user as in M1; `test` callers only during a test run (no prompts); MCP clients
 * may read freely, other effects ask (once or for the session), destructive always asks, hidden
 * (UI-only) commands are denied. Agents ask in their conversation; extensions are decided by
 * `authorizeExtension` (granted permissions).
 */
export function createM2Policy(options: M2PolicyOptions): PermissionPolicy {
  const user = createM1Policy(options.confirm);
  const sessionGrants = new Set<string>();
  return {
    async authorize(request) {
      const { caller, effects } = request;
      if (caller.kind === "user") return user.authorize(request);
      if (caller.kind === "test") return options.testMode() ? "allow" : "deny";
      if (caller.kind === "agent" || caller.kind === "acp") {
        // Agents (M4, PLAN §6): read freely; UI-only commands (no effects) are harmless; anything
        // else asks in the conversation (destructive every time); file edits don't come through
        // here — agent tools put them in the changeset for review.
        if (request.agent === "hidden") return "deny";
        const ideControl = isIdeControl(request.commandId, effects);
        const always = options.agentAlwaysAsks?.(request) === true;
        if (!always && !ideControl && effects.every((e) => e === "read")) return "allow";
        const key = `agent\0${caller.session}\0${ideControl ? IDE_CONTROL_GRANT : request.commandId}`;
        if (!always && !effects.includes("destructive") && sessionGrants.has(key)) return "allow";
        if (!options.askAgent) return "deny";
        const answer = await options.askAgent({
          ...request,
          session: caller.session,
          ...(ideControl && { ideControl: true }),
        });
        if (answer === "session" && !effects.includes("destructive")) sessionGrants.add(key);
        return answer === "deny" ? "deny" : "allow";
      }
      if (caller.kind === "ext") {
        if (request.agent === "hidden" || !options.authorizeExtension) return "deny";
        return options.authorizeExtension({ ...request, extension: caller.id });
      }
      if (caller.kind !== "mcp") return "deny";
      if (request.agent === "hidden") return "deny";
      const readOnly = effects.every((e) => e === "read");
      if (readOnly) return "allow";
      const key = `${caller.client}\0${request.commandId}`;
      if (!effects.includes("destructive") && sessionGrants.has(key)) return "allow";
      const answer = await options.askMcp({ ...request, client: caller.client });
      if (answer === "session" && !effects.includes("destructive")) sessionGrants.add(key);
      return answer === "deny" ? "deny" : "allow";
    },
  };
}

/** Allows everything (unit tests). */
export const ALLOW_ALL: PermissionPolicy = { authorize: async () => "allow" };

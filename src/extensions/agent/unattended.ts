// The permission policy of a run with nobody at the window: what the agent may do without
// asking, what it may never do, and what happens to a question nobody is there to answer. It is
// part of the agent's host (agentHost.ts) and is read where a chat already decides: before a
// tool call runs (the deny list), and where a chat would show a permission card (the allow list,
// then "otherwise"). The access mode is the app's own, applied through the settings it already
// reads (`modeSettings`), so the same rules decide as in the window. DOM-free.
import type { PendingPrompt, PromptPolicy } from "./agentHost";
import { commandAllowed, normalizedCommandParts } from "./permissions";
import type { PermissionRequest } from "./sessionTypes";

/**
 * The app's four access modes. `ask`: edits wait for review, commands ask. `accept-edits`: edits
 * apply (checkpointed), commands ask. `auto`: edits apply, commands run except the risky ones
 * (deleting, pushing, the user's denied commands), which ask. `full-access`: nothing asks.
 */
export type AccessMode = "ask" | "accept-edits" | "auto" | "full-access";

export const ACCESS_MODES: readonly AccessMode[] = ["ask", "accept-edits", "auto", "full-access"];

export interface UnattendedPolicy {
  /** The access mode of this run; left out: what the settings and the chat say. */
  mode?: AccessMode;
  /**
   * What may go ahead without asking, beyond the mode. Each entry is one of:
   * - a tool's name (`write_file`, `run_command`, an MCP tool's `server__tool`), `*` for any run
   *   of characters; `tool:<name>` says it is a tool;
   * - a command line pattern as in `agent.allowedCommands`: a prefix on word boundaries
   *   (`npm test` allows `npm test -- x`), or ending in `*` for a raw prefix; every part of a
   *   chained command must be allowed; `cmd:<pattern>` says it is a command;
   * - an IDE command's id (`terminal.runCommand`).
   * An entry here also answers what asks whatever the mode (deletion protection, the agent
   * changing the IDE): the person named it.
   */
  allow?: readonly string[];
  /**
   * What is refused, whatever the mode and the allow list: the same entries. A denied tool or
   * command line doesn't run; the model is told it was refused. A command pattern here matches
   * each part of a chained line by its words (a prefix), not what a shell would expand: it is a
   * guard against the expected, not a sandbox.
   */
  deny?: readonly string[];
  /**
   * What happens to a question neither list answers: `deny` (nobody can answer; the default) or
   * `wait` (it stays on the chat until a front end answers with `agent.respondPermission`).
   */
  otherwise?: "deny" | "wait";
}

/** A permission question's outcome and who gave it. */
export interface PermissionDecision {
  /** The request's id when it waited on the chat; none when it was decided before it would. */
  id?: string;
  title: string;
  kind?: PermissionRequest["kind"];
  /** What it was about (a command line, a command's id), when the request said. */
  code?: string;
  /** The tool call that asked, when one did. */
  tool?: string;
  answer: "once" | "always" | "deny";
  /**
   * `policy`: the run's allow or deny list, or its "otherwise". `mode`: full access. `user`:
   * answered on the chat (the window's card, `agent.respondPermission`), or refused by Stop.
   */
  by: "policy" | "mode" | "user";
  /** The allow or deny entry that decided it. */
  rule?: string;
}

const strip = (entry: string, prefix: string): string | null =>
  entry.startsWith(prefix) ? entry.slice(prefix.length).trim() : null;

/** `pattern` with `*` for any run of characters, against the whole of `text`. */
function globEquals(pattern: string, text: string): boolean {
  if (!pattern.includes("*")) return pattern === text;
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(text);
}

/** The entry of `list` that names tool `name`, if one does. */
function toolRule(list: readonly string[], name: string): string | undefined {
  return list.find((entry) => {
    const e = entry.trim();
    if (!e || strip(e, "cmd:") !== null) return false;
    return globEquals(strip(e, "tool:") ?? e, name);
  });
}

/** The command patterns of `list` (entries that don't say they are a tool), with their entry. */
const commandPatterns = (list: readonly string[]): { entry: string; pattern: string }[] =>
  list.flatMap((entry) => {
    const e = entry.trim();
    if (!e || strip(e, "tool:") !== null) return [];
    return [{ entry: e, pattern: strip(e, "cmd:") ?? e }];
  });

/** The entry of `list` that allows the whole command line (the entries, when it takes several). */
function allowedCommandRule(list: readonly string[], line: string): string | undefined {
  const patterns = commandPatterns(list);
  if (
    !patterns.length ||
    !commandAllowed(
      line,
      patterns.map((p) => p.pattern),
    )
  )
    return undefined;
  return (
    patterns.find((p) => commandAllowed(line, [p.pattern]))?.entry ??
    patterns.map((p) => p.entry).join(", ")
  );
}

/** The entry of `list` that one part of the command line matches, if one does. */
function deniedCommandRule(list: readonly string[], line: string): string | undefined {
  const parts = [
    ...line
      .split(/\s*(?:&&|\|\||;|\||&|[\r\n]+)\s*/)
      .map((p) => p.trim())
      .filter(Boolean),
    ...normalizedCommandParts(line),
  ].map((p) => p.toLowerCase());
  return commandPatterns(list).find(({ pattern }) => {
    const p = pattern.toLowerCase();
    return parts.some((part) =>
      p.endsWith("*") ? part.startsWith(p.slice(0, -1)) : part === p || part.startsWith(`${p} `),
    );
  })?.entry;
}

/** The command line a tool call runs, when it is one that runs a command line. */
function commandLineOf(name: string, args: Record<string, unknown>): string | null {
  if (name !== "run_command") return null;
  return typeof args.command === "string" ? args.command : null;
}

/**
 * The deny entry that refuses tool call `name` with `args` (its name, or the command line it
 * runs), or null when the policy lets it be decided as usual.
 */
export function deniedCall(
  policy: UnattendedPolicy | null,
  name: string,
  args: Record<string, unknown>,
): string | null {
  const deny = policy?.deny ?? [];
  if (!deny.length) return null;
  const byName = toolRule(deny, name);
  if (byName) return byName;
  const line = commandLineOf(name, args);
  return (line && deniedCommandRule(deny, line)) || null;
}

/** What a permission question is about, for the lists: the tool call behind it, when there is one. */
export interface AskedCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * How the policy's lists answer a question a chat is about to show: denied or allowed by an
 * entry, or null when neither list names it (the mode, then `otherwise`, decide).
 */
export function listDecision(
  policy: UnattendedPolicy | null,
  request: Pick<PermissionRequest, "title" | "kind" | "code">,
  call?: AskedCall,
): { answer: "once" | "deny"; rule: string } | null {
  if (!policy) return null;
  const deny = policy.deny ?? [];
  const allow = policy.allow ?? [];
  // What the question names: a command line, an IDE command's id, or (an external agent's own
  // request) its title, which is the command it wants to run.
  const subject = request.code ?? (request.kind === "agent" ? request.title : undefined);
  const isLine = request.kind === "command" || request.kind === "agent";
  if (deny.length) {
    const rule =
      (call && toolRule(deny, call.name)) ||
      (subject && isLine && deniedCommandRule(deny, subject)) ||
      (subject && request.kind === "ide" && toolRule(deny, subject)) ||
      undefined;
    if (rule) return { answer: "deny", rule };
  }
  if (allow.length) {
    const rule =
      (call && toolRule(allow, call.name)) ||
      (subject && isLine && allowedCommandRule(allow, subject)) ||
      (subject && request.kind === "ide" && toolRule(allow, subject)) ||
      undefined;
    if (rule) return { answer: "once", rule };
  }
  return null;
}

/**
 * The settings an access mode stands for (the ones the window's access menu writes), and
 * whether edits apply without review. Applied for the run only, never written.
 */
export function modeSettings(mode: AccessMode): {
  settings: Record<string, unknown>;
  autoApply: boolean;
} {
  switch (mode) {
    case "ask":
      return { settings: { "agent.runCommands": "ask" }, autoApply: false };
    case "accept-edits":
      return { settings: { "agent.runCommands": "ask" }, autoApply: true };
    case "auto":
      return { settings: { "agent.runCommands": "auto" }, autoApply: true };
    case "full-access":
      return { settings: { "agent.runCommands": "full" }, autoApply: true };
  }
}

/**
 * The host prompts' policy that goes with a permission policy (an MCP server's input, sign-in
 * again, elicitation, sampling): they wait for a front end when questions do, and are dismissed
 * when nobody can answer.
 */
export function promptPolicyOf(policy: UnattendedPolicy | null): PromptPolicy {
  return {
    decide: (_prompt: PendingPrompt) => (policy?.otherwise === "wait" ? "wait" : "dismiss"),
  };
}

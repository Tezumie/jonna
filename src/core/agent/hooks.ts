// Agent hooks (D227): the user's commands on the agent's events, in Claude Code's `hooks` format
// so the same settings work in both: PreToolUse (can block a tool call), PostToolUse (can send
// feedback to the agent), UserPromptSubmit (can block a message or add context) and Stop (can send
// the agent back to work once). D371: the rest of Claude Code's events too: SessionStart (adds
// context to a chat's first message), SessionEnd, PreCompact, Notification (the agent waits for
// the user), SubagentStart (adds context to its task) and SubagentStop (can send it back once).
// A hook gets the event as JSON on stdin; exit code 2 blocks with its output as the reason; exit 0
// may print JSON (`decision: "block"`, `additionalContext`…). DOM-free.

export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SessionStart",
  "SessionEnd",
  "PreCompact",
  "Notification",
  "SubagentStart",
  "SubagentStop",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface HookCommand {
  command: string;
  timeoutMs: number;
  /** Where it's configured ("user settings", ".claude/settings.json"). */
  source: string;
}

interface HookGroup {
  matcher: string;
  commands: HookCommand[];
}

export type HookTable = Partial<Record<HookEvent, HookGroup[]>>;

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * `{ "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "…",
 * "timeout": 30 }] }] }` (timeout in seconds, as Claude Code's). Anything else is skipped.
 */
export function parseHooks(value: unknown, source: string): HookTable {
  const table: HookTable = {};
  if (!value || typeof value !== "object") return table;
  for (const event of HOOK_EVENTS) {
    const groups = (value as Record<string, unknown>)[event];
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      const raw = g as { matcher?: unknown; hooks?: unknown };
      if (!Array.isArray(raw?.hooks)) continue;
      const commands: HookCommand[] = [];
      for (const h of raw.hooks) {
        const x = h as { type?: unknown; command?: unknown; timeout?: unknown };
        if ((x?.type ?? "command") !== "command" || typeof x.command !== "string") continue;
        if (!x.command.trim()) continue;
        const seconds = typeof x.timeout === "number" && x.timeout > 0 ? x.timeout : 0;
        commands.push({
          command: x.command,
          timeoutMs: seconds ? Math.min(seconds * 1000, 600_000) : DEFAULT_TIMEOUT_MS,
          source,
        });
      }
      if (!commands.length) continue;
      const matcher = typeof raw.matcher === "string" ? raw.matcher : "";
      table[event] = [...(table[event] ?? []), { matcher, commands }];
    }
  }
  return table;
}

/** Tables from several places, in order (user settings first, then the folder's). */
export function mergeHooks(...tables: HookTable[]): HookTable {
  const out: HookTable = {};
  for (const t of tables)
    for (const event of HOOK_EVENTS) {
      const groups = t[event];
      if (groups) out[event] = [...(out[event] ?? []), ...groups];
    }
  return out;
}

/** The IDE agent's tools under Claude Code's names, so a `Bash` or `Edit|Write` matcher fits. */
const CLAUDE_NAMES: Readonly<Record<string, readonly string[]>> = {
  run_command: ["Bash"],
  read_file: ["Read"],
  write_file: ["Write"],
  edit_file: ["Edit", "MultiEdit"],
  list_dir: ["LS", "Glob"],
  find_files: ["Glob"],
  search: ["Grep"],
  update_plan: ["TodoWrite"],
};

/** Whether a matcher takes this tool: empty or "*" all, else a regex over the whole name. */
export function matchesTool(matcher: string, tool: string): boolean {
  const m = matcher.trim();
  if (!m || m === "*") return true;
  const names = [tool, ...(CLAUDE_NAMES[tool] ?? [])];
  let re: RegExp;
  try {
    re = new RegExp(`^(?:${m})$`);
  } catch {
    return names.includes(m);
  }
  return names.some((n) => re.test(n));
}

/**
 * What an event's matcher is matched against (Claude Code's): the tool for tool events, the
 * source for SessionStart (startup, resume, clear, compact), the trigger for PreCompact (manual,
 * auto), the kind for Notification (permission_prompt…), the agent for SubagentStart and
 * SubagentStop. Other events take every group.
 */
const MATCHED: Partial<Record<HookEvent, keyof HookFields>> = {
  PreToolUse: "tool",
  PostToolUse: "tool",
  SessionStart: "source",
  PreCompact: "trigger",
  Notification: "notificationType",
  SubagentStart: "agentType",
  SubagentStop: "agentType",
};

/** The commands for an event: the groups whose matcher takes the event's matched value. */
export function hooksFor(
  table: HookTable,
  event: HookEvent,
  fields: HookFields = {},
): HookCommand[] {
  const groups = table[event] ?? [];
  const field = MATCHED[event];
  const value = field ? fields[field] : undefined;
  return groups
    .filter((g) => !field || matchesTool(g.matcher, typeof value === "string" ? value : ""))
    .flatMap((g) => g.commands);
}

/** An event's details, as the IDE has them (hookInput gives them Claude Code's names). */
export interface HookFields {
  tool?: string;
  toolInput?: unknown;
  toolResponse?: string;
  prompt?: string;
  stopHookActive?: boolean;
  /** SessionStart: startup, resume, clear or compact. */
  source?: "startup" | "resume" | "clear" | "compact";
  /** SessionEnd: clear, logout, prompt_input_exit or other. */
  reason?: "clear" | "logout" | "prompt_input_exit" | "other";
  /** PreCompact: manual or auto, and what the user asked the summary to keep. */
  trigger?: "manual" | "auto";
  customInstructions?: string;
  /** Notification: what the user is told, and its kind. */
  message?: string;
  notificationType?: "permission_prompt" | "idle_prompt" | "elicitation_dialog";
  /** SubagentStart / SubagentStop: the subagent's name and run id. */
  agentType?: string;
  agentId?: string;
}

/** What a hook gets on stdin (Claude Code's field names; `tool_name` is the IDE's own). */
export function hookInput(
  event: HookEvent,
  fields: HookFields & { sessionId: string; cwd: string },
): string {
  return JSON.stringify({
    session_id: fields.sessionId,
    cwd: fields.cwd,
    hook_event_name: event,
    ...(fields.tool !== undefined && {
      tool_name: fields.tool,
      tool_aliases: CLAUDE_NAMES[fields.tool] ?? [],
      tool_input: fields.toolInput ?? {},
    }),
    ...(fields.toolResponse !== undefined && { tool_response: fields.toolResponse }),
    ...(fields.prompt !== undefined && { prompt: fields.prompt }),
    ...(fields.stopHookActive !== undefined && { stop_hook_active: fields.stopHookActive }),
    ...(fields.source !== undefined && { source: fields.source }),
    ...(fields.reason !== undefined && { reason: fields.reason }),
    ...(fields.trigger !== undefined && {
      trigger: fields.trigger,
      custom_instructions: fields.customInstructions ?? "",
    }),
    ...(fields.message !== undefined && { message: fields.message }),
    ...(fields.notificationType !== undefined && { notification_type: fields.notificationType }),
    ...(fields.agentType !== undefined && { agent_type: fields.agentType }),
    ...(fields.agentId !== undefined && { agent_id: fields.agentId }),
  });
}

export interface HookDecision {
  /** Stop the tool call / the message / the agent stopping. */
  block: boolean;
  /**
   * `"continue": false`: the agent stops for good (Claude Code's meaning): a Stop hook saying it
   * doesn't send the agent back; other events end the turn.
   */
  halt?: boolean;
  /** Why (shown to the agent when it blocks a tool or a stop; to the user for a message). */
  reason: string;
  /** Text for the agent: a prompt's extra context, a tool's feedback. */
  context: string;
  /** The hook failed (not 0 or 2, or timed out): shown to the user, nothing blocked. */
  error?: string;
}

/**
 * The hook's JSON answer in its output: the whole output, else the last line that starts one and
 * runs to the end (or that line alone). stderr shares the stream, so a warning before the JSON
 * mustn't make a "deny" count as plain text and let the call through; pretty-printed JSON (Python
 * `indent=2`, PowerShell's ConvertTo-Json) spans lines.
 */
function hookJson(output: string): Record<string, unknown> | null {
  const lines = output.split(/\r?\n/);
  const candidates = [output];
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]?.trim().startsWith("{")) continue;
    candidates.push(lines.slice(i).join("\n"), lines[i] ?? "");
  }
  for (const candidate of candidates) {
    const text = candidate.trim();
    if (!text.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        return parsed as Record<string, unknown>;
    } catch {
      // Not this one.
    }
  }
  return null;
}

const PLAIN_CONTEXT = new Set<HookEvent>(["UserPromptSubmit", "SessionStart"]);

/**
 * A hook's exit code and output: what the agent does. Plain output (no JSON) is context for the
 * agent only for UserPromptSubmit, as in Claude Code: a tool hook's log lines aren't sent along.
 */
export function hookDecision(
  r: { exitCode: number | null; output: string; timedOut: boolean },
  event?: HookEvent,
): HookDecision {
  const output = r.output.trim();
  if (r.timedOut) return { block: false, reason: "", context: "", error: "timed out" };
  if (r.exitCode === 2) return { block: true, reason: output || "Blocked by a hook.", context: "" };
  if (r.exitCode !== 0)
    return {
      block: false,
      reason: "",
      context: "",
      error: `exit code ${r.exitCode ?? "?"}${output ? `: ${output.slice(0, 500)}` : ""}`,
    };
  const json = hookJson(output);
  // Plain output is context where Claude Code takes it so: a message's and a session's start.
  if (!json)
    return { block: false, reason: "", context: event && PLAIN_CONTEXT.has(event) ? output : "" };
  const specific = (json.hookSpecificOutput ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const denied = specific.permissionDecision === "deny";
  const block = json.decision === "block" || denied;
  const halt = json.continue === false;
  return {
    block,
    ...(halt && { halt }),
    reason:
      str(specific.permissionDecisionReason) ||
      str(json.reason) ||
      str(json.stopReason) ||
      (block || halt ? "Stopped by a hook." : ""),
    context: str(specific.additionalContext),
  };
}

/** Several hooks' decisions as one: any block blocks; reasons and context joined. */
export function combineDecisions(list: readonly HookDecision[]): HookDecision {
  const join = (k: "reason" | "context") =>
    list
      .map((d) => d[k])
      .filter(Boolean)
      .join("\n");
  const errors = list.map((d) => d.error).filter(Boolean);
  return {
    block: list.some((d) => d.block),
    ...(list.some((d) => d.halt) && { halt: true }),
    reason: join("reason"),
    context: join("context"),
    ...(errors.length && { error: errors.join("; ") }),
  };
}

/** One workspace folder's hooks (D251): its path and what its files set. */
export interface FolderHookSet {
  root: string;
  table: HookTable;
}

/**
 * What a folder hook approval signs (hashed with SHA-256): every folder that sets hooks, with its
 * path (`key`: its path key), so an approval in one repository doesn't carry to another, and
 * adding a folder that sets hooks asks again. One such folder is signed as it always was
 * (`[key, table]`), so a single folder's approval stays valid; several are signed together.
 */
export function hookSignatureText(
  sets: readonly FolderHookSet[],
  key: (path: string) => string,
): string {
  const withHooks = sets.filter((s) => Object.keys(s.table).length);
  const [only] = withHooks;
  if (withHooks.length === 1 && only) return JSON.stringify([key(only.root), only.table]);
  return JSON.stringify(withHooks.map((s) => [key(s.root), s.table]));
}

/** `table` with each command's source prefixed by `label` ("api: .claude/settings.json"). */
export function labelHooks(table: HookTable, label: string): HookTable {
  const out: HookTable = {};
  for (const event of HOOK_EVENTS) {
    const groups = table[event];
    if (groups)
      out[event] = groups.map((g) => ({
        ...g,
        commands: g.commands.map((c) => ({ ...c, source: `${label}: ${c.source}` })),
      }));
  }
  return out;
}

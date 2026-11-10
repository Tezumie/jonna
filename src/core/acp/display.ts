// What an external agent's updates mean for the chat (D208), DOM-free and tested: its commands
// as a person would type them (Codex titles a Windows command with PowerShell's full path and
// quoting), Codex's Guardian reviews as one line, and a turn's token usage in the IDE's units.

/** A command line without the shell that runs it, and that shell's name (the row's tag). */
export interface PrettyCommand {
  command: string;
  shell?: string;
}

const SHELLS: Readonly<Record<string, string>> = {
  powershell: "PowerShell",
  pwsh: "PowerShell",
  cmd: "cmd",
  bash: "bash",
  sh: "sh",
  zsh: "zsh",
};

/** The first word of `text` and the rest (a word in double quotes may hold spaces). */
function firstWord(text: string): { word: string; rest: string; quoted: boolean } {
  const s = text.trimStart();
  if (s.startsWith('"')) {
    // `\"` inside: an escaped quote (Rust's and JSON's debug quoting), not the end.
    let i = 1;
    while (i < s.length && !(s[i] === '"' && s[i - 1] !== "\\")) i++;
    const raw = s.slice(1, i);
    return {
      word: raw.replace(/\\(["\\])/g, "$1"),
      rest: s.slice(i + 1).trimStart(),
      quoted: true,
    };
  }
  const m = /^(\S+)\s*([\s\S]*)$/.exec(s);
  return { word: m?.[1] ?? "", rest: m?.[2] ?? "", quoted: false };
}

/** `'npm run check'` → `npm run check`: one quoted argument that is the whole rest. */
function unquote(text: string, shell: string): string {
  const s = text.trim();
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    const inner = s.slice(1, -1);
    // PowerShell doubles a quote inside; POSIX shells close, escape and reopen.
    if (shell === "PowerShell")
      return /(^|[^'])'([^']|$)/.test(inner) ? s : inner.replace(/''/g, "'");
    if (!inner.replace(/'\\''/g, "").includes("'")) return inner.replace(/'\\''/g, "'");
    return s;
  }
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    const inner = s.slice(1, -1);
    if (!/(^|[^\\])"/.test(inner)) return inner.replace(/\\(["\\])/g, "$1");
  }
  return s;
}

/** The program's file name without `.exe`/`.cmd` (a path in a title says nothing). */
function programName(word: string): string {
  const base = word.split(/[\\/]+/).pop() ?? word;
  return base.replace(/\.(exe|cmd|bat|com)$/i, "");
}

/**
 * An agent's command title as the user would type it: `"C:\…\powershell.exe" -Command 'npm run
 * check'` → `npm run check` (PowerShell), `/bin/bash -lc 'ls'` → `ls` (bash), a program's full path
 * → its name. Anything else comes back as it was.
 */
export function prettyCommand(title: string): PrettyCommand {
  let text = title.trim();
  // The whole line in one pair of quotes (a debug-quoted string).
  const whole = firstWord(text);
  if (whole.quoted && !whole.rest && /\s/.test(whole.word)) text = whole.word.trim();
  const { word, rest } = firstWord(text);
  if (!word) return { command: text };
  const name = programName(word);
  const shell = SHELLS[name.toLowerCase()];
  if (!shell) {
    // Not a shell: only a long program path is shortened.
    if (!/[\\/]/.test(word)) return { command: text };
    return { command: rest ? `${name} ${rest}` : name };
  }
  // The shell's own switches, up to the one that takes the command.
  let tail = rest;
  for (let guard = 0; guard < 12 && tail; guard++) {
    const next = firstWord(tail);
    const flag = next.word.toLowerCase();
    if (shell === "PowerShell") {
      if (flag === "-command" || flag === "-c")
        return { command: unquote(next.rest, shell), shell };
      if (flag === "-executionpolicy" || flag === "-ep") {
        tail = firstWord(next.rest).rest;
        continue;
      }
      if (!flag.startsWith("-")) break;
    } else if (shell === "cmd") {
      if (flag === "/c" || flag === "/k") return { command: unquote(next.rest, shell), shell };
      if (!flag.startsWith("/")) break;
    } else {
      if (/^-[a-z]*c[a-z]*$/.test(flag)) return { command: unquote(next.rest, shell), shell };
      if (!flag.startsWith("-")) break;
    }
    tail = next.rest;
  }
  // A shell with a script or no command: the line as it is, with the shell's short name.
  return { command: rest ? `${name} ${rest}` : name, shell };
}

/** A Guardian (Codex's approval reviewer) verdict, from its review step's text. */
export interface AgentReview {
  /** Who reviewed: "Guardian". */
  by: string;
  /** "approved", "denied", "in progress", "timed out", "aborted". */
  status: string;
  risk?: string;
  authorization?: string;
  action?: string;
  rationale?: string;
}

/** Whether a tool step is one of Codex's Guardian reviews (its id or its title says so). */
export function isGuardianStep(toolCallId: string, title: string | undefined): boolean {
  return toolCallId.startsWith("guardian_assessment:") || /^guardian review$/i.test(title ?? "");
}

/** "Status: Approved\nAction: …\nRisk: low\nRationale: …" → the review, or null. */
export function parseReview(text: string, by = "Guardian"): AgentReview | null {
  const field = (key: string, rest = false): string | undefined => {
    const m = new RegExp(`^${key}:[ \\t]*(.*)$`, rest ? "ims" : "im").exec(text);
    const v = m?.[1]?.trim();
    return v ? v : undefined;
  };
  const status = field("Status")?.toLowerCase();
  if (!status) return null;
  const risk = field("Risk")?.toLowerCase();
  const authorization = field("Authorization")?.toLowerCase();
  const action = field("Action");
  const rationale = field("Rationale", true);
  return {
    by,
    status,
    ...(risk && { risk }),
    ...(authorization && { authorization }),
    ...(action && { action }),
    ...(rationale && { rationale }),
  };
}

/** "Guardian: approved · low risk". */
export function reviewLine(r: AgentReview): string {
  const status = r.status === "in progress" ? "reviewing…" : r.status;
  return [`${r.by}: ${status}`, r.risk ? `${r.risk} risk` : ""].filter(Boolean).join(" · ");
}

/** The id of the step a Guardian review is about (Codex's `targetItemId`), if it says. */
export function reviewTarget(raw: unknown): string | null {
  const target = (raw as { targetItemId?: unknown } | null)?.targetItemId;
  return typeof target === "string" && target ? target : null;
}

/** A turn's tokens in the IDE's units: `input` includes the cached ones (as the usage log's). */
export interface AgentTurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const count = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;

/**
 * The usage in a `session/prompt` answer (ACP's `usage`, a draft the agents already send; or
 * `_meta.quota.token_count`), or null when it has none. Agents count input differently: Claude
 * Code and Codex leave the cached tokens out of `inputTokens` (their `totalTokens` adds them),
 * Gemini CLI counts them in; `totalTokens` tells which.
 */
export function promptUsage(result: unknown): AgentTurnUsage | null {
  const r = (result ?? {}) as {
    usage?: Record<string, unknown> | null;
    _meta?: { quota?: { token_count?: Record<string, unknown> | null } } | null;
  };
  const u = r.usage;
  if (u && typeof u === "object") {
    const input = count(u.inputTokens);
    const output = count(u.outputTokens);
    const cacheRead = count(u.cachedReadTokens);
    const cacheWrite = count(u.cachedWriteTokens);
    const total = count(u.totalTokens);
    if (input || output || cacheRead) {
      const cached = cacheRead + cacheWrite;
      const apart =
        cached > 0 && (total ? total >= input + output + cached - 1 : cacheRead > input);
      return { input: apart ? input + cached : input, output, cacheRead, cacheWrite };
    }
  }
  const q = r._meta?.quota?.token_count;
  if (q && typeof q === "object") {
    const input = count(q.input_tokens ?? q.inputTokens);
    const output = count(q.output_tokens ?? q.outputTokens);
    if (input || output) return { input, output, cacheRead: 0, cacheWrite: 0 };
  }
  return null;
}

/** One model's share of a turn (`_meta.quota.model_usage`, D223). */
export interface ModelTurnUsage {
  model: string;
  usage: AgentTurnUsage;
}

/**
 * A turn's tokens by model, as Claude Code and Codex report them in `_meta.quota.model_usage`
 * (`[{ model, token_count: { inputTokens, cachedInputTokens, cachedWriteTokens, outputTokens,
 * totalTokens } }]`; Claude Code's rows also count its subagents and compaction, so they can add
 * up to more than `usage`). Empty when there are none.
 */
export function promptModelUsage(result: unknown): ModelTurnUsage[] {
  const rows = (result as { _meta?: { quota?: { model_usage?: unknown } } } | null)?._meta?.quota
    ?.model_usage;
  if (!Array.isArray(rows)) return [];
  const out: ModelTurnUsage[] = [];
  for (const row of rows.slice(0, 20)) {
    const r = row as { model?: unknown; token_count?: Record<string, unknown> | null };
    if (typeof r?.model !== "string" || !r.model.trim() || !r.token_count) continue;
    const q = r.token_count;
    const usage = promptUsage({
      usage: {
        inputTokens: q.inputTokens ?? q.input_tokens,
        outputTokens: q.outputTokens ?? q.output_tokens,
        cachedReadTokens: q.cachedInputTokens ?? q.cached_input_tokens ?? q.cachedReadTokens,
        cachedWriteTokens: q.cachedWriteTokens ?? q.cached_write_tokens,
        totalTokens: q.totalTokens ?? q.total_tokens,
      },
    });
    if (usage) out.push({ model: r.model.trim().slice(0, 120), usage });
  }
  return out;
}

/** A `usage_update`'s cumulative cost in dollars (other currencies aren't converted). */
export function updateCost(update: unknown): number | null {
  const c = (update as { cost?: { amount?: unknown; currency?: unknown } | null })?.cost;
  if (!c || typeof c.amount !== "number" || !Number.isFinite(c.amount) || c.amount < 0) return null;
  return typeof c.currency === "string" && c.currency.toUpperCase() !== "USD" ? null : c.amount;
}

/**
 * The package runner an agent is launched through (npx, uvx, bunx, pnpm dlx…), or null: it
 * downloads the agent first when there's a new version, so starting can take minutes (D401).
 */
export function packageRunner(command: string): string | null {
  const name = command
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.(exe|cmd|bat)$/i, "")
    .toLowerCase();
  return name && ["npx", "uvx", "bunx", "pnpx", "pnpm", "yarn", "deno"].includes(name)
    ? name
    : null;
}

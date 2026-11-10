// Custom slash commands (D200), Claude Code's format: a Markdown prompt file whose front matter
// may give `description`, `argument-hint`, `model` and `allowed-tools`; the body takes
// `$ARGUMENTS` (everything after the name) and `$1`…`$9` (one word or "quoted words" each),
// `!`command`` lines (run in the folder, their output put in place; approved first) and
// `@path` files (their text added). A command in a subfolder is `/folder:name`, and a command
// that lists `allowed-tools` gets only those tools and the read-only ones for its turn (D203).
// `disallowed-tools` takes tools away for the turn (a `Bash(prefix:*)` there refuses those
// lines), and in the user's own command files `allowed-tools` also pre-approves those tools for
// the turn, as Claude Code reads it (D207; a project's file only narrows: a cloned repository
// mustn't approve its own commands). DOM-free and tested; the files are read and the commands
// run by extensions/agent/slashCommands.ts.
import { importRefs, parseFrontMatter } from "./rules";
import { isWholeToolEntry, patternEntryMatches, type RuleContext } from "./toolRules";

export interface CommandFile {
  description?: string;
  argumentHint?: string;
  model?: string;
  /** `allowed-tools` as written: `Bash(git status:*)`, `Read`, … */
  allowedTools: string[];
  /** `disallowed-tools` as written (D207): taken away for the command's turn. */
  disallowedTools: string[];
  body: string;
}

/** A front matter tool list: commas or spaces separate tools, except inside a `Bash(…)` pattern. */
export function splitToolList(value: string | undefined): string[] {
  return (value ?? "")
    .replace(/^\[|\]$/g, "")
    .split(/[,\s]+(?![^(]*\))/)
    .map((t) => t.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

export function parseCommandFile(text: string): CommandFile {
  const { meta, body } = parseFrontMatter(text);
  return {
    ...(meta.description && { description: meta.description }),
    ...(meta["argument-hint"] && { argumentHint: meta["argument-hint"] }),
    ...(meta.model && { model: meta.model }),
    allowedTools: splitToolList(meta["allowed-tools"] ?? meta.allowedtools),
    // Claude Code's subagents spell it disallowedTools; either is taken.
    disallowedTools: splitToolList(meta["disallowed-tools"] ?? meta.disallowedtools),
    body: body.trim(),
  };
}

/**
 * What a command's front matter does to its own turn (D203, D207): `allowed` narrows the tools
 * to those and the read-only ones, `disallowed` takes tools away, `preApproved` (the user's own
 * command files only) lets those tools run without asking.
 */
export interface TurnTools {
  allowed: readonly string[];
  disallowed: readonly string[];
  preApproved: readonly string[];
}

/** The turn's tool settings for a command file; null when it changes nothing. */
export function turnToolsFor(file: CommandFile, fromUser: boolean): TurnTools | null {
  if (!file.allowedTools.length && !file.disallowedTools.length) return null;
  return {
    allowed: file.allowedTools,
    disallowed: file.disallowedTools,
    preApproved: fromUser ? file.allowedTools : [],
  };
}

/**
 * Two sets of turn tools together (a command and a skill loaded in its turn, D221): the narrowing
 * of the first stays (a skill doesn't widen it), disallowed and pre-approved entries add up.
 */
export function mergeTurnTools(
  a: TurnTools | null,
  b: Partial<TurnTools> | null,
): TurnTools | null {
  if (!b) return a;
  const merged: TurnTools = {
    allowed: a?.allowed ?? b.allowed ?? [],
    disallowed: [...new Set([...(a?.disallowed ?? []), ...(b.disallowed ?? [])])],
    preApproved: [...new Set([...(a?.preApproved ?? []), ...(b.preApproved ?? [])])],
  };
  return merged.allowed.length || merged.disallowed.length || merged.preApproved.length
    ? merged
    : null;
}

/**
 * `/name args` → its parts; null when the message isn't a slash command. A command from a
 * subfolder has the folders in its name, `:` separated (`/frontend:test`, D203); a nested skill
 * whose name is taken has its folder's path in front (`/apps/web:deploy`, D229).
 */
export function parseSlash(message: string): { name: string; args: string } | null {
  const m = /^\/((?:[\w.-]+\/)*[\w-]+(?::[\w-]+)*)(?:\s+([\s\S]*))?$/.exec(message.trim());
  return m?.[1] ? { name: m[1], args: (m[2] ?? "").trim() } : null;
}

/** How deep command folders are looked into (`frontend/forms/check.md` → /frontend:forms:check). */
export const COMMAND_DEPTH = 3;

/**
 * A command file's name from its path in a commands folder (`/` separated), as Claude Code names
 * them (D203): `test.md` → test, `frontend/test.md` → frontend:test; null for a path that isn't
 * one (another extension, a folder or file name with other characters, too deep).
 */
export function commandNameFor(rel: string): string | null {
  const parts = rel.split("/");
  if (parts.length > COMMAND_DEPTH) return null;
  const file = /^([\w-]+)\.md$/i.exec(parts.pop() ?? "")?.[1];
  if (!file || parts.some((p) => !/^[\w-]+$/.test(p))) return null;
  return [...parts, file].join(":");
}

/** The file a command name stands for in a commands folder: frontend:test → frontend/test.md. */
export function commandFileFor(name: string): string | null {
  const parts = name.split(":");
  if (parts.length > COMMAND_DEPTH || parts.some((p) => !/^[\w-]+$/.test(p))) return null;
  return `${parts.join("/")}.md`;
}

/**
 * Claude Code's tool names in `allowed-tools` → the IDE agent's own (its own names are taken as
 * they are; an MCP tool is `mcp__<server>__<tool>` in both, or `mcp__<server>` for all of them).
 */
const CLAUDE_CODE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  read: ["read_file"],
  write: ["write_file"],
  edit: ["edit_file"],
  multiedit: ["edit_file"],
  notebookedit: ["edit_file"],
  bash: ["run_command", "process_output", "kill_process"],
  glob: ["find_files", "list_dir"],
  ls: ["list_dir"],
  grep: ["search"],
  websearch: ["web_search"],
  task: ["delegate", "explore"],
  agent: ["delegate", "explore"],
  todowrite: ["update_plan"],
  // web_fetch, and web.fetch through call_command; the calls are told apart in toolRules.ts.
  webfetch: ["web_fetch", "call_command"],
};

/** The tool names list entries stand for (their own, Claude Code's mapped, an MCP server's). */
function toolMatcher(entries: readonly string[]): (tool: string) => boolean {
  const wanted = new Set<string>();
  const servers: string[] = [];
  for (const raw of entries) {
    const name = raw.trim().replace(/\([\s\S]*\)$/, "");
    if (!name) continue;
    for (const mapped of CLAUDE_CODE_TOOLS[name.toLowerCase()] ?? []) wanted.add(mapped);
    wanted.add(name);
    if (name.startsWith("mcp__") && !name.slice(5).includes("__")) servers.push(`${name}__`);
  }
  return (tool) => wanted.has(tool) || servers.some((s) => tool.startsWith(s));
}

/** `Bash(git push:*)`: about some lines, not the whole tool (`WebSearch(…)` is whole, D229). */
const hasPattern = (entry: string) =>
  /\(\s*\S[\s\S]*\)$/.test(entry.trim()) && !isWholeToolEntry(entry);

/**
 * The tools a command's turn is offered (D203, D207): when its `allowed-tools` lists any, only
 * those (`Bash(git diff:*)` stands for run_command; the pattern still decides which lines run
 * without asking) and every read-only tool, so the agent can still look around; then minus its
 * `disallowed-tools` (read-only ones too; a `Bash(rm:*)` there doesn't take run_command away, it
 * refuses those lines: see lineDisallowed). Null (every tool) when it changes nothing.
 * `available` is the turn's tool list, in order.
 */
export function commandTools(
  allowedTools: readonly string[],
  available: readonly { name: string; readOnly: boolean }[],
  disallowedTools: readonly string[] = [],
): string[] | null {
  // `WebFetch` refuses web.fetch calls (callDisallowed), not every IDE command.
  const removed = disallowedTools.filter((t) => !hasPattern(t) && !/^webfetch$/i.test(t.trim()));
  if (!allowedTools.length && !removed.length) return null;
  const allowed = allowedTools.length ? toolMatcher(allowedTools) : () => true;
  const denied = removed.length ? toolMatcher(removed) : () => false;
  return available
    .filter((t) => (t.readOnly || allowed(t.name)) && !denied(t.name))
    .map((t) => t.name);
}

/**
 * Whether `disallowed-tools` refuses a command line (D207): a `Bash(prefix:*)`, `Bash(prefix *)`
 * or `Bash(exact line)` entry matching any part of it (`git status && git push` is refused by
 * `Bash(git push:*)`).
 */
export function lineDisallowed(disallowedTools: readonly string[], command: string): boolean {
  const parts = command
    .split(/\s*(?:&&|\|\||;|\||&|[\r\n]+)\s*/)
    // Without case, as a refusal should be: Windows runs `GIT PUSH` as git push.
    .map((p) => p.trim().replace(/\s+/g, " ").toLowerCase())
    .filter(Boolean);
  for (const tool of disallowedTools) {
    const m = /^Bash\((.*)\)$/.exec(tool.trim());
    const pattern = (m?.[1] ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    if (!pattern) continue;
    const prefix = /^(.*?)(?::\*| \*)$/.exec(pattern)?.[1];
    const hit = (p: string) =>
      prefix !== undefined ? p === prefix || p.startsWith(`${prefix} `) : p === pattern;
    if (parts.some(hit)) return true;
  }
  return false;
}

/**
 * Whether a tool call runs without asking because the user's own command or skill lists it in
 * `allowed-tools` (D207, Claude Code's reading): run_command by its `Bash` patterns (bashAllowed:
 * chains and substitutions still ask), a file tool by its path pattern (`Edit(src/**)`, D221),
 * web.fetch through call_command by `WebFetch` or `WebFetch(domain:…)`, any other tool by name
 * (`mcp__github` for a whole server). What always asks (an Ask pattern, delete protection, the
 * denylist) is the caller's.
 */
export function preApprovedCall(
  preApproved: readonly string[],
  name: string,
  args: Record<string, unknown>,
  ctx: RuleContext = { root: null },
): boolean {
  if (!preApproved.length) return false;
  if (name === "run_command")
    return typeof args.command === "string" && bashAllowed(preApproved, args.command);
  if (preApproved.some((e) => patternEntryMatches(e, name, args, ctx))) return true;
  // WebFetch stands for web.fetch only (matched above), never every IDE command.
  const whole = preApproved.filter((t) => !hasPattern(t) && !/^webfetch$/i.test(t.trim()));
  return toolMatcher(whole)(name);
}

/**
 * Whether `disallowed-tools` refuses this call (D207, D221): a Bash line (lineDisallowed), a file
 * tool's path pattern (`Read(.env)`, `Edit(/migrations/**)`), or web.fetch by `WebFetch` (whole
 * or a domain). Whole other tools are taken away from the turn instead (commandTools).
 */
export function callDisallowed(
  disallowed: readonly string[],
  name: string,
  args: Record<string, unknown>,
  ctx: RuleContext = { root: null },
): boolean {
  if (!disallowed.length) return false;
  if (name === "run_command")
    return typeof args.command === "string" && lineDisallowed(disallowed, args.command);
  return disallowed.some((e) => patternEntryMatches(e, name, args, { ...ctx, foldCase: true }));
}

/** Words as a shell splits them: spaces separate, quotes keep words together. */
export function splitArgs(args: string): string[] {
  const out: string[] = [];
  for (const m of args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

/**
 * `$ARGUMENTS` and `$1`…`$9` filled in; a body that uses neither gets the arguments after it
 * (so `/fix the login bug` still says what to fix).
 */
export function expandArguments(body: string, args: string): string {
  const words = splitArgs(args);
  const usesArgs = /\$ARGUMENTS\b|\$[1-9](?!\d)/.test(body);
  const filled = body
    .replaceAll("$ARGUMENTS", args)
    .replace(/\$([1-9])(?!\d)/g, (_m, n: string) => words[Number(n) - 1] ?? "");
  return usesArgs || !args ? filled : `${filled}\n\nArguments: ${args}`;
}

/** The `!`command`` lines of a body, each once, in order. */
export function shellRefs(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/!`([^`\n]+)`/g)) {
    const cmd = (m[1] ?? "").trim();
    if (cmd && !out.includes(cmd)) out.push(cmd);
  }
  return out;
}

/** The body with each `!`command`` replaced by its output (as a fenced block). */
export function inlineShell(body: string, outputs: ReadonlyMap<string, string>): string {
  return body.replace(/!`([^`\n]+)`/g, (whole, cmd: string) => {
    const out = outputs.get(cmd.trim());
    return out === undefined ? whole : `\n\`\`\`\n$ ${cmd.trim()}\n${out.trimEnd()}\n\`\`\`\n`;
  });
}

/** The `@path` files a body names (same rule as CLAUDE.md imports: a `/` or an extension). */
export const fileRefs = importRefs;

/**
 * Whether `allowed-tools` lets `command` run without asking: `Bash` (anything), `Bash(cmd)` (that
 * exact line) or `Bash(prefix:*)` / `Bash(prefix *)` (lines starting with that prefix).
 */
export function bashAllowed(allowedTools: readonly string[], command: string): boolean {
  const line = command.trim().replace(/\s+/g, " ");
  // A chain or a substitution could slip another command past a prefix: those always ask.
  // A newline too: the line above has it turned into a space, but the shell runs a second command.
  const chained = /[;&|`$<>]|\$\(/.test(line) || /[\r\n]/.test(command.trim());
  for (const tool of allowedTools) {
    const m = /^Bash(?:\((.*)\))?$/.exec(tool.trim());
    if (!m) continue;
    const pattern = (m[1] ?? "").trim();
    if (!pattern) return !chained;
    const prefix = /^(.*?)(?::\*| \*)$/.exec(pattern)?.[1];
    if (prefix !== undefined) {
      if (!chained && (line === prefix || line.startsWith(`${prefix} `))) return true;
    } else if (line === pattern.replace(/\s+/g, " ")) return true;
  }
  return false;
}

/** What the inline "/" list ranks (D389): a command's name, other names and description. */
export interface RankableCommand {
  name: string;
  description: string;
  aliases?: readonly string[];
}

/**
 * The commands matching what's typed after "/", best first (D389), as Claude Code's list: a
 * name that starts with it, then another name (an alias) that does, then a name containing it,
 * then a description containing every typed word. Ties keep their order (built-ins first). An
 * empty query lists them all.
 */
export function rankSlashCommands<C extends RankableCommand>(
  query: string,
  commands: readonly C[],
): C[] {
  const q = query.trim().toLowerCase().replace(/^\//, "");
  if (!q) return [...commands];
  const words = q.split(/\s+/);
  const scored: { c: C; score: number; at: number }[] = [];
  commands.forEach((c, at) => {
    const name = c.name.toLowerCase();
    const aliases = (c.aliases ?? []).map((a) => a.toLowerCase());
    // The description by its words' starts: "co" shouldn't find "uncommitted".
    const described = c.description.toLowerCase().split(/[^\p{L}\p{N}]+/u);
    const score = name.startsWith(q)
      ? 0
      : aliases.some((a) => a.startsWith(q))
        ? 1
        : name.includes(q)
          ? 2
          : words.every((w) => described.some((d) => d.startsWith(w)) || name.includes(w))
            ? 3
            : -1;
    if (score >= 0) scored.push({ c, score, at });
  });
  return scored.sort((a, b) => a.score - b.score || a.at - b.at).map((s) => s.c);
}

/** The command a message's other name stands for ("/new" → "/clear"), or the message as is. */
export function canonicalSlash(message: string, commands: readonly RankableCommand[]): string {
  const m = /^\/([\w:-]+)([\s\S]*)$/.exec(message.trimStart());
  if (!m?.[1]) return message;
  const name = m[1].toLowerCase();
  if (commands.some((c) => c.name === name)) return message;
  const target = commands.find((c) => c.aliases?.includes(name));
  return target ? `/${target.name}${m[2] ?? ""}` : message;
}

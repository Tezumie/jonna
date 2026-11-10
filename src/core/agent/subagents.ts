// Subagents (D195, after Claude Code's): workers the agent hands a task to with the `delegate`
// tool. Each has its own instructions, its own tools and its own model, works in its own context,
// and hands back only a report, so the main conversation stays small (Claude Code's design,
// D288). Built in: Explore (its own tool, D127), Plan, General purpose and Review (the automatic
// review). Custom subagents are Markdown files in Claude Code's folders (`.claude/agents`, the
// project's and the user's) with a small header, in
// the format Claude Code uses, so its `.claude/agents/*.md` work here unchanged:
//
//   ---
//   name: test-runner
//   description: Runs the tests and fixes what fails. Use after changing code.
//   tools: read_file, search, run_command      (Claude's Read, Grep, Bash… work too)
//   model: inherit                              (or provider/model, or sonnet / opus / haiku)
//   ---
//   You run the project's tests…
//
// DOM-free and tested.

import { type Handoff, parseHandoffs } from "./groupChat";
import { TURN_TOOL_NAMES } from "./turnTools";

export type SubagentSource = "builtin" | "project" | "user";

/** Shipped with the IDE (no file of its own): a file with its name replaces it. */
export function isBundledAgent(def: { source: SubagentSource }): boolean {
  return def.source === "builtin";
}

/** How a chat with an agent starts (D249): Agent, Plan or Ask. */
export type StartMode = "agent" | "plan" | "ask";

const START_MODES: readonly string[] = ["agent", "plan", "ask"];

export interface SubagentDef {
  /** Its id: letters, digits, - and _ (also the file's name). */
  name: string;
  description: string;
  /** The name shown ("Test runner"), when it differs from the id (D230). */
  label?: string;
  /** A short role tag shown beside the name ("Reviewer"), D230. */
  role?: string;
  /** Its face, as a face code (`blob-3-dots`, core/agent/faces.ts); none: one from its name. */
  icon?: string;
  /** Instructions (the file's body). */
  prompt: string;
  /**
   * Tools by name; undefined: every tool the agent has (except delegating again). MCP tools by
   * their names (`mcp__<server>__<tool>`) or a whole server's (`mcp__<server>`), D245.
   */
  tools?: string[];
  /** Tools it may never use, whatever `tools` says (Claude Code's `disallowedTools`, D245). */
  disallowedTools?: string[];
  /** Its file edits are kept without review (Claude Code's `permissionMode: acceptEdits`, D245). */
  acceptEdits?: boolean;
  /** provider/model, a Claude alias (sonnet, opus, haiku, fable) or "inherit" / undefined. */
  model?: string;
  /** The model it answers with once `model` (or the chat's) hits a usage limit (D254). */
  fallbackModel?: string;
  /** Only reading tools, whatever `tools` says (Claude's permissionMode: plan). */
  readOnly?: boolean;
  /** The mode a chat with it starts in (`mode: plan`, D249); undefined: Agent. */
  startMode?: StartMode;
  /** Step limit (Claude's maxTurns). */
  maxSteps?: number;
  /** Rules to preload in full (paths or names; Claude's `skills:` for rules), D204. */
  rules?: string[];
  /** Start without the project's always-on rules (Claude's `omitClaudeMd`), D204. */
  omitRules?: boolean;
  /**
   * `isolation: worktree` (Claude Code's subagent option, D231): delegated work runs in a git
   * worktree and window of its own instead of this chat.
   */
  isolation?: "worktree";
  /** Buttons after its reply that move the chat to another agent (VS Code's `handoffs:`, D231). */
  handoffs?: Handoff[];
  source: SubagentSource;
  /**
   * What it is (D288, Claude Code's split): an agent you talk to (a persona: the agents folders)
   * or a subagent an agent runs for one task (Claude Code's `.claude/agents` folders, and the
   * built-in ones). Undefined: an agent.
   */
  kind?: "agent" | "subagent";
  /**
   * An agent's subagents (D288, as Claude Code's `Agent(a, b)` in an agent's tools): the ones it
   * may run, by name; [] none (`subagents: none`). Undefined: all of them.
   */
  subagents?: string[];
  /** The file it came from. */
  path?: string;
}

/** A subagent (a worker an agent runs for one task), not an agent you talk to (D288). */
export function isSubagent(def: Pick<SubagentDef, "source" | "kind">): boolean {
  return def.source === "builtin" || def.kind === "subagent";
}

/** Whether an agent may run the subagent `name` (its `subagents:` list, else every one). */
export function allowsSubagent(
  agent: { subagents?: readonly string[] | undefined } | undefined,
  name: string,
): boolean {
  const list = agent?.subagents;
  return !list || list.some((n) => n.toLowerCase() === name.toLowerCase());
}

/**
 * The `subagents:` value for an agent allowed `allowed` out of `all`: null (the key removed)
 * when that's every one, `none` for none, else the names.
 */
export function subagentsField(allowed: readonly string[], all: readonly string[]): string | null {
  if (all.every((n) => allowed.some((a) => a.toLowerCase() === n.toLowerCase()))) return null;
  return allowed.length ? allowed.join(", ") : "none";
}

/** Tools that change nothing: what a read-only or background subagent gets. */
export const READ_TOOLS = [
  "list_dir",
  "find_files",
  "search",
  "read_file",
  "recall",
  "get_state",
  "find_commands",
];

/**
 * Read-only tools kept apart from READ_TOOLS (whose list is what "Read only" means in agent files):
 * the user guide (D333), which read-only and background subagents may use too.
 */
export const GUIDE_TOOLS: readonly string[] = ["read_guide"];

/** Claude Code's tool names → ours. */
const CLAUDE_TOOLS: Record<string, string[]> = {
  read: ["read_file"],
  glob: ["find_files"],
  grep: ["search"],
  ls: ["list_dir"],
  edit: ["edit_file"],
  multiedit: ["edit_file"],
  write: ["write_file"],
  bash: ["run_command"],
  powershell: ["run_command"],
  // Background commands (D201): BashOutput / KillShell (KillBash in older versions).
  bashoutput: ["process_output"],
  killshell: ["kill_process"],
  killbash: ["kill_process"],
  todowrite: ["update_plan"],
  // WebFetch and NotebookEdit have no read-only match here: left out (call_command can write).
};

/** Claude Code's tools with no safe match here (call_command could write): left out. */
const UNMATCHED = new Set([
  "webfetch",
  "websearch",
  "notebookedit",
  "notebookread",
  "task",
  "agent",
]);

const SUFFIX = `

You are a subagent: the main agent gave you one task. Work on it with your tools, then end with a report for the main agent (it sees only your report, not your steps): what you found or did, the files and lines that matter, and anything you couldn't do or confirm. No preamble.`;

export const BUILTIN_SUBAGENTS: readonly SubagentDef[] = [
  {
    name: "plan",
    label: "Plan",
    description:
      "Researches the code (read-only) and returns a step-by-step plan for a change: the files to touch, in order, with the risks. Use before a change that spans several files.",
    prompt:
      "You plan code changes. Read what's needed to understand the current code, then write a numbered plan: each step names the files and what changes there, in the order to do them, plus risks and how to check the result. Don't change anything.",
    readOnly: true,
    maxSteps: 30,
    // Claude Code's Plan starts without CLAUDE.md too (D204).
    omitRules: true,
    source: "builtin",
  },
  {
    name: "reviewer",
    label: "Review",
    description:
      "Reviews code or a change (read-only) like a careful senior engineer and reports problems, most severe first. Use after making changes, or to get a second opinion.",
    prompt:
      "You review code. Look for bugs, edge cases, security issues, missing error handling, missing or wrong tests and confusing code. Report only concrete problems, each with the file and line and a suggested fix, most severe first. If it looks good, say so in one line. Don't change anything.",
    readOnly: true,
    maxSteps: 30,
    source: "builtin",
  },
  {
    // D333 (Claude Code's claude-code-guide): how-to questions about the IDE, from its guide.
    name: "guide",
    label: "Guide",
    description:
      "Answers how-to questions about the IDE itself (its features, settings, commands, keys, the agent and its tools) from the IDE's user guide, citing the page. Use for questions about the IDE, not about the user's code.",
    prompt:
      "You answer questions about the IDE you run in, from its user guide. Search it with read_guide (query: the question's key words; try other words if the first search misses), read a whole page with read_guide { page } when a section isn't enough, and check a command's exact id with find_commands when the answer names one. Answer briefly and concretely (where to click, the command, the setting, the key), and cite the pages you used as (page: <file name>). If the guide doesn't cover it, say so plainly rather than guess, and don't describe another editor's menus or keys.",
    tools: ["read_guide", "find_commands", "get_state"],
    readOnly: true,
    maxSteps: 15,
    omitRules: true,
    source: "builtin",
  },
  {
    name: "general",
    label: "General purpose",
    description:
      "A copy of the agent with its tools, in a fresh context: a self-contained task (a refactor in one area, a script, a fix) whose steps shouldn't fill this conversation.",
    prompt:
      "You do one self-contained task in this project, carefully and completely. Make the changes, check them, and report what you changed.",
    maxSteps: 60,
    source: "builtin",
  },
];

/** The explore subagent's entry (it has its own tool, `explore`; listed so it can be configured). */
export const EXPLORE_ENTRY: SubagentDef = {
  name: "explore",
  label: "Explore",
  description:
    "Searches the codebase (read-only) and answers a question with a short report, so the conversation stays small. The agent runs it through its explore tool.",
  prompt: "",
  readOnly: true,
  omitRules: true,
  source: "builtin",
};

/** A tool list from a header value: "a, b", "[a, b]" or YAML list lines. */
function list(value: string | string[]): string[] {
  const parts = Array.isArray(value) ? value : value.replace(/^\[|\]$/g, "").split(",");
  return parts.map((p) => p.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

/**
 * Tool names in our terms: Claude's names mapped, MCP tools kept (ours are named as Claude Code
 * names them, D245; `mcp__server__*` reads as the whole server), `Agent(…)` patterns dropped.
 */
export function mapTools(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name || name.includes("(")) continue;
    if (name.startsWith("mcp__")) {
      const mcp = name.replace(/(__)?\*$/, "");
      if (/^mcp__[\w-]+(__[\w-]+)?$/.test(mcp) && !out.includes(mcp)) out.push(mcp);
      continue;
    }
    const key = name.toLowerCase();
    if (UNMATCHED.has(key)) continue;
    const mapped = CLAUDE_TOOLS[key] ?? [name];
    for (const m of mapped) if (!out.includes(m)) out.push(m);
  }
  return out;
}

/** A name a subagent may have: letters, digits, - and _ (the file name too). */
export function validSubagentName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,47}$/i.test(name);
}

/** A header value: comments off, quotes off (and their escapes undone). */
function unquote(raw: string): string {
  const v = raw.trim();
  // Quoted: up to the closing quote (a comment may follow it).
  const q = /^"((?:[^"\\]|\\.)*)"|^'((?:[^']|'')*)'/.exec(v);
  if (q)
    return q[1] !== undefined ? q[1].replace(/\\(.)/g, "$1") : (q[2] ?? "").replace(/''/g, "'");
  return v.replace(/\s+#.*$/, "");
}

/** One agent file → its definition, or null (no header, no name or description). */
export function parseSubagentFile(
  text: string,
  source: SubagentSource,
  path?: string,
): SubagentDef | null {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const header: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  let blockKey: string | null = null;
  let blockFold = false;
  let block: string[] = [];
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const prev = header[listKey];
      header[listKey] = [...(Array.isArray(prev) ? prev : []), item[1] ?? ""];
      continue;
    }
    if (blockKey) {
      if (/^\s+\S/.test(line) || line.trim() === "") {
        block.push(line.trim());
        continue;
      }
      header[blockKey] = block.join(blockFold ? " " : "\n").trim();
      blockKey = null;
    }
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv?.[1]) continue;
    // A block value (`description: |` or `>`): the indented lines after it.
    const marker = (kv[2] ?? "").trim();
    if (/^[|>][+-]?$/.test(marker)) {
      blockKey = kv[1];
      blockFold = marker.startsWith(">");
      block = [];
      listKey = null;
      continue;
    }
    const key = kv[1];
    const value = unquote(kv[2] ?? "");
    listKey = value === "" ? key : null;
    header[key] = value === "" ? [] : value;
  }
  if (blockKey) header[blockKey] = block.join(blockFold ? " " : "\n").trim();
  const str = (k: string) => (typeof header[k] === "string" ? (header[k] as string) : undefined);
  const name = str("name");
  const description = str("description");
  if (!name || !description || !validSubagentName(name)) return null;
  const tools = header.tools ? mapTools(list(header.tools)) : undefined;
  const disallowed = header.disallowedTools ? mapTools(list(header.disallowedTools)) : [];
  const steps = Number(str("maxTurns") ?? str("maxSteps"));
  const model = str("model");
  const fallbackModel = str("fallbackModel");
  const mode = str("permissionMode");
  const rules = header.rules ? list(header.rules) : undefined;
  const omit = str("omitClaudeMd") ?? str("omitRules");
  const label = str("label")?.slice(0, 60);
  const role = str("role")?.slice(0, 40);
  const icon = str("icon");
  const handoffs = parseHandoffs(m[1] ?? "");
  const startMode = str("mode")?.toLowerCase();
  const subagentList = header.subagents ? list(header.subagents) : undefined;
  return {
    name,
    description,
    ...(label && { label }),
    ...(role && { role }),
    ...(icon && { icon }),
    prompt: (m[2] ?? "").trim(),
    // A tools line, even one that maps to nothing, limits it (never "every tool" by mistake).
    ...(tools && { tools }),
    ...(disallowed.length && { disallowedTools: disallowed }),
    ...(mode === "acceptEdits" && { acceptEdits: true }),
    ...(model && { model }),
    ...(fallbackModel && { fallbackModel }),
    ...((mode === "plan" || str("readOnly") === "true") && { readOnly: true }),
    ...(startMode && START_MODES.includes(startMode) && { startMode: startMode as StartMode }),
    ...(Number.isFinite(steps) && steps > 0 && { maxSteps: Math.min(200, Math.floor(steps)) }),
    ...(rules?.length && { rules }),
    ...(omit === "true" && { omitRules: true }),
    ...(str("isolation")?.toLowerCase() === "worktree" && { isolation: "worktree" as const }),
    ...(handoffs.length && { handoffs }),
    // `none` allows none; `*` (or no key) every one.
    ...(subagentList &&
      !subagentList.includes("*") && {
        subagents: subagentList.filter((n) => n.toLowerCase() !== "none"),
      }),
    source,
    ...(path && { path }),
  };
}

/** The name an agent is shown by: its label, else its id. */
export function agentLabel(def: Pick<SubagentDef, "name" | "label">): string {
  return def.label?.trim() || def.name;
}

/** A new agent file's text. */
export function subagentTemplate(name: string, description: string): string {
  return `---
name: ${name}
description: ${description || "What it does, and when the agent should hand work to it."}
tools: read_file, search, find_files, list_dir
model: inherit
---

You are ${name}. Describe here how it should work: what to look at, what to do, and what its
report should contain.
`;
}

/**
 * A subagent as a Claude Code file (D288: Customize on a built-in one writes its copy to
 * `.claude/agents`, which then replaces it). Read-only is `permissionMode: plan`, as Claude Code
 * reads it; its label stays ours (Claude Code ignores keys it doesn't know).
 */
export function subagentFile(def: SubagentDef): string {
  const lines = [
    "---",
    `name: ${def.name}`,
    ...(def.label ? [`label: ${def.label}`] : []),
    `description: ${def.description.replace(/\s+/g, " ")}`,
    ...(def.tools?.length ? [`tools: ${def.tools.join(", ")}`] : []),
    ...(def.readOnly ? ["permissionMode: plan"] : []),
    `model: ${def.model || "inherit"}`,
    ...(def.maxSteps ? [`maxTurns: ${def.maxSteps}`] : []),
    ...(def.omitRules ? ["omitClaudeMd: true"] : []),
    "---",
    "",
  ];
  const prompt =
    def.prompt.trim() ||
    `You are ${def.name}. Describe here how it should work: what to look at, what to do, and what its report should contain.`;
  return `${lines.join("\n")}${prompt}\n`;
}

/**
 * Definitions in order of precedence: the project's (its own folder before `.claude/agents`), the
 * user's, then the built-ins. The first of a name wins.
 */
export function mergeSubagents(...lists: readonly (readonly SubagentDef[])[]): SubagentDef[] {
  const seen = new Set<string>();
  const out: SubagentDef[] = [];
  for (const list of lists)
    for (const def of list) {
      const key = def.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(def);
    }
  return out;
}

/** Whether a tool list names a tool: by its name, or an MCP server's name for all its tools. */
export function toolListed(list: readonly string[], tool: string): boolean {
  return list.some((e) => e === tool || (e.startsWith("mcp__") && tool.startsWith(`${e}__`)));
}

/** The tools a subagent gets out of `available`: read-only ones, its list, or all but delegating (D288: nor handing off: it works privately). */
export function subagentTools(
  def: SubagentDef,
  available: readonly string[],
  background = false,
): string[] {
  const allowed = available.filter(
    (t) =>
      (!def.tools || toolListed(def.tools, t)) &&
      !toolListed(def.disallowedTools ?? [], t) &&
      t !== "delegate" &&
      t !== "hand_off" &&
      t !== "ask_user" &&
      // A workflow (D338) is the main agent's, run when the user asks for one.
      t !== "run_workflow" &&
      // Cards for the user (D313, D314): a subagent's calls aren't in the conversation.
      t !== "report_findings" &&
      t !== "suggest_extension" &&
      t !== "suggest_skill" &&
      t !== "suggest_mcp_server" &&
      t !== "mcp_status" &&
      t !== "suggest_sandbox_allowance" &&
      t !== "update_plan" &&
      // The chat's own turn tools (wrap_up, chapters, tasks, D301): the main agent's.
      !TURN_TOOL_NAMES.has(t),
  );
  return def.readOnly || background
    ? allowed.filter((t) => READ_TOOLS.includes(t) || GUIDE_TOOLS.includes(t))
    : allowed;
}

/** The subagent's instructions, with what every subagent is told. */
export function subagentSystem(def: SubagentDef): string {
  return `${def.prompt.trim()}${SUFFIX}`;
}

/**
 * A model name from a definition → one of `keys` (provider/model): an exact key or model name, or
 * a Claude alias (sonnet, opus, haiku, fable) matched to the newest model whose name has it.
 * Null means the chat's model ("inherit", empty, or nothing matches).
 */
export function resolveModelName(
  wanted: string | undefined,
  keys: readonly string[],
): string | null {
  const w = wanted?.trim();
  if (!w || w === "inherit" || w === "default") return null;
  const exact = keys.find((k) => k === w || k.slice(k.indexOf("/") + 1) === w);
  if (exact) return exact;
  const alias = w.toLowerCase();
  if (!/^(sonnet|opus|haiku|fable|best)$/.test(alias)) return null;
  const want = alias === "best" ? "opus" : alias;
  const matches = keys.filter((k) => k.toLowerCase().includes(want));
  if (!matches.length) return null;
  // Newest first: the highest version number in the name.
  // Major and minor version from the name; date stamps (20250929) don't count.
  const version = (k: string): [number, number] => {
    const parts = (k.match(/\d+/g) ?? []).filter((n) => n.length < 6).map(Number);
    const [major = 0, minor = 0] = parts;
    return [major, minor];
  };
  return (
    [...matches].sort((a, b) => {
      const [am, an] = version(a);
      const [bm, bn] = version(b);
      return bm - am || bn - an;
    })[0] ?? null
  );
}

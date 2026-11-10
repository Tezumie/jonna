// Custom chat modes (D227, Cursor's custom modes and Copilot's chat modes): a mode of the user's
// own beside Agent, Plan and Ask, with its instructions, the tools it may use and optionally its
// model. From the user's `agent.customModes` setting, or a folder's `.github/chatmodes/*.chatmode.md`
// and `.github/agents/*.agent.md` (Copilot's files: front matter `description`, `tools`, `model`;
// the body is the instructions). DOM-free.
import { type Handoff, parseHandoffs } from "./groupChat";
import { parseSkillFrontMatter } from "./skills";

export interface CustomMode {
  /** Shown in the mode menu; also the id (`custom:<name>`). */
  name: string;
  description: string;
  /** Sent with each message in this mode (like Plan's and Ask's rules). */
  instructions: string;
  /** Tool names and groups it may use; null: every tool, as in Agent mode. */
  tools: string[] | null;
  /** provider/model for its turns, when set. */
  model: string | null;
  /** The model its turns go on with at a usage limit (an agent's `fallbackModel`, D254). */
  fallbackModel?: string;
  /** Where it's from ("user settings", ".github/chatmodes/review.chatmode.md"). */
  source: string;
  /** Set when the mode is one of the user's agents (D230): chatting with that agent. */
  agent?: { label: string; role?: string; icon?: string; path?: string };
  /** Buttons after its replies that move the chat to another agent (`handoffs:`, D231). */
  handoffs?: Handoff[];
  /** Tools it may never use (an agent's `disallowedTools`, D245). */
  deny?: string[];
  /** Its edits are kept without review (an agent's `permissionMode: acceptEdits`, D245). */
  acceptEdits?: boolean;
  /** Plan or Ask: the mode a chat with it starts in (an agent's `mode:`, D249). */
  startMode?: "plan" | "ask";
  /** Its reasoning effort (agent.effort's values), picked for it by the user (D273). */
  effort?: string;
  /** Only the reading tools (an agent's `permissionMode: plan`, or the user's pick). */
  readOnly?: boolean;
}

/** agent.effort's values, "default" (the model's own) first. */
export const EFFORT_VALUES = ["default", "low", "medium", "high", "xhigh", "max"] as const;

/** An effort as the menus say it. */
export function effortLabel(effort: string): string {
  return (
    {
      default: "Model default",
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "Extra high",
      max: "Max",
    }[effort] ?? effort
  );
}

/** What an agent's chat needs from its definition (core/agent/subagents.ts's SubagentDef). */
export interface AgentForMode {
  name: string;
  label?: string;
  role?: string;
  icon?: string;
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
  fallbackModel?: string;
  readOnly?: boolean;
  path?: string;
  handoffs?: readonly Handoff[];
  disallowedTools?: readonly string[];
  acceptEdits?: boolean;
  startMode?: "agent" | "plan" | "ask";
  effort?: string;
  /** The subagents it may run (D288); undefined: all. */
  subagents?: readonly string[];
}

/** The access the user picked for one of their agents (D273): its edits kept, or reading only. */
export type AgentAccess = "edit" | "read";

/** An agent with the access the user picked for it: the user's pick beats its file's. */
export function withAccess<T extends AgentForMode>(def: T, access: AgentAccess | undefined): T {
  if (access === "read") return { ...def, readOnly: true, acceptEdits: false };
  if (access === "edit") return { ...def, readOnly: false, acceptEdits: true };
  return def;
}

/**
 * One of the user's agents as a chat mode (D230: chatting with an agent): its instructions go
 * with each message, its tools and model apply; read-only agents get the reading tools.
 */
export function agentAsMode(def: AgentForMode, readTools: readonly string[]): CustomMode {
  const model = def.model?.trim();
  // Explore is a subagent with a tool of its own: an agent not allowed it doesn't get the tool.
  const deny = [
    ...(def.disallowedTools ?? []),
    ...(def.subagents && !def.subagents.some((n) => n.toLowerCase() === "explore")
      ? ["explore"]
      : []),
  ];
  return {
    name: def.name,
    description: def.description,
    instructions: def.prompt,
    tools: def.readOnly ? [...readTools] : (def.tools ?? null),
    model: model && model !== "inherit" && model !== "default" ? model : null,
    source: def.path ?? def.name,
    agent: {
      label: def.label?.trim() || def.name,
      ...(def.role && { role: def.role }),
      ...(def.icon && { icon: def.icon }),
      ...(def.path && { path: def.path }),
    },
    ...(def.handoffs?.length && { handoffs: [...def.handoffs] }),
    ...(deny.length && { deny }),
    ...(def.acceptEdits && !def.readOnly && { acceptEdits: true }),
    ...(def.startMode && def.startMode !== "agent" && { startMode: def.startMode }),
    ...(def.fallbackModel?.trim() && { fallbackModel: def.fallbackModel.trim() }),
    ...(def.effort && def.effort !== "default" && { effort: def.effort }),
    ...(def.readOnly && { readOnly: true }),
  };
}

export const CUSTOM_PREFIX = "custom:";

export const customModeId = (name: string): string => `${CUSTOM_PREFIX}${name}`;

/** The mode a `custom:<name>` id names, if it's there. */
export function findCustomMode(
  modes: readonly CustomMode[],
  id: string | null | undefined,
): CustomMode | undefined {
  if (!id?.startsWith(CUSTOM_PREFIX)) return undefined;
  const name = id.slice(CUSTOM_PREFIX.length);
  return modes.find((m) => m.name === name);
}

const list = (v: unknown): string[] | null => {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && !!x.trim());
  if (typeof v === "string" && v.trim())
    return v
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  return null;
};

/** A mode file: `review.chatmode.md` or `review.agent.md` is named "review" unless it says. */
export function parseModeFile(fileName: string, text: string, source: string): CustomMode | null {
  const base = fileName.replace(/\.(chatmode|agent)\.md$/i, "").replace(/\.md$/i, "");
  const parsed = parseSkillFrontMatter(text);
  const meta = parsed?.meta ?? {};
  const body = (parsed ? parsed.body : text).trim();
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const name = str(meta.name) || base;
  if (!name || !body) return null;
  // VS Code's .agent.md handoffs (D231): a list of maps the front-matter reader doesn't keep.
  const header = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const handoffs = parseHandoffs(header);
  return {
    name,
    description: str(meta.description),
    instructions: body,
    tools: list(meta.tools),
    model: str(meta.model) || null,
    source,
    ...(handoffs.length && { handoffs }),
  };
}

/** `agent.customModes`: [{ name, description?, instructions, tools?, model? }]. */
export function parseModeSetting(value: unknown): CustomMode[] {
  if (!Array.isArray(value)) return [];
  const out: CustomMode[] = [];
  for (const raw of value) {
    const x = raw as Record<string, unknown>;
    const name = typeof x?.name === "string" ? x.name.trim() : "";
    const instructions =
      typeof x?.instructions === "string"
        ? x.instructions.trim()
        : typeof x?.prompt === "string"
          ? x.prompt.trim()
          : "";
    if (!name || !instructions) continue;
    out.push({
      name,
      description: typeof x.description === "string" ? x.description : "",
      instructions,
      tools: list(x.tools),
      model: typeof x.model === "string" && x.model.trim() ? x.model.trim() : null,
      source: "user settings",
    });
  }
  return out;
}

/** The chat's own modes: no custom mode or agent takes their names. */
export const BUILT_IN_MODES: ReadonlySet<string> = new Set(["agent", "plan", "ask"]);

/**
 * The lists in order (the user's agents first, D232, then settings, then the folder's); a later
 * mode with a name already taken is skipped.
 */
export function mergeModes(...lists: readonly CustomMode[][]): CustomMode[] {
  const seen = new Set<string>(BUILT_IN_MODES);
  const out: CustomMode[] = [];
  for (const l of lists)
    for (const m of l) {
      const key = m.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m);
    }
  return out;
}

/**
 * Names a mode's `tools` may use for groups of the IDE agent's tools: its own groups ("read",
 * "edit", "run"), Claude Code's tool names and Copilot's chat mode tool names.
 */
const GROUPS: Readonly<Record<string, readonly string[] | "read">> = {
  read: "read",
  codebase: "read",
  search: "read",
  usages: "read",
  problems: "read",
  findtestfiles: "read",
  edit: ["write_file", "edit_file"],
  editfiles: ["write_file", "edit_file"],
  write: ["write_file"],
  multiedit: ["edit_file"],
  run: ["run_command"],
  bash: ["run_command"],
  runcommands: ["run_command"],
  runinterminal: ["run_command"],
  terminal: ["run_command"],
  todos: ["update_plan"],
  todowrite: ["update_plan"],
  grep: ["search"],
  glob: ["find_files", "list_dir"],
  ls: ["list_dir"],
};

/** Whether a mode lets the agent use a tool. */
export function modeAllows(mode: CustomMode, tool: { name: string; readOnly: boolean }): boolean {
  if (
    mode.deny?.some(
      (e) => e === tool.name || (e.startsWith("mcp__") && tool.name.startsWith(`${e}__`)),
    )
  )
    return false;
  if (!mode.tools) return true;
  for (const entry of mode.tools) {
    if (entry === tool.name) return true;
    const group = GROUPS[entry.toLowerCase().replace(/[^a-z]/g, "")];
    if (group === "read" ? tool.readOnly : group?.includes(tool.name)) return true;
    // MCP servers' tools: "mcp" for all of them, `mcp__<server>` for one server's.
    if (entry === "mcp" && tool.name.startsWith("mcp__")) return true;
    if (entry.startsWith("mcp__") && tool.name.startsWith(`${entry}__`)) return true;
  }
  return false;
}

/** A new mode file's text (agent.createChatMode). */
export function modeTemplate(name: string): string {
  return `---
description: What this mode is for, in one line
tools: [read, edit]
---

You are in ${name} mode. Describe how the agent should work here: what to focus on, what to
avoid, and what a good answer looks like.
`;
}

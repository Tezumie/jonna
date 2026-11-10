// Editing the agent's rules (D204): what the Rules page shows and writes. The scope a person picks
// (always, for matching files, by description, for a folder, only when mentioned), how each kind
// of rules file says it in its front matter, new rules from a template (a Cursor .mdc, a section
// of AGENTS.md, Copilot's .instructions.md, Claude Code's .claude/rules), and which rules a
// subagent gets. DOM-free and tested; the files are read and written by extensions/agent/rules*.ts.
import { parseFrontMatter, type Rule, type RuleSource, splitGlobs } from "./rules";

/** The scope as the Rules page names it (Cursor's four kinds, plus a folder's own file). */
export type RuleScope = "always" | "globs" | "description" | "folder" | "manual";

export function ruleScope(rule: Pick<Rule, "activation">): RuleScope {
  switch (rule.activation) {
    case "always":
      return "always";
    case "files":
      return "globs";
    case "requested":
      return "description";
    case "folder":
      return "folder";
    default:
      return "manual";
  }
}

/** Which scopes a kind of file can hold (a root AGENTS.md is always on; its place decides). */
export function scopesFor(source: RuleSource, path: string): RuleScope[] {
  switch (source) {
    case "cursor":
      return !path.startsWith(".cursor/")
        ? ["folder", "globs", "description", "manual"]
        : ["always", "globs", "description", "manual"];
    case "instructions":
      return ["always", "globs", "description", "manual"];
    case "claudeRules":
      return ["always", "globs"];
    default:
      return [];
  }
}

export const SCOPE_LABELS: Record<RuleScope, string> = {
  always: "Always",
  globs: "Matching files",
  description: "When relevant (description)",
  folder: "Files in its folder",
  manual: "Only when mentioned",
};

/** Where each source comes from, for the page's "Source" column. */
export const SOURCE_LABELS: Record<RuleSource, string> = {
  agents: "AGENTS.md",
  claude: "CLAUDE.md",
  copilot: "Copilot instructions",
  instructions: "Copilot .instructions.md",
  cursorrules: ".cursorrules",
  cursor: "Cursor rule",
  claudeRules: "Claude Code rule",
  user: "Your own rules",
};

export interface RuleFields {
  scope: RuleScope;
  globs?: string[];
  description?: string;
  /** Subagent names (`*` all, [] none); undefined leaves the default. */
  subagents?: string[];
}

/**
 * The front matter keys a kind of file uses for `fields` (null value: remove the key). Cursor:
 * description, globs, alwaysApply; Copilot: applyTo, description; Claude Code: paths.
 */
export function frontMatterFor(
  source: RuleSource,
  fields: RuleFields,
): Record<string, string | null> {
  const globs = (fields.globs ?? []).map((g) => g.trim()).filter(Boolean);
  const description = fields.description?.trim() || null;
  const subagents =
    fields.subagents === undefined
      ? undefined
      : fields.subagents.length === 0
        ? "none"
        : fields.subagents.join(", ");
  const out: Record<string, string | null> = {};
  if (source === "cursor") {
    out.description = description;
    out.globs = fields.scope === "globs" && globs.length ? globs.join(",") : null;
    out.alwaysApply = fields.scope === "always" || fields.scope === "folder" ? "true" : "false";
  } else if (source === "instructions") {
    out.applyTo =
      fields.scope === "always"
        ? '"**"'
        : fields.scope === "globs" && globs.length
          ? JSON.stringify(globs.join(","))
          : null;
    out.description = fields.scope === "manual" ? null : description;
  } else if (source === "claudeRules") {
    out.paths = fields.scope === "globs" && globs.length ? JSON.stringify(globs.join(",")) : null;
    out.description = description;
  }
  if (subagents !== undefined) out.subagents = subagents;
  return out;
}

/**
 * `text` with its front matter keys set (`null` removes one; other keys and the body stay). A key
 * written as a YAML list (`globs:` then `- …` lines) is replaced as a whole.
 */
export function setFrontMatter(text: string, values: Record<string, string | null>): string {
  const src = text.replace(/^﻿/, "");
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const lines = m ? (m[1] ?? "").split(/\r?\n/) : [];
  const body = m ? src.slice(m[0].length) : src;
  const done = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const kv = /^\s*([\w-]+)\s*:/.exec(line);
    const key = kv?.[1];
    const match = key && Object.keys(values).find((k) => k.toLowerCase() === key.toLowerCase());
    if (!match) {
      out.push(line);
      continue;
    }
    // Skip the key's list items.
    while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1] ?? "")) i++;
    done.add(match);
    const value = values[match];
    if (value !== null && value !== undefined) out.push(`${match}: ${value}`);
  }
  for (const [k, v] of Object.entries(values))
    if (!done.has(k) && v !== null && v !== undefined) out.push(`${k}: ${v}`);
  const meta = out.filter((l, i) => l.trim() || i < out.length - 1);
  if (!meta.length) return body;
  return `---${eol}${meta.join(eol)}${eol}---${eol}${body}`;
}

/** The fields a rule's file says now (for the editor). */
export function fieldsOf(rule: Rule): RuleFields {
  return {
    scope: ruleScope(rule),
    globs: rule.globs,
    ...(rule.description && { description: rule.description }),
    ...(rule.subagents && { subagents: rule.subagents }),
  };
}

export type RuleTemplate = "cursor" | "agents" | "copilot" | "claude";

export const TEMPLATE_LABELS: Record<RuleTemplate, string> = {
  cursor: "Cursor rule (.cursor/rules/<name>.mdc)",
  agents: "Section of AGENTS.md",
  copilot: "Copilot instructions (.github/instructions/<name>.instructions.md)",
  claude: "Claude Code rule (.claude/rules/<name>.md)",
};

/** A rule's file name from what a person typed: lower case, words joined by -. */
export function ruleSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "rule"
  );
}

export interface NewRule {
  /** Workspace-relative path. */
  path: string;
  /** The whole file (`append` false) or the text to add at its end. */
  text: string;
  append: boolean;
}

/**
 * A new rule from a template. `existing` is the target file's text when it exists (an AGENTS.md
 * section is added to it, in its folder for a folder rule).
 */
export function newRule(
  template: RuleTemplate,
  name: string,
  fields: RuleFields & { folder?: string; body?: string },
  existing: string | null = null,
): NewRule {
  const slug = ruleSlug(name);
  const body =
    fields.body?.trim() ||
    "Describe what the agent should do here: conventions, commands to run, things to avoid.";
  const folder = fields.folder?.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") ?? "";
  if (template === "agents") {
    const path = folder ? `${folder}/AGENTS.md` : "AGENTS.md";
    const title = name.trim() || "Rules";
    const section = `## ${title}\n\n${body}\n`;
    if (existing?.trim())
      return { path, text: `${existing.endsWith("\n") ? "" : "\n"}\n${section}`, append: true };
    return { path, text: `# AGENTS.md\n\n${section}`, append: false };
  }
  const source: RuleSource =
    template === "cursor" ? "cursor" : template === "copilot" ? "instructions" : "claudeRules";
  const base =
    template === "cursor"
      ? `.cursor/rules/${slug}.mdc`
      : template === "copilot"
        ? `.github/instructions/${slug}.instructions.md`
        : `.claude/rules/${slug}.md`;
  // A folder's own Cursor rules (D203): web/.cursor/rules/x.mdc.
  const path = template === "cursor" && folder ? `${folder}/${base}` : base;
  const scope =
    template === "cursor" && folder && fields.scope === "always" ? "folder" : fields.scope;
  const text = setFrontMatter(`${body}\n`, frontMatterFor(source, { ...fields, scope }));
  return { path, text, append: false };
}

// ---- Subagents (D204) ---------------------------------------------------------------------

/**
 * What decides a subagent's rules, after Claude Code: a custom subagent (and the general and
 * reviewer ones) starts with the project's always-on rules, as Claude Code's get CLAUDE.md; the
 * built-in plan and explore start without (theirs don't either), and `omitRules` (Claude's
 * `omitClaudeMd`) leaves them out. `rules` in its definition preloads more in full (Claude's
 * `skills:`), and a rule's own `subagents:` front matter gives it to the subagents it names (or
 * keeps it from all of them with `none`).
 */
export interface SubagentRuleNeeds {
  name: string;
  /** Rule paths or names (a file name without its extension) to load in full. */
  rules?: readonly string[];
  omitRules?: boolean;
}

const ruleName = (path: string) =>
  (path.slice(path.lastIndexOf("/") + 1) || path).replace(/(\.instructions)?\.(mdc?|md)$/i, "");

/** Whether `wanted` (a path or a name) means this rule. */
export function ruleMatchesRef(rule: Pick<Rule, "path">, wanted: string): boolean {
  const w = wanted.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!w) return false;
  if (w === rule.path) return true;
  return !w.includes("/") && ruleName(rule.path).toLowerCase() === w.toLowerCase();
}

export function rulesForSubagent<T extends Rule>(rules: readonly T[], def: SubagentRuleNeeds): T[] {
  const name = def.name.toLowerCase();
  return rules.filter((r) => {
    if (def.rules?.some((ref) => ruleMatchesRef(r, ref))) return true;
    if (r.subagents) {
      if (r.subagents.length === 0) return false;
      return r.subagents.some((s) => s === "*" || s.toLowerCase() === name);
    }
    return !def.omitRules && r.activation === "always";
  });
}

/**
 * The folder and matching-files rules a subagent gets with its read or edit of `rel` (D207), as
 * the main agent does (D200), instead of all of them in its prompt: the ones covering the file
 * that may go to this subagent (a `subagents:` list naming it or `*`; none for `subagents:
 * none`; none when it omits the project's rules, unless named) and that its prompt doesn't
 * already hold. `covering` is rulesForFile's answer for the file.
 */
export function subagentRulesForFile<T extends Rule>(
  covering: readonly T[],
  inPrompt: readonly T[],
  def: SubagentRuleNeeds,
): T[] {
  const name = def.name.toLowerCase();
  return covering.filter((r) => {
    if (inPrompt.some((p) => p.path === r.path)) return false;
    if (r.subagents) {
      if (r.subagents.length === 0) return false;
      return r.subagents.some((s) => s === "*" || s.toLowerCase() === name);
    }
    return !def.omitRules;
  });
}

/** The rules section of a subagent's instructions. */
export function renderSubagentRules(
  rules: readonly (Rule & { text: string })[],
  budget = 16_000,
): string {
  if (!rules.length) return "";
  let left = budget;
  const parts: string[] = [];
  for (const r of rules) {
    const text = r.text.trim();
    if (!text || left <= 0) continue;
    const block = `--- ${r.path} ---\n${text.length > left ? `${text.slice(0, left)}\n… (truncated)` : text}`;
    parts.push(block);
    left -= block.length;
  }
  return parts.length
    ? `\n\nThe project's rules (follow them in this task):\n${parts.join("\n\n")}`
    : "";
}

/** `subagents:` text from the page's field ("reviewer, test-runner", "*", "none", ""). */
export function parseSubagentField(value: string): string[] | undefined {
  const v = value.trim();
  if (!v) return undefined;
  if (/^(none|no)$/i.test(v)) return [];
  if (/^(\*|all)$/i.test(v)) return ["*"];
  return splitGlobs(v);
}

/** For tests and the page: the front matter of a text, lower-cased keys. */
export const frontMatterOf = (text: string) => parseFrontMatter(text).meta;

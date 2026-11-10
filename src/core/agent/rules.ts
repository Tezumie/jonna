// The project's rules for the agent (D200): every rules file other AI tools use, not only the
// first one found — AGENTS.md (at the root and in subfolders), CLAUDE.md with its `@path`
// imports, .github/copilot-instructions.md, .github/instructions/*.instructions.md (`applyTo`),
// .cursorrules and .cursor/rules/*.mdc (`alwaysApply`, `globs`, `description`; a subfolder's own
// .cursor/rules holds for files under it, and both folders may have subfolders, D203), plus the user's
// own rules file. Each rule is either always in the prompt, attached when the agent reads or
// edits a file it covers (a subfolder's AGENTS.md, a glob), or listed for the agent to read when
// it applies. DOM-free and tested; the files are read by extensions/agent/rules.ts.
import { globToRegExp } from "../paths/glob";

export type RuleSource =
  | "agents"
  | "claude"
  | "copilot"
  | "instructions"
  | "cursorrules"
  | "cursor"
  /** `.claude/rules/**\/*.md` (Claude Code's rules folder, `paths` front matter), D204. */
  | "claudeRules"
  | "user";

/**
 * always: in every chat's prompt; folder: a subfolder's AGENTS.md / CLAUDE.md, attached when a
 * file under that folder is read or edited; files: attached for files matching its globs;
 * requested: listed with its description, read by the agent when it applies; manual: only when
 * the user mentions it (@rules).
 */
export type RuleActivation = "always" | "folder" | "files" | "requested" | "manual";

export interface RuleInput {
  /** Workspace-relative with `/` (a user-level file: its absolute path, with `user`). */
  path: string;
  text: string;
  user?: boolean;
}

export interface Rule {
  path: string;
  source: RuleSource;
  activation: RuleActivation;
  /** For "files": workspace-relative globs. */
  globs: string[];
  /**
   * For "folder": the folder it covers (relative, no trailing `/`); also set on a subfolder's
   * .cursor/rules rule of any kind, which only holds inside that folder (D203).
   */
  folder?: string;
  description?: string;
  /** The text without its front matter. */
  body: string;
  user?: boolean;
  /**
   * Which subagents get this rule (D204, front matter `subagents:`): names, or `*` for all of
   * them; `[]` (`subagents: none`) keeps it from every subagent. Undefined: the default (an
   * always-on rule goes to the subagents that load the project's rules).
   */
  subagents?: string[];
}

/** Root files that are always in the prompt, in prompt order (the first is the IDE's own). */
export const ROOT_RULE_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
  ".github/copilot-instructions.md",
  ".cursorrules",
];

const NESTED_NAMES = new Set(["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md"]);

const relDir = (path: string) => {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
};
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * Front matter (`---` … `---`) as lower-cased keys and string values; a YAML list under a key
 * (`globs:` then `- "*.ts"` lines) becomes one comma-separated value.
 */
export function parseFrontMatter(text: string): { meta: Record<string, string>; body: string } {
  const src = text.replace(/^﻿/, "");
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, string> = {};
  let listKey: string | null = null;
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const value = unquote((item[1] ?? "").trim());
      meta[listKey] = meta[listKey] ? `${meta[listKey]},${value}` : value;
      continue;
    }
    const kv = /^\s*([\w-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = (kv[1] ?? "").toLowerCase();
    const value = (kv[2] ?? "").trim();
    meta[key] = unquote(value);
    listKey = value === "" ? key : null;
  }
  return { meta, body: src.slice(m[0].length) };
}

const unquote = (v: string) => v.replace(/^["']|["']$/g, "");

/** `"src/**, *.ts"`, `[a, b]` or quoted parts → the globs. */
export function splitGlobs(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .trim()
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((g) => unquote(g.trim()).trim())
    .filter(Boolean);
}

/** `subagents:` front matter → names (`*` for all, `[]` for none); undefined when absent. */
export function parseSubagentTargets(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const list = splitGlobs(value);
  if (list.some((v) => /^(none|false)$/i.test(v))) return [];
  if (list.some((v) => /^(\*|all|true)$/i.test(v))) return ["*"];
  return list;
}

/** What kind of rule a file is (null: not a rules file). */
export function classifyRule(input: RuleInput): Rule | null {
  const rule = classifyBase(input);
  if (!rule || rule.source === "user") return rule;
  // Any rules file may name the subagents it's for (D204): front matter `subagents:`.
  if (!/^﻿?---\r?\n/.test(input.text)) return rule;
  const { meta, body } = parseFrontMatter(input.text);
  const targets = parseSubagentTargets(meta.subagents);
  if (targets === undefined) return rule;
  // Files read without their front matter (AGENTS.md, CLAUDE.md…) drop it here.
  const plain = rule.body === input.text || rule.body === input.text.replace(/^﻿/, "");
  return { ...rule, subagents: targets, ...(plain && { body }) };
}

function classifyBase(input: RuleInput): Rule | null {
  const { path, text } = input;
  const name = baseName(path);
  if (input.user)
    return {
      path,
      source: "user",
      activation: "always",
      globs: [],
      body: parseFrontMatter(text).body,
      user: true,
    };
  if (path === ".cursorrules")
    return { path, source: "cursorrules", activation: "always", globs: [], body: text };
  if (path === ".github/copilot-instructions.md")
    return { path, source: "copilot", activation: "always", globs: [], body: text };
  const cursor = /^(?:(.+)\/)?\.cursor\/rules\/.+\.mdc?$/i.exec(path);
  if (cursor) {
    const { meta, body } = parseFrontMatter(text);
    const globs = splitGlobs(meta.globs);
    const description = meta.description || undefined;
    // A subfolder's .cursor/rules (Cursor's nested rules, D203) holds for files under that
    // subfolder only: always-on becomes "for this folder", globs and descriptions stay in it.
    const folder = cursor[1];
    const activation: RuleActivation =
      meta.alwaysapply === "true"
        ? folder
          ? "folder"
          : "always"
        : globs.length
          ? "files"
          : description
            ? "requested"
            : "manual";
    return {
      path,
      source: "cursor",
      activation,
      globs,
      ...(folder && { folder }),
      ...(description && { description }),
      body,
    };
  }
  // Claude Code's rules folder (D204): `paths` globs, or always on without them.
  if (/^\.claude\/rules\/.+\.md$/i.test(path)) {
    const { meta, body } = parseFrontMatter(text);
    const globs = splitGlobs(meta.paths);
    const description = meta.description || undefined;
    return {
      path,
      source: "claudeRules",
      activation: globs.length ? "files" : "always",
      globs,
      ...(description && { description }),
      body,
    };
  }
  if (/^\.github\/instructions\/.+\.instructions\.md$/i.test(path)) {
    const { meta, body } = parseFrontMatter(text);
    const globs = splitGlobs(meta.applyto);
    const description = meta.description || undefined;
    const everything = globs.some((g) => g === "**" || g === "**/*" || g === "*");
    const activation: RuleActivation = everything
      ? "always"
      : globs.length
        ? "files"
        : description
          ? "requested"
          : "manual";
    return {
      path,
      source: "instructions",
      activation,
      globs: everything ? [] : globs,
      ...(description && { description }),
      body,
    };
  }
  if (NESTED_NAMES.has(name)) {
    const folder = relDir(path);
    const source: RuleSource = name === "AGENTS.md" ? "agents" : "claude";
    return folder
      ? { path, source, activation: "folder", globs: [], folder, body: text }
      : { path, source, activation: "always", globs: [], body: text };
  }
  return null;
}

/** Rules files in folders of rules (any depth inside them; a subfolder's .cursor/rules too). */
const RULE_FOLDER_FILE =
  /^(?:(?:.+\/)?\.cursor\/rules\/.+\.mdc?|\.github\/instructions\/.+\.instructions\.md|\.claude\/rules\/.+\.md)$/i;

/**
 * The rules files among workspace-relative `paths` (an index lookup) that sit in a subfolder's
 * .cursor/rules or deeper inside .cursor/rules / .github/instructions (D203): what a listing of
 * the root's two folders misses. The shallowest first, at most `limit`.
 */
export function nestedRuleFiles(paths: readonly string[], limit: number): string[] {
  const depth = (p: string) => p.split("/").length;
  return [...new Set(paths)]
    .filter((p) => RULE_FOLDER_FILE.test(p))
    .filter((p) => !/^(?:\.cursor\/rules|\.github\/instructions|\.claude\/rules)\/[^/]+$/i.test(p))
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
    .slice(0, limit);
}

/** A glob without a `/` matches the name in any folder (`*.ts`), as Cursor and Copilot read it. */
function globMatches(glob: string, rel: string): boolean {
  const g = glob.replace(/^\.\//, "").replace(/^\/+/, "");
  return globToRegExp(g.includes("/") ? g : `**/${g}`).test(rel);
}

/** Whether `rule` is attached for the workspace-relative file `rel`. */
export function ruleCovers(rule: Rule, rel: string): boolean {
  const path = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  if (rule.activation === "folder" && rule.folder !== undefined)
    return path.startsWith(`${rule.folder}/`);
  if (rule.activation === "files") {
    if (rule.folder === undefined) return rule.globs.some((g) => globMatches(g, path));
    // A nested .cursor/rules rule: files under its folder, its globs relative to that folder
    // (or written from the root, which people do as well).
    if (!path.startsWith(`${rule.folder}/`)) return false;
    const inner = path.slice(rule.folder.length + 1);
    return rule.globs.some((g) => globMatches(g, inner) || globMatches(g, path));
  }
  return false;
}

/**
 * A rule of another folder of a multi-root workspace (D251), as the workspace names it: its path
 * with the folder's name in front ("api/AGENTS.md"), and what it covers inside that folder only —
 * a root rule stays always on (labeled with the folder), a folder's own globs and subfolders are
 * read inside it. Matched with workspace-relative paths ("api/src/x.ts"). User rules unchanged.
 */
export function ruleInFolder<T extends Rule>(rule: T, name: string): T {
  if (rule.user) return rule;
  const inside = (p: string | undefined) => (p ? `${name}/${p}` : name);
  const scoped = rule.activation === "files" || rule.activation === "requested" || !!rule.folder;
  return {
    ...rule,
    path: `${name}/${rule.path}`,
    ...(scoped && rule.activation !== "always" && { folder: inside(rule.folder) }),
  };
}

/** The rules attached when the agent reads or edits `rel` (outer folders first). */
export function rulesForFile<T extends Rule>(rules: readonly T[], rel: string): T[] {
  return rules
    .filter((r) => ruleCovers(r, rel))
    .sort((a, b) => (a.folder?.length ?? 1e9) - (b.folder?.length ?? 1e9));
}

/** Why a rule is active, in a few words (the rules list, ide://agent/rules). */
export function ruleReason(rule: Rule): string {
  switch (rule.activation) {
    case "always":
      return rule.user ? "Your own rules, in every project" : "Always on";
    case "folder":
      return `When the agent reads or edits a file in ${rule.folder}/`;
    case "files":
      return `When the agent reads or edits ${rule.globs.join(", ")}${rule.folder ? ` in ${rule.folder}/` : ""}`;
    case "requested":
      return `Listed by its description; the agent reads it when it applies${rule.folder ? ` to ${rule.folder}/` : ""}`;
    default:
      return "Only when you mention it (@rules)";
  }
}

/** `@path` imports (CLAUDE.md): outside code, with a `/` or an extension (not `@someone`). */
export function importRefs(text: string): string[] {
  const plain = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const out: string[] = [];
  for (const m of plain.matchAll(/(?:^|[\s(])@((?:~\/|\.{1,2}\/|\/)?[\w.-]+(?:\/[\w.-]+)*)/g)) {
    const ref = (m[1] ?? "").replace(/[.,;:)]+$/, "");
    if (!ref || (!ref.includes("/") && !/\.\w{1,8}$/.test(ref))) continue;
    if (!out.includes(ref)) out.push(ref);
  }
  return out;
}

/** Most nested imports (Claude Code's limit). */
export const MAX_IMPORT_DEPTH = 5;

/**
 * The text with each `@path` import's contents added after it (recursively, at most
 * MAX_IMPORT_DEPTH deep, each file once). `resolve(ref, fromFile)` gives the path to read;
 * `read` returns null for a file that can't be read (left as written).
 */
export async function expandImports(
  text: string,
  file: string,
  io: {
    resolve(ref: string, fromFile: string): string | null;
    read(path: string): Promise<string | null>;
  },
  seen: Set<string> = new Set([file]),
  depth = 0,
): Promise<{ text: string; imported: string[] }> {
  const imported: string[] = [];
  if (depth >= MAX_IMPORT_DEPTH) return { text, imported };
  const parts = [text];
  for (const ref of importRefs(text)) {
    const path = io.resolve(ref, file);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const content = await io.read(path);
    if (content === null) continue;
    imported.push(path);
    const inner = await expandImports(content, path, io, seen, depth + 1);
    imported.push(...inner.imported);
    parts.push(`Imported from @${ref}:\n${inner.text.trim()}`);
  }
  return { text: parts.join("\n\n"), imported };
}

export interface LoadedRule extends Rule {
  /** The body with its imports (what the agent gets). */
  text: string;
}

const PER_RULE = 8000;
const cut = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}\n… (truncated)` : text;

function heading(rule: Rule): string {
  if (rule.user) return `Your own rules (${baseName(rule.path)}, they hold in every project):`;
  if (rule.source === "cursorrules") return `Project rules from ${rule.path}:`;
  if (rule.source === "cursor" || rule.source === "claudeRules")
    return `Project rule ${rule.path}:`;
  return `Project instructions from ${rule.path}:`;
}

const ORDER: Record<RuleSource, number> = {
  user: 0,
  agents: 1,
  claude: 2,
  copilot: 3,
  instructions: 4,
  cursorrules: 5,
  cursor: 6,
  claudeRules: 7,
};

/**
 * The prompt's rules section: the always-on rules in full (within `budget` characters, a file
 * whose text repeats one already shown is left out), then one line per other rule.
 */
export function renderRulesPrompt(rules: readonly LoadedRule[], budget = 24_000): string {
  const out: string[] = [];
  const shown = new Set<string>();
  let left = budget;
  const always = rules
    .filter((r) => r.activation === "always")
    .sort((a, b) => ORDER[a.source] - ORDER[b.source] || a.path.localeCompare(b.path));
  for (const r of always) {
    const text = r.text.trim();
    if (!text || shown.has(text) || left <= 0) continue;
    shown.add(text);
    const block = `${heading(r)}\n${cut(text, Math.min(PER_RULE, left))}`;
    out.push(block);
    left -= block.length;
  }
  const other = rules.filter((r) => r.activation !== "always" && r.activation !== "manual");
  if (other.length)
    out.push(
      `More project rules. Those for a folder or for matching files come with the tool result when you read or edit such a file; read_file one listed by its description when it applies to the task:\n${other
        .map(
          (r) =>
            `- ${r.path}${r.description ? `: ${r.description}` : ""}${
              r.activation === "folder"
                ? ` (for files in ${r.folder}/)`
                : r.activation === "files"
                  ? ` (for ${r.globs.join(", ")}${r.folder ? ` in ${r.folder}/` : ""})`
                  : r.folder
                    ? ` (for files in ${r.folder}/)`
                    : ""
            }`,
        )
        .join("\n")}`,
    );
  return out.join("\n\n");
}

/** The rules attached to a tool result for a file (D200): what to follow while working on it. */
export function renderAttachedRules(rules: readonly LoadedRule[], rel: string): string {
  if (!rules.length) return "";
  return `\n\n<rules for="${rel}">\nThe project's rules for this file (follow them while you work on it):\n${rules
    .map((r) => `--- ${r.path} (${ruleReason(r).toLowerCase()}) ---\n${cut(r.text.trim(), 6000)}`)
    .join("\n\n")}\n</rules>`;
}

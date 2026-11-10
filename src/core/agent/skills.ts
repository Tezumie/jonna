// Agent skills (D206), the format Claude Code and Cursor share (agentskills.io): a folder with a
// SKILL.md whose YAML front matter gives `name` and `description`, then the instructions; other
// files in the folder (references, scripts, assets) are read only when the skill needs them. The
// agent sees each skill's name, description and path up front and loads the rest with its
// use_skill tool; the user can run one as `/name args`. DOM-free and tested; the folders are read
// by extensions/agent/skills.ts.
import { globToRegExp } from "../paths/glob";
import { expandArguments } from "./slash";

/** Where a skill was found: the user's own folders, or the open folder's. */
export type SkillScope = "user" | "workspace";

export interface SkillMeta {
  name: string;
  description: string;
  /** `argument-hint`: what to type after /name. */
  argumentHint?: string;
  /** `disable-model-invocation: true`: only the user runs it (/name), the agent isn't told of it. */
  disableModelInvocation: boolean;
  /** `user-invocable: false`: not offered as /name; the agent still uses it. */
  userInvocable: boolean;
  /**
   * `allowed-tools` as written: a user's own skill pre-approves them while it's active (its /name
   * turn, or the rest of the turn it was loaded in, D221); a project's skill only shows them.
   */
  allowedTools: string[];
  /**
   * `paths` (or the older `globs`): the files it's for. Such a skill isn't listed up front; it's
   * offered when the agent works on a matching file (D221, Claude Code's reading).
   */
  paths: string[];
  /** `model`, as written: the model of its /name turn, or of its forked run. */
  model?: string;
  /** `effort` (low … max): the reasoning effort of its /name turn (D221). */
  effort?: string;
  /** `context: fork`: it runs in a subagent of its own, which returns a report (D221). */
  fork: boolean;
  /** `agent`: the subagent a forked skill runs as (default: general). */
  agent?: string;
  body: string;
}

export interface ParsedSkill {
  skill: SkillMeta | null;
  /** Why it can't be used (no description, a bad name…), when `skill` is null. */
  error?: string;
  /** Things that don't stop it (a name that differs from its folder's…). */
  warnings: string[];
}

/** The reasoning efforts a skill may ask for (agent.effort's values). */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** The listing caps a description (with `when_to_use`) here, as Claude Code does. */
export const DESCRIPTION_LIMIT = 1536;
export const NAME_LIMIT = 64;

/** Lowercase letters, digits and single hyphens, at most 64 characters (the shared format). */
export function isValidSkillName(name: string): boolean {
  return name.length > 0 && name.length <= NAME_LIMIT && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

/** A typed name turned into a skill name ("Deploy App" → "deploy-app"); "" when nothing is left. */
export function slugSkillName(typed: string): string {
  return typed
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, NAME_LIMIT)
    .replace(/-+$/, "");
}

const unquote = (v: string) => {
  const t = v.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'"))))
    return t[0] === '"'
      ? t.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n")
      : t.slice(1, -1).replace(/''/g, "'");
  return t;
};

type FrontValue = string | string[];

/**
 * YAML front matter, as much of YAML as skills use: `key: value` (quoted or not), block scalars
 * (`description: >` or `|` and the indented lines after), a plain value continued on indented
 * lines, lists (`- item` lines, or `[a, b]`). A nested map (`metadata:` with `key: value` under it)
 * is skipped. Keys are lower-cased. Null when the text has no front matter.
 */
export function parseSkillFrontMatter(
  text: string,
): { meta: Record<string, FrontValue>; body: string } | null {
  const src = text.replace(/^﻿/, "");
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return null;
  const meta: Record<string, FrontValue> = {};
  const lines = (m[1] ?? "").split(/\r?\n/);
  let i = 0;
  const indented = (line: string) => /^[ \t]+\S/.test(line) || line.trim() === "";
  while (i < lines.length) {
    const line = lines[i] ?? "";
    i++;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const kv = /^([\w-]+)\s*:(?:\s+(.*)|\s*)$/.exec(line);
    if (!kv) continue;
    const key = (kv[1] ?? "").toLowerCase();
    const raw = (kv[2] ?? "").replace(/\s+#.*$/, "").trim();
    // Block scalar: the indented lines that follow (folded joins them with spaces).
    const block = /^([>|])[+-]?\d*$/.exec(raw);
    if (block) {
      const taken: string[] = [];
      while (i < lines.length && indented(lines[i] ?? "")) taken.push(lines[i++] ?? "");
      while (taken.length && !taken[taken.length - 1]?.trim()) taken.pop();
      const pad = Math.min(
        ...taken.filter((l) => l.trim()).map((l) => (/^[ \t]*/.exec(l)?.[0] ?? "").length),
      );
      const body = taken.map((l) => l.slice(Number.isFinite(pad) ? pad : 0));
      meta[key] =
        block[1] === "|"
          ? body.join("\n")
          : body
              .join("\n")
              .split(/\n[ \t]*\n/)
              .map((p) =>
                p
                  .split("\n")
                  .map((l) => l.trim())
                  .join(" "),
              )
              .join("\n")
              .trim();
      continue;
    }
    if (raw === "") {
      // A list, or a nested map (skipped).
      const items: string[] = [];
      let nested = false;
      while (i < lines.length && (indented(lines[i] ?? "") || /^-\s/.test(lines[i] ?? ""))) {
        const next = lines[i++] ?? "";
        const item = /^\s*-\s+(.*)$/.exec(next);
        if (item) items.push(unquote(item[1] ?? ""));
        else if (next.trim()) nested = true;
      }
      if (items.length) meta[key] = items;
      else if (!nested) meta[key] = "";
      continue;
    }
    if (raw.startsWith("[") && raw.endsWith("]")) {
      meta[key] = raw
        .slice(1, -1)
        .split(",")
        .map((x) => unquote(x))
        .filter(Boolean);
      continue;
    }
    // A plain value continued on indented lines.
    let value = raw;
    if (!/^["']/.test(raw))
      while (
        i < lines.length &&
        /^[ \t]+\S/.test(lines[i] ?? "") &&
        !/^\s*-\s/.test(lines[i] ?? "")
      )
        value += ` ${(lines[i++] ?? "").trim()}`;
    meta[key] = unquote(value);
  }
  return { meta, body: src.slice(m[0].length) };
}

const asText = (v: FrontValue | undefined): string =>
  v === undefined ? "" : Array.isArray(v) ? v.join(", ") : v;
const asList = (v: FrontValue | undefined): string[] =>
  v === undefined
    ? []
    : (Array.isArray(v) ? v : v.split(/[,\s]+(?![^(]*\))/)).map((x) => x.trim()).filter(Boolean);
const asBool = (v: FrontValue | undefined, fallback: boolean): boolean => {
  const t = asText(v).trim().toLowerCase();
  return t === "true" || t === "yes" ? true : t === "false" || t === "no" ? false : fallback;
};

/**
 * A SKILL.md read: its fields, or why it can't be used. `folder` is its folder's name, the name
 * when the front matter has none (as Claude Code does); Cursor wants the two to match, so a
 * difference is a warning.
 */
export function parseSkillFile(text: string, folder: string): ParsedSkill {
  const warnings: string[] = [];
  const front = parseSkillFrontMatter(text);
  if (!front)
    return { skill: null, error: "No front matter (--- name, description ---).", warnings };
  const { meta, body } = front;
  const name = asText(meta.name).trim() || folder;
  if (!isValidSkillName(name))
    return {
      skill: null,
      error: `The name "${name}" isn't valid: lowercase letters, digits and hyphens, at most ${NAME_LIMIT} characters.`,
      warnings,
    };
  if (name !== folder) warnings.push(`The name (${name}) differs from its folder's (${folder}).`);
  let description = asText(meta.description).replace(/\s+/g, " ").trim();
  if (!description)
    return {
      skill: null,
      error: "No description: the agent decides when to use a skill from it.",
      warnings,
    };
  const when = asText(meta.when_to_use).replace(/\s+/g, " ").trim();
  if (when) description = `${description} ${when}`;
  if (description.length > DESCRIPTION_LIMIT) {
    warnings.push(`The description is cut at ${DESCRIPTION_LIMIT} characters.`);
    description = `${description.slice(0, DESCRIPTION_LIMIT - 1)}…`;
  }
  // `argument-hint: [issue-number]` is a YAML list, but it's meant as written.
  const rawHint = meta["argument-hint"];
  const hint = (Array.isArray(rawHint) ? `[${rawHint.join(", ")}]` : asText(rawHint)).trim();
  const model = asText(meta.model).trim();
  const effort = asText(meta.effort).trim().toLowerCase();
  const agent = asText(meta.agent).trim();
  const context = asText(meta.context).trim().toLowerCase();
  if (context && context !== "fork")
    warnings.push(`context: ${context} isn't known (only fork is); it runs in the conversation.`);
  if (effort && !EFFORTS.includes(effort))
    warnings.push(`effort: ${effort} isn't one of ${EFFORTS.join(", ")}; it's left out.`);
  return {
    skill: {
      name,
      description,
      ...(hint && { argumentHint: hint }),
      disableModelInvocation: asBool(meta["disable-model-invocation"], false),
      userInvocable: asBool(meta["user-invocable"], true),
      allowedTools: asList(meta["allowed-tools"]),
      paths: asList(meta.paths ?? meta.globs),
      ...(model && { model }),
      ...(effort && EFFORTS.includes(effort) && { effort }),
      fork: context === "fork",
      ...(agent && { agent }),
      body: body.trim(),
    },
    warnings,
  };
}

/** A skill found on disk, with where it is. */
export interface FoundSkill extends SkillMeta {
  scope: SkillScope;
  /** The folder it was found in, as shown ("~/.claude/skills", ".cursor/skills"…). */
  source: string;
  /** The skill's folder (absolute). */
  dir: string;
  /** Its SKILL.md (absolute). */
  file: string;
  warnings: string[];
  /**
   * A nested skill (D221, Claude Code's monorepo skills): the folder (workspace-relative, `/`)
   * whose `.claude/skills` it's in. It's offered when the agent works on a file inside it.
   */
  nested?: string;
  /** One that comes with the IDE (D255): no folder on disk; a skill of the same name replaces it. */
  builtin?: boolean;
}

export interface SkillProblem {
  scope: SkillScope;
  source: string;
  file: string;
  error: string;
}

/**
 * One skill per name: a workspace skill overrides a user skill of the same name (like the IDE's
 * settings, D206; Claude Code puts personal ones first), and within a scope the first folder in
 * precedence order wins. `found` is in precedence order within each scope. The ones left out are
 * returned as `shadowed`.
 */
export function mergeSkills(found: readonly FoundSkill[]): {
  skills: FoundSkill[];
  shadowed: FoundSkill[];
} {
  const byName = new Map<string, FoundSkill>();
  const shadowed: FoundSkill[] = [];
  for (const s of found) {
    const had = byName.get(s.name);
    if (!had) byName.set(s.name, s);
    else if (had.scope === "user" && s.scope === "workspace") {
      shadowed.push(had);
      byName.set(s.name, s);
    } else shadowed.push(s);
  }
  const skills = [...byName.values()].sort(
    (a, b) =>
      (a.scope === b.scope ? 0 : a.scope === "user" ? -1 : 1) || a.name.localeCompare(b.name),
  );
  return { skills, shadowed };
}

/**
 * The folders' skills, then the nested ones found so far (D221). A nested skill whose name is
 * taken gets its folder in front, `apps/web:deploy` (D229, Claude Code's monorepo naming; the
 * plain `/deploy` stays the root's); one still taken after that is left out.
 */
export function withNestedSkills(
  skills: readonly FoundSkill[],
  nested: readonly FoundSkill[],
): FoundSkill[] {
  const names = new Set(skills.map((x) => x.name));
  const extra: FoundSkill[] = [];
  for (const x of nested) {
    const name = names.has(x.name) && x.nested !== undefined ? `${x.nested}:${x.name}` : x.name;
    if (names.has(name)) continue;
    names.add(name);
    extra.push(name === x.name ? x : { ...x, name });
  }
  return [...skills, ...extra];
}

/** The skills the agent may pick by itself: not turned off, not `disable-model-invocation`. */
export function modelSkills(
  skills: readonly FoundSkill[],
  disabled: ReadonlySet<string>,
): FoundSkill[] {
  return skills.filter((s) => !disabled.has(s.name) && !s.disableModelInvocation);
}

/**
 * The skills the prompt lists up front: those the agent may pick by itself, minus the ones only
 * for some files (`paths`) and nested ones, which are offered when the agent works there (D221).
 */
export function upFrontSkills(skills: readonly FoundSkill[]): FoundSkill[] {
  return skills.filter((s) => !s.paths.length && s.nested === undefined);
}

/** A glob without a `/` matches the name in any folder (`*.ts`), as for rules. */
function globCovers(glob: string, rel: string): boolean {
  const g = glob.trim().replace(/^\.\//, "").replace(/^\/+/, "");
  if (!g) return false;
  return globToRegExp(g.includes("/") ? g : `**/${g}`).test(rel);
}

/**
 * Whether a skill is for the workspace-relative file `rel` (D221): inside a nested skill's
 * folder, and matching its `paths` (relative to that folder, or to the root) when it has some.
 */
export function skillCoversFile(skill: FoundSkill, rel: string): boolean {
  const path = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  let inner = path;
  if (skill.nested !== undefined) {
    if (!path.startsWith(`${skill.nested}/`)) return false;
    inner = path.slice(skill.nested.length + 1);
    if (!skill.paths.length) return true;
  }
  if (!skill.paths.length) return false;
  return skill.paths.some((g) => globCovers(g, inner) || globCovers(g, path));
}

/**
 * The skills to offer with a tool result about `rel` (D221): the ones for that file the chat
 * hasn't been told of yet (`told`, by name), in name order.
 */
export function skillsForFile(
  skills: readonly FoundSkill[],
  rel: string,
  told: ReadonlySet<string>,
): FoundSkill[] {
  return skills
    .filter((s) => !told.has(s.name) && skillCoversFile(s, rel))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The note a tool result carries for those skills (empty with none). */
export function renderFileSkills(skills: readonly FoundSkill[], rel: string): string {
  if (!skills.length) return "";
  return `\n\n(Skills for ${rel}; load one with use_skill {name} when the task matches it:\n${skills
    .map((s) => `- ${s.name}: ${s.description}`)
    .join("\n")})`;
}

/**
 * The folders a nested skill could be in for the workspace-relative file `rel` (D221): every
 * folder between it and the root (not the root, whose skills are read anyway) with each label
 * (`.claude/skills`…), the nearest first.
 */
export function nestedSkillDirs(rel: string, labels: readonly string[]): string[] {
  const parts = rel.replace(/\\/g, "/").split("/").filter(Boolean);
  parts.pop();
  const out: string[] = [];
  for (let n = parts.length; n >= 1; n--) {
    const folder = parts.slice(0, n).join("/");
    // Not inside dependencies, git's folder or a skills folder itself.
    if (/(^|\/)(node_modules|\.git|skills)(\/|$)/.test(folder)) continue;
    for (const label of labels) out.push(`${folder}/${label}`);
  }
  return out;
}

/** The system prompt's skills section (empty with none): name, description and where it is. */
export function renderSkillsPrompt(
  skills: readonly FoundSkill[],
  shownPath: (s: FoundSkill) => string,
): string {
  if (!skills.length) return "";
  const lines = skills.map((s) => {
    const paths = s.paths.length ? ` (for files matching ${s.paths.join(", ")})` : "";
    return `- ${s.name}: ${s.description}${paths} [${shownPath(s)}]`;
  });
  return `Skills (instructions and files for particular tasks; only their descriptions are here). When a task matches a skill's description, call use_skill {name} first to load its instructions and the list of its files, then follow them. Don't load a skill that doesn't fit the task.\n${lines.join("\n")}`;
}

/** A file inside a skill's folder from the model's input: `/` separated, never outside it. */
export function skillFileRel(input: string): string | null {
  const rel = input.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!rel || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return null;
  const parts = rel.split("/").filter((p) => p && p !== ".");
  if (!parts.length || parts.some((p) => p === "..")) return null;
  return parts.join("/");
}

/** The body with `${CLAUDE_SKILL_DIR}` (and `${SKILL_DIR}`) set to the skill's folder. */
export function withSkillDir(body: string, dir: string): string {
  return body.replace(/\$\{(?:CLAUDE_SKILL_DIR|SKILL_DIR)\}/g, dir);
}

const folderName = (dir: string) =>
  dir
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() ?? dir;

/** What use_skill returns: the instructions, then the folder's other files to read when needed. */
export function renderSkillForAgent(
  skill: FoundSkill,
  files: readonly string[],
  readHint: string,
): string {
  const others = files.filter((f) => f !== "SKILL.md");
  const tools = skill.allowedTools.length
    ? `\n(The skill lists allowed-tools: ${skill.allowedTools.join(", ")}. ${
        skill.scope === "user"
          ? "They run without asking for the rest of this turn."
          : "A project's skill can't pre-approve tools: they still ask as usual."
      })`
    : "";
  const list = others.length
    ? `\n\nFiles in the skill's folder (${skill.dir}); read one when the instructions call for it, ${readHint}:\n${others.map((f) => `- ${f}`).join("\n")}`
    : "";
  return `Skill ${skill.name} (${skill.source}/${folderName(skill.dir)}/SKILL.md). Follow these instructions:\n\n${withSkillDir(skill.body, skill.dir)}${tools}${list}`;
}

/** What `/name args` sends with the message (the user ran the skill). */
export function renderSkillInvocation(
  skill: FoundSkill,
  args: string,
  files: readonly string[],
  readHint: string,
): string {
  const body = expandArguments(withSkillDir(skill.body, skill.dir), args);
  const others = files.filter((f) => f !== "SKILL.md");
  const list = others.length
    ? `\n\nFiles in the skill's folder (${skill.dir}), ${readHint}:\n${others.map((f) => `- ${f}`).join("\n")}`
    : "";
  return `The user ran the skill /${skill.name} (${skill.source}/${folderName(skill.dir)}/SKILL.md). Follow it:\n${body}${list}`;
}

/** A forked skill's task for its subagent (D221, `context: fork`): the instructions, filled in. */
export function renderForkedSkillTask(
  skill: FoundSkill,
  args: string,
  files: readonly string[],
  readHint: string,
): string {
  const body = expandArguments(withSkillDir(skill.body, skill.dir), args);
  const others = files.filter((f) => f !== "SKILL.md");
  const list = others.length
    ? `\n\nFiles in the skill's folder (${skill.dir}), ${readHint}:\n${others.map((f) => `- ${f}`).join("\n")}`
    : "";
  return `Carry out the skill ${skill.name} (${skill.source}/${folderName(skill.dir)}/SKILL.md) and report what you found or did:\n${body}${list}`;
}

/** What `/name args` sends for a forked skill: the agent runs it with use_skill (D221). */
export function renderForkInvocation(skill: FoundSkill, args: string): string {
  return `The user ran the skill /${skill.name}, which runs in a subagent of its own (context: fork). Call use_skill with ${JSON.stringify({ name: skill.name, arguments: args })} now: it runs the skill there and returns the subagent's report. Then tell the user what it found or did.`;
}

/** A new skill's SKILL.md (the Skills page's New). */
export function skillTemplate(name: string): string {
  return `---\nname: ${name}\ndescription: Describe when Agent should use this skill.\n---\n\n# ${name}\n\nDescribe the workflow and knowledge this skill provides.\n`;
}

/**
 * The skills a stretch of conversation used (D221): use_skill calls that worked and /name runs,
 * in order, each once. A summary names them, so the agent loads them again when it needs them.
 */
export function skillsUsedIn(
  items: readonly {
    type: string;
    name?: string;
    status?: string;
    args?: unknown;
    context?: string[];
  }[],
): string[] {
  const out: string[] = [];
  const add = (name: string) => {
    if (name && !out.includes(name)) out.push(name);
  };
  for (const it of items) {
    if (it.type === "tool" && it.name === "use_skill" && it.status === "done") {
      const name = (it.args as { name?: unknown } | null)?.name;
      if (typeof name === "string") add(name.trim().replace(/^\//, ""));
    } else if (it.type === "user")
      for (const c of it.context ?? []) {
        const m = /^The user ran the skill \/([\w:./-]+)/.exec(c);
        if (m?.[1]) add(m[1]);
      }
  }
  return out;
}

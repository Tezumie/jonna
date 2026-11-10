// Agent skills (D206), like Claude Code's and Cursor's: a folder with a SKILL.md (front matter
// `name`, `description`) and files it refers to. Found in the user's folders (the IDE's own
// ~/<dataFolderName>/skills, and ~/.claude/skills, ~/.cursor/skills, ~/.agents/skills) and the
// open folder's (<workspace folder>/skills, .claude/skills, .cursor/skills, .agents/skills), one
// level of skill folders each; a workspace skill overrides a user skill of the same name. The
// agent's prompt lists each one's name and description (context.ts); its use_skill tool loads the
// instructions and lists the folder's files; `/name args` runs one (a slash source). Turned off:
// `agent.skills.disabled`. State: ide://agent/skills; commands agent.listSkills here, the page and
// its commands in skillsPage.ts. The format's logic is DOM-free in core/agent/skills.ts. D221: the user
// folders are watched; nested `<folder>/.claude/skills` and skills with `paths` are offered with the
// first tool result about a file they cover; a user's own skill pre-approves its allowed-tools while
// active; `context: fork` runs one in a subagent; `model` / `effort` hold for its /name turn.
import { approveDecision } from "../../core/agent/autoApprove";
import type { ToolOutcome } from "../../core/agent/loop";
import {
  type FoundSkill,
  mergeSkills,
  modelSkills,
  nestedSkillDirs,
  parseSkillFile,
  renderFileSkills,
  renderForkedSkillTask,
  renderForkInvocation,
  renderSkillForAgent,
  renderSkillInvocation,
  renderSkillsPrompt,
  type SkillProblem,
  type SkillScope,
  skillFileRel,
  skillsForFile,
  upFrontSkills,
  withNestedSkills,
} from "../../core/agent/skills";
import { mergeTurnTools } from "../../core/agent/slash";
import { subagentSystem, subagentTools } from "../../core/agent/subagents";
import { on } from "../../core/dom/index";
import { skillsIpc } from "../../core/ipc/agent";
import { fsIpc } from "../../core/ipc/fs";
import { appIpc } from "../../core/ipc/system";
import type { Disposable, DisposableStore } from "../../core/lifecycle/index";
import {
  basename,
  isWithin,
  joinPath,
  relativePath,
  resolveInRoot,
  samePath,
} from "../../core/paths/index";
import { product } from "../../core/product";
import { effect, signal, untracked } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { workspaceFolderLabelsOf } from "../../workbench/workspaceFolder";
import { approveRules } from "./autoApprove";
import buildExtensionSkill from "./builtinSkills/build-extension.md?raw";
import { registerSlashSource } from "./composerExtras";
import { agentIgnored, ignoredMessage } from "./ignore";
import { activePlugins, pluginLabel } from "./pluginContributions";
import { projectInstructionsBlocked } from "./riskyGuard";
import { rulesFor } from "./rules";
import type { SessionManager } from "./sessions";
import { registerSkillsPage } from "./skillsPage";
import { type SubagentRegistry, subagentModel } from "./subagents";
import type { AgentTool } from "./tools";

const READ_LIMIT = 40_000;
/** Skill folders looked at per skills folder, and files listed per skill. */
const SKILLS_PER_FOLDER = 100;
const FILES_PER_SKILL = 100;
const FILE_DEPTH = 3;
/** Read again after this when the user folders couldn't be watched (D221: they normally are). */
const STALE_MS = 30_000;
const SKILL_PATH = /(?:^|[\\/])skills(?:[\\/]|$)/i;
/** Other tools' skills folders, in precedence order (with agent.thirdPartyConfigs, D179). */
const OTHER_FOLDERS = [".claude/skills", ".cursor/skills", ".agents/skills"];

/**
 * Skills that come with the IDE (D255), read after every folder's: one of the same name in the
 * user's folders or the open folder replaces it (Customize on the Skills page makes that copy).
 */
const BUILTIN_SKILLS: readonly { name: string; text: string }[] = [
  { name: "build-extension", text: buildExtensionSkill },
];

/** A built-in skill's SKILL.md (Customize copies it), or null. */
export function builtinSkillText(name: string): string | null {
  return BUILTIN_SKILLS.find((b) => b.name === name)?.text ?? null;
}

function builtinSkills(): FoundSkill[] {
  return BUILTIN_SKILLS.flatMap(({ name, text }) => {
    const parsed = parseSkillFile(text, name);
    return parsed.skill
      ? [
          {
            ...parsed.skill,
            scope: "user" as const,
            source: "built in",
            dir: `builtin:${name}`,
            file: `builtin:${name}/SKILL.md`,
            warnings: parsed.warnings,
            builtin: true,
          },
        ]
      : [];
  });
}

export interface SkillFolder {
  /** Absolute. */
  dir: string;
  /** As shown: "~/.claude/skills", ".cursor/skills"… */
  label: string;
  scope: SkillScope;
  /** The IDE's own: New writes here, Delete removes from here. */
  own?: boolean;
  /** A plugin's (D358): its skills are named `<plugin>:<skill>`, as in Claude Code. */
  prefix?: string;
}

export interface LoadedSkills {
  skills: FoundSkill[];
  shadowed: FoundSkill[];
  problems: SkillProblem[];
}

/** The skills turned off (`agent.skills.disabled`: names). */
export function disabledSkills(services: WorkbenchServices): Set<string> {
  const list = services.settings.peek<unknown>("agent.skills.disabled");
  return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
}

async function readText(path: string, limit = READ_LIMIT): Promise<string | null> {
  try {
    const text = new TextDecoder().decode(await fsIpc.read(path)).replace(/^﻿/, "");
    return text.length > limit ? `${text.slice(0, limit)}\n… (truncated)` : text;
  } catch {
    return null;
  }
}

export class SkillsService {
  /** Bumped when the skills may have changed (the page redraws). */
  readonly version = signal(0);
  private cache: { key: string; at: number; loaded: Promise<LoadedSkills> } | null = null;
  private home: string | null | undefined;
  /**
   * The user folders are watched (D221): the list stays until a change says otherwise. Without
   * the watcher (it couldn't start) it's read again after STALE_MS.
   */
  watching = false;
  /** Nested skills folders looked at so far (D221), workspace-relative: their skills. */
  private nested = new Map<string, FoundSkill[]>();

  constructor(private readonly services: WorkbenchServices) {}

  /** A skill file or folder changed (or the folder did, or a setting): read them again. */
  invalidate(): void {
    this.cache = null;
    this.nested = new Map();
    this.version.value++;
  }

  /** The labels a nested skills folder has (`.claude/skills`…), as for the open folder's. */
  private nestedLabels(root?: string | null): string[] {
    return [
      ...workspaceFolderLabelsOf(root ?? null, "skills"),
      ...(this.others() ? OTHER_FOLDERS : []),
    ];
  }

  /**
   * The nested skills for the workspace-relative file `rel` (D221, Claude Code's monorepo
   * skills): `<folder>/.claude/skills/<skill>/SKILL.md` in the folders between the file and the
   * root, each folder read once (until a change). Not in restricted mode or a risky folder.
   */
  async nestedFor(rel: string, inFolder?: string): Promise<FoundSkill[]> {
    // D251: `rel` is relative to the workspace folder `inFolder` (the first by default).
    const first = this.services.workspace.root.peek();
    const root = inFolder ?? first;
    if (!root || projectInstructionsBlocked(this.services, root)) return [];
    // Another folder's nested skills are named with it ("api/pkg/.claude/skills").
    const owner = this.services.workspace.folderOf(root);
    const prefix =
      first && !samePath(root, first) && this.services.workspace.folders.peek().length > 1
        ? `${owner?.name ?? basename(root)}/`
        : "";
    const out: FoundSkill[] = [];
    for (const dirRel of nestedSkillDirs(rel, this.nestedLabels(root))) {
      const key = `${prefix}${dirRel}`;
      let skills = this.nested.get(key);
      if (!skills) {
        const label = this.nestedLabels(root).find((l) => dirRel.endsWith(`/${l}`)) ?? "";
        const folder = dirRel.slice(0, dirRel.length - label.length - 1);
        const read = await this.readFolder({
          dir: resolveInRoot(root, dirRel),
          label: key,
          scope: "workspace",
        });
        skills = read.found.map((x) => ({ ...x, nested: `${prefix}${folder}` }));
        this.nested.set(key, skills);
      }
      out.push(...skills);
    }
    return out;
  }

  /** The nested skills found so far (each folder's, the nearest folder's first by name). */
  private nestedKnown(): FoundSkill[] {
    return [...this.nested.values()].flat();
  }

  /**
   * Every skill the agent may be offered: the folders' ones, then nested ones found so far (one
   * whose name is taken as `folder:name`, D229).
   */
  async known(): Promise<FoundSkill[]> {
    return withNestedSkills((await this.all()).skills, this.nestedKnown());
  }

  /**
   * What a tool result about `path` carries for skills (D221): the ones for that file — a
   * matching `paths`, or nested in a folder it's in — that the chat hasn't been told of yet.
   * They're noted in `told` (name → turn).
   */
  async noteFor(path: string, told: Map<string, number>, turn: number): Promise<string> {
    const { workspace } = this.services;
    const root = workspace.root.peek();
    if (!root) return "";
    const abs = workspace.resolve(path);
    // D251: the workspace folder holding it (its nested skills; its own path for `paths`).
    const owner = workspace.folderOf(abs)?.path ?? (isWithin(root, abs) ? root : null);
    if (!owner) return "";
    const rel = relativePath(owner, abs);
    await this.nestedFor(rel, owner);
    const off = disabledSkills(this.services);
    const offered = skillsForFile(modelSkills(await this.known(), off), rel, new Set(told.keys()));
    for (const x of offered) told.set(x.name, turn);
    return renderFileSkills(offered, rel);
  }

  /** Whether `path` may be in a skills folder: its change invalidates. */
  static isSkillPath(path: string): boolean {
    return SKILL_PATH.test(path);
  }

  private others(): boolean {
    return this.services.settings.peek<boolean>("agent.thirdPartyConfigs") !== false;
  }

  private async homeDir(): Promise<string | null> {
    if (this.home === undefined)
      this.home = (await appIpc.info().catch(() => null))?.homeDir ?? null;
    return this.home;
  }

  /** The IDE's own user skills folder (`~/<dataFolderName>/skills`), where New writes. */
  async userDir(): Promise<string | null> {
    const home = await this.homeDir();
    return home ? joinPath(joinPath(home, product.dataFolderName), "skills") : null;
  }

  /**
   * A folder's own skills folder (`<workspace folder>/skills`), where New writes: `root`'s (a
   * folder of a multi-root workspace, D251), the first folder's by default.
   */
  workspaceDir(root: string | null = this.services.workspace.root.peek()): string | null {
    const label = root ? workspaceFolderLabelsOf(root, "skills")[0] : undefined;
    return root && label ? resolveInRoot(root, label) : null;
  }

  /**
   * Every skills folder, in precedence order: the user's, then the open folder's (D251: each
   * workspace folder's, the first first, labeled with the folder's name when there are several).
   */
  async folders(): Promise<SkillFolder[]> {
    const out: SkillFolder[] = [];
    const home = await this.homeDir();
    const own = await this.userDir();
    if (own && home)
      out.push({ dir: own, label: `~/${product.dataFolderName}/skills`, scope: "user", own: true });
    if (home && this.others())
      for (const rel of OTHER_FOLDERS)
        out.push({ dir: resolveInRoot(home, rel), label: `~/${rel}`, scope: "user" });
    // D358: the enabled plugins' skills, the user's.
    for (const p of activePlugins.peek())
      for (const dir of p.skillDirs)
        out.push({ dir, label: pluginLabel(p.name), scope: "user", prefix: `${p.name}:` });
    // D213: not a folder's own in restricted mode or a risky folder (Downloads…), each folder
    // judged on its own.
    const first = this.services.workspace.root.peek();
    const several = this.services.workspace.folders.peek().length > 1;
    for (const f of this.workspaceFolders()) {
      if (projectInstructionsBlocked(this.services, f.path)) continue;
      const isFirst = !!first && samePath(f.path, first);
      const named = (label: string) => (several ? `${f.name}/${label}` : label);
      workspaceFolderLabelsOf(f.path, "skills").forEach((label, i) => {
        out.push({
          dir: resolveInRoot(f.path, label),
          label: named(label),
          scope: "workspace",
          ...(i === 0 && isFirst && { own: true }),
        });
      });
      if (this.others())
        for (const rel of OTHER_FOLDERS)
          out.push({ dir: resolveInRoot(f.path, rel), label: named(rel), scope: "workspace" });
    }
    return out;
  }

  /** The workspace's folders, the first first (none with nothing open). */
  private workspaceFolders(): readonly { path: string; name: string }[] {
    const root = this.services.workspace.root.peek();
    if (!root) return [];
    const list = this.services.workspace.folders.peek();
    return list.length ? list : [{ path: root, name: basename(root) || root }];
  }

  /** Every skill (one per name), the ones shadowed by another and the files that aren't valid. */
  all(): Promise<LoadedSkills> {
    const root = this.services.workspace.root.peek();
    const folders = this.services.workspace.folders.peek();
    const key = `${root}\0${this.others()}\0${activePlugins
      .peek()
      .map((p) => p.id)
      .join(
        ",",
      )}${folders.length > 1 ? `\0${folders.map((f) => `${f.path}\u0001${f.name}`).join("\0")}` : ""}`;
    if (
      this.cache &&
      this.cache.key === key &&
      (this.watching || Date.now() - this.cache.at < STALE_MS)
    )
      return this.cache.loaded;
    const loaded = this.load().catch(() => ({ skills: [], shadowed: [], problems: [] }));
    this.cache = { key, at: Date.now(), loaded };
    return loaded;
  }

  private async load(): Promise<LoadedSkills> {
    const found: FoundSkill[] = [];
    const problems: SkillProblem[] = [];
    for (const folder of await this.folders()) {
      const read = await this.readFolder(folder);
      found.push(...read.found);
      problems.push(...read.problems);
    }
    found.push(...builtinSkills());
    return { ...mergeSkills(found), problems };
  }

  /** The skills in one skills folder (one level of skill folders) and the files that aren't. */
  private async readFolder(
    folder: SkillFolder,
  ): Promise<{ found: FoundSkill[]; problems: SkillProblem[] }> {
    const found: FoundSkill[] = [];
    const problems: SkillProblem[] = [];
    const entries = await fsIpc.listDir(folder.dir).catch(() => []);
    for (const e of entries.filter((x) => x.kind === "dir").slice(0, SKILLS_PER_FOLDER)) {
      const file = joinPath(e.path, "SKILL.md");
      if (folder.scope === "workspace" && agentIgnored(this.services, file)) continue;
      const text = await readText(file);
      if (text === null) continue;
      const parsed = parseSkillFile(text, e.name);
      if (!parsed.skill) {
        problems.push({
          scope: folder.scope,
          source: folder.label,
          file,
          error: parsed.error ?? "Not valid.",
        });
        continue;
      }
      found.push({
        ...parsed.skill,
        ...(folder.prefix && { name: `${folder.prefix}${parsed.skill.name}` }),
        scope: folder.scope,
        source: folder.label,
        dir: e.path,
        file,
        warnings: parsed.warnings,
      });
    }
    return { found, problems };
  }

  /** The skill called `name` (null when there's none): nested ones found so far too. */
  async find(name: string): Promise<FoundSkill | null> {
    return (await this.known()).find((x) => x.name === name) ?? null;
  }

  /** Where the agent sees a skill: workspace-relative in the folder, `~/…` for a user one. */
  shownPath(skill: FoundSkill): string {
    const { workspace } = this.services;
    if (workspace.root.peek() && workspace.contains(skill.file))
      return workspace.relative(skill.file);
    return `${skill.source}/${basename(skill.dir)}/SKILL.md`;
  }

  /** The files in a skill's folder (`/` separated, relative to it), a few levels deep. */
  async files(skill: FoundSkill): Promise<string[]> {
    const out: string[] = [];
    if (skill.builtin) return out;
    const walk = async (dir: string, rel: string, depth: number) => {
      const entries = await fsIpc.listDir(dir).catch(() => []);
      for (const e of entries) {
        if (out.length >= FILES_PER_SKILL) return;
        if (e.name.startsWith(".") || e.isSymlink) continue;
        if (skill.scope === "workspace" && agentIgnored(this.services, e.path, e.kind === "dir"))
          continue;
        if (e.kind === "dir") {
          if (depth < FILE_DEPTH && !e.ignored) await walk(e.path, `${rel}${e.name}/`, depth + 1);
        } else out.push(`${rel}${e.name}`);
      }
    };
    await walk(skill.dir, "", 1);
    return out;
  }

  /** How the agent reads a skill's other files. */
  readHint(skill: FoundSkill): string {
    const { workspace } = this.services;
    if (workspace.root.peek() && workspace.contains(skill.dir))
      return `with read_file ${workspace.relative(skill.dir)}/<file>`;
    return `with use_skill {"name": "${skill.name}", "file": "<file>"}`;
  }

  /** The prompt's skills section (a new chat): the ones the agent may pick by itself. */
  async promptSection(): Promise<string> {
    const { skills } = await this.all();
    // Skills for some files only (`paths`) come with the first tool result about one (D221).
    return renderSkillsPrompt(
      upFrontSkills(modelSkills(skills, disabledSkills(this.services))),
      (x) => this.shownPath(x),
    );
  }

  /** What agent.listSkills and ide://agent/skills show. */
  async listing(): Promise<{
    folders: { dir: string; label: string; scope: SkillScope; own: boolean }[];
    skills: {
      name: string;
      description: string;
      scope: SkillScope;
      source: string;
      path: string;
      enabled: boolean;
      modelInvocable: boolean;
      userInvocable: boolean;
      argumentHint?: string;
      allowedTools?: string[];
      paths?: string[];
      warnings?: string[];
      model?: string;
      effort?: string;
      fork?: boolean;
      agent?: string;
      nested?: string;
      builtIn?: boolean;
      preApproves?: boolean;
    }[];
    shadowed: { name: string; path: string; by: string }[];
    problems: SkillProblem[];
    watching: boolean;
  }> {
    const off = disabledSkills(this.services);
    const { shadowed, problems } = await this.all();
    const skills = await this.known();
    return {
      folders: (await this.folders()).map((f) => ({
        dir: f.dir,
        label: f.label,
        scope: f.scope,
        own: !!f.own,
      })),
      // The user folders are watched (D221); without that, they're read again after 30 s.
      watching: this.watching,
      skills: skills.map((x) => ({
        ...(x.model && { model: x.model }),
        ...(x.effort && { effort: x.effort }),
        ...(x.fork && { fork: true }),
        ...(x.agent && { agent: x.agent }),
        ...(x.nested !== undefined && { nested: x.nested }),
        ...(x.builtin && { builtIn: true }),
        // A user's own skill pre-approves its allowed-tools while it's active (D221).
        ...(x.allowedTools.length && { preApproves: x.scope === "user" }),
        name: x.name,
        description: x.description,
        scope: x.scope,
        source: x.source,
        path: x.file,
        enabled: !off.has(x.name),
        modelInvocable: !x.disableModelInvocation,
        userInvocable: x.userInvocable,
        ...(x.argumentHint && { argumentHint: x.argumentHint }),
        ...(x.allowedTools.length && { allowedTools: x.allowedTools }),
        ...(x.paths.length && { paths: x.paths }),
        ...(x.warnings.length && { warnings: x.warnings }),
      })),
      shadowed: shadowed.map((x) => ({
        name: x.name,
        path: x.file,
        by: skills.find((k) => k.name === x.name)?.file ?? "",
      })),
      problems,
    };
  }
}

const services_ = new WeakMap<WorkbenchServices, SkillsService>();

/** The agent's skills (registered on activation; a plain one before, for tests). */
export function skillsFor(services: WorkbenchServices): SkillsService {
  let skills = services_.get(services);
  if (!skills) {
    skills = new SkillsService(services);
    services_.set(services, skills);
  }
  return skills;
}

/** The use_skill tool: a skill's instructions and its folder's files, or one of those files. */
export function useSkillTool(skills: SkillsService, subagents?: SubagentRegistry): AgentTool {
  return {
    spec: {
      name: "use_skill",
      description:
        "Load a skill listed under Skills in your instructions (or offered with a tool result): returns its instructions (SKILL.md) and the files in its folder. Call it when a task matches a skill's description, then follow the instructions. A skill that runs in a subagent of its own does the work there and returns the report instead (pass `arguments` for it). With `file`, returns that file of the skill's folder (a path from the list).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The skill's name" },
          file: {
            type: "string",
            description: "A file in the skill's folder, relative to it (e.g. reference.md)",
          },
          arguments: {
            type: "string",
            description: "What the skill is to work on ($ARGUMENTS in its instructions)",
          },
        },
        required: ["name"],
      },
    },
    readOnly: true,
    verb: "Used skill",
    target: (a) => `${String(a.name ?? "")}${a.file ? ` · ${String(a.file)}` : ""}`,
    async run(args, host, itemId) {
      const name = typeof args.name === "string" ? args.name.trim().replace(/^\//, "") : "";
      const { services } = host;
      const all = await skills.known();
      const skill = all.find((x) => x.name === name);
      const off = disabledSkills(services);
      if (!skill || off.has(name)) {
        const names = modelSkills(all, off).map((x) => x.name);
        return {
          result: `Error: no skill named "${name}"${skill ? " (the user turned it off)" : ""}. Skills: ${names.join(", ") || "none"}.`,
          isError: true,
          summary: "not found",
        };
      }
      if (skill.disableModelInvocation)
        return {
          result: `Error: ${name} runs only when the user asks for it (/${name}).`,
          isError: true,
          summary: "user only",
        };
      const root = services.workspace.root.peek();
      // In one of the workspace's folders (D251): the read_file protections hold.
      const inFolder = !!root && services.workspace.contains(skill.dir);
      if (typeof args.file === "string" && args.file.trim()) {
        const rel = skillFileRel(args.file);
        if (!rel)
          return {
            result: `Error: ${args.file} isn't a file in the skill's folder.`,
            isError: true,
            summary: "outside",
          };
        const abs = rel.split("/").reduce((at, part) => joinPath(at, part), skill.dir);
        if (inFolder && root) {
          const shown = services.workspace.relative(abs);
          // The same protections as read_file: the agent's ignore rules and protected reads.
          if (agentIgnored(services, abs))
            return { result: ignoredMessage(shown), isError: true, summary: "excluded" };
          if (approveDecision(approveRules(services), "reads", shown) === "ask") {
            const answer = await host.ask({
              title: `Read ${shown}`,
              heading: "Read a protected file",
              code: shown,
              kind: "tool",
              detail: "agent.autoApprove says to ask before reading this file.",
              evenWithFullAccess: true,
            });
            if (answer === "deny")
              return { result: `The user denied reading ${shown}.`, summary: "denied" };
          }
        }
        const text = await readText(abs);
        if (text === null)
          return {
            result: `Error: ${rel} isn't in the skill's folder (or can't be read as text).`,
            isError: true,
            summary: "not found",
          };
        return {
          result: `${skill.name}/${rel}:\n${text}`,
          summary: `${text.split("\n").length} lines`,
        };
      }
      const files = await skills.files(skill);
      // A user's own skill pre-approves its allowed-tools while it's active (D221): for the rest
      // of this turn. A project's skill can't approve its own tools (a cloned repository's).
      if (skill.scope === "user" && skill.allowedTools.length)
        host.preApprove?.(skill.allowedTools);
      // Its `effort` holds for the rest of the turn (D229, Claude Code's); a forked one's is
      // its subagent's.
      if (skill.effort && !skill.fork) host.setTurnEffort?.(skill.effort);
      // Its `model` too, from the next request on (D232); a forked one's is its subagent's.
      if (skill.model && skill.model !== "inherit" && !skill.fork)
        host.setTurnModel?.(skill.model, `The ${skill.name} skill`);
      const argText = typeof args.arguments === "string" ? args.arguments.trim() : "";
      if (skill.fork) return runForked(skill, argText, files, skills, subagents, host, itemId);
      return {
        result: `${renderSkillForAgent(skill, files, skills.readHint(skill))}${argText ? `\n\nArguments: ${argText}` : ""}`,
        summary: `${skill.name}${files.length > 1 ? ` · ${files.length - 1} files` : ""}`,
        detail: skill.description,
      };
    },
  };
}

/**
 * A skill with `context: fork` (D221, Claude Code's): its instructions are a subagent's task (its
 * `agent`, default general; its `model`, else the subagent's), and only the report comes back.
 */
async function runForked(
  skill: FoundSkill,
  args: string,
  files: readonly string[],
  skills: SkillsService,
  subagents: SubagentRegistry | undefined,
  host: Parameters<AgentTool["run"]>[1],
  itemId: string,
): Promise<ToolOutcome> {
  const { services } = host;
  const def = subagents?.subagent(skill.agent ?? "general") ?? subagents?.subagent("general");
  if (!def || !host.subagent)
    return {
      result: `Error: ${skill.name} runs in a subagent, and subagents aren't available here.`,
      isError: true,
      summary: "no subagent",
    };
  const rules = rulesFor(services);
  const system = `${subagentSystem(def)}${rules.subagentSection(def, await rules.rules())}`;
  const model =
    skill.model && skill.model !== "inherit" ? skill.model : subagentModel(services, def);
  const looked: string[] = [];
  const report = await host.subagent({
    system,
    task: renderForkedSkillTask(skill, args, files, skills.readHint(skill)),
    title: `Skill ${skill.name}`,
    agentName: def.name,
    tools: subagentTools(def, host.toolNames?.() ?? [], false),
    maxSteps: def.maxSteps ?? 30,
    model,
    ruleNeeds: def,
    progress: (line) => {
      looked.push(line);
      host.output(itemId, `${line}\n`);
    },
  });
  const text = report.trim()
    ? report.trim().slice(0, 12_000)
    : `It wrote no report. It ran: ${looked.slice(-15).join("; ") || "nothing"}.`;
  return {
    result: `Skill ${skill.name} ran in a subagent (${def.name}). Its report:\n\n${text}`,
    summary: `${skill.name} · ${def.name} · ${looked.length} step${looked.length === 1 ? "" : "s"}`,
    detail: text,
  };
}

/**
 * The user skills folders' watcher (D221): any change in them reads the skills again. A folder
 * that doesn't exist yet can't be watched; on focus the folders are looked at again, and one
 * that appeared (or went) reads the skills again too. Without a watcher (it couldn't start) the
 * list is read again after 30 s, as before.
 */
function registerSkillsWatch(
  sub: DisposableStore,
  services: WorkbenchServices,
  skills: SkillsService,
): void {
  let disposed = false;
  let watcher: Disposable | null = null;
  let present = "";
  const userDirs = async () =>
    (await skills.folders()).filter((f) => f.scope === "user").map((f) => f.dir);
  const refresh = async () => {
    if (disposed || !watcher) return;
    const dirs = await userDirs();
    const exists = await Promise.all(
      dirs.map((d) =>
        fsIpc
          .stat(d)
          .then(() => true)
          .catch(() => false),
      ),
    );
    const now = dirs.filter((_, i) => exists[i]).join("\n");
    await skillsIpc.setWatched(dirs).catch(() => {});
    // A folder appeared or went: what was read before it can't have been seen.
    if (now !== present) {
      present = now;
      skills.invalidate();
    }
  };
  void skillsIpc
    .watch((batch) => {
      if (batch.paths.length) skills.invalidate();
    })
    .then((d) => {
      if (disposed) {
        d.dispose();
        return;
      }
      watcher = d;
      skills.watching = true;
      void refresh();
    })
    .catch(() => {
      skills.watching = false;
    });
  sub.add(on(window, "focus", () => void refresh()));
  // Read again (a skill made, a setting changed): a user folder the IDE just made is watched.
  sub.add(
    effect(() => {
      skills.version.value;
      void untracked(() => refresh());
      return undefined;
    }),
  );
  // Other tools' folders turned on or off (agent.thirdPartyConfigs): the watched set follows.
  let last = services.settings.peek<boolean>("agent.thirdPartyConfigs");
  sub.add(
    services.settings.model.onDidChange((keys) => {
      if (!keys.includes("agent.thirdPartyConfigs")) return;
      const next = services.settings.peek<boolean>("agent.thirdPartyConfigs");
      if (next === last) return;
      last = next;
      void refresh();
    }),
  );
  sub.add({
    dispose: () => {
      disposed = true;
      skills.watching = false;
      watcher?.dispose();
      void skillsIpc.setWatched([]).catch(() => {});
    },
  });
}

export function registerSkills(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
  subagents?: SubagentRegistry,
): SkillsService {
  const skills = skillsFor(services);
  const { events, dispatcher, state, workspace, settings } = services;
  sub.add(workspace.onDidOpen(() => skills.invalidate()));
  sub.add(workspace.onDidClose(() => skills.invalidate()));
  sub.add(workspace.onDidChangeFolders(() => skills.invalidate()));
  // The user skills folders are watched with what's in them (D221), instead of being read again
  // every 30 s: a skill installed, edited or removed elsewhere shows at once.
  registerSkillsWatch(sub, services, skills);
  // Skills for a file the agent reads or edits (`paths`, nested folders) come with the result.
  const previousNote = sessions.fileNote;
  sessions.fileNote = async (session, path) =>
    `${await previousNote(session, path)}${await skills.noteFor(path, session.toldSkills, session.turn)}`;
  for (const name of [
    "files.didSave",
    "files.didCreate",
    "files.didDelete",
    "files.didChange",
  ] as const)
    sub.add(
      events.on(name, (e) => {
        if (SkillsService.isSkillPath(e.path)) skills.invalidate();
      }),
    );
  sub.add(
    events.on("files.didRename", (e) => {
      if (SkillsService.isSkillPath(e.from) || SkillsService.isSkillPath(e.to)) skills.invalidate();
    }),
  );
  // Turning one off or other tools' folders on or off: the page and the listing follow.
  let off = JSON.stringify([...disabledSkills(services)]);
  let others = settings.peek<boolean>("agent.thirdPartyConfigs");
  sub.add(
    effect(() => {
      settings.version.value;
      const nextOff = JSON.stringify([...disabledSkills(services)]);
      const nextOthers = settings.peek<boolean>("agent.thirdPartyConfigs");
      if (nextOff === off && nextOthers === others) return;
      off = nextOff;
      others = nextOthers;
      skills.invalidate();
      return undefined;
    }),
  );

  // The tool joins the others (the MCP servers', the subagents', web_search).
  const tool = useSkillTool(skills, subagents);
  const previous = sessions.extraTools;
  sessions.extraTools = (session) => [...previous(session), tool];

  // `/name args` runs a skill (unless a command file of that name comes first, slashCommands.ts).
  sub.add(
    registerSlashSource({
      list: async () => {
        const off = disabledSkills(services);
        return (await skills.known())
          .filter((x) => x.userInvocable && !off.has(x.name))
          .map((x) => ({
            name: x.name,
            description: x.description.slice(0, 100),
            source: `skill · ${x.source}`,
            ...(x.argumentHint && { argumentHint: x.argumentHint }),
          }));
      },
      expand: async (name, args, session) => {
        const skill = await skills.find(name);
        if (!skill?.userInvocable || disabledSkills(services).has(name)) return null;
        // A forked skill runs through use_skill (D221): its model goes to its subagent.
        if (skill.fork) return renderForkInvocation(skill, args);
        // Its model, effort and (a user's own skill) pre-approved tools hold for this turn (D221).
        if (skill.model && skill.model !== "inherit") session.nextTurnModel = skill.model;
        if (skill.effort) session.nextTurnEffort = skill.effort;
        if (skill.scope === "user" && skill.allowedTools.length)
          session.nextTurnTools = mergeTurnTools(session.nextTurnTools, {
            preApproved: skill.allowedTools,
          });
        return renderSkillInvocation(
          skill,
          args,
          await skills.files(skill),
          skills.readHint(skill),
        );
      },
    }),
  );

  sub.add(
    state.register("ide://agent/skills", {
      description:
        "The agent's skills (D206): the folders looked in, each skill (name, description, user or workspace, path, whether it's turned off, whether the agent or only the user may run it), skills hidden by another of the same name, and SKILL.md files that couldn't be used and why.",
      get: () => skills.listing(),
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.listSkills",
      title: "Show agent skills",
      category: "Agent",
      description:
        "Lists the agent's skills: folders with a SKILL.md in ~/" +
        `${product.dataFolderName}/skills, ~/.claude/skills, ~/.cursor/skills, ~/.agents/skills (the user's) and <workspace folder>/skills, .claude/skills, .cursor/skills, .agents/skills (this folder's, which override the user's of the same name). The agent loads one with use_skill when a task matches its description; the user runs one as /name. When a person runs it, picking one opens its SKILL.md.`,
      input: s.object({
        pick: s
          .boolean()
          .describe("Show a list to open one (default when a person runs it)")
          .optional(),
      }),
      effects: ["read"],
      agent: "hidden",
      run: async ({ pick }, ctx) => {
        skills.invalidate();
        const list = await skills.listing();
        if (pick === false || ctx.caller.kind !== "user") return list;
        const chosen = await services.quickInput.pick(
          list.skills.map((x) => ({
            id: x.path,
            label: x.name,
            description: `${x.enabled ? "" : "off · "}${x.source}`,
            detail: x.description,
            icon: "zap" as const,
          })),
          {
            placeholder: list.skills.length
              ? "Agent skills (pick one to open it)"
              : "No skills yet: add one in Customize → Skills",
          },
        );
        if (chosen) await ctx.execute("editor.openFile", { path: chosen.id });
        return { ...list, opened: chosen?.id ?? null };
      },
    }),
  );
  registerSkillsPage(sub, services, skills);
  return skills;
}

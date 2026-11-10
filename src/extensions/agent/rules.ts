// The project's rules for the agent (D200; the model in core/agent/rules.ts): finds every rules
// file in the folder and the user's own, keeps them until one changes, puts the always-on ones in
// a new chat's prompt and attaches the others to a tool result when the agent reads or edits a
// file they cover. `agent.listRules` and `ide://agent/rules` say which rules are active and why.
// D251: a multi-root workspace's every folder has its rules. The first folder's are named as
// before ("AGENTS.md"); another folder's carry its name ("api/AGENTS.md", core ruleInFolder) and
// cover only its files. A file gets the nested rules of the folder that holds it.

import {
  renderSubagentRules,
  ruleScope,
  rulesForSubagent,
  type SubagentRuleNeeds,
  subagentRulesForFile,
} from "../../core/agent/ruleEditing";
import {
  classifyRule,
  expandImports,
  type LoadedRule,
  nestedRuleFiles,
  ROOT_RULE_FILES,
  renderAttachedRules,
  renderRulesPrompt,
  ruleInFolder,
  ruleReason,
  rulesForFile,
} from "../../core/agent/rules";
import { fsIpc, indexIpc } from "../../core/ipc/fs";
import { appIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import {
  dirname,
  isWithin,
  joinPath,
  relativePath,
  resolveInRoot,
  samePath,
} from "../../core/paths/index";
import { s } from "../../core/schema/index";
import type { WorkspaceFolder } from "../../core/workspace/workspaceFile";
import type { WorkbenchServices } from "../../workbench/services";
import { agentIgnored } from "./ignore";
import { cleanPathArg } from "./pathArg";
import { inDownloads, projectInstructionsBlocked } from "./riskyGuard";
import type { SessionManager } from "./sessions";

const READ_LIMIT = 40_000;
/** Subfolder rules files looked up in the index (the nearest first). */
const NESTED_LIMIT = 60;
/** The rules are read again after this, even without a change event (files edited elsewhere). */
const STALE_MS = 30_000;
const RULE_FILE =
  /(?:^|[\\/])(?:AGENTS\.md|CLAUDE(?:\.local)?\.md|\.cursorrules|[^\\/]+\.mdc|[^\\/]+\.instructions\.md|copilot-instructions\.md|\.cursor[\\/]rules[\\/].+\.md|\.claude[\\/]rules[\\/].+\.md)$/i;

export interface ActiveRule extends LoadedRule {
  /** Absolute path. */
  abs: string;
  /** Files it imports (`@path`, CLAUDE.md). */
  imported: string[];
  /** Turned off on the Rules page (`agent.rules.disabled`, D204): not given to any agent. */
  disabled?: boolean;
  /** The workspace folder it belongs to (D251); none for the user's own. */
  root?: string;
}

/** The rules turned off (`agent.rules.disabled`: workspace-relative paths, or a user file's). */
export function disabledRules(services: WorkbenchServices): Set<string> {
  const list = services.settings.peek<unknown>("agent.rules.disabled");
  return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
}

async function readText(path: string): Promise<string | null> {
  try {
    const text = new TextDecoder().decode(await fsIpc.read(path)).replace(/^﻿/, "");
    return text.length > READ_LIMIT ? text.slice(0, READ_LIMIT) : text;
  } catch {
    return null;
  }
}

export class RulesService {
  private cache: { key: string; at: number; rules: Promise<ActiveRule[]> } | null = null;
  private home: string | null | undefined;
  /** The rules as last read, for what needs them without waiting (the automatic review). */
  private last: ActiveRule[] = [];

  constructor(private readonly services: WorkbenchServices) {}

  /** A rules file changed (or the folder did): read them again next time. */
  invalidate(): void {
    this.cache = null;
  }

  /** Whether `path` (absolute or relative) may be a rules file: its change invalidates. */
  static isRuleFile(path: string): boolean {
    return RULE_FILE.test(path);
  }

  private others(): boolean {
    return this.services.settings.peek<boolean>("agent.thirdPartyConfigs") !== false;
  }

  /** The user's own rules: the IDE's `<config>/AGENTS.md`, and Claude Code's `~/.claude/CLAUDE.md`. */
  async userFiles(): Promise<string[]> {
    const out: string[] = [];
    const settings = this.services.settings.filePath("user");
    if (settings) out.push(joinPath(dirname(settings), "AGENTS.md"));
    if (this.others()) {
      if (this.home === undefined)
        this.home = (await appIpc.info().catch(() => null))?.homeDir ?? null;
      if (this.home) out.push(joinPath(joinPath(this.home, ".claude"), "CLAUDE.md"));
    }
    return out;
  }

  /** Every rules file the agent follows (the ones turned off left out). */
  async rules(): Promise<ActiveRule[]> {
    return (await this.all()).filter((r) => !r.disabled);
  }

  /** The rules as last read (empty before the first read), without the ones turned off. */
  peek(): ActiveRule[] {
    return this.last.filter((r) => !r.disabled);
  }

  /** Every rules file, classified, the ones turned off marked (cached until one changes). */
  all(): Promise<ActiveRule[]> {
    const root = this.services.workspace.root.peek();
    const off = disabledRules(this.services);
    // D213: none of a folder's own rules in restricted mode or a risky folder (Downloads…); D251:
    // each folder of a multi-root workspace is judged on its own.
    const blocked = projectInstructionsBlocked(this.services);
    const folders = this.folders().filter(
      (f, i) => !(i === 0 ? blocked : projectInstructionsBlocked(this.services, f.path)),
    );
    const key = `${root}\0${this.others()}\0${[...off].join("\0")}\0${blocked ?? ""}\0${this.services.trust.risky.version.peek()}\0${folders.map((f) => `${f.path}\u0001${f.name}`).join("\0")}`;
    if (this.cache && this.cache.key === key && Date.now() - this.cache.at < STALE_MS)
      return this.cache.rules;
    const rules = this.load(folders)
      .then((list) => list.map((r) => (off.has(r.path) ? { ...r, disabled: true } : r)))
      .catch(() => []);
    void rules.then((list) => {
      if (this.cache?.rules === rules) this.last = list;
    });
    this.cache = { key, at: Date.now(), rules };
    return rules;
  }

  /** The workspace's folders (the first alone before the list is known; none with nothing open). */
  private folders(): readonly WorkspaceFolder[] {
    const { workspace } = this.services;
    const root = workspace.root.peek();
    if (!root) return [];
    const list = workspace.folders.peek();
    return list.length ? list : [{ path: root, name: root, index: 0 }];
  }

  /**
   * The folder whose rules `abs` gets and the path its rules are matched with: relative to the
   * first folder (as always), or the workspace's path for another folder ("api/src/x.ts").
   */
  private ruleTarget(path: string): { root: string; rel: string; shown: string } | null {
    const { workspace } = this.services;
    const root = workspace.root.peek();
    if (!root) return null;
    const abs = workspace.resolve(cleanPathArg(path));
    const owner =
      workspace.folderOf(abs) ??
      (isWithin(root, abs) ? { path: root, name: root, index: 0 } : undefined);
    if (!owner) return null;
    const inner = relativePath(owner.path, abs);
    const first = samePath(owner.path, root);
    return {
      root: owner.path,
      rel: first ? inner : `${owner.name}/${inner}`,
      shown: first ? inner : workspace.relative(abs),
    };
  }

  /** The rules files of one workspace folder (folder-relative), the index's hits for it given. */
  private async folderFiles(
    root: string,
    others: boolean,
    hits: { rule: string[]; named: Map<string, string[]> },
  ): Promise<{ rel: string; abs: string }[]> {
    const found: { rel: string; abs: string }[] = [];
    for (const rel of others ? ROOT_RULE_FILES : ROOT_RULE_FILES.slice(0, 1))
      found.push({ rel, abs: resolveInRoot(root, rel) });
    if (others)
      for (const dir of [".cursor/rules", ".github/instructions", ".claude/rules"]) {
        const entries = await fsIpc.listDir(resolveInRoot(root, dir)).catch(() => []);
        for (const e of entries.slice(0, 60))
          if (e.kind === "file" && /\.(mdc|md)$/i.test(e.name))
            found.push({ rel: `${dir}/${e.name}`, abs: e.path });
      }
    // A subfolder's .cursor/rules, and subfolders of the two folders above (D203): from the
    // index, which skips ignored folders; the agent's own ignore rules (.aiignore) hold too.
    if (others)
      for (const rel of nestedRuleFiles(hits.rule, NESTED_LIMIT)) {
        const abs = resolveInRoot(root, rel);
        if (!agentIgnored(this.services, abs)) found.push({ rel, abs });
      }
    // Subfolders' AGENTS.md (and CLAUDE.md): from the index, which skips ignored folders.
    for (const name of others ? ["AGENTS.md", "CLAUDE.md"] : ["AGENTS.md"]) {
      const nested = (hits.named.get(name) ?? [])
        .filter((p) => p.includes("/") && p.slice(p.lastIndexOf("/") + 1) === name)
        .sort((a, b) => a.split("/").length - b.split("/").length)
        .slice(0, NESTED_LIMIT);
      for (const rel of nested) found.push({ rel, abs: resolveInRoot(root, rel) });
    }
    return found;
  }

  private async load(folders: readonly WorkspaceFolder[]): Promise<ActiveRule[]> {
    const others = this.others();
    const found: { rel: string; abs: string; user?: boolean; root?: string; name?: string }[] = [];
    for (const abs of await this.userFiles()) found.push({ rel: abs, abs, user: true });
    const primary = this.services.workspace.root.peek();
    if (folders.length && primary) {
      // The index's hits, each in its folder (the index names the folder of those outside the
      // first one), folder-relative.
      const byFolder = new Map<string, { rule: string[]; named: Map<string, string[]> }>();
      const of = (root: string) => {
        let entry = byFolder.get(root);
        if (!entry) {
          entry = { rule: [], named: new Map() };
          byFolder.set(root, entry);
        }
        return entry;
      };
      if (others)
        for (const query of [
          ".cursor/rules/",
          ".github/instructions/ .instructions.md",
          ".claude/rules/",
        ]) {
          const result = await indexIpc.query(query, 400).catch(() => null);
          for (const item of result?.items ?? []) of(item.root ?? primary).rule.push(item.path);
        }
      for (const name of others ? ["AGENTS.md", "CLAUDE.md"] : ["AGENTS.md"]) {
        const result = await indexIpc.query(name, 200).catch(() => null);
        for (const item of result?.items ?? []) {
          const named = of(item.root ?? primary).named;
          named.set(name, [...(named.get(name) ?? []), item.path]);
        }
      }
      const several = this.services.workspace.folders.peek().length > 1;
      for (const f of folders) {
        const hits = [...byFolder.entries()].find(([root]) => samePath(root, f.path))?.[1] ?? {
          rule: [],
          named: new Map(),
        };
        const first = samePath(f.path, primary);
        for (const file of await this.folderFiles(f.path, others, hits))
          found.push({ ...file, root: f.path, ...(several && !first && { name: f.name }) });
      }
    }
    const out: ActiveRule[] = [];
    const seen = new Set<string>();
    for (const f of found) {
      if (seen.has(f.abs)) continue;
      // A rules file in a Downloads folder inside the open one (the home folder) isn't loaded.
      if (!f.user && inDownloads(this.services, f.abs)) continue;
      seen.add(f.abs);
      const text = await readText(f.abs);
      if (text === null || !text.trim()) continue;
      const classified = classifyRule({ path: f.rel, text, ...(f.user && { user: true }) });
      if (!classified) continue;
      // Another folder's rule, named and scoped with the folder (D251).
      const rule = f.name ? ruleInFolder(classified, f.name) : classified;
      let body = rule.body;
      let imported: string[] = [];
      // CLAUDE.md's `@path` imports, relative to the file (`~/` the home folder, for the user's).
      if (/CLAUDE(\.local)?\.md$/.test(f.rel)) {
        const home = this.home ?? null;
        const expanded = await expandImports(
          body,
          f.abs,
          {
            resolve: (ref, from) => {
              // `~/` only from the user's own CLAUDE.md: a project's could pull the user's config
              // files (mcp.json with tokens, settings, memory) into every chat's prompt.
              if (ref.startsWith("~/"))
                return f.user && home ? resolveInRoot(home, ref.slice(2)) : null;
              const path = resolveInRoot(dirname(from), ref);
              // Only files in the workspace's folders (or the home folder for a user file): fs
              // refuses others.
              return folders.some((w) => isWithin(w.path, path)) ? path : f.user ? path : null;
            },
            read: readText,
          },
          // A rules file it imports (CLAUDE.md's usual "@AGENTS.md") is shown once, as itself.
          new Set([f.abs, ...found.map((x) => x.abs)]),
        );
        body = expanded.text;
        imported = expanded.imported;
      }
      out.push({ ...rule, text: body, abs: f.abs, imported, ...(f.root && { root: f.root }) });
    }
    return out;
  }

  /** The prompt's rules section (a new chat; D112 keeps it for the chat). */
  async promptSection(): Promise<string> {
    return renderRulesPrompt(await this.rules());
  }

  /**
   * The rules to attach to a tool result for `path` (read_file, edit_file, write_file) that this
   * chat hasn't had yet; `attached` records them (rule path → turn).
   */
  async forFile(path: string, attached: Map<string, number>, turn: number): Promise<string> {
    const target = this.ruleTarget(path);
    if (!target) return "";
    const abs = this.services.workspace.resolve(cleanPathArg(path));
    // Reading a rules file itself doesn't attach it a second time.
    const fresh = rulesForFile(this.ofFolder(await this.rules(), target.root), target.rel).filter(
      (r) => !attached.has(r.path) && !samePath(r.abs, abs),
    );
    for (const r of fresh) attached.set(r.path, turn);
    return renderAttachedRules(fresh, target.shown);
  }

  /** The rules a file in workspace folder `root` may get: that folder's and the user's own. */
  private ofFolder(rules: ActiveRule[], root: string): ActiveRule[] {
    return rules.filter((r) => !r.root || samePath(r.root, root));
  }

  /**
   * The same for a subagent's read or edit (D207): the folder and matching-files rules it may
   * get (subagentRulesForFile) that its prompt and this run haven't had; `attached` is the run's
   * own (rule paths).
   */
  async forSubagentFile(
    path: string,
    def: SubagentRuleNeeds,
    attached: Set<string>,
  ): Promise<string> {
    const target = this.ruleTarget(path);
    if (!target) return "";
    const abs = this.services.workspace.resolve(cleanPathArg(path));
    const rules = await this.rules();
    const fresh = subagentRulesForFile(
      rulesForFile(this.ofFolder(rules, target.root), target.rel),
      rulesForSubagent(rules, def),
      def,
    ).filter((r) => !attached.has(r.path) && !samePath(r.abs, abs));
    for (const r of fresh) attached.add(r.path);
    return renderAttachedRules(fresh, target.shown);
  }

  /** What `agent.listRules` and `ide://agent/rules` show (the ones turned off too, marked). */
  async listing(attached?: ReadonlyMap<string, number>): Promise<
    {
      path: string;
      source: string;
      activation: string;
      scope: string;
      why: string;
      enabled: boolean;
      globs?: string[];
      folder?: string;
      description?: string;
      subagents?: string[];
      chars: number;
      imported?: string[];
      attachedInTurn?: number;
    }[]
  > {
    return (await this.all()).map((r) => ({
      path: r.path,
      source: r.source,
      activation: r.activation,
      scope: ruleScope(r),
      why: r.disabled ? "Turned off" : ruleReason(r),
      enabled: !r.disabled,
      ...(r.globs.length && { globs: r.globs }),
      ...(r.folder && { folder: r.folder }),
      ...(r.description && { description: r.description }),
      ...(r.subagents && { subagents: r.subagents }),
      chars: r.text.length,
      ...(r.imported.length && { imported: r.imported }),
      ...(attached?.has(r.path) && { attachedInTurn: attached.get(r.path) }),
    }));
  }

  /** A subagent's rules section (D204): see core/agent/ruleEditing.ts rulesForSubagent. */
  subagentSection(def: SubagentRuleNeeds, rules: readonly ActiveRule[] = this.peek()): string {
    return renderSubagentRules(rulesForSubagent(rules, def));
  }

  /** The rules a subagent gets, as last read. */
  subagentRules(def: SubagentRuleNeeds): ActiveRule[] {
    return rulesForSubagent(this.peek(), def);
  }

  /** Every rule in full, for an @rules mention. */
  async mentionText(): Promise<string> {
    const rules = await this.rules();
    if (!rules.length)
      return "Rules: this project has no rules files (AGENTS.md, CLAUDE.md, .cursor/rules, …).";
    return `The project's rules files (${rules.length}):\n\n${rules
      .map(
        (r) =>
          `--- ${r.path} (${ruleReason(r).toLowerCase()}) ---\n${r.text.trim().slice(0, 8000)}`,
      )
      .join("\n\n")}`;
  }
}

const services_ = new WeakMap<WorkbenchServices, RulesService>();

/** The agent's rules (registered on activation; a plain one before, for tests). */
export function rulesFor(services: WorkbenchServices): RulesService {
  let rules = services_.get(services);
  if (!rules) {
    rules = new RulesService(services);
    services_.set(services, rules);
  }
  return rules;
}

export function registerRules(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
): RulesService {
  const rules = rulesFor(services);
  const { events, dispatcher, state, workspace } = services;
  sub.add(workspace.onDidOpen(() => rules.invalidate()));
  sub.add(workspace.onDidClose(() => rules.invalidate()));
  sub.add(workspace.onDidChangeFolders(() => rules.invalidate()));
  for (const name of [
    "files.didSave",
    "files.didCreate",
    "files.didDelete",
    "files.didChange",
  ] as const)
    sub.add(
      events.on(name, (e) => {
        if (RulesService.isRuleFile(e.path)) rules.invalidate();
      }),
    );
  sub.add(
    events.on("files.didRename", (e) => {
      if (RulesService.isRuleFile(e.from) || RulesService.isRuleFile(e.to)) rules.invalidate();
    }),
  );
  // agent.thirdPartyConfigs is part of the cache's key: switching it reads the files again.
  sub.add(
    state.register("ide://agent/rules", {
      description:
        "The agent's rules files (D200): each one's path, kind, when it applies (always, for a folder, for matching files, when the agent finds it relevant, only when mentioned) and why, with what the active chat has had attached so far; `projectBlocked`: why the folder's own rules aren't loaded (restricted mode or a risky folder like Downloads, D213), else null.",
      get: async () => {
        const session = sessions.find(undefined);
        return {
          userFiles: await rules.userFiles(),
          rules: await rules.listing(session?.attachedRules),
          // D213: why the folder's own rules aren't loaded (restricted mode, a risky folder).
          projectBlocked: projectInstructionsBlocked(services),
        };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.listRules",
      title: "Show agent rules",
      category: "Agent",
      description:
        "Lists the rules files the agent follows and why each is active: always (AGENTS.md, CLAUDE.md, .cursorrules, .github/copilot-instructions.md, .cursor/rules marked alwaysApply, the user's own <config>/AGENTS.md), for a subfolder (its AGENTS.md), for matching files (.mdc globs, .instructions.md applyTo), or by description. When a person runs it, picking one opens it.",
      input: s.object({
        session: s
          .string()
          .describe("Show what this chat has had attached (default: the active one)")
          .optional(),
        pick: s
          .boolean()
          .describe("Show a list to open one (default when a person runs it)")
          .optional(),
      }),
      effects: ["read"],
      run: async ({ session, pick }, ctx) => {
        rules.invalidate();
        const list = await rules.listing(sessions.find(session)?.attachedRules);
        if (pick === false || ctx.caller.kind !== "user") return { rules: list };
        const chosen = await services.quickInput.pick(
          list.map((r) => ({
            id: r.path,
            label: r.path,
            description: `${r.why}${r.attachedInTurn ? " · attached in this chat" : ""}`,
          })),
          {
            placeholder: list.length
              ? "Rules the agent follows (pick one to open it)"
              : "No rules files: add an AGENTS.md at the folder's root",
          },
        );
        const rule = chosen && (await rules.rules()).find((r) => r.path === chosen.id);
        if (rule) await ctx.execute("editor.openFile", { path: rule.abs });
        return { rules: list, opened: rule?.abs ?? null };
      },
    }),
  );
  return rules;
}

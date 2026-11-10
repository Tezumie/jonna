// Claude Code plugins (D358). The user adds a marketplace (a local folder, a git URL or GitHub's
// owner/repo: copied or cloned with their git into <data>/plugins/marketplaces), sees
// its plugins, and installs one (its own copy in plugins/cache/<marketplace>/<plugin>); an
// installed plugin's slash commands (`/<plugin>:<command>`), skills (`<plugin>:<skill>`),
// subagents, hooks and MCP servers then count where the IDE's own do, labeled "plugin <name>",
// with `${CLAUDE_PLUGIN_ROOT}` resolved (pluginContributions.ts is what those places read).
// Installing asks, as Claude Code does, and says what the plugin brings; its hooks and MCP
// servers run only if the user ticks them there (they're shown with what they run). Enabled,
// disabled or uninstalled at any time. The formats are DOM-free in core/agent/plugins.ts; Rust
// (ipc/plugins.rs) copies, clones and removes inside the plugins folder only.
// Commands: agent.showPlugins, agent.addPluginMarketplace, agent.updatePluginMarketplace,
// agent.removePluginMarketplace, agent.listPlugins, agent.installPlugin, agent.uninstallPlugin,
// agent.setPluginEnabled; `/plugin …` in the chat; state ide://agent/plugins.
// D375: what Claude Code installed (`~/.claude/plugins/installed_plugins.json`, on in its
// `enabledPlugins`) is used in place, never installed twice; its marketplaces are listed without
// a second copy; npm sources install with the user's npm; a plugin's output styles count, and its
// language servers start when the user lets them (like its hooks and MCP servers).

import {
  type ClaudeInstalledPlugin,
  claudeEnabled,
  describeMcpEntry,
  findInstalled,
  hookCommandsOf,
  hooksTableOf,
  type InstalledPlugin,
  type KnownMarketplace,
  lspServersOf,
  type Marketplace,
  type MarketplacePlugin,
  type MarketplaceSource,
  manifestFrom,
  mcpServersOf,
  npmSpec,
  type PluginLspServer,
  type PluginManifest,
  type PluginsFile,
  parseClaudeInstalled,
  parseClaudeMarketplaces,
  parseMarketplace,
  parseMarketplaceInput,
  parsePluginManifest,
  parsePluginRef,
  parsePluginsFile,
  pluginId,
  pluginParts,
  substitutePluginRoot,
  validName,
} from "../../core/agent/plugins";
import type { Caller } from "../../core/dispatcher/types";
import { pluginsIpc } from "../../core/ipc/agentIntegrations";
import { fsIpc } from "../../core/ipc/fs";
import { appIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { basename, isAbsolute, joinPath, resolveInRoot } from "../../core/paths/index";
import { signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { parseJsonc } from "../../core/settings/jsonc";
import { confirmAction, confirmWithOptions } from "../../ui/Dialog";
import type { WorkbenchServices } from "../../workbench/services";
import type { McpClients } from "./mcp";
import { type ActivePlugin, activePlugins, pluginLabel } from "./pluginContributions";
import { skillsFor } from "./skills";
import { actionSlash } from "./slashCommands";
import type { SubagentRegistry } from "./subagents";

const RECORD = "plugins.json";

async function readText(path: string): Promise<string | null> {
  try {
    return new TextDecoder().decode(await fsIpc.read(path)).replace(/^﻿/, "");
  } catch {
    return null;
  }
}

async function readJson(path: string): Promise<unknown> {
  const text = await readText(path);
  if (text === null) return undefined;
  const parsed = parseJsonc(text);
  return parsed.ok ? parsed.value : undefined;
}

/** A relative `/` path inside `dir`. */
function inside(dir: string, rel: string): string {
  return rel.split("/").reduce((at, part) => joinPath(at, part), dir);
}

/** What a plugin brings, for the install question and the page. */
export interface PluginContents {
  commands: string[];
  agents: string[];
  skills: string[];
  hooks: string[];
  mcpServers: string[];
  outputStyles: string[];
  lspServers: string[];
}

/** A plugin's parts read from its folder (`${CLAUDE_PLUGIN_ROOT}` resolved). */
interface ReadPlugin {
  manifest: PluginManifest;
  commandDirs: string[];
  agentDirs: string[];
  skillDirs: string[];
  hooks: unknown;
  mcpServers: Record<string, unknown> | null;
  outputStyleDirs: string[];
  lspServers: PluginLspServer[];
  contents: PluginContents;
}

async function listNames(dir: string, pick: (e: { name: string; kind: string }) => string | null) {
  const entries = await fsIpc.listDir(dir).catch(() => []);
  return entries.map((e) => pick(e)).filter((n): n is string => !!n);
}

/** Reads a plugin's folder: its manifest (`fallback` without plugin.json), parts and contents. */
const md = (e: { name: string; kind: string }) =>
  e.kind === "file" && e.name.endsWith(".md") ? e.name.slice(0, -3) : null;

async function readPlugin(
  dir: string,
  fallback?: Record<string, unknown>,
  folderName = basename(dir),
): Promise<ReadPlugin | { error: string }> {
  const text = await readText(joinPath(joinPath(dir, ".claude-plugin"), "plugin.json"));
  const parsed =
    text !== null
      ? parsePluginManifest(text, folderName)
      : fallback
        ? manifestFrom(fallback, folderName)
        : { error: "It has no .claude-plugin/plugin.json." };
  if ("error" in parsed) return parsed;
  const manifest = parsed.manifest;
  const parts = pluginParts(manifest);
  const commandDirs = parts.commands.map((p) => inside(dir, p));
  const agentDirs = parts.agents.map((p) => inside(dir, p));
  const skillDirs = parts.skills.map((p) => inside(dir, p));
  const hooksRaw =
    parts.inlineHooks ?? (parts.hooksFile ? await readJson(inside(dir, parts.hooksFile)) : null);
  const hooksTable = hooksRaw ? substitutePluginRoot(hooksTableOf(hooksRaw), dir) : null;
  const mcpRaw =
    parts.inlineMcp ?? (parts.mcpFile ? await readJson(inside(dir, parts.mcpFile)) : null);
  const servers = mcpRaw ? substitutePluginRoot(mcpServersOf(mcpRaw), dir) : {};
  const lspRaw =
    parts.inlineLsp ?? (parts.lspFile ? await readJson(inside(dir, parts.lspFile)) : null);
  const lspServers = lspRaw ? lspServersOf(substitutePluginRoot(lspRaw, dir)) : [];
  const outputStyleDirs = parts.outputStyles.map((p) => inside(dir, p));
  const styles: string[] = [];
  for (const d of outputStyleDirs) styles.push(...(await listNames(d, md)));
  const commands: string[] = [];
  for (const d of commandDirs) commands.push(...(await listNames(d, md)));
  const agents: string[] = [];
  for (const d of agentDirs) agents.push(...(await listNames(d, md)));
  const skills: string[] = [];
  for (const d of skillDirs)
    skills.push(...(await listNames(d, (e) => (e.kind === "dir" ? e.name : null))));
  const hookCommands = hookCommandsOf(hooksTable);
  return {
    manifest,
    commandDirs,
    agentDirs,
    skillDirs,
    hooks: hookCommands.length ? hooksTable : null,
    mcpServers: Object.keys(servers).length ? servers : null,
    outputStyleDirs,
    lspServers,
    contents: {
      commands: commands.map((c) => `/${manifest.name}:${c}`),
      agents,
      skills: skills.map((x) => `${manifest.name}:${x}`),
      hooks: hookCommands,
      mcpServers: Object.entries(servers).map(([n, v]) => describeMcpEntry(n, v)),
      outputStyles: styles,
      lspServers: lspServers.map(
        (l) =>
          `${l.name}: ${[l.command, ...l.args].join(" ")} (${Object.keys(l.extensions).join(", ")})`,
      ),
    },
  };
}

/** A language server's name in lsp.servers: the plugin's, then its own. */
function lspName(plugin: string, server: string): string {
  return `${plugin}-${server}`.replace(/[^\w-]/g, "-");
}

/** The question's text: what the plugin brings. */
function contentsText(c: PluginContents): string {
  const line = (label: string, list: string[]) =>
    list.length ? `${label}: ${list.slice(0, 12).join(", ")}${list.length > 12 ? "…" : ""}` : "";
  return [line("Commands", c.commands), line("Skills", c.skills), line("Subagents", c.agents)]
    .concat(c.outputStyles.length ? [`Output styles: ${c.outputStyles.join(", ")}`] : [])
    .filter(Boolean)
    .join("\n");
}

export class PluginService {
  readonly version = signal(0);
  private record: PluginsFile = { marketplaces: [], plugins: [] };
  private rootDir: string | null | undefined;
  private loaded: Promise<void> | null = null;
  /** Each marketplace's catalog as last read (name → it, or why it couldn't be read). */
  private catalogs = new Map<string, Marketplace | { error: string }>();
  /** The installed plugins' contents as last read. */
  private contents = new Map<string, PluginContents | { error: string }>();
  /** What Claude Code installed (D375), as last read; used in place. */
  private claudeInstalled: ClaudeInstalledPlugin[] = [];
  /** Claude Code's marketplaces (D375): listed, installed from, never copied again. */
  private claudeMarkets: KnownMarketplace[] = [];
  /** Claude Code's `enabledPlugins`, as last read. */
  private claudeOn: Record<string, unknown> | null = null;

  constructor(
    private readonly services: WorkbenchServices,
    private readonly onChange: () => void,
  ) {}

  /** `<data>/plugins` (the app's data folder), or null when it isn't known. */
  async root(): Promise<string | null> {
    if (this.rootDir === undefined) {
      const data = (await appIpc.info().catch(() => null))?.dataDir ?? null;
      this.rootDir = data ? joinPath(data, "plugins") : null;
    }
    return this.rootDir;
  }

  private async needRoot(): Promise<string> {
    const root = await this.root();
    if (!root) throw new Error("The IDE's data folder, where plugins are kept, isn't known.");
    return root;
  }

  /** Reads the record and every plugin and marketplace again. */
  reload(): Promise<void> {
    this.loaded = this.load();
    return this.loaded;
  }

  ready(): Promise<void> {
    this.loaded ??= this.load();
    return this.loaded;
  }

  /** The IDE's marketplaces, then Claude Code's (D375) that it hasn't one of the name of. */
  private allMarkets(): KnownMarketplace[] {
    const own = new Set(this.record.marketplaces.map((m) => m.name));
    return [...this.record.marketplaces, ...this.claudeMarkets.filter((m) => !own.has(m.name))];
  }

  /** Reads what Claude Code installed and its marketplaces (D375). */
  private async readClaude(): Promise<void> {
    const others = this.services.settings.peek<boolean>("agent.thirdPartyConfigs") !== false;
    const info = others ? await pluginsIpc.claudeInfo().catch(() => null) : null;
    const dir = info?.dir;
    if (!dir) {
      this.claudeInstalled = [];
      this.claudeMarkets = [];
      this.claudeOn = null;
      return;
    }
    this.claudeInstalled = parseClaudeInstalled(
      await readText(joinPath(dir, "installed_plugins.json")),
    );
    this.claudeMarkets = parseClaudeMarketplaces(
      await readText(joinPath(dir, "known_marketplaces.json")),
    ).map((m) => ({ name: m.name, source: { kind: "path", path: m.dir }, dir: m.dir, addedAt: 0 }));
    this.claudeOn = info.enabled;
  }

  /** A Claude Code plugin the IDE uses (installed there, not here). */
  private claudeOnly(): ClaudeInstalledPlugin[] {
    const own = new Set(this.record.plugins.map((p) => p.id));
    return this.claudeInstalled.filter((p) => !own.has(p.id));
  }

  private async load(): Promise<void> {
    const root = await this.root();
    this.record = parsePluginsFile(root ? await readText(joinPath(root, RECORD)) : null);
    await this.readClaude();
    const catalogs = new Map<string, Marketplace | { error: string }>();
    for (const m of this.allMarkets()) catalogs.set(m.name, await this.readCatalog(m.dir));
    this.catalogs = catalogs;
    const contents = new Map<string, PluginContents | { error: string }>();
    const active: ActivePlugin[] = [];
    for (const p of this.record.plugins) {
      const read = await readPlugin(p.dir, p.manifest, p.name);
      contents.set(p.id, "error" in read ? read : read.contents);
      if ("error" in read || !p.enabled) continue;
      active.push({
        id: p.id,
        name: p.name,
        dir: p.dir,
        commandDirs: read.commandDirs,
        agentDirs: read.agentDirs,
        skillDirs: read.skillDirs,
        hooks: p.hooks ? read.hooks : null,
        mcpServers: p.mcp ? read.mcpServers : null,
        outputStyleDirs: read.outputStyleDirs,
        lspServers: p.lsp ? read.lspServers : null,
      });
    }
    // Claude Code's (D375): on where it has them on and the IDE hasn't turned them off; their
    // hooks, MCP and language servers only once allowed here.
    for (const c of this.claudeOnly()) {
      const read = await readPlugin(c.dir, undefined, c.name);
      contents.set(c.id, "error" in read ? read : read.contents);
      const mine = this.record.claude?.[c.id];
      if ("error" in read || mine?.enabled === false || !claudeEnabled(this.claudeOn, c.id))
        continue;
      active.push({
        id: c.id,
        name: c.name,
        dir: c.dir,
        commandDirs: read.commandDirs,
        agentDirs: read.agentDirs,
        skillDirs: read.skillDirs,
        hooks: mine?.hooks ? read.hooks : null,
        mcpServers: mine?.mcp ? read.mcpServers : null,
        outputStyleDirs: read.outputStyleDirs,
        lspServers: mine?.lsp ? read.lspServers : null,
        fromClaude: true,
      });
    }
    this.contents = contents;
    activePlugins.value = active;
    // Their language servers, for the LSP manager (named plugin-server).
    const servers: Record<
      string,
      import("../../core/extensions/index").LanguageServerContribution & {
        extension: string;
      }
    > = {};
    for (const p of active)
      for (const l of p.lspServers ?? [])
        servers[lspName(p.name, l.name)] = {
          command: l.command,
          args: l.args,
          languages: [...new Set(Object.values(l.extensions))],
          ...(l.initializationOptions !== undefined && {
            initializationOptions: l.initializationOptions,
          }),
          title: `${l.name} (${pluginLabel(p.name)})`,
          extension: pluginLabel(p.name),
        };
    this.services.languageClients.plugins.value = servers;
    this.version.value++;
    this.onChange();
  }

  private async readCatalog(dir: string): Promise<Marketplace | { error: string }> {
    const text = await readText(joinPath(joinPath(dir, ".claude-plugin"), "marketplace.json"));
    if (text === null) return { error: "Its .claude-plugin/marketplace.json can't be read." };
    const parsed = parseMarketplace(text);
    return "error" in parsed ? parsed : parsed.marketplace;
  }

  private async save(): Promise<void> {
    await this.needRoot();
    await pluginsIpc.saveRecord(JSON.stringify(this.record, null, 2));
  }

  /** What ide://agent/plugins and agent.listPlugins show. */
  describe(): unknown {
    const fromClaude = new Set(this.claudeMarkets.map((m) => m.name));
    const own = new Set(this.record.marketplaces.map((m) => m.name));
    return {
      marketplaces: this.allMarkets().map((m) => {
        const cat = this.catalogs.get(m.name);
        return {
          name: m.name,
          source: m.source.kind === "git" ? m.source.url : m.source.path,
          ...(fromClaude.has(m.name) && !own.has(m.name) && { fromClaude: true }),
          ...(cat && "error" in cat
            ? { error: cat.error }
            : {
                description: cat?.description,
                plugins: (cat?.plugins ?? []).map((p) => ({
                  name: p.name,
                  id: pluginId(p.name, m.name),
                  description: p.description ?? "",
                  version: p.version,
                  installed:
                    this.record.plugins.some((x) => x.id === pluginId(p.name, m.name)) ||
                    this.claudeInstalled.some((x) => x.id === pluginId(p.name, m.name)),
                })),
                problems: cat?.problems ?? [],
              }),
        };
      }),
      installed: this.record.plugins.map((p) => ({
        id: p.id,
        description: p.description ?? "",
        version: p.version,
        enabled: p.enabled,
        hooks: p.hooks,
        mcp: p.mcp,
        lsp: p.lsp === true,
        dir: p.dir,
        contents: this.contents.get(p.id) ?? null,
      })),
      // Installed by Claude Code, used in place (D375).
      claudeCode: this.claudeOnly().map((c) => {
        const mine = this.record.claude?.[c.id];
        return {
          id: c.id,
          version: c.version,
          dir: c.dir,
          enabledInClaudeCode: claudeEnabled(this.claudeOn, c.id),
          enabled: mine?.enabled !== false && claudeEnabled(this.claudeOn, c.id),
          hooks: mine?.hooks === true,
          mcp: mine?.mcp === true,
          lsp: mine?.lsp === true,
          contents: this.contents.get(c.id) ?? null,
        };
      }),
    };
  }

  marketplaces(): readonly KnownMarketplace[] {
    return this.allMarkets();
  }

  /** A marketplace that's Claude Code's, not added here (D375). */
  isClaudeMarketplace(name: string): boolean {
    return (
      !this.record.marketplaces.some((m) => m.name === name) &&
      this.claudeMarkets.some((m) => m.name === name)
    );
  }

  /** Claude Code's installed plugins the IDE uses in place (D375). */
  claudePlugins(): readonly ClaudeInstalledPlugin[] {
    return this.claudeOnly();
  }

  installed(): readonly InstalledPlugin[] {
    return this.record.plugins;
  }

  catalog(name: string): Marketplace | { error: string } | undefined {
    return this.catalogs.get(name);
  }

  contentsOf(id: string): PluginContents | { error: string } | undefined {
    return this.contents.get(id);
  }

  /** A folder the user named: `~/…`, absolute, or relative to the open folder. */
  private async resolveFolder(path: string): Promise<string> {
    if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) {
      const home = (await appIpc.info().catch(() => null))?.homeDir;
      if (!home) throw new Error("The home folder isn't known.");
      return path === "~" ? home : resolveInRoot(home, path.slice(2));
    }
    if (isAbsolute(path)) return path;
    const root = this.services.workspace.root.peek();
    if (!root) throw new Error(`"${path}" is relative: give the folder's full path.`);
    return resolveInRoot(root, path);
  }

  /** Brings a marketplace's files to `dest` (a copy, or a clone). */
  private async fetchMarketplace(source: MarketplaceSource, dest: string): Promise<void> {
    if (source.kind === "git") await pluginsIpc.clone(source.url, dest);
    else await pluginsIpc.copy(source.path, dest);
  }

  async addMarketplace(input: string): Promise<{ name: string; plugins: number }> {
    await this.ready();
    const root = await this.needRoot();
    const looksLikePath = /^(\.|~|\/|\\|[A-Za-z]:)/.test(input.trim());
    const parsed = parseMarketplaceInput(input, looksLikePath);
    if (!parsed) throw new Error("Give a marketplace: owner/repo, a git URL or a folder.");
    const source: MarketplaceSource =
      parsed.kind === "path"
        ? { kind: "path", path: await this.resolveFolder(parsed.path) }
        : parsed;
    const same = this.allMarkets().find((m) =>
      source.kind === "git"
        ? m.source.kind === "git" && m.source.url === source.url
        : m.source.kind === "path" && m.source.path === source.path,
    );
    if (same)
      throw new Error(`That marketplace is added already (${same.name}): update it instead.`);
    // Its folder is named after the source; the marketplace's own name comes from its file.
    const base = (source.kind === "git" ? source.url : source.path)
      .replace(/[\\/]+$/, "")
      .replace(/\.git$/, "")
      .split(/[\\/:]/)
      .pop();
    let slug = (base ?? "").replace(/[^\w.-]/g, "-").replace(/^[.-]+/, "") || "marketplace";
    const taken = new Set(this.record.marketplaces.map((m) => basename(m.dir).toLowerCase()));
    for (let i = 2; taken.has(slug.toLowerCase()); i++) slug = `${slug.replace(/-\d+$/, "")}-${i}`;
    const dest = joinPath(joinPath(root, "marketplaces"), slug);
    await this.fetchMarketplace(source, dest);
    const cat = await this.readCatalog(dest);
    if ("error" in cat) {
      await pluginsIpc.remove(dest).catch(() => {});
      throw new Error(`That isn't a plugin marketplace: ${cat.error}`);
    }
    if (this.record.marketplaces.some((m) => m.name === cat.name)) {
      await pluginsIpc.remove(dest).catch(() => {});
      throw new Error(`A marketplace named ${cat.name} is added already.`);
    }
    this.record.marketplaces.push({ name: cat.name, source, dir: dest, addedAt: Date.now() });
    await this.save();
    await this.reload();
    return { name: cat.name, plugins: cat.plugins.length };
  }

  async updateMarketplace(name: string): Promise<{ name: string; plugins: number }> {
    await this.ready();
    const m = this.record.marketplaces.find((x) => x.name === name);
    if (!m) throw new Error(`No marketplace ${name}.`);
    await this.fetchMarketplace(m.source, m.dir);
    await this.reload();
    const cat = this.catalogs.get(name);
    return { name, plugins: cat && !("error" in cat) ? cat.plugins.length : 0 };
  }

  async removeMarketplace(name: string): Promise<{ marketplace: string; uninstalled: string[] }> {
    await this.ready();
    const m = this.record.marketplaces.find((x) => x.name === name);
    if (!m) throw new Error(`No marketplace ${name}.`);
    const plugins = this.record.plugins.filter((p) => p.marketplace === name);
    for (const p of plugins) await pluginsIpc.remove(p.dir).catch(() => {});
    await pluginsIpc.remove(m.dir).catch(() => {});
    this.record.plugins = this.record.plugins.filter((p) => p.marketplace !== name);
    this.record.marketplaces = this.record.marketplaces.filter((x) => x !== m);
    await this.save();
    await this.reload();
    return { marketplace: name, uninstalled: plugins.map((p) => p.id) };
  }

  /** The marketplace entry for `ref` (`name@marketplace`, or a name only one marketplace has). */
  private entryFor(ref: string): { market: KnownMarketplace; entry: MarketplacePlugin } {
    const parsed = parsePluginRef(ref);
    if (!parsed) throw new Error(`"${ref}" isn't a plugin (name@marketplace).`);
    const found: { market: KnownMarketplace; entry: MarketplacePlugin }[] = [];
    for (const market of this.allMarkets()) {
      if (parsed.marketplace && market.name !== parsed.marketplace) continue;
      const cat = this.catalogs.get(market.name);
      const entry =
        cat && !("error" in cat) ? cat.plugins.find((p) => p.name === parsed.name) : undefined;
      if (entry) found.push({ market, entry });
    }
    const one = found[0];
    if (!one)
      throw new Error(
        `No plugin ${ref} in ${parsed.marketplace ? `marketplace ${parsed.marketplace}` : "your marketplaces"} (/plugin marketplace add one first).`,
      );
    if (found.length > 1)
      throw new Error(
        `${parsed.name} is in several marketplaces: say which (${found.map((f) => pluginId(parsed.name, f.market.name)).join(", ")}).`,
      );
    return one;
  }

  /**
   * Installs a plugin: its copy, then the question (what it brings; its hooks and MCP servers
   * unticked). `allow` answers it for a test run.
   */
  async install(
    ref: string,
    caller: Caller,
    allow: { hooks?: boolean; mcp?: boolean; lsp?: boolean } = {},
  ): Promise<{ installed: boolean; id?: string; contents?: PluginContents }> {
    await this.ready();
    const root = await this.needRoot();
    const { market, entry } = this.entryFor(ref);
    const id = pluginId(entry.name, market.name);
    if (this.record.plugins.some((p) => p.id === id))
      throw new Error(`${id} is installed already.`);
    // Nothing twice (D375): Claude Code's copy is the one used.
    if (this.claudeInstalled.some((p) => p.id === id))
      throw new Error(
        `${id} is installed in Claude Code already, and the IDE uses that copy: turn it on or off on the Plugins page.`,
      );
    if (!validName(entry.name) || !validName(market.name))
      throw new Error("Not a valid plugin name.");
    const dest = joinPath(joinPath(joinPath(root, "cache"), market.name), entry.name);
    if (entry.source.kind === "path") await pluginsIpc.copy(market.dir, dest, entry.source.path);
    else if (entry.source.kind === "npm")
      await pluginsIpc.npm(npmSpec(entry.source), dest, entry.source.registry);
    else await pluginsIpc.clone(entry.source.url, dest, entry.source.ref, entry.source.path);
    const fallback = entry.strict ? undefined : entry.entry;
    const read = await readPlugin(dest, fallback, entry.name);
    if ("error" in read) {
      await pluginsIpc.remove(dest).catch(() => {});
      throw new Error(`${id} can't be installed: ${read.error}`);
    }
    let hooks = allow.hooks === true && read.contents.hooks.length > 0;
    let mcp = allow.mcp === true && read.contents.mcpServers.length > 0;
    let lsp = allow.lsp === true && read.contents.lspServers.length > 0;
    if (caller.kind !== "test") {
      const choices = [
        ...(read.contents.hooks.length
          ? [
              {
                label: "Run its hooks (on the agent's events, with your permissions)",
                detail: read.contents.hooks.join("\n").slice(0, 1500),
              },
            ]
          : []),
        ...(read.contents.mcpServers.length
          ? [
              {
                label: "Start its MCP servers (with your permissions)",
                detail: read.contents.mcpServers.join("\n").slice(0, 1500),
              },
            ]
          : []),
        ...(read.contents.lspServers.length
          ? [
              {
                label: "Start its language servers (with your permissions)",
                detail: read.contents.lspServers.join("\n").slice(0, 1500),
              },
            ]
          : []),
      ];
      const what = contentsText(read.contents);
      const answer = await confirmWithOptions(
        `Install ${entry.name}?`,
        `From ${market.name}${read.manifest.author ? `, by ${read.manifest.author}` : ""}. ${read.manifest.description ?? entry.description ?? ""}\n\n${what || "It brings no commands, skills or subagents."}\n\nIts commands run as yours (their allowed-tools run without asking). Only install plugins you trust.`,
        "Install",
        choices,
      );
      if (!answer.ok) {
        await pluginsIpc.remove(dest).catch(() => {});
        return { installed: false };
      }
      let i = 0;
      if (read.contents.hooks.length) hooks = answer.options[i++] === true;
      if (read.contents.mcpServers.length) mcp = answer.options[i++] === true;
      if (read.contents.lspServers.length) lsp = answer.options[i++] === true;
    }
    const version = read.manifest.version ?? entry.version;
    const description = read.manifest.description ?? entry.description;
    this.record.plugins.push({
      id,
      name: entry.name,
      marketplace: market.name,
      dir: dest,
      ...(version && { version }),
      ...(description && { description }),
      enabled: true,
      hooks,
      mcp,
      ...(lsp && { lsp }),
      installedAt: Date.now(),
      ...(fallback && { manifest: fallback }),
    });
    await this.save();
    await this.reload();
    return { installed: true, id, contents: read.contents };
  }

  async uninstall(ref: string): Promise<{ uninstalled: string }> {
    await this.ready();
    const p = findInstalled(this.record, ref);
    if ("error" in p) throw new Error(p.error);
    await pluginsIpc.remove(p.dir).catch(() => {});
    this.record.plugins = this.record.plugins.filter((x) => x.id !== p.id);
    await this.save();
    await this.reload();
    return { uninstalled: p.id };
  }

  async setEnabled(
    ref: string,
    changes: { enabled?: boolean; hooks?: boolean; mcp?: boolean; lsp?: boolean },
  ): Promise<InstalledPlugin | { id: string; fromClaude: true; enabled: boolean }> {
    await this.ready();
    // One of Claude Code's (D375): the IDE keeps its own on/off and permissions for it.
    const claude = this.claudeOnly().find((c) => c.id === ref || c.name === ref);
    if (claude && !this.record.plugins.some((p) => p.name === ref || p.id === ref)) {
      const was = this.record.claude?.[claude.id] ?? { enabled: true, hooks: false, mcp: false };
      const now = {
        enabled: changes.enabled ?? was.enabled,
        hooks: changes.hooks ?? was.hooks,
        mcp: changes.mcp ?? was.mcp,
        ...((changes.lsp ?? was.lsp) && { lsp: true }),
      };
      this.record.claude = { ...this.record.claude, [claude.id]: now };
      await this.save();
      await this.reload();
      return { id: claude.id, fromClaude: true, enabled: now.enabled };
    }
    const p = findInstalled(this.record, ref);
    if ("error" in p) throw new Error(p.error);
    const next = {
      ...p,
      ...(changes.enabled !== undefined && { enabled: changes.enabled }),
      ...(changes.hooks !== undefined && { hooks: changes.hooks }),
      ...(changes.mcp !== undefined && { mcp: changes.mcp }),
      ...(changes.lsp !== undefined && { lsp: changes.lsp }),
    };
    this.record.plugins = this.record.plugins.map((x) => (x.id === p.id ? next : x));
    await this.save();
    await this.reload();
    return next;
  }
}

/** `/plugin …` in the chat: what it does, by its words (Claude Code's). */
async function runPluginSlash(
  services: WorkbenchServices,
  args: string,
  caller: Caller,
): Promise<Record<string, unknown>> {
  const run = (id: string, input: unknown) => services.dispatcher.execute(id, input, caller);
  const words = args.split(/\s+/).filter(Boolean);
  const [verb, sub, ...rest] = words;
  const say = (text: string) => {
    if (caller.kind === "user") services.notifications.show("info", text);
  };
  const ref = sub ?? "";
  switch (verb?.toLowerCase()) {
    case undefined:
    case "manage":
      return { opened: await run("agent.showPlugins", {}) };
    case "marketplace":
    case "market": {
      const target = rest.join(" ");
      switch (sub?.toLowerCase()) {
        case "add": {
          const r = (await run("agent.addPluginMarketplace", { source: target })) as {
            name: string;
            plugins: number;
          };
          say(`Added marketplace ${r.name} (${r.plugins} plugin${r.plugins === 1 ? "" : "s"}).`);
          return { marketplace: r };
        }
        case "remove":
        case "rm":
          return { marketplace: await run("agent.removePluginMarketplace", { name: target }) };
        case "update":
          return {
            marketplace: await run("agent.updatePluginMarketplace", target ? { name: target } : {}),
          };
        case "list":
        case undefined:
          return { opened: await run("agent.showPlugins", {}) };
        default:
          throw new Error(
            "/plugin marketplace add <owner/repo | git URL | folder>, remove, update or list.",
          );
      }
    }
    case "install":
    case "i": {
      const r = (await run("agent.installPlugin", { plugin: ref })) as {
        installed: boolean;
        id?: string;
      };
      if (r.installed && r.id) say(`Installed ${r.id}.`);
      return { plugin: r };
    }
    case "uninstall":
    case "remove":
      return { plugin: await run("agent.uninstallPlugin", { plugin: ref }) };
    case "enable":
    case "disable":
      return {
        plugin: await run("agent.setPluginEnabled", {
          plugin: ref,
          enabled: verb.toLowerCase() === "enable",
        }),
      };
    case "list":
      return { opened: await run("agent.showPlugins", {}) };
    default:
      throw new Error(
        "/plugin: marketplace add <source>, install <name@marketplace>, uninstall, enable, disable, or nothing to manage them.",
      );
  }
}

export function registerPlugins(
  sub: DisposableStore,
  services: WorkbenchServices,
  subagents: SubagentRegistry,
  mcp: McpClients,
): PluginService {
  const { dispatcher, quickInput } = services;
  // What the plugins bring changed: the places that read them read again.
  const plugins = new PluginService(services, () => {
    skillsFor(services).invalidate();
    void subagents.refresh();
    // Servers started before the plugins were read (or with an older set) start again.
    void mcp.configChanged();
  });
  void plugins.ready();

  actionSlash.set("plugin", (args, caller) => runPluginSlash(services, args, caller));
  sub.add({ dispose: () => actionSlash.delete("plugin") });

  sub.add(
    services.state.register("ide://agent/plugins", {
      description:
        "Claude Code plugins (D358): the marketplaces added (each with its plugins and whether each is installed) and the installed plugins (enabled, whether their hooks and MCP servers may run, and what they bring: /plugin:command commands, plugin:skill skills, subagents, hook commands, MCP servers).",
      get: () => plugins.describe(),
    }),
  );

  const register: typeof dispatcher.register = (c) =>
    sub.add(dispatcher.register({ category: "Agent", ...c }));

  const pickInstalled = async (placeholder: string): Promise<string | null> => {
    await plugins.ready();
    const list = plugins.installed();
    if (!list.length) throw new Error("No plugins are installed.");
    const picked = await quickInput.pick(
      list.map((p) => ({ id: p.id, label: p.id, description: p.enabled ? "" : "disabled" })),
      { placeholder },
    );
    return picked?.id ?? null;
  };

  register({
    id: "agent.addPluginMarketplace",
    title: "Add a plugin marketplace…",
    description:
      "Adds a Claude Code plugin marketplace (D358): GitHub's owner/repo, a git URL (cloned with your git) or a local folder with .claude-plugin/marketplace.json (copied). Its plugins can then be installed. A person running it without `source` is asked.",
    input: s.object({
      source: s.string().describe("owner/repo, a git URL or a folder").optional(),
    }),
    effects: ["write", "network"],
    agent: "hidden",
    run: async ({ source }, ctx) => {
      const given =
        source?.trim() ||
        (ctx.caller.kind === "user"
          ? await quickInput.prompt({
              prompt: "Marketplace: GitHub owner/repo, a git URL or a folder",
              placeholder: "anthropics/claude-code",
            })
          : undefined);
      if (!given?.trim()) return { added: false };
      return { added: true, ...(await plugins.addMarketplace(given.trim())) };
    },
  });

  register({
    id: "agent.updatePluginMarketplace",
    title: "Update a plugin marketplace",
    description:
      "Fetches a plugin marketplace again (D358): its git repository cloned anew, or its folder copied anew; installed plugins stay as they are. Without `name`, every marketplace.",
    input: s.object({ name: s.string().optional() }),
    effects: ["write", "network"],
    agent: "hidden",
    run: async ({ name }) => {
      await plugins.ready();
      const names = name ? [name] : plugins.marketplaces().map((m) => m.name);
      const updated = [];
      for (const n of names) updated.push(await plugins.updateMarketplace(n));
      return { updated };
    },
  });

  register({
    id: "agent.removePluginMarketplace",
    title: "Remove a plugin marketplace…",
    description:
      "Removes a plugin marketplace and uninstalls the plugins installed from it (D358). Asks first when a person runs it.",
    input: s.object({ name: s.string().optional() }),
    effects: ["write", "destructive"],
    agent: "hidden",
    run: async ({ name }, ctx) => {
      await plugins.ready();
      let chosen = name;
      if (!chosen && ctx.caller.kind === "user") {
        const picked = await quickInput.pick(
          plugins.marketplaces().map((m) => ({ id: m.name, label: m.name })),
          { placeholder: "Remove which marketplace?" },
        );
        chosen = picked?.id;
      }
      if (!chosen) return { removed: false };
      const count = plugins.installed().filter((p) => p.marketplace === chosen).length;
      if (
        ctx.caller.kind === "user" &&
        !(await confirmAction(
          `Remove marketplace ${chosen}?`,
          count
            ? `Its ${count} installed plugin${count === 1 ? " is" : "s are"} uninstalled too.`
            : "Its copy in your plugins folder is deleted.",
          "Remove",
          true,
        ))
      )
        return { removed: false };
      return { removed: true, ...(await plugins.removeMarketplace(chosen)) };
    },
  });

  register({
    id: "agent.listPlugins",
    title: "List plugins",
    description:
      "The plugin marketplaces added, their plugins and the installed ones with what they bring (the same as ide://agent/plugins).",
    input: s.empty(),
    effects: ["read"],
    agent: "hidden",
    palette: false,
    run: async () => {
      await plugins.ready();
      return plugins.describe();
    },
  });

  register({
    id: "agent.installPlugin",
    title: "Install a plugin…",
    description:
      "Installs a Claude Code plugin from an added marketplace (D358): `plugin` is name@marketplace (or a name only one marketplace has). Always asks, showing what it brings; its hooks and MCP servers run only if ticked there (`hooks` / `mcp` answer that in test runs). Its commands (/plugin:command), skills, subagents then work in every chat.",
    input: s.object({
      plugin: s.string().describe("name@marketplace").optional(),
      hooks: s.boolean().describe("Test runs: let its hooks run").optional(),
      mcp: s.boolean().describe("Test runs: let its MCP servers start").optional(),
    }),
    effects: ["write", "network"],
    agent: "hidden",
    run: async ({ plugin, hooks, mcp: allowMcp }, ctx) => {
      await plugins.ready();
      let ref = plugin?.trim();
      if (!ref && ctx.caller.kind === "user") {
        const items = plugins.marketplaces().flatMap((m) => {
          const cat = plugins.catalog(m.name);
          return cat && !("error" in cat)
            ? cat.plugins
                .filter((p) => !plugins.installed().some((x) => x.id === pluginId(p.name, m.name)))
                .map((p) => ({
                  id: pluginId(p.name, m.name),
                  label: p.name,
                  description: m.name,
                  ...(p.description && { detail: p.description }),
                }))
            : [];
        });
        if (!items.length)
          throw new Error("Nothing to install: add a marketplace first (/plugin marketplace add).");
        ref = (await quickInput.pick(items, { placeholder: "Install which plugin?" }))?.id;
      }
      if (!ref) return { installed: false };
      return plugins.install(ref, ctx.caller, {
        ...(hooks !== undefined && { hooks }),
        ...(allowMcp !== undefined && { mcp: allowMcp }),
      });
    },
  });

  register({
    id: "agent.uninstallPlugin",
    title: "Uninstall a plugin…",
    description:
      "Uninstalls a plugin (D358): its copy is deleted and what it brought goes. Asks first when a person runs it.",
    input: s.object({ plugin: s.string().describe("name@marketplace").optional() }),
    effects: ["write", "destructive"],
    agent: "hidden",
    run: async ({ plugin }, ctx) => {
      const ref =
        plugin?.trim() ||
        (ctx.caller.kind === "user" ? await pickInstalled("Uninstall which plugin?") : null);
      if (!ref) return { uninstalled: false };
      if (
        ctx.caller.kind === "user" &&
        !(await confirmAction(
          `Uninstall ${ref}?`,
          "Its commands, skills, subagents, hooks and MCP servers go.",
          "Uninstall",
          true,
        ))
      )
        return { uninstalled: false };
      return plugins.uninstall(ref);
    },
  });

  register({
    id: "agent.setPluginEnabled",
    title: "Enable or disable a plugin…",
    description:
      "Turns an installed plugin on or off (D358; off: nothing of it is used, it stays installed). `hooks` / `mcp` / `lsp` change whether its hooks run and its MCP and language servers start (D375). A plugin Claude Code installed is switched for the IDE only. A person running it without `plugin` picks one and it's switched.",
    input: s.object({
      plugin: s.string().describe("name@marketplace").optional(),
      enabled: s.boolean().optional(),
      hooks: s.boolean().optional(),
      mcp: s.boolean().optional(),
      lsp: s.boolean().optional(),
    }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ plugin, enabled, hooks, mcp: allowMcp, lsp }, ctx) => {
      const ref =
        plugin?.trim() ||
        (ctx.caller.kind === "user"
          ? await pickInstalled("Enable or disable which plugin?")
          : null);
      if (!ref) return { changed: false };
      const onlyFlags = hooks === undefined && allowMcp === undefined && lsp === undefined;
      const flags = {
        ...(hooks !== undefined && { hooks }),
        ...(allowMcp !== undefined && { mcp: allowMcp }),
        ...(lsp !== undefined && { lsp }),
      };
      // Claude Code's (D375): switched for the IDE.
      const claude = plugins.claudePlugins().find((c) => c.id === ref || c.name === ref);
      const current = findInstalled({ marketplaces: [], plugins: [...plugins.installed()] }, ref);
      if ("error" in current) {
        if (!claude) throw new Error(current.error);
        const on = (
          plugins.describe() as { claudeCode: { id: string; enabled: boolean }[] }
        ).claudeCode.find((c) => c.id === claude.id)?.enabled;
        const next = await plugins.setEnabled(claude.id, {
          enabled: enabled ?? (onlyFlags ? !on : undefined),
          ...flags,
        });
        return { changed: true, id: next.id, enabled: next.enabled, fromClaude: true };
      }
      const next = await plugins.setEnabled(ref, {
        enabled: enabled ?? (onlyFlags ? !current.enabled : undefined),
        ...flags,
      });
      if ("fromClaude" in next) return { changed: true, id: next.id, enabled: next.enabled };
      return {
        changed: true,
        id: next.id,
        enabled: next.enabled,
        hooks: next.hooks,
        mcp: next.mcp,
        lsp: next.lsp === true,
      };
    },
  });

  return plugins;
}

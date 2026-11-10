// Claude Code plugins (D358), the DOM-free part: a plugin is a folder with
// `.claude-plugin/plugin.json` and any of `commands/*.md`, `agents/*.md`, `skills/<name>/SKILL.md`,
// `hooks/hooks.json` and `.mcp.json`; a marketplace is a folder (or a git repository) with
// `.claude-plugin/marketplace.json` listing plugins and where each comes from. Here: reading
// both files, what `/plugin marketplace add <source>` means, where a plugin's parts are,
// `${CLAUDE_PLUGIN_ROOT}`, and the IDE's own record of marketplaces and installed plugins.
// D375: npm sources, a plugin's output styles and LSP servers, and Claude Code's own record of
// what it installed (`~/.claude/plugins/installed_plugins.json`) and its marketplaces.

/** A plugin's manifest (`.claude-plugin/plugin.json`), the fields the IDE uses. */
export interface PluginManifest {
  name: string;
  description?: string;
  version?: string;
  author?: string;
  homepage?: string;
  /** Extra command files or folders (relative paths, `./…`), besides `commands/`. */
  commands: string[];
  agents: string[];
  skills: string[];
  /** A hooks file (relative path) or the hooks themselves (`{ hooks: {…} }` or the table). */
  hooks?: string | Record<string, unknown>;
  /** An MCP config file (relative path) or the servers themselves. */
  mcpServers?: string | Record<string, unknown>;
  /** Extra output style files or folders, besides `output-styles/` (D375). */
  outputStyles?: string[];
  /** An LSP config file (relative path) or the servers themselves (D375). */
  lspServers?: string | Record<string, unknown>;
}

/** Where a marketplace's plugin comes from. */
export type PluginSource =
  /** A folder in the marketplace (relative to its root, or to `metadata.pluginRoot`). */
  | { kind: "path"; path: string }
  /** A git repository (GitHub's `owner/repo` is one), optionally a folder in it and a ref. */
  | { kind: "git"; url: string; path?: string; ref?: string }
  /** An npm package (D375), at a version, from a registry. */
  | { kind: "npm"; package: string; version?: string; registry?: string };

export interface MarketplacePlugin {
  name: string;
  description?: string;
  version?: string;
  author?: string;
  category?: string;
  source: PluginSource;
  /** `strict: false`: the entry is the manifest (the plugin needs no plugin.json). */
  strict: boolean;
  /** The entry itself (with `strict: false` it serves as the manifest). */
  entry: Record<string, unknown>;
}

export interface Marketplace {
  name: string;
  description?: string;
  owner?: string;
  plugins: MarketplacePlugin[];
  /** Entries that couldn't be read, with why. */
  problems: string[];
}

/** What `/plugin marketplace add <input>` names. */
export type MarketplaceSource = { kind: "path"; path: string } | { kind: "git"; url: string };

/** A marketplace the IDE knows (its copy under the plugins folder). */
export interface KnownMarketplace {
  name: string;
  /** As the user gave it: a folder or a git URL. */
  source: MarketplaceSource;
  /** Its copy (a clone, or a copy of the folder). */
  dir: string;
  addedAt: number;
}

export interface InstalledPlugin {
  /** `name@marketplace`. */
  id: string;
  name: string;
  marketplace: string;
  /** Its own copy, under the plugins folder: `${CLAUDE_PLUGIN_ROOT}`. */
  dir: string;
  version?: string;
  description?: string;
  enabled: boolean;
  /** The user let its hooks run (asked at install, D358). */
  hooks: boolean;
  /** The user let its MCP servers start. */
  mcp: boolean;
  /** The user let its language servers start (D375). */
  lsp?: boolean;
  installedAt: number;
  /** A plugin without a plugin.json (`strict: false`): its marketplace entry, the manifest. */
  manifest?: Record<string, unknown>;
}

export interface PluginsFile {
  marketplaces: KnownMarketplace[];
  plugins: InstalledPlugin[];
  /**
   * Claude Code's installed plugins as the IDE uses them (D375): off here, or their hooks and
   * MCP servers allowed, by id. Absent: on, without hooks or servers.
   */
  claude?: Record<string, { enabled: boolean; hooks: boolean; mcp: boolean; lsp?: boolean }>;
}

const NAME = /^[A-Za-z0-9][\w.-]{0,63}$/;

/** A plugin or marketplace name usable as a folder name (letters, digits, `-`, `_`, `.`). */
export function validName(name: string): boolean {
  return NAME.test(name) && !name.includes("..");
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function authorOf(v: unknown): string | undefined {
  if (typeof v === "string") return str(v);
  if (v && typeof v === "object") return str((v as { name?: unknown }).name);
  return undefined;
}

function paths(v: unknown): string[] {
  if (typeof v === "string") return str(v) ? [v.trim()] : [];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
}

function objectOrPath(v: unknown): string | Record<string, unknown> | undefined {
  if (typeof v === "string") return str(v);
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return undefined;
}

/** A manifest from its fields (plugin.json's, or a `strict: false` marketplace entry's). */
export function manifestFrom(
  value: unknown,
  fallbackName?: string,
): { manifest: PluginManifest } | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { error: "plugin.json isn't a JSON object." };
  const v = value as Record<string, unknown>;
  const name = str(v.name) ?? fallbackName;
  if (!name) return { error: "plugin.json has no name." };
  if (!validName(name)) return { error: `"${name}" isn't a valid plugin name.` };
  const hooks = objectOrPath(v.hooks);
  const mcpServers = objectOrPath(v.mcpServers);
  const lspServers = objectOrPath(v.lspServers);
  const description = str(v.description);
  const version = str(v.version);
  const author = authorOf(v.author);
  const homepage = str(v.homepage);
  return {
    manifest: {
      name,
      ...(description && { description }),
      ...(version && { version }),
      ...(author && { author }),
      ...(homepage && { homepage }),
      commands: paths(v.commands),
      agents: paths(v.agents),
      skills: paths(v.skills),
      ...(hooks && { hooks }),
      ...(mcpServers && { mcpServers }),
      outputStyles: paths(v.outputStyles),
      ...(lspServers && { lspServers }),
    },
  };
}

/** `.claude-plugin/plugin.json`'s text. */
export function parsePluginManifest(
  text: string,
  fallbackName?: string,
): { manifest: PluginManifest } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return { error: "plugin.json isn't valid JSON." };
  }
  return manifestFrom(value, fallbackName);
}

/** An npm package name (`@scope/name` or `name`) and an exact version or tag (D375). */
const NPM_NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
const NPM_VERSION = /^[\w.+-]{1,64}$/;

/** What `npm pack` gets for an npm source: `name@version`, or the name alone. */
export function npmSpec(source: { package: string; version?: string }): string {
  return source.version ? `${source.package}@${source.version}` : source.package;
}

/** `owner/repo` on GitHub. */
const GITHUB_REPO = /^[\w.-]+\/[\w.-]+$/;

function githubUrl(repo: string): string {
  return `https://github.com/${repo.replace(/\.git$/, "")}.git`;
}

/** A plugin entry's `source`: a relative path, or `{ source: github | url | git | git-subdir }`. */
export function parsePluginSource(v: unknown, pluginRoot?: string): PluginSource | null {
  if (typeof v === "string") {
    const raw = v.trim();
    if (!raw) return null;
    // A bare name is relative to `metadata.pluginRoot` (Claude Code's), `./x` to the root.
    const rel =
      raw.startsWith("./") || raw.startsWith("../") || !pluginRoot
        ? raw
        : `${pluginRoot.replace(/\/+$/, "")}/${raw}`;
    const path = normalizeRelative(rel);
    return path === null ? null : { kind: "path", path };
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const ref = str(o.ref) ?? str(o.branch) ?? str(o.tag);
  const sub = str(o.path);
  const subPath = sub === undefined ? undefined : normalizeRelative(sub);
  if (subPath === null) return null;
  const extra = { ...(subPath && { path: subPath }), ...(ref && { ref }) };
  switch (o.source) {
    case "github": {
      const repo = str(o.repo);
      return repo && GITHUB_REPO.test(repo)
        ? { kind: "git", url: githubUrl(repo), ...extra }
        : null;
    }
    case "url":
    case "git":
    case "git-subdir": {
      const url = str(o.url);
      return url && gitUrl(url) ? { kind: "git", url, ...extra } : null;
    }
    case "npm": {
      const pkg = str(o.package);
      const version = str(o.version);
      const registry = str(o.registry);
      if (!pkg || !NPM_NAME.test(pkg)) return null;
      if (version && !NPM_VERSION.test(version)) return null;
      if (registry && !/^https?:\/\/[^\s"'`]+$/.test(registry)) return null;
      return {
        kind: "npm",
        package: pkg,
        ...(version && { version }),
        ...(registry && { registry }),
      };
    }
    default:
      return null;
  }
}

/** A relative path inside a folder (`/` separated, no `..` out of it), or null. */
export function normalizeRelative(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  // A drive or an absolute path isn't relative.
  if (/^[A-Za-z]:/.test(path) || path.startsWith("/") || path.startsWith("\\")) return null;
  return parts.join("/");
}

/** Whether `url` is a git URL the IDE clones (https, http, ssh, git@host:path). */
export function gitUrl(url: string): boolean {
  if (url.startsWith("-")) return false;
  return /^(https?|ssh|git):\/\/\S+$/i.test(url) || /^[\w.-]+@[\w.-]+:\S+$/.test(url);
}

/** `.claude-plugin/marketplace.json`'s text. */
export function parseMarketplace(text: string): { marketplace: Marketplace } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return { error: "marketplace.json isn't valid JSON." };
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { error: "marketplace.json isn't a JSON object." };
  const v = value as Record<string, unknown>;
  const name = str(v.name);
  if (!name) return { error: "marketplace.json has no name." };
  if (!validName(name)) return { error: `"${name}" isn't a valid marketplace name.` };
  const metadata = (v.metadata && typeof v.metadata === "object" ? v.metadata : {}) as Record<
    string,
    unknown
  >;
  const pluginRoot = str(metadata.pluginRoot);
  const problems: string[] = [];
  const plugins: MarketplacePlugin[] = [];
  for (const raw of Array.isArray(v.plugins) ? v.plugins : []) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const pname = str(e.name);
    if (!pname || !validName(pname)) {
      problems.push(`An entry has no valid name (${JSON.stringify(e.name ?? null)}).`);
      continue;
    }
    if (plugins.some((p) => p.name === pname)) {
      problems.push(`${pname} is listed twice; the first one counts.`);
      continue;
    }
    const source = parsePluginSource(e.source, pluginRoot);
    if (!source) {
      problems.push(`${pname}: its source isn't one the IDE can install (a folder or a git URL).`);
      continue;
    }
    const description = str(e.description);
    const version = str(e.version);
    const author = authorOf(e.author);
    const category = str(e.category);
    plugins.push({
      name: pname,
      ...(description && { description }),
      ...(version && { version }),
      ...(author && { author }),
      ...(category && { category }),
      source,
      strict: e.strict !== false,
      entry: e,
    });
  }
  const description = str(v.description) ?? str(metadata.description);
  const owner = authorOf(v.owner);
  return {
    marketplace: {
      name,
      ...(description && { description }),
      ...(owner && { owner }),
      plugins,
      problems,
    },
  };
}

/**
 * What `/plugin marketplace add <input>` names: GitHub's `owner/repo`, a git URL, or a folder.
 * `isPath` says whether a folder by that name exists (`owner/repo` could be a relative folder).
 */
export function parseMarketplaceInput(input: string, isPath = false): MarketplaceSource | null {
  const raw = input.trim().replace(/^["']|["']$/g, "");
  if (!raw) return null;
  if (gitUrl(raw)) return { kind: "git", url: raw };
  if (GITHUB_REPO.test(raw) && !isPath && !raw.startsWith("."))
    return { kind: "git", url: githubUrl(raw) };
  return { kind: "path", path: raw };
}

/** `name@marketplace` (just `name` when the marketplace isn't said). */
export function parsePluginRef(ref: string): { name: string; marketplace?: string } | null {
  const at = ref.trim().lastIndexOf("@");
  const name = at > 0 ? ref.trim().slice(0, at) : ref.trim();
  const marketplace = at > 0 ? ref.trim().slice(at + 1) : undefined;
  if (!validName(name) || (marketplace !== undefined && !validName(marketplace))) return null;
  return { name, ...(marketplace && { marketplace }) };
}

export function pluginId(name: string, marketplace: string): string {
  return `${name}@${marketplace}`;
}

/** Strings with `${CLAUDE_PLUGIN_ROOT}` get the plugin's folder (`/` separated), deep. */
export function substitutePluginRoot<T>(value: T, root: string): T {
  const folder = root.replaceAll("\\", "/").replace(/\/+$/, "");
  const swap = (v: unknown): unknown => {
    if (typeof v === "string")
      return v.replace(/\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT\b/g, () => folder);
    if (Array.isArray(v)) return v.map(swap);
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)]));
    return v;
  };
  return swap(value) as T;
}

/** A plugin's parts, as relative paths in its folder (defaults first, then the manifest's). */
export function pluginParts(manifest: PluginManifest): {
  commands: string[];
  agents: string[];
  skills: string[];
  hooksFile: string | null;
  inlineHooks: Record<string, unknown> | null;
  mcpFile: string | null;
  inlineMcp: Record<string, unknown> | null;
  outputStyles: string[];
  lspFile: string | null;
  inlineLsp: Record<string, unknown> | null;
} {
  const rel = (list: string[]) =>
    list.map((p) => normalizeRelative(p)).filter((p): p is string => !!p);
  const uniq = (list: string[]) => list.filter((p, i) => list.indexOf(p) === i);
  const hooksPath = typeof manifest.hooks === "string" ? normalizeRelative(manifest.hooks) : null;
  const mcpPath =
    typeof manifest.mcpServers === "string" ? normalizeRelative(manifest.mcpServers) : null;
  return {
    commands: uniq(["commands", ...rel(manifest.commands)]),
    agents: uniq(["agents", ...rel(manifest.agents)]),
    skills: uniq(["skills", ...rel(manifest.skills)]),
    hooksFile: hooksPath ?? "hooks/hooks.json",
    inlineHooks: typeof manifest.hooks === "object" ? manifest.hooks : null,
    mcpFile: mcpPath ?? ".mcp.json",
    inlineMcp: typeof manifest.mcpServers === "object" ? manifest.mcpServers : null,
    outputStyles: uniq(["output-styles", ...rel(manifest.outputStyles ?? [])]),
    lspFile:
      (typeof manifest.lspServers === "string" ? normalizeRelative(manifest.lspServers) : null) ??
      ".lsp.json",
    inlineLsp: typeof manifest.lspServers === "object" ? manifest.lspServers : null,
  };
}

/** A plugin's language server (Claude Code's `.lsp.json` entry), as the IDE starts one. */
export interface PluginLspServer {
  name: string;
  command: string;
  args: string[];
  /** File extensions (`.go`) and the language each is. */
  extensions: Record<string, string>;
  env?: Record<string, string>;
  initializationOptions?: unknown;
}

/**
 * Claude Code's LSP config: `{ "go": { "command": "gopls", "args": ["serve"],
 * "extensionToLanguage": { ".go": "go" } } }`. Entries without a command or extensions are
 * skipped.
 */
export function lspServersOf(value: unknown): PluginLspServer[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const out: PluginLspServer[] = [];
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const command = str(o.command);
    const map = o.extensionToLanguage;
    if (!command || !map || typeof map !== "object" || Array.isArray(map)) continue;
    const extensions: Record<string, string> = {};
    for (const [ext, lang] of Object.entries(map as Record<string, unknown>))
      if (/^\.[\w.+-]+$/.test(ext) && typeof lang === "string" && lang.trim())
        extensions[ext.toLowerCase()] = lang.trim();
    if (!Object.keys(extensions).length) continue;
    const env =
      o.env && typeof o.env === "object" && !Array.isArray(o.env)
        ? Object.fromEntries(
            Object.entries(o.env as Record<string, unknown>).filter(
              (e): e is [string, string] => typeof e[1] === "string",
            ),
          )
        : undefined;
    out.push({
      name,
      command,
      args: Array.isArray(o.args) ? o.args.filter((a): a is string => typeof a === "string") : [],
      extensions,
      ...(env && Object.keys(env).length && { env }),
      ...(o.initializationOptions !== undefined && {
        initializationOptions: o.initializationOptions,
      }),
    });
  }
  return out;
}

/** A plugin Claude Code installed (its `installed_plugins.json`), used in place (D375). */
export interface ClaudeInstalledPlugin {
  id: string;
  name: string;
  marketplace: string;
  /** Its folder, as Claude Code keeps it. */
  dir: string;
  version?: string;
}

/**
 * Claude Code's `installed_plugins.json`: version 1 (`{ "plugins": { "name@market":
 * { installPath, version } } }`) or 2 (each id a list of installs by scope; the user-scope one,
 * else the first). Anything unreadable gives nothing.
 */
export function parseClaudeInstalled(text: string | null): ClaudeInstalledPlugin[] {
  if (!text) return [];
  let v: unknown;
  try {
    v = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return [];
  }
  const plugins = (v as { plugins?: unknown } | null)?.plugins;
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return [];
  const out: ClaudeInstalledPlugin[] = [];
  for (const [id, raw] of Object.entries(plugins as Record<string, unknown>)) {
    const ref = parsePluginRef(id);
    if (!ref?.marketplace || !validName(ref.name) || !validName(ref.marketplace)) continue;
    const list = Array.isArray(raw) ? raw : [raw];
    const pick = (list.find((x) => (x as { scope?: unknown })?.scope === "user") ?? list[0]) as
      | { installPath?: unknown; version?: unknown }
      | undefined;
    const dir = str(pick?.installPath);
    if (!dir) continue;
    const version = str(pick?.version);
    out.push({
      id: pluginId(ref.name, ref.marketplace),
      name: ref.name,
      marketplace: ref.marketplace,
      dir,
      ...(version && { version }),
    });
  }
  return out;
}

/** Whether Claude Code has a plugin on (`enabledPlugins`; without the setting, all are). */
export function claudeEnabled(enabled: Record<string, unknown> | null, id: string): boolean {
  if (!enabled) return true;
  return enabled[id] === true;
}

/** Claude Code's marketplaces (`known_marketplaces.json`): name and its local copy. */
export function parseClaudeMarketplaces(text: string | null): { name: string; dir: string }[] {
  if (!text) return [];
  let v: unknown;
  try {
    v = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return [];
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return [];
  return Object.entries(v as Record<string, unknown>).flatMap(([name, raw]) => {
    const dir = str((raw as { installLocation?: unknown } | null)?.installLocation);
    return validName(name) && dir ? [{ name, dir }] : [];
  });
}

/** A hooks file's table: `{ hooks: {…} }` (Claude Code's plugin format) or the table itself. */
export function hooksTableOf(value: unknown): unknown {
  if (value && typeof value === "object" && "hooks" in value)
    return (value as { hooks: unknown }).hooks;
  return value;
}

/** An MCP config's servers: `{ mcpServers: {…} }`, `{ servers: {…} }` or the servers themselves. */
export function mcpServersOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const v = value as Record<string, unknown>;
  const inner = v.mcpServers ?? v.servers;
  if (inner && typeof inner === "object" && !Array.isArray(inner))
    return inner as Record<string, unknown>;
  // The servers themselves: each an object with a command or a url.
  return Object.fromEntries(
    Object.entries(v).filter(
      ([, s]) => !!s && typeof s === "object" && ("command" in s || "url" in s),
    ),
  );
}

/** The commands a set of hooks runs (for the install question). */
export function hookCommandsOf(table: unknown): string[] {
  const out: string[] = [];
  if (!table || typeof table !== "object") return out;
  for (const groups of Object.values(table as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      const hooks = (g as { hooks?: unknown } | null)?.hooks;
      if (!Array.isArray(hooks)) continue;
      for (const h of hooks) {
        const c = (h as { command?: unknown } | null)?.command;
        if (typeof c === "string" && c.trim() && !out.includes(c.trim())) out.push(c.trim());
      }
    }
  }
  return out;
}

/** What an MCP server runs, one line (for the install question). */
export function describeMcpEntry(name: string, value: unknown): string {
  const v = (value ?? {}) as { command?: unknown; args?: unknown; url?: unknown };
  if (typeof v.url === "string") return `${name}: ${v.url}`;
  const args = Array.isArray(v.args) ? v.args.filter((a) => typeof a === "string") : [];
  return `${name}: ${[typeof v.command === "string" ? v.command : "?", ...args].join(" ")}`;
}

/** The record file's contents, checked (anything odd is dropped). */
export function parsePluginsFile(text: string | null): PluginsFile {
  const out: PluginsFile = { marketplaces: [], plugins: [] };
  if (!text) return out;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return out;
  }
  const o = (v ?? {}) as { marketplaces?: unknown; plugins?: unknown };
  for (const m of Array.isArray(o.marketplaces) ? o.marketplaces : []) {
    const x = m as Partial<KnownMarketplace> | null;
    const src = x?.source as Partial<MarketplaceSource> | undefined;
    const source: MarketplaceSource | null =
      src?.kind === "git" && typeof src.url === "string"
        ? { kind: "git", url: src.url }
        : src?.kind === "path" && typeof src.path === "string"
          ? { kind: "path", path: src.path }
          : null;
    if (x && typeof x.name === "string" && validName(x.name) && typeof x.dir === "string" && source)
      out.marketplaces.push({
        name: x.name,
        source,
        dir: x.dir,
        addedAt: typeof x.addedAt === "number" ? x.addedAt : 0,
      });
  }
  for (const p of Array.isArray(o.plugins) ? o.plugins : []) {
    const x = p as Partial<InstalledPlugin> | null;
    if (
      !x ||
      typeof x.name !== "string" ||
      typeof x.marketplace !== "string" ||
      typeof x.dir !== "string" ||
      !validName(x.name) ||
      !validName(x.marketplace)
    )
      continue;
    out.plugins.push({
      id: pluginId(x.name, x.marketplace),
      name: x.name,
      marketplace: x.marketplace,
      dir: x.dir,
      ...(typeof x.version === "string" && { version: x.version }),
      ...(typeof x.description === "string" && { description: x.description }),
      enabled: x.enabled !== false,
      hooks: x.hooks === true,
      mcp: x.mcp === true,
      ...(x.lsp === true && { lsp: true }),
      installedAt: typeof x.installedAt === "number" ? x.installedAt : 0,
      ...(x.manifest &&
        typeof x.manifest === "object" &&
        !Array.isArray(x.manifest) && { manifest: x.manifest }),
    });
  }
  const claude = (o as { claude?: unknown }).claude;
  if (claude && typeof claude === "object" && !Array.isArray(claude)) {
    const kept: NonNullable<PluginsFile["claude"]> = {};
    for (const [id, raw] of Object.entries(claude as Record<string, unknown>)) {
      const c = (raw ?? {}) as Record<string, unknown>;
      kept[id] = {
        enabled: c.enabled !== false,
        hooks: c.hooks === true,
        mcp: c.mcp === true,
        ...(c.lsp === true && { lsp: true }),
      };
    }
    out.claude = kept;
  }
  return out;
}

/** An installed plugin by `name@marketplace`, or by name when only one has it. */
export function findInstalled(file: PluginsFile, ref: string): InstalledPlugin | { error: string } {
  const parsed = parsePluginRef(ref);
  if (!parsed) return { error: `"${ref}" isn't a plugin (name@marketplace).` };
  const matches = file.plugins.filter(
    (p) => p.name === parsed.name && (!parsed.marketplace || p.marketplace === parsed.marketplace),
  );
  if (matches.length === 1 && matches[0]) return matches[0];
  if (!matches.length) return { error: `No installed plugin ${ref}.` };
  return {
    error: `${parsed.name} is installed from several marketplaces: say which (${matches.map((m) => m.id).join(", ")}).`,
  };
}

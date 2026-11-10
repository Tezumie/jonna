// The ACP agent registry (D215): agentclientprotocol/registry's registry.json, parsed strictly.
// The file comes from the network (or the bundled snapshot), so every field is checked: ids and
// versions are plain tokens, links are https, packages are npm / PyPI names, a binary's `cmd` is
// a relative path inside its archive, environment variables can't preload code, icons are SVG
// with no scripts, handlers, external references or foreignObject. An agent that fails a check
// is left out (with the reason), not the whole registry. DOM-free and unit-tested.

export const REGISTRY_PLATFORMS = [
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-aarch64",
  "linux-x86_64",
  "windows-aarch64",
  "windows-x86_64",
] as const;
export type RegistryPlatform = (typeof REGISTRY_PLATFORMS)[number];

export interface PackageDistribution {
  package: string;
  args: string[];
  env: Record<string, string>;
}

export interface BinaryTarget {
  archive: string;
  /** Lowercase hex; absent: the download can't be checked (the UI says so). */
  sha256?: string;
  cmd: string;
  args: string[];
  env: Record<string, string>;
}

export interface RegistryIcon {
  /** A data:image/svg+xml URL of a checked SVG. */
  src: string;
  /** One-color (currentColor): drawn as a mask in the text color, so it reads in both themes. */
  mono: boolean;
}

export interface RegistryAgent {
  id: string;
  name: string;
  version: string;
  description: string;
  repository?: string;
  website?: string;
  authors: string[];
  license: string;
  licenseUrl?: string;
  icon?: RegistryIcon;
  /** An https icon address still to fetch (the published registry links its icons). */
  iconUrl?: string;
  distribution: {
    npx?: PackageDistribution;
    uvx?: PackageDistribution;
    binary?: Partial<Record<RegistryPlatform, BinaryTarget>>;
  };
}

export interface ParsedRegistry {
  version: string;
  agents: RegistryAgent[];
  /** Agents left out, and why. */
  skipped: { id: string; reason: string }[];
}

export interface ParseOptions {
  /** Test builds only: http://127.0.0.1 / localhost archive and icon addresses. */
  allowLoopback?: boolean;
}

/** The registry's own agents for the IDE's four built-in presets (acp.ts ACP_PRESETS). */
export const PRESET_REGISTRY_IDS: Readonly<Record<string, string>> = {
  "Claude Code": "claude-acp",
  Codex: "codex-acp",
  "Gemini CLI": "gemini",
  "GitHub Copilot": "github-copilot-cli",
};

const MAX_AGENTS = 500;
export const MAX_ICON_CHARS = 32 * 1024;
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;
const NPM_PACKAGE = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(@[A-Za-z0-9][\w.+-]*)?$/;
const PYPI_PACKAGE =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9._,-]+\])?((==|>=|<=|~=|@)[A-Za-z0-9][\w.+!-]*)?$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Variables that make a program load other code (or find other programs). */
const UNSAFE_ENV = /^(PATH|PATHEXT|LD_\w+|DYLD_\w+|NODE_OPTIONS|NODE_PATH|PYTHON\w*|COMSPEC)$/i;
/** Control characters (C0 and DEL), which no name, argument or value here should have. */
const CONTROL = { test: (s: string) => [...s].some((c) => c.charCodeAt(0) < 0x20 || c === "\x7f") };
const COPYLEFT = /\b(A|L)?GPL\b|\bGNU (Affero |Lesser )?General Public\b/i;
const UNSAFE_SVG =
  /<script|\son[a-z]+\s*=|javascript:|<foreignObject|<!ENTITY|<!DOCTYPE|<iframe|<embed|<object|<image|<use[\s>]|<style|@import|url\(|href\s*=/i;
export const INSTALLER_FORMATS = /\.(dmg|pkg|deb|rpm|msi|appimage)$/i;

class Bad extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function text(v: unknown, what: string, max: number, optional: true): string | undefined;
function text(v: unknown, what: string, max: number, optional?: false): string;
function text(v: unknown, what: string, max: number, optional = false): string | undefined {
  if (v === undefined || v === null) {
    if (optional) return undefined;
    throw new Bad(`no ${what}`);
  }
  if (typeof v !== "string") throw new Bad(`${what} isn't text`);
  const t = v.trim();
  if (!t && !optional) throw new Bad(`empty ${what}`);
  if (t.length > max) throw new Bad(`${what} is too long`);
  if (CONTROL.test(t)) throw new Bad(`${what} has control characters`);
  return t || undefined;
}

/** Whether `url` is an address the IDE may open or download from. */
export function allowedUrl(url: string, allowLoopback = false): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return (
    allowLoopback &&
    u.protocol === "http:" &&
    (u.hostname === "127.0.0.1" || u.hostname === "localhost")
  );
}

function link(v: unknown, what: string, allowLoopback: boolean): string | undefined {
  const t = text(v, what, 500, true);
  if (t === undefined) return undefined;
  if (!allowedUrl(t, allowLoopback)) throw new Bad(`${what} isn't an https address`);
  return t;
}

function args(v: unknown, what: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 32) throw new Bad(`${what} isn't a list of arguments`);
  return v.map((a, i) => {
    if (typeof a !== "string" || a.length > 500 || CONTROL.test(a))
      throw new Bad(`${what}[${i}] isn't an argument`);
    return a;
  });
}

function env(v: unknown, what: string): Record<string, string> {
  if (v === undefined) return {};
  if (!isObject(v)) throw new Bad(`${what} isn't a set of variables`);
  const out: Record<string, string> = {};
  for (const [k, value] of Object.entries(v)) {
    if (!ENV_KEY.test(k)) throw new Bad(`${what} has a bad variable name`);
    if (UNSAFE_ENV.test(k)) throw new Bad(`${what} sets ${k}`);
    if (typeof value !== "string" || value.length > 1000 || CONTROL.test(value))
      throw new Bad(`${what}.${k} isn't text`);
    out[k] = value;
  }
  return out;
}

/** A path inside an archive: relative, no `..`, no drive or NUL (`./dist\\agent.cmd` is fine). */
export function safeCommandPath(cmd: string): boolean {
  const p = cmd.replace(/\\/g, "/");
  if (!p || p.startsWith("/") || p.includes(":") || CONTROL.test(p) || p.length > 300) return false;
  const parts = p.split("/").filter((x) => x && x !== ".");
  return parts.length > 0 && parts.every((x) => x !== "..");
}

function packageDist(v: unknown, kind: "npx" | "uvx"): PackageDistribution {
  if (!isObject(v)) throw new Bad(`${kind} isn't an object`);
  const pkg = text(v.package, `${kind}.package`, 214);
  if (!(kind === "npx" ? NPM_PACKAGE : PYPI_PACKAGE).test(pkg))
    throw new Bad(`${kind}.package isn't a package name`);
  return { package: pkg, args: args(v.args, `${kind}.args`), env: env(v.env, `${kind}.env`) };
}

function binaryDist(
  v: unknown,
  allowLoopback: boolean,
): Partial<Record<RegistryPlatform, BinaryTarget>> {
  if (!isObject(v)) throw new Bad("binary isn't an object");
  const out: Partial<Record<RegistryPlatform, BinaryTarget>> = {};
  for (const [platform, t] of Object.entries(v)) {
    if (!(REGISTRY_PLATFORMS as readonly string[]).includes(platform)) continue;
    if (!isObject(t)) throw new Bad(`binary.${platform} isn't an object`);
    const archive = link(t.archive, `binary.${platform}.archive`, allowLoopback);
    if (!archive) throw new Bad(`binary.${platform} has no archive`);
    if (INSTALLER_FORMATS.test(new URL(archive).pathname))
      throw new Bad(`binary.${platform} is an installer, not an archive`);
    const sha = text(t.sha256, `binary.${platform}.sha256`, 64, true);
    if (sha !== undefined && !/^[0-9a-fA-F]{64}$/.test(sha))
      throw new Bad(`binary.${platform}.sha256 isn't a SHA-256`);
    const cmd = text(t.cmd, `binary.${platform}.cmd`, 300);
    if (!safeCommandPath(cmd)) throw new Bad(`binary.${platform}.cmd leaves its folder`);
    out[platform as RegistryPlatform] = {
      archive,
      ...(sha && { sha256: sha.toLowerCase() }),
      cmd,
      args: args(t.args, `binary.${platform}.args`),
      env: env(t.env, `binary.${platform}.env`),
    };
  }
  return out;
}

/** An SVG as a data URL when it's safe to show as an image (no script, handler, link or style). */
export function sanitizeSvg(svg: string): RegistryIcon | null {
  const t = svg.replace(/^﻿/, "").trim();
  if (!t || t.length > MAX_ICON_CHARS || !/^(<\?xml[^>]*\?>\s*)?<svg[\s>]/i.test(t)) return null;
  if (UNSAFE_SVG.test(t) || CONTROL.test(t.replace(/[\t\n\r]/g, ""))) return null;
  const mono = !/(fill|stop-color|stroke)\s*[=:]\s*["']?\s*(#|rgb|hsl|url)/i.test(t);
  return { src: `data:image/svg+xml,${encodeURIComponent(t.replace(/\s+/g, " "))}`, mono };
}

/** A data:image/svg+xml URL's SVG, checked again (the bundled snapshot carries them so). */
function iconFrom(v: unknown, allowLoopback: boolean): { icon?: RegistryIcon; url?: string } {
  if (typeof v !== "string" || v.length > MAX_ICON_CHARS * 4) return {};
  const data = /^data:image\/svg\+xml(;utf8)?,(.*)$/s.exec(v);
  if (data) {
    let svg: string;
    try {
      svg = decodeURIComponent(data[2] ?? "");
    } catch {
      return {};
    }
    const icon = sanitizeSvg(svg);
    return icon ? { icon } : {};
  }
  const b64 = /^data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)$/.exec(v);
  if (b64) {
    try {
      const icon = sanitizeSvg(
        new TextDecoder().decode(Uint8Array.from(atob(b64[1] ?? ""), (c) => c.charCodeAt(0))),
      );
      return icon ? { icon } : {};
    } catch {
      return {};
    }
  }
  return allowedUrl(v, allowLoopback) ? { url: v } : {};
}

export function isCopyleft(license: string): boolean {
  return COPYLEFT.test(license);
}

function parseAgent(v: unknown, allowLoopback: boolean): RegistryAgent {
  if (!isObject(v)) throw new Bad("not an object");
  const id = text(v.id, "id", 64);
  if (!ID.test(id)) throw new Bad("id isn't a plain name");
  const version = text(v.version, "version", 64);
  if (!VERSION.test(version)) throw new Bad("version isn't a version");
  const license = text(v.license, "license", 100, true) ?? "unknown";
  if (isCopyleft(license)) throw new Bad(`its license is ${license} (copyleft)`);
  const authors = v.authors === undefined ? [] : v.authors;
  if (!Array.isArray(authors) || authors.length > 20) throw new Bad("authors isn't a list");
  const d = v.distribution;
  if (!isObject(d)) throw new Bad("no distribution");
  const distribution: RegistryAgent["distribution"] = {};
  if (d.npx !== undefined) distribution.npx = packageDist(d.npx, "npx");
  if (d.uvx !== undefined) distribution.uvx = packageDist(d.uvx, "uvx");
  if (d.binary !== undefined) {
    const binary = binaryDist(d.binary, allowLoopback);
    if (Object.keys(binary).length) distribution.binary = binary;
  }
  if (!distribution.npx && !distribution.uvx && !distribution.binary)
    throw new Bad("no way to run it (npx, uvx or binary)");
  const repository = link(v.repository, "repository", false);
  const website = link(v.website, "website", false);
  const licenseUrl = link(v.license_url, "license_url", false);
  const { icon, url } = iconFrom(v.icon, allowLoopback);
  return {
    id,
    name: text(v.name, "name", 80),
    version,
    description: text(v.description, "description", 500, true) ?? "",
    ...(repository && { repository }),
    ...(website && { website }),
    authors: authors.map((a, i) => text(a, `authors[${i}]`, 120)),
    license,
    ...(licenseUrl && { licenseUrl }),
    ...(icon && { icon }),
    ...(url && { iconUrl: url }),
    distribution,
  };
}

/** The registry's agents; throws only when the file itself isn't a registry. */
export function parseRegistry(raw: unknown, options: ParseOptions = {}): ParsedRegistry {
  if (!isObject(raw) || !Array.isArray(raw.agents))
    throw new Error("Not an agent registry (no agents list).");
  if (raw.agents.length > MAX_AGENTS) throw new Error("The registry lists too many agents.");
  const version = typeof raw.version === "string" ? raw.version.slice(0, 40) : "";
  const agents: RegistryAgent[] = [];
  const skipped: ParsedRegistry["skipped"] = [];
  const seen = new Set<string>();
  raw.agents.forEach((a, i) => {
    const id = isObject(a) && typeof a.id === "string" ? a.id.slice(0, 64) : `#${i}`;
    try {
      const agent = parseAgent(a, options.allowLoopback === true);
      if (seen.has(agent.id)) throw new Bad("listed twice");
      seen.add(agent.id);
      agents.push(agent);
    } catch (err) {
      if (!(err instanceof Bad)) throw err;
      skipped.push({ id, reason: err.message });
    }
  });
  return { version, agents, skipped };
}

/** How an agent would run here: the first of binary (for this platform), npx, uvx. */
export type RunChoice =
  | { kind: "binary"; target: BinaryTarget }
  | { kind: "npx"; dist: PackageDistribution }
  | { kind: "uvx"; dist: PackageDistribution };

export function runChoices(agent: RegistryAgent, platform: RegistryPlatform | null): RunChoice[] {
  const out: RunChoice[] = [];
  const target = platform ? agent.distribution.binary?.[platform] : undefined;
  if (target) out.push({ kind: "binary", target });
  if (agent.distribution.npx) out.push({ kind: "npx", dist: agent.distribution.npx });
  if (agent.distribution.uvx) out.push({ kind: "uvx", dist: agent.distribution.uvx });
  return out;
}

/**
 * The way to run it: a binary download first (pinned, often checksum-verified, no runtime
 * needed); else npx when Node.js is there, uvx when uv is; else the first one (whose missing
 * runtime the UI names).
 */
export function chooseRun(
  agent: RegistryAgent,
  platform: RegistryPlatform | null,
  have: { npx: boolean; uvx: boolean },
): RunChoice | null {
  const all = runChoices(agent, platform);
  return all.find((c) => c.kind === "binary" || have[c.kind]) ?? all[0] ?? null;
}

/** The program a binary agent's command is when it's installed on PATH (`./dist/kimi.exe` → kimi). */
export function pathProgram(target: BinaryTarget): string | null {
  const base = target.cmd.replace(/\\/g, "/").split("/").pop() ?? "";
  const name = base.replace(/\.(exe|cmd|bat)$/i, "");
  // A platform-suffixed raw binary (sigit-linux-amd64) isn't what a person would have on PATH.
  if (!/^[A-Za-z0-9][\w.-]{0,63}$/.test(name) || /-(linux|darwin|win|windows|macos)\b/i.test(name))
    return null;
  return name;
}

export interface LaunchConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The command line for an npx / uvx agent (`npx -y <package> …`, `uvx <package> …`). */
export function packageLaunch(kind: "npx" | "uvx", dist: PackageDistribution): LaunchConfig {
  return {
    command: kind,
    args: kind === "npx" ? ["-y", dist.package, ...dist.args] : [dist.package, ...dist.args],
    env: { ...dist.env },
  };
}

/** The name an agent gets in the model menu (`acp/<name>`): its own, unless that's taken. */
export function agentDisplayName(
  agent: Pick<RegistryAgent, "id" | "name">,
  all: readonly Pick<RegistryAgent, "id" | "name">[],
  taken: ReadonlySet<string>,
): string {
  const presetFor = Object.values(PRESET_REGISTRY_IDS).includes(agent.id);
  const shared = all.some((a) => a.id !== agent.id && a.name === agent.name);
  // Two registry agents with one name (GitHub's two Copilots): the preset's keeps it.
  if ((shared && !presetFor) || taken.has(agent.name)) return `${agent.name} (${agent.id})`;
  return agent.name;
}

/** Agents whose name, id, description or authors match `query` (all words), in order. */
export function filterAgents<T extends RegistryAgent>(agents: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...agents];
  return agents.filter((a) => {
    const hay = `${a.name} ${a.id} ${a.description} ${a.authors.join(" ")}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Compares two versions the way people read them (1.10.0 after 1.9.2; 2026.10.22 dates). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    const nx = /^\d+$/.test(x) ? Number(x) : Number.NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : Number.NaN;
    const c =
      !Number.isNaN(nx) && !Number.isNaN(ny)
        ? nx - ny
        : x.localeCompare(y, "en", { numeric: true });
    if (c !== 0) return c < 0 ? -1 : 1;
  }
  return 0;
}

// ---- Installed agents (kept in the global state, D215) ------------------------------------------

export type InstallKind = "binary" | "npx" | "uvx" | "path";

export interface InstalledAgent {
  id: string;
  /** Its name in the model menu (`acp/<name>`). */
  name: string;
  version: string;
  kind: InstallKind;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** binary: the download matched the registry's SHA-256. */
  verified?: boolean;
  /** binary: where it came from. */
  source?: string;
  license?: string;
  installedAt: number;
}

/** One stored installed agent, checked (the global state file is the user's to edit). */
export function sanitizeInstalled(v: unknown): InstalledAgent | null {
  if (!isObject(v)) return null;
  try {
    const id = text(v.id, "id", 64);
    if (!ID.test(id)) return null;
    const kind = v.kind;
    if (kind !== "binary" && kind !== "npx" && kind !== "uvx" && kind !== "path") return null;
    const command = text(v.command, "command", 1000);
    return {
      id,
      name: text(v.name, "name", 120),
      version: text(v.version, "version", 64),
      kind,
      command,
      args: args(v.args, "args"),
      env: env(v.env, "env"),
      ...(typeof v.verified === "boolean" && { verified: v.verified }),
      ...(typeof v.source === "string" && v.source.length < 1000 && { source: v.source }),
      ...(typeof v.license === "string" && v.license.length < 100 && { license: v.license }),
      installedAt: typeof v.installedAt === "number" ? v.installedAt : 0,
    };
  } catch {
    return null;
  }
}

export function sanitizeInstalledMap(v: unknown): Record<string, InstalledAgent> {
  if (!isObject(v)) return {};
  const out: Record<string, InstalledAgent> = {};
  for (const [id, entry] of Object.entries(v)) {
    const a = sanitizeInstalled(entry);
    if (a && a.id === id) out[id] = a;
  }
  return out;
}

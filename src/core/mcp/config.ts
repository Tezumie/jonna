// Which MCP servers the agent uses (D193), from every place people keep them: the IDE's own
// `agent.mcpServers`, the folder's `.vscode/mcp.json` / `<IDE folder>/mcp.json` / `.mcp.json`, the
// configs of other tools on this machine (Claude Desktop, Claude Code, Cursor, VS Code — when
// discovery is on) and extensions. Variables follow VS Code: `${workspaceFolder}`, `${userHome}`,
// `${env:NAME}` (filled in by Rust) and `${input:id}` (asked once; password inputs are stored as
// secrets and also filled in by Rust, never kept in the webview). DOM-free, tested.

import type { McpInput, McpServerConfig } from "../settings/vscodeImport";

export type McpSourceKind = "settings" | "workspace" | "discovered" | "extension";

export interface McpSource {
  /** Shown in the status: "settings", ".vscode/mcp.json", "Claude Desktop"… */
  label: string;
  kind: McpSourceKind;
  servers: Record<string, McpServerConfig & { enabled?: boolean }>;
  inputs: McpInput[];
}

export interface ResolvedServer {
  name: string;
  config: McpServerConfig;
  source: McpSource;
}

/**
 * One server per name: the first source that has it wins (settings, then the folder's files, then
 * other tools', then extensions). `"enabled": false` in an earlier source turns the name off.
 */
export function mergeServers(sources: readonly McpSource[]): ResolvedServer[] {
  const seen = new Set<string>();
  const out: ResolvedServer[] = [];
  for (const source of sources)
    for (const [name, config] of Object.entries(source.servers)) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (config.enabled === false) continue;
      if (!config.command && !config.url) continue;
      const { enabled: _enabled, ...rest } = config;
      out.push({ name, config: rest, source });
    }
  return out;
}

const INPUT = /\$\{input:([^}]+)\}/g;

/** Every string a server's config passes on (where variables can appear). */
function strings(c: McpServerConfig): string[] {
  return [
    c.command ?? "",
    c.url ?? "",
    c.cwd ?? "",
    c.envFile ?? "",
    ...(c.args ?? []),
    ...Object.values(c.env ?? {}),
    ...Object.values(c.headers ?? {}),
  ];
}

/** The `${input:…}` ids a server's config uses, in order of appearance. */
export function inputIds(c: McpServerConfig): string[] {
  const ids: string[] = [];
  for (const s of strings(c))
    for (const m of s.matchAll(INPUT)) if (m[1] && !ids.includes(m[1])) ids.push(m[1]);
  return ids;
}

/**
 * Where a password input's value is stored (Rust secrets; `${secret:…}` reads it). Rust gives a
 * server only ids under its own `mcp.input.<server>::` (src-tauri/src/ai/secrets.rs mcp_prefix).
 */
export function secretId(server: string, input: string, identity?: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  return `mcp.input.${clean(server)}::${clean(input)}${identity ? `@${identity}` : ""}`;
}

/**
 * What a server is, beyond its name (D223): where it connects (the address as configured, its
 * query left out) or what it runs (the program and its arguments, version pins left out so an
 * update doesn't ask for the key again). `${input:…}` and other variables stay as written. A
 * folder's mcp.json naming its server "github" but pointing elsewhere is another server, so it
 * doesn't get the key stored for the user's own "github".
 */
export function serverIdentity(c: McpServerConfig): string {
  if (c.url) return `url ${c.url.split("?")[0]?.split("#")[0]?.replace(/\/+$/, "") ?? ""}`;
  const unpinned = (a: string) => a.replace(/(@|==|:)v?\d[\w.+-]*$/, "");
  // The environment and working folder count too (`NODE_OPTIONS=--require ./steal.js`, D226 audit).
  const command = (c.command ?? "").replace(/\\/g, "/");
  // An absolute path (`C:\Program Files\nodejs\npx.cmd`) is the installed program: by name. A
  // relative one (`./tools/npx`, `tools\npx.cmd`) runs a file from the folder: kept whole.
  const relative = command.includes("/") && !/^([A-Za-z]:)?\//.test(command);
  const program = relative
    ? command
    : (command.split("/").pop() ?? "").toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
  const env = Object.entries(c.env ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);
  return `run ${[program, ...(c.args ?? []).map(unpinned), ...(env.length ? ["env", ...env] : []), ...(c.cwd ? ["cwd", c.cwd] : []), ...(c.envFile ? ["envFile", c.envFile] : [])].join("\u0000")}`;
}

/** A short hash of `serverIdentity` for secret ids (SHA-256, 12 hex characters). */
export async function identityHash(c: McpServerConfig): Promise<string> {
  const bytes = new TextEncoder().encode(serverIdentity(c));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest.slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A config that names a stored secret itself (only `${input:…}` may lead to one). */
export function usesRawSecret(c: McpServerConfig): boolean {
  return strings(c).some((s) => s.includes("${secret:"));
}

/**
 * Fills in `${workspaceFolder}`, `${userHome}` and `${input:id}` (`inputs(id)` gives the value, or
 * a `${secret:…}` placeholder for a password). `${env:…}` and `${secret:…}` stay for Rust.
 */
export function substitute(
  c: McpServerConfig,
  vars: { workspaceFolder: string; userHome: string | null },
  inputs: (id: string) => string,
): McpServerConfig {
  const fill = (s: string) =>
    s
      .replaceAll("${workspaceFolder}", vars.workspaceFolder)
      .replaceAll("${userHome}", vars.userHome ?? "")
      .replace(INPUT, (_m, id: string) => inputs(id));
  const map = (o?: Record<string, string>) =>
    o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fill(v)])) : undefined;
  return {
    ...c,
    ...(c.command !== undefined && { command: fill(c.command) }),
    ...(c.url !== undefined && { url: fill(c.url) }),
    ...(c.cwd !== undefined && { cwd: fill(c.cwd) }),
    ...(c.envFile !== undefined && { envFile: fill(c.envFile) }),
    ...(c.args && { args: c.args.map(fill) }),
    ...(c.env && { env: map(c.env) }),
    ...(c.headers && { headers: map(c.headers) }),
  };
}

/** A `.env` file: `KEY=value` lines (`export`, quotes and `#` comments allowed). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m?.[1]) continue;
    let value = (m[2] ?? "").trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2)
      value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    out[m[1]] = quote === '"' ? value.replace(/\\n/g, "\n") : value;
  }
  return out;
}

/** What the user approves for a folder's server: change the command and it asks again. */
export function serverSignature(name: string, c: McpServerConfig): string {
  return JSON.stringify([name, c.command, c.args, c.url, c.cwd, c.envFile, c.env, c.headers]);
}

/** What the approval card shows: the command or address, and what it's given. */
export function describeServer(c: McpServerConfig): string {
  const lines = [c.url ?? [c.command, ...(c.args ?? [])].join(" ")];
  for (const [k, v] of Object.entries(c.env ?? {})) lines.push(`env ${k}=${v}`);
  for (const [k, v] of Object.entries(c.headers ?? {})) lines.push(`header ${k}: ${v}`);
  if (c.envFile) lines.push(`envFile ${c.envFile}`);
  return lines.join("\n");
}

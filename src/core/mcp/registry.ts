// The official MCP registry (D207, registry.modelcontextprotocol.io): searched from New MCP
// server besides the built-in gallery (gallery.ts), which stays the offline list. The API is
// `GET <base>/v0.1/servers?search=<text>&limit=<n>&version=latest` → `{ servers: [{ server,
// _meta }], metadata: { nextCursor, count } }`, and one server's latest version at
// `<base>/v0.1/servers/<name>/versions/latest` → `{ server, _meta }` (server.json's schema,
// 2025-09-29). This module builds the addresses and turns entries into gallery entries: a
// Streamable HTTP remote first (headers with `{placeholders}` become password inputs), else a
// package run by npx (npm), uvx (PyPI) or docker (OCI) with its required environment variables
// and arguments as inputs. Entries the IDE can't run (SSE-only remotes, other registries) are
// kept out. DOM-free and tested; extensions/agent/mcpRegistry.ts fetches.
import type { GalleryEntry, GalleryInput } from "./gallery";
import { parseIcons } from "./icons";

export const DEFAULT_REGISTRY = "https://registry.modelcontextprotocol.io";

interface Variable {
  description?: string;
  isSecret?: boolean;
  isRequired?: boolean;
  default?: string;
  value?: string;
  /** The allowed values (D223: asked as a pick, not typed). */
  choices?: string[];
  /** "string" (default), "number", "boolean", "filepath". */
  format?: string;
}

interface Header extends Variable {
  name?: string;
}

interface Argument extends Variable {
  type?: "positional" | "named";
  name?: string;
  valueHint?: string;
  variables?: Record<string, Variable>;
}

interface EnvVar extends Variable {
  name?: string;
  variables?: Record<string, Variable>;
}

interface Package {
  registryType?: string;
  identifier?: string;
  version?: string;
  runtimeHint?: string;
  transport?: { type?: string; url?: string };
  runtimeArguments?: Argument[];
  packageArguments?: Argument[];
  environmentVariables?: EnvVar[];
}

interface Remote {
  type?: string;
  /** May hold `{name}` placeholders named in `variables` (a tenant, a region; D223). */
  url?: string;
  headers?: Header[];
  variables?: Record<string, Variable>;
}

/** One server.json, the parts used. */
export interface RegistryServer {
  name: string;
  title?: string;
  description?: string;
  version?: string;
  websiteUrl?: string;
  repository?: { url?: string };
  remotes?: Remote[];
  packages?: Package[];
  /** `[{ src, mimeType, sizes, theme }]` (checked by icons.ts before it's shown). */
  icons?: unknown;
}

/** The base without a trailing slash, or null when it isn't an http(s) address. */
export function registryBase(setting: unknown): string | null {
  const raw = typeof setting === "string" && setting.trim() ? setting.trim() : DEFAULT_REGISTRY;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

export function registrySearchUrl(base: string, query: string, limit = 30): string {
  const q = new URLSearchParams({ limit: String(limit), version: "latest" });
  if (query.trim()) q.set("search", query.trim());
  return `${base}/v0.1/servers?${q}`;
}

export function registryServerUrl(base: string, name: string): string {
  return `${base}/v0.1/servers/${encodeURIComponent(name)}/versions/latest`;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function readServer(v: unknown): RegistryServer | null {
  const server = isObject(v) && isObject(v.server) ? v.server : v;
  if (!isObject(server) || typeof server.name !== "string" || !server.name) return null;
  return server as unknown as RegistryServer;
}

/** A search answer's servers (the latest version of each; entries without a name dropped). */
export function parseRegistryList(json: unknown): RegistryServer[] {
  if (!isObject(json) || !Array.isArray(json.servers)) return [];
  const seen = new Set<string>();
  const out: RegistryServer[] = [];
  for (const item of json.servers) {
    const server = readServer(item);
    if (!server || seen.has(server.name)) continue;
    // A deleted or deprecated entry isn't offered.
    const official = isObject(item) && isObject(item._meta) ? item._meta : {};
    const status = Object.values(official).find(isObject)?.status;
    if (status === "deleted" || status === "deprecated") continue;
    seen.add(server.name);
    out.push(server);
  }
  return out;
}

/** One server's answer (`{ server, _meta }`). */
export function parseRegistryServer(json: unknown): RegistryServer | null {
  return readServer(json);
}

/** An input id from a variable or header name: lower case, letters, digits and hyphens. */
const inputId = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "value";

/** A gallery id from the registry name ("io.github.acme/weather-mcp" → "weather-mcp"). */
export function registryId(name: string): string {
  const last = name.split("/").pop() ?? name;
  return (
    last
      .replace(/[^\w-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "server"
  );
}

class Inputs {
  readonly list: GalleryInput[] = [];
  add(name: string, v: Variable | undefined, fallback: string): string {
    const id = inputId(name);
    const secret = v?.isSecret === true;
    const choices = Array.isArray(v?.choices)
      ? v.choices.filter((c): c is string => typeof c === "string" && c.length > 0).slice(0, 100)
      : [];
    if (!this.list.some((i) => i.id === id))
      this.list.push({
        id,
        description: v?.description || fallback,
        password: secret,
        ...(choices.length && !secret && { options: choices }),
        ...(!secret && typeof v?.default === "string" && { default: v.default }),
      });
    return `\${input:${id}}`;
  }
}

/** `{name}` placeholders in a value become inputs (`${input:name}`). */
function fill(
  value: string,
  variables: Record<string, Variable> | undefined,
  inputs: Inputs,
  secret: boolean,
  what: string,
): string {
  return value.replace(/\{([A-Za-z_][\w-]*)\}/g, (_m, name: string) => {
    const v = variables?.[name];
    return inputs.add(name, { ...v, isSecret: v?.isSecret ?? secret }, `${what}: ${name}`);
  });
}

/**
 * A named argument that is a flag: `format: "boolean"`, or nothing to ask or fill in (no value,
 * default, choices, hint or description; listed to be passed as it is, like `--stdio`). A bare
 * one is passed unless its value says "false". A boolean one is passed only when its value or
 * default says "true", or when it's required: anyone can publish to the registry, and an
 * optional `--allow-write` mustn't switch itself on.
 */
function flagOf(a: Argument): { flag: true; on: boolean } | null {
  if (a.type !== "named" || !a.name) return null;
  const bare =
    a.value === undefined &&
    a.default === undefined &&
    !a.choices?.length &&
    !a.valueHint &&
    !a.description &&
    !a.isSecret &&
    !a.variables;
  if (a.format !== "boolean" && !bare) return null;
  const set = (a.value ?? a.default)?.trim().toLowerCase();
  if (set !== undefined) return { flag: true, on: set === "true" || (bare && set !== "false") };
  return { flag: true, on: bare || a.isRequired === true };
}

function argumentsOf(list: Argument[] | undefined, inputs: Inputs): string[] | null {
  const out: string[] = [];
  for (const a of list ?? []) {
    // A flag has no value of its own (`--readonly`): its name is passed, or nothing.
    const flag = flagOf(a);
    if (flag) {
      if (flag.on && a.name) out.push(a.name);
      continue;
    }
    const raw = a.value ?? a.default;
    let value: string | null = null;
    // An argument with choices and no fixed value is picked when the server starts (D223), its
    // default first.
    if (a.value === undefined && Array.isArray(a.choices) && a.choices.length)
      value = inputs.add(
        a.name ?? a.valueHint ?? "argument",
        a,
        a.description ?? `${a.name ?? a.valueHint ?? "argument"}`,
      );
    else if (raw !== undefined)
      value = fill(raw, a.variables, inputs, a.isSecret === true, a.name ?? "argument");
    else if (a.isRequired)
      value = inputs.add(
        a.name ?? a.valueHint ?? "argument",
        a,
        a.description ?? `${a.name ?? a.valueHint ?? "argument"}`,
      );
    if (a.type === "named") {
      if (!a.name) continue;
      if (value === null && !a.isRequired) continue;
      out.push(a.name);
      if (value !== null) out.push(value);
    } else if (value !== null) out.push(value);
    else if (a.isRequired) return null;
  }
  return out;
}

/**
 * The programs each package type may run with (`runtimeHint`): anyone can publish to the
 * registry, so a hint naming another program (a shell, curl) isn't taken; the default is.
 */
const RUNTIMES: Record<string, readonly string[]> = {
  npm: ["npx", "bunx", "pnpx"],
  pypi: ["uvx", "pipx"],
  oci: ["docker", "podman"],
};

/**
 * A package name or image the runner gets as an argument: not an option (`-c=…` would make npx
 * run a shell command) and no whitespace or shell characters.
 */
const SAFE_IDENTIFIER = /^[A-Za-z0-9@][\w@./:+~-]*$/;

/** What a runner's options would do that the user must know of, or what makes it refused. */
export interface RunnerRisks {
  /** Why the entry isn't offered at all. */
  refuse: string | null;
  /** What the install question shows. */
  warnings: string[];
}

/** Host folders a container must never get (the whole disk, system folders, docker's socket). */
const SYSTEM_MOUNT =
  /^(\/|~|\$HOME|\$\{userHome\}|[A-Za-z]:[\\/]?|\/(etc|var|usr|root|home|proc|sys|dev|boot|bin|sbin|lib|lib64|opt|private|run|mnt|media|snap|Users|System|Library|Volumes)(\/.*)?|.*docker\.sock|[A-Za-z]:[\\/](Windows|Users|Program Files|ProgramData)([\\/].*)?)$/i;

/** A host path made comparable: `\\?\` gone, `.` / `..` / repeated slashes folded, no trailing slash. */
function normalizeHostPath(raw: string): string {
  let p = raw
    .trim()
    .replace(/^\\\\\?\\/, "")
    .replace(/^["']|["']$/g, "");
  const drive = /^[A-Za-z]:/.test(p) ? p.slice(0, 2) : "";
  p = p.slice(drive.length).replace(/\\/g, "/");
  const absolute = p.startsWith("/");
  const parts: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const body = (absolute || drive ? "/" : "") + parts.join("/");
  return drive ? `${drive}${body}` : body || (absolute ? "/" : "");
}

/** CSV fields of `--mount` (docker reads it as CSV: quotes allowed, keys case-insensitive). */
function mountFields(value: string): Map<string, string> {
  const out = new Map<string, string>();
  let field = "";
  let quote = false;
  const push = () => {
    const f = field.trim().replace(/^"|"$/g, "");
    const eq = f.indexOf("=");
    if (eq > 0)
      out.set(
        f.slice(0, eq).trim().toLowerCase(),
        f
          .slice(eq + 1)
          .trim()
          .replace(/^"|"$/g, ""),
      );
    else if (f) out.set(f.toLowerCase(), "");
    field = "";
  };
  for (const ch of value) {
    if (ch === '"') quote = !quote;
    if (ch === "," && !quote) push();
    else field += ch;
  }
  push();
  return out;
}

/** A mount's host side (`-v src:dst[:ro]`, `--mount type=bind,source=src,…`), or null. */
function mountSource(flag: string, value: string): string | null {
  if (flag === "--mount") {
    const fields = mountFields(value);
    return fields.get("source") ?? fields.get("src") ?? null;
  }
  // A Windows drive letter's colon isn't the separator ("C:\data:/data").
  const v = value.replace(/^\\\\\?\\/, "");
  const drive = /^[A-Za-z]:[\\/]/.test(v) ? v.slice(0, 2) : "";
  const rest = v.slice(drive.length);
  const at = rest.indexOf(":");
  if (at < 0) return null; // a named volume or an anonymous one: nothing of the host
  const source = drive + rest.slice(0, at);
  // A named volume ("data:/data") isn't a host path.
  return /[\\/~$.]/.test(source) || drive ? source : null;
}

/** Docker's short options that take a value (`-v x`, `-vx`, `-v=x`, `-itv x`). */
const DOCKER_SHORT_VALUE = new Set(["v", "p", "u", "e", "w", "l", "h", "m", "c", "a"]);
const DOCKER_SHORT_NAMES: Record<string, string> = { v: "-v", p: "-p", u: "-u" };

/** Options as [flag, value] pairs, the way the runner itself would read them. */
function readOptions(t: string, runtime: readonly string[]): [string, string][] {
  const takesValue: Record<string, readonly string[]> = {
    oci: [
      "--volume",
      "--mount",
      "--network",
      "--net",
      "--pid",
      "--ipc",
      "--uts",
      "--userns",
      "--cgroupns",
      "--cap-add",
      "--device",
      "--security-opt",
      "--user",
      "--publish",
      "--env-file",
      "--add-host",
    ],
    npm: ["-p", "--package", "--registry", "-c", "--call", "--node-options", "--script-shell"],
    pypi: ["--index-url", "-i", "--extra-index-url", "--from", "--with", "--python", "-p"],
  };
  const options: [string, string][] = [];
  for (let i = 0; i < runtime.length; i++) {
    const arg = runtime[i] ?? "";
    const eq = arg.indexOf("=");
    if (arg.startsWith("--")) {
      if (eq > 0) options.push([arg.slice(0, eq), arg.slice(eq + 1)]);
      else if (takesValue[t]?.includes(arg)) options.push([arg, runtime[++i] ?? ""]);
      else options.push([arg, ""]);
    } else if (arg.startsWith("-") && arg.length > 1) {
      if (t === "oci") {
        // Combined short flags: the first one that takes a value takes the rest (or the next arg).
        const letters = arg.slice(1);
        for (let k = 0; k < letters.length; k++) {
          const letter = letters[k] as string;
          if (!DOCKER_SHORT_VALUE.has(letter)) {
            options.push([`-${letter}`, ""]);
            continue;
          }
          const rest = letters.slice(k + 1).replace(/^=/, "");
          const value = rest || runtime[++i] || "";
          options.push([DOCKER_SHORT_NAMES[letter] ?? `-${letter}`, value]);
          break;
        }
      } else if (eq > 0) options.push([arg.slice(0, eq), arg.slice(eq + 1)]);
      else if (takesValue[t]?.includes(arg)) options.push([arg, runtime[++i] ?? ""]);
      else if (t === "npm" && /^-c./.test(arg)) options.push(["-c", arg.slice(2)]);
      else options.push([arg, ""]);
    } else options.push([arg, ""]);
  }
  return options;
}

/** What the user is asked for an input: its default and its choices (each is judged). */
export interface InputValues {
  default?: string;
  options?: readonly string[];
}

/**
 * Each concrete form an argument can take: every input it names replaced by its default, by each
 * of its choices, and by "" (what the user types isn't judged, but the fixed text around it is:
 * `/:/host/${input:x}` still mounts `/`).
 */
function expansions(arg: string, inputs: ReadonlyMap<string, InputValues>): string[] {
  const refs = [...arg.matchAll(/\$\{input:([^}]+)\}/g)].map((m) => m[1] as string);
  if (!refs.length) return [arg];
  let forms = [arg];
  for (const id of new Set(refs)) {
    const v = inputs.get(id);
    const values = new Set(["", ...(v?.default ? [v.default] : []), ...(v?.options ?? [])]);
    const token = `\${input:${id}}`;
    forms = forms.flatMap((f) => [...values].map((x) => f.split(token).join(x)));
    if (forms.length > 200) forms = forms.slice(0, 200);
  }
  return forms;
}

/**
 * The runner's options from a registry entry checked (D223): anyone can publish there, so
 * `docker run --privileged -v /:/host`, `npx -c 'curl … | sh'` and the like are refused, and
 * options that reach beyond the package (other package indexes, host folders, ports) are shown
 * before installing. Options are read as the runner reads them (short flags combined or with the
 * value attached, `--mount` as CSV); inputs are judged with their defaults and choices, and the
 * fixed text around a typed value is judged too.
 */
export function runnerRisks(
  type: string,
  runtime: readonly string[],
  inputs: ReadonlyMap<string, InputValues> = new Map(),
): RunnerRisks {
  const t = type.toLowerCase();
  const warnings: string[] = [];
  // Every combination of the arguments' forms (capped) is read and judged.
  let combos: string[][] = [[...runtime]];
  runtime.forEach((arg, i) => {
    const list = expansions(arg, inputs);
    if (list.length === 1 && list[0] === arg) return;
    combos = combos.flatMap((c) => list.map((x) => c.map((y, j) => (j === i ? x : y))));
    if (combos.length > 400) combos = combos.slice(0, 400);
  });
  for (const args of combos) {
    const why = judge(t, args, warnings);
    if (why) return { refuse: why, warnings };
  }
  return { refuse: null, warnings: [...new Set(warnings)] };
}

/** The reason a set of concrete runner options is refused, or null (warnings are collected). */
function judge(t: string, runtime: readonly string[], warnings: string[]): string | null {
  for (const [flag, value] of readOptions(t, runtime)) {
    if (t === "oci") {
      if (flag === "--privileged") return "it runs the container with --privileged";
      if (
        ["--pid", "--network", "--net", "--ipc", "--uts", "--userns", "--cgroupns"].includes(
          flag,
        ) &&
        value.trim().toLowerCase() === "host"
      )
        return `it shares the computer's ${flag.slice(2)} with the container`;
      if (flag === "--cap-add" || flag === "--device" || flag === "--security-opt")
        return `it gives the container ${flag} ${value}`.trim();
      if (flag === "-v" || flag === "--volume" || flag === "--mount") {
        const raw = mountSource(flag, value);
        if (raw === null) continue;
        const source = normalizeHostPath(raw);
        if (!source) continue; // nothing fixed: the user types the folder
        if (SYSTEM_MOUNT.test(source)) return `it mounts ${raw} into the container`;
        warnings.push(`mounts ${source} from this computer`);
      } else if (flag === "--network" || flag === "--net") {
        if (value !== "none" && value !== "bridge") warnings.push(`uses the ${value} network`);
      } else if ((flag === "-u" || flag === "--user") && /^(0|root)(:|$)/.test(value))
        warnings.push("runs as root in the container");
      else if (flag === "-p" || flag === "--publish") warnings.push(`opens port ${value}`);
      else if (flag === "--env-file") warnings.push(`reads environment from ${value}`);
      else if (flag === "--add-host") warnings.push(`adds host ${value}`);
    } else if (t === "npm") {
      if (["-c", "--call", "--node-options", "--script-shell", "--shell"].includes(flag))
        return `it passes ${flag} to npx (runs a command of its own)`;
      if (flag === "--registry") warnings.push(`installs from ${value} instead of npm`);
      else if (flag === "-p" || flag === "--package")
        warnings.push(`installs another package too: ${value}`);
    } else if (t === "pypi") {
      if (flag === "--index-url" || flag === "-i" || flag === "--extra-index-url")
        warnings.push(`installs from ${value} instead of PyPI`);
      else if (flag === "--from") warnings.push(`installs from ${value}`);
      else if (flag === "--with") warnings.push(`installs ${value} too`);
      else if (flag === "--python" || flag === "-p") warnings.push(`runs with Python ${value}`);
    }
  }
  return null;
}

function runPackage(
  p: Package,
  inputs: Inputs,
  risks?: { warnings: string[]; refused: string | null },
): GalleryEntry["config"] | null {
  if (p.transport?.type && p.transport.type !== "stdio") return null;
  if (!p.identifier || !SAFE_IDENTIFIER.test(p.identifier)) return null;
  if (p.version !== undefined && !SAFE_IDENTIFIER.test(p.version)) return null;
  const type = (p.registryType ?? "").toLowerCase();
  const hint = p.runtimeHint && RUNTIMES[type]?.includes(p.runtimeHint) ? p.runtimeHint : "";
  const runtime = argumentsOf(p.runtimeArguments, inputs);
  const packageArgs = argumentsOf(p.packageArguments, inputs);
  if (!runtime || !packageArgs) return null;
  const checked = runnerRisks(
    type,
    runtime,
    new Map(inputs.list.map((i) => [i.id, { default: i.default, options: i.options }])),
  );
  if (risks) {
    risks.warnings.push(...checked.warnings);
    risks.refused = checked.refuse;
  }
  if (checked.refuse) return null;
  let command: string;
  let args: string[];
  if (type === "npm") {
    command = hint || "npx";
    args = [
      ...(runtime.length ? runtime : ["-y"]),
      p.version ? `${p.identifier}@${p.version}` : p.identifier,
    ];
  } else if (type === "pypi") {
    command = hint || "uvx";
    args = [...runtime, p.version ? `${p.identifier}==${p.version}` : p.identifier];
  } else if (type === "oci") {
    command = hint || "docker";
    const image =
      p.version && !p.identifier.includes(":") ? `${p.identifier}:${p.version}` : p.identifier;
    args = ["run", "-i", "--rm", ...runtime, image];
  } else return null;
  const env: Record<string, string> = {};
  for (const e of p.environmentVariables ?? []) {
    if (!e.name) continue;
    if (e.value !== undefined)
      env[e.name] = fill(e.value, e.variables, inputs, e.isSecret === true, e.name);
    else if (e.isRequired || e.isSecret)
      env[e.name] = inputs.add(e.name, e, e.description ?? e.name);
  }
  return {
    type: "stdio",
    command,
    args: [...args, ...packageArgs],
    ...(Object.keys(env).length && { env }),
  };
}

const NEEDS: Record<string, string> = { npx: "Node.js", uvx: "uv (Python)", docker: "Docker" };

/** A registry server as a gallery entry the IDE can install, or null when it can't run it. */
export function registryEntry(server: RegistryServer): GalleryEntry | null {
  const inputs = new Inputs();
  const homepage = server.websiteUrl || server.repository?.url || "";
  const icons = parseIcons(server.icons);
  const base = {
    id: registryId(server.name),
    title: server.title || registryId(server.name),
    description: (server.description ?? "").slice(0, 300),
    category: "work" as const,
    homepage,
    ...(icons.length && { icons }),
  };
  const remote = (server.remotes ?? []).find(
    (r) => r.type === "streamable-http" && typeof r.url === "string" && /^https?:\/\//.test(r.url),
  );
  if (remote?.url) {
    const headers: Record<string, string> = {};
    for (const h of remote.headers ?? []) {
      if (!h.name) continue;
      if (h.value) headers[h.name] = fill(h.value, undefined, inputs, h.isSecret !== false, h.name);
      else if (h.isRequired || h.isSecret)
        headers[h.name] = inputs.add(
          h.name,
          { ...h, isSecret: h.isSecret ?? true },
          h.description ?? h.name,
        );
    }
    // `{tenant}` in the address (D223): asked when the server starts, like a header's value.
    const url = fill(remote.url, remote.variables, inputs, false, "address");
    return {
      ...base,
      kind: "remote",
      config: { type: "http", url, ...(Object.keys(headers).length && { headers }) },
      ...(inputs.list.length && { inputs: inputs.list }),
    };
  }
  for (const p of server.packages ?? []) {
    const attempt = new Inputs();
    const risks = { warnings: [] as string[], refused: null as string | null };
    const config = runPackage(p, attempt, risks);
    if (!config) continue;
    return {
      ...base,
      kind: "local",
      config,
      ...(attempt.list.length && { inputs: attempt.list }),
      needs: NEEDS[config.command ?? ""] ?? config.command ?? "",
      ...(risks.warnings.length && { warnings: risks.warnings }),
    };
  }
  return null;
}

/** Why none of a registry server's packages is offered (a refused runner option), or null. */
export function registryRefusal(server: RegistryServer): string | null {
  for (const p of server.packages ?? []) {
    const risks = { warnings: [] as string[], refused: null as string | null };
    runPackage(p, new Inputs(), risks);
    if (risks.refused) return risks.refused;
  }
  return null;
}

// What of an mcp.json may go into a team's library, DOM-free. A member's own file often holds
// keys; a library is read by everyone in the team. So a server is published only when what it
// is given (`env`, `headers`, and what its arguments and address carry) holds no literal secret:
// a secret is written as `${input:id}` (each member is asked once, and theirs stays on their
// computer) or `${env:NAME}`.
import { type McpServerConfig, parseMcpConfig } from "../settings/vscodeImport";

/** Names of things that are secrets (an env variable, a header). */
const SECRET_NAME =
  /(token|secret|password|passwd|pwd|api[-_]?key|apikey|access[-_]?key|private[-_]?key|credential|authorization|auth|cookie|session|bearer|signature)/i;
/** What keys of well-known services start with. */
const SECRET_SHAPE =
  /(^|[^A-Za-z0-9])(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{10,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/;
const PLACEHOLDER = /\$\{(input|env|workspaceFolder|userHome)(:[^}]*)?\}/g;

/** What is left of a value once its placeholders (and a scheme word in front) are taken out. */
function literalPart(value: string): string {
  return value
    .replace(PLACEHOLDER, "")
    .replace(/^\s*(bearer|basic|token)\s+/i, "")
    .trim();
}

/** A run of 24 or more key-like characters with letters and digits: a key, not a word or a path. */
function longToken(text: string): boolean {
  return (text.match(/[A-Za-z0-9_+=-]{24,}/g) ?? []).some(
    (run) => /[A-Za-z]/.test(run) && /[0-9]/.test(run),
  );
}

/** Whether a value carries something that reads as a secret, whatever it is called. */
function secretLooking(value: string): boolean {
  if (value.includes("${secret:")) return true;
  const literal = literalPart(value);
  return SECRET_SHAPE.test(literal) || longToken(literal) || /:\/\/[^/\s:@]+:[^/\s@]+@/.test(value);
}

/**
 * Why a server can't be published as it is (null: it can). A value under a name that says
 * "secret" must be a placeholder and nothing else; any other value mustn't read as a key.
 */
export function literalSecretIn(config: McpServerConfig): string | null {
  for (const [where, values] of [
    ["env", config.env ?? {}],
    ["headers", config.headers ?? {}],
  ] as const)
    for (const [name, value] of Object.entries(values)) {
      if (SECRET_NAME.test(name) ? literalPart(value) !== "" : secretLooking(value))
        return `${where} ${name}`;
    }
  for (const arg of config.args ?? []) if (secretLooking(arg)) return "an argument";
  if (
    config.url &&
    (secretLooking(config.url) || /[?&][^=&]*(token|key|secret)[^=&]*=[^&$]/i.test(config.url))
  )
    return "its address";
  return null;
}

/**
 * The `mcp.json` to publish from the text of one of the user's (`only`: the servers to take,
 * by name; all of them without it): servers and the inputs they use, in VS Code's shape, and
 * nothing else of the file. Refused, saying which server and where, when one holds a literal
 * secret.
 */
export function mcpForTeam(
  json: unknown,
  only?: readonly string[],
): { ok: true; text: string; servers: string[] } | { ok: false; reason: string } {
  const parsed = parseMcpConfig(json);
  const names = Object.keys(parsed.servers).filter((name) => !only || only.includes(name));
  const missing = (only ?? []).filter((name) => !(name in parsed.servers));
  if (missing.length)
    return { ok: false, reason: `No MCP server named ${missing.join(", ")} in your mcp.json.` };
  if (!names.length) return { ok: false, reason: "There is no MCP server to publish." };
  const servers: Record<string, McpServerConfig> = {};
  const used = new Set<string>();
  for (const name of names.sort()) {
    const config = parsed.servers[name];
    if (!config) continue;
    const secret = literalSecretIn(config);
    if (secret)
      return {
        ok: false,
        reason: `The MCP server ${name} has a secret written out (${secret}). Write it as \${input:name} so each member is asked for their own, then publish.`,
      };
    servers[name] = config;
    for (const text of JSON.stringify(config).matchAll(/\$\{input:([^}]+)\}/g))
      if (text[1]) used.add(text[1]);
  }
  // Only what describes an input: never a value someone typed into one.
  const inputs = parsed.inputs
    .filter((i) => used.has(i.id))
    .map((i) => ({
      id: i.id,
      type: i.options?.length ? "pickString" : "promptString",
      description: i.description,
      ...(i.password && { password: true }),
      ...(i.options?.length && { options: i.options }),
    }));
  return {
    ok: true,
    servers: Object.keys(servers),
    text: `${JSON.stringify({ servers, ...(inputs.length && { inputs }) }, null, 2)}\n`,
  };
}

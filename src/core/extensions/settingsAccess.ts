// Which settings an extension's code may read (`ide.settings.get`, D202). Its own, the editor's,
// the workbench's and the files' ones always; others only when its manifest lists them in
// `readsSettings` (exact keys or "prefix.*"). Areas that hold credentials or say where they go
// (agent, AI, MCP, accounts, HTTP proxies) are never readable, nor any key named like a secret.
// DOM-free and unit-tested.

/** Setting areas an extension can never read, whatever its manifest says. */
// lsp.* holds language servers' commands and env (API keys for some servers).
export const BLOCKED_SETTING_PREFIXES = [
  "agent.",
  "ai.",
  "mcp.",
  "accounts.",
  "http.",
  "lsp.",
] as const;

/** Areas every extension may read (they hold no secrets and are about how files look). */
const ALWAYS_READABLE = ["editor.", "workbench.", "files."] as const;

/** Words in a key that suggest a secret ("apiKey", "auth_token", "github.password"). */
const SECRET_WORDS = new Set([
  "token",
  "tokens",
  "secret",
  "secrets",
  "password",
  "passwords",
  "passwd",
  "apikey",
  "key",
  "credential",
  "credentials",
  "auth",
  "cookie",
  "cookies",
]);

/** The words of a key: split at dots, dashes, underscores and camelCase humps. */
function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s._-]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

/** Whether a key looks like it holds a secret (a word match, so "keybindings" is fine). */
export function isSecretLikeSetting(key: string): boolean {
  const list = words(key);
  for (let i = 0; i < list.length; i++) {
    const w = list[i] ?? "";
    if (SECRET_WORDS.has(w)) return true;
    // "api" + "key" split by camelCase ("apiKey").
    if (w === "api" && list[i + 1] === "key") return true;
  }
  return false;
}

export function isBlockedSetting(key: string): boolean {
  return BLOCKED_SETTING_PREFIXES.some((p) => key.startsWith(p)) || isSecretLikeSetting(key);
}

/** "debug.pythonPath", "markdown.*": a key, or a prefix ending in ".*". */
const PATTERN = /^[A-Za-z][\w-]*(\.[A-Za-z0-9][\w-]*)*(\.\*)?$/;

/**
 * Reads the manifest's `readsSettings`; refused entries (blocked areas, secret-like names, bad
 * patterns) are reported in `errors`.
 */
export function parseReadsSettings(value: unknown, errors: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`"readsSettings" must be a list of setting keys or "prefix.*" patterns`);
    return [];
  }
  const out: string[] = [];
  for (const raw of value.slice(0, 100)) {
    if (typeof raw !== "string" || !PATTERN.test(raw) || raw === "*") {
      errors.push(`readsSettings: ${JSON.stringify(raw)} isn't a setting key or "prefix.*"`);
      continue;
    }
    const prefix = raw.endsWith(".*") ? raw.slice(0, -1) : raw;
    if (
      BLOCKED_SETTING_PREFIXES.some((p) => prefix.startsWith(p) || p.startsWith(prefix)) ||
      isSecretLikeSetting(prefix)
    ) {
      errors.push(`readsSettings: ${raw} can't be read by extensions (credentials live there)`);
      continue;
    }
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

/** Whether `key` matches one of the `readsSettings` entries. */
export function matchesReadsSettings(patterns: readonly string[], key: string): boolean {
  return patterns.some((p) =>
    p.endsWith(".*") ? key.startsWith(p.slice(0, -1)) && key.length > p.length - 1 : key === p,
  );
}

/**
 * Whether an extension may read `key`: its own settings (`own`), the always-readable areas, or
 * what `readsSettings` lists; never a blocked area or a secret-like key that isn't its own.
 */
export function canReadSetting(
  own: readonly string[],
  readsSettings: readonly string[],
  key: string,
): boolean {
  // Blocked areas first: an extension named "acme.http" can't contribute and read http.proxy.
  if (BLOCKED_SETTING_PREFIXES.some((p) => key.startsWith(p))) return false;
  if (own.includes(key)) return true;
  if (isBlockedSetting(key)) return false;
  return ALWAYS_READABLE.some((p) => key.startsWith(p)) || matchesReadsSettings(readsSettings, key);
}

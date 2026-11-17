// What a model provider's id may be. The id names the provider's key in the secrets store
// (`provider.<id>`, src-tauri/src/ai/key_slots.rs has the same rule and is the one that
// decides); a provider in the settings whose id isn't one is left out, so it is never offered,
// asked for a key or sent anything.

/** Names (and beginnings of names) other parts of the IDE keep in the secrets store. */
const RESERVED_NAMES = ["sync-device-key", "sync-keyring", "notify.webhook"];
const RESERVED_PREFIXES = [
  "provider.",
  "mcp.",
  "ext.",
  "websearch.",
  "notify.",
  "sync-",
  "sync.",
  "accounts.",
  "secrets.",
];

/** A letter or digit, then letters, digits, `_`, `-` and `.`, 64 at most, and not reserved. */
export function validProviderId(id: unknown): id is string {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) return false;
  const lower = id.toLowerCase();
  return !RESERVED_NAMES.includes(lower) && !RESERVED_PREFIXES.some((p) => lower.startsWith(p));
}

/** The provider entries of `agent.providers` that may be used: a valid id and an address. */
export function usableProviders<T extends { id: string; baseUrl: string }>(
  configured: unknown,
): T[] {
  if (!Array.isArray(configured)) return [];
  return configured.filter(
    (p): p is T =>
      !!p &&
      typeof p === "object" &&
      validProviderId((p as { id?: unknown }).id) &&
      typeof (p as { baseUrl?: unknown }).baseUrl === "string",
  );
}

// Which language servers exist: contributed by extensions, overridden or added by the user's
// `lsp.servers` setting (user scope only: a workspace must not be able to start programs — that
// needs workspace trust, M6). DOM-free, tested.
import type { LanguageServerContribution } from "../../core/extensions/index";

export interface ServerConfig extends LanguageServerContribution {
  name: string;
  /** Where it came from: an extension id, or "settings". */
  source: string;
}

/** `lsp.servers` entries: a full definition, or `{ enabled: false }` / partial overrides. */
export type UserServers = Record<
  string,
  Partial<LanguageServerContribution> & { enabled?: boolean }
>;

export function resolveServers(
  contributed: Record<string, LanguageServerContribution & { extension?: string }>,
  user: unknown,
): ServerConfig[] {
  const out = new Map<string, ServerConfig>();
  for (const [name, c] of Object.entries(contributed))
    out.set(name, { ...c, name, source: c.extension ?? "extension" });
  const entries = user && typeof user === "object" ? Object.entries(user as UserServers) : [];
  for (const [name, u] of entries) {
    if (!u || typeof u !== "object") continue;
    if (u.enabled === false) {
      out.delete(name);
      continue;
    }
    const base = out.get(name);
    const merged = { ...base, ...u, name, source: base && !u.command ? base.source : "settings" };
    // The user's settings and initialization options go over the server's own, key by key (D204:
    // the server settings page writes only what was changed).
    for (const key of ["settings", "initializationOptions"] as const) {
      const mine = u[key];
      const theirs = base?.[key];
      if (isObject(mine) && isObject(theirs)) merged[key] = deepMerge(theirs, mine);
    }
    if (typeof merged.command !== "string" || !Array.isArray(merged.languages)) continue;
    out.set(name, merged as ServerConfig);
  }
  return [...out.values()];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** `over` merged into `base`, objects key by key (arrays and values replace). */
export function deepMerge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = isObject(v) && isObject(b) ? deepMerge(b, v) : v;
  }
  return out;
}

/**
 * Expands ${workspaceFolder} (the first folder: one server has the whole workspace) and
 * ${workspaceFolder:Name} (a folder of a multi-root workspace, D251) in arguments.
 */
export function expandArgs(
  args: readonly string[] | undefined,
  root: string,
  folders: readonly { name: string; path: string }[] = [],
): string[] {
  return (args ?? []).map((a) =>
    a.replace(/\$\{workspaceFolder(?::([^}]+))?\}/g, (whole, name: string | undefined) =>
      name === undefined ? root : (folders.find((f) => f.name === name)?.path ?? whole),
    ),
  );
}

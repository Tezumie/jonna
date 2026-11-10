// The extensions registry (`<appData>/extensions/registry.json`, D102): folders loaded unpacked,
// disabled ids and the permissions the user granted. DOM-free.
import type { ThirdPartyManifest } from "../../core/extensions/thirdParty";
import { type BisectState, parseBisect } from "./bisect";

export interface Registry {
  dev: string[];
  disabled: string[];
  /** id → permissions the user granted. */
  granted: Record<string, string[]>;
  /** id → the permission list the user said no to (not asked again until it changes). */
  declined: Record<string, string>;
  /** Bundled extensions the backend has seeded once (D121): kept so they aren't seeded again. */
  bundled: string[];
  /** id → the git repository it was installed from (D185), so it can be updated from there. */
  sources: Record<string, RepoSource>;
  /**
   * Bundled extensions the user replaced with their own changed copy (D189): the IDE's updates
   * to them aren't applied (the backend skips them) until the user goes back to the IDE's version.
   */
  customized: string[];
  /** Extension bisect under way (bisect.ts): its half that's off this round. */
  bisect: BisectState | null;
  /** Off in one workspace only (D258, VS Code's Disable (Workspace)): its folder → ids. */
  disabledIn: Record<string, string[]>;
  /** Each extension's own Auto update choice (D258); the rest follow extensions.autoUpdate. */
  autoUpdate: Record<string, boolean>;
  /**
   * When each was first installed (ms; kept across updates, D264). Extensions start in this
   * order, so one installed later can't take an earlier one's command ids by its folder's name.
   */
  installedAt?: Record<string, number>;
}

/**
 * The order extensions start in (D264): the earliest installed first; those with no time
 * (development copies, the IDE's own, ones from before D264) before them, as listed.
 */
export function startOrder<T extends { id: string }>(
  records: readonly T[],
  installedAt: Readonly<Record<string, number>> = {},
): T[] {
  return records
    .map((r, i) => ({ r, i, at: installedAt[r.id] ?? 0 }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map((x) => x.r);
}

export interface RepoSource {
  /** What git clones: an https URL, or what the user typed (owner/name became a GitHub URL). */
  repo: string;
  /** Branch or tag; the default branch when absent. */
  ref?: string;
  /** The extension's folder inside the repository ("" or absent: its top). */
  path?: string;
}

export function parseRegistry(text: string): Registry {
  let raw: Record<string, unknown> = {};
  try {
    const v = JSON.parse(text || "{}") as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) raw = v as Record<string, unknown>;
  } catch {
    /* a broken registry starts empty */
  }
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const granted: Record<string, string[]> = {};
  if (raw.granted && typeof raw.granted === "object")
    for (const [k, v] of Object.entries(raw.granted as Record<string, unknown>))
      granted[k] = strings(v);
  const declined: Record<string, string> = {};
  if (raw.declined && typeof raw.declined === "object")
    for (const [k, v] of Object.entries(raw.declined as Record<string, unknown>))
      if (typeof v === "string") declined[k] = v;
  const sources: Record<string, RepoSource> = {};
  if (raw.sources && typeof raw.sources === "object")
    for (const [k, v] of Object.entries(raw.sources as Record<string, unknown>)) {
      const o = (v ?? {}) as Record<string, unknown>;
      if (typeof o.repo !== "string" || !o.repo) continue;
      sources[k] = {
        repo: o.repo,
        ...(typeof o.ref === "string" && o.ref && { ref: o.ref }),
        ...(typeof o.path === "string" && o.path && { path: o.path }),
      };
    }
  const disabledIn: Record<string, string[]> = {};
  if (raw.disabledIn && typeof raw.disabledIn === "object")
    for (const [k, v] of Object.entries(raw.disabledIn as Record<string, unknown>)) {
      const ids = strings(v);
      if (ids.length) disabledIn[k] = ids;
    }
  const autoUpdate: Record<string, boolean> = {};
  if (raw.autoUpdate && typeof raw.autoUpdate === "object")
    for (const [k, v] of Object.entries(raw.autoUpdate as Record<string, unknown>))
      if (typeof v === "boolean") autoUpdate[k] = v;
  const installedAt: Record<string, number> = {};
  if (raw.installedAt && typeof raw.installedAt === "object")
    for (const [k, v] of Object.entries(raw.installedAt as Record<string, unknown>))
      if (typeof v === "number" && Number.isFinite(v) && v > 0) installedAt[k] = v;
  return {
    ...(Object.keys(installedAt).length && { installedAt }),
    sources,
    disabledIn,
    autoUpdate,
    dev: strings(raw.dev),
    disabled: strings(raw.disabled),
    granted,
    declined,
    bundled: strings(raw.bundled),
    customized: strings(raw.customized),
    bisect: parseBisect(raw.bisect),
  };
}

/** Permissions the manifest asks for that haven't been granted. */
export function missingPermissions(
  manifest: ThirdPartyManifest,
  granted: readonly string[],
): string[] {
  return manifest.permissions.filter((p) => !granted.includes(p));
}

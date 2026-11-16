// A team's library, DOM-free: what an item is, which names it may have, which items are on for
// this person, and what is to be downloaded given the list and the cache. A library comes from
// other people: every name is checked here again (Rust checks it too before it writes a file),
// and kinds this build doesn't know are left out.

/** The kinds of item this build reads (the service also has `providers`: not used). */
export const TEAM_KINDS = [
  "rules",
  "skills",
  "commands",
  "agents",
  "outputStyles",
  "snippets",
  "mcp",
  "settings",
  "extensions",
] as const;

export type TeamKind = (typeof TEAM_KINDS)[number];

/** One item of the library, as the service lists it (never its text). */
export interface TeamItem {
  id: string;
  kind: TeamKind;
  /** Its name: the same names the user's own files sync under (`skills/review/SKILL.md`). */
  path: string;
  /** On from the start for every member (a member may turn it off). */
  isDefault: boolean;
  version: number;
  size: number;
  /** Who published this version. */
  by: string;
  /** When, in ms. */
  updatedAt: number | null;
}

export function isTeamKind(kind: unknown): kind is TeamKind {
  return typeof kind === "string" && (TEAM_KINDS as readonly string[]).includes(kind);
}

const MAX_PATH_CHARS = 200;
/** `skills/<skill>/<file…>`: as deep as the user's own synced skills go. */
const MAX_SKILL_DEPTH = 6;
/** Names Windows keeps for devices, whatever follows the first dot. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const PART = /^[\p{L}\p{N}._\- ]+$/u;

/** An item's id: 1 to 64 characters of `[A-Za-z0-9_-]`. */
export function validItemId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/** One part of a name: letters, digits, `. _ -` and spaces; not hidden, not `..`, not a device. */
function plainPart(part: string): boolean {
  return (
    PART.test(part) &&
    !part.startsWith(".") &&
    !part.startsWith(" ") &&
    !part.endsWith(".") &&
    !part.endsWith(" ") &&
    !part.includes("..") &&
    !RESERVED.test(part.split(".")[0] ?? "")
  );
}

/**
 * Whether `path` is a name an item of `kind` may have: relative, of plain parts (no `..`, no
 * leading `/`, no `\` or `:`, no device name), in the shape that kind has.
 */
export function validItemPath(kind: string, path: string): boolean {
  if (!path || [...path].length > MAX_PATH_CHARS) return false;
  const parts = path.split("/");
  if (!parts.every(plainPart)) return false;
  const file = (folder: string, endings: readonly string[]) =>
    parts.length === 2 &&
    parts[0] === folder &&
    endings.some((e) => (parts[1] ?? "").length > e.length && (parts[1] ?? "").endsWith(e));
  switch (kind) {
    case "rules":
      return path === "AGENTS.md";
    case "mcp":
      return path === "mcp.json";
    case "settings":
      return path === "settings.json";
    case "extensions":
      return path === "extensions.json";
    case "skills":
      return parts[0] === "skills" && parts.length >= 3 && parts.length <= MAX_SKILL_DEPTH;
    case "commands":
      return file("commands", [".md"]);
    case "agents":
      return file("agents", [".md"]);
    case "outputStyles":
      return file("output-styles", [".md"]);
    case "snippets":
      return file("snippets", [".json", ".code-snippets"]);
    default:
      return false;
  }
}

/** The kind a name belongs to (`commands/ship.md` → commands), or null when it fits none. */
export function kindOfPath(path: string): TeamKind | null {
  return TEAM_KINDS.find((kind) => validItemPath(kind, path)) ?? null;
}

/**
 * An item's id, the same for the same kind and name wherever it is made: unpadded base64url of
 * the first 16 bytes of SHA-256 of `kind + "\0" + path` (22 characters).
 */
export async function itemId(kind: TeamKind, path: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${kind}\0${path}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).slice(0, 16);
  let binary = "";
  for (const b of digest) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The usable items of a list (from the service, or from the cache): the rest is left out. */
export function teamItems(raw: unknown): TeamItem[] {
  const out: TeamItem[] = [];
  const ids = new Set<string>();
  for (const x of Array.isArray(raw) ? raw : []) {
    if (!x || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    if (!validItemId(r.id) || ids.has(r.id) || !isTeamKind(r.kind)) continue;
    if (typeof r.path !== "string" || !validItemPath(r.kind, r.path)) continue;
    ids.add(r.id);
    out.push({
      id: r.id,
      kind: r.kind,
      path: r.path,
      isDefault: r.isDefault === true,
      version: typeof r.version === "number" ? r.version : 0,
      size: typeof r.size === "number" ? r.size : 0,
      by: typeof r.by === "string" ? r.by : "",
      updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : null,
    });
  }
  return out;
}

/** The skill a skill's file belongs to (`skills/review/a.md` → "review"), else null. */
export function skillOf(item: Pick<TeamItem, "kind" | "path">): string | null {
  if (item.kind !== "skills") return null;
  return item.path.split("/")[1] ?? null;
}

/**
 * The item that switches `item` on or off. A skill is every item under `skills/<skill>/`, and
 * its `SKILL.md` is the skill's switch: adding or turning off any of its files acts on that
 * one, so the whole skill follows. A skill's file without a `SKILL.md` in the library has no
 * switch (null): it isn't a skill, and is never on. Any other item is its own switch.
 */
export function switchOf(item: TeamItem, items: readonly TeamItem[]): TeamItem | null {
  const skill = skillOf(item);
  if (skill === null) return item;
  return items.find((x) => x.kind === "skills" && x.path === `skills/${skill}/SKILL.md`) ?? null;
}

/** What this person chose on this computer (the settings `team.added` and `team.off`). */
export interface TeamChoices {
  /** Items added: on though not default. */
  added: readonly string[];
  /** Defaults turned off. */
  off: readonly string[];
}

/** A setting's value as a list of item ids (anything else: none). */
export function choiceIds(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter(validItemId))] : [];
}

/**
 * The ids of the items that are on: an item whose switch is default and not turned off, or
 * whose switch was added.
 */
export function activeIds(items: readonly TeamItem[], choices: TeamChoices): Set<string> {
  const added = new Set(choices.added);
  const off = new Set(choices.off);
  const on = new Set<string>();
  for (const item of items) {
    const s = switchOf(item, items);
    if (!s) continue;
    if ((s.isDefault && !off.has(s.id)) || added.has(s.id)) on.add(item.id);
  }
  return on;
}

/** The choices after adding `item` (its skill, for a skill's file): on from now. */
export function addItem(
  item: TeamItem,
  items: readonly TeamItem[],
  choices: TeamChoices,
): TeamChoices {
  const s = switchOf(item, items);
  if (!s) throw new Error("That skill has no SKILL.md in the library: it can't be added.");
  return {
    added: s.isDefault ? choices.added.filter((id) => id !== s.id) : union(choices.added, s.id),
    off: choices.off.filter((id) => id !== s.id),
  };
}

/** The choices after turning `item` off (its skill, for a skill's file). */
export function turnOffItem(
  item: TeamItem,
  items: readonly TeamItem[],
  choices: TeamChoices,
): TeamChoices {
  const s = switchOf(item, items) ?? item;
  return {
    added: choices.added.filter((id) => id !== s.id),
    off: s.isDefault ? union(choices.off, s.id) : choices.off.filter((id) => id !== s.id),
  };
}

function union(list: readonly string[], id: string): string[] {
  return list.includes(id) ? [...list] : [...list, id];
}

/** The service's own limits, kept to here whatever it lists. */
export const MAX_TEAM_ITEMS = 500;
export const MAX_TEAM_ITEM_BYTES = 256 * 1024;
export const MAX_TEAM_BYTES = 20 * 1024 * 1024;

/**
 * The items whose text is to be downloaded: listed, within the limits, and not here in the
 * listed version (`cached`: id → the version kept). Every item's text is kept, on or not, so
 * one can be looked at before it is added.
 */
export function itemsToFetch(
  items: readonly TeamItem[],
  cached: Readonly<Record<string, number>>,
): string[] {
  const out: string[] = [];
  let bytes = 0;
  for (const item of items.slice(0, MAX_TEAM_ITEMS)) {
    if (item.size > MAX_TEAM_ITEM_BYTES) continue;
    bytes += item.size;
    if (bytes > MAX_TEAM_BYTES) break;
    // Own keys only: an id may be any name ("constructor").
    if (!Object.hasOwn(cached, item.id) || cached[item.id] !== item.version) out.push(item.id);
  }
  return out;
}

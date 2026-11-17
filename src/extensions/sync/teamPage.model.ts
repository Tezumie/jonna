// The Team page's words and rules, DOM-free: the team's library as `ide://team` gives it, its
// items as the rows the page lists (by kind, a skill as one row), who a row is on for (its
// mode), what a switch does, what this account may do, the filter, and what the publish picker
// offers and reports. The library itself is the
// team extension's (extensions/team); this page reads its state and runs its commands, and
// imports nothing from it.
import {
  isTeamKind,
  kindOfPath,
  modeOf,
  skillOf,
  TEAM_MODES,
  type TeamKind,
  type TeamMode,
} from "../../core/team/items";
import { countOf } from "./model";

// ------------------------------------------------------------ the library, as the state gives it

export interface TeamLibraryItem {
  id: string;
  kind: TeamKind;
  path: string;
  isDefault: boolean;
  /** On for every member, always: it can't be switched off. */
  required: boolean;
  /** On here: required, a default this person didn't turn off, or one they added. */
  active: boolean;
  version: number;
  by: string;
  updatedAt: number | null;
}

export interface TeamLibrary {
  team: { name: string; role: "owner" | "member"; publisher: boolean } | null;
  /** "lapsed": the team's subscription ended; the library still applies, and can't be changed. */
  state: "on" | "lapsed" | null;
  items: TeamLibraryItem[];
  lastRefresh: number | null;
  problem: string | null;
}

export const NO_LIBRARY: TeamLibrary = {
  team: null,
  state: null,
  items: [],
  lastRefresh: null,
  problem: null,
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The value of `ide://team`, narrowed: anything that isn't the expected shape is left out. */
export function teamLibraryOf(raw: unknown): TeamLibrary {
  const r = record(raw);
  if (!r) return NO_LIBRARY;
  const team = record(r.team);
  const items: TeamLibraryItem[] = [];
  for (const entry of Array.isArray(r.items) ? r.items : []) {
    const x = record(entry);
    if (!x || typeof x.id !== "string" || typeof x.path !== "string" || !isTeamKind(x.kind))
      continue;
    items.push({
      id: x.id,
      kind: x.kind,
      path: x.path,
      isDefault: x.isDefault === true,
      required: x.required === true,
      active: x.active === true,
      version: typeof x.version === "number" ? x.version : 0,
      by: typeof x.by === "string" ? x.by : "",
      updatedAt: typeof x.updatedAt === "number" ? x.updatedAt : null,
    });
  }
  return {
    team: team
      ? {
          name: typeof team.name === "string" && team.name.trim() ? team.name.trim() : "Your team",
          role: team.role === "owner" ? "owner" : "member",
          publisher: team.publisher === true,
        }
      : null,
    state: r.state === "lapsed" ? "lapsed" : r.state === "on" ? "on" : null,
    items,
    lastRefresh: typeof r.lastRefresh === "number" ? r.lastRefresh : null,
    problem: typeof r.problem === "string" && r.problem ? r.problem : null,
  };
}

// ------------------------------------------------------------ the kinds, as the page names them

/** The library's kinds in the page's order: heading, and what is said under it (null: nothing). */
export const TEAM_GROUPS: readonly {
  kind: TeamKind;
  heading: string;
  note: string | null;
}[] = [
  { kind: "rules", heading: "Rules", note: null },
  {
    kind: "skills",
    heading: "Skills",
    note: "A team's skills and commands always ask before they run something.",
  },
  {
    kind: "commands",
    heading: "Commands",
    note: "A team's skills and commands always ask before they run something.",
  },
  { kind: "agents", heading: "Agents", note: null },
  { kind: "outputStyles", heading: "Output styles", note: null },
  { kind: "snippets", heading: "Snippets", note: null },
  {
    kind: "mcp",
    heading: "MCP servers",
    note: "A team's servers ask before they start. Each member signs in to a server themselves: keys are never in the library.",
  },
  {
    kind: "settings",
    heading: "Default settings",
    note: "Defaults, not locks: your own settings win. Some settings never come from a team (what the agent may run without asking, protections, switching AI features on).",
  },
  { kind: "extensions", heading: "Recommended extensions", note: null },
];

/** A kind's heading ("Output styles"). */
export function kindHeading(kind: TeamKind): string {
  return TEAM_GROUPS.find((group) => group.kind === kind)?.heading ?? kind;
}

// ------------------------------------------------------------ rows

/** One row of the library: an item, or a whole skill. */
export interface TeamRow {
  /**
   * The item the row's switch, menu and preview act on: the item itself, or a skill's
   * `SKILL.md` (a skill without one in the library: its first file, and no switch).
   */
  id: string;
  kind: TeamKind;
  /** What the row is called: a skill's folder, a file's name without `.md`, else the file. */
  name: string;
  /** The path of the item `id` names. */
  path: string;
  isDefault: boolean;
  /** Who it is on for: optional, default, or required (always on, no switch). */
  mode: TeamMode;
  on: boolean;
  /** Who published the newest part of it (the name the service gives them), and when. */
  by: string;
  updatedAt: number | null;
  /** How many files it is (1, or a skill's). */
  files: number;
  /** A skill's other files, by their names inside the skill. */
  others: string[];
  /** False for a skill's files without a `SKILL.md`: they aren't a skill, and are never on. */
  switchable: boolean;
}

export interface TeamGroup {
  kind: TeamKind;
  heading: string;
  note: string | null;
  rows: TeamRow[];
}

function rowName(kind: TeamKind, path: string): string {
  const file = path.split("/").pop() ?? path;
  if (kind === "commands" || kind === "agents" || kind === "outputStyles")
    return file.replace(/\.md$/, "");
  return file;
}

function skillRow(skill: string, files: readonly TeamLibraryItem[]): TeamRow | null {
  const prefix = `skills/${skill}/`;
  const main = files.find((file) => file.path === `${prefix}SKILL.md`);
  const first = main ?? files[0];
  if (!first) return null;
  // The newest file says who changed the skill last.
  const newest = files.reduce((a, b) => ((b.updatedAt ?? 0) > (a.updatedAt ?? 0) ? b : a), first);
  return {
    id: first.id,
    kind: "skills",
    name: skill,
    path: first.path,
    isDefault: main?.isDefault === true,
    // A skill is on as its SKILL.md says; files without one are nobody's.
    mode: main ? modeOf(main) : "optional",
    on: main?.active === true,
    by: newest.by,
    updatedAt: newest.updatedAt,
    files: files.length,
    others: files
      .filter((file) => file.id !== first.id)
      .map((file) => file.path.slice(prefix.length))
      .sort(),
    switchable: main !== undefined,
  };
}

/**
 * The library as the page lists it: by kind in the page's order, kinds without items left out,
 * rows by name. A skill is one row whatever its number of files, switched by its `SKILL.md`.
 */
export function teamGroups(items: readonly TeamLibraryItem[]): TeamGroup[] {
  const groups: TeamGroup[] = [];
  for (const { kind, heading, note } of TEAM_GROUPS) {
    const own = items.filter((item) => item.kind === kind);
    let rows: TeamRow[];
    if (kind === "skills") {
      const bySkill = new Map<string, TeamLibraryItem[]>();
      for (const item of own) {
        const skill = skillOf(item);
        if (skill === null) continue;
        bySkill.set(skill, [...(bySkill.get(skill) ?? []), item]);
      }
      rows = [...bySkill].flatMap(([skill, files]) => skillRow(skill, files) ?? []);
    } else {
      rows = own.map((item) => ({
        id: item.id,
        kind,
        name: rowName(kind, item.path),
        path: item.path,
        isDefault: item.isDefault,
        mode: modeOf(item),
        on: item.active,
        by: item.by,
        updatedAt: item.updatedAt,
        files: 1,
        others: [],
        switchable: true,
      }));
    }
    if (rows.length === 0) continue;
    rows.sort((a, b) => a.name.localeCompare(b.name));
    groups.push({ kind, heading, note, rows });
  }
  return groups;
}

/** A row's facts before its time: who published it, and a skill's number of files. */
export function rowFacts(row: TeamRow): string {
  const by = row.by ? `Published by ${row.by}` : "Published";
  return row.kind === "skills" ? `${by} · ${countOf(row.files, "file")}` : by;
}

/** The command a row's switch runs when it is set to `on`. */
export function toggleCommand(
  row: Pick<TeamRow, "isDefault">,
  on: boolean,
): "team.addItem" | "team.turnOnItem" | "team.turnOffItem" {
  if (!on) return "team.turnOffItem";
  // A default that is off was turned off by this person: it is turned back on, not added.
  return row.isDefault ? "team.turnOnItem" : "team.addItem";
}

// ------------------------------------------------------------ modes

/** Under the page's heading: whose word counts. */
export const TEAM_PRECEDENCE =
  "Your own files and settings win over the team's. Required items are always on.";

/** A row's mode as its tag; nothing for an optional item. */
export function modeTag(mode: TeamMode): string | null {
  return mode === "required" ? "Required" : mode === "default" ? "Default" : null;
}

/**
 * What a required row says in place of its switch (the tooltip). Required default settings
 * are still defaults: the item can't be switched off as a whole, and each value is under the
 * person's own.
 */
export function requiredWords(kind: TeamKind): string {
  return kind === "settings"
    ? "Your team requires these settings, so they can't be switched off here. They are still defaults: where you set a value of your own, yours wins."
    : "Your team requires this item, so it can't be switched off here.";
}

const MODE_ACTIONS: Record<TeamMode, string> = {
  optional: "Make optional",
  default: "Make a default",
  required: "Make required",
};

/** The owner's menu for a row: the modes it isn't in, each as what `team.setMode` is given. */
export function modeActions(mode: TeamMode): { mode: TeamMode; label: string }[] {
  return TEAM_MODES.filter((other) => other !== mode).map((other) => ({
    mode: other,
    label: MODE_ACTIONS[other],
  }));
}

// ------------------------------------------------------------ the filter

/** A library with more rows than this gets a filter box above it. */
export const FILTER_FROM = 12;

export function rowCount(groups: readonly TeamGroup[]): number {
  return groups.reduce((n, group) => n + group.rows.length, 0);
}

/** Whether the library is long enough for a filter box. */
export function hasFilter(groups: readonly TeamGroup[]): boolean {
  return rowCount(groups) > FILTER_FROM;
}

/**
 * The rows that match `query`, by name and by kind, whatever the case: every word of it is in
 * the row's name or in its kind's heading ("mcp" and "servers" both find the MCP servers).
 * Groups left without a row are left out; an empty query keeps everything.
 */
export function filterGroups(groups: readonly TeamGroup[], query: string): TeamGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...groups];
  const out: TeamGroup[] = [];
  for (const group of groups) {
    const kind = `${group.heading} ${group.kind}`.toLowerCase();
    const rows = group.rows.filter((row) => {
      const name = row.name.toLowerCase();
      return words.every((word) => name.includes(word) || kind.includes(word));
    });
    if (rows.length > 0) out.push({ ...group, rows });
  }
  return out;
}

// ------------------------------------------------------------ who may do what

export interface TeamAbilities {
  /** Turning items on and off on this computer: anyone in the team, lapsed or not. */
  choose: boolean;
  /** Publishing optional items, removing: publishers, while the subscription runs. */
  publish: boolean;
  /** Saying what is on for everyone (default, required): the team's owner, who can publish. */
  decide: boolean;
  /** The team's subscription ended: said in one line, and nothing of the library changes. */
  lapsed: boolean;
}

/** What this account may do with the library (`lapsed`: the account's sync is ended too). */
export function teamAbilities(library: TeamLibrary, lapsed = false): TeamAbilities {
  const ended = library.state === "lapsed" || lapsed;
  const publish = library.team?.publisher === true && !ended;
  return {
    choose: library.team !== null,
    publish,
    decide: publish && library.team?.role === "owner",
    lapsed: library.team !== null && ended,
  };
}

/** Under the team's name: whose team it is, and whether this account may publish. */
export function roleWords(team: NonNullable<TeamLibrary["team"]>): string {
  // An owner publishing is a given: only a member is told.
  if (team.role === "owner") return "You own this team";
  return team.publisher ? "Member · Can publish" : "Member";
}

/** Why the library can't be changed while the team's subscription is ended, in one line. */
export function lapsedLibraryLine(owner: boolean): string {
  return owner
    ? "Your team's subscription ended. The library still applies on every member's computer; publishing and changing defaults come back once you renew it."
    : "Your team's subscription ended. The library still applies on this computer; it can't be changed until the team's owner renews it.";
}

export const TEAM_PURPOSE =
  "A team is for people who work together: one bill, a shared pool of storage, and a shared library of how the team works (rules, skills, commands, agents, default settings and more) that every member's IDE can use.";
export const TEAM_START =
  "You aren't in a team. Teams are set up on your account page, which opens in the browser: invite people there by their email address.";
export const TEAM_INVITED =
  "You aren't in a team. To join one, ask its owner to invite the email address of your account, on their account page.";

/** What an empty library says (`publisher`: this account can fill it). */
export function emptyLibraryWords(publisher: boolean): string {
  return publisher
    ? "Nothing is published yet. Choose Publish to share one of your own rules, skills, commands, agents, settings or servers with the team."
    : "Nothing is published yet. What the team's publishers share shows here.";
}

// ------------------------------------------------------------ publishing

/** One of the user's own things that can be published: `path` is what `team.publish` takes. */
export interface OwnItem {
  path: string;
  label: string;
}

/**
 * The user's own items of a kind that is files (rules, skills, commands, agents, output styles,
 * snippets), from the names of their own files (`commands/ship.md`, `skills/review/SKILL.md`).
 * A skill is offered whole (`skills/<skill>`), and only when it has a `SKILL.md`.
 */
export function ownItems(kind: TeamKind, files: readonly string[]): OwnItem[] {
  if (kind === "rules")
    return files.includes("AGENTS.md") ? [{ path: "AGENTS.md", label: "AGENTS.md" }] : [];
  if (kind === "skills") {
    const skills = new Set<string>();
    for (const path of files) {
      const parts = path.split("/");
      if (parts.length === 3 && parts[0] === "skills" && parts[2] === "SKILL.md" && parts[1])
        skills.add(parts[1]);
    }
    return [...skills].sort().map((skill) => ({ path: `skills/${skill}`, label: skill }));
  }
  if (kind === "mcp" || kind === "settings" || kind === "extensions") return [];
  return files
    .filter((path) => kindOfPath(path) === kind)
    .sort()
    .map((path) => ({ path, label: rowName(kind, path) }));
}

/** One answer to "who is it on for?" in the publish picker. */
export interface ModeChoice {
  /** A mode, or "keep": what is in the library already stays as it is. */
  id: TeamMode | "keep";
  label: string;
  description: string;
}

/**
 * What the publish picker asks about who the item is on for. The owner chooses (`there`: it is
 * in the library already, so it may stay as it is); a member who can publish isn't asked (null):
 * theirs is optional.
 */
export function modeChoices(owner: boolean, there: boolean): ModeChoice[] | null {
  if (!owner) return null;
  return [
    ...(there
      ? [
          {
            id: "keep" as const,
            label: "Keep as it is",
            description: "What is in the library already stays optional, a default or required",
          },
        ]
      : []),
    {
      id: "optional",
      label: "Optional (members add it)",
      description: "Off until a member adds it",
    },
    {
      id: "default",
      label: "On by default (members can switch it off)",
      description: "On for every member from the start",
    },
    {
      id: "required",
      label: "Required (always on)",
      description: "On for every member; nobody can switch it off",
    },
  ];
}

/** What `team.publish` is given for an answer (`null`: a publisher who isn't asked). */
export function modeInput(answer: ModeChoice["id"] | null): { mode?: TeamMode } {
  if (answer === null) return { mode: "optional" };
  return answer === "keep" ? {} : { mode: answer };
}

/** What one `team.publish` came to: what went, and what didn't with why. */
export interface PublishOutcome {
  published: string[];
  refused: { what: string; why: string }[];
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];

/**
 * Reads the result of a `team.publish` (`what`: the thing asked for, for a result that names
 * nothing): published paths, and conflicts, files left out, refused keys and a failure as
 * things not published.
 */
export function publishOutcome(what: string, result: unknown): PublishOutcome {
  const r = record(result);
  const out: PublishOutcome = { published: [], refused: [] };
  if (!r) return { published: [], refused: [{ what, why: "nothing came back" }] };
  for (const entry of Array.isArray(r.published) ? r.published : []) {
    const path = record(entry)?.path;
    if (typeof path === "string") out.published.push(path);
  }
  for (const entry of Array.isArray(r.conflicts) ? r.conflicts : []) {
    const c = record(entry);
    if (!c || typeof c.path !== "string") continue;
    const by = typeof c.by === "string" && c.by ? c.by : "someone";
    out.refused.push({ what: c.path, why: `${by} published a newer version meanwhile` });
  }
  for (const path of strings(r.skipped))
    out.refused.push({ what: path, why: "not a file the library takes" });
  for (const key of strings(r.refused))
    out.refused.push({ what: key, why: "not something a team's library takes" });
  if (typeof r.failed === "string" && r.failed) {
    const at = r.failed.indexOf(": ");
    out.refused.push(
      at > 0
        ? { what: r.failed.slice(0, at), why: r.failed.slice(at + 2) }
        : { what, why: r.failed },
    );
  }
  return out;
}

/** A thing that couldn't be published at all (the command refused), as an outcome. */
export function publishFailure(what: string, error: unknown): PublishOutcome {
  const why = error instanceof Error ? error.message : String(error);
  return { published: [], refused: [{ what, why }] };
}

/** Several outcomes as one, and the sentence that says it. */
export function publishReport(
  outcomes: readonly PublishOutcome[],
  teamName: string,
): PublishOutcome & { message: string } {
  const published = outcomes.flatMap((o) => o.published);
  const refused = outcomes.flatMap((o) => o.refused);
  const where = teamName ? `the library of ${teamName}` : "your team's library";
  const went =
    published.length === 0
      ? "Nothing was published."
      : published.length <= 3
        ? `Published to ${where}: ${published.join(", ")}.`
        : `Published ${countOf(published.length, "file")} to ${where}.`;
  const stayed = refused.length
    ? ` Not published: ${refused.map((r) => `${r.what} (${r.why.replace(/\.$/, "")})`).join("; ")}.`
    : "";
  return { published, refused, message: `${went}${stayed}` };
}

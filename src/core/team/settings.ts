// The team's default settings (`settings.json` in its library), DOM-free: which keys a team may
// set. The same filter runs on what is downloaded and on what is published. They are defaults,
// not locks: the model resolves them under the user's own values (core/settings/model.ts).
//
// A team's settings are written by other people. So a key never comes from the team when it
// stays on the computer it was set on (`staysLocal`: programs to run, hooks, servers, what may
// run without asking, paths), when this build doesn't know it, or when it is the account's,
// sync's or the team's own.
import { isLanguageOverrideKey } from "../settings/languageOverrides";
import { staysLocal } from "../sync/localSettings";

/** Settings that are never the team's to set, whatever else is true of them. */
const OWN_PREFIXES = ["team.", "sync.", "accounts."];

/**
 * Whether the team may set `key`: `known` says whether the settings registry has it (and it
 * isn't one only a folder may set).
 */
export function teamMaySet(key: string, known: (key: string) => boolean): boolean {
  if (OWN_PREFIXES.some((prefix) => key.startsWith(prefix))) return false;
  if (staysLocal(key)) return false;
  if (lowersGuard(key)) return false;
  return known(key);
}

/** Areas that are a person's own decision on their own computer, whoever they work with. */
const GUARDED_PREFIXES = [
  // Which servers start by themselves or are found by themselves, and what they may do.
  "agent.mcp.",
  // Driving this computer's screen, keyboard and mouse.
  "agent.computerUse.",
  // Whether a folder is trusted, and what an untrusted one may do.
  "security.",
];
const GUARDED_KEYS: ReadonlySet<string> = new Set([
  // Whether an agent outside the IDE may drive it.
  "agent.ideControl",
]);

/**
 * Whether setting `key` could lower a protection, let something run or leave without asking,
 * or switch on a feature that calls a model. A team's settings arrive from other people and
 * apply without being read, so they never decide these: every protection ("…Protection"),
 * every automatic approval ("…autoApprove…"), every on/off switch of a model-calling feature
 * (an agent's, inline completions, next edit, inline edit), and the areas above. The person's
 * own setting is the only one that counts for them.
 */
export function lowersGuard(key: string): boolean {
  if (GUARDED_KEYS.has(key)) return true;
  if (GUARDED_PREFIXES.some((prefix) => key.startsWith(prefix))) return true;
  const last = key.slice(key.lastIndexOf(".") + 1);
  if (/protection$/i.test(last)) return true;
  if (/autoapprove/i.test(key)) return true;
  // Opt-in features that call a model, or send something to one.
  if (last === "enabled" && /^(agent\.|editor\.(inline|nextEdit)|ai\.)/.test(key)) return true;
  return false;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * The settings a team's `settings.json` may set, and the keys left out. Language blocks
 * (`"[python]": {…}`) are kept with only the keys the team may set.
 */
export function teamSettings(
  raw: unknown,
  known: (key: string) => boolean,
): { values: Record<string, unknown>; refused: string[] } {
  const values: Record<string, unknown> = {};
  const refused: string[] = [];
  if (!isPlainObject(raw)) return { values, refused };
  for (const [key, value] of Object.entries(raw)) {
    if (key === "__proto__") continue;
    if (isLanguageOverrideKey(key)) {
      if (!isPlainObject(value)) continue;
      const block: Record<string, unknown> = {};
      for (const [inner, v] of Object.entries(value)) {
        if (inner !== "__proto__" && teamMaySet(inner, known)) block[inner] = v;
        else refused.push(`${key}.${inner}`);
      }
      if (Object.keys(block).length) values[key] = block;
      continue;
    }
    if (teamMaySet(key, known)) values[key] = value;
    else refused.push(key);
  }
  return { values, refused };
}

/**
 * The team's `settings.json` after publishing `values` into it: what was there (`current`: its
 * text, null when there is none) with those keys set, everything the team may not set left
 * out. Keys in order, so the same settings always make the same text.
 */
export function mergeTeamSettings(
  current: string | null,
  values: Readonly<Record<string, unknown>>,
  known: (key: string) => boolean,
): { text: string; published: string[]; refused: string[] } {
  let before: unknown = {};
  if (current?.trim()) {
    try {
      before = JSON.parse(current);
    } catch {
      throw new Error("The team's settings.json isn't valid JSON: fix it before adding to it.");
    }
  }
  const kept = teamSettings(before, known).values;
  const added = teamSettings(values, known);
  const merged: Record<string, unknown> = { ...kept, ...added.values };
  const sorted = Object.fromEntries(
    Object.keys(merged)
      .sort()
      .map((key) => [key, merged[key]]),
  );
  return {
    text: `${JSON.stringify(sorted, null, 2)}\n`,
    published: Object.keys(added.values).sort(),
    refused: added.refused,
  };
}

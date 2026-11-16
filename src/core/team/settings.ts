// The team's default settings (`settings.json` in its library), DOM-free: which keys a team may
// set. The same filter runs on what is downloaded and on what is published. They are defaults,
// not locks: the model resolves them under the user's own values (core/settings/model.ts).
//
// A team's settings are written by other people. So a key never comes from the team when it
// stays on the computer it was set on (`staysLocal`: programs to run, hooks, servers, what may
// run without asking, paths), when it could lower a protection, open the network or switch a
// feature on (`lowersGuard`), when this build doesn't know it, or when it is the account's,
// sync's or the team's own.
import { isLanguageOverrideKey } from "../settings/languageOverrides";
import { staysLocal } from "../sync/localSettings";

/** Settings that are never the team's to set, whatever else is true of them. */
const OWN_PREFIXES = ["team.", "sync.", "accounts."];

/**
 * Whether the team may set `key` to `value`: `known` says whether the settings registry has it
 * (and it isn't one only a folder may set). The one place this is decided. Without a `value`
 * the answer is the careful one: a switch a team may only turn off is then not the team's.
 */
export function teamMaySet(key: string, known: (key: string) => boolean, value?: unknown): boolean {
  if (OWN_PREFIXES.some((prefix) => key.startsWith(prefix))) return false;
  if (staysLocal(key)) return false;
  if (lowersGuard(key, value)) return false;
  return known(key);
}

/** Areas that are a person's own decision on their own computer, whoever they work with. */
const GUARDED_PREFIXES = [
  // Which servers start by themselves or are found by themselves, and what they may do.
  "agent.mcp.",
  // The IDE's own server, through which agents outside it drive it.
  "mcp.",
  // Driving this computer's screen, keyboard and mouse.
  "agent.computerUse.",
  // Whether a folder is trusted, and what an untrusted one may do.
  "security.",
  // Which extensions may call a model, what installs or updates by itself, and from where.
  "extensions.",
  // Which build of the IDE this computer runs, and when it changes.
  "update.",
  // What the agent's tools leave alone (the shield over .env and key files, more patterns).
  "agent.ignore",
  // Pages fetched from the network, what is crawled, and searches sent out.
  "agent.docs.",
  "agent.webFetch.",
  "agent.webSearch.",
  // Where what is said into the microphone goes.
  "agent.voice.",
  // Other agents started on this computer, and what of the IDE they get.
  "agent.externalAgent",
  // Tasks: which are found and which run by themselves.
  "task.",
  "tasks.",
  // Fetching with this person's credentials on a timer.
  "git.autofetch",
  // Which processes a debugger attaches to by itself.
  "debug.javascript.autoAttach",
  // Anything sent home about how the IDE is used (none today; never a team's to switch on).
  "telemetry.",
];
const GUARDED_KEYS: ReadonlySet<string> = new Set([
  // Whether an agent outside the IDE may drive it.
  "agent.ideControl",
  // What the agent may read and never change.
  "agent.readOnlyPaths",
  // Pictures fetched from other sites when a preview opens (who opened what, and when).
  "markdown.preview.remoteImages",
  // Other sites inside the IDE's own window.
  "browser.embedSites",
  // A folder of this computer.
  "agent.projectsFolder",
  // Signing every commit off in this person's name.
  "git.alwaysSignOff",
]);

/** A key's last part naming a program, a command line, a place on this computer or the network. */
const NAMES_PROGRAM_OR_PLACE =
  /(paths?|directory|executable|command|args|script|ur[li]s?|prox(y|ies)|webhooks?|endpoints?|cdn|hosts?|hooks?)$/i;
/** A key's last part naming a port (not "import"). */
const NAMES_PORT = /(^p|P)orts?$/;
/** Words that mark a protection, a permission or something kept secret, anywhere in a key. */
const PROTECTS =
  /protect|approv|trust|sandbox|permission|allow|warn|confirm|prompt|secret|credential|password|apikey|telemetry/i;
/** A part of a key that names how a program is started. */
const STARTS_PROGRAM = /(^|\.)(env|shell|shellArgs|cwd)(\.|$)/i;
/** Features that call a model, or send something to one: their switches are never a team's. */
const CALLS_MODEL = /^(agent\.|editor\.(inline|nextEdit)|ai\.)/;

/**
 * Whether setting `key` (to `value`) could lower a protection, let something run or leave
 * without asking, open this computer to the network, or switch a feature on. A team's settings
 * arrive from other people and apply without being read, so they never decide these:
 *
 * - every protection, permission, confirmation and trust decision, and every automatic
 *   approval;
 * - every on/off switch of a model-calling feature (an agent's, inline completions, next edit,
 *   inline edit), either way;
 * - any other on/off switch ("….enabled", "…Enabled", "enable…") unless it is being switched
 *   off: a team may turn a feature off for everyone, never on;
 * - what names a program, a command line, a port, or a place on this computer or the network;
 * - the areas listed above.
 *
 * The person's own setting is the only one that counts for them.
 */
export function lowersGuard(key: string, value?: unknown): boolean {
  if (GUARDED_KEYS.has(key)) return true;
  if (GUARDED_PREFIXES.some((prefix) => key.startsWith(prefix))) return true;
  const last = key.slice(key.lastIndexOf(".") + 1);
  if (PROTECTS.test(key)) return true;
  if (NAMES_PROGRAM_OR_PLACE.test(last) || NAMES_PORT.test(last)) return true;
  if (STARTS_PROGRAM.test(key)) return true;
  if (last === "enabled" || /Enabled$/.test(last) || /^enable[A-Z]/.test(last)) {
    // Opt-in features that call a model, or send something to one: not even off.
    if (CALLS_MODEL.test(key)) return true;
    return value !== false && value !== "off";
  }
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
        if (inner !== "__proto__" && teamMaySet(inner, known, v)) block[inner] = v;
        else refused.push(`${key}.${inner}`);
      }
      if (Object.keys(block).length) values[key] = block;
      continue;
    }
    if (teamMaySet(key, known, value)) values[key] = value;
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

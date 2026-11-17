// Which settings decide a protection, a permission, a program, a place or a feature's switch.
// DOM-free. One list for everything that arrives from somewhere else than the person at this
// computer: a team's default settings (core/team/settings.ts) and what sync downloads from the
// account's other computers (core/sync/localSettings.ts). A new setting of this kind is added
// here, once.

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
  // Anything sent home about how the IDE is used (none today; never someone else's to switch on).
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
/** Features that call a model, or send something to one: their switches are never someone else's. */
const CALLS_MODEL = /^(agent\.|editor\.(inline|nextEdit)|ai\.)/;

/**
 * What kind of decision `key` is: "guarded" (a protection, a permission, a program, a port, a
 * place, a model-calling feature's switch, or one of the areas above: only the person at this
 * computer decides it), "switch" (any other feature's on/off switch), or null (neither).
 */
export function guardKind(key: string): "guarded" | "switch" | null {
  if (GUARDED_KEYS.has(key)) return "guarded";
  if (GUARDED_PREFIXES.some((prefix) => key.startsWith(prefix))) return "guarded";
  const last = key.slice(key.lastIndexOf(".") + 1);
  if (PROTECTS.test(key)) return "guarded";
  if (NAMES_PROGRAM_OR_PLACE.test(last) || NAMES_PORT.test(last)) return "guarded";
  if (STARTS_PROGRAM.test(key)) return "guarded";
  if (last === "enabled" || /Enabled$/.test(last) || /^enable[A-Z]/.test(last)) {
    // Opt-in features that call a model, or send something to one: not even off.
    return CALLS_MODEL.test(key) ? "guarded" : "switch";
  }
  return null;
}

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
  const kind = guardKind(key);
  if (kind === "switch") return value !== false && value !== "off";
  return kind === "guarded";
}

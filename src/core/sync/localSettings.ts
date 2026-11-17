// Settings that never sync (D435). DOM-free.
//
// What is synced is written into the settings file of every computer of the account. A setting
// that names a program to run, a command line, a hook, a server to start or to send things to,
// or that widens what may run without asking, would let one computer of the account (or
// whoever got into the account) run programs on all the others. And a path on one computer
// means nothing on another. So these stay where they were set, whatever the person's own list
// (`sync.ignoredSettings`) says. Kept in this one place: a new setting of this kind is added
// here.
//
// What sync downloads is held to more than that (`syncKeepsLocal`, `settingSyncs`): a computer
// of the account that someone else got into must not loosen a protection or point the IDE
// somewhere new on the others.
import { guardKind } from "../settings/guard";
import { isLanguageOverrideKey } from "../settings/languageOverrides";

/** Exact keys. */
const LOCAL_KEYS: ReadonlySet<string> = new Set([
  // Sync's own, and where the account lives.
  "accounts.serverUrl",
  "sync.projects",
  // What of the team's library this person added or turned off, on this computer.
  "team.added",
  "team.off",
  // Commands the agent runs or is allowed to run.
  "agent.hooks",
  "agent.statusLine",
  "agent.verifyCommand",
  "agent.allowedCommands",
  "agent.deniedCommands",
  "agent.runCommands",
  "agent.autoApprove",
  "agent.computerUse.allowedApps",
  // Programs started as servers or agents, and what they may ask of the model.
  "agent.mcpServers",
  "agent.mcp.sampling",
  "agent.mcp.registryUrl",
  "agent.externalAgents",
  "lsp.servers",
  // Where prompts, notifications and pages go, or code is loaded from.
  "agent.providers",
  "agent.ollama.url",
  "agent.notify.webhook",
  "agent.webSearch.searxngUrl",
  "extensions.officialRepo",
  "notebook.output.cdn",
  // Tasks that run by themselves.
  "task.allowAutomaticTasks",
  // Folders of this computer.
  "security.riskyFolders",
]);

/** Keys that start with one of these. */
const LOCAL_PREFIXES: readonly string[] = [
  // Which shell a terminal, a task or a debug launch starts, with its arguments.
  "terminal.profiles.",
  "terminal.defaultProfile.",
  "terminal.automationProfile.",
  // What sandboxed commands may read, write and reach (and whether there is a sandbox).
  "agent.sandbox",
  // The script run in each new worktree, and what is copied into it.
  "agent.worktree.",
  // Who a shared project's keys are handed to (only verified teammates, or all): decided on
  // each computer, where the fingerprints were compared; another computer must not loosen it.
  "team.share",
];

/**
 * Settings sync keeps on each computer besides the lists above and the guard's
 * (core/settings/guard.ts). A team may set some of these as defaults under a person's own
 * values; what sync downloads is written into the settings file as the person's own, so it is
 * held to more.
 */
const SYNC_LOCAL_PREFIXES: readonly string[] = [
  // What syncs from a computer, and what doesn't, is that computer's own choice.
  "sync.",
  // A model-calling feature's switch, though its name doesn't say "agent".
  "git.aiCommitMessage.",
];
const SYNC_LOCAL_KEYS: ReadonlySet<string> = new Set([
  // Modes with their own instructions, tools and model; each agent's model.
  "agent.customModes",
  "agent.subagents",
  // Which rules and skills are switched off, and whether other tools' project files are read:
  // what steers the agent on a computer is decided there.
  "agent.skills.disabled",
  "agent.rules.disabled",
  "agent.thirdPartyConfigs",
]);
/** A key's last part naming a model (or several): where prompts and code are sent. */
const NAMES_MODEL = /models?$/i;

/**
 * Whether sync leaves `key` alone in both directions, whatever it is set to: it stays on the
 * computer it was set on (`staysLocal`), it decides a protection, a permission, a program, a
 * port or a place, or it is a model-calling feature's switch (the guard a team's settings pass,
 * `guardKind`), it routes prompts to a model, or it is one of sync's own. A computer of the
 * account that someone else got into can then change how the others look and edit, never what
 * they run, allow, or send where. Other features' plain on/off switches do sync.
 */
export function syncKeepsLocal(key: string): boolean {
  if (staysLocal(key)) return true;
  if (guardKind(key) === "guarded") return true;
  if (SYNC_LOCAL_KEYS.has(key)) return true;
  if (SYNC_LOCAL_PREFIXES.some((prefix) => key.startsWith(prefix))) return true;
  return NAMES_MODEL.test(key.slice(key.lastIndexOf(".") + 1));
}

/** What decides, on one computer, which settings take part in sync. */
export interface SyncSettingsFilter {
  /** Whether the settings registry of this computer has the key. */
  known(key: string): boolean;
  /** Keys the registry doesn't have that the person chose to sync (`sync.extraSettings`). */
  extra: ReadonlySet<string>;
  /** Keys the person keeps on this computer (`sync.ignoredSettings`). */
  ignored: ReadonlySet<string>;
}

/**
 * Whether the setting `key` syncs on this computer: not one sync keeps local, not one the
 * person keeps here, and either known to this computer's settings registry or listed by the
 * person. A key nothing here knows (a setting of an extension from elsewhere, a misspelling,
 * something made up) is never written into the settings file unasked.
 */
export function settingSyncs(key: string, filter: SyncSettingsFilter): boolean {
  if (key === "__proto__" || syncKeepsLocal(key) || filter.ignored.has(key)) return false;
  return filter.known(key) || filter.extra.has(key);
}

/**
 * The same for a top-level entry of the settings file with its value: a language block
 * (`"[python]": {…}`) syncs as a whole, and only when everything in it would sync by itself.
 */
export function entrySyncs(key: string, value: unknown, filter: SyncSettingsFilter): boolean {
  if (!isLanguageOverrideKey(key)) return settingSyncs(key, filter);
  if (filter.ignored.has(key)) return false;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).every((inner) => settingSyncs(inner, filter));
}

/**
 * Whether a setting stays on the computer it was set on. Besides the lists: any key whose last
 * part ends in "Path" (a debugger's, an interpreter's, docker's: `debug.gdbPath`,
 * `python.defaultInterpreterPath`, `remote.containers.dockerPath`, and the ones to come).
 */
export function staysLocal(key: string): boolean {
  if (LOCAL_KEYS.has(key)) return true;
  if (LOCAL_PREFIXES.some((prefix) => key.startsWith(prefix))) return true;
  const last = key.slice(key.lastIndexOf(".") + 1);
  return /path$/i.test(last);
}

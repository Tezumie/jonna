// Settings that never sync (D435). DOM-free.
//
// What is synced is written into the settings file of every computer of the account. A setting
// that names a program to run, a command line, a hook, a server to start or to send things to,
// or that widens what may run without asking, would let one computer of the account (or
// whoever got into the account) run programs on all the others. And a path on one computer
// means nothing on another. So these stay where they were set, whatever the person's own list
// (`sync.ignoredSettings`) says. Kept in this one place: a new setting of this kind is added
// here.

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

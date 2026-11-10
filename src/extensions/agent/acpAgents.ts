// The external (ACP) agents the IDE knows (split from acp.ts in D245): the presets, the ones
// extensions bring, the ones installed from the ACP registry and the user's own
// (`agent.externalAgents`), plus how their command lines are put together (`--help` model
// choices, shell quoting).

import type { WorkbenchServices } from "../../workbench/services";

export interface ExternalAgentConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Shown in the model menu. */
  description?: string;
  /**
   * For agents whose ACP mode offers no model choice (Copilot: "whoever launches the server
   * chooses"): the flag that picks one at launch (`--model`); its `--help` lists the choices.
   */
  modelFlag?: string;
}

/** The `(choices: "a", "b")` list `--help` prints for `flag`, if it does. */
export function helpChoices(help: string, flag: string): string[] {
  const at = help.indexOf(flag);
  if (at < 0) return [];
  const m = /\(choices:\s*([^)]*)\)/.exec(help.slice(at, at + 2000));
  if (!m?.[1]) return [];
  return [...m[1].matchAll(/"([^"]+)"|'([^']+)'/g)]
    .map((x) => x[1] ?? x[2] ?? "")
    .filter((x) => /^[\w.:/-]+$/.test(x));
}

/** Well-known ACP agents (they must be installed / reachable through npx). */
export const ACP_PRESETS: ExternalAgentConfig[] = [
  {
    name: "Claude Code",
    command: "npx",
    // The adapter moved to the ACP organization (the @zed-industries one is deprecated and old,
    // D192): it runs Claude Code through its SDK with the login of `claude /login`.
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
    description: "needs Node.js and a Claude login (claude /login) or ANTHROPIC_API_KEY",
  },
  {
    name: "Gemini CLI",
    command: "gemini",
    args: ["--acp"],
    description: "npm i -g @google/gemini-cli",
  },
  {
    name: "Codex",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp"],
    description: "needs an OpenAI login or OPENAI_API_KEY",
  },
  // GitHub's own agent mode for Copilot plans (GitHub Models, the API, was retired in July 2026).
  {
    name: "GitHub Copilot",
    command: "copilot",
    args: ["--acp", "--stdio"],
    description: "npm i -g @github/copilot, then copilot /login",
    // Its ACP mode has no model choice; `copilot --model <id>` picks one at launch (D194).
    modelFlag: "--model",
  },
  // OpenCode is no preset since D401: the registry's OpenCode V2 (a download, no npm) is offered
  // in its place (catalog.ts SUGGESTED_REGISTRY_AGENTS, freeStart.ts).
];

export function externalAgents(services: WorkbenchServices): ExternalAgentConfig[] {
  const raw =
    services.settings.peek<
      Record<string, Omit<ExternalAgentConfig, "name"> & { enabled?: boolean }>
    >("agent.externalAgents");
  const custom = raw && typeof raw === "object" ? Object.entries(raw) : [];
  const out = new Map(ACP_PRESETS.map((p) => [p.name, p]));
  // Agents extensions bring (D176), after the presets: an extension can't replace Claude Code or
  // Codex, and the user's own settings below still win.
  for (const a of services.extensionFeatures.agents.peek())
    if (!out.has(a.name))
      out.set(a.name, {
        name: a.name,
        command: a.command,
        ...(a.args && { args: [...a.args] }),
        ...(a.env && { env: { ...a.env } }),
        description: `${a.description ?? "External agent"} (from the ${a.owner} extension)`,
      });
  // Installed from the ACP registry (D215): after the presets and extensions' agents (their
  // names were kept free when installing); the user's own settings still win.
  for (const a of Object.values(services.persistence.globalState().acpAgents ?? {}))
    if (!out.has(a.name))
      out.set(a.name, {
        name: a.name,
        command: a.command,
        args: [...a.args],
        ...(Object.keys(a.env).length && { env: { ...a.env } }),
        description: `${a.id} ${a.version} from the ACP registry (${
          a.kind === "binary"
            ? a.verified
              ? "downloaded, checksum-verified"
              : "downloaded, not checksum-verified"
            : a.kind === "path"
              ? "the program on PATH"
              : `runs with ${a.kind}`
        })`,
      });
  for (const [name, c] of custom) {
    if (c?.enabled === false) out.delete(name);
    else if (c && typeof c.command === "string") out.set(name, { ...c, name });
  }
  return [...out.values()];
}

/**
 * One argument of an agent's terminal command for the shell that runs it (PowerShell on
 * Windows, sh elsewhere): single quotes, so `$x`, backticks and `\` reach the program as they
 * are (double quotes would let the shell expand them first, or double Windows' backslashes).
 */
export function shellArg(arg: string, windows: boolean): string {
  if (arg && !/[^\w@%+=:,./-]/.test(arg)) return arg;
  return windows ? `'${arg.replace(/'/g, "''")}'` : `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * `<program> --help` as a command line (D223): a program path with spaces is quoted, and
 * PowerShell runs a quoted path only after `&` (else it's a string, printed back).
 */
export function helpCommandLine(command: string, windows: boolean): string {
  const quoted = shellArg(command, windows);
  return windows && quoted !== command ? `& ${quoted} --help` : `${quoted} --help`;
}

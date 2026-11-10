// Files an agent must never change without asking (D213), even with full access: other agents'
// own configuration (Codex's .codex/, Claude Code's settings and ~/.claude.json, MCP server
// lists), shell and login startup files, git's configuration and hooks, SSH. A prompt injection
// — a downloaded AGENTS.md, a web page — that gets an agent to write one of them outlives the
// chat: an MCP server added to ~/.codex/config.toml runs with every later Codex session,
// ANTHROPIC_BASE_URL in .claude/settings.json sends the sign-in token to someone else's server, a
// line in .bashrc runs in every terminal. The built-in agent's writes, IDE commands it calls and
// external agents' fs/write_text_file requests all check here; command lines are scanned for
// the same paths and for the agent CLIs' own config commands (`codex mcp add`). DOM-free, tested.

export type ConfigRisk =
  | "codex"
  | "claude"
  | "mcp"
  | "agent"
  | "shell"
  | "git"
  | "ssh"
  | "startup"
  | "workspace";

export interface ProtectedConfig {
  risk: ConfigRisk;
  /** What the file is and what writing it could do, in a sentence. */
  reason: string;
}

const REASONS: Record<ConfigRisk, string> = {
  codex:
    "Codex's configuration: the MCP servers it starts and its approval and sandbox settings, for every later Codex session.",
  claude:
    "Claude Code's settings: environment variables such as ANTHROPIC_BASE_URL (where your sign-in token is sent), hooks that run commands, MCP servers and permissions.",
  mcp: "An MCP server list: each server in it is a program an agent starts and gives its tools to.",
  agent:
    "An AI agent's own settings (Gemini, Cursor, Copilot…): its MCP servers, hooks and permissions.",
  shell:
    "A shell or tool startup file: what it says runs in every new terminal or package install.",
  git: "Git's configuration or hooks: they can run programs on every git command.",
  ssh: "SSH configuration and keys: they decide which servers you trust and how you sign in.",
  startup: "A login startup location: programs here start every time you sign in.",
  workspace:
    "A workspace file: the folders it lists join the window (the agent and extensions can then reach them), and its settings, tasks and launch configurations apply.",
};

/** File names that are a startup file wherever they are. */
const SHELL_FILES = new Set([
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_logout",
  ".profile",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".zlogin",
  ".zlogout",
  ".cshrc",
  ".tcshrc",
  ".kshrc",
  ".envrc",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnpmrc",
  "microsoft.powershell_profile.ps1",
  "microsoft.vscode_profile.ps1",
]);

/** MCP server lists by file name (anywhere). */
const MCP_FILES = new Set([".mcp.json", "mcp_config.json", "claude_desktop_config.json"]);

/**
 * Whether writing `path` (absolute, or relative to the open folder) needs the user's say, and
 * why. `workspaceFolder`: the IDE's own folder name in a project (its mcp.json lists servers).
 */
export function protectedConfig(path: string, workspaceFolder = ""): ProtectedConfig | null {
  const segs = path
    .trim()
    .replace(/^~(?=[\\/])/, "")
    .replaceAll("\\", "/")
    .split("/")
    .filter((s) => s && s !== ".")
    // Windows ignores trailing dots and spaces: `settings.json.` is settings.json. A name's
    // default stream (`settings.json::$DATA`, `.git::$INDEX_ALLOCATION`) is the name itself.
    .map((s) =>
      /^\.+$/.test(s)
        ? s
        : s
            .toLowerCase()
            .replace(/(?:::\$data|::\$index_allocation|:\$i30:\$index_allocation)$/, "")
            .replace(/[. ]+$/, ""),
    )
    // `.git/x/../config` is .git/config.
    .reduce<string[]>((out, s) => {
      if (s === "..") out.pop();
      else out.push(s);
      return out;
    }, []);
  if (!segs.length) return null;
  const name = segs[segs.length - 1] ?? "";
  const dir = segs.slice(0, -1);
  const parent = dir[dir.length - 1] ?? "";
  const hit = (risk: ConfigRisk): ProtectedConfig => ({ risk, reason: REASONS[risk] });
  if (dir.includes(".codex")) return hit("codex");
  if (parent === ".claude" && /^settings(\.local)?\.json$/.test(name)) return hit("claude");
  if (name === ".claude.json" || (dir.includes(".claude") && dir.includes("hooks")))
    return hit("claude");
  if (MCP_FILES.has(name)) return hit("mcp");
  // D251: the folders a workspace file lists are in scope once it's open.
  if (name.endsWith(".code-workspace")) return hit("workspace");
  if (name === "mcp.json" && [".cursor", ".vscode", ".gemini", ".amazonq", ".roo"].includes(parent))
    return hit("mcp");
  if (name === "mcp.json" && workspaceFolder && parent === workspaceFolder.toLowerCase())
    return hit("mcp");
  if (parent === ".cursor" && /\.json$/.test(name)) return hit("agent");
  if (parent === ".gemini" && name === "settings.json") return hit("agent");
  if (dir.includes(".continue") && /^config\.(json|ya?ml|ts)$/.test(name)) return hit("agent");
  if (dir.includes(".git") && (dir.includes("hooks") || (parent === ".git" && name === "config")))
    return hit("git");
  if (name === ".gitconfig" || (parent === "git" && dir.includes(".config"))) return hit("git");
  if (dir.includes(".ssh")) return hit("ssh");
  if (SHELL_FILES.has(name)) return hit("shell");
  if (name === "profile.ps1" && (parent === "powershell" || parent === "windowspowershell"))
    return hit("shell");
  if (dir.includes(".config") && dir.includes("fish") && /\.fish$/.test(name)) return hit("shell");
  const joined = dir.join("/");
  if (
    joined.includes("start menu/programs/startup") ||
    joined.endsWith(".config/autostart") ||
    joined.endsWith("library/launchagents")
  )
    return hit("startup");
  return null;
}

/** Agent CLIs' commands that change their own configuration, and their no-safety flags. */
const CLI_CONFIG =
  /(?:^|[\s;&|(])(?:codex|claude|gemini|cursor-agent|copilot|qwen)(?:\.cmd|\.exe)?\s+mcp\s+(?:add|add-json|add-from-claude-desktop|remove|import)\b/i;
const NO_SAFETY =
  /--dangerously-bypass-approvals-and-sandbox|--dangerously-skip-permissions|--yolo\b|(?:^|\s)-c\s+["']?(?:approval_policy|sandbox_mode|mcp_servers)\b/i;

/**
 * Whether a command line looks like it changes an agent's configuration or a startup file: it
 * names one of the files above (`>> ~/.bashrc`, `cp x .codex/config.toml`), runs an agent CLI's
 * `mcp add`, or starts one without its safety checks. A heuristic: a shell can write anything.
 */
export function commandTouchesConfig(
  line: string,
  workspaceFolder = "",
): (ProtectedConfig & { subject: string }) | null {
  if (CLI_CONFIG.test(line))
    return {
      risk: "mcp",
      reason: "It changes an AI agent's MCP servers: programs that agent starts in every session.",
      subject: CLI_CONFIG.exec(line)?.[0].trim() ?? line,
    };
  if (NO_SAFETY.test(line))
    return {
      risk: "agent",
      reason: "It starts an AI agent with its approvals and sandbox turned off.",
      subject: NO_SAFETY.exec(line)?.[0].trim() ?? line,
    };
  for (const raw of line.split(/[\s"'`<>|;&()=,]+/)) {
    const token = raw.replace(
      /^(?:\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)(?=[\\/])/i,
      "~",
    );
    if (!/[./\\]/.test(token)) continue;
    const found = protectedConfig(token, workspaceFolder);
    if (found) return { ...found, subject: raw };
  }
  return null;
}

/** The question's detail: what the file is, and that it asks even with full access. */
export function configQuestionDetail(found: ProtectedConfig): string {
  return `${found.reason} An instruction hidden in a file or web page could have asked for this, so it asks even with full access.`;
}

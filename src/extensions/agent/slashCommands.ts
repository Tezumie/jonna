// Slash commands (D111, D200): the built-ins (/compact, /clear, /model, /review, /init) and the
// prompt files in <workspace folder>/commands, .claude/commands and .cursor/commands, then the
// user's own (<config>/commands and ~/.claude/commands). A file's front matter gives its
// description, argument hint, model and allowed tools; its body takes $ARGUMENTS / $1…$9,
// `!`command`` lines (run in the folder once approved, like run_command) and @files (their text
// is added). Subfolders hold commands named `folder:name`, and `allowed-tools` narrows the
// command's turn to those tools and the read-only ones (D203); in the user's own files it also
// pre-approves them for that turn, and `disallowed-tools` takes tools away (D207). The format's
// logic is DOM-free in core/agent/slash.ts.
import {
  bashAllowed,
  COMMAND_DEPTH,
  commandFileFor,
  commandNameFor,
  expandArguments,
  fileRefs,
  inlineShell,
  lineDisallowed,
  parseCommandFile,
  parseSlash,
  shellRefs,
  type TurnTools,
  turnToolsFor,
} from "../../core/agent/slash";
import type { Caller } from "../../core/dispatcher/types";
import { fsIpc } from "../../core/ipc/fs";
import { execIpc } from "../../core/ipc/process";
import { appIpc } from "../../core/ipc/system";
import { dirname, isWithin, joinPath, relativePath, resolveInRoot } from "../../core/paths/index";
import type { WorkbenchServices } from "../../workbench/services";
import { workspaceFolderLabelsOf } from "../../workbench/workspaceFolder";
import { readText } from "./changeset";
import { newId } from "./ids";
import { agentIgnored } from "./ignore";
import {
  commandAllowed,
  commandDenied,
  DEFAULT_DENIED_COMMANDS,
  mayDeleteFiles,
  permissionKey,
} from "./permissions";
import { activePlugins, pluginLabel } from "./pluginContributions";
import type { AgentSession } from "./session";

export interface SlashCommand {
  name: string;
  description: string;
  /** Where it comes from: "built-in" or the folder ("<workspace folder>/commands"). */
  source: string;
  /** What to type after it (`argument-hint`). */
  argumentHint?: string;
  /** The model it runs on (`model`). */
  model?: string;
  /** Its file (a prompt file's command). */
  path?: string;
  /** From the user's own folders rather than the project's. */
  user?: boolean;
  /** Other names it answers to ("/new" for /clear, D389). */
  aliases?: readonly string[];
}

const builtin = (
  name: string,
  description: string,
  more: { argumentHint?: string; aliases?: readonly string[] } = {},
): SlashCommand => ({ name, description, source: "built-in", ...more });

/**
 * The built-in commands, Claude Code's set where the IDE has the feature (D389): the chat, its
 * context, models, review, setup pages, and the IDE's own (/btw, /undo).
 */
export const BUILTIN_COMMANDS: readonly SlashCommand[] = [
  // The conversation.
  builtin("clear", "Start a new chat (this one stays in Chats)", { aliases: ["new", "reset"] }),
  builtin("compact", "Summarize the conversation so far (optionally: what to keep)", {
    argumentHint: "[what to keep]",
  }),
  builtin("btw", "Ask a side question; the answer doesn't join the conversation", {
    argumentHint: "<question>",
  }),
  builtin("undo", "Put back the files the last turn changed (the chat stays)"),
  builtin("rewind", "Go back to before one of your messages: the chat and its files"),
  builtin("fork", "Continue this chat as a copy, leaving this one as it is"),
  builtin("resume", "Open an earlier chat"),
  builtin("rename", "Rename this chat", { argumentHint: "[name]" }),
  builtin("export", "Open this chat as a Markdown document"),
  builtin("copy", "Copy the agent's last answer"),
  // What the agent works with.
  builtin("context", "How full this chat's context is, and what's in it"),
  builtin("usage", "Tokens and cost: this chat, today, and by model", { aliases: ["cost"] }),
  builtin("model", "Choose this chat's model", { argumentHint: "[provider/model]" }),
  builtin("effort", "How hard the model thinks (low, medium, high…)", {
    argumentHint: "[level]",
  }),
  builtin("plan", "Plan first: the agent proposes, you approve, then it builds", {
    argumentHint: "[task]",
  }),
  builtin(
    "output-style",
    "Choose how the agent talks while it works (Default, Explanatory, Learning…)",
    {
      argumentHint: "[style]",
    },
  ),
  builtin("todos", "This chat's plan"),
  builtin("tasks", "Background commands, subagents and helpers", { aliases: ["bashes"] }),
  builtin(
    "loop",
    "Have the agent check something again and again (self-paced, or every interval)",
    {
      argumentHint: "[interval] <what to check>",
    },
  ),
  // Review and setup.
  builtin("review", "Review the uncommitted changes in a new chat", {
    argumentHint: "[what to look at]",
  }),
  builtin("security-review", "Review the uncommitted changes for security problems"),
  builtin("init", "Write an AGENTS.md for this project (you review it)", {
    argumentHint: "[anything to include]",
  }),
  builtin("memory", "The agent's memory: what it keeps about this project and you"),
  builtin("agents", "Agents and subagents: who answers, their models and tools", {
    aliases: ["subagents"],
  }),
  builtin("skills", "Skills the agent can use"),
  builtin("rules", "Rules files (AGENTS.md, CLAUDE.md…) and which apply"),
  builtin("mcp", "MCP servers: add, check, turn tools on or off"),
  builtin("hooks", "Commands that run on the agent's events"),
  builtin("permissions", "What the agent may do without asking", { aliases: ["allowed-tools"] }),
  builtin("plugin", "Claude Code plugins: add a marketplace, install, enable or remove one", {
    argumentHint: "[marketplace add <source> | install <name@marketplace> | …]",
  }),
  builtin("add-dir", "Add a folder to this workspace"),
  builtin("config", "The agent's settings", { aliases: ["settings"] }),
  builtin("help", "Every slash command, with what it does"),
  builtin("release-notes", "What's new in this version"),
  builtin("bug", "Report a problem with the IDE", { aliases: ["feedback"] }),
];

/** The built-in a message names, by its name or another one (D389). */
export function builtinFor(name: string): SlashCommand | undefined {
  const n = name.toLowerCase();
  return BUILTIN_COMMANDS.find((c) => c.name === n || c.aliases?.includes(n));
}

/**
 * Built-in commands that act on a chat instead of sending a message (D389): name to what they do
 * with that chat and what follows the name (they throw to refuse it).
 */
export const sessionSlash = new Map<
  string,
  (session: AgentSession, args: string, caller: Caller) => Promise<Record<string, unknown>>
>();

/** The chat command a message runs, if it's one (its name or another one). */
export function sessionSlashFor(message: string): {
  run: (session: AgentSession, args: string, caller: Caller) => Promise<Record<string, unknown>>;
  args: string;
} | null {
  const m = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(message.trim());
  const name = m?.[1] ? (builtinFor(m[1])?.name ?? m[1]) : undefined;
  const run = name ? sessionSlash.get(name) : undefined;
  return run ? { run, args: (m?.[2] ?? "").trim() } : null;
}

/**
 * Built-in commands whose work lives in their own module (/loop, D332): name to the context the
 * message goes with (they throw to refuse it).
 */
export const builtinSlash = new Map<
  string,
  (session: AgentSession, args: string) => Promise<{ context: string }>
>();

/**
 * Built-in commands that act instead of sending a message (/plugin, D358): name to what they do
 * with what follows the name (they throw to refuse it).
 */
export const actionSlash = new Map<
  string,
  (args: string, caller: Caller) => Promise<Record<string, unknown>>
>();

/** The action command a message runs, if it's one. */
export function actionSlashFor(message: string): {
  run: (args: string, caller: Caller) => Promise<Record<string, unknown>>;
  args: string;
} | null {
  const m = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(message.trim());
  const run = m?.[1] ? actionSlash.get(m[1]) : undefined;
  return run ? { run, args: (m?.[2] ?? "").trim() } : null;
}

const SHELL_TIMEOUT_MS = 30_000;
const SHELL_OUTPUT = 8000;
const FILE_LIMIT = 20_000;
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}]*${BEL}`, "g");

let home: Promise<string | null> | undefined;
const homeDir = () => {
  home ??= appIpc
    .info()
    .then((i) => i.homeDir)
    .catch(() => null);
  return home;
};

/**
 * The folders commands come from, in precedence order: the project's, then the user's. D251: in
 * a multi-root workspace each folder's, the first first, labeled with the folder's name; `root`
 * is the workspace folder a project command belongs to (its `!` lines run there).
 */
export async function commandFolders(
  services: WorkbenchServices,
): Promise<{ dir: string; label: string; user?: boolean; root?: string; prefix?: string }[]> {
  const others = services.settings.peek<boolean>("agent.thirdPartyConfigs") !== false;
  const root = services.workspace.root.peek();
  const out: { dir: string; label: string; user?: boolean; root?: string; prefix?: string }[] = [];
  const listed = services.workspace.folders.peek();
  const folders = root ? (listed.length ? listed : [{ path: root, name: root }]) : [];
  const several = folders.length > 1;
  for (const f of folders)
    for (const label of [
      ...workspaceFolderLabelsOf(f.path, "commands"),
      // Other AI tools' commands, unless the user turned that off (agent.thirdPartyConfigs, D179).
      ...(others ? [".claude/commands", ".cursor/commands"] : []),
    ])
      out.push({
        dir: resolveInRoot(f.path, label),
        label: several ? `${f.name}/${label}` : label,
        root: f.path,
      });
  const settings = services.settings.filePath("user");
  if (settings)
    out.push({ dir: joinPath(dirname(settings), "commands"), label: "your commands", user: true });
  const h = others ? await homeDir() : null;
  if (h)
    out.push({
      dir: joinPath(joinPath(h, ".claude"), "commands"),
      label: "~/.claude/commands",
      user: true,
    });
  // D358: the enabled plugins' commands, named `<plugin>:<command>` as in Claude Code (the plain
  // name works too when nothing before it has it). Installed by the user: theirs, like the above.
  for (const p of activePlugins.peek())
    for (const dir of p.commandDirs)
      out.push({ dir, label: pluginLabel(p.name), user: true, prefix: `${p.name}:` });
  return out;
}

/** Command files listed per commands folder, subfolders included. */
const FILES_PER_FOLDER = 200;

/**
 * The command files of a commands folder: its own `.md` files, then its subfolders' as
 * `folder:name` (D203, Claude Code's naming), at most COMMAND_DEPTH deep and FILES_PER_FOLDER.
 */
async function commandFiles(dir: string): Promise<{ name: string; path: string }[]> {
  const out: { name: string; path: string }[] = [];
  const walk = async (folder: string, rel: string, depth: number) => {
    const entries = await fsIpc.listDir(folder).catch(() => []);
    const subfolders: { path: string; name: string }[] = [];
    for (const e of entries) {
      if (out.length >= FILES_PER_FOLDER) return;
      if (e.kind === "dir") {
        if (depth < COMMAND_DEPTH && /^[\w-]+$/.test(e.name)) subfolders.push(e);
        continue;
      }
      const name = commandNameFor(`${rel}${e.name}`);
      if (name) out.push({ name, path: e.path });
    }
    for (const sub of subfolders) await walk(sub.path, `${rel}${sub.name}/`, depth + 1);
  };
  await walk(dir, "", 1);
  return out;
}

/** Built-in commands, then the folders' own (first folder wins for a name). */
export async function slashCommands(services: WorkbenchServices): Promise<SlashCommand[]> {
  const out: SlashCommand[] = [...BUILTIN_COMMANDS];
  for (const { dir, label, user, prefix } of await commandFolders(services)) {
    for (const found of await commandFiles(dir)) {
      const e = prefix ? { ...found, name: `${prefix}${found.name}` } : found;
      if (out.some((c) => c.name === e.name)) continue;
      const file = parseCommandFile((await readText(services, e.path)) ?? "");
      const firstLine = file.body
        .split("\n")
        .find((l) => l.trim())
        ?.trim();
      out.push({
        name: e.name,
        description: (file.description ?? firstLine ?? "").replace(/^#+\s*/, "").slice(0, 100),
        source: label,
        path: e.path,
        ...(user && { user: true }),
        ...(file.argumentHint && { argumentHint: file.argumentHint }),
        ...(file.model && { model: file.model }),
      });
    }
  }
  return out;
}

/** /init's prompt (D200): the agent writes the file, and the user reviews it like any edit. */
function initPrompt(args: string): string {
  return `The user ran /init. Write an AGENTS.md at the folder's root for coding agents working on this project. Look first (list_dir, read the README and the build files such as package.json, Cargo.toml or pyproject.toml, find the test setup), then write it with write_file. Keep it short and specific to this project (at most about 120 lines): what the project is in a sentence; how to install, build, run and test it (the exact commands); how the code is laid out; the conventions and gotchas a newcomer would miss. Don't pad it with generic advice. If AGENTS.md (or CLAUDE.md, .cursorrules, .github/copilot-instructions.md) already exists, read it and improve it rather than starting over. The user reviews the file before keeping it, so finish with a two-line summary of what you wrote.${args ? `\n\nAlso: ${args}` : ""}`;
}

/**
 * Whether a command line runs without asking (as run_command decides, D117, D179). A project's
 * command file (`fromProject`) can't approve its own lines with `allowed-tools`, and in a folder
 * that isn't trusted every one of its lines asks (a cloned repository's .claude/commands could
 * otherwise run anything when the user types its name). The denylist and delete protection
 * always come first.
 */
function preApproved(
  services: WorkbenchServices,
  command: string,
  allowedTools: string[],
  fromProject: boolean,
): boolean {
  const s = services.settings;
  if (s.peek<boolean>("agent.deleteProtection") === true && mayDeleteFiles(command)) return false;
  if (
    commandDenied(command, [
      ...DEFAULT_DENIED_COMMANDS,
      ...(s.peek<string[]>("agent.deniedCommands") ?? []),
    ])
  )
    return false;
  if (fromProject && !services.trust.trusted) return false;
  if (!fromProject && bashAllowed(allowedTools, command)) return true;
  return (
    s.peek<string>("agent.runCommands") !== "ask" ||
    commandAllowed(command, s.peek<string[]>("agent.allowedCommands") ?? [])
  );
}

/** Runs a command file's `!`command`` line in the folder, after the user's approval. */
async function runShellLine(
  services: WorkbenchServices,
  session: AgentSession,
  command: string,
  name: string,
  allowedTools: string[],
  fromProject: boolean,
  /** The workspace folder the command file is in (D251); the first folder by default. */
  inFolder?: string,
): Promise<string> {
  const root = inFolder ?? services.workspace.root.peek();
  if (!root) return "(not run: no folder is open)";
  if (!preApproved(services, command, allowedTools, fromProject)) {
    const always = permissionKey(command);
    const answer = await session.askBeforeSend({
      title: `Run \`${command}\` for /${name}`,
      heading: `Run a command for /${name}`,
      code: command,
      kind: "command",
      always,
    });
    if (answer === "deny") return "(not run: the user said no)";
    if (answer === "always") {
      const list = services.settings.peek<string[]>("agent.allowedCommands") ?? [];
      await services.settings
        .update("agent.allowedCommands", [...list, always], "user")
        .catch(() => {});
    }
  }
  let output = "";
  try {
    const r = await execIpc.run(
      newId("x"),
      command,
      { cwd: root, timeoutMs: SHELL_TIMEOUT_MS },
      (chunk) => {
        output += chunk;
        if (output.length > 4 * SHELL_OUTPUT) output = output.slice(-2 * SHELL_OUTPUT);
      },
    );
    const plain = output.replace(ANSI, "");
    const tail = plain.length > SHELL_OUTPUT ? `…\n${plain.slice(-SHELL_OUTPUT)}` : plain;
    return r.exitCode === 0 ? tail : `${tail}\n[exit ${r.timedOut ? "timed out" : r.exitCode}]`;
  } catch (err) {
    return `(couldn't run: ${err instanceof Error ? err.message : String(err)})`;
  }
}

/** The text of the `@path` files a command names (in the folder, not excluded from the agent). */
async function inlineFiles(
  services: WorkbenchServices,
  body: string,
  inFolder?: string,
): Promise<string[]> {
  const { workspace } = services;
  const root = inFolder ?? workspace.root.peek();
  if (!root) return [];
  const out: string[] = [];
  for (const ref of fileRefs(body).slice(0, 10)) {
    // Relative to the command's own folder; a folder's name in front picks another (D251).
    const own = resolveInRoot(root, ref);
    const abs = isWithin(root, own) ? own : workspace.resolve(ref);
    // In one of the workspace's folders only.
    if (!workspace.contains(abs) && !isWithin(root, abs)) continue;
    const rel = workspace.contains(abs) ? workspace.relative(abs) : relativePath(root, abs);
    if (agentIgnored(services, abs)) {
      out.push(`@${ref}: excluded from the agent (its content wasn't sent)`);
      continue;
    }
    const text = await readText(services, abs);
    if (text === null) continue;
    out.push(
      `Contents of ${rel}:\n\`\`\`\n${text.length > FILE_LIMIT ? `${text.slice(0, FILE_LIMIT)}\n… (truncated; use read_file for the rest)` : text}\n\`\`\``,
    );
  }
  return out;
}

/**
 * A prompt slash command (`/name args`): /init, or a command file. Returns the context to send
 * with the message (and the model it asks for), or null when the message isn't one.
 */
export async function promptSlash(
  services: WorkbenchServices,
  session: AgentSession,
  message: string,
): Promise<{ context: string; model?: string; turnTools?: TurnTools } | null> {
  const parsed = parseSlash(message);
  if (!parsed) return null;
  const { name, args } = parsed;
  if (name === "init") return { context: initPrompt(args) };
  const builtin = builtinSlash.get(name);
  if (builtin) return builtin(session, args);
  const plainFile = commandFileFor(name);
  if (!plainFile) return null;
  for (const { dir, label, user, root, prefix } of await commandFolders(services)) {
    // A plugin's command is `<plugin>:<command>` (D358); its plain name works too.
    const relFile =
      prefix && name.startsWith(prefix)
        ? (commandFileFor(name.slice(prefix.length)) ?? plainFile)
        : plainFile;
    const text = await readText(
      services,
      relFile.split("/").reduce((at, part) => joinPath(at, part), dir),
    );
    if (text === null) continue;
    const file = parseCommandFile(text);
    let prompt = expandArguments(file.body, args);
    const lines = shellRefs(prompt).slice(0, 10);
    if (lines.length) {
      const outputs = new Map<string, string>();
      for (const line of lines)
        outputs.set(
          line,
          // disallowed-tools refuses its Bash lines here too (D207), and all of them for `Bash`.
          file.disallowedTools.some((t) => t.trim() === "Bash") ||
            lineDisallowed(file.disallowedTools, line)
            ? "(not run: the command's disallowed-tools refuses it)"
            : await runShellLine(services, session, line, name, file.allowedTools, !user, root),
        );
      prompt = inlineShell(prompt, outputs);
    }
    const files = await inlineFiles(services, prompt, root);
    // allowed-tools narrows this turn's tools to those and the read-only ones (D203); in the
    // user's own command it also pre-approves them (D207); disallowed-tools takes tools away.
    const notes = [
      file.allowedTools.length &&
        `you have only the tools it names, ${file.allowedTools.join(", ")}, and the read-only ones${user ? " (the ones it names run without asking)" : ""}`,
      file.disallowedTools.length &&
        `you may not use ${file.disallowedTools.join(", ")} (those calls are refused)`,
    ].filter(Boolean);
    const tools = notes.length ? `\n\n(For this command ${notes.join("; ")}.)` : "";
    const turnTools = turnToolsFor(file, !!user);
    return {
      context: `The user ran the command /${name} (${label}/${relFile}). Follow it:\n${prompt}${tools}${files.length ? `\n\n${files.join("\n\n")}` : ""}`,
      ...(file.model && { model: file.model }),
      ...(turnTools && { turnTools }),
    };
  }
  return null;
}

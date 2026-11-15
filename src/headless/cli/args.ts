// The command line's arguments: what was typed, as one object, or a usage error that says what
// to do next. Pure (no process, no files): main.ts hands it `process.argv.slice(2)`.

export const ACCESS_MODE_NAMES = ["ask", "accept-edits", "auto", "full-access"] as const;
export type AccessModeName = (typeof ACCESS_MODE_NAMES)[number];
export const OUTPUT_FORMATS = ["text", "json", "stream-json"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
export const SUBCOMMANDS = ["exec", "serve", "acp", "sessions", "help"] as const;
export type Subcommand = "main" | "exec" | "serve" | "acp" | "sessions";

/** Bad usage: exit code 2, the message on stderr with a pointer to `--help`. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface CliArgs {
  command: Subcommand;
  /** `sessions list` or `sessions show <id>`. */
  sessionsAction?: "list" | "show";
  /** `sessions show <id>`. */
  sessionsId?: string;
  help: boolean;
  version: boolean;
  /** The prompt from `-p`, `exec` or the positional words. */
  prompt?: string;
  /** `-p` / `--prompt` was given (one shot, even at a terminal). */
  promptFlag: boolean;
  promptFile?: string;
  /** A lone `-`: the prompt is read from standard input. */
  stdinPrompt: boolean;
  cwd?: string;
  addDirs: string[];
  continue: boolean;
  /** `--resume <id>`; true: `--resume` alone (the interactive session lists the chats). */
  resume?: string | true;
  sessionId?: string;
  model?: string;
  agent?: string;
  effort?: string;
  mode?: string;
  permissionMode?: AccessModeName;
  allow: string[];
  deny: string[];
  nonInteractive: boolean;
  /** The interactive session even without a terminal (lines on a pipe). */
  interactive: boolean;
  outputFormat: OutputFormat;
  maxSteps?: number;
  maxCost?: number;
  /** Seconds. */
  timeout?: number;
  review: boolean;
  /** Trust the folder (its hooks, MCP servers, tasks and settings), and remember it. */
  trust: boolean;
  userDataDir?: string;
  /** Settings for this run only: JSON text, or the path of a JSON file. */
  settings?: string;
  host?: string;
  verbose: boolean;
  /** `--color` / `--no-color`; undefined: decided by the terminal and the environment. */
  color?: boolean;
  /** `serve`: the port (0 or left out: one the system picks) and the token (left out: random). */
  port?: number;
  token?: string;
  /** `sessions list --all`: every folder's chats. */
  all: boolean;
  /** `sessions`: JSON instead of text. */
  json: boolean;
}

type Kind = "boolean" | "string" | "number" | "list" | "optional";

interface FlagSpec {
  /** Without the dashes. */
  name: string;
  short?: string;
  kind: Kind;
  /** The value's placeholder in the help. */
  value?: string;
  help: string;
  /** Allowed values. */
  choices?: readonly string[];
  /** Subcommands that take it; left out: the runs (main and exec). */
  on?: readonly Subcommand[];
  set(args: CliArgs, value: string | number | boolean): void;
}

const RUNS: readonly Subcommand[] = ["main", "exec"];
const EVERYWHERE: readonly Subcommand[] = ["main", "exec", "serve", "acp", "sessions"];
const SESSION_HOSTS: readonly Subcommand[] = ["main", "exec", "serve", "acp"];

export const FLAGS: readonly FlagSpec[] = [
  {
    name: "prompt",
    short: "p",
    kind: "optional",
    value: "text",
    help: "Run this prompt and exit (one shot). Alone: the prompt comes from standard input.",
    set: (a, v) => {
      a.promptFlag = true;
      if (typeof v === "string") a.prompt = v;
    },
  },
  {
    name: "prompt-file",
    kind: "string",
    value: "path",
    help: "Read the prompt from a file.",
    set: (a, v) => {
      a.promptFile = String(v);
    },
  },
  {
    name: "cwd",
    kind: "string",
    value: "dir",
    help: "The folder to work in (default: the current folder).",
    on: EVERYWHERE,
    set: (a, v) => {
      a.cwd = String(v);
    },
  },
  {
    name: "add-dir",
    kind: "list",
    value: "dir",
    help: "Another folder the agent may work in (repeatable).",
    on: SESSION_HOSTS,
    set: (a, v) => {
      a.addDirs.push(String(v));
    },
  },
  {
    name: "continue",
    short: "c",
    kind: "boolean",
    help: "Continue the last chat of this folder.",
    set: (a) => {
      a.continue = true;
    },
  },
  {
    name: "resume",
    short: "r",
    kind: "optional",
    value: "id",
    help: "Resume a chat by id (see `sessions list`). Alone, in a terminal: pick from a list.",
    set: (a, v) => {
      a.resume = typeof v === "string" ? v : true;
    },
  },
  {
    name: "session-id",
    kind: "string",
    value: "id",
    help: "Use this id for the chat: resumed when it exists, else a new chat with that id.",
    set: (a, v) => {
      a.sessionId = String(v);
    },
  },
  {
    name: "model",
    short: "m",
    kind: "string",
    value: "model",
    help: "provider/model (ollama/qwen3:8b), a model's name, or an external agent[:its model].",
    on: SESSION_HOSTS,
    set: (a, v) => {
      a.model = String(v);
    },
  },
  {
    name: "agent",
    kind: "string",
    value: "name",
    help: "One of your own agents, or an external agent (ACP), by name.",
    on: SESSION_HOSTS,
    set: (a, v) => {
      a.agent = String(v);
    },
  },
  {
    name: "effort",
    kind: "string",
    value: "level",
    help: "Reasoning effort: low, medium, high… (what the model or the external agent offers).",
    on: SESSION_HOSTS,
    set: (a, v) => {
      a.effort = String(v);
    },
  },
  {
    name: "mode",
    kind: "string",
    value: "mode",
    help: "agent (default), plan (read-only, writes a plan) or ask (read-only answers).",
    choices: ["agent", "plan", "ask"],
    on: SESSION_HOSTS,
    set: (a, v) => {
      a.mode = String(v);
    },
  },
  {
    name: "permission-mode",
    kind: "string",
    value: "mode",
    help: "ask, accept-edits, auto or full-access (default: your settings).",
    choices: ACCESS_MODE_NAMES,
    on: SESSION_HOSTS,
    set: (a, v) => {
      a.permissionMode = v as AccessModeName;
    },
  },
  {
    name: "allow",
    kind: "list",
    value: "pattern",
    help: 'Allow without asking: a tool (write_file, mcp__server__*), or a command ("npm test").',
    on: SESSION_HOSTS,
    set: (a, v) => {
      a.allow.push(String(v));
    },
  },
  {
    name: "deny",
    kind: "list",
    value: "pattern",
    help: "Never allow, whatever the mode: the same patterns.",
    on: SESSION_HOSTS,
    set: (a, v) => {
      a.deny.push(String(v));
    },
  },
  {
    name: "non-interactive",
    kind: "boolean",
    help: "Never ask: what would ask is refused, unless the mode or --allow lets it.",
    set: (a) => {
      a.nonInteractive = true;
    },
  },
  {
    name: "interactive",
    short: "i",
    kind: "boolean",
    help: "The interactive session even when input isn't a terminal (lines on a pipe).",
    set: (a) => {
      a.interactive = true;
    },
  },
  {
    name: "output-format",
    kind: "string",
    value: "format",
    help: "text (default), json (one result object) or stream-json (one event per line).",
    choices: OUTPUT_FORMATS,
    set: (a, v) => {
      a.outputFormat = v as OutputFormat;
    },
  },
  {
    name: "max-steps",
    kind: "number",
    value: "n",
    help: "Stop after this many model requests.",
    set: (a, v) => {
      a.maxSteps = Number(v);
    },
  },
  {
    name: "max-cost",
    kind: "number",
    value: "amount",
    help: "Stop when the run has cost this much (dollars).",
    set: (a, v) => {
      a.maxCost = Number(v);
    },
  },
  {
    name: "timeout",
    kind: "number",
    value: "seconds",
    help: "Stop after this many seconds.",
    set: (a, v) => {
      a.timeout = Number(v);
    },
  },
  {
    name: "review",
    kind: "boolean",
    help: "Hold edits for review instead of writing them (one shot writes them by default).",
    on: SESSION_HOSTS,
    set: (a) => {
      a.review = true;
    },
  },
  {
    name: "trust",
    kind: "boolean",
    help: "Trust this folder: its hooks, MCP servers, tasks and settings apply. Remembered.",
    on: SESSION_HOSTS,
    set: (a) => {
      a.trust = true;
    },
  },
  {
    name: "user-data-dir",
    kind: "string",
    value: "dir",
    help: "A separate profile (settings, keys, chats), as the app's flag.",
    on: EVERYWHERE,
    set: (a, v) => {
      a.userDataDir = String(v);
    },
  },
  {
    name: "settings",
    kind: "string",
    value: "json|path",
    help: "Settings for this run only, above your own and the folder's: JSON, or a JSON file.",
    on: EVERYWHERE,
    set: (a, v) => {
      a.settings = String(v);
    },
  },
  {
    name: "host",
    kind: "string",
    value: "path",
    help: "The host program to start (default: beside this tool).",
    on: EVERYWHERE,
    set: (a, v) => {
      a.host = String(v);
    },
  },
  {
    name: "port",
    kind: "number",
    value: "n",
    help: "The port to listen on (default: one the system picks).",
    on: ["serve"],
    set: (a, v) => {
      a.port = Number(v);
    },
  },
  {
    name: "token",
    kind: "string",
    value: "text",
    help: "The secret a client must give (default: a random one, printed at start).",
    on: ["serve"],
    set: (a, v) => {
      a.token = String(v);
    },
  },
  {
    name: "all",
    kind: "boolean",
    help: "Every folder's chats, not only this folder's.",
    on: ["sessions"],
    set: (a) => {
      a.all = true;
    },
  },
  {
    name: "json",
    kind: "boolean",
    help: "JSON instead of text.",
    on: ["sessions"],
    set: (a) => {
      a.json = true;
    },
  },
  {
    name: "color",
    kind: "boolean",
    help: "Colour even when the output isn't a terminal.",
    on: EVERYWHERE,
    set: (a) => {
      a.color = true;
    },
  },
  {
    name: "no-color",
    kind: "boolean",
    help: "No colour or styling.",
    on: EVERYWHERE,
    set: (a) => {
      a.color = false;
    },
  },
  {
    name: "verbose",
    kind: "boolean",
    help: "Say more on stderr: the host's log, failed calls, each tool call.",
    on: EVERYWHERE,
    set: (a) => {
      a.verbose = true;
    },
  },
  {
    name: "version",
    short: "v",
    kind: "boolean",
    help: "Print the version.",
    on: EVERYWHERE,
    set: (a) => {
      a.version = true;
    },
  },
  {
    name: "help",
    short: "h",
    kind: "boolean",
    help: "Show help (also: help <command>).",
    on: EVERYWHERE,
    set: (a) => {
      a.help = true;
    },
  },
];

/** The flags subcommand `command` takes. */
export function flagsOf(command: Subcommand): FlagSpec[] {
  return FLAGS.filter((f) => (f.on ?? RUNS).includes(command));
}

export function emptyArgs(command: Subcommand = "main"): CliArgs {
  return {
    command,
    help: false,
    version: false,
    promptFlag: false,
    stdinPrompt: false,
    addDirs: [],
    continue: false,
    allow: [],
    deny: [],
    nonInteractive: false,
    interactive: false,
    outputFormat: "text",
    review: false,
    trust: false,
    verbose: false,
    all: false,
    json: false,
  };
}

/** How many single-character edits turn `a` into `b`. */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = row;
  }
  return previous[b.length] ?? 0;
}

/** The candidate closest to `word`, when one is close enough to be what was meant. */
export function closest(word: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const d = candidate.startsWith(word) && word.length >= 3 ? 0.5 : editDistance(word, candidate);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return bestDistance <= Math.max(2, Math.floor(word.length / 3)) ? best : undefined;
}

function unknownFlag(text: string, command: Subcommand): UsageError {
  const name = text.replace(/^-+/, "").split("=")[0] ?? "";
  const here = flagsOf(command);
  const elsewhere = FLAGS.find((f) => f.name === name && !here.includes(f));
  if (elsewhere) {
    const where = (elsewhere.on ?? RUNS).filter((c) => c !== "main");
    return new UsageError(
      command === "main"
        ? `--${name} belongs to: ${where.join(", ")}.`
        : `--${name} isn't an option of ${command}.`,
    );
  }
  const hit = closest(
    name,
    here.map((f) => f.name),
  );
  return new UsageError(`Unknown option ${text}.${hit ? ` Did you mean --${hit}?` : ""}`);
}

/**
 * Parses the arguments (without the program's own name). Throws a `UsageError` for an unknown
 * option (with the nearest one), a missing or bad value, or a subcommand used wrongly.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  const list = [...argv];
  let command: Subcommand = "main";
  let helpTopic = false;
  // The subcommand is the first word, before any option's value could be taken for it.
  const first = list[0];
  if (first === "help") {
    helpTopic = true;
    list.shift();
    const topic = list[0];
    if (topic && !topic.startsWith("-")) {
      if (!(SUBCOMMANDS as readonly string[]).includes(topic) || topic === "help")
        throw new UsageError(`No command named ${topic}. Commands: exec, serve, acp, sessions.`);
      command = topic as Subcommand;
      list.shift();
    }
  } else if (first === "exec" || first === "serve" || first === "acp" || first === "sessions") {
    command = first;
    list.shift();
  }
  const args = emptyArgs(command);
  if (helpTopic) args.help = true;
  const flags = flagsOf(command);
  const words: string[] = [];

  for (let i = 0; i < list.length; i++) {
    const arg = list[i] ?? "";
    if (arg === "--") {
      words.push(...list.slice(i + 1));
      break;
    }
    if (arg === "-") {
      args.stdinPrompt = true;
      continue;
    }
    if (!arg.startsWith("-") || /^-\d/.test(arg)) {
      words.push(arg);
      continue;
    }
    let spec: FlagSpec | undefined;
    let inline: string | undefined;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      if (eq >= 0) inline = arg.slice(eq + 1);
      spec = flags.find((f) => f.name === name);
    } else if (arg.length === 2) {
      spec = flags.find((f) => f.short === arg[1]);
    } else {
      // "-pTEXT" isn't offered: say what is.
      spec = undefined;
    }
    if (!spec) throw unknownFlag(arg, command);
    const shown = `--${spec.name}`;
    if (spec.kind === "boolean") {
      if (inline !== undefined) throw new UsageError(`${shown} takes no value.`);
      spec.set(args, true);
      continue;
    }
    let value = inline;
    if (value === undefined) {
      const next = list[i + 1];
      const isValue = next !== undefined && (!next.startsWith("-") || /^-\d/.test(next));
      if (isValue) {
        value = next;
        i++;
      } else if (spec.kind === "optional") {
        spec.set(args, true);
        continue;
      } else {
        throw new UsageError(`${shown} needs a value${spec.value ? ` (${spec.value})` : ""}.`);
      }
    }
    if (spec.choices && !spec.choices.includes(value)) {
      const hit = closest(value, spec.choices);
      throw new UsageError(
        `${shown} is one of ${spec.choices.join(", ")}; got "${value}".${hit ? ` Did you mean ${hit}?` : ""}`,
      );
    }
    if (spec.kind === "number") {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || value.trim() === "")
        throw new UsageError(`${shown} needs a number; got "${value}".`);
      spec.set(args, n);
    } else {
      if (value === "" && spec.kind !== "optional")
        throw new UsageError(`${shown} needs a value${spec.value ? ` (${spec.value})` : ""}.`);
      spec.set(args, value);
    }
  }

  if (command === "sessions") {
    const [action, id, ...rest] = words;
    if (args.help || args.version) return args;
    if (action === undefined || action === "list") {
      args.sessionsAction = "list";
      if (id !== undefined) throw new UsageError("sessions list takes no argument.");
    } else if (action === "show") {
      args.sessionsAction = "show";
      if (!id) throw new UsageError("sessions show needs a chat's id (see: sessions list).");
      if (rest.length) throw new UsageError("sessions show takes one id.");
      args.sessionsId = id;
    } else {
      const hit = closest(action, ["list", "show"]);
      throw new UsageError(
        `sessions: no action named ${action}.${hit ? ` Did you mean ${hit}?` : " Use list or show."}`,
      );
    }
    return args;
  }
  if (command === "serve" || command === "acp") {
    if (words.length) throw new UsageError(`${command} takes no prompt: "${words[0]}".`);
    return args;
  }
  if (words.length) {
    if (args.prompt !== undefined)
      throw new UsageError(
        `A prompt was given twice (with --prompt, and "${words[0]}"). Quote the prompt as one argument.`,
      );
    args.prompt = words.join(" ");
  }
  if (args.help || args.version) return args;
  if (args.promptFile !== undefined && args.prompt !== undefined)
    throw new UsageError("Give the prompt as an argument or with --prompt-file, not both.");
  const chats = [args.continue, args.resume !== undefined, args.sessionId !== undefined];
  if (chats.filter(Boolean).length > 1)
    throw new UsageError("Use one of --continue, --resume and --session-id.");
  if (args.sessionId !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(args.sessionId))
    throw new UsageError("--session-id takes letters, digits, - and _ (80 at most).");
  if (args.interactive && args.nonInteractive)
    throw new UsageError("--interactive and --non-interactive exclude each other.");
  if (args.interactive && (args.promptFlag || args.command === "exec"))
    throw new UsageError("--interactive starts a session; leave out --prompt / exec.");
  if (args.interactive && args.outputFormat !== "text")
    throw new UsageError("--output-format is for one-shot runs (--prompt, exec, piped input).");
  if (args.maxSteps !== undefined && (!Number.isInteger(args.maxSteps) || args.maxSteps < 1))
    throw new UsageError("--max-steps needs a whole number, 1 or more.");
  if (args.timeout !== undefined && args.timeout <= 0)
    throw new UsageError("--timeout needs a number of seconds above 0.");
  if (args.maxCost !== undefined && args.maxCost <= 0)
    throw new UsageError("--max-cost needs an amount above 0.");
  return args;
}

export type RunMode = "interactive" | "run" | "serve" | "acp" | "sessions";

export interface Terminals {
  /** Standard input is a terminal (a person can type). */
  stdin: boolean;
  /** Standard output is a terminal. */
  stdout: boolean;
}

/**
 * What to run: a session at the terminal, or one shot. One shot: `exec`, `--prompt`,
 * `--prompt-file`, `-`, a prompt with input or output that isn't a terminal, or piped input alone.
 */
export function decideMode(args: CliArgs, tty: Terminals): RunMode {
  if (args.command === "serve" || args.command === "acp" || args.command === "sessions")
    return args.command;
  if (args.interactive) return "interactive";
  if (args.command === "exec" || args.promptFlag || args.promptFile !== undefined) return "run";
  if (args.stdinPrompt) return "run";
  if (tty.stdin && tty.stdout) return "interactive";
  if (args.prompt !== undefined || !tty.stdin) return "run";
  throw new UsageError(
    "Output isn't a terminal: give a prompt to run (a quoted argument, --prompt-file, or piped input).",
  );
}

/**
 * Whether a one-shot run may stop to ask the person (a permission, a question): only with a
 * terminal to type at, and not with `--non-interactive`.
 */
export function mayAsk(args: CliArgs, mode: RunMode, tty: Terminals): boolean {
  if (args.nonInteractive) return false;
  if (mode === "interactive") return true;
  // A one shot reads its prompt from input that isn't a terminal: nobody is there to answer.
  return mode === "run" && tty.stdin && !args.stdinPrompt && args.outputFormat === "text";
}

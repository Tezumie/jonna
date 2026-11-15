// Node only. What every mode does first: find the host program, start the brain over it in the
// folder asked for, and open the chat the flags name. Failures here are configuration errors
// (exit 2) with a message that says what to do.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { product } from "../../core/product";
import { parseJsoncOrThrow } from "../../core/settings/jsonc";
import { externalAgents } from "../../extensions/agent/acpAgents";
import type { BrainChat, HeadlessPolicy, HostedBrain, UnattendedPolicy } from "../run";
import type { CliArgs } from "./args";
import { type KnownAgents, modelChoice, reviewOf } from "./config";

/** A problem with the setup, not with the task: exit code 2. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** The host started and then went away (a crash, a kill): exit code 1. */
export class HostGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostGoneError";
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The environment variable that names the host program. */
export const HOST_ENV = "IDE_HOST_PATH";

const HOST_NAME = process.platform === "win32" ? "ide-host.exe" : "ide-host";

/** The folder this bundle was loaded from. */
export function bundleDirectory(): string {
  // The entry's chunks live in `chunks/` beside it.
  const here = dirname(fileURLToPath(import.meta.url));
  return here.endsWith("chunks") ? dirname(here) : here;
}

/**
 * Where the host program may be, in the order they are tried: `--host`, the environment, beside
 * the bundle and up to two folders above it (an installed app keeps the host beside its own
 * program and the bundle in a folder under it), then a repository checkout's build folders.
 */
export function hostCandidates(
  flag: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  bundle: string,
): string[] {
  if (flag) return [resolve(flag)];
  const fromEnv = env[HOST_ENV];
  if (fromEnv) return [resolve(fromEnv)];
  const up = (n: number) => resolve(bundle, ...Array.from({ length: n }, () => ".."));
  const targets = [
    ...(env.CARGO_TARGET_DIR ? [resolve(env.CARGO_TARGET_DIR)] : []),
    join(up(1), "src-tauri", "target"),
  ];
  return [
    join(bundle, HOST_NAME),
    join(up(1), HOST_NAME),
    join(up(2), HOST_NAME),
    ...targets.flatMap((t) => [join(t, "release", HOST_NAME), join(t, "debug", HOST_NAME)]),
  ];
}

/** The host program to start, or a `ConfigError` that lists where it was looked for. */
export function findHost(flag: string | undefined): string {
  const candidates = hostCandidates(flag, process.env, bundleDirectory());
  const found = candidates.find((path) => existsSync(path));
  if (found) return found;
  if (flag) throw new ConfigError(`No host program at ${candidates[0]} (--host).`);
  if (process.env[HOST_ENV])
    throw new ConfigError(`No host program at ${candidates[0]} (${HOST_ENV}).`);
  throw new ConfigError(
    `The host program (${HOST_NAME}) wasn't found. Looked in:\n${candidates
      .map((c) => `  ${c}`)
      .join(
        "\n",
      )}\nPass --host <path>, or set ${HOST_ENV}. In a source checkout, build it with: cargo build --no-default-features --features host --bin ide-host (in src-tauri).`,
  );
}

/** The folder to work in: `--cwd`, else the current one. A `ConfigError` when it isn't a folder. */
export function workFolder(args: CliArgs): string {
  const folder = resolve(args.cwd ?? process.cwd());
  let isFolder = false;
  try {
    isFolder = statSync(folder).isDirectory();
  } catch {
    isFolder = false;
  }
  if (!isFolder) throw new ConfigError(`Not a folder: ${folder}${args.cwd ? " (--cwd)" : ""}.`);
  return folder;
}

/** `--settings`: JSON text, or a JSON file (comments allowed), as an object of settings. */
export function runSettings(value: string | undefined): Record<string, unknown> {
  if (value === undefined) return {};
  let text = value;
  let label = "--settings";
  if (!value.trim().startsWith("{")) {
    label = value;
    try {
      text = readFileSync(resolve(value), "utf8");
    } catch (err) {
      throw new ConfigError(`Couldn't read ${value} (--settings): ${messageOf(err)}`);
    }
  }
  let parsed: unknown;
  try {
    parsed = parseJsoncOrThrow(text, label);
  } catch (err) {
    throw new ConfigError(`--settings isn't valid JSON: ${messageOf(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new ConfigError('--settings takes an object: {"agent.model": "ollama/qwen3:8b"}.');
  return parsed as Record<string, unknown>;
}

export interface StartOptions {
  /** The front end's name in the audit log. */
  frontend: string;
  policy: UnattendedPolicy;
  /** Answers for the services' own questions (confirmations, pickers, trust). */
  services?: HeadlessPolicy;
  /** The host's log and failed backend calls (`--verbose`). */
  log?: (text: string) => void;
  /** Settings for the run only, beyond the flags' own. */
  settings?: Readonly<Record<string, unknown>>;
}

export interface Started {
  brain: HostedBrain;
  folder: string;
  /** Things worth telling the person once (a folder that isn't trusted, a host of another version). */
  notes: string[];
}

/**
 * Starts the host and the brain in the folder the flags name, adds the extra folders, and
 * resolves once the agent is ready. Rejects with a `ConfigError`.
 */
export async function start(args: CliArgs, options: StartOptions): Promise<Started> {
  const folder = workFolder(args);
  const extra = args.addDirs.map((dir) => {
    const path = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
    if (!existsSync(path)) throw new ConfigError(`Not a folder: ${path} (--add-dir).`);
    return path;
  });
  const hostBinary = findHost(args.host);
  const settings = { ...runSettings(args.settings), ...options.settings };
  const { openBrain, onFailedCall } = await import("../run");
  if (options.log) {
    const log = options.log;
    onFailedCall((call) => log(`[call failed] ${JSON.stringify(call)}\n`));
  }
  let brain: HostedBrain;
  try {
    brain = await openBrain({
      hostBinary,
      ...(args.userDataDir && { userDataDir: resolve(args.userDataDir) }),
      ...(options.log && { onHostLog: options.log }),
      folder,
      frontend: options.frontend,
      permissions: options.policy,
      ...(Object.keys(settings).length && { settings }),
      ...(args.trust && { trustFolder: true }),
      ...(options.services && { policy: options.services }),
    });
  } catch (err) {
    const message = messageOf(err);
    if (/speaks protocol|isn't the protocol/.test(message))
      throw new ConfigError(
        `${message} The host program (${hostBinary}) and this tool (${product.version}) are from different versions: install matching ones, or point --host at the right one.`,
      );
    throw new ConfigError(message);
  }
  const notes: string[] = [];
  try {
    if (brain.host && brain.host.version !== product.version)
      notes.push(
        `The host program is version ${brain.host.version}, this tool ${product.version}: they are meant to match.`,
      );
    const trusted = () => brain.services.trust.state.peek() === "trusted";
    if (extra.length) {
      const added = await brain.execute<{ added: { path: string }[] }>("workspace.addFolder", {
        paths: extra,
        // The folders join with the same standing the main one has.
        trust: trusted(),
      });
      if (added.added.length < extra.length)
        notes.push("Some --add-dir folders were not added (already part of the workspace?).");
    }
    if (!trusted())
      notes.push(
        "This folder isn't trusted: its own hooks, MCP servers, tasks and settings are off. Pass --trust to trust it (remembered).",
      );
  } catch (err) {
    await brain.dispose().catch(() => {});
    throw new ConfigError(messageOf(err));
  }
  return { brain, folder, notes };
}

/** The names `--agent` and `--model` may mean, from the running brain. */
export async function knownAgents(brain: HostedBrain): Promise<KnownAgents> {
  const external = externalAgents(brain.services).map((a) => a.name);
  const modes = (await brain.state("ide://agent/chatModes").catch(() => [])) as {
    id?: unknown;
    name?: unknown;
  }[];
  const custom = (Array.isArray(modes) ? modes : []).flatMap((m) =>
    typeof m.id === "string" && typeof m.name === "string" ? [{ id: m.id, name: m.name }] : [],
  );
  return { external, custom };
}

export interface OpenedChat {
  chat: BrainChat;
  /** The chat existed before (continued or resumed). */
  resumed: boolean;
}

/**
 * Opens the chat the flags name (`--continue`, `--resume`, `--session-id`, else a new one) with
 * their model, agent, effort and mode, and checks that some model can answer. `session`: a chat
 * to open instead of what the flags say (the session's own /resume).
 */
export async function openChat(
  brain: HostedBrain,
  args: CliArgs,
  oneShot: boolean,
  session?: string,
): Promise<OpenedChat> {
  const needNames = args.model !== undefined || args.agent !== undefined;
  const choice = modelChoice(
    args,
    needNames ? await knownAgents(brain) : { external: [], custom: [] },
  );
  if (Object.keys(choice.settings).length) brain.override(choice.settings);
  const id = session ?? (typeof args.resume === "string" ? args.resume : args.sessionId);
  const review = reviewOf(args, oneShot);
  let chat: BrainChat;
  try {
    chat = await brain.open({
      ...(id && { session: id }),
      ...(!session && args.sessionId && { create: true }),
      ...(!id && args.continue && { continue: true }),
      ...(choice.model && { model: choice.model }),
      ...(choice.agentModel !== undefined && { agentModel: choice.agentModel }),
      ...(choice.agentLevel !== undefined && { agentLevel: choice.agentLevel }),
      ...(choice.agentMode && { chatMode: choice.agentMode }),
      ...(review !== undefined && { review }),
    });
    if (choice.workMode)
      await brain.execute("agent.setChatMode", { session: chat.id, mode: choice.workMode });
    // The effort of an external agent the settings chose (no --model named it).
    if (args.effort && !choice.agentLevel && chat.session.model.peek()?.startsWith("acp/"))
      await brain.execute("agent.setAgentModel", {
        session: chat.id,
        setting: "thought_level",
        value: args.effort.trim().toLowerCase(),
      });
  } catch (err) {
    const message = messageOf(err);
    if (/No saved chat/.test(message))
      throw new ConfigError(`${message} See: sessions list${args.cwd ? "" : " (in this folder)"}.`);
    if (/isn't available/.test(message))
      throw new ConfigError(await noModelMessage(brain, message));
    throw new ConfigError(message);
  }
  const key = chat.session.model.peek();
  if (!key?.startsWith("acp/")) {
    const providers = brain.agent.providers;
    await providers.refreshIfStale(5000, 8000);
    if (!((key && providers.find(key)) || providers.defaultModel()))
      throw new ConfigError(await noModelMessage(brain));
  }
  return { chat, resumed: chat.session.items.length > 0 };
}

/** What to do when no model can answer: which providers there are and what each said. */
async function noModelMessage(brain: HostedBrain, first?: string): Promise<string> {
  const lines = [first ?? "No model is available."];
  const agent = (await brain.state("ide://agent").catch(() => null)) as {
    providers?: { id?: string; name?: string; state?: string; error?: string; models?: number }[];
  } | null;
  for (const p of agent?.providers ?? []) {
    if (p.state === "ok" && p.models) continue;
    lines.push(
      `  ${p.name ?? p.id}: ${p.state === "unreachable" ? "not reachable" : (p.error ?? "no models")}`,
    );
  }
  const models = brain.agent.providers.models.peek().map((m) => m.key);
  if (models.length)
    lines.push(
      `Models there are: ${models.slice(0, 12).join(", ")}${models.length > 12 ? "…" : ""}`,
    );
  lines.push(
    "What to do: start Ollama and pull a model (ollama pull qwen3:8b); or add a provider in the app (Agent: Add provider) or in the settings (agent.providers) and give its key in the environment (ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY…); or name an installed external agent with --agent. Then pick with --model <provider/model>.",
  );
  return lines.join("\n");
}

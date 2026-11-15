// Node only: the entry of the headless build (`node build.mjs --headless` bundles it as
// dist-headless/brain.mjs). What a command line builds on:
//
// - `openBrain(options)`: starts the host program, boots the brain over it and resolves with it
//   (brain.ts: commands as a front end, state, chats and their events). For a session that
//   lasts: an interactive terminal, a server.
// - `runHeadless(options)`: one prompt, start to finish: boot, open or continue a chat, send,
//   stream the events to a callback, resolve with the result, and shut everything down (the
//   host stopped, nothing left running: Node exits by itself).
import type { SessionEventListener } from "../extensions/agent/sessionEvents";
import type { UnattendedPolicy } from "../extensions/agent/unattended";
import {
  type Brain,
  type BrainOptions,
  type OpenChatOptions,
  type RunLimits,
  type RunResult,
  startBrain,
} from "./brain";
import { headlessExtensions } from "./extensions";
import { type HostBackend, hostBackend } from "./node/hostBackend";
import { nodeWorkers } from "./node/workers";

export type { Caller } from "../core/dispatcher/types";
/** Hears every backend call that failed (one listener; null stops): a command line's `--verbose`. */
export { type IpcError, onFailedCall } from "../core/ipc/invoke";
export type { HostInfo } from "../core/ipc/streamTransport";
export type {
  HeadlessPrompts,
  PendingPrompt,
  PromptPolicy,
} from "../extensions/agent/agentHost";
export type {
  SessionEvent,
  SessionEventListener,
  SessionUsage,
  TurnEndReason,
} from "../extensions/agent/sessionEvents";
export {
  ACCESS_MODES,
  type AccessMode,
  type PermissionDecision,
  type UnattendedPolicy,
} from "../extensions/agent/unattended";
export type {
  Brain,
  BrainChat,
  BrainOptions,
  OpenChatOptions,
  RunEndReason,
  RunLimits,
  RunResult,
  SavedChat,
} from "./brain";
export { headlessExtensions } from "./extensions";
export type { HeadlessPolicy } from "./services";

export interface HostOptions {
  /** The host program (`ide-host`). */
  hostBinary: string;
  /** A separate profile (the app's `--user-data-dir`); none: the app's own profile. */
  userDataDir?: string;
  /** The host's log (its stderr), in chunks; left out: dropped. */
  onHostLog?: (text: string) => void;
  /** The host's environment (left out: this process's, which is where API keys may be). */
  env?: Record<string, string | undefined>;
  /**
   * The folder of the bundled worker scripts (`workflow.worker.mjs`); default: the folder this
   * module was loaded from (the headless build puts them there). Null: no workflow scripts.
   */
  workerDirectory?: URL | null;
}

export type OpenBrainOptions = HostOptions &
  Omit<BrainOptions, "backend" | "workers" | "extensions"> & {
    /** The built-ins to activate; default `headlessExtensions()`. */
    extensions?: BrainOptions["extensions"];
  };

/** A brain over a host process this call started. */
export interface HostedBrain extends Brain {
  /** The host's handshake answer (its version, OS and commands). */
  readonly host: HostBackend["info"];
  /** The host process ended by itself (a crash): hear it to give up cleanly. */
  onHostExit(listener: (code: number | null, signal: string | null) => void): void;
}

/**
 * Starts the host program and a brain over it. Dispose the brain to end both. One per process:
 * the call layer underneath is module-level state.
 */
export async function openBrain(options: OpenBrainOptions): Promise<HostedBrain> {
  const { hostBinary, userDataDir, onHostLog, env, workerDirectory, ...brainOptions } = options;
  const exitListeners: ((code: number | null, signal: string | null) => void)[] = [];
  const backend = hostBackend({
    binary: hostBinary,
    ...(userDataDir && { userDataDir }),
    ...(env && { env }),
    ...(onHostLog && { onLog: onHostLog }),
    onExit: (code, signal) => {
      for (const listener of exitListeners) listener(code, signal);
    },
  });
  const directory = workerDirectory === undefined ? new URL(".", import.meta.url) : workerDirectory;
  const brain = await startBrain({
    ...brainOptions,
    extensions: brainOptions.extensions ?? headlessExtensions(),
    backend,
    workers: directory ? nodeWorkers(directory) : null,
  });
  // The end starts here: the close then waits for what the end itself sends, not for a probe
  // an extension started long ago (looking for a repository, the terminal's shells).
  const dispose = brain.dispose;
  brain.dispose = () => {
    backend.ending();
    return dispose();
  };
  return Object.assign(brain, {
    host: backend.info,
    onHostExit: (listener: (code: number | null, signal: string | null) => void) => {
      exitListeners.push(listener);
    },
  });
}

export interface RunHeadlessOptions extends HostOptions {
  /** The folder to work in; none: an answer-only chat. */
  folder?: string | null;
  /** The message to send. */
  prompt: string;
  /** Which chat: a saved one (`session`), the folder's latest (`continue`), else a new one. */
  session?: string;
  continue?: boolean;
  /** The model route: "<provider>/<model>", a model's name, or "acp/<agent>". */
  model?: string;
  agentModel?: string;
  agentLevel?: string;
  /** agent, plan, ask or `custom:<name>`. */
  chatMode?: OpenChatOptions["chatMode"];
  /** The permission policy; default: what the settings allow, and what would ask is refused. */
  permissions?: UnattendedPolicy;
  limits?: RunLimits;
  /** Settings for this run only (never written). */
  settings?: Readonly<Record<string, unknown>>;
  /** Every event of the chat, as it happens (the first is `session`). */
  onEvent?: SessionEventListener;
  frontend?: string;
  ideServer?: boolean;
  trustFolder?: boolean;
}

/**
 * One prompt from start to finish. Resolves with how it ended (never rejects for a turn that
 * failed: `reason` says); rejects when it couldn't start (no host, no folder, no such chat or
 * model). Either way everything it started has ended when it settles.
 */
export async function runHeadless(options: RunHeadlessOptions): Promise<RunResult> {
  const brain = await openBrain({
    hostBinary: options.hostBinary,
    ...(options.userDataDir && { userDataDir: options.userDataDir }),
    ...(options.onHostLog && { onHostLog: options.onHostLog }),
    ...(options.env && { env: options.env }),
    ...(options.workerDirectory !== undefined && { workerDirectory: options.workerDirectory }),
    folder: options.folder ?? null,
    ...(options.permissions && { permissions: options.permissions }),
    ...(options.settings && { settings: options.settings }),
    ...(options.frontend && { frontend: options.frontend }),
    ...(options.ideServer !== undefined && { ideServer: options.ideServer }),
    ...(options.trustFolder !== undefined && { trustFolder: options.trustFolder }),
  });
  try {
    const chat = await brain.open({
      ...(options.session && { session: options.session }),
      ...(options.continue && { continue: true }),
      ...(options.model && { model: options.model }),
      ...(options.agentModel !== undefined && { agentModel: options.agentModel }),
      ...(options.agentLevel !== undefined && { agentLevel: options.agentLevel }),
      ...(options.chatMode && { chatMode: options.chatMode }),
    });
    const events = options.onEvent ? chat.onEvent(options.onEvent) : null;
    try {
      return await chat.send(options.prompt, options.limits);
    } finally {
      events?.dispose();
    }
  } finally {
    await brain.dispose();
  }
}

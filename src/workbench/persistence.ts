// Persists UI state as JSON through Rust (atomic writes):
//   global    <appData>/state.json                          last opened folder, UI preferences
//   workspace <appData>/workspaces/<hash>/state.json         sidebar, dock tree, explorer expansion
// Contributors register a key with save/restore; saves are debounced.

import { type InstalledAgent, sanitizeInstalledMap } from "../core/acp/registry";
import { storeIpc } from "../core/ipc/system";
import { type Disposable, DisposableStore, toDisposable } from "../core/lifecycle/index";

const STATE_VERSION = 1;
const SAVE_DELAY_MS = 400;

export interface StateContributor {
  save(): unknown;
  restore(data: unknown): void | Promise<void>;
  /**
   * Restored before the rest, whatever the order they were registered in: state other parts read
   * while they restore (the agent's channels, which the dock's restored channel tabs open, D244).
   */
  early?: boolean;
}

export interface GlobalState {
  lastFolder?: string;
  /** Most recently opened folders, newest first (welcome tab, "Open recent"). */
  recentFolders?: string[];
  /** Folders pinned at the top of the recent list (D192). */
  pinnedFolders?: string[];
  /** Theme / density / panel style (validated by ThemeService.apply). */
  ui?: Record<string, unknown>;
  /** Workspace trust by folder (pathKey → trusted), D103. */
  trust?: Record<string, boolean>;
  /**
   * Tasks for agents in new windows (D193): "Start in a worktree" leaves one here for the window
   * it opens on the worktree, which takes it when it starts.
   */
  agentHandoffs?: AgentHandoff[];
  /** Helpers in worktrees asked to stop (D231): their windows look here while they work. */
  agentStops?: { id: string; at: number }[];
  /** Messages for helpers in windows of their own (their windows pass them on while they work). */
  agentHelperMessages?: { id: string; msg: string; text: string; at: number }[];
  /** Commands run from quick access, the most recent first (VS Code's command history, D262). */
  recentCommands?: string[];
  /** The welcome page's "Coming from VS Code?" link was dismissed (D194). */
  hideImportLink?: boolean;
  /** Notices the user turned off with "Don't show again" (D344, workbench/notices.ts). */
  hiddenNotices?: string[];
  /**
   * Extensions' `env.machineId` (D255): random, made once per installation, never derived from
   * the machine (VS Code's is a hash of a network address; extensions use it as a cache key).
   */
  installationId?: string;
  /** Images the user picked for their own model providers (provider id → image data URL, D212). */
  providerImages?: Record<string, string>;
  /** Risky folders (Downloads…) whose open-time caution was turned off (pathKeys, D213). */
  riskyFolderDismissed?: string[];
  /** External agents installed from the ACP agent registry, by registry id (D215). */
  acpAgents?: Record<string, InstalledAgent>;
  /** The agent preset last applied or saved (D230), so the Agents page can say "· changed". */
  lastPreset?: string;
  /** The chat's details panel (D231): its folded cards, and whether the user hid it. */
  /** The chat details panel (D231): folded cards, hidden, the cards' order (D409). */
  agentDetails?: { folded?: string[]; hidden?: boolean; order?: string[] };
  /** The built-in team's agent files were written once (D241); deleted ones stay deleted. */
  teamAgentsSeeded?: boolean;
  /** Which team agents were written (D245): one added to the team later is written once too. */
  teamAgentsWritten?: string[];
  /** The team's files were moved to their models' logos (D270), once. */
  teamIconsModel?: boolean;
  /** Extensions' log levels ("Set log level…"): "default" and channel ids → a level name. */
  logLevels?: Record<string, string>;
}

export interface AgentHandoff {
  /** The chat id to create (a window that sees an existing chat by that id skips it). */
  id: string;
  folder: string;
  task: string;
  model?: string;
  /** Where it came from (the main worktree), for the chat's first line. */
  from: string;
  branch: string;
  /** ms since epoch; older than ten minutes is dropped. */
  at: number;
  /** The chat mode it starts in (`custom:<name>`: one of the user's agents, D231). */
  mode?: string;
  /** That agent's name shown and instructions, for when its mode isn't there (D231). */
  label?: string;
  instructions?: string;
  /** A helper (D231): the chat that started it, which gets its report. */
  helper?: string;
  /** The tools its chat may use at most (D232: never more than the chat that started it). */
  tools?: string[];
}

/** Where state files are read and written (Rust in the app; a fake in unit tests). */
export interface StateBackend {
  load(scope: "global" | "workspace"): Promise<string | null>;
  save(scope: "global" | "workspace", json: string): Promise<void>;
}

/** A change to the global state: the keys to set, or a function of the current state. */
export type GlobalPatch = GlobalState | ((current: Readonly<GlobalState>) => GlobalState);

export class PersistenceService implements Disposable {
  private readonly store = new DisposableStore();
  private readonly contributors = new Map<string, StateContributor>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private restoring = false;
  /** Workspace saves are only allowed while a workspace is open. */
  private workspaceOpen = false;
  private global: GlobalState = {};
  /** Global writes, one after the other (each reads the file first). */
  private globalWrites: Promise<void> = Promise.resolve();

  constructor(private readonly backend: StateBackend = storeIpc) {
    this.store.add(toDisposable(() => clearTimeout(this.timer)));
  }

  /** Registers per-workspace state under `key`. Restore order = registration order. */
  register(key: string, contributor: StateContributor): Disposable {
    if (this.contributors.has(key)) throw new Error(`State key already registered: ${key}`);
    this.contributors.set(key, contributor);
    return toDisposable(() => this.contributors.delete(key));
  }

  /** Call whenever contributed state changed. */
  scheduleSave(): void {
    if (this.restoring || !this.workspaceOpen) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), SAVE_DELAY_MS);
  }

  /** Writes workspace state now (e.g. before switching folders or closing the window). */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.workspaceOpen || this.restoring) return;
    const data: Record<string, unknown> = { version: STATE_VERSION };
    for (const [key, contributor] of this.contributors) {
      try {
        data[key] = contributor.save();
      } catch (err) {
        console.warn(`state contributor "${key}" failed to save`, err);
      }
    }
    try {
      await this.backend.save("workspace", JSON.stringify(data));
    } catch (err) {
      console.warn("saving workspace state failed", err);
    }
  }

  /** Marks the workspace closed (stops saves until the next restore). */
  closeWorkspace(): void {
    clearTimeout(this.timer);
    this.workspaceOpen = false;
  }

  /** Loads the open workspace's state and hands each key to its contributor. */
  async restoreWorkspace(): Promise<void> {
    this.restoring = true;
    try {
      const text = await this.backend.load("workspace").catch(() => null);
      const data = parseState(text) ?? {};
      const ordered = [...this.contributors].sort(
        ([, a], [, b]) => Number(!!b.early) - Number(!!a.early),
      );
      for (const [key, contributor] of ordered) {
        if (!(key in data)) continue;
        try {
          await contributor.restore(data[key]);
        } catch (err) {
          console.warn(`state contributor "${key}" failed to restore`, err);
        }
      }
    } finally {
      this.restoring = false;
      this.workspaceOpen = true;
    }
  }

  async loadGlobal(): Promise<GlobalState> {
    this.global = (await this.readGlobal()) ?? {};
    return this.global;
  }

  /**
   * The global state on disk, or null when it can't be read or parsed (then nothing is known
   * about it, which isn't the same as an empty or missing file).
   */
  private async readGlobal(): Promise<GlobalState | null> {
    let text: string | null;
    try {
      text = await this.backend.load("global");
    } catch {
      return null;
    }
    const data = parseState(text);
    return data && sanitizeGlobal(data);
  }

  /**
   * Reads the global state again (another window may have changed it, D273); an unreadable file
   * keeps what this window has.
   */
  async refreshGlobal(): Promise<Readonly<GlobalState>> {
    const fresh = await this.readGlobal();
    if (fresh) this.global = fresh;
    return this.global;
  }

  /** The global state as last loaded or saved. */
  globalState(): Readonly<GlobalState> {
    return this.global;
  }

  /**
   * Merges `patch` into the global state and writes it (keys not in `patch` are kept). The file
   * is read again first: each window is its own process sharing the file, so what this window
   * loaded at startup may be stale, and writing that back would undo another window's changes
   * (a trust decision taken back, the folders it opened). A file that can't be read or parsed
   * keeps what this window has. Writes run one at a time.
   */
  saveGlobal(patch: GlobalPatch): Promise<void> {
    const run = async () => {
      const fresh = await this.readGlobal();
      if (fresh) this.global = fresh;
      const changes = typeof patch === "function" ? patch(this.global) : patch;
      this.global = { ...this.global, ...changes };
      await this.backend
        .save("global", JSON.stringify({ version: STATE_VERSION, ...this.global }))
        .catch((err) => {
          console.warn("saving global state failed", err);
        });
    };
    const next = this.globalWrites.then(run, run);
    this.globalWrites = next.catch(() => {});
    return next;
  }

  dispose(): void {
    this.store.dispose();
  }
}

/** The known keys of a global state file, each checked. */
function sanitizeGlobal(data: Record<string, unknown>): GlobalState {
  return {
    ...(typeof data.lastFolder === "string" && { lastFolder: data.lastFolder }),
    ...(Array.isArray(data.pinnedFolders) && {
      pinnedFolders: data.pinnedFolders.filter((p): p is string => typeof p === "string"),
    }),
    ...(Array.isArray(data.recentFolders) && {
      recentFolders: data.recentFolders.filter((p): p is string => typeof p === "string"),
    }),
    ...(data.hideImportLink === true && { hideImportLink: true }),
    ...(Array.isArray(data.hiddenNotices) && {
      hiddenNotices: data.hiddenNotices
        .filter((k): k is string => typeof k === "string" && k.length <= 200)
        .slice(-200),
    }),
    ...(typeof data.logLevels === "object" &&
      data.logLevels !== null &&
      !Array.isArray(data.logLevels) && {
        logLevels: Object.fromEntries(
          Object.entries(data.logLevels as Record<string, unknown>)
            .filter((e): e is [string, string] => typeof e[1] === "string")
            .slice(0, 200),
        ),
      }),
    ...(typeof data.installationId === "string" &&
      /^[0-9a-f]{32}$/.test(data.installationId) && { installationId: data.installationId }),
    ...(typeof data.lastPreset === "string" && { lastPreset: data.lastPreset }),
    ...(typeof data.agentDetails === "object" &&
      data.agentDetails !== null && {
        agentDetails: {
          ...(Array.isArray((data.agentDetails as { folded?: unknown }).folded) && {
            folded: ((data.agentDetails as { folded: unknown[] }).folded ?? []).filter(
              (c): c is string => typeof c === "string",
            ),
          }),
          ...((data.agentDetails as { hidden?: unknown }).hidden === true && { hidden: true }),
          ...(Array.isArray((data.agentDetails as { order?: unknown }).order) && {
            order: ((data.agentDetails as { order: unknown[] }).order ?? []).filter(
              (c): c is string => typeof c === "string",
            ),
          }),
        },
      }),
    ...(typeof data.providerImages === "object" &&
      data.providerImages !== null && {
        providerImages: Object.fromEntries(
          Object.entries(data.providerImages as Record<string, unknown>).filter(
            (e): e is [string, string] =>
              typeof e[1] === "string" && e[1].startsWith("data:image/"),
          ),
        ),
      }),
    ...(typeof data.acpAgents === "object" &&
      data.acpAgents !== null && { acpAgents: sanitizeInstalledMap(data.acpAgents) }),
    ...(Array.isArray(data.riskyFolderDismissed) && {
      riskyFolderDismissed: data.riskyFolderDismissed.filter(
        (p): p is string => typeof p === "string",
      ),
    }),
    ...(Array.isArray(data.agentHandoffs) && {
      agentHandoffs: data.agentHandoffs.filter(
        (x): x is AgentHandoff =>
          !!x &&
          typeof x === "object" &&
          typeof (x as AgentHandoff).id === "string" &&
          typeof (x as AgentHandoff).folder === "string" &&
          typeof (x as AgentHandoff).task === "string" &&
          typeof (x as AgentHandoff).at === "number",
      ),
    }),
    ...(Array.isArray(data.agentStops) && {
      agentStops: data.agentStops.filter(
        (x): x is { id: string; at: number } =>
          !!x &&
          typeof x === "object" &&
          typeof (x as { id?: unknown }).id === "string" &&
          typeof (x as { at?: unknown }).at === "number",
      ),
    }),
    ...(Array.isArray(data.agentHelperMessages) && {
      agentHelperMessages: data.agentHelperMessages.filter(
        (x): x is { id: string; msg: string; text: string; at: number } =>
          !!x &&
          typeof x === "object" &&
          typeof (x as { id?: unknown }).id === "string" &&
          typeof (x as { msg?: unknown }).msg === "string" &&
          typeof (x as { text?: unknown }).text === "string" &&
          typeof (x as { at?: unknown }).at === "number",
      ),
    }),
    // D293: these were left out, so every read (and the save after it) dropped them.
    ...(Array.isArray(data.recentCommands) && {
      recentCommands: data.recentCommands.filter((c): c is string => typeof c === "string"),
    }),
    ...(data.teamAgentsSeeded === true && { teamAgentsSeeded: true }),
    ...(Array.isArray(data.teamAgentsWritten) && {
      teamAgentsWritten: data.teamAgentsWritten.filter((c): c is string => typeof c === "string"),
    }),
    ...(typeof data.teamIconsModel === "boolean" && { teamIconsModel: data.teamIconsModel }),
    ...(typeof data.ui === "object" &&
      data.ui !== null && { ui: data.ui as Record<string, unknown> }),
    ...(typeof data.trust === "object" &&
      data.trust !== null && {
        trust: Object.fromEntries(
          Object.entries(data.trust as Record<string, unknown>).filter(
            (e): e is [string, boolean] => typeof e[1] === "boolean",
          ),
        ),
      }),
  };
}

/**
 * Parses a state file ({} for none yet); null when it isn't JSON of this version (unknown
 * versions are ignored; forward migrations go here).
 */
function parseState(text: string | null): Record<string, unknown> | null {
  if (!text) return {};
  try {
    const data: unknown = JSON.parse(text);
    if (
      typeof data === "object" &&
      data !== null &&
      (data as { version?: unknown }).version === STATE_VERSION
    ) {
      return data as Record<string, unknown>;
    }
  } catch {
    // Corrupt state is not fatal: start fresh.
  }
  return null;
}

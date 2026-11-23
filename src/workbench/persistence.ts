// Persists UI state as JSON through Rust (atomic writes):
//   global    <appData>/state.json                          last opened folder, UI preferences
//   workspace <appData>/workspaces/<hash>/state.json         sidebar, dock tree, explorer expansion
// Contributors register a key with save/restore; saves are debounced.

import { type InstalledAgent, sanitizeInstalledMap } from "../core/acp/registry";
import { storeIpc } from "../core/ipc/system";
import { type Disposable, DisposableStore, toDisposable } from "../core/lifecycle/index";

const STATE_VERSION = 1;
const SAVE_DELAY_MS = 400;
/** The waits before a failed read of the workspace state is tried again. */
const LOAD_RETRY_DELAYS_MS = [100, 400];
/** The key a workspace state file keeps an earlier, unrestored file's text under. */
const UNRESTORED_KEY = "unrestored";

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
  /**
   * The models and reasoning levels each external agent reported last time, by agent name: the
   * model menu shows them before the agent has started. (They were in the web view's own
   * storage until the agent could run without one.)
   */
  acpSettings?: Record<string, unknown[]>;
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
  /** The open workspace's state file couldn't be read: nothing is saved over it until it can. */
  private workspaceUnread = false;
  /**
   * The text of a workspace state file that restored nothing (not this version's JSON, or only
   * readable after the folder had opened): saved along under `unrestored`, so the layout and the
   * unsaved files' backups in it aren't replaced by this session's.
   */
  private unrestored: string | undefined;
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
    if (this.workspaceUnread) {
      // The file couldn't be read when the folder opened: look again. Still unreadable: nothing
      // is written over what can't be seen. Readable now: what it holds was never restored
      // here, so it is kept inside the state written from now on.
      let text: string | null;
      try {
        text = await this.backend.load("workspace");
      } catch {
        return;
      }
      // The folder closed, or another was opened, while the file was read.
      if (!this.workspaceOpen || this.restoring || !this.workspaceUnread) return;
      this.workspaceUnread = false;
      this.unrestored = text || undefined;
    }
    const data: Record<string, unknown> = { version: STATE_VERSION };
    if (this.unrestored !== undefined) data[UNRESTORED_KEY] = this.unrestored;
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
    this.workspaceUnread = false;
    this.unrestored = undefined;
  }

  /**
   * True while the open workspace's state isn't being saved because its file couldn't be read
   * (`flush`). Who relies on the saved state for something that would otherwise be lost (hot
   * exit's backups of unsaved files) must not count on it then.
   */
  workspaceSavesHeld(): boolean {
    return this.workspaceUnread;
  }

  /**
   * The workspace state file's text; a failed read is tried again a few times first (another
   * window writing it, an antivirus scan: gone a moment later). Throws when it stays unreadable.
   */
  private async loadWorkspaceText(): Promise<string | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.backend.load("workspace");
      } catch (err) {
        if (attempt >= LOAD_RETRY_DELAYS_MS.length) throw err;
        await new Promise((resolve) => setTimeout(resolve, LOAD_RETRY_DELAYS_MS[attempt]));
      }
    }
  }

  /**
   * What a workspace state file held that wasn't restored (it isn't this version's JSON), from
   * its text; undefined for an empty file or one that was restored. A file that already carries
   * such a copy passes it on as it is (the copy isn't wrapped again on every start).
   */
  private unrestoredOf(text: string | null): string | undefined {
    if (!text) return undefined;
    const data = parseState(text);
    if (!data) return text;
    return typeof data[UNRESTORED_KEY] === "string" ? data[UNRESTORED_KEY] : undefined;
  }

  /** Loads the open workspace's state and hands each key to its contributor. */
  async restoreWorkspace(): Promise<void> {
    this.restoring = true;
    this.workspaceUnread = false;
    this.unrestored = undefined;
    try {
      let text: string | null = null;
      try {
        text = await this.loadWorkspaceText();
      } catch (err) {
        // Not "no state yet": the file may hold the layout and the backups of unsaved files,
        // and a save now would replace them with this start's defaults. Saves wait until it
        // can be read (`flush`).
        this.workspaceUnread = true;
        console.warn("workspace state couldn't be read; it isn't saved until it can be", err);
      }
      // A file that isn't this version's JSON (a newer build's after a downgrade, a damaged
      // one) restores nothing, and is kept inside the state saved from here on.
      this.unrestored = this.unrestoredOf(text);
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
    return this.writeGlobal(patch).then(() => {});
  }

  /**
   * As `saveGlobal`, and says whether the file was written: false when the write failed (it is
   * only warned about; this window has the values until it next reads the file). For a caller that removes another copy
   * of what it saved, which it may only do once the values are in the file.
   */
  saveGlobalChecked(patch: GlobalPatch): Promise<boolean> {
    return this.writeGlobal(patch);
  }

  private writeGlobal(patch: GlobalPatch): Promise<boolean> {
    const run = async () => {
      const fresh = await this.readGlobal();
      if (fresh) this.global = fresh;
      const changes = typeof patch === "function" ? patch(this.global) : patch;
      this.global = { ...this.global, ...changes };
      try {
        await this.backend.save(
          "global",
          JSON.stringify({ version: STATE_VERSION, ...this.global }),
        );
        return true;
      } catch (err) {
        console.warn("saving global state failed", err);
        return false;
      }
    };
    const next = this.globalWrites.then(run, run);
    this.globalWrites = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  dispose(): void {
    this.store.dispose();
  }
}

/**
 * A most-recent-first list with `id` put first, built on the list as stored now: for a
 * `saveGlobal` function patch, so what another window recorded since stays in the list (this
 * window's own copy of it would drop that).
 */
export function recentWith(
  stored: readonly string[] | undefined,
  id: string,
  max: number,
): string[] {
  return [id, ...(stored ?? []).filter((other) => other !== id)].slice(0, max);
}

/**
 * A record as stored now with only this window's changes applied (`before`: its values when it
 * last saved or loaded them, `now`: its values at present): keys it set or changed take its
 * value, keys it removed go, and every other key keeps what is stored, another window's change
 * included. For a `saveGlobal` function patch.
 */
export function withOwnChanges<T>(
  stored: Readonly<Record<string, T>> | undefined,
  before: Readonly<Record<string, T>>,
  now: Readonly<Record<string, T>>,
): Record<string, T> {
  const out: Record<string, T> = { ...(stored ?? {}) };
  for (const key of Object.keys(before)) if (!Object.hasOwn(now, key)) delete out[key];
  for (const [key, value] of Object.entries(now))
    if (!Object.hasOwn(before, key) || before[key] !== value) out[key] = value;
  return out;
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
    ...(typeof data.acpSettings === "object" &&
      data.acpSettings !== null && {
        acpSettings: Object.fromEntries(
          Object.entries(data.acpSettings).filter((entry): entry is [string, unknown[]] =>
            Array.isArray(entry[1]),
          ),
        ),
      }),
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

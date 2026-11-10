// What the main window keeps about its worktree agents (D204): a record per agent (chat id,
// branch, folder, the commit it started from, model, port block, best-of-N group, setup), saved
// with the workspace. The setup step (copy untracked files, run the project's script with the
// worktree's PORT, D207) runs here before the agent's window opens; progress comes from each
// agent's saved chat (another window's: windows are separate processes with no channel between
// them) and whether its window still runs (the process this window started, D207; after this
// window restarted, a running window with the worktree's folder in the window registry, D222);
// each tick stats the chats and reads only those saved since (D222); changes are compared against
// the start commit and "Apply this one" brings them in.
// Commands: agent.worktreeAgents (the overview), agent.bestOfN, agent.compareWorktrees,
// agent.applyWorktree; state `ide://agent/worktrees`. The model is core/agent/worktrees.ts.
import {
  chatsInBatch,
  DIFF_BUSY_MS,
  outputTail,
  planWorktreeRead,
  portSettings,
  progressFromChat,
  pruneAgents,
  setupConfig,
  slimChat,
  type WorktreeAgent,
  type WorktreeProgress,
  type WorktreeReadCache,
  worktreeEnv,
} from "../../core/agent/worktrees";
import { agentStoreIpc, type WorktreeDiff, worktreeAgentIpc } from "../../core/ipc/agent";
import { gitIpc } from "../../core/ipc/git";
import { execIpc } from "../../core/ipc/process";
import { appIpc } from "../../core/ipc/system";
import { type Disposable, type DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { pathKey } from "../../core/paths/index";
import { signal } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import { newId } from "./ids";

export interface AgentProgress {
  state: WorktreeProgress;
  updated?: number;
  title?: string;
  /** Files the chat changed (pending and applied). */
  changed: number;
  /** From git: files changed against the start commit, lines added and removed. */
  files?: number;
  added?: number;
  removed?: number;
}

/** What starting one worktree agent takes (agent.startInWorktree, best of N, helpers). */
export interface WorktreeStart {
  task: string;
  branch: string;
  base?: string | undefined;
  model?: string | undefined;
  group?: string;
  setup: boolean;
  /** Its chat starts in this mode (`custom:<name>`: one of the user's agents, D231). */
  mode?: string;
  /** The agent's name and instructions, for when its window lacks that mode (D231). */
  label?: string;
  instructions?: string;
  /** A helper (D231): the chat that started it. */
  helper?: string;
  /** The tools its chat may use at most (a helper gets no more than the chat that started it, D232). */
  tools?: string[];
  /** Stop was pressed: checked before its window opens (D232), the worktree is then removed. */
  cancelled?: () => boolean;
  /**
   * A headless helper: no handoff and no window; the caller starts its chat in this window
   * (isolatedHelpers.ts), its tools on the worktree.
   */
  headless?: boolean;
  /** Its record goes by this chat's id (a chat moving into the worktree itself, D337). */
  chat?: string;
}

export interface WorktreeStarted {
  branch: string;
  folder: string;
  /** Stopped before its window opened (D232): nothing was spawned. */
  cancelled?: boolean;
  /** Whether its window opened (test runs open none; a headless helper has none). */
  spawned: boolean;
  /** Started headless: its chat is the caller's to start here. */
  headless?: boolean;
  chat: string;
  port: number;
  setup: WorktreeAgent["setup"] | undefined;
}

export class WorktreeRegistry {
  /** Starts one agent in a new worktree and window (set by registerWorktreeAgents). */
  starter: ((opts: WorktreeStart) => Promise<WorktreeStarted | null>) | null = null;
  /**
   * Whether a headless agent's chat is here in this window (its "window" for the progress: a
   * chat that's gone mid-turn was stopped). Set by registerWorktreeAgents.
   */
  chatHere: (chat: string) => boolean = () => false;
  readonly agents = signal<readonly WorktreeAgent[]>([]);
  readonly progress = signal<ReadonlyMap<string, AgentProgress>>(new Map());
  private readonly diffs = new Map<string, { at: number; diff: WorktreeDiff }>();
  /** Per agent: its chat's stamp and slim copy when last read, when its diff was (D222). */
  private readonly reads = new Map<string, WorktreeReadCache>();

  constructor(private readonly services: WorkbenchServices) {}

  /** Pages following the agents (D233): while any does, the saved chats are watched. */
  private followers = 0;
  private watching: Promise<Disposable | null> | null = null;

  /**
   * Refreshes whenever one of the agents' chats is saved (any window, D233), instead of on a
   * timer; `onChange` hears it too. Dispose to stop following. Falls back to nothing when the
   * folder can't be watched (the caller keeps a slow timer for window liveness anyway).
   */
  follow(): Disposable {
    this.followers++;
    this.watching ??= agentStoreIpc
      .watchSessions((batch) => {
        const hit = chatsInBatch(
          batch.paths,
          this.agents.peek().map((a) => a.chat),
        );
        if (hit.length) void this.refresh();
      })
      .catch(() => null);
    return toDisposable(() => {
      if (--this.followers > 0) return;
      const watching = this.watching;
      // Stopped only if nobody followed again meanwhile (that reuses this same watch: the
      // window has one watcher, and stopping it would stop the newer follower's too).
      void watching?.then((d) => {
        if (this.followers > 0 || this.watching !== watching) return;
        this.watching = null;
        d?.dispose();
      });
    });
  }

  add(agent: WorktreeAgent): void {
    this.agents.value = [...this.agents.peek().filter((a) => a.chat !== agent.chat), agent];
    this.services.persistence.scheduleSave();
  }

  update(chat: string, change: Partial<WorktreeAgent>): void {
    this.agents.value = this.agents.peek().map((a) => (a.chat === chat ? { ...a, ...change } : a));
    this.services.persistence.scheduleSave();
  }

  remove(chat: string): void {
    this.agents.value = this.agents.peek().filter((a) => a.chat !== chat);
    this.diffs.delete(chat);
    this.reads.delete(chat);
    this.services.persistence.scheduleSave();
  }

  find(ref: string): WorktreeAgent | undefined {
    return this.agents.peek().find((a) => a.chat === ref || a.branch === ref);
  }

  group(group: string): WorktreeAgent[] {
    return this.agents.peek().filter((a) => a.group === group);
  }

  /** Drops agents whose worktree is gone (deleted elsewhere). */
  async prune(): Promise<void> {
    const list = await gitIpc.worktrees().catch(() => null);
    if (!list) return;
    const known = new Set(list.map((w) => pathKey(w.path)));
    const kept = pruneAgents(this.agents.peek(), known, pathKey);
    if (kept.length !== this.agents.peek().length) {
      this.agents.value = kept;
      this.services.persistence.scheduleSave();
    }
  }

  /** The agent's changes against its start commit (cached for a few seconds). */
  async diff(agent: WorktreeAgent, maxAgeMs = 4000): Promise<WorktreeDiff> {
    const cached = this.diffs.get(agent.chat);
    if (cached && Date.now() - cached.at < maxAgeMs) return cached.diff;
    const diff = await worktreeAgentIpc.diff(agent.folder, agent.base);
    this.diffs.set(agent.chat, { at: Date.now(), diff });
    return diff;
  }

  private refreshing: Promise<void> | null = null;

  /**
   * Reads every agent's chat and changes again (the overview's timer), and asks whether each
   * one's window is still open (D207: one this window started; closed mid-turn → Stopped).
   * Calls while one runs share it.
   */
  refresh(): Promise<void> {
    this.refreshing ??= this.readAll().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async readAll(): Promise<void> {
    await this.prune();
    const next = new Map<string, AgentProgress>();
    const agents = this.agents.peek();
    // Windows started before this one restarted are found by their folder (D222).
    const open = await appIpc
      .windowsAlive(
        agents.map((a) => a.chat),
        agents.map((a) => a.folder),
      )
      .catch(() => agents.map(() => null));
    // A stat per chat; only the ones another window saved since are read (D222).
    const stamps = await agentStoreIpc
      .stamps(agents.map((a) => a.chat))
      .catch(() => agents.map(() => undefined));
    for (const [i, agent] of agents.entries()) {
      const now = Date.now();
      const stamp = stamps[i];
      let cache = this.reads.get(agent.chat);
      // No stamp (the call failed): read as before.
      const plan =
        stamp === undefined
          ? { readChat: true, readDiff: !cache?.diffAt || now - cache.diffAt >= DIFF_BUSY_MS }
          : planWorktreeRead(cache, stamp, now);
      if (plan.readChat || !cache) {
        const text = await agentStoreIpc.load(agent.chat).catch(() => null);
        let saved: unknown = null;
        try {
          saved = text ? JSON.parse(text) : null;
        } catch {}
        cache = {
          stamp: stamp ?? null,
          chat: slimChat(saved),
          ...(cache?.diffAt !== undefined && { diffAt: cache.diffAt }),
          dirty: true,
        };
        this.reads.set(agent.chat, cache);
      }
      // A headless agent runs in this window: its chat being here is its window being open.
      const alive = agent.headless ? this.chatHere(agent.chat) : (open[i] ?? null);
      const p: AgentProgress = progressFromChat(cache.chat, now, undefined, alive);
      // The diff is git's work: after the chat moved, or now and then (planWorktreeRead).
      const diff = plan.readDiff
        ? await this.diff(agent, 0).catch(() => null)
        : (this.diffs.get(agent.chat)?.diff ?? null);
      if (plan.readDiff) {
        cache.diffAt = now;
        cache.dirty = false;
      }
      if (diff) {
        p.files = diff.files.length;
        p.added = diff.files.reduce((n, f) => n + (f.added ?? 0), 0);
        p.removed = diff.files.reduce((n, f) => n + (f.removed ?? 0), 0);
      }
      if (agent.setup?.state === "running") p.state = "starting";
      next.set(agent.chat, p);
    }
    this.progress.value = next;
  }

  /**
   * The setup step in a new worktree: copy the listed untracked files from this folder, then
   * run the project's setup script there (`agent.worktree.setupScript`). Recorded on the agent.
   */
  async setup(agent: WorktreeAgent): Promise<WorktreeAgent["setup"]> {
    const settings = this.services.settings;
    const config = setupConfig(
      settings.peek<unknown>("agent.worktree.setupScript"),
      settings.peek<unknown>("agent.worktree.copyFiles"),
      settings.peek<unknown>("agent.worktree.setupTimeoutSeconds"),
    );
    const copied = config.files.length
      ? await worktreeAgentIpc.copy(agent.folder, config.files).catch(() => [])
      : [];
    if (!config.script) {
      const done = { state: "skipped" as const, copied };
      this.update(agent.chat, { setup: done });
      return done;
    }
    // The script may come from the folder's own settings (.vscode/settings.json): like a task,
    // it runs only in a trusted folder (D103).
    try {
      await this.services.trust.require("The worktree setup script (agent.worktree.setupScript)");
    } catch (err) {
      const done = {
        state: "failed" as const,
        copied,
        output: err instanceof Error ? err.message : String(err),
      };
      this.update(agent.chat, { setup: done });
      return done;
    }
    this.update(agent.chat, { setup: { state: "running", copied } });
    let output = "";
    const id = newId("w");
    try {
      // The script gets the worktree's PORT and WORKTREE_* like its window (D207), so it can
      // write them into a .env or start a database on the worktree's own port.
      const env = worktreeEnv(
        agent.index,
        portSettings(
          settings.peek<unknown>("agent.worktree.basePort"),
          settings.peek<unknown>("agent.worktree.portStep"),
        ),
      );
      const r = await worktreeAgentIpc.run(
        agent.folder,
        config.script,
        id,
        config.timeoutMs,
        (c) => {
          output = (output + c).slice(-20_000);
        },
        env,
      );
      const ok = r.exitCode === 0 && !r.timedOut && !r.cancelled;
      const done = {
        state: ok ? ("done" as const) : ("failed" as const),
        copied,
        exitCode: r.exitCode,
        output: outputTail(output),
      };
      this.update(agent.chat, { setup: done });
      return done;
    } catch (err) {
      const done = {
        state: "failed" as const,
        copied,
        output: err instanceof Error ? err.message : String(err),
      };
      this.update(agent.chat, { setup: done });
      return done;
    } finally {
      void execIpc.cancel(id).catch(() => {});
    }
  }

  /** What `ide://agent/worktrees` shows. */
  describe(): unknown[] {
    const progress = this.progress.peek();
    return this.agents.peek().map((a) => ({
      ...a,
      ...(progress.get(a.chat) && { progress: progress.get(a.chat) }),
      elapsedMs: Date.now() - a.startedAt,
    }));
  }
}

export function registerWorktreeRegistry(
  sub: DisposableStore,
  services: WorkbenchServices,
): WorktreeRegistry {
  const registry = new WorktreeRegistry(services);
  sub.add(
    services.persistence.register("agent.worktreeAgents", {
      save: () => registry.agents.peek(),
      restore: (data) => {
        registry.agents.value = Array.isArray(data)
          ? data.filter(
              (x): x is WorktreeAgent =>
                !!x &&
                typeof x === "object" &&
                typeof (x as WorktreeAgent).chat === "string" &&
                typeof (x as WorktreeAgent).folder === "string" &&
                typeof (x as WorktreeAgent).base === "string",
            )
          : [];
      },
    }),
  );
  sub.add(
    services.state.register("ide://agent/worktrees", {
      description:
        "The agents started in git worktrees from this folder (D204): chat, branch, folder, start commit, model, port (PORT), best-of-N group, headless (a helper whose chat runs in this window, no window of its own), setup (copied files, script result), and their progress (working, waiting, done, error, stopped — its window closed mid-turn; files changed and lines added / removed against the start commit; elapsed).",
      get: async () => {
        await registry.refresh().catch(() => {});
        return { agents: registry.describe() };
      },
    }),
  );
  return registry;
}

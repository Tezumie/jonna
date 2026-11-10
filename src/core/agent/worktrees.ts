// Worktree agents (D193, D204): the records the main window keeps of the agents it started in
// worktrees, each one's port block, the setup step's settings, best-of-N branch names, and what
// the progress overview reads from each one's saved chat. DOM-free and tested; the commands and
// views are extensions/agent/worktreeAgents.ts and worktreePages.ts.

export interface WorktreeAgent {
  /** The chat id the worktree's window starts (its saved transcript is read for progress). */
  chat: string;
  branch: string;
  folder: string;
  /** The commit it started from: what its changes are compared against. */
  base: string;
  task: string;
  model?: string;
  startedAt: number;
  /** 1, 2, 3…: its port block and its place in a best-of-N group. */
  index: number;
  /** Its PORT (base + index × step). */
  port: number;
  /** Best-of-N: the agents given the same prompt share a group id. */
  group?: string;
  /**
   * A headless helper: its chat runs in the main window's process (no window of its own), its
   * tools on the worktree. Its progress comes from that chat, not from a window.
   */
  headless?: boolean;
  setup?: {
    state: "running" | "done" | "failed" | "skipped";
    copied: string[];
    exitCode?: number | null;
    /** The script's last lines. */
    output?: string;
  };
  /** "Apply this one" brought its changes into the main folder. */
  applied?: number;
  /** Files that Apply left with conflicts (D207), for the merge editor. */
  conflicts?: string[];
}

/** The smallest index ≥ 1 no listed agent uses (indexes are reused once a worktree is gone). */
export function nextIndex(agents: readonly Pick<WorktreeAgent, "index">[]): number {
  const used = new Set(agents.map((a) => a.index));
  let i = 1;
  while (used.has(i)) i++;
  return i;
}

export interface PortSettings {
  base: number;
  step: number;
}

export function portSettings(base: unknown, step: unknown): PortSettings {
  const num = (v: unknown, d: number, min: number, max: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.floor(v))) : d;
  return { base: num(base, 3000, 1024, 60000), step: num(step, 10, 1, 1000) };
}

/**
 * The environment a worktree's window gets: PORT (its own, base + index × step) and
 * WORKTREE_INDEX / WORKTREE_PORT_BASE / WORKTREE_PORT_STEP, so a dev server or a script can
 * spread several ports over the block (PORT … PORT + step − 1).
 */
export function worktreeEnv(index: number, ports: PortSettings): Record<string, string> {
  const port = ports.base + index * ports.step;
  return {
    PORT: String(port),
    WORKTREE_INDEX: String(index),
    WORKTREE_PORT_BASE: String(port),
    WORKTREE_PORT_STEP: String(ports.step),
  };
}

export interface SetupConfig {
  /** Run in the new worktree before the agent starts (empty: none). */
  script: string;
  /** Files git doesn't track to copy from the main folder (`*` in the last segment). */
  files: string[];
  timeoutMs: number;
}

export const DEFAULT_COPY = [".env", ".env.local", ".env.development.local"];

export function setupConfig(script: unknown, files: unknown, timeoutSeconds: unknown): SetupConfig {
  return {
    script: typeof script === "string" ? script.trim() : "",
    files: Array.isArray(files)
      ? files.filter((f): f is string => typeof f === "string" && !!f.trim())
      : DEFAULT_COPY,
    timeoutMs:
      typeof timeoutSeconds === "number" && timeoutSeconds > 0
        ? Math.min(3600, timeoutSeconds) * 1000
        : 600_000,
  };
}

/** The last `lines` lines of a script's output (for the overview). */
export function outputTail(text: string, lines = 12): string {
  const all = text.replace(/\r\n?/g, "\n").trimEnd().split("\n");
  return all.slice(-lines).join("\n");
}

/** A short, branch-safe word for a model ("anthropic/claude-sonnet-4-5" → "claude-sonnet-4-5"). */
export function modelSlug(model: string): string {
  const name = model.slice(model.lastIndexOf("/") + 1);
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, "-")
      .replace(/\.+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "model"
  );
}

/** Best-of-N branches: one per model, the same task (`agent/<task>-<model>`), never twice. */
export function bestOfBranches(
  taskBranch: string,
  models: readonly string[],
  taken: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  models.forEach((m, i) => {
    const wanted = `${taskBranch}-${modelSlug(m)}${models.indexOf(m) !== i ? `-${i + 1}` : ""}`;
    let name = wanted;
    for (let n = 2; (taken.has(name) || out.includes(name)) && n < 50; n++) name = `${wanted}-${n}`;
    out.push(name);
  });
  return out;
}

export type WorktreeProgress =
  | "starting"
  | "working"
  | "waiting"
  | "done"
  | "error"
  | "stopped"
  | "gone";

/**
 * How a worktree agent is doing, from its saved chat (another window writes it): working while a
 * turn runs, waiting on the user, done when idle after a turn, error when it stopped on one.
 * `windowOpen` is whether its window still runs (false: closed; null: unknown, e.g. after this
 * window restarted, D207): a closed window's running or waiting chat is "stopped", and so is
 * one never started. Without that answer, a "running" chat not saved for `staleMs` (the window
 * closed mid-turn, most likely) is "stopped" too.
 */
export function progressFromChat(
  saved: unknown,
  now: number,
  staleMs = 10 * 60_000,
  windowOpen: boolean | null = null,
): { state: WorktreeProgress; updated?: number; title?: string; changed: number } {
  if (windowOpen === false && (!saved || typeof saved !== "object"))
    return { state: "stopped", changed: 0 };
  if (!saved || typeof saved !== "object") return { state: "starting", changed: 0 };
  const data = saved as {
    meta?: { status?: unknown; updated?: unknown; title?: unknown; error?: unknown };
    changeset?: unknown;
    applied?: unknown;
  };
  const meta = data.meta ?? {};
  const updated = typeof meta.updated === "number" ? meta.updated : undefined;
  const files = new Set<string>();
  // Pending edits (a list of files) and applied ones ("<turn>#<path>" keys).
  if (Array.isArray(data.changeset))
    for (const f of data.changeset)
      if (f && typeof f === "object" && typeof (f as { path?: unknown }).path === "string")
        files.add((f as { path: string }).path);
  if (data.applied && typeof data.applied === "object")
    for (const key of Object.keys(data.applied)) files.add(key.slice(key.indexOf("#") + 1));
  const status = meta.status;
  const busy = status === "running" || status === "waiting";
  const state: WorktreeProgress =
    meta.error === true
      ? "error"
      : busy && windowOpen === false
        ? "stopped"
        : status === "running"
          ? windowOpen !== true && updated !== undefined && now - updated > staleMs
            ? "stopped"
            : "working"
          : status === "waiting"
            ? "waiting"
            : "done";
  return {
    state,
    ...(updated !== undefined && { updated }),
    ...(typeof meta.title === "string" && { title: meta.title }),
    changed: files.size,
  };
}

/** "45 s", "12 min", "2 h 5 min". */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

/** Totals of a compare row: files, lines added and removed. */
export function diffTotals(files: readonly { added: number | null; removed: number | null }[]): {
  files: number;
  added: number;
  removed: number;
} {
  return {
    files: files.length,
    added: files.reduce((n, f) => n + (f.added ?? 0), 0),
    removed: files.reduce((n, f) => n + (f.removed ?? 0), 0),
  };
}

/** The records still valid: their folders are still worktrees (`known`, normalized paths). */
export function pruneAgents(
  agents: readonly WorktreeAgent[],
  known: ReadonlySet<string>,
  norm: (p: string) => string,
): WorktreeAgent[] {
  return agents.filter((a) => known.has(norm(a.folder)));
}

// ---- What the overview reads each tick (D222) ---------------------------------------------------

/** What the overview remembers of one agent between ticks. */
export interface WorktreeReadCache {
  /** The chat's save stamp when it was last read (null: not saved yet). */
  stamp: string | null;
  /** The slim chat read then (what progressFromChat needs). */
  chat: unknown;
  /** When git's diff was last read (ms). */
  diffAt?: number;
  /** The chat moved since git's diff was last read. */
  dirty: boolean;
}

/** How often git's diff is read at most while the chat changes, and at least while it's quiet. */
export const DIFF_BUSY_MS = 6000;
export const DIFF_IDLE_MS = 30_000;

/**
 * Windows are separate processes: the overview isn't told when another window saves its chat,
 * so each tick stats the chats (a stamp: cheap) and reads only the ones that moved; git's diff
 * follows the chat (at most every DIFF_BUSY_MS) and otherwise runs every DIFF_IDLE_MS, for edits
 * the chat doesn't record (a command the agent ran).
 */
export function planWorktreeRead(
  cache: WorktreeReadCache | undefined,
  stamp: string | null,
  now: number,
): { readChat: boolean; readDiff: boolean } {
  const readChat = !cache || cache.stamp !== stamp;
  const dirty = readChat || !!cache?.dirty;
  const age = cache?.diffAt === undefined ? Number.POSITIVE_INFINITY : now - cache.diffAt;
  return { readChat, readDiff: age >= DIFF_IDLE_MS || (dirty && age >= DIFF_BUSY_MS) };
}

/** The parts of a saved chat progressFromChat reads, so a long transcript isn't kept. */
export function slimChat(saved: unknown): unknown {
  if (!saved || typeof saved !== "object") return null;
  const data = saved as { meta?: unknown; changeset?: unknown; applied?: unknown };
  const isFile = (f: unknown): f is { path: string } =>
    !!f && typeof f === "object" && typeof (f as { path?: unknown }).path === "string";
  return {
    ...(data.meta !== undefined && { meta: data.meta }),
    ...(Array.isArray(data.changeset) && {
      changeset: data.changeset.filter(isFile).map((f) => ({ path: f.path })),
    }),
    ...(!!data.applied &&
      typeof data.applied === "object" && {
        applied: Object.fromEntries(Object.keys(data.applied).map((k) => [k, true])),
      }),
  };
}

/**
 * Which of `chats` a batch of changed paths in the saved-chats folder names (D233): `<id>.json`,
 * any separator. Temp files of a save in progress (`.<id>.json.tmp-…`) don't count; the rename
 * that ends the save names the file itself.
 */
export function chatsInBatch(paths: readonly string[], chats: readonly string[]): string[] {
  const wanted = new Set(chats);
  const hit = new Set<string>();
  for (const path of paths) {
    const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (wanted.has(id)) hit.add(id);
  }
  return [...hit];
}

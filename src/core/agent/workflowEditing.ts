// Workflow agents that edit (D351, Claude Code's agent({ isolation: 'worktree' })): an agent() call
// with `isolation: "worktree"` runs as one of the IDE's worktree helpers (a branch and folder of
// its own), so it may change files without touching the open folder; the user reviews and merges
// each one's changes. The DOM-free part: finding those calls in a script (the run's permission
// card names them before any of it runs), the per-run cap, keeping two of them off the same files
// at once (when the script says which files), the value agent() returns, and what the end message
// says about their branches.

/** `agent.workflows.maxEditingAgents`: editing agents one run may start (1–10, default 3). */
export const DEFAULT_MAX_EDITING = 3;

export function maxEditingAgents(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw)
    ? Math.max(1, Math.min(10, Math.floor(raw)))
    : DEFAULT_MAX_EDITING;
}

/** The worktree an editing agent worked in, and what it changed there. */
export interface WorkflowWorktree {
  /** Its helper's id (ide://agent/helpers): Review / Merge go through it. */
  helper: string;
  branch: string;
  folder: string;
  /** Paths it changed (relative to the worktree), once it ended. */
  files: string[];
  added: number;
  removed: number;
  /** It ended (its changes are final). */
  ended: boolean;
}

const ISOLATION = /isolation\s*:\s*(["'`])worktree\1/g;
const LABEL = /label\s*:\s*(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/;

/**
 * The script's editing agent() calls, found in its text: one entry per `isolation: 'worktree'`,
 * the label written in the same call when there is one (else the line). The permission card lists
 * them; a run whose script has none refuses editing at run time (its options built some other
 * way would edit without the user having been told).
 */
export function editingCalls(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(ISOLATION)) {
    const at = m.index ?? 0;
    // The call this option belongs to: from the last agent( before it to the end of its options.
    const start = body.lastIndexOf("agent(", at);
    const close = body.indexOf("}", at);
    const span = body.slice(start >= 0 ? start : Math.max(0, at - 300), close >= 0 ? close : at);
    const label = LABEL.exec(span)?.[2];
    const line = body.slice(0, at).split("\n").length;
    out.push(label ? label : `the agent on line ${line}`);
  }
  return out;
}

/** A path as compared: forward slashes, no ./ or trailing slash, case folded (Windows, macOS). */
export function claimPath(path: string): string {
  let p = path.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  // A glob claims the folder before its first wildcard.
  const wild = p.search(/[*?[{]/);
  if (wild >= 0) p = p.slice(0, p.lastIndexOf("/", wild) + 1);
  return p.replace(/\/$/, "").toLowerCase();
}

/** Whether two claimed paths touch: the same, one inside the other, or a whole-tree claim. */
export function pathsOverlap(a: string, b: string): boolean {
  const x = claimPath(a);
  const y = claimPath(b);
  if (!x || !y) return true;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/**
 * Editing agents' file claims: an agent that names its `files` waits while another one at work
 * claims any of them. One that names none claims nothing (the IDE can't tell what it will touch);
 * their branches are compared when they end instead (`overlaps`).
 */
export class FileClaims {
  private readonly held = new Map<number, string[]>();
  private readonly waiting: { paths: string[]; wake: () => void; fail: (e: Error) => void }[] = [];
  private next = 1;
  private closed: Error | null = null;

  private free(paths: readonly string[]): boolean {
    for (const mine of this.held.values())
      if (mine.some((h) => paths.some((p) => pathsOverlap(h, p)))) return false;
    return true;
  }

  async acquire(paths: readonly string[]): Promise<() => void> {
    if (this.closed) throw this.closed;
    const list = paths.filter((p) => p.trim());
    if (!list.length) return () => {};
    while (!this.free(list))
      await new Promise<void>((wake, fail) => this.waiting.push({ paths: list, wake, fail }));
    if (this.closed) throw this.closed;
    const id = this.next++;
    this.held.set(id, list);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held.delete(id);
      // Everyone waiting looks again (each re-checks; the ones still blocked wait on).
      for (const w of this.waiting.splice(0)) w.wake();
    };
  }

  /** Refuses every waiter and later acquire (the run stopped). */
  close(reason: Error): void {
    this.closed = reason;
    for (const w of this.waiting.splice(0)) w.fail(reason);
  }

  get holders(): number {
    return this.held.size;
  }
}

/** "2 files changed (+12 −3)". */
export function worktreeChanges(w: Pick<WorkflowWorktree, "files" | "added" | "removed">): string {
  const n = w.files.length;
  if (!n) return "no files changed";
  return `${n} file${n === 1 ? "" : "s"} changed (+${w.added} −${w.removed})`;
}

/** What agent() returns for an editing agent: its answer with its branch and changes. */
export function worktreeResult(value: unknown, w: WorkflowWorktree): Record<string, unknown> {
  return {
    result: value,
    branch: w.branch,
    folder: w.folder,
    changes: worktreeChanges(w),
    files: w.files.slice(0, 200),
  };
}

/** Pairs of editing agents whose branches changed the same files (merging both may conflict). */
export function overlaps(
  agents: readonly { label: string; worktree?: WorkflowWorktree }[],
): { a: string; b: string; files: string[] }[] {
  const out: { a: string; b: string; files: string[] }[] = [];
  const editing = agents.filter((x) => x.worktree?.files.length);
  for (let i = 0; i < editing.length; i++)
    for (let j = i + 1; j < editing.length; j++) {
      const a = editing[i];
      const b = editing[j];
      if (!a?.worktree || !b?.worktree) continue;
      const theirs = new Set(b.worktree.files.map(claimPath));
      const shared = a.worktree.files.filter((f) => theirs.has(claimPath(f)));
      if (shared.length) out.push({ a: a.label, b: b.label, files: shared });
    }
  return out;
}

/** The end message's lines on the editing agents' branches; empty when there were none. */
export function worktreeLines(
  agents: readonly { label: string; worktree?: WorkflowWorktree }[],
): string[] {
  const editing = agents.filter((a) => a.worktree);
  if (!editing.length) return [];
  const lines = [
    `Agents that edited, each in a git worktree of its own (their changes are NOT in this folder; the user reviews and merges them from the workflow's card, or agent.helpers { helper, action: "merge" } when the user asks):\n${editing
      .map((a) => {
        const w = a.worktree as WorkflowWorktree;
        return `- ${a.label}: branch ${w.branch}, ${worktreeChanges(w)}${w.files.length ? ` (${w.files.slice(0, 8).join(", ")}${w.files.length > 8 ? ", …" : ""})` : ""}`;
      })
      .join("\n")}`,
  ];
  const both = overlaps(editing);
  if (both.length)
    lines.push(
      `These branches changed the same files, so merging both may conflict: ${both
        .slice(0, 5)
        .map((o) => `${o.a} and ${o.b} (${o.files.slice(0, 3).join(", ")})`)
        .join("; ")}.`,
    );
  return lines;
}

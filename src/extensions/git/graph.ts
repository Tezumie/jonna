// The commit graph's lanes (D139): for commits listed children-before-parents (git log
// --date-order), which lane each commit sits in and the line segments to draw in its row — lanes
// passing through, branches joining the commit from above, and the edges down to its parents.
// D210: colored like VS Code's scmGraph — a commit carrying the current branch's ref (or its
// upstream's) colors its lane from there down ("ref" blue, "remote" purple), so the current
// branch's unpushed history reads in one color and what's already on the remote in another; a
// lane without such a label keeps the color it came in with, and a new lane takes the next of the
// five rotating colors. VS Code's "Incoming changes" / "Outgoing changes" items are inserted by
// `withSyncChanges`. D220: the base branch (the default branch the current one is compared with)
// colors its lane orange ("base", VS Code's historyItemBaseRefColor), and ref chips take their
// lane's color in All branches mode (`refChipColor`). DOM-free and unit-tested; graphSvg.ts
// draws each row as a small SVG.

export interface GraphCommit {
  hash: string;
  parents: readonly string[];
}

/**
 * A lane's color: the current branch's ref, its upstream's, the base branch's, or one of the
 * rotating ones.
 */
export type LaneColor = "ref" | "remote" | "base" | "0" | "1" | "2" | "3" | "4";

/** The rotating colors (VS Code's scmGraph.foreground1…5): CSS classes scm-lane-0…4. */
export const LANE_COLORS = 5;

/** A segment within one row: from lane `from` at the top (or the dot) to lane `to`. */
export interface GraphEdge {
  from: number;
  to: number;
  color: LaneColor;
  /** "top": row top → dot; "bottom": dot → row bottom; "through": top → bottom. */
  part: "top" | "bottom" | "through";
}

export interface GraphRow {
  /** The commit's lane. */
  lane: number;
  /** The dot's color (the lane's color below the commit, VS Code's circle color). */
  color: LaneColor;
  edges: GraphEdge[];
  /** Lanes the row is wide (for the SVG width). */
  width: number;
  /** A merge commit (two or more parents). */
  merge: boolean;
}

/** The ids of the synthetic rows (never a real hash: those are hex). */
export const INCOMING_ID = "#incoming";
export const OUTGOING_ID = "#outgoing";

export interface GraphOptions {
  /**
   * The color a commit's refs give its lane (VS Code's getLabelColorIdentifier): "ref" for the
   * current branch, "remote" for its upstream; undefined for anything else.
   */
  labelColor?(hash: string): LaneColor | undefined;
}

/** The label color of the synthetic rows: incoming is the remote's, outgoing the branch's. */
function syntheticColor(hash: string): LaneColor | undefined {
  return hash === INCOMING_ID ? "remote" : hash === OUTGOING_ID ? "ref" : undefined;
}

export function layoutGraph(
  commits: readonly GraphCommit[],
  options: GraphOptions = {},
): GraphRow[] {
  const label = (hash: string) => syntheticColor(hash) ?? options.labelColor?.(hash);
  /** What each lane waits for next (a commit hash), or null when free. */
  const lanes: (string | null)[] = [];
  const colors: LaneColor[] = [];
  let rotation = -1;
  const nextColor = (): LaneColor => {
    rotation = (rotation + 1) % LANE_COLORS;
    return String(rotation) as LaneColor;
  };
  const claim = (hash: string, color: LaneColor): number => {
    let i = lanes.indexOf(null);
    if (i === -1) i = lanes.push(null) - 1;
    lanes[i] = hash;
    colors[i] = color;
    return i;
  };
  const rows: GraphRow[] = [];
  for (const c of commits) {
    const own = label(c.hash);
    // A branch tip (nothing above waits for it) starts a lane at its dot.
    let lane = lanes.indexOf(c.hash);
    const tip = lane === -1;
    const before = [...lanes];
    const beforeColors = [...colors];
    // The lane's color below this commit: its label's, else the color it came in with (a tip
    // with no label takes the next rotating color).
    const below: LaneColor = own ?? (tip ? nextColor() : (colors[lane] ?? "0"));
    if (tip) lane = claim(c.hash, below);
    const edges: GraphEdge[] = [];
    // Top half: lanes waiting for this commit join its dot; the others pass through. Both in
    // the colors they came in with.
    for (let i = 0; i < before.length; i++) {
      const want = before[i];
      if (want === null || want === undefined) continue;
      const color = beforeColors[i] ?? "0";
      if (want === c.hash) {
        edges.push({ from: i, to: lane, color, part: "top" });
        if (i !== lane) lanes[i] = null;
      } else edges.push({ from: i, to: i, color, part: "through" });
    }
    const [first, ...others] = c.parents;
    lanes[lane] = first ?? null;
    colors[lane] = below;
    if (first !== undefined) edges.push({ from: lane, to: lane, color: below, part: "bottom" });
    for (const p of others) {
      let j = lanes.indexOf(p);
      // A parent no lane waits for yet: its own label's color, else the next one.
      if (j === -1) j = claim(p, label(p) ?? nextColor());
      edges.push({ from: lane, to: j, color: colors[j] ?? "0", part: "bottom" });
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    colors.length = Math.max(lanes.length, 0);
    const width = edges.reduce((w, e) => Math.max(w, e.from + 1, e.to + 1), lane + 1);
    // A root commit has nothing below: its dot keeps the color it came in with.
    const dot = first !== undefined || tip ? below : (beforeColors[lane] ?? below);
    rows.push({ lane, color: dot, edges, width, merge: c.parents.length > 1 });
  }
  return rows;
}

/** Where the current branch stands against its upstream, for the synthetic rows. */
export interface SyncInfo {
  /** HEAD's commit. */
  head: string | null;
  /** The upstream's commit (null: no upstream). */
  upstream: string | null;
  /** Where HEAD and the upstream forked (git merge-base). */
  mergeBase: string | null;
  /** Commits on the upstream, not on HEAD (HEAD..@{u}). */
  incoming: ReadonlySet<string>;
  ahead: number;
  behind: number;
}

export type GraphItem<C extends GraphCommit> =
  | { kind: "commit"; commit: C }
  | { kind: "incoming" | "outgoing"; count: number };

/**
 * VS Code's "Incoming changes" and "Outgoing changes" items: with commits to push, a row just
 * above HEAD (its first parent HEAD); with commits to pull, a row just above where the branches
 * forked, which the upstream's lane runs through. `graph` is what `layoutGraph` takes, one entry
 * per item (the incoming commits that sat on the fork now sit on the incoming row).
 */
export function withSyncChanges<C extends GraphCommit>(
  commits: readonly C[],
  sync: SyncInfo,
): { items: GraphItem<C>[]; graph: GraphCommit[] } {
  const { head, upstream, mergeBase } = sync;
  const diverged = head !== null && upstream !== null && head !== upstream && mergeBase !== null;
  const outgoingAt =
    diverged && sync.ahead > 0 && head !== mergeBase
      ? commits.findIndex((c) => c.hash === head)
      : -1;
  let incomingAt =
    diverged && sync.behind > 0 && upstream !== mergeBase
      ? commits.findIndex((c) => c.hash === mergeBase)
      : -1;
  // Only when an incoming commit sits on the fork (else it's merged already, or not listed).
  if (
    incomingAt !== -1 &&
    !commits.some((c) => sync.incoming.has(c.hash) && c.parents.includes(mergeBase ?? ""))
  )
    incomingAt = -1;
  const items: GraphItem<C>[] = [];
  const graph: GraphCommit[] = [];
  for (const [i, c] of commits.entries()) {
    if (i === outgoingAt) {
      items.push({ kind: "outgoing", count: sync.ahead });
      graph.push({ hash: OUTGOING_ID, parents: [c.hash] });
    }
    if (i === incomingAt && mergeBase) {
      items.push({ kind: "incoming", count: sync.behind });
      graph.push({ hash: INCOMING_ID, parents: [mergeBase] });
    }
    items.push({ kind: "commit", commit: c });
    graph.push(
      incomingAt !== -1 && sync.incoming.has(c.hash) && c.parents.includes(mergeBase ?? "")
        ? { hash: c.hash, parents: c.parents.map((p) => (p === mergeBase ? INCOMING_ID : p)) }
        : c,
    );
  }
  return { items, graph };
}

export interface BranchRefs {
  head: string | null;
  upstream: string | null;
  detached: boolean;
  /**
   * The base branch ("origin/main", or a local "main"): the one the current branch is compared
   * with. Ignored when it is the current branch or its upstream.
   */
  base?: string | null;
}

/** The base branch when it's a third ref (not the current branch, not its upstream). */
function baseOf(branch: BranchRefs): string | null {
  const base = branch.base?.trim();
  if (!base || base === branch.head || base === branch.upstream) return null;
  return base;
}

/**
 * VS Code's lane label colors from a commit's decorations: the current branch ("ref"), its
 * upstream ("remote"), the base branch ("base"), in that order.
 */
export function refLabelColor(refs: readonly string[], branch: BranchRefs): LaneColor | undefined {
  const base = baseOf(branch);
  let found: LaneColor | undefined;
  for (const raw of refs) {
    const ref = raw.trim();
    if (branch.head && (ref === `HEAD -> ${branch.head}` || ref === branch.head)) return "ref";
    if (branch.detached && ref === "HEAD") return "ref";
    if (branch.upstream && ref === branch.upstream) found = "remote";
    else if (base && ref === base && found === undefined) found = "base";
  }
  return found;
}

/**
 * A ref chip's color (VS Code's labels): the current branch's and its upstream's by their kind
 * (null: the chip's own CSS), the base branch orange, and in All branches mode every other ref in
 * its commit's lane color (in Auto mode, by kind).
 */
export function refChipColor(
  chip: { kind: "head" | "branch" | "remote" | "tag" | "detached"; name: string },
  branch: BranchRefs,
  lane: LaneColor,
  allBranches: boolean,
): LaneColor | null {
  if (chip.kind === "head" || chip.kind === "detached") return null;
  if (chip.kind === "remote" && chip.name === branch.upstream) return null;
  const base = baseOf(branch);
  if (base && chip.kind !== "tag" && chip.name === base) return "base";
  return allBranches ? lane : null;
}

/**
 * How a listed commit's files are read when its row expands (D233): against its first parent with
 * one `git diff --name-status` (no line counts: the hover card's commit detail also diffs every
 * file's content for its shortstat, which made a commit with many files slow to open), or, for a
 * root commit, from the commit's detail.
 */
export function commitFilesQuery(
  commit: GraphCommit,
): { kind: "range"; left: string; right: string } | { kind: "detail" } {
  const parent = commit.parents[0];
  return parent ? { kind: "range", left: parent, right: commit.hash } : { kind: "detail" };
}

/**
 * A small least-recently-used cache of pending answers (a commit's files, its detail): a value
 * asked for again is reused, the oldest goes past `max`, and a failed one is dropped so it's asked
 * for again next time.
 */
export class PromiseCache<T> {
  private readonly entries = new Map<string, Promise<T>>();

  constructor(private readonly max: number) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit) {
      // Most recently used last.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    const p = load();
    this.entries.set(key, p);
    p.catch(() => {
      if (this.entries.get(key) === p) this.entries.delete(key);
    });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return p;
  }

  /** The pending answer for `key`, if one was asked for (not counted as a use). */
  peek(key: string): Promise<T> | undefined {
    return this.entries.get(key);
  }

  get size(): number {
    return this.entries.size;
  }
}

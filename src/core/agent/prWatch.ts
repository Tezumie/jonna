// Watching a pull request for a chat (D323, after Claude Code's app binding a PR to a session):
// the IDE looks at it through the GitHub CLI on a timer — never the model — and tells the chat's
// agent only what it can act on: a check failed, all checks passed, a merge conflict appeared (or
// went), new comments with their text, the pull request merged or closed. The DOM-free part: a
// snapshot from `gh pr view` and the review threads, what changed between two snapshots, the
// message, and the polling delay with back-off.

export const PR_POLL_MS = 60_000;
/** The longest wait after errors (back-off doubles from PR_POLL_MS). */
export const PR_MAX_BACKOFF_MS = 15 * 60_000;
/** Text of one comment sent to the agent. */
const COMMENT_CHARS = 1500;
/** Comments in one message; the rest are counted. */
const MAX_COMMENTS = 10;

export type CheckOutcome = "pass" | "fail" | "pending";

export interface PrComment {
  /** Stable across polls: the review comment's id, or author and time for a conversation one. */
  id: string;
  author: string;
  body: string;
  /** A review comment's file and line. */
  path?: string;
  line?: number;
}

export interface PrSnapshot {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  /** GitHub's mergeable: MERGEABLE, CONFLICTING or UNKNOWN (still being worked out). */
  mergeable: string;
  checks: { name: string; outcome: CheckOutcome }[];
  comments: PrComment[];
  /** D352: APPROVED, REVIEW_REQUIRED, CHANGES_REQUESTED, or "" (no review required). */
  reviewDecision?: string;
  isDraft?: boolean;
  /** D352: GitHub's auto-merge is on for it. */
  autoMerge?: boolean;
  /** D352: GitHub's mergeStateStatus (CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE…), or "". */
  mergeState?: string;
}

export type PrEvent =
  | { kind: "checks-failed"; failed: string[] }
  | { kind: "checks-passed"; count: number }
  | { kind: "conflict" }
  | { kind: "conflict-resolved" }
  | { kind: "comments"; comments: PrComment[] }
  | { kind: "merged" }
  | { kind: "closed" };

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** One check of `statusCheckRollup` (a check run or a commit status). */
export function checkOutcome(check: unknown): CheckOutcome {
  const c = obj(check);
  const status = str(c.status).toUpperCase();
  if (status && status !== "COMPLETED") return "pending";
  const outcome = (str(c.conclusion) || str(c.state)).toUpperCase();
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(outcome)) return "pass";
  if (outcome === "" || outcome === "PENDING" || outcome === "EXPECTED") return "pending";
  return "fail";
}

/**
 * A snapshot from `gh pr view --json …` (`view`) and the review threads query (`threads`, the
 * GraphQL answer; null when it failed: no review comments then).
 */
export function prSnapshot(view: unknown, threads: unknown): PrSnapshot {
  const v = obj(view);
  const state = str(v.state).toUpperCase();
  const checks = arr(v.statusCheckRollup).map((c) => {
    const o = obj(c);
    return {
      name: str(o.name) || str(o.context) || str(o.workflowName) || "check",
      outcome: checkOutcome(c),
    };
  });
  const comments: PrComment[] = [];
  for (const c of arr(v.comments)) {
    const o = obj(c);
    const author = str(obj(o.author).login) || "someone";
    comments.push({
      id: `c:${author}:${str(o.createdAt)}`,
      author,
      body: str(o.body),
    });
  }
  const nodes = arr(
    obj(obj(obj(obj(obj(threads).data).repository).pullRequest).reviewThreads).nodes,
  );
  for (const t of nodes) {
    const thread = obj(t);
    if (thread.isResolved === true) continue;
    for (const c of arr(obj(thread.comments).nodes)) {
      const o = obj(c);
      const id = o.databaseId;
      if (typeof id !== "number" && typeof id !== "string") continue;
      const line = thread.line ?? thread.originalLine;
      comments.push({
        id: `r:${id}`,
        author: str(obj(o.author).login) || "someone",
        body: str(o.body),
        ...(str(thread.path) && { path: str(thread.path) }),
        ...(typeof line === "number" && { line }),
      });
    }
  }
  return {
    number: typeof v.number === "number" ? v.number : 0,
    title: str(v.title),
    url: str(v.url),
    state: state === "MERGED" || state === "CLOSED" ? state : "OPEN",
    mergeable: str(v.mergeable).toUpperCase() || "UNKNOWN",
    checks,
    comments,
    reviewDecision: str(v.reviewDecision).toUpperCase(),
    isDraft: v.isDraft === true,
    autoMerge: !!v.autoMergeRequest && typeof v.autoMergeRequest === "object",
    mergeState: str(v.mergeStateStatus).toUpperCase(),
  };
}

/** Passing, failing, pending counts. */
export function checkCounts(s: PrSnapshot): { pass: number; fail: number; pending: number } {
  const n = { pass: 0, fail: 0, pending: 0 };
  for (const c of s.checks) n[c.outcome]++;
  return n;
}

/**
 * What changed that the agent can act on. The first snapshot (`prev` null) is the baseline:
 * nothing to tell, except that it's already merged or closed.
 */
export function diffPr(prev: PrSnapshot | null, next: PrSnapshot): PrEvent[] {
  if (next.state === "MERGED") return prev?.state === "MERGED" ? [] : [{ kind: "merged" }];
  if (next.state === "CLOSED") return prev?.state === "CLOSED" ? [] : [{ kind: "closed" }];
  if (!prev) return [];
  const events: PrEvent[] = [];
  const before = new Map(prev.checks.map((c) => [c.name, c.outcome]));
  // A check failing that wasn't failing (new, or re-run and failed again).
  const failed = next.checks
    .filter((c) => c.outcome === "fail" && before.get(c.name) !== "fail")
    .map((c) => c.name);
  if (failed.length) events.push({ kind: "checks-failed", failed: [...new Set(failed)] });
  const now = checkCounts(next);
  const was = checkCounts(prev);
  const allPass = now.pass > 0 && !now.fail && !now.pending;
  const wasAllPass =
    was.pass > 0 && !was.fail && !was.pending && prev.checks.length === next.checks.length;
  if (allPass && !wasAllPass) events.push({ kind: "checks-passed", count: now.pass });
  if (next.mergeable === "CONFLICTING" && prev.mergeable !== "CONFLICTING")
    events.push({ kind: "conflict" });
  if (prev.mergeable === "CONFLICTING" && next.mergeable === "MERGEABLE")
    events.push({ kind: "conflict-resolved" });
  const seen = new Set(prev.comments.map((c) => c.id));
  const fresh = next.comments.filter((c) => !seen.has(c.id));
  if (fresh.length) events.push({ kind: "comments", comments: fresh });
  return events;
}

/** The watch ends with these. */
export function endsWatch(events: readonly PrEvent[]): boolean {
  return events.some((e) => e.kind === "merged" || e.kind === "closed");
}

function quote(text: string): string {
  const body = text.trim();
  const cut = body.length > COMMENT_CHARS ? `${body.slice(0, COMMENT_CHARS)}…` : body;
  return cut
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

/** The chat message for what changed. Its first line is what the chat shows. */
export function prEventText(pr: PrSnapshot, events: readonly PrEvent[]): string {
  const name = `Pull request #${pr.number}${pr.title ? ` (${pr.title})` : ""}`;
  const heads: string[] = [];
  const body: string[] = [];
  for (const e of events) {
    switch (e.kind) {
      case "checks-failed":
        heads.push(`${e.failed.length} check${e.failed.length === 1 ? "" : "s"} failed`);
        body.push(
          `Failed checks: ${e.failed.join(", ")}. Look at why (\`gh pr checks ${pr.number}\`, \`gh run view --log-failed\`) and fix it.`,
        );
        break;
      case "checks-passed":
        heads.push("all checks passed");
        body.push(`All ${e.count} checks passed.`);
        break;
      case "conflict":
        heads.push("a merge conflict appeared");
        body.push(
          "It has a merge conflict with its base branch now: merge or rebase the base branch, resolve the conflict and push.",
        );
        break;
      case "conflict-resolved":
        heads.push("the merge conflict is gone");
        body.push("It merges cleanly again.");
        break;
      case "comments": {
        const n = e.comments.length;
        heads.push(`${n} new comment${n === 1 ? "" : "s"}`);
        for (const c of e.comments.slice(0, MAX_COMMENTS))
          body.push(
            `${c.author}${c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ""}` : ""}:\n${quote(c.body)}`,
          );
        if (n > MAX_COMMENTS) body.push(`[${n - MAX_COMMENTS} more not shown]`);
        break;
      }
      case "merged":
        heads.push("merged");
        body.push("It was merged; the watch has ended.");
        break;
      case "closed":
        heads.push("closed");
        body.push("It was closed without merging; the watch has ended.");
        break;
    }
  }
  return [
    `${name}: ${heads.join(", ")}`,
    ...(pr.url ? [pr.url] : []),
    "",
    ...body,
    ...(endsWatch(events)
      ? []
      : [
          "",
          "(The IDE is watching it for you: no need to poll. watch_pr with action unwatch stops it.)",
        ]),
  ].join("\n");
}

/** One line on where it stands (the tool's result, the details panel). */
export function prStatusLine(s: PrSnapshot): string {
  const n = checkCounts(s);
  const checks = s.checks.length
    ? [
        n.fail && `${n.fail} failing`,
        n.pending && `${n.pending} pending`,
        n.pass && `${n.pass} passing`,
      ]
        .filter(Boolean)
        .join(", ")
    : "no checks";
  const merge =
    s.state !== "OPEN"
      ? s.state.toLowerCase()
      : s.mergeable === "CONFLICTING"
        ? "merge conflict"
        : s.mergeable === "MERGEABLE"
          ? "mergeable"
          : "mergeability unknown";
  return `checks: ${checks}; ${merge}; ${s.comments.length} comment${s.comments.length === 1 ? "" : "s"}`;
}

/** The wait before the next look: PR_POLL_MS, doubled per failure in a row up to the cap. */
export function nextPollDelay(failures: number, base = PR_POLL_MS): number {
  if (failures <= 0) return base;
  return Math.min(PR_MAX_BACKOFF_MS, base * 2 ** Math.min(failures, 10));
}

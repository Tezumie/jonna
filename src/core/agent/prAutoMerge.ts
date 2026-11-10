// Auto-merge for a watched pull request (D352, after Claude Code's app's set_auto_merge): opt-in
// per pull request, only when the user asked. Where the repository allows it, GitHub's own
// auto-merge does it (`gh pr merge --auto`); else the IDE merges it itself at a look where every
// check passed, it's approved (when reviews are required) and it's mergeable. The DOM-free part:
// that decision from a snapshot, the method, and the messages.

import { checkCounts, type PrSnapshot } from "./prWatch";

export type MergeMethod = "merge" | "squash" | "rebase";

export const MERGE_METHODS: readonly MergeMethod[] = ["merge", "squash", "rebase"];

export function mergeMethod(raw: unknown): MergeMethod {
  return typeof raw === "string" && (MERGE_METHODS as readonly string[]).includes(raw)
    ? (raw as MergeMethod)
    : "merge";
}

/** Who merges it: GitHub's auto-merge, or the IDE at a look where it's ready. */
export type AutoMergeMode = "github" | "ide";

export interface AutoMergeState {
  method: MergeMethod;
  mode: AutoMergeMode;
  /** When it was turned on. */
  since: number;
}

export type MergeDecision =
  | { ready: true }
  | { ready: false; reason: string }
  /** It can't be merged at all any more (merged or closed already): auto-merge ends. */
  | { ready: false; reason: string; ended: true };

/**
 * Whether the IDE merges it now: open, not a draft, every check passed (none at all counts:
 * nothing to wait for, as GitHub does), approved when reviews are required (no changes
 * requested), mergeable, and not blocked by the branch's rules.
 */
export function mergeDecision(s: PrSnapshot): MergeDecision {
  if (s.state === "MERGED") return { ready: false, reason: "it's merged already", ended: true };
  if (s.state === "CLOSED") return { ready: false, reason: "it was closed", ended: true };
  if (s.isDraft) return { ready: false, reason: "it's a draft" };
  const n = checkCounts(s);
  if (n.fail) return { ready: false, reason: `${n.fail} check${n.fail === 1 ? "" : "s"} failing` };
  if (n.pending)
    return {
      ready: false,
      reason: `${n.pending} check${n.pending === 1 ? "" : "s"} still running`,
    };
  const review = s.reviewDecision ?? "";
  if (review === "CHANGES_REQUESTED") return { ready: false, reason: "changes were requested" };
  if (review === "REVIEW_REQUIRED") return { ready: false, reason: "it needs an approving review" };
  if (s.mergeable === "CONFLICTING") return { ready: false, reason: "it has a merge conflict" };
  if (s.mergeable !== "MERGEABLE")
    return { ready: false, reason: "GitHub is still working out whether it merges cleanly" };
  const state = s.mergeState ?? "";
  if (state === "BLOCKED")
    return { ready: false, reason: "the branch's rules block it (GitHub says BLOCKED)" };
  if (state === "DIRTY") return { ready: false, reason: "it has a merge conflict" };
  return { ready: true };
}

/** "all 2 checks passed, approved, mergeable" — why it was merged. */
export function readyText(s: PrSnapshot): string {
  const n = checkCounts(s);
  return [
    s.checks.length ? `all ${n.pass} check${n.pass === 1 ? "" : "s"} passed` : "no checks",
    s.reviewDecision === "APPROVED" ? "approved" : "",
    "mergeable",
  ]
    .filter(Boolean)
    .join(", ");
}

const name = (s: Pick<PrSnapshot, "number" | "title">) =>
  `Pull request #${s.number}${s.title ? ` (${s.title})` : ""}`;

/** The chat's message when the IDE merged it. */
export function mergedByIdeText(s: PrSnapshot, method: MergeMethod): string {
  return [
    `${name(s)}: merged by auto-merge (${method})`,
    ...(s.url ? [s.url] : []),
    "",
    `The IDE merged it as you asked: ${readyText(s)}. The watch has ended.`,
  ].join("\n");
}

/** The chat's message when its merge failed (auto-merge is off again). */
export function mergeFailedText(s: PrSnapshot, error: string): string {
  return [
    `${name(s)}: auto-merge couldn't merge it`,
    ...(s.url ? [s.url] : []),
    "",
    `It looked ready (${readyText(s)}), but the merge failed: ${error.trim().slice(0, 600)}. Auto-merge is off; the watch goes on.`,
  ].join("\n");
}

/** A line for the watch's status ("auto-merge (squash) by GitHub · waiting: 1 check still running"). */
export function autoMergeLine(a: AutoMergeState, s: PrSnapshot | null): string {
  const who = a.mode === "github" ? "by GitHub" : "by the IDE";
  if (!s) return `auto-merge (${a.method}) ${who}`;
  const d = mergeDecision(s);
  return `auto-merge (${a.method}) ${who}${d.ready ? " · ready" : ` · waiting: ${d.reason}`}`;
}

/** The repository's answer to `gh repo view --json autoMergeAllowed`. */
export function autoMergeAllowed(view: unknown): boolean {
  return (
    !!view &&
    typeof view === "object" &&
    (view as { autoMergeAllowed?: unknown }).autoMergeAllowed === true
  );
}

// An external agent's own approval reviews (D208): Codex's Guardian subagent reviews a command
// before it runs and streams the review as a step of its own ("Guardian Review", text with
// Status / Action / Risk / Authorization / Rationale). The chat shows it as one line folded into
// the step it reviewed ("Guardian: approved · low risk" on the command's row, the rationale in
// its details); until that step appears (or when it never does: denied), as a compact row.

import type { ToolCallFields } from "../../core/acp/client";
import {
  type AgentReview,
  isGuardianStep,
  parseReview,
  reviewLine,
  reviewTarget,
} from "../../core/acp/display";
import type { Item } from "../../core/agent/conversation";
import { newId } from "./ids";

type ToolItem = Extract<Item, { type: "tool" }>;

const textOf = (c: unknown): string =>
  (c as { type?: string; text?: string })?.type === "text"
    ? ((c as { text?: string }).text ?? "")
    : "";

export class AgentReviews {
  /** Review step id → the step it reviews. */
  private readonly targets = new Map<string, string>();
  /** Review step id → its own row (shown until its step appears). */
  private readonly rows = new Map<string, ToolItem>();
  /** Step id → its review, waiting for the step. */
  private readonly waiting = new Map<string, AgentReview>();

  constructor(
    /** The chat's items (a getter: the session replaces its array at times). */
    private readonly items: () => Item[],
    private readonly tools: ReadonlyMap<string, ToolItem>,
  ) {}

  /** Whether this update is a review step (then `take` handles it). */
  isReview(f: ToolCallFields): boolean {
    return (
      isGuardianStep(f.toolCallId, f.title) ||
      this.targets.has(f.toolCallId) ||
      this.rows.has(f.toolCallId)
    );
  }

  take(f: ToolCallFields): void {
    const text = (f.content ?? [])
      .map((c) => (c.type === "content" ? textOf(c.content) : ""))
      .join("\n");
    const fallback =
      f.status === "completed" ? "approved" : f.status === "failed" ? "denied" : "in progress";
    const review = parseReview(text) ?? { by: "Guardian", status: fallback };
    const target =
      reviewTarget(f.rawInput) ?? reviewTarget(f.rawOutput) ?? this.targets.get(f.toolCallId);
    if (target) this.targets.set(f.toolCallId, target);
    const step = target ? this.tools.get(target) : undefined;
    if (step) {
      step.review = review;
      this.dropRow(f.toolCallId);
      return;
    }
    if (target) this.waiting.set(target, review);
    let row = this.rows.get(f.toolCallId);
    if (!row) {
      row = {
        type: "tool",
        id: newId("i"),
        callId: f.toolCallId,
        name: "acp:review",
        args: {},
        status: "running",
      };
      this.rows.set(f.toolCallId, row);
      this.items().push(row);
    }
    row.args = { title: reviewLine(review) };
    row.status =
      review.status === "approved" ? "done" : review.status === "in progress" ? "running" : "error";
    const detail = [
      review.action && `Action: ${review.action}`,
      review.authorization && `Authorization: ${review.authorization}`,
      review.rationale,
    ]
      .filter(Boolean)
      .join("\n");
    if (detail) row.detail = detail;
  }

  /** A new step: the review that waited for it goes onto its row. */
  attach(step: ToolItem): void {
    const review = this.waiting.get(step.callId);
    if (!review) return;
    step.review = review;
    this.waiting.delete(step.callId);
    for (const [id, target] of this.targets) if (target === step.callId) this.dropRow(id);
  }

  /** A turn ended: reviews still waiting stay as their own rows. */
  endTurn(): void {
    this.waiting.clear();
    this.rows.clear();
    this.targets.clear();
  }

  private dropRow(id: string): void {
    const row = this.rows.get(id);
    if (!row) return;
    const items = this.items();
    const at = items.indexOf(row);
    if (at >= 0) items.splice(at, 1);
    this.rows.delete(id);
  }
}

// A run's limits (time, cost, a cancel) held against its chat: what stops the run, and keeps it
// stopped. A limit can fire while the chat is between "the message was taken" and "the turn is
// running", when Stop has nothing to stop: the limit is remembered, and a turn that starts
// afterwards (that one, or one a queued message or a background command's end starts) is
// stopped as it starts. DOM-free.

/** What of a chat the limits read and act on (an `AgentSession` is one). */
export interface LimitedChat {
  stop(reason?: string): void;
  readonly status: { peek(): string };
  /** What the chat's own requests cost; null until one had a known price. */
  readonly cost: { peek(): number | null };
  /** The price of the model answering now; undefined when it isn't known. */
  readonly price?: unknown;
  /** What its subagents' requests cost (they are outside the chat's meter). */
  readonly sideCost: number;
  readonly totals: { peek(): { requests: number } };
  addNotice(text: string): void;
}

/** The limits that end a run early. */
export type LimitReason = "max_cost" | "timeout" | "cancelled";

export interface LimitEvent {
  type: string;
  status?: string;
}

export class RunLimiter {
  /** The limit that stopped the run, once one did. */
  limit: LimitReason | null = null;
  private why = "";
  private readonly startCost: number;
  private readonly startOwnCost: number;
  private readonly startRequests: number;
  private toldUnpriced = false;

  constructor(
    private readonly chat: LimitedChat,
    private readonly maxCost: number | undefined,
    /** Ends what would start another turn by itself (background commands that report back). */
    private readonly endBackground: () => void,
  ) {
    this.startCost = this.total();
    this.startOwnCost = chat.cost.peek() ?? 0;
    this.startRequests = chat.totals.peek().requests;
  }

  private total(): number {
    return (this.chat.cost.peek() ?? 0) + this.chat.sideCost;
  }

  /** What the run has cost so far: the chat's requests and its subagents'. */
  spent(): number {
    return this.total() - this.startCost;
  }

  /** A limit was reached: the run stops now, and stays stopped. The first limit is the reason. */
  stopFor(reason: LimitReason, why: string): void {
    if (this.limit) return;
    this.limit = reason;
    this.why = why;
    this.enforce();
  }

  /** Marks the run as cancelled before anything was sent: nothing to stop yet. */
  cancelledBeforeStart(): void {
    this.limit ??= "cancelled";
    this.why ||= "the run was cancelled";
  }

  private enforce(): void {
    this.chat.stop(this.why);
    this.endBackground();
  }

  /** Every event of the chat: the cost limit is read, and a stopped run's new turn is stopped. */
  onEvent(event: LimitEvent): void {
    if (this.limit) {
      // A turn starting after the limit. After this tick: a turn sets itself up (clears the
      // last Stop) right after it says it runs.
      if (event.type === "turn.start" || (event.type === "status" && event.status !== "idle"))
        queueMicrotask(() => {
          if (this.chat.status.peek() !== "idle") this.enforce();
        });
      return;
    }
    if (this.maxCost === undefined) return;
    if (this.spent() >= this.maxCost) {
      this.stopFor("max_cost", "the cost limit of this run was reached");
      return;
    }
    // Requests were made and none had a price: the limit can't be held. Said once, not hidden.
    if (
      !this.toldUnpriced &&
      event.type === "usage" &&
      this.chat.price === undefined &&
      (this.chat.cost.peek() ?? 0) === this.startOwnCost &&
      this.chat.totals.peek().requests > this.startRequests
    ) {
      this.toldUnpriced = true;
      this.chat.addNotice(
        "This run's cost limit can't be enforced: the model's price isn't known, so its requests count as costing nothing. Use a step or time limit as well.",
      );
    }
  }
}

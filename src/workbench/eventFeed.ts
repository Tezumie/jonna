// What changed in the IDE, as a numbered feed (D191, wishlist 16): `ide://events?since=<n>`
// returns the events after n and the number to ask with next time, so an agent can poll cheaply
// instead of re-reading big state. Files created, changed, saved, renamed and deleted; documents
// opened; tabs opened and closed; commands the user ran. Kept in memory, the last 500.

import { allTabs } from "../core/dock/index";
import { type Disposable, DisposableStore } from "../core/lifecycle/index";
import { effect } from "../core/reactive/index";
import type { WorkbenchServices } from "./services";

export interface FeedEvent {
  seq: number;
  time: number;
  type: string;
  [key: string]: unknown;
}

export const FEED_SIZE = 500;

export class EventFeed implements Disposable {
  private readonly store = new DisposableStore();
  private readonly events: FeedEvent[] = [];
  private seq = 0;

  push(type: string, data: Record<string, unknown>): void {
    this.events.push({ seq: ++this.seq, time: Date.now(), type, ...data });
    if (this.events.length > FEED_SIZE) this.events.splice(0, this.events.length - FEED_SIZE);
  }

  /** Events after `since` (at most `limit`, the oldest first) and the number to pass next. */
  since(
    since: number,
    limit = 100,
  ): { next: number; events: FeedEvent[]; missed?: number; reset?: boolean } {
    // A number from before a reload (the feed starts again at 1): everything there is, and say so.
    if (since > this.seq) return { ...this.since(0, limit), reset: true };
    const after = this.events.filter((e) => e.seq > since);
    const first = this.events[0]?.seq ?? this.seq + 1;
    const missed = since > 0 && since < first - 1 ? first - 1 - since : 0;
    const events = after.slice(0, limit);
    const next = events.length
      ? (events[events.length - 1] as FeedEvent).seq
      : Math.max(since, this.seq);
    return { next, events, ...(missed && { missed }) };
  }

  /** Feeds from the workbench's events and the dock. */
  attach(services: WorkbenchServices): void {
    const { events, dock, workspace } = services;
    // Relative to its folder (with the folder's name first, of several: D251).
    const rel = (p: string) => (workspace.contains(p) ? workspace.relative(p) || "." : p);
    this.store.add(
      events.on("files.didCreate", (e) =>
        this.push("file.created", { path: rel(e.path), kind: e.kind }),
      ),
    );
    this.store.add(
      events.on("files.didDelete", (e) => this.push("file.deleted", { path: rel(e.path) })),
    );
    this.store.add(
      events.on("files.didRename", (e) =>
        this.push("file.renamed", { from: rel(e.from), to: rel(e.to) }),
      ),
    );
    this.store.add(
      events.on("files.didSave", (e) => this.push("file.saved", { path: rel(e.path) })),
    );
    this.store.add(
      events.on("files.didChange", (e) => this.push("file.changed", { path: rel(e.path) })),
    );
    this.store.add(
      events.on("documents.didOpen", (e) =>
        this.push("document.opened", { path: rel(e.path), language: e.languageId }),
      ),
    );
    this.store.add(
      events.on("command.executed", (e) => {
        // What the user did themselves (the agent knows what it did).
        if (e.caller.kind !== "user" || e.id.startsWith("dev.")) return;
        this.push("command", { id: e.id, status: e.status });
      }),
    );
    // Tabs opened and closed: the dock tree's tab ids, compared.
    let tabs = new Map<string, string>();
    let first = true;
    this.store.add(
      effect(() => {
        const now = new Map<string, string>();
        for (const t of allTabs(dock.root.value)) now.set(t.id, describeTab(t));
        if (!first) {
          for (const [id, what] of now)
            if (!tabs.has(id)) this.push("tab.opened", { tab: id, what });
          for (const [id, what] of tabs)
            if (!now.has(id)) this.push("tab.closed", { tab: id, what });
        }
        first = false;
        tabs = now;
        return undefined;
      }),
    );
  }

  dispose(): void {
    this.store.dispose();
  }
}

function describeTab(t: { viewType: string; viewState: unknown }): string {
  const state = t.viewState as { path?: unknown } | null;
  return typeof state?.path === "string" ? `${t.viewType} ${state.path}` : t.viewType;
}

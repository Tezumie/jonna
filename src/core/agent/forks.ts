// Forks of a chat: a copy of the conversation up to a message, which goes on separately (D422).
// DOM-free: what a fork keeps of the saved chat, its title, and the order the Chats list shows
// forks in (each under the chat it came from, forks of forks under those).

const FORK_MARK = " (fork)";

/** The title of a fork of a chat titled `title` (a fork of a fork isn't marked twice). */
export function forkTitle(title: string | undefined): string {
  const base = title?.trim() || "Chat";
  return base.endsWith(FORK_MARK) ? base : `${base}${FORK_MARK}`;
}

/** The saved items up to and including `item`; null when the chat has no such item. */
export function itemsUpTo<T extends { id?: unknown }>(
  items: readonly T[],
  item: string,
): T[] | null {
  const at = items.findIndex((i) => i.id === item);
  return at < 0 ? null : items.slice(0, at + 1);
}

type ForkItem = { id?: unknown; type?: unknown; streaming?: unknown; status?: unknown };

/** `items` without the reply still streaming and the tools still running at its end. */
function withoutUnfinishedTail(items: ForkItem[]): ForkItem[] {
  let end = items.length;
  while (end > 0) {
    const it = items[end - 1];
    const unfinished =
      (it?.type === "assistant" && it.streaming === true) ||
      (it?.type === "tool" && (it.status === "running" || it.status === "pending"));
    if (!unfinished) break;
    end--;
  }
  return end === items.length ? items : items.slice(0, end);
}

/** The ids of the images kept whole in a chat's media folder (D381) that `items` show. */
export function storedImageIds(items: unknown): string[] {
  const out: string[] = [];
  for (const it of Array.isArray(items) ? items : []) {
    const media = (it as { media?: unknown })?.media;
    for (const img of Array.isArray(media) ? media : []) {
      const x = img as { id?: unknown; stored?: unknown };
      if (x?.stored === true && typeof x.id === "string" && !out.includes(x.id)) out.push(x.id);
    }
  }
  return out;
}

/**
 * What a saved chat's fork is saved with. Edits waiting for review and file checkpoints stay
 * with the original; an external agent's own session too (the fork is told the conversation
 * again, as a chat it never saw). Cut at a message, what was said after it is forgotten: the
 * plan, and the rules and skills the agent was told (they're told again when they apply).
 * Null when `item` isn't in the chat.
 */
export function forkedChat(
  saved: Record<string, unknown>,
  options: { from: string; item?: string; now: number },
): Record<string, unknown> | null {
  const {
    changeset: _changeset,
    checkpoints: _checkpoints,
    applied: _applied,
    rejected: _rejected,
    acpResume: _acpResume,
    externalSeen: _externalSeen,
    pullRequest: _pullRequest,
    // What the original spent, and its leave to go past the budget, are the original's.
    cost: _cost,
    budgetAllowed: _budgetAllowed,
    ...rest
  } = saved;
  const before = (saved.meta ?? {}) as Record<string, unknown>;
  const {
    pinned: _pinned,
    archived: _archived,
    pending: _pending,
    worktree: _worktree,
    status: _status,
    error: _error,
    blocked: _blocked,
    // A fork is a chat of its own: not another thread on the message its original hangs from,
    // and not one of a channel's conversations (deleting the channel would delete it).
    parent: _parent,
    room: _room,
    ...meta
  } = before;
  const out: Record<string, unknown> = {
    ...rest,
    meta: {
      ...meta,
      title: forkTitle(typeof before.title === "string" ? before.title : undefined),
      updated: options.now,
      forkOf: options.from,
    },
  };
  const items = Array.isArray(saved.items) ? (saved.items as ForkItem[]) : [];
  let kept: ForkItem[] | null = items;
  if (options.item !== undefined) {
    kept = itemsUpTo(items, options.item);
    if (!kept) return null;
  }
  // Forked while the original works: what is still under way stays with it (the fork would
  // open it as "interrupted when the IDE closed", which it wasn't).
  kept = withoutUnfinishedTail(kept);
  // The whole chat: nothing after it to forget.
  if (kept.length < items.length) {
    out.items = kept;
    delete out.plan;
    delete out.attachedRules;
    delete out.toldSkills;
    // Files read after the cut: the fork hasn't seen them (write_file's check, D221).
    delete out.seen;
    // The list's preview of the last reply and wrap-up: written again on the fork's first save.
    const m = out.meta as Record<string, unknown>;
    delete m.last;
    delete m.lastBy;
    delete m.replies;
    delete m.recap;
  }
  return out;
}

/**
 * `rows` with each fork right under the chat it came from (forks of forks under those), and
 * how deep it sits. The order given is kept among chats of one parent. A fork whose chat isn't
 * among the rows (deleted, archived, in another section, filtered out) stands on its own.
 */
export function forkOrder<T extends { id: string; forkOf?: string }>(
  rows: readonly T[],
): { row: T; depth: number }[] {
  const ids = new Set(rows.map((r) => r.id));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const r of rows) {
    if (r.forkOf && r.forkOf !== r.id && ids.has(r.forkOf))
      children.set(r.forkOf, [...(children.get(r.forkOf) ?? []), r]);
    else roots.push(r);
  }
  const out: { row: T; depth: number }[] = [];
  const seen = new Set<string>();
  const add = (row: T, depth: number) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    out.push({ row, depth });
    for (const c of children.get(row.id) ?? []) add(c, depth + 1);
  };
  for (const r of roots) add(r, 0);
  // Chats that only point at each other (a damaged file): listed, on their own.
  for (const r of rows) add(r, 0);
  return out;
}

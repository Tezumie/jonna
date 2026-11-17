// What the team shares, as last read: the team's members with where each one's key stands, and
// the team's shared projects. One place, so the two extensions that show it agree: the Sync
// extension reads it from the service (sharing needs sync on) and draws it; the team extension
// reports it in ide://team. Nothing here calls the service, and nothing here is a key: a
// fingerprint is what people read out to each other.
import type { ShareInfo, ShareMember } from "../ipc/share";
import { type Signal, signal } from "../reactive/index";

export interface ShareBook {
  /** The team's members (this account among them); empty in no team, or before the first read. */
  members: readonly ShareMember[];
  /** The team's shared projects, this account's own among them. */
  shares: readonly ShareInfo[];
  /** When it was last read from the service, in ms; null: not yet. */
  readAt: number | null;
  /** Why the last read failed, in a sentence (what was read before stays); null when it worked. */
  problem: string | null;
}

export const EMPTY_SHARE_BOOK: ShareBook = {
  members: [],
  shares: [],
  readAt: null,
  problem: null,
};

/** Moves only when something in it changed, so a read that says the same redraws nothing. */
export const shareBook: Signal<ShareBook> = signal<ShareBook>(
  EMPTY_SHARE_BOOK,
  (a, b) => JSON.stringify(a) === JSON.stringify(b),
);

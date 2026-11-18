// What the team shares, as last read: the team's members with where each one's key stands, and
// the team's shared projects. One place, so the two extensions that show it agree: the Sync
// extension reads it from the service (sharing needs sync on) and draws it; the team extension
// reports it in ide://team. Nothing here calls the service, and nothing here is a key: a
// fingerprint is what people read out to each other.
import type { ShareAsk, ShareInfo, ShareMember } from "../ipc/share";
import { type Signal, signal } from "../reactive/index";

export interface ShareBook {
  /** The team's members (this account among them); empty in no team, or before the first read. */
  members: readonly ShareMember[];
  /** The team's shared projects, this account's own among them. */
  shares: readonly ShareInfo[];
  /** The teammates who asked this account to share a project (D455); none: empty. */
  asks: readonly ShareAsk[];
  /** When it was last read from the service, in ms; null: not yet. */
  readAt: number | null;
  /** Why the last read failed, in a sentence (what was read before stays); null when it worked. */
  problem: string | null;
  /**
   * The problem is that the account's own record of its key for sharing, or of its teammates'
   * keys, couldn't be read (`SharePins`): trying again may settle it, and when it stays the
   * person can start over with a new key (`team.startOver`).
   */
  startOver?: boolean;
}

export const EMPTY_SHARE_BOOK: ShareBook = {
  members: [],
  shares: [],
  asks: [],
  readAt: null,
  problem: null,
};

/** Whether a failed read is one starting over with a new key for sharing settles. */
export function settledByStartingOver(code: string): boolean {
  return code === "SharePins";
}

/** What starting over with a new key for sharing means, asked before it is done. */
export const START_OVER_WORDS = {
  title: "Start over with a new key for sharing?",
  message:
    "Use this only when sharing keeps being refused because your account's record of its keys can't be read.\n\nYour account gets a new key for sharing. Your teammates will see your key as changed and each has to accept it (compare fingerprints again). What you shared has to be shared again under the new key. Teammates' keys this computer doesn't remember are taken as first seen: verify them again.\n\nYour projects, snapshots and chats are not touched.",
  confirm: "Start over",
} as const;

/** Moves only when something in it changed, so a read that says the same redraws nothing. */
export const shareBook: Signal<ShareBook> = signal<ShareBook>(
  EMPTY_SHARE_BOOK,
  (a, b) => JSON.stringify(a) === JSON.stringify(b),
);

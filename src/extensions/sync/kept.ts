// Sync went off on this computer by itself, DOM-free: what is said, and what is offered. The
// account saying "sync was reset" or "this computer was removed" is the service's word, and an
// outage or a wrong answer says the same. So the computer's keys are kept aside, out of use,
// until the person removes them, turns sync on again, or their time passes (`SyncKept`).
import type { SyncKept, SyncStatus } from "../../core/ipc/sync";

export interface KeptWords {
  title: string;
  /** Why sync is off here, and what happens to the keys. */
  text: string;
  /** Sync can be turned back on with the keys that were kept. */
  resume: boolean;
}

function daysLeft(until: number, now: number): string {
  const days = Math.max(1, Math.ceil((until - now) / 86_400_000));
  return days === 1 ? "1 more day" : `${days} more days`;
}

const WHY: Record<SyncKept["reason"], string> = {
  reset: "Sync was reset on your account page",
  removed: "This computer was removed from sync",
  account: "Another account signed in on this computer",
  server: "The account's server changed",
};

/** The card shown where sync is turned on, while keys are kept. */
export function keptWords(kept: SyncKept, now: number = Date.now()): KeptWords {
  const why = WHY[kept.reason] ?? WHY.reset;
  const left = daysLeft(kept.until, now);
  return {
    title: "Sync is off on this computer",
    text: kept.resumable
      ? `${why}, so sync stopped here. The account lists this computer again: you can turn sync back on with the keys it kept.`
      : `${why}, so sync stopped here. Your files and chats are untouched. This computer's sync keys are kept for ${left} in case that wasn't meant; turning sync on again from the start, or removing them, deletes them.`,
    resume: kept.resumable,
  };
}

/** What the notification says the moment sync goes off by itself. */
export function wentOffWords(notice: NonNullable<SyncStatus["notice"]>): string {
  if (notice === "removed")
    return "This computer was removed from sync on another one. Sync is off here; your files and chats are untouched, and this computer's sync keys are kept for 30 days in case that wasn't meant.";
  if (notice === "keysLost")
    return "This computer's sync keys are gone from its keychain, so sync is off here. Your files and chats are untouched. To sync again, join from this computer.";
  return "Sync was reset on your account page. It is off here until you turn it on again; your files and chats are untouched, and this computer's sync keys are kept for 30 days in case that wasn't meant.";
}

/** Asked before the kept keys are deleted. */
export const FORGET_KEPT_WORDS = {
  title: "Remove this computer's sync keys?",
  message:
    "They are the keys sync used on this computer before it went off. If no other computer of yours syncs and you don't have the recovery key, nobody can read what the account still holds once they are removed. Your files and chats on this computer are not touched.",
  confirm: "Remove the keys",
} as const;

// Errors as the sync loop reads them (D435). DOM-free.

export const codeOf = (err: unknown): string =>
  err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";

export const messageOf = (err: unknown): string =>
  err instanceof Error
    ? err.message
    : err && typeof err === "object" && "message" in err
      ? String((err as { message: unknown }).message)
      : String(err);

/** The service asked to slow down (429, "too many requests"). */
export function isRateLimited(err: unknown): boolean {
  return /\b429\b|too many requests|rate.?limit/i.test(messageOf(err));
}

/** Codes that say where sync stands changed: the status is read again, quietly. */
export const STANDING_CODES: readonly string[] = [
  "SyncSignedOut",
  "SyncNotApproved",
  "SyncReset",
  "SyncOff",
  // The subscription ended: every write is refused until it is renewed.
  "SyncLapsed",
];

/**
 * The account has no room left (507). Not about the one item either, but it doesn't end the
 * pass where it stands: nothing more is sent, what the account holds is still fetched, and the
 * pass then ends as failed with it (see `LayerContext.noRoom`).
 */
export function isFull(err: unknown): boolean {
  return codeOf(err) === "SyncFull";
}

/**
 * An error that isn't about the one item being synced: no connection, the service asking to
 * slow down, sync gone off. Trying the next item would only fail the same way, so the pass
 * ends and reports it.
 */
export function stopsPass(err: unknown): boolean {
  const code = codeOf(err);
  return code === "SyncOffline" || STANDING_CODES.includes(code) || isRateLimited(err);
}

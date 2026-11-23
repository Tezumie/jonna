// The chats this window is writing right now (a turn runs, or has ended and is still being
// saved), by id. The agent knows; sync must: a chat uploaded mid-turn arrives elsewhere as
// "Interrupted", and one pulled or removed between two of its saves is written back over.
// Extensions don't import each other, so the agent sets the source here and sync reads it.

import { type Disposable, toDisposable } from "../lifecycle/index";

let source: (() => Iterable<string>) | null = null;

/** The agent's answer to "which chats are being written". The last one set is asked. */
export function setBusyChatSource(read: () => Iterable<string>): Disposable {
  source = read;
  return toDisposable(() => {
    if (source === read) source = null;
  });
}

/** The ids, read now. Empty while no agent runs in this window. */
export function busyChatIds(): ReadonlySet<string> {
  if (!source) return new Set();
  try {
    return new Set(source());
  } catch {
    // Sync goes on without the guard rather than stopping on the agent's error.
    return new Set();
  }
}

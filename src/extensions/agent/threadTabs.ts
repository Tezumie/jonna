// One channel tab and one thread tab (D237, as Slack shows one channel and one thread at a time):
// opening a thread or a channel shows it in the open preview tab of its kind, so tabs don't pile up.
// Pinning that tab (double-click its title) keeps it, and "Open in new tab" opens one that stays.
// Both live where chats are, on the right (D238): the channel and its thread as two tabs of that
// group, so they hold up in a narrow window; drag one out to see them side by side.

import { signal } from "../../core/reactive/index";
import type { DockService } from "../../workbench/dock/service";

export const ROOM_VIEW = "agent.room";
export const THREAD_VIEW = "agent";

/** A message to bring into view in its conversation's tab (agent.showMessage). */
export interface MessageReveal {
  session: string;
  item: string;
  /** When it was asked: a view opened much later doesn't act on it. */
  at: number;
}

/**
 * The message the next chat view of `session` scrolls to and flashes ("Show it in the
 * conversation" from a thread): the view clears it once it's shown.
 */
export const messageReveal = signal<MessageReveal | null>(null);

const sessionOf = (state: unknown) => (state as { session?: string } | null)?.session;
const roomOf = (state: unknown) => (state as { room?: string } | null)?.room;

let isEmptyThread: (id: string | undefined) => boolean = () => false;

/** A channel's or direct message's conversation (its session), null for the Inbox. */
let roomConversation: (room: string) => string | null = () => null;

/**
 * Tells the tabs each room's conversation (D291): a channel or a direct message opens as a plain
 * chat in the chat panel, not in a channel tab.
 */
export function setRoomConversation(resolve: (room: string) => string | null): void {
  roomConversation = resolve;
}

/** Tells the tabs which threads are empty (nothing said yet): their tab is reused too. */
export function setEmptyThreadCheck(check: (id: string | undefined) => boolean): void {
  isEmptyThread = check;
}

/** How a channel or thread opens: in its tab (default), a tab of its own, or to the side. */
export interface ShowOptions {
  newTab?: boolean;
  /** In a new group beside the chats (D241: several conversations open at once). */
  side?: boolean;
  focus?: boolean;
}

/** Shows thread `id`: its own tab if open, else in the preview thread tab, else a new one. */
export function showThreadTab(dock: DockService, id: string, options: ShowOptions = {}): string {
  const focus = options.focus ?? true;
  const open = dock.tabs(THREAD_VIEW).find((t) => sessionOf(t.viewState) === id);
  if (options.side) return openBeside(dock, THREAD_VIEW, { session: id }, open?.id, focus);
  if (open) {
    dock.activateTab(open.id, focus);
    return open.id;
  }
  const state = { session: id };
  if (!options.newTab) {
    // The preview thread tab, else a tab of an empty thread (the one a window starts with).
    const preview = dock.recentTab(
      (t) => t.viewType === THREAD_VIEW && (!!t.preview || isEmptyThread(sessionOf(t.viewState))),
    );
    if (preview) {
      const replaced = dock.replaceTab(preview.id, THREAD_VIEW, state, focus, { preview: true });
      if (replaced) return replaced;
    }
  }
  return dock.openView(THREAD_VIEW, state, chatPlace(dock, THREAD_VIEW), focus, {
    preview: !options.newTab,
  });
}

/** Shows channel or direct message `room` (or "inbox") in the channel tab. */
export function showRoomTab(dock: DockService, room: string, options: ShowOptions = {}): string {
  // A plain chat panel (D291): a room's conversation is a chat like any other; only the Inbox
  // keeps the channel tab.
  const conversation = roomConversation(room);
  if (conversation) return showThreadTab(dock, conversation, options);
  const focus = options.focus ?? true;
  const open = dock.tabs(ROOM_VIEW).find((t) => roomOf(t.viewState) === room);
  if (options.side) return openBeside(dock, ROOM_VIEW, { room }, open?.id, focus);
  if (open) {
    dock.activateTab(open.id, focus);
    return open.id;
  }
  const state = { room };
  if (!options.newTab) {
    // The preview channel tab, else the tab of an empty chat (the one a window starts with).
    const preview =
      dock.recentTab((t) => t.viewType === ROOM_VIEW && !!t.preview) ??
      dock.recentTab((t) => t.viewType === THREAD_VIEW && isEmptyThread(sessionOf(t.viewState)));
    if (preview) {
      const replaced = dock.replaceTab(preview.id, ROOM_VIEW, state, focus, { preview: true });
      if (replaced) return replaced;
    }
  }
  return dock.openView(ROOM_VIEW, state, chatPlace(dock, ROOM_VIEW), focus, {
    preview: !options.newTab,
  });
}

/**
 * To the side: a tab that stays, in a new group split to the right of the chats (VS Code's Open to
 * the Side). One already open moves there instead of opening twice.
 */
function openBeside(
  dock: DockService,
  kind: string,
  state: { room: string } | { session: string },
  open: string | undefined,
  focus: boolean,
): string {
  const near = dock.recentTab((t) => t.viewType === ROOM_VIEW || t.viewType === THREAD_VIEW);
  const group = near ? dock.findTab(near.id)?.group : undefined;
  // Opened first, then the old tab closed: closing first could remove the group to split (D244).
  const id = dock.openView(
    kind,
    state,
    group ? { groupId: group.id, split: "right" } : "right",
    focus,
  );
  if (open) void dock.closeTab(open, true);
  return id;
}

/** Where a channel or thread tab opens: beside the chats already open (its own kind first). */
function chatPlace(dock: DockService, kind: string): { groupId: string } | "right" {
  const near =
    dock.recentTab((t) => t.viewType === kind) ??
    dock.recentTab((t) => t.viewType === ROOM_VIEW || t.viewType === THREAD_VIEW);
  const group = near ? dock.findTab(near.id)?.group : undefined;
  return group ? { groupId: group.id } : "right";
}

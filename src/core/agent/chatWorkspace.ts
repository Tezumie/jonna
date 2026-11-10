// Which workspace a chat belongs to (D251). A chat stores where it was started (`meta.workspace`):
// the window's first folder, for a single folder (as always, so every existing chat still
// matches) and for a multi-root workspace alike. The workspace file isn't the key: an untitled
// workspace's file changes when it's saved under a name ("Save workspace as…"), and its chats
// would be lost. A window shows a chat as its own when the stored place is its first folder, or
// its workspace file (chats saved while the file was the key). DOM-free and tested.

/** The window: its first folder and its workspace file (null for a single folder). */
export interface ChatPlace {
  root: string | null;
  file: string | null;
}

/** What a new chat stores as its workspace: the first folder (multi-root too). */
export function chatWorkspaceKey(place: ChatPlace): string | null {
  return place.root;
}

/** Whether a chat stored with `stored` belongs to the window at `place`. */
export function belongsToWorkspace(
  stored: string | null | undefined,
  place: ChatPlace,
  same: (a: string, b: string) => boolean,
): boolean {
  if (!stored) return false;
  return (!!place.root && same(stored, place.root)) || (!!place.file && same(stored, place.file));
}

// Files and the workspace: read/write/list (fs), watching (watch), the file index (quick open),
// search/replace, and files dropped onto the window from the OS.

import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Emitter } from "../events/index";
import { type Disposable, toDisposable } from "../lifecycle/index";
import { Channel, call, isTauri } from "./invoke";

export type EntryKind = "file" | "dir";

export interface DirEntry {
  name: string;
  path: string;
  kind: EntryKind;
  isSymlink: boolean;
  /** Matched by .gitignore/.ignore (shown dimmed). */
  ignored: boolean;
}

export interface FileStat {
  kind: EntryKind;
  size: number;
  mtimeMs: number;
  readonly: boolean;
}

/** Workspace-scoped file system. Paths are absolute OS paths; Rust rejects paths outside the workspace. */
/**
 * Paths this window changed through fsIpc (written, created, deleted, moved…): the explorer
 * lists their folders again at once, without waiting for the OS watcher, which can miss or
 * delay events (an agent's writes, Accept all / Reject all, D226).
 */
export const fsChanges = new Emitter<string[]>();

/** Runs `op`, then reports `paths` (and the result when it's a path) as changed. */
async function changing<R>(paths: string[], op: Promise<R>): Promise<R> {
  const result = await op;
  fsChanges.fire(typeof result === "string" && result ? [...paths, result] : paths);
  return result;
}

/** One folder given to `workspaceFoldersSet`: its canonical path when it's in, else why not. */
export interface FolderStatus {
  path: string;
  canonical: string | null;
  error: string | null;
}

export const fsIpc = {
  /** Lets a file from outside the open folder be opened (the user chose it, D190). */
  allowFile: (path: string): Promise<string> => call<string>("workspace_allow_file", { path }),
  /**
   * Lets a linked git worktree of the open folder's repository in as an extra root while a
   * headless helper works there (its files read, written, listed, searched, run in); refused for
   * anything else. Returns its canonical path. `forgetRoot` takes it out again.
   */
  allowRoot: (path: string): Promise<string> => call<string>("workspace_allow_root", { path }),
  forgetRoot: (path: string): Promise<void> => call<void>("workspace_forget_root", { path }),
  /** Opens `path` as the workspace folder; returns its canonical path. */
  openWorkspace: (path: string): Promise<string> => call<string>("workspace_open", { path }),
  /** A new (or empty) project folder `name` in `parent`, outside any workspace; returns its path. */
  createProjectFolder: (parent: string, name: string): Promise<string> =>
    call<string>("workspace_create_folder", { parent, name }),
  closeWorkspace: (): Promise<void> => call<void>("workspace_close"),
  /**
   * Sets the workspace's other folders (a multi-root workspace: the folder `openWorkspace`
   * opened stays the first). They're in scope like it, indexed and searched. One status per
   * path given, in order: a missing folder comes back with an `error` and is left out.
   */
  workspaceFoldersSet: (paths: string[]): Promise<FolderStatus[]> =>
    call<FolderStatus[]>("workspace_folders_set", { paths }),
  /** Every folder of the workspace, the first (the root) first. */
  workspaceFolders: (): Promise<string[]> => call<string[]>("workspace_folders"),
  /**
   * The `.code-workspace` file this window has open (null: none). While set, the window's state
   * is kept for it and other launches find this window by it. Returns the path kept (canonical).
   */
  workspaceSetFile: (file: string | null): Promise<string | null> =>
    call<string | null>("workspace_set_file", { file }),
  /** Reads a `.code-workspace` file (absolute, local, named `*.code-workspace`). */
  workspaceFileRead: (path: string): Promise<string> =>
    call<string>("workspace_file_read", { path }),
  /**
   * Writes a `.code-workspace` file atomically. Its folder must exist, unless it's in the app's
   * data folder (an untitled workspace's, `workspaceUntitledPath`).
   */
  workspaceFileWrite: (path: string, text: string): Promise<void> =>
    call<void>("workspace_file_write", { path, text }),
  /** A fresh, unused path for an untitled workspace's file, in the app's data folder. */
  workspaceUntitledPath: (): Promise<string> => call<string>("workspace_untitled_path"),
  /** Raw bytes, no JSON encoding. */
  read: async (path: string): Promise<Uint8Array> =>
    new Uint8Array(await call<ArrayBuffer>("fs_read", { path })),
  /** Atomic write of raw bytes. Workspace files get a local-history snapshot tagged `source`. */
  write: (path: string, bytes: Uint8Array, source = "save"): Promise<void> =>
    changing(
      [path],
      call<void>("fs_write", bytes, {
        headers: { "x-path": encodeURIComponent(path), "x-source": source },
      }),
    ),
  stat: (path: string): Promise<FileStat> => call<FileStat>("fs_stat", { path }),
  /**
   * Starts the OS drag of these workspace files out of the window (D200), while the mouse button
   * is down: other apps (a file manager, a mail, a chat) take them.
   */
  startDrag: (paths: string[]): Promise<"dropped" | "cancelled"> =>
    call<"dropped" | "cancelled">("fs_start_drag", { paths }),
  listDir: (path: string): Promise<DirEntry[]> => call<DirEntry[]>("fs_list_dir", { path }),
  createFile: (parent: string, name: string): Promise<string> =>
    changing([], call<string>("fs_create_file", { parent, name })),
  createDir: (parent: string, name: string): Promise<string> =>
    changing([], call<string>("fs_create_dir", { parent, name })),
  rename: (path: string, newName: string): Promise<string> =>
    changing([path], call<string>("fs_rename", { path, newName })),
  /** Permanent, recursive delete. Only call from a `destructive` command. */
  delete: (path: string): Promise<void> => changing([path], call<void>("fs_delete", { path })),
  /**
   * Delete into the app trash: returns the id to undo with. Never deletes for good — when the
   * item can't be moved (a file inside in use) it throws and nothing changed (D141).
   */
  trash: async (path: string): Promise<string> => {
    const id = await call<string | null>("fs_trash", { path });
    if (!id) throw new Error(`Couldn't move ${path} to the trash.`);
    fsChanges.fire([path]);
    return id;
  },
  /** Local history's content hash of a file ("" when it isn't there). */
  hash: (path: string): Promise<string> => call<string>("fs_hash", { path }),
  /** Deleted items in the app trash (restorable for 30 days), newest first. */
  trashList: (): Promise<TrashedItem[]> => call<TrashedItem[]>("fs_trash_list"),
  /** Whether a trashed item can still be put back. */
  trashExists: (id: string): Promise<boolean> => call<boolean>("fs_trash_exists", { id }),
  /** Puts a trashed item back at `path`. */
  untrash: (id: string, path: string): Promise<void> =>
    changing([path], call<void>("fs_untrash", { id, path })),
  /** Moves into another folder; returns the new path. */
  move: (path: string, destDir: string): Promise<string> =>
    changing([path], call<string>("fs_move", { path, destDir })),
  /** Copies (recursively) into a folder; a taken name gets " copy". Returns the new path. */
  copy: (path: string, destDir: string): Promise<string> =>
    changing([], call<string>("fs_copy", { path, destDir })),
};

/** Legacy text encodings in Rust (D204): encoding_rs writes, chardetng guesses. */
export const encodingIpc = {
  /** Text → bytes in a WHATWG encoding; throws "can't hold "x", …" for characters it lacks. */
  encode: async (text: string, encoding: string): Promise<Uint8Array> =>
    new Uint8Array(
      await call<ArrayBuffer>("encoding_encode", new TextEncoder().encode(text), {
        headers: { "x-encoding": encoding },
      }),
    ),
  /** The likely WHATWG encoding of some bytes (lower case), or null for plain ASCII. */
  guess: (bytes: Uint8Array): Promise<string | null> =>
    call<string | null>("encoding_guess", bytes),
};

export interface WatchBatch {
  /** Directories whose listing may have changed. */
  dirs: string[];
  paths: string[];
}

export const watchIpc = {
  /** Starts the watcher; `onBatch` receives debounced batches. Dispose to stop. */
  start: async (onBatch: (batch: WatchBatch) => void): Promise<Disposable> => {
    const channel = new Channel<WatchBatch>(onBatch);
    await call<void>("watch_start", { onBatch: channel });
    return toDisposable(() => {
      channel.onmessage = () => {};
      void call<void>("watch_stop").catch(() => {});
    });
  },
  /** Replaces the watched set (non-recursive): typically the explorer's expanded folders. */
  setDirs: (dirs: string[]): Promise<void> => call<void>("watch_set_dirs", { dirs }),
};

/** Watcher for the folders of open documents (editor reload from disk). */
export const docsWatchIpc = {
  start: async (onBatch: (batch: WatchBatch) => void): Promise<Disposable> => {
    const channel = new Channel<WatchBatch>(onBatch);
    await call<void>("docs_watch_start", { onBatch: channel });
    return toDisposable(() => {
      channel.onmessage = () => {};
    });
  },
  setDirs: (dirs: string[]): Promise<void> => call<void>("docs_watch_set_dirs", { dirs }),
};

// Workspace file index (Rust: src-tauri/src/index). Built when a folder opens, kept fresh by its
// own watcher; queries are fuzzy-matched and ranked in Rust.
export interface IndexQueryItem {
  /** Relative to its workspace folder (the root unless `root` says otherwise), `/` separators. */
  path: string;
  score: number;
  /** Matched character indices into `path`. */
  positions: number[];
  /** The workspace folder (absolute) holding it; only set when that isn't the first folder. */
  root?: string;
}

export interface IndexQueryResult {
  items: IndexQueryItem[];
  total: number;
  indexing: boolean;
  truncated: boolean;
}

/** Files changed on disk (absolute paths, `.git` left out); `overflow`: more than listed. */
export interface IndexChanges {
  paths: string[];
  overflow: boolean;
}

export const indexIpc = {
  /**
   * Every workspace folder's files, merged. `root`: one workspace folder's files only, or another
   * root in scope (a headless helper's worktree), walked for this query.
   */
  query: (query: string, limit = 100, root?: string): Promise<IndexQueryResult> =>
    call<IndexQueryResult>("index_query", { query, limit, root: root ?? null }),
  /**
   * Hears the file index's watcher (D220): each debounced batch of files changed on disk. One
   * listener per window (a new call replaces it). `watching`: whether the open folder is
   * watched (false: keep polling). Dispose to stop hearing.
   */
  watch: async (
    onChange: (changes: IndexChanges) => void,
  ): Promise<{ watching: boolean; listener: Disposable }> => {
    const channel = new Channel<IndexChanges>(onChange);
    const watching = await call<boolean>("index_watch", { onChange: channel });
    return {
      watching,
      listener: toDisposable(() => {
        channel.onmessage = () => {};
      }),
    };
  },
};

// Workspace text search (Rust: src-tauri/src/search). Results stream over a Channel, one event per
// file, then `done`. A new search cancels the running one.
export interface TrashedItem {
  id: string;
  /** Where it was (absolute). */
  path: string;
  /** Ms since the epoch. */
  deleted: number;
  isDir: boolean;
}

export interface SearchOptions {
  query: string;
  isRegex: boolean;
  matchCase: boolean;
  wholeWord: boolean;
  include: string[];
  exclude: string[];
  maxResults?: number;
  /** Honor .gitignore/.ignore (default true). */
  useIgnoreFiles?: boolean;
  followSymlinks?: boolean;
  /** Replace keeps each match's case pattern (UPPER, lower, Capitalized). */
  preserveCase?: boolean;
  /** Replace only on these 1-based lines. */
  lines?: number[];
  /** A regex may span lines and `.` matches a line break (the agent's search, D306). */
  multiLine?: boolean;
}

export interface LineMatch {
  /** 1-based. */
  line: number;
  text: string;
  /** [start, end) within `text` (JS string indices). */
  ranges: [number, number][];
}

export type SearchEvent =
  | { kind: "file"; path: string; rel: string; matches: LineMatch[] }
  | {
      kind: "done";
      files: number;
      matches: number;
      truncated: boolean;
      cancelled: boolean;
      durationMs: number;
    };

export interface ReplaceResult {
  files: number;
  replacements: number;
  skipped: string[];
  /** Per changed file: the history snapshot before, and the content hash after (for undo). */
  changes: {
    path: string;
    before: string | null;
    after: string | null;
    beforeHash: string;
    afterHash: string;
  }[];
}

/** A local-history snapshot of a workspace file. */
export interface HistoryEntry {
  id: string;
  timestamp: number;
  /** "original", "external", "save", "agent", "replace", "restore"… */
  source: string;
  size: number;
  hash: string;
}

/** Local history: snapshots taken whenever the app writes a workspace file. */
export const historyIpc = {
  /** Newest first. */
  list: (path: string): Promise<HistoryEntry[]> => call<HistoryEntry[]>("history_list", { path }),
  read: async (path: string, id: string): Promise<Uint8Array> =>
    new Uint8Array(await call<ArrayBuffer>("history_read", { path, id })),
  /** Writes snapshot `id` back; with `expectHash`, only if the file still has that content. */
  restore: (path: string, id: string, expectHash?: string): Promise<void> =>
    call<void>("history_restore", { path, id, expectHash: expectHash ?? null }),
};

export const searchIpc = {
  /**
   * `detached`: an extension's search, independent of the search view's (neither cancels the
   * other). Searches every workspace folder (the first first), or only `root` and `roots`
   * (workspace folders or other roots in scope, e.g. a headless helper's worktree), in order.
   * A file event's `rel` is relative to that file's own folder; one `done` ends the search.
   */
  start: (
    options: SearchOptions,
    onEvent: (event: SearchEvent) => void,
    detached = false,
    root?: string,
    roots?: string[],
  ): Promise<void> =>
    call<void>("search_start", {
      options,
      onEvent: new Channel<SearchEvent>(onEvent),
      detached,
      root: root ?? null,
      roots: roots ?? null,
    }),
  cancel: (): Promise<void> => call<void>("search_cancel"),
  replace: (options: SearchOptions, replacement: string, paths: string[]): Promise<ReplaceResult> =>
    call<ReplaceResult>("search_replace", { options, replacement, paths }),
};

// Files dragged onto the window from the OS (Tauri drag-drop events) and importing them into a
// workspace folder. Positions arrive in physical pixels; these are CSS pixels.
export type DropEvent =
  | { kind: "over"; x: number; y: number; paths: string[] }
  | { kind: "drop"; x: number; y: number; paths: string[] }
  | { kind: "leave" };

export const dragDropIpc = {
  listen: async (handler: (e: DropEvent) => void): Promise<Disposable> => {
    if (!isTauri()) return toDisposable(() => {});
    let paths: string[] = [];
    const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      const scale = window.devicePixelRatio || 1;
      if (p.type === "enter") paths = p.paths;
      if (p.type === "leave") handler({ kind: "leave" });
      else if (p.type === "over" || p.type === "enter" || p.type === "drop") {
        const x = p.position.x / scale;
        const y = p.position.y / scale;
        handler({
          kind: p.type === "drop" ? "drop" : "over",
          x,
          y,
          paths: p.type === "drop" ? p.paths : paths,
        });
      }
    });
    return toDisposable(unlisten);
  },
  /** The last dropped OS paths, each with whether it's a folder (D281). */
  droppedEntries: (): Promise<{ path: string; dir: boolean }[]> =>
    call<{ path: string; dir: boolean }[]>("fs_dropped_entries"),
  /** Copies the last dropped OS paths into `destDir`; returns the new paths. */
  importDropped: (destDir: string): Promise<string[]> =>
    call<string[]>("fs_import_dropped", { destDir }),
};

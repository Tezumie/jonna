// More of VS Code's API on the worker side (D234): text editor decoration types and the active
// editor's events, file system watchers and findFiles, settings written back, per-folder state
// (workspaceState), and `env` helpers (open a web page, the clipboard, the app's name and the
// user's language). Requests go to the host, which checks permissions as for the rest of the API;
// a watcher is the files.* events filtered by a glob here. DOM-free, unit-tested.
import { globToRegExp } from "../paths/glob";
import type { Disposable, TextRange } from "./rpc";
import type { Request } from "./rpcTerminals";
import {
  type GlobPattern,
  patternBase,
  type RelativePattern,
  relativeCandidates,
} from "./rpcWorkspace";

export { relativeTo } from "./rpcWorkspace";

type On = (type: string, listener: (payload: unknown) => void) => Disposable;

/** How a decoration type looks (VS Code's DecorationRenderOptions, the parts the IDE draws). */
export interface DecorationTypeOptions {
  /**
   * Colors: a theme name ("error", "warning", "info", "success", "accent", "muted", "subtle",
   * "label1"…"label6", their "…Background" forms), VS Code's `{ id: "editorError.foreground" }`,
   * or a literal ("#e5534b", the CSS color functions).
   */
  color?: string | { id: string };
  backgroundColor?: string | { id: string };
  borderColor?: string | { id: string };
  borderStyle?: "solid" | "dashed" | "dotted";
  borderWidth?: string | number;
  borderRadius?: string | number;
  outlineColor?: string | { id: string };
  fontStyle?: "italic" | "normal";
  fontWeight?: "bold" | "normal";
  textDecoration?: "underline" | "line-through" | "none" | "underline dotted" | "underline wavy";
  opacity?: string | number;
  isWholeLine?: boolean;
  before?: DecorationAttachmentOptions;
  after?: DecorationAttachmentOptions;
  overviewRulerColor?: string | { id: string };
  overviewRulerLane?: "left" | "center" | "right" | "full";
  /** A colored bar beside the line numbers. */
  gutterColor?: string | { id: string };
  light?: DecorationTypeOptions;
  dark?: DecorationTypeOptions;
}

export interface DecorationAttachmentOptions {
  contentText: string;
  color?: string | { id: string };
  backgroundColor?: string | { id: string };
  fontStyle?: "italic" | "normal";
  fontWeight?: "bold" | "normal";
  /** "1em", or a number of em (0 to 4). */
  margin?: string | number;
}

/** A range of a decoration type: `hover` Markdown, `before` / `after` text instead of the type's. */
export type DecorationOptions = TextRange & { hover?: string; before?: string; after?: string };

export interface TextEditorDecorationType extends Disposable {
  readonly key: string;
  /** Replaces this type's ranges in `path` (default: the active editor's file); [] clears them. */
  set(path: string | undefined, ranges: DecorationOptions[]): Promise<void>;
  /** Clears this type's ranges in every file. */
  clear(): Promise<void>;
}

export interface ActiveEditorEvent {
  path: string;
  language: string;
}

export interface SelectionEvent {
  path: string;
  selections: { startLine: number; startColumn: number; endLine: number; endColumn: number }[];
}

export interface VisibleRangeEvent {
  path: string;
  startLine: number;
  endLine: number;
}

/** The active notebook editor (D265): its file and selected cells' indexes. */
export interface NotebookEditorEvent {
  path: string;
  selection: number[];
}

export interface EditorExtrasApi {
  createDecorationType(options: DecorationTypeOptions): TextEditorDecorationType;
  /** Another file's editor became active, or none (null). "fs.read". */
  onDidChangeActive(listener: (editor: ActiveEditorEvent | null) => void): Disposable;
  /** The active editor's selections (the cursor) moved. "fs.read". */
  onDidChangeSelection(listener: (event: SelectionEvent) => void): Disposable;
  /** The active editor scrolled (its first and last visible lines). "fs.read". */
  onDidChangeVisibleRange(listener: (event: VisibleRangeEvent) => void): Disposable;
  /** Another notebook became active, or none (null), or its selected cells changed. "fs.read". */
  onDidChangeNotebook(listener: (editor: NotebookEditorEvent | null) => void): Disposable;
}

export interface FileSystemWatcher extends Disposable {
  onDidCreate(listener: (path: string) => void): Disposable;
  onDidChange(listener: (path: string) => void): Disposable;
  onDidDelete(listener: (path: string) => void): Disposable;
}

export interface WorkspaceExtrasApi {
  /**
   * Files of the workspace's folders whose path relative to their folder matches `include`
   * ("**\/*.md"; a RelativePattern: relative to its base), not `exclude`; .gitignored files
   * aren't listed. Absolute paths; "fs.read".
   */
  findFiles(include: GlobPattern, exclude?: string, maxResults?: number): Promise<string[]>;
  /**
   * Created, changed (saved or written) and deleted files of the workspace's folders whose path
   * relative to their folder matches `glob` (a RelativePattern: relative to its base; VS Code's
   * createFileSystemWatcher). "fs.read".
   */
  createFileSystemWatcher(
    glob: GlobPattern,
    options?: { ignoreCreate?: boolean; ignoreChange?: boolean; ignoreDelete?: boolean },
  ): FileSystemWatcher;
}

export interface EnvExtrasApi {
  /** The IDE's name, as it shows it. */
  readonly appName: string;
  /** The user's language ("en-US"). */
  readonly language: string;
  /** The scheme of links to the IDE (`<scheme>://<extension id>/…` reach its URI handler). */
  readonly uriScheme: string;
  /**
   * The theme's kind when the extension started (VS Code's activeColorTheme); the
   * "theme.didChange" event (`ide.events.on`, no permission) reports `{ kind }` as it changes.
   */
  readonly themeKind: "light" | "dark";
  /**
   * An id for this installation of the IDE (VS Code's machineId): random, made once, not derived
   * from the machine. The same in every window and folder.
   */
  readonly machineId: string;
  /** An id for this window's session: new each time the window starts. */
  readonly sessionId: string;
  /** Opens a web page (https, http or mailto) in the system's browser. */
  openExternal(url: string): Promise<boolean>;
  /** "clipboard". */
  clipboard: { readText(): Promise<string>; writeText(text: string): Promise<void> };
}

/** A small JSON store for the open folder (VS Code's workspaceState; a multi-root workspace's own). */
export interface MementoApi {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

let typeSeq = 0;

export function createEditorExtras(request: Request, on: On): EditorExtrasApi {
  const typed =
    <T>(type: string) =>
    (listener: (e: T) => void): Disposable =>
      on(type, (payload) => listener(payload as T));
  return {
    createDecorationType(options) {
      const key = `t${++typeSeq}`;
      // The host checks the options; an error is logged when it refuses them.
      const created = request("editor.createDecorationType", { key, options }).catch(
        (err: unknown) => {
          console.error(err instanceof Error ? err.message : String(err));
          throw err;
        },
      );
      let disposed = false;
      return {
        key,
        set: async (path, ranges) => {
          await created;
          if (disposed) return;
          await request("editor.setDecorationType", {
            key,
            ranges: Array.isArray(ranges) ? ranges : [],
            ...(path !== undefined && { path }),
          });
        },
        clear: async () => {
          await created.catch(() => {});
          await request("editor.clearDecorationType", { key });
        },
        dispose: () => {
          disposed = true;
          void request("editor.disposeDecorationType", { key }).catch(() => {});
        },
      };
    },
    onDidChangeActive: typed<ActiveEditorEvent | null>("editor.didChangeActive"),
    onDidChangeSelection: typed<SelectionEvent>("editor.didChangeSelection"),
    onDidChangeVisibleRange: typed<VisibleRangeEvent>("editor.didChangeVisibleRange"),
    onDidChangeNotebook: typed<NotebookEditorEvent | null>("notebook.didChangeEditor"),
  };
}

export function createWorkspaceExtras(
  request: Request,
  on: On,
  folders: () => readonly { path: string }[],
): WorkspaceExtrasApi {
  return {
    findFiles: (include, exclude, maxResults) => {
      // A RelativePattern goes as { base, pattern } (D251): the host lists that folder's files.
      const base = patternBase(include);
      return request("fs.findFiles", {
        include:
          base !== null
            ? { base, pattern: String((include as RelativePattern).pattern) }
            : String(include ?? ""),
        ...(exclude && { exclude: String(exclude) }),
        ...(typeof maxResults === "number" && { maxResults }),
      });
    },
    createFileSystemWatcher(glob, options = {}) {
      // Every folder's events (D251): a plain glob is tried on the path relative to each folder
      // holding the file, a RelativePattern on the path relative to its base. The folders are
      // the worker's mirror at the time of the event (folders come and go).
      const base = patternBase(glob);
      const re = globToRegExp(
        base !== null ? String((glob as RelativePattern).pattern) : String(glob ?? "**"),
      );
      const listeners = {
        create: new Set<(p: string) => void>(),
        change: new Set<(p: string) => void>(),
        delete: new Set<(p: string) => void>(),
      };
      const fire = (kind: keyof typeof listeners, path: unknown) => {
        if (typeof path !== "string") return;
        if (!relativeCandidates(folders(), base, path).some((rel) => re.test(rel))) return;
        for (const l of listeners[kind]) l(path);
      };
      const subs: Disposable[] = [];
      const field = (p: unknown, name: string) => (p as Record<string, unknown> | null)?.[name];
      if (!options.ignoreCreate)
        subs.push(on("files.didCreate", (p) => fire("create", field(p, "path"))));
      if (!options.ignoreChange) {
        subs.push(on("files.didChange", (p) => fire("change", field(p, "path"))));
        subs.push(on("files.didSave", (p) => fire("change", field(p, "path"))));
      }
      if (!options.ignoreDelete)
        subs.push(on("files.didDelete", (p) => fire("delete", field(p, "path"))));
      // A rename is a delete and a create (as VS Code's watcher reports it).
      subs.push(
        on("files.didRename", (p) => {
          if (!options.ignoreDelete) fire("delete", field(p, "from"));
          if (!options.ignoreCreate) fire("create", field(p, "to"));
        }),
      );
      const add = (set: Set<(p: string) => void>, l: (p: string) => void): Disposable => {
        set.add(l);
        return { dispose: () => set.delete(l) };
      };
      return {
        onDidCreate: (l) => add(listeners.create, l),
        onDidChange: (l) => add(listeners.change, l),
        onDidDelete: (l) => add(listeners.delete, l),
        dispose: () => {
          for (const s of subs) s.dispose();
          for (const set of Object.values(listeners)) set.clear();
        },
      };
    },
  };
}

export function createEnvExtras(
  request: Request,
  info: {
    appName?: string;
    language?: string;
    uriScheme?: string;
    themeKind?: "light" | "dark";
    machineId?: string;
    sessionId?: string;
  },
): EnvExtrasApi {
  return {
    appName: info.appName ?? "",
    language: info.language ?? "en",
    uriScheme: info.uriScheme ?? "",
    themeKind: info.themeKind === "light" ? "light" : "dark",
    machineId: info.machineId ?? "",
    sessionId: info.sessionId ?? "",
    openExternal: (url) => request("env.openExternal", { url: String(url) }),
    clipboard: {
      readText: () => request("env.clipboardRead"),
      writeText: (text) => request("env.clipboardWrite", { text: String(text) }),
    },
  };
}

export function createWorkspaceState(request: Request): MementoApi {
  return {
    get: (key) =>
      request("storage.get", { key, scope: "workspace" }).then((v) => (v ?? undefined) as never),
    set: (key, value) => request("storage.set", { key, value, scope: "workspace" }),
  };
}

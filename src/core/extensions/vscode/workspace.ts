// The `vscode` shim's `workspace` (D256): configuration read synchronously from a cache filled
// before the extension activates (and kept current), the open documents and their events, the
// folders, files (`workspace.fs` on Node's file system for files on disk, so an extension reads
// its own files too), watchers, edits, trust and content / file system providers. DOM-free and
// unit-tested.

import type { WorkerApi } from "../rpc";
import { decodeText, fromTextEdit, pathOf, uriOf } from "./convert";
import type { Documents, ShimTextDocument } from "./document";
import { languageOfPath, ShimTextDocument as TextDocumentClass } from "./document";
import {
  ConfigurationTarget,
  Disposable,
  EventEmitter,
  eventOf,
  FileChangeType,
  FileSystemError,
  FileType,
  NONE_TOKEN,
  type RelativePattern,
  TextDocumentSaveReason,
  type TextEdit,
  Uri,
  type WorkspaceEdit,
} from "./types";
import type { ContentProviders } from "./workbench";

/** Files on disk (Node's fs in the Node host; a fake in tests). */
export interface ShimFileSystem {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  stat(path: string): Promise<{ type: FileType; ctime: number; mtime: number; size: number }>;
  readDirectory(path: string): Promise<[string, FileType][]>;
  createDirectory(path: string): Promise<void>;
  delete(path: string, options: { recursive: boolean }): Promise<void>;
  rename(from: string, to: string, options: { overwrite: boolean }): Promise<void>;
  copy(from: string, to: string, options: { overwrite: boolean }): Promise<void>;
}

/** Settings read before the extension starts besides its own (what extensions commonly ask). */
export const COMMON_SETTINGS = [
  "editor.tabSize",
  "editor.insertSpaces",
  "editor.fontSize",
  "editor.fontFamily",
  "editor.formatOnSave",
  "editor.formatOnType",
  "editor.wordWrap",
  "editor.defaultFormatter",
  "files.exclude",
  "files.encoding",
  "files.eol",
  "files.associations",
  "files.autoSave",
  "workbench.colorTheme",
];

const MAX_LATE_FETCHES = 200;

/** Key parts never written into an object built from setting keys. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** VS Code's WorkspaceConfiguration (its values are also its properties). */
export interface WorkspaceConfiguration {
  get<T>(key: string, defaultValue?: T): T | undefined;
  has(key: string): boolean;
  inspect(key: string): {
    key: string;
    defaultValue?: unknown;
    globalValue?: unknown;
    workspaceValue?: unknown;
  };
  update(key: string, value: unknown, target?: ConfigurationTarget | boolean | null): Promise<void>;
  readonly [key: string]: unknown;
}

/** VS Code's configuration over the IDE's settings, read synchronously from a cache. */
export class ShimConfiguration {
  private readonly cache = new Map<string, unknown>();
  private lateFetches = 0;
  readonly onDidChange = new EventEmitter<{
    affectsConfiguration(section: string, scope?: unknown): boolean;
  }>();

  constructor(private readonly ide: WorkerApi) {
    ide.settings.onChange((keys) => void this.refresh(keys));
  }

  /** Reads `keys` into the cache (one that can't be read stays undefined). */
  async preload(keys: readonly string[]): Promise<void> {
    await Promise.all(
      [...new Set(keys)].map((key) =>
        this.ide.settings.get(key).then(
          (v) => this.cache.set(key, v ?? undefined),
          () => this.cache.set(key, undefined),
        ),
      ),
    );
  }

  private async refresh(keys: readonly string[]): Promise<void> {
    await this.preload(keys);
    this.onDidChange.fire({
      affectsConfiguration: (section) =>
        keys.some(
          (k) => k === section || k.startsWith(`${section}.`) || section.startsWith(`${k}.`),
        ),
    });
  }

  private lookup(full: string): unknown {
    const known = this.cache.has(full);
    if (known && this.cache.get(full) !== undefined) return this.cache.get(full);
    // A key inside an object setting ("eslint.codeActionsOnSave.mode").
    const parts = full.split(".");
    for (let i = parts.length - 1; i > 0; i--) {
      const parent = parts.slice(0, i).join(".");
      if (this.cache.get(parent) === undefined) continue;
      let v = this.cache.get(parent);
      for (const p of parts.slice(i))
        v = v && typeof v === "object" ? (v as Record<string, unknown>)[p] : undefined;
      return v;
    }
    // A section rather than a setting (`getConfiguration().get("errorLens")`): VS Code answers
    // with an object of the settings under it, nested by the dots in their keys.
    const section = this.sectionObject(full);
    if (section) return section;
    // Not read before: read now for next time (VS Code's API is synchronous).
    if (!known && this.lateFetches < MAX_LATE_FETCHES) {
      this.lateFetches++;
      this.cache.set(full, undefined);
      void this.preload([full]);
    }
    return undefined;
  }

  /** The cached settings under `section` as one nested object; undefined when there are none. */
  private sectionObject(section: string): Record<string, unknown> | undefined {
    const prefix = `${section}.`;
    let out: Record<string, unknown> | undefined;
    for (const [key, value] of this.cache) {
      if (value === undefined || !key.startsWith(prefix)) continue;
      const parts = key.slice(prefix.length).split(".");
      if (parts.some((p) => !p || FORBIDDEN_KEYS.has(p))) continue;
      const last = parts.pop();
      if (!last) continue;
      out ??= {};
      let at = out;
      for (const p of parts) {
        const next = at[p];
        if (next && typeof next === "object" && !Array.isArray(next)) {
          at = next as Record<string, unknown>;
        } else {
          const made: Record<string, unknown> = {};
          at[p] = made;
          at = made;
        }
      }
      at[last] = value;
    }
    return out;
  }

  get(section?: string): WorkspaceConfiguration {
    const prefix = section ? `${section}.` : "";
    const config: WorkspaceConfiguration & Record<string, unknown> = {
      get: <T>(key: string, defaultValue?: T): T | undefined => {
        const v = this.lookup(prefix + key);
        return v === undefined ? defaultValue : (v as T);
      },
      has: (key: string) => this.lookup(prefix + key) !== undefined,
      inspect: (key: string) => {
        const v = this.lookup(prefix + key);
        return {
          key: prefix + key,
          defaultValue: v,
          globalValue: undefined,
          workspaceValue: undefined,
        };
      },
      update: async (
        key: string,
        value: unknown,
        target?: ConfigurationTarget | boolean | null,
      ) => {
        const where =
          target === ConfigurationTarget.Workspace ||
          target === ConfigurationTarget.WorkspaceFolder ||
          target === false
            ? "workspace"
            : "user";
        await this.ide.settings.update(prefix + key, value, where);
        this.cache.set(prefix + key, value);
      },
    };
    // VS Code's configuration also has its values as properties ("config.enable").
    for (const [key, value] of this.cache)
      if (
        key.startsWith(prefix) &&
        !key.slice(prefix.length).includes(".") &&
        !(key.slice(prefix.length) in config)
      )
        config[key.slice(prefix.length)] = value;
    return config;
  }
}

type GlobPattern = string | RelativePattern | { baseUri: Uri; pattern: string };

const toIdeGlob = (g: GlobPattern) =>
  typeof g === "string" ? g : { base: pathOf((g as RelativePattern).baseUri), pattern: g.pattern };

/** A FileSystemProvider an extension registers (VS Code's shape, the members the shim uses). */
interface OwnFileSystemProvider {
  stat(
    uri: Uri,
  ):
    | { type: FileType; size?: number; mtime?: number; permissions?: number }
    | Promise<{ type: FileType; size?: number; mtime?: number; permissions?: number }>;
  readDirectory(uri: Uri): [string, FileType][] | Promise<[string, FileType][]>;
  readFile(uri: Uri): Uint8Array | Promise<Uint8Array>;
  writeFile?(
    uri: Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): void | Promise<void>;
  createDirectory?(uri: Uri): void | Promise<void>;
  delete?(uri: Uri, options: { recursive: boolean }): void | Promise<void>;
  rename?(from: Uri, to: Uri, options: { overwrite: boolean }): void | Promise<void>;
  copy?(from: Uri, to: Uri, options: { overwrite: boolean }): void | Promise<void>;
  onDidChangeFile?: (listener: (changes: { type: FileChangeType; uri: Uri }[]) => void) => {
    dispose(): void;
  };
}

export function createWorkspace(
  ide: WorkerApi,
  docs: Documents,
  fs: ShimFileSystem,
  configuration: ShimConfiguration,
  contentProviders: ContentProviders,
  unsupported: (name: string) => void,
) {
  let trusted = true;
  const onDidGrantWorkspaceTrust = new EventEmitter<void>();
  const trustReady = ide.workspace.isTrusted().then(
    (t) => {
      trusted = t;
    },
    () => undefined,
  );
  ide.workspace.onDidChangeTrust((t) => {
    const was = trusted;
    trusted = t;
    if (t && !was) onDidGrantWorkspaceTrust.fire();
  });

  const folderCache = new Map<string, { uri: Uri; name: string; index: number }>();
  const folderOf = (f: { path: string; name: string; index: number }) => {
    const key = `${f.path}\n${f.name}\n${f.index}`;
    let out = folderCache.get(key);
    if (!out) {
      out = { uri: Uri.file(f.path), name: f.name, index: f.index };
      folderCache.set(key, out);
    }
    return out;
  };
  const onDidChangeWorkspaceFolders = new EventEmitter<{ added: unknown[]; removed: unknown[] }>();
  ide.workspace.onDidChangeWorkspaceFolders((e) =>
    onDidChangeWorkspaceFolders.fire({
      added: e.added.map(folderOf),
      removed: e.removed.map(folderOf),
    }),
  );

  const filesEvent = (type: string) => {
    const emitter = new EventEmitter<unknown>();
    ide.events.on(type, (payload) => {
      const p = payload as { path?: string; from?: string; to?: string };
      if (p.from && p.to)
        emitter.fire({ files: [{ oldUri: Uri.file(p.from), newUri: Uri.file(p.to) }] });
      else if (p.path) emitter.fire({ files: [Uri.file(p.path)] });
    });
    return emitter.event;
  };

  const isFile = (uri: Uri) => uri.scheme === "file";
  const notFile = (uri: Uri) =>
    FileSystemError.Unavailable(`${uri.toString(true)} (only files on disk)`);
  /**
   * The extension's own file system providers by scheme (registerFileSystemProvider): VS Code's
   * workspace.fs reaches them too (a `memfs:` file read back failed as "only files on disk").
   */
  const ownProviders = new Map<string, { provider: OwnFileSystemProvider; readonly: boolean }>();
  const run = <T>(
    uri: Uri,
    onDisk: () => Promise<T>,
    onOwn: (p: OwnFileSystemProvider) => T | PromiseLike<T>,
  ): Promise<T> => {
    if (isFile(uri)) return onDisk();
    const own = ownProviders.get(uri.scheme)?.provider;
    return own ? Promise.resolve().then(() => onOwn(own)) : Promise.reject(notFile(uri));
  };
  const missing = (uri: Uri): never => {
    throw FileSystemError.NoPermissions(uri);
  };

  const workspaceFs = {
    readFile: (uri: Uri) =>
      run(
        uri,
        () => fs.readFile(uri.fsPath),
        (p) => p.readFile(uri),
      ),
    writeFile: (uri: Uri, content: Uint8Array) =>
      run(
        uri,
        () => fs.writeFile(uri.fsPath, content),
        (p) =>
          p.writeFile ? p.writeFile(uri, content, { create: true, overwrite: true }) : missing(uri),
      ),
    stat: (uri: Uri) =>
      run(
        uri,
        () => fs.stat(uri.fsPath),
        async (p) => ({ ctime: 0, mtime: 0, size: 0, ...(await p.stat(uri)) }),
      ),
    readDirectory: (uri: Uri) =>
      run(
        uri,
        () => fs.readDirectory(uri.fsPath),
        (p) => p.readDirectory(uri),
      ),
    createDirectory: (uri: Uri) =>
      run(
        uri,
        () => fs.createDirectory(uri.fsPath),
        (p) => (p.createDirectory ? p.createDirectory(uri) : missing(uri)),
      ),
    delete: (uri: Uri, options?: { recursive?: boolean; useTrash?: boolean }) =>
      run(
        uri,
        () => fs.delete(uri.fsPath, { recursive: !!options?.recursive }),
        (p) => (p.delete ? p.delete(uri, { recursive: !!options?.recursive }) : missing(uri)),
      ),
    rename: (from: Uri, to: Uri, options?: { overwrite?: boolean }) =>
      from.scheme !== to.scheme
        ? Promise.reject(notFile(isFile(from) ? to : from))
        : run(
            from,
            () => fs.rename(from.fsPath, to.fsPath, { overwrite: !!options?.overwrite }),
            (p) =>
              p.rename ? p.rename(from, to, { overwrite: !!options?.overwrite }) : missing(from),
          ),
    copy: (from: Uri, to: Uri, options?: { overwrite?: boolean }) =>
      from.scheme !== to.scheme
        ? Promise.reject(notFile(isFile(from) ? to : from))
        : run(
            from,
            () => fs.copy(from.fsPath, to.fsPath, { overwrite: !!options?.overwrite }),
            async (p) => {
              const overwrite = !!options?.overwrite;
              if (p.copy) return p.copy(from, to, { overwrite });
              // VS Code copies a file through the provider's read and write when it has no copy.
              if (!p.writeFile) return missing(to);
              await p.writeFile(to, await p.readFile(from), { create: true, overwrite });
            },
          ),
    isWritableFileSystem: (scheme: string) => {
      if (scheme === "file") return true;
      const own = ownProviders.get(scheme);
      return own ? !own.readonly : undefined;
    },
  };

  /** A VS Code WorkspaceEdit as the IDE's, every operation in order. */
  const toIdeEdit = (edit: WorkspaceEdit) => {
    const out = ide.workspace.createWorkspaceEdit();
    for (const op of edit.operations()) {
      if (op.kind === "edit") out.replace(pathOf(op.uri), fromTextEdit(op.edit), op.edit.newText);
      else if (op.kind === "create")
        out.createFile(pathOf(op.uri), {
          ...(op.options?.overwrite && { overwrite: true }),
          ...(op.options?.ignoreIfExists && { ignoreIfExists: true }),
          ...(op.options?.contents && { contents: decodeText(op.options.contents) }),
        });
      else if (op.kind === "rename")
        out.renameFile(pathOf(op.from), pathOf(op.to), op.options ?? {});
      else out.deleteFile(pathOf(op.uri), op.options ?? {});
    }
    return out;
  };

  let untitled = 0;
  const openTextDocument = async (
    target?: Uri | string | { language?: string; content?: string; encoding?: string },
  ): Promise<ShimTextDocument> => {
    if (target === undefined || (typeof target === "object" && !Uri.isUri(target))) {
      const o = (target ?? {}) as { language?: string; content?: string };
      // In `textDocuments` and announced, as in VS Code; showing it opens the IDE's own untitled
      // editor with its text (D261: it was in neither, and showing it failed).
      const doc = new TextDocumentClass(
        `untitled:Untitled-${++untitled}`,
        o.language ?? "plaintext",
        o.content ?? "",
      );
      docs.openLocal(doc);
      return doc;
    }
    const uri = typeof target === "string" ? Uri.file(target) : target;
    // A Uri of one of its content providers (a `git:` one…): that provider's text.
    const provider = uri.scheme !== "file" ? contentProviders.get(uri.scheme) : undefined;
    if (provider) {
      const text = (await provider.provideTextDocumentContent(uri, NONE_TOKEN)) ?? "";
      return new TextDocumentClass(uri.toString(true), languageOfPath(uri.path), text);
    }
    const path = pathOf(uri);
    const doc = docs.get(path) ?? (await docs.sync(path));
    if (!doc) throw new Error(`Couldn't open ${path}`);
    return doc;
  };

  const SAVE_REASONS = {
    manual: TextDocumentSaveReason.Manual,
    afterDelay: TextDocumentSaveReason.AfterDelay,
    focusOut: TextDocumentSaveReason.FocusOut,
  } as const;

  return {
    trustReady,
    get workspaceFolders() {
      return ide.workspace.workspaceFolders?.map(folderOf);
    },
    get rootPath() {
      return ide.workspace.rootPath;
    },
    get name() {
      return ide.workspace.name;
    },
    get workspaceFile() {
      const f = ide.workspace.workspaceFile;
      return f ? Uri.file(f) : undefined;
    },
    get isTrusted() {
      return trusted;
    },
    onDidGrantWorkspaceTrust: onDidGrantWorkspaceTrust.event,
    getWorkspaceFolder: (uri: Uri) => {
      const f = ide.workspace.getWorkspaceFolder(pathOf(uri));
      return f ? folderOf(f) : undefined;
    },
    asRelativePath: (pathOrUri: string | Uri, includeWorkspaceFolder?: boolean) =>
      ide.workspace.asRelativePath(
        typeof pathOrUri === "string" ? pathOrUri : pathOf(pathOrUri),
        includeWorkspaceFolder,
      ),
    onDidChangeWorkspaceFolders: onDidChangeWorkspaceFolders.event,
    updateWorkspaceFolders: (
      start: number,
      deleteCount: number | undefined | null,
      ...folders: { uri: Uri; name?: string }[]
    ) =>
      ide.workspace.updateWorkspaceFolders(
        start,
        deleteCount,
        ...folders.map((f) => ({ path: pathOf(f.uri), ...(f.name && { name: f.name }) })),
      ),

    getConfiguration: (section?: string, _scope?: unknown) => configuration.get(section),
    onDidChangeConfiguration: configuration.onDidChange.event,

    get textDocuments() {
      return docs.all();
    },
    openTextDocument,
    onDidOpenTextDocument: docs.onDidOpen.event,
    onDidCloseTextDocument: docs.onDidClose.event,
    onDidChangeTextDocument: docs.onDidChange.event,
    onDidSaveTextDocument: docs.onDidSave.event,
    onWillSaveTextDocument: eventOf<unknown>((listener) =>
      ide.workspace.onWillSaveTextDocument((e) => {
        const document = docs.get(e.path);
        if (!document) return;
        listener({
          document,
          reason: SAVE_REASONS[e.reason],
          waitUntil: (thenable: Promise<unknown>) =>
            e.waitUntil(
              Promise.resolve(thenable).then((edits) =>
                Array.isArray(edits) ? (edits as TextEdit[]).map(fromTextEdit) : undefined,
              ),
            ),
        });
      }),
    ),
    onDidCreateFiles: filesEvent("files.didCreate"),
    onDidDeleteFiles: filesEvent("files.didDelete"),
    onDidRenameFiles: filesEvent("files.didRename"),
    onWillCreateFiles: new EventEmitter<unknown>().event,
    onWillDeleteFiles: new EventEmitter<unknown>().event,
    onWillRenameFiles: new EventEmitter<unknown>().event,

    fs: workspaceFs,
    findFiles: async (include: GlobPattern, exclude?: GlobPattern | null, maxResults?: number) => {
      const paths = await ide.workspace.findFiles(
        toIdeGlob(include),
        typeof exclude === "string" ? exclude : undefined,
        maxResults,
      );
      return paths.map((p) => Uri.file(p));
    },
    createFileSystemWatcher: (
      glob: GlobPattern,
      ignoreCreateEvents?: boolean,
      ignoreChangeEvents?: boolean,
      ignoreDeleteEvents?: boolean,
    ) => {
      const watcher = ide.workspace.createFileSystemWatcher(toIdeGlob(glob), {
        ...(ignoreCreateEvents && { ignoreCreate: true }),
        ...(ignoreChangeEvents && { ignoreChange: true }),
        ...(ignoreDeleteEvents && { ignoreDelete: true }),
      });
      const wrap = (on: (l: (path: string) => void) => { dispose(): void }) =>
        eventOf<Uri>((listener) => on((path) => listener(Uri.file(path))));
      return {
        ignoreCreateEvents: !!ignoreCreateEvents,
        ignoreChangeEvents: !!ignoreChangeEvents,
        ignoreDeleteEvents: !!ignoreDeleteEvents,
        onDidCreate: wrap((l) => watcher.onDidCreate(l)),
        onDidChange: wrap((l) => watcher.onDidChange(l)),
        onDidDelete: wrap((l) => watcher.onDidDelete(l)),
        dispose: () => watcher.dispose(),
      };
    },
    applyEdit: async (edit: WorkspaceEdit) => {
      const applied = await ide.workspace.applyEdit(toIdeEdit(edit)).catch(() => false);
      // The open documents it changed show it once this resolves, as in VS Code (D261).
      if (applied)
        await Promise.all(
          edit
            .entries()
            .map(([uri]) => pathOf(uri))
            .filter((path) => docs.get(path))
            .map((path) => docs.sync(path, undefined, { dirty: true }).catch(() => undefined)),
        );
      return applied;
    },
    saveAll: async (_includeUntitled?: boolean) => {
      await ide.commands.execute("editor.saveAll", {});
      return true;
    },
    save: async (uri: Uri) => {
      const doc = docs.get(pathOf(uri));
      return doc && (await doc.save()) ? uri : undefined;
    },

    registerTextDocumentContentProvider: (
      scheme: string,
      provider: {
        provideTextDocumentContent(
          uri: Uri,
          token: unknown,
        ): string | null | undefined | Promise<string | null | undefined>;
        onDidChange?: (listener: (uri: Uri) => void) => { dispose(): void };
      },
    ) => {
      const handle = ide.workspace.registerFileSystemProvider(
        scheme,
        {
          stat: () => ({ type: "file" }),
          readDirectory: () => [],
          readFile: async (path) =>
            (await provider.provideTextDocumentContent(uriOf(path), NONE_TOKEN)) ?? "",
        },
        { isReadonly: true },
      );
      contentProviders.set(scheme, provider);
      const changes = provider.onDidChange?.((uri) =>
        handle.fireDidChange([{ path: uri.toString(true), kind: "changed" }]),
      );
      return new Disposable(() => {
        if (contentProviders.get(scheme) === provider) contentProviders.delete(scheme);
        changes?.dispose();
        handle.dispose();
      });
    },
    registerFileSystemProvider: (
      scheme: string,
      provider: OwnFileSystemProvider,
      options?: { isReadonly?: boolean },
    ) => {
      const kind = (t: FileType) =>
        (t & FileType.Directory) !== 0 ? ("directory" as const) : ("file" as const);
      const handle = ide.workspace.registerFileSystemProvider(
        scheme,
        {
          stat: async (path) => {
            const s = await provider.stat(uriOf(path));
            return {
              type: kind(s.type),
              ...(s.size !== undefined && { size: s.size }),
              ...(s.mtime !== undefined && { mtime: s.mtime }),
              ...(s.permissions === 1 && { readonly: true }),
            };
          },
          readDirectory: async (path) =>
            (await provider.readDirectory(uriOf(path))).map(
              ([name, t]) => [name, kind(t)] as [string, "file" | "directory"],
            ),
          readFile: async (path) => provider.readFile(uriOf(path)),
          ...(provider.writeFile && {
            writeFile: (path, content, o) => provider.writeFile?.(uriOf(path), content, o),
          }),
          ...(provider.createDirectory && {
            createDirectory: (path) => provider.createDirectory?.(uriOf(path)),
          }),
          ...(provider.delete && { delete: (path, o) => provider.delete?.(uriOf(path), o) }),
          ...(provider.rename && {
            rename: (from, to, o) => provider.rename?.(uriOf(from), uriOf(to), o),
          }),
        },
        { ...(options?.isReadonly && { isReadonly: true }) },
      );
      const KIND = {
        [FileChangeType.Created]: "created",
        [FileChangeType.Changed]: "changed",
        [FileChangeType.Deleted]: "deleted",
      } as const;
      const changes = provider.onDidChangeFile?.((list) =>
        handle.fireDidChange(
          list.map((c) => ({ path: c.uri.toString(true), kind: KIND[c.type] ?? "changed" })),
        ),
      );
      const entry = { provider, readonly: !!options?.isReadonly };
      ownProviders.set(scheme, entry);
      return new Disposable(() => {
        if (ownProviders.get(scheme) === entry) ownProviders.delete(scheme);
        changes?.dispose();
        handle.dispose();
      });
    },
    registerTaskProvider: () => {
      unsupported("workspace.registerTaskProvider");
      return new Disposable(() => {});
    },
    registerNotebookSerializer: () => {
      unsupported("workspace.registerNotebookSerializer");
      return new Disposable(() => {});
    },
  };
}

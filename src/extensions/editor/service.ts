// EditorService: the open documents (one per file, shared by every editor tab showing it), dirty
// tracking, loading and saving. Tabs themselves live in the dock (view.ts); this service only
// knows which views show which document. Monaco loads lazily: a document is readable (plain-text
// preview) before the engine exists, and gets its engine model once the engine is ready.
import { Emitter } from "../../core/events/index";
import { encodingIpc, fsIpc } from "../../core/ipc/fs";
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import { basename, isWithin, pathKey, rebase } from "../../core/paths/index";
import { perf } from "../../core/perf";
import { type Signal, signal } from "../../core/reactive/index";
import { confirmSaveChanges } from "../../ui/Dialog";
import { fileSystems, uriScheme } from "../../workbench/extensionRegistries";
import { decodeFile, wantsGuess } from "./diskText";
import { decodeWith, encodeText, encodingInfo } from "./encodings";
import type { EditorEngine, EditorTheme, EngineDocument, EngineHost } from "./engine";
import { loadEditorEngine } from "./engine";
import { languageForPath } from "./languages";
import { applySaveTransforms, DEFAULT_SETTINGS, type EditorSettings, newFileEol } from "./settings";
import { isUntitled, nextUntitled, untitledName } from "./untitled";

/** For tests and tools without a workbench. */
const NO_HOST: EngineHost = {
  openFile: () => {},
  readFile: async () => null,
  openDocuments: async () => {},
  fileExists: async () => false,
  root: () => null,
  run: async () => null,
  readClipboard: async () => "",
  writeClipboard: async () => {},
  showMenu: (_at, _items, onClose) => {
    onClose();
    return { dispose() {} };
  },
};

const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** How long a file of an extension's scheme waits for the extension to serve it (D234). */
const PROVIDER_WAIT_MS = 15_000;

// Decoding lives in a DOM-free module (unit-tested); re-exported for existing importers.
export { decodeFile } from "./diskText";

/** Unreferenced documents (opened by a command whose tab never appeared) are dropped after this. */
const SWEEP_MS = 2000;
/**
 * Closed files keep their engine model (and so their undo stack) for reopening, like VS Code:
 * save, close, reopen, and Ctrl+Z still goes back. At most this many, each under 2 MB.
 */
const KEEP_CLOSED = 20;
const KEEP_CLOSED_CHARS = 2 * 1024 * 1024;

export interface EditorDocument {
  /** Absolute path, or "virtual:<id>" for generated read-only content. Changes on rename. */
  readonly path: Signal<string>;
  readonly kind: "text" | "binary" | "virtual";
  /** Tab title for virtual documents. */
  readonly title?: string;
  /** The text as loaded (shown as a preview until the engine model exists). */
  initialText: string;
  /** The engine model; null until Monaco has loaded (or for binary files). */
  readonly model: Signal<EngineDocument | null>;
  readonly dirty: Signal<boolean>;
  savedVersion: number;
  /** "changed": the file changed on disk while there are unsaved edits (banner); "deleted". */
  readonly diskState: Signal<"ok" | "changed" | "deleted">;
  hadBom: boolean;
  /** How it's written back (encodings.ts): utf8, utf8bom, utf16le, windows-1252… (D199). */
  encoding: string;
  /**
   * The file isn't valid UTF-8 (Latin-1, Windows-1252…). It is shown decoded with U+FFFD
   * replacement characters, so writing it back would destroy the original bytes: it opens
   * read-only and saving is refused.
   */
  notUtf8: boolean;
  /**
   * The text last loaded from or written to disk by the IDE. The file watcher also reports the
   * IDE's own saves; disk text equal to this is our own write, not an external change, even after
   * the user has typed more since (checkDisk).
   */
  diskText: string | undefined;
  /**
   * The last time the text was replaced from disk (a workspace operation wrote the file): the
   * model version right after, and when. Ctrl+Z at exactly that version can offer the whole
   * workspace operation's undo (D141).
   */
  reloadMark?: { model: EngineDocument; versionId: number; at: number };
  refs: number;
  readonly subscriptions: DisposableStore;
}

export interface SaveRequest {
  /** The cursor lines an auto save leaves untrimmed (1-based). */
  keepLines?: ReadonlySet<number>;
  /** Write in this encoding (Save with encoding); the document's own until it's written. */
  encoding?: string;
}

/** The error a save of a non-UTF-8 document throws (it would replace bytes with U+FFFD). */
export function notUtf8Error(doc: EditorDocument): Error {
  return new Error(
    `${documentName(doc)} isn't UTF-8 encoded, so it opened read-only: saving would damage its characters.`,
  );
}

/** Replaces a document's text with what is on disk and marks it saved (one undoable edit). */
export function applyDiskText(doc: EditorDocument, text: string): void {
  const model = doc.model.peek();
  if (!model) {
    doc.initialText = text;
  } else {
    const before = model.versionId;
    model.replaceText(text);
    doc.savedVersion = model.versionId;
    if (model.versionId !== before)
      doc.reloadMark = { model, versionId: model.versionId, at: Date.now() };
  }
  doc.diskText = text;
  doc.dirty.value = false;
  doc.diskState.value = "ok";
}

export function documentName(doc: EditorDocument): string {
  const path = doc.path.peek();
  return doc.title ?? (isUntitled(path) ? untitledName(path) : basename(path));
}

export function documentLanguage(doc: EditorDocument): string {
  return doc.model.peek()?.languageId ?? languageForPath(doc.path.peek());
}

export class EditorService implements Disposable {
  /** Every open document, in opening order. */
  readonly documents: Signal<readonly EditorDocument[]> = signal<readonly EditorDocument[]>([]);
  private readonly byKey = new Map<string, EditorDocument>();
  private readonly loading = new Map<string, Promise<EditorDocument>>();
  /** Models of closed files, oldest first (see KEEP_CLOSED). */
  private readonly closed = new Map<string, EngineDocument>();
  private engine: EditorEngine | undefined;
  private enginePending: Promise<EditorEngine> | undefined;
  private readonly saved = new Emitter<string>();
  readonly onDidSave = this.saved.event;
  private readonly store = new DisposableStore();

  constructor(
    private readonly theme: () => EditorTheme,
    /**
     * The editor settings, for a language when given (its `[lang]` blocks, D201), for the file at
     * `path` when given (its folder's own settings in a multi-root workspace, D251).
     */
    private readonly settings: (
      languageId?: string | null,
      path?: string | null,
    ) => EditorSettings = () => DEFAULT_SETTINGS,
    private readonly host: EngineHost = NO_HOST,
  ) {}

  private readonly textChanged = new Emitter<string>();
  /** A document's text changed (typing, reload from disk) or it was closed; with its path. */
  readonly onDidChangeText = this.textChanged.event;

  private readonly engineCallbacks: ((engine: EditorEngine) => void)[] = [];

  /** Runs `callback` with the engine once it is loaded (now, if it already is). */
  whenEngine(callback: (engine: EditorEngine) => void): void {
    if (this.engine) callback(this.engine);
    else this.engineCallbacks.push(callback);
  }

  /** A language's editor options (read again on each settings change: applySettings). */
  private readonly languageOptions = (languageId: string, path?: string) =>
    this.settings(languageId, path).editor;

  /** Re-reads editor settings into the engine (call when editor.* settings change). */
  applySettings(): void {
    this.engine?.setOptions(this.settings().editor, this.languageOptions);
  }

  /** The engine, if loaded. */
  get loadedEngine(): EditorEngine | undefined {
    return this.engine;
  }

  /** Loads Monaco (once). Safe to call early to warm up. */
  ensureEngine(): Promise<EditorEngine> {
    this.enginePending ??= loadEditorEngine(this.theme, this.host).then((engine) => {
      perf.mark("editorReady");
      this.engine = engine;
      this.store.add(engine);
      engine.setOptions(this.settings().editor, this.languageOptions);
      for (const callback of this.engineCallbacks.splice(0)) callback(engine);
      for (const doc of this.byKey.values()) this.attachModel(doc);
      return engine;
    });
    return this.enginePending;
  }

  find(path: string): EditorDocument | undefined {
    return this.byKey.get(pathKey(path));
  }

  /** Saving an untitled document: asks where and writes it (set by the editor extension). */
  saveUntitled: ((doc: EditorDocument) => Promise<void>) | undefined;

  /**
   * An untitled document became `path` (saved): same tabs, text and undo-free model under the
   * new name, and clean.
   */
  adopt(doc: EditorDocument, path: string): void {
    const from = doc.path.peek();
    this.renamed(from, path);
    const model = doc.model.peek();
    if (model) {
      doc.savedVersion = model.versionId;
      doc.diskText = model.getText();
    }
    doc.dirty.value = false;
    doc.diskState.value = "ok";
    this.saved.fire(path);
  }

  /** A new untitled document (Ctrl+N, D126), optionally with text. */
  createUntitled(text = ""): EditorDocument {
    const path = nextUntitled(this.documents.peek().map((d) => d.path.peek()));
    return this.add(path, "text", text, false);
  }

  /** Loads `path` (or returns the open document). Throws for folders and files over 50 MB. */
  load(path: string): Promise<EditorDocument> {
    const key = pathKey(path);
    const open = this.byKey.get(key);
    if (open) return Promise.resolve(open);
    // A restored tab of an untitled document: empty again (hot exit puts its text back).
    if (isUntitled(path)) return Promise.resolve(this.add(path, "text", "", false));
    let pending = this.loading.get(key);
    if (!pending) {
      pending = this.read(path).finally(() => this.loading.delete(key));
      this.loading.set(key, pending);
    }
    return pending;
  }

  private async read(path: string): Promise<EditorDocument> {
    // The grammar loads while the file is read: the text shows colored when the model appears.
    void this.engine?.warmLanguage?.(path).catch(() => {});
    // A URI of an extension's file system (D233) is read through the extension.
    // A restored tab can ask before its extension has started: wait for the scheme's provider
    // (extensions activating on `onFileSystem:<scheme>` start now, D234).
    const provided = uriScheme(path)
      ? await fileSystems.whenServed(path, PROVIDER_WAIT_MS)
      : undefined;
    if (uriScheme(path) && !provided)
      throw new Error(`No extension serves ${uriScheme(path)}: files (${path}).`);
    const stat = provided ? await provided.stat(path) : await fsIpc.stat(path);
    if (stat.kind === "dir") throw new Error(`${basename(path)} is a folder.`);
    if (stat.size > MAX_FILE_BYTES)
      throw new Error(
        `${basename(path)} is too large to open (${Math.round(stat.size / 1048576)} MB).`,
      );
    const files = this.settings(languageForPath(path), path).files;
    const bytes = provided ? await provided.readFile(path) : await fsIpc.read(path);
    // files.autoGuessEncoding (D204): the detector looks only at text that isn't UTF-8.
    const guessed = wantsGuess(bytes, files.autoGuessEncoding)
      ? await encodingIpc.guess(bytes).catch(() => null)
      : null;
    const { text, binary, hadBom, notUtf8, encoding } = decodeFile(bytes, undefined, {
      fallback: files.encoding,
      guess: files.autoGuessEncoding,
      guessed,
    });
    const doc = this.add(path, binary ? "binary" : "text", text, hadBom, undefined, notUtf8);
    doc.encoding = encoding;
    doc.diskText = text;
    return doc;
  }

  /** Opens generated read-only content (e.g. dev.dumpState output), replacing earlier text for `id`. */
  openVirtual(id: string, title: string, text: string): EditorDocument {
    const old = this.byKey.get(pathKey(`virtual:${id}`));
    if (old) {
      old.model.peek()?.dispose();
      old.model.value = null;
      old.subscriptions.clear();
      old.initialText = text;
      this.attachModel(old);
      return old;
    }
    return this.add(`virtual:${id}`, "virtual", text, false, title);
  }

  retain(doc: EditorDocument): void {
    doc.refs++;
  }

  release(doc: EditorDocument): void {
    doc.refs = Math.max(0, doc.refs - 1);
    if (doc.refs === 0) this.drop(doc);
  }

  /**
   * Reads the file again in `encoding` (D199). A document that becomes writable (or read-only)
   * gets a new model; otherwise its text is replaced as one undoable edit.
   */
  async reopenWithEncoding(doc: EditorDocument, encoding: string): Promise<void> {
    const info = encodingInfo(encoding);
    if (!info) throw new Error(`Unknown encoding ${encoding}.`);
    if (doc.kind !== "text") throw new Error(`${documentName(doc)} isn't a text file.`);
    if (doc.dirty.peek())
      throw new Error(`Save or revert ${documentName(doc)} first: reopening replaces its text.`);
    const bytes = await fsIpc.read(doc.path.peek());
    this.applyReading(doc, {
      text: decodeWith(bytes, encoding),
      encoding,
      hadBom: encoding === "utf8bom" || encoding.startsWith("utf16"),
      readOnly: !info.canSave,
    });
  }

  /**
   * A read-only document (not valid UTF-8, or in an encoding that can't be written) whose file
   * was rewritten as UTF-8 elsewhere (D218): it's read as UTF-8 from now on and becomes writable.
   */
  becameUtf8(
    doc: EditorDocument,
    reading: { text: string; encoding: string; hadBom: boolean },
  ): void {
    this.applyReading(doc, { ...reading, readOnly: false });
    doc.dirty.value = false;
    doc.diskState.value = "ok";
  }

  /**
   * The file's text in an encoding: a document that becomes writable (or read-only) gets a new
   * model; otherwise its text is replaced as one undoable edit.
   */
  private applyReading(
    doc: EditorDocument,
    reading: { text: string; encoding: string; hadBom: boolean; readOnly: boolean },
  ): void {
    const { text, encoding, hadBom, readOnly } = reading;
    doc.encoding = encoding;
    doc.hadBom = hadBom;
    const before = doc.notUtf8;
    doc.notUtf8 = readOnly;
    const model = doc.model.peek();
    if (model && model.readOnly !== readOnly) {
      // Writable or not is fixed when a model is made: make a new one.
      doc.subscriptions.clear();
      doc.model.value = null;
      model.dispose();
      doc.initialText = text;
      this.attachModel(doc);
    } else applyDiskText(doc, text);
    doc.diskText = text;
    if (before !== doc.notUtf8) doc.diskState.value = doc.diskState.peek();
    this.encodingChanged.fire(doc.path.peek());
  }
  /** A document's encoding changed (the status bar shows it). */
  readonly encodingChanged = new Emitter<string>();

  /** Per document, the save in flight: saves of one file run one after another (see save). */
  private readonly saving = new WeakMap<EditorDocument, Promise<void>>();

  /**
   * Writes the document. `keepLines`: the cursor lines an auto save leaves untrimmed. Saves of
   * one document are queued: an auto save and Ctrl+S racing could otherwise land on disk in the
   * wrong order (the older text last).
   */
  save(doc: EditorDocument, options: SaveRequest = {}): Promise<void> {
    const previous = this.saving.get(doc) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.saveNow(doc, options));
    this.saving.set(doc, next);
    return next;
  }

  private async saveNow(doc: EditorDocument, options: SaveRequest): Promise<void> {
    if (isUntitled(doc.path.peek())) {
      if (!this.saveUntitled) throw new Error("Save as… to give it a file.");
      await this.saveUntitled(doc);
      return;
    }
    const model = doc.model.peek();
    if (!model || doc.kind !== "text") throw new Error(`Nothing to save for ${documentName(doc)}`);
    if (doc.notUtf8) throw notUtf8Error(doc);
    // getText() keeps the document's own line endings (CRLF files stay CRLF).
    model.replaceText(
      applySaveTransforms(
        model.getText(),
        model.eol,
        this.settings(model.languageId, doc.path.peek()).files,
        options.keepLines,
      ),
    );
    const text = model.getText();
    // The version of `text`, taken before any await: typing during the (native) encode must leave
    // the document dirty, not be marked saved.
    const version = model.versionId;
    const encoding = options.encoding ?? doc.encoding;
    const bytes = await encodeText(text, encoding, encodingIpc.encode);
    const path = doc.path.peek();
    // Changed on disk since the IDE last read or wrote it, and the watcher hasn't said so yet (or
    // can't: a network drive): don't overwrite it unseen (VS Code's "the file is newer"). The
    // banner offers Reload or Keep my changes (which takes the disk text as the known one).
    if (await this.changedOnDisk(doc, path, text)) {
      doc.diskState.value = "changed";
      throw new Error(
        `${documentName(doc)} changed on disk since it was opened: reload it, or keep your changes and save again.`,
      );
    }
    const provided = fileSystems.get(path);
    await (provided ? provided.writeFile(path, bytes) : fsIpc.write(path, bytes));
    doc.encoding = encoding;
    doc.diskText = text;
    doc.savedVersion = version;
    doc.dirty.value = model.versionId !== doc.savedVersion;
    doc.diskState.value = "ok";
    this.saved.fire(path);
  }

  /** The file holds text other than what the IDE last knew of it (and other than `text`). */
  private async changedOnDisk(doc: EditorDocument, path: string, text: string): Promise<boolean> {
    const known = doc.diskText;
    if (known === undefined) return false;
    let bytes: Uint8Array;
    try {
      bytes = await (fileSystems.get(path)?.readFile(path) ?? fsIpc.read(path));
    } catch {
      return false; // deleted (or unreadable): saving writes it again
    }
    const disk = decodeFile(bytes, doc.encoding);
    return !disk.binary && disk.text !== known && disk.text !== text;
  }

  /** Save / Don't save / Cancel for one document. False = cancelled. */
  async confirmDiscard(doc: EditorDocument): Promise<boolean> {
    if (!doc.dirty.peek()) return true;
    const choice = await confirmSaveChanges(
      `Save changes to ${documentName(doc)}?`,
      "Your changes will be lost if you don't save them.",
    );
    if (choice === "cancel") return false;
    if (choice === "save") await this.save(doc);
    return true;
  }

  /**
   * Asks once about all dirty documents (folder switch, window close), or only those of `among`
   * (window close with hot exit: the ones without a backup). False = cancelled.
   */
  async confirmCloseAll(among?: readonly EditorDocument[]): Promise<boolean> {
    const dirty = (among ?? this.documents.peek()).filter((d) => d.dirty.peek());
    if (dirty.length === 0) return true;
    const names = dirty.map(documentName).join(", ");
    const choice = await confirmSaveChanges(
      dirty.length === 1 ? `Save changes to ${names}?` : `Save changes to ${dirty.length} files?`,
      dirty.length === 1
        ? "Your changes will be lost if you don't save them."
        : `${names}\n\nYour changes will be lost if you don't save them.`,
    );
    if (choice === "cancel") return false;
    if (choice === "save") for (const doc of dirty) await this.save(doc);
    // "Don't save": forget the edits so later close prompts don't ask again.
    for (const doc of dirty) doc.dirty.value = false;
    return true;
  }

  /** Follows a rename of a file or folder: documents keep their content, dirty state and tabs. */
  renamed(from: string, to: string): void {
    this.forgetClosed(from);
    // A kept model at the destination would be disposed by createDocument (same URI) while still
    // listed as kept; reopening would then reuse a disposed model.
    this.forgetClosed(to);
    for (const doc of [...this.byKey.values()]) {
      const path = doc.path.peek();
      if (doc.kind === "virtual" || !isWithin(from, path)) continue;
      const next = rebase(from, to, path);
      this.byKey.delete(pathKey(path));
      this.byKey.set(pathKey(next), doc);
      const model = doc.model.peek();
      const wasDirty = doc.dirty.peek();
      doc.path.value = next;
      if (model && this.engine) {
        // A new model under the new URI (language may change with the extension).
        const text = model.getText();
        const eol = model.eol;
        model.dispose();
        doc.subscriptions.clear();
        // Still read-only when it was (not UTF-8, D199), and a one-line file keeps its line ending.
        this.bindModel(doc, this.engine.createDocument(next, text, { eol, readOnly: doc.notUtf8 }));
        if (wasDirty) {
          doc.savedVersion = -1;
          doc.dirty.value = true;
        }
      }
    }
  }

  /** Documents at or under `path` (for delete handling). */
  under(path: string): EditorDocument[] {
    return [...this.byKey.values()].filter(
      (d) => d.kind !== "virtual" && isWithin(path, d.path.peek()),
    );
  }

  /** Drops every document (folder switch, after views closed), and the closed files' models. */
  closeAll(): void {
    for (const doc of [...this.byKey.values()]) this.drop(doc);
    this.forgetClosed();
    this.engine?.disposePreviewModels?.();
  }

  /** A closed file whose model (undo history) is kept for reopening. */
  isClosedKept(path: string): boolean {
    return this.closed.has(pathKey(path));
  }

  private forgetClosed(under?: string): void {
    for (const [key, model] of [...this.closed]) {
      if (under !== undefined && !isWithin(under, model.path)) continue;
      model.dispose();
      this.closed.delete(key);
    }
  }

  /** Keeps a closed document's model. Discarded unsaved edits become one undoable step back. */
  private keepClosed(doc: EditorDocument, model: EngineDocument): boolean {
    if (
      doc.kind !== "text" ||
      isUntitled(doc.path.peek()) ||
      model.getText().length > KEEP_CLOSED_CHARS
    )
      return false;
    const key = pathKey(doc.path.peek());
    this.closed.get(key)?.dispose();
    this.closed.delete(key);
    this.closed.set(key, model);
    while (this.closed.size > KEEP_CLOSED) {
      const [oldest, old] = this.closed.entries().next().value as [string, EngineDocument];
      old.dispose();
      this.closed.delete(oldest);
    }
    // Closed for language servers (didClose), D218.
    model.setKeptClosed?.(true);
    if (doc.dirty.peek()) {
      // The built-in checkers keep seeing this model: give it the saved text (the discarded edits
      // stay reachable with undo after reopening).
      void fsIpc
        .read(doc.path.peek())
        .then((bytes) => {
          const disk = decodeFile(bytes, doc.encoding);
          if (this.closed.get(key) === model && !disk.binary) model.replaceText(disk.text);
        })
        .catch(() => {});
    }
    return true;
  }

  private add(
    path: string,
    kind: EditorDocument["kind"],
    text: string,
    hadBom: boolean,
    title?: string,
    notUtf8 = false,
  ): EditorDocument {
    const doc: EditorDocument = {
      path: signal(path),
      kind,
      ...(title !== undefined && { title }),
      initialText: text,
      model: signal<EngineDocument | null>(null),
      dirty: signal(false),
      savedVersion: 0,
      diskState: signal<"ok" | "changed" | "deleted">("ok"),
      hadBom,
      encoding: hadBom ? "utf8bom" : "utf8",
      notUtf8,
      diskText: undefined,
      refs: 0,
      subscriptions: new DisposableStore(),
    };
    this.byKey.set(pathKey(path), doc);
    this.documents.value = [...this.documents.peek(), doc];
    this.attachModel(doc);
    setTimeout(() => {
      if (doc.refs === 0 && this.byKey.get(pathKey(doc.path.peek())) === doc) this.drop(doc);
    }, SWEEP_MS);
    return doc;
  }

  private attachModel(doc: EditorDocument): void {
    if (!this.engine || doc.kind === "binary" || doc.model.peek()) return;
    const path = doc.path.peek();
    const kept = doc.kind === "text" ? this.closed.get(pathKey(path)) : undefined;
    if (kept) {
      // Reopened: the same model, so undo reaches back past the close (and past the last save).
      this.closed.delete(pathKey(path));
      kept.replaceText(doc.initialText);
      // Open again for language servers (didOpen with this text).
      kept.setKeptClosed?.(false);
      this.bindModel(doc, kept);
      return;
    }
    const model =
      doc.kind === "virtual"
        ? this.engine.createDocument(`/${path.slice("virtual:".length)}`, doc.initialText, {
            readOnly: true,
          })
        : this.engine.createDocument(path, doc.initialText, {
            eol: newFileEol(this.settings(languageForPath(path), path)),
            readOnly: doc.notUtf8,
          });
    this.bindModel(doc, model);
  }

  private bindModel(doc: EditorDocument, model: EngineDocument): void {
    doc.savedVersion = model.versionId;
    if (doc.kind === "text") {
      doc.subscriptions.add(
        model.onDidChangeContent(() => {
          // An untitled document is dirty while it has text (emptied, it closes without asking).
          doc.dirty.value = isUntitled(doc.path.peek())
            ? model.getText().length > 0
            : model.versionId !== doc.savedVersion;
          this.textChanged.fire(doc.path.peek());
        }),
      );
    }
    doc.model.value = model;
  }

  private drop(doc: EditorDocument): void {
    const key = pathKey(doc.path.peek());
    if (this.byKey.get(key) !== doc) return;
    this.byKey.delete(key);
    this.documents.value = this.documents.peek().filter((d) => d !== doc);
    doc.subscriptions.dispose();
    const model = doc.model.peek();
    if (model && !this.keepClosed(doc, model)) model.dispose();
    doc.model.value = null;
    this.textChanged.fire(doc.path.peek());
  }

  dispose(): void {
    this.closeAll();
    this.store.dispose();
    this.saved.dispose();
    this.textChanged.dispose();
  }
}

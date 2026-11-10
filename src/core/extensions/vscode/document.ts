// The `vscode` shim's text documents (D256): VS Code's TextDocument over a file's text, and the
// set of open ones its extensions see (workspace.textDocuments and their events). The IDE says a
// file opened, changed or closed; the text comes from the editor, so a change is the difference
// between the old and the new text (one replaced range, what language clients send on). DOM-free
// and unit-tested.

import { pathOf, uriOf } from "./convert";
import { vscodeLanguageId } from "./languageIds";
import { EndOfLine, EventEmitter, Position, Range, type Uri } from "./types";

/** VS Code's default word pattern (numbers, or runs of what isn't punctuation or space). */
const DEFAULT_WORD = /(-?\d*\.\d\w*)|([^`~!@#$%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g;

export interface TextLine {
  readonly lineNumber: number;
  readonly text: string;
  readonly range: Range;
  readonly rangeIncludingLineBreak: Range;
  readonly firstNonWhitespaceCharacterIndex: number;
  readonly isEmptyOrWhitespace: boolean;
}

export interface TextDocumentContentChangeEvent {
  readonly range: Range;
  readonly rangeOffset: number;
  readonly rangeLength: number;
  readonly text: string;
}

export interface TextDocumentChangeEvent {
  readonly document: ShimTextDocument;
  readonly contentChanges: readonly TextDocumentContentChangeEvent[];
  readonly reason: undefined;
}

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 13 /* \r */) {
      if (text.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    } else if (ch === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

export class ShimTextDocument {
  readonly uri: Uri;
  /** An "untitled:" document (D261: always false before). */
  readonly isUntitled: boolean;
  readonly encoding = "utf8";
  version = 1;
  isDirty = false;
  isClosed = false;
  private content = "";
  private starts: number[] = [0];

  constructor(
    path: string,
    public languageId: string,
    text: string,
    private readonly saver?: (doc: ShimTextDocument) => Promise<boolean>,
  ) {
    this.uri = uriOf(path);
    this.isUntitled = this.uri.scheme === "untitled";
    this.setText(text);
  }

  get fileName(): string {
    return pathOf(this.uri);
  }

  get lineCount(): number {
    return this.starts.length;
  }

  get eol(): EndOfLine {
    return this.content.includes("\r\n") ? EndOfLine.CRLF : EndOfLine.LF;
  }

  /** Replaces the text; the change as one replaced range of the old text (null: no change). */
  setText(text: string): TextDocumentContentChangeEvent | null {
    const old = this.content;
    if (text === old) return null;
    let prefix = 0;
    const max = Math.min(old.length, text.length);
    while (prefix < max && old.charCodeAt(prefix) === text.charCodeAt(prefix)) prefix++;
    // Don't split a \r\n pair, nor a surrogate pair (an emoji changed into another: the change
    // was half a character, which a server counting UTF-8 can't apply).
    if (prefix > 0 && old.charCodeAt(prefix - 1) === 13 && old.charCodeAt(prefix) === 10) prefix--;
    if (prefix > 0 && isHighSurrogate(old.charCodeAt(prefix - 1))) prefix--;
    let suffix = 0;
    while (
      suffix < max - prefix &&
      old.charCodeAt(old.length - 1 - suffix) === text.charCodeAt(text.length - 1 - suffix)
    )
      suffix++;
    if (suffix > 0 && isLowSurrogate(old.charCodeAt(old.length - suffix))) suffix--;
    if (
      suffix > 0 &&
      old.charCodeAt(old.length - suffix) === 10 &&
      old.charCodeAt(old.length - suffix - 1) === 13
    )
      suffix--;
    const range = new Range(this.positionAt(prefix), this.positionAt(old.length - suffix));
    const change = {
      range,
      rangeOffset: prefix,
      rangeLength: old.length - suffix - prefix,
      text: text.slice(prefix, text.length - suffix),
    };
    this.content = text;
    this.starts = lineStartsOf(text);
    return change;
  }

  getText(range?: Range): string {
    if (!range) return this.content;
    const r = this.validateRange(range);
    return this.content.slice(this.offsetAt(r.start), this.offsetAt(r.end));
  }

  lineAt(lineOrPosition: number | Position): TextLine {
    const line = typeof lineOrPosition === "number" ? lineOrPosition : lineOrPosition.line;
    if (line < 0 || line >= this.lineCount) throw new Error(`Illegal value for line: ${line}`);
    const start = this.starts[line] ?? 0;
    const next = this.starts[line + 1] ?? this.content.length;
    let end = next;
    if (line + 1 < this.lineCount) {
      end =
        this.content.charCodeAt(next - 2) === 13 && this.content.charCodeAt(next - 1) === 10
          ? next - 2
          : next - 1;
    }
    const text = this.content.slice(start, end);
    const firstNonWs = text.search(/\S/);
    return {
      lineNumber: line,
      text,
      range: new Range(line, 0, line, text.length),
      rangeIncludingLineBreak:
        line + 1 < this.lineCount
          ? new Range(line, 0, line + 1, 0)
          : new Range(line, 0, line, text.length),
      firstNonWhitespaceCharacterIndex: firstNonWs < 0 ? text.length : firstNonWs,
      isEmptyOrWhitespace: firstNonWs < 0,
    };
  }

  offsetAt(position: Position): number {
    const p = this.validatePosition(position);
    return (this.starts[p.line] ?? 0) + p.character;
  }

  positionAt(offset: number): Position {
    const o = Math.max(0, Math.min(Math.floor(offset), this.content.length));
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.starts[mid] ?? 0) <= o) lo = mid;
      else hi = mid - 1;
    }
    const lineLength = this.lineAt(lo).text.length;
    return new Position(lo, Math.min(o - (this.starts[lo] ?? 0), lineLength));
  }

  validatePosition(position: Position): Position {
    const line = Math.max(0, Math.min(position.line, this.lineCount - 1));
    const max = this.lineAt(line).text.length;
    if (position.line > this.lineCount - 1) return new Position(line, max);
    const character = Math.max(0, Math.min(position.character, max));
    return line === position.line && character === position.character
      ? position
      : new Position(line, character);
  }

  validateRange(range: Range): Range {
    const start = this.validatePosition(range.start);
    const end = this.validatePosition(range.end);
    return start === range.start && end === range.end ? range : new Range(start, end);
  }

  getWordRangeAtPosition(position: Position, regex?: RegExp): Range | undefined {
    const p = this.validatePosition(position);
    const text = this.lineAt(p.line).text;
    const pattern = regex
      ? new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`)
      : new RegExp(DEFAULT_WORD.source, "g");
    for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
      if (!m[0]) {
        pattern.lastIndex++;
        continue;
      }
      if (m.index <= p.character && p.character <= m.index + m[0].length)
        return new Range(p.line, m.index, p.line, m.index + m[0].length);
      if (m.index > p.character) break;
    }
    return undefined;
  }

  save(): Promise<boolean> {
    return this.saver ? this.saver(this) : Promise.resolve(false);
  }
}

/** Larger documents aren't synced to the extension (VS Code's limit, 50 MB). */
export const MAX_SYNCED_CHARS = 50 * 1024 * 1024;

/** A comparable key for a path (Windows paths ignore case and the slash's direction). */
export function pathKey(path: string): string {
  const p = path.replace(/\\/g, "/");
  return /^[a-zA-Z]:\//.test(p) || p.startsWith("//") ? p.toLowerCase() : p;
}

export interface DocumentsHost {
  /** The file's text as the editor has it (unsaved edits included), or on disk. */
  text(path: string): Promise<string>;
  /** Saves an open file. */
  save(path: string): Promise<boolean>;
}

/** The documents an extension sees: the editor's open files, and those it opened itself. */
export class Documents {
  private readonly docs = new Map<string, ShimTextDocument>();
  readonly onDidOpen = new EventEmitter<ShimTextDocument>();
  readonly onDidClose = new EventEmitter<ShimTextDocument>();
  readonly onDidChange = new EventEmitter<TextDocumentChangeEvent>();
  readonly onDidSave = new EventEmitter<ShimTextDocument>();
  /** One fetch per document at a time: a change waits for the one before it. */
  private readonly syncing = new Map<string, Promise<ShimTextDocument | undefined>>();

  constructor(private readonly host: DocumentsHost) {}

  all(): ShimTextDocument[] {
    return [...this.docs.values()];
  }

  get(path: string): ShimTextDocument | undefined {
    return this.docs.get(pathKey(path));
  }

  /**
   * Brings `path` up to date with the editor: opens it (onDidOpen) or reports what changed
   * (onDidChange, a new version). `languageId` is kept from before when not given.
   */
  sync(
    path: string,
    languageId?: string,
    // A change from the editor makes it dirty, one read from disk doesn't (D261: never dirty).
    options: { dirty?: boolean } = {},
  ): Promise<ShimTextDocument | undefined> {
    const key = pathKey(path);
    // Open now: if it closes while this waits, it stays closed (D261: it came back as a document
    // no close would ever follow).
    const wasOpen = this.docs.has(key);
    const before = this.syncing.get(key) ?? Promise.resolve(undefined);
    const next = before
      .catch(() => undefined)
      .then(async () => {
        if (wasOpen && !this.docs.has(key)) return undefined;
        const text = await this.host.text(path);
        if (wasOpen && !this.docs.has(key)) return undefined;
        let doc = this.docs.get(key);
        // As in VS Code, a huge file isn't given to extensions (nor copied on every change).
        if (text.length > MAX_SYNCED_CHARS) {
          if (doc) this.close(path);
          return undefined;
        }
        // The editor's id as VS Code names it ("tsx" → "typescriptreact").
        if (languageId) languageId = vscodeLanguageId(languageId);
        // A language change is a close and an open in VS Code.
        if (doc && languageId && languageId !== doc.languageId) {
          this.close(path);
          doc = undefined;
        }
        if (!doc) {
          const opened = new ShimTextDocument(path, languageId ?? languageOfPath(path), text, (d) =>
            this.host.save(pathOf(d.uri)),
          );
          this.docs.set(key, opened);
          this.onDidOpen.fire(opened);
          return opened;
        }
        const change = doc.setText(text);
        if (change) {
          doc.version++;
          if (options.dirty !== undefined) doc.isDirty = options.dirty;
          this.onDidChange.fire({ document: doc, contentChanges: [change], reason: undefined });
        }
        return doc;
      });
    this.syncing.set(key, next);
    void next.finally(() => {
      if (this.syncing.get(key) === next) this.syncing.delete(key);
    });
    return next;
  }

  /** Documents made by `openTextDocument({ content })` that no editor shows yet (D261). */
  private readonly local = new WeakSet<ShimTextDocument>();

  /** Adds an untitled document of the extension's own: open (onDidOpen), not yet in an editor. */
  openLocal(doc: ShimTextDocument): void {
    this.local.add(doc);
    this.docs.set(pathKey(pathOf(doc.uri)), doc);
    this.onDidOpen.fire(doc);
  }

  /**
   * A notebook cell's document (`vscode-notebook-cell:`): open while its cell is, changed in place
   * by its notebook (notebookEditors.ts), as VS Code's workspace.textDocuments has them.
   */
  readonly cells = {
    opened: (doc: ShimTextDocument): void => {
      this.docs.set(pathKey(pathOf(doc.uri)), doc);
      this.onDidOpen.fire(doc);
    },
    changed: (event: TextDocumentChangeEvent): void => {
      if (this.docs.get(pathKey(pathOf(event.document.uri))) === event.document)
        this.onDidChange.fire(event);
    },
    closed: (doc: ShimTextDocument): void => {
      const key = pathKey(pathOf(doc.uri));
      if (this.docs.get(key) === doc) this.docs.delete(key);
      this.onDidClose.fire(doc);
    },
  };

  /** Whether `doc` is one of those (showing it makes the IDE's own untitled editor). */
  isLocal(doc: ShimTextDocument): boolean {
    return this.local.has(doc);
  }

  close(path: string): void {
    const key = pathKey(path);
    const doc = this.docs.get(key);
    if (!doc) return;
    this.docs.delete(key);
    doc.isClosed = true;
    this.onDidClose.fire(doc);
  }

  async saved(path: string): Promise<void> {
    if (!this.get(path)) return;
    const doc = await this.sync(path);
    if (doc) {
      doc.isDirty = false;
      this.onDidSave.fire(doc);
    }
  }
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  jsx: "javascriptreact",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  css: "css",
  html: "html",
  yml: "yaml",
  yaml: "yaml",
  txt: "plaintext",
};

/** A guess from the file's extension, for a document the IDE didn't name a language for. */
export function languageOfPath(path: string): string {
  const ext = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
  return LANGUAGE_BY_EXTENSION[ext] ?? "plaintext";
}

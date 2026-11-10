// The `vscode` shim's core types (D256): VS Code's classes and enums its extensions construct
// (Position, Range, Uri, EventEmitter, CancellationTokenSource, WorkspaceEdit…), written from VS
// Code's documented API. Positions are 0-based here, as in VS Code; convert.ts turns them into
// the IDE's 1-based ones. DOM-free and unit-tested.

export class Disposable {
  private disposed = false;

  constructor(private readonly callOnDispose: () => unknown) {}

  static from(...items: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => {
      // As VS Code: what has no dispose function is skipped (one throwing stopped the rest).
      for (const item of items) if (typeof item?.dispose === "function") item.dispose();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.callOnDispose();
  }
}

export type Event<T> = (
  listener: (e: T) => unknown,
  thisArgs?: unknown,
  disposables?: { dispose(): unknown }[],
) => Disposable;

/**
 * An Event over a subscription the IDE gives (a listener in, something to dispose out), with VS
 * Code's `thisArgs` and `disposables` (the Disposable is added to them, as `context.subscriptions`
 * expects).
 */
export function eventOf<T>(
  subscribe: (listener: (e: T) => unknown) => { dispose(): unknown },
): Event<T> {
  return (listener, thisArgs, disposables) => {
    const d = subscribe(thisArgs ? listener.bind(thisArgs) : listener);
    const out = new Disposable(() => d.dispose());
    disposables?.push(out);
    return out;
  };
}

export class EventEmitter<T> {
  /** One entry per subscription: the same listener added twice is two (disposed one at a time). */
  private listeners: { fn: (e: T) => unknown }[] = [];
  private disposed = false;

  readonly event: Event<T> = (listener, thisArgs, disposables) => {
    const entry = { fn: thisArgs ? listener.bind(thisArgs) : listener };
    if (!this.disposed) this.listeners.push(entry);
    const d = new Disposable(() => {
      this.listeners = this.listeners.filter((l) => l !== entry);
    });
    disposables?.push(d);
    return d;
  };

  fire(data: T): void {
    for (const { fn } of [...this.listeners]) {
      try {
        fn(data);
      } catch (err) {
        console.error(err);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners = [];
  }
}

export interface CancellationToken {
  isCancellationRequested: boolean;
  onCancellationRequested: Event<unknown>;
}

export class CancellationTokenSource {
  private emitter = new EventEmitter<unknown>();
  private cancelled = false;
  readonly token: CancellationToken;

  constructor() {
    const self = this;
    this.token = {
      get isCancellationRequested() {
        return self.cancelled;
      },
      onCancellationRequested: (listener, thisArgs, disposables) => {
        if (self.cancelled) {
          listener.call(thisArgs, undefined);
          return new Disposable(() => {});
        }
        return self.emitter.event(listener, thisArgs, disposables);
      },
    };
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.emitter.fire(undefined);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** A token that never cancels (what a call the IDE can't cancel gets). */
export const NONE_TOKEN: CancellationToken = new CancellationTokenSource().token;

export class CancellationError extends Error {
  constructor() {
    super("Canceled");
    this.name = "Canceled";
  }
}

export class Position {
  readonly line: number;
  readonly character: number;

  constructor(line: number, character: number) {
    if (line < 0 || character < 0)
      throw new Error("Illegal argument: line and character must be >= 0");
    this.line = line;
    this.character = character;
  }

  static isPosition(v: unknown): v is Position {
    return (
      v instanceof Position ||
      (!!v &&
        typeof (v as Position).line === "number" &&
        typeof (v as Position).character === "number")
    );
  }

  isBefore(other: Position): boolean {
    return this.line < other.line || (this.line === other.line && this.character < other.character);
  }
  isBeforeOrEqual(other: Position): boolean {
    return this.isBefore(other) || this.isEqual(other);
  }
  isAfter(other: Position): boolean {
    return !this.isBeforeOrEqual(other);
  }
  isAfterOrEqual(other: Position): boolean {
    return !this.isBefore(other);
  }
  isEqual(other: Position): boolean {
    return this.line === other.line && this.character === other.character;
  }
  compareTo(other: Position): number {
    return this.isBefore(other) ? -1 : this.isEqual(other) ? 0 : 1;
  }
  translate(
    lineDelta: number | { lineDelta?: number; characterDelta?: number } = 0,
    characterDelta = 0,
  ): Position {
    if (typeof lineDelta === "object")
      return this.translate(lineDelta.lineDelta ?? 0, lineDelta.characterDelta ?? 0);
    return new Position(this.line + lineDelta, this.character + characterDelta);
  }
  with(
    line: number | { line?: number; character?: number } = this.line,
    character = this.character,
  ): Position {
    if (typeof line === "object")
      return new Position(line.line ?? this.line, line.character ?? this.character);
    return new Position(line, character);
  }
  toJSON(): { line: number; character: number } {
    return { line: this.line, character: this.character };
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;

  constructor(start: Position, end: Position);
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    const start = typeof a === "number" ? new Position(a, b as number) : a;
    const end = typeof a === "number" ? new Position(c ?? 0, d ?? 0) : (b as Position);
    // VS Code orders them.
    if (end.isBefore(start)) {
      this.start = end;
      this.end = start;
    } else {
      this.start = start;
      this.end = end;
    }
  }

  static isRange(v: unknown): v is Range {
    return (
      v instanceof Range ||
      (!!v && Position.isPosition((v as Range).start) && Position.isPosition((v as Range).end))
    );
  }

  get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }
  get isSingleLine(): boolean {
    return this.start.line === this.end.line;
  }
  contains(v: Position | Range): boolean {
    if (v instanceof Range || Range.isRange(v))
      return this.contains(v.start) && this.contains(v.end);
    return v.isAfterOrEqual(this.start) && v.isBeforeOrEqual(this.end);
  }
  isEqual(other: Range): boolean {
    return this.start.isEqual(other.start) && this.end.isEqual(other.end);
  }
  intersection(other: Range): Range | undefined {
    const start = this.start.isAfter(other.start) ? this.start : other.start;
    const end = this.end.isBefore(other.end) ? this.end : other.end;
    return start.isAfter(end) ? undefined : new Range(start, end);
  }
  union(other: Range): Range {
    const start = this.start.isBefore(other.start) ? this.start : other.start;
    const end = this.end.isAfter(other.end) ? this.end : other.end;
    return new Range(start, end);
  }
  with(
    start: Position | { start?: Position; end?: Position } = this.start,
    end: Position = this.end,
  ): Range {
    if (!(start instanceof Position) && !Position.isPosition(start))
      return new Range(start.start ?? this.start, start.end ?? this.end);
    return new Range(start, end);
  }
  toJSON(): unknown {
    return [this.start.toJSON(), this.end.toJSON()];
  }
}

export class Selection extends Range {
  readonly anchor: Position;
  readonly active: Position;

  constructor(anchor: Position, active: Position);
  constructor(
    anchorLine: number,
    anchorCharacter: number,
    activeLine: number,
    activeCharacter: number,
  );
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    const anchor = typeof a === "number" ? new Position(a, b as number) : a;
    const active = typeof a === "number" ? new Position(c ?? 0, d ?? 0) : (b as Position);
    super(anchor, active);
    this.anchor = anchor;
    this.active = active;
  }

  get isReversed(): boolean {
    return this.anchor.isAfter(this.active);
  }

  /** VS Code's: the anchor and active ends too (a Range's pair lost them across JSON). */
  override toJSON(): unknown {
    return {
      start: this.start.toJSON(),
      end: this.end.toJSON(),
      active: this.active.toJSON(),
      anchor: this.anchor.toJSON(),
    };
  }
}

const URI = /^([a-zA-Z][\w+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/;
const DRIVE = /^\/[a-zA-Z]:/;

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** VS Code's Uri: scheme, authority, path, query, fragment; `fsPath` for files. */
export class Uri {
  readonly path: string;

  private constructor(
    readonly scheme: string,
    readonly authority: string,
    path: string,
    readonly query: string,
    readonly fragment: string,
  ) {
    // VS Code's rule: a file or web Uri's path is absolute ("c:/x" from Uri.from became
    // "file://c%3A/x", whose drive read as a host).
    this.path =
      (scheme === "file" || scheme === "http" || scheme === "https") && !path.startsWith("/")
        ? `/${path}`
        : path;
  }

  /** A file's path ("C:\\a\\b.ts" or "/a/b.ts"). */
  static file(path: string): Uri {
    let p = path.replace(/\\/g, "/");
    let authority = "";
    // A UNC path ("\\\\server\\share\\x").
    if (p.startsWith("//")) {
      const end = p.indexOf("/", 2);
      authority = end < 0 ? p.slice(2) : p.slice(2, end);
      p = end < 0 ? "/" : p.slice(end);
    }
    if (!p.startsWith("/")) p = `/${p}`;
    return new Uri("file", authority, p, "", "");
  }

  static parse(value: string, _strict?: boolean): Uri {
    const m = URI.exec(value);
    if (!m) return Uri.file(value);
    const scheme = (m[1] ?? "").toLowerCase();
    let path = decode(m[3] ?? "");
    if (scheme === "file" && path && !path.startsWith("/")) path = `/${path}`;
    return new Uri(scheme, decode(m[2] ?? ""), path, decode(m[4] ?? ""), decode(m[5] ?? ""));
  }

  static from(parts: {
    scheme: string;
    authority?: string;
    path?: string;
    query?: string;
    fragment?: string;
  }): Uri {
    return new Uri(
      parts.scheme,
      parts.authority ?? "",
      parts.path ?? "",
      parts.query ?? "",
      parts.fragment ?? "",
    );
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    const parts = [base.path, ...segments].join("/").split("/");
    const out: string[] = [];
    for (const part of parts) {
      if (part === "..") out.pop();
      else if (part && part !== ".") out.push(part);
    }
    // A trailing slash stays, as posix.join keeps it ("folder/").
    const last = segments[segments.length - 1];
    const slash = out.length && last?.endsWith("/") ? "/" : "";
    return base.with({ path: `/${out.join("/")}${slash}` });
  }

  static isUri(v: unknown): v is Uri {
    return (
      v instanceof Uri ||
      (!!v &&
        typeof (v as Uri).scheme === "string" &&
        typeof (v as Uri).path === "string" &&
        typeof (v as Uri).with === "function")
    );
  }

  /** A Uri that came through JSON (`{ scheme, path, … }`) as a Uri again. */
  static revive(v: unknown): Uri | undefined {
    if (v instanceof Uri) return v;
    if (!v || typeof v !== "object") return undefined;
    const o = v as Record<string, unknown>;
    if (typeof o.scheme !== "string") return undefined;
    const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
    return new Uri(o.scheme, s("authority"), s("path"), s("query"), s("fragment"));
  }

  get fsPath(): string {
    let p = this.path;
    if (this.authority && this.scheme === "file") p = `//${this.authority}${p}`;
    if (DRIVE.test(p)) {
      p = (p[1] ?? "").toLowerCase() + p.slice(2);
      return p.replace(/\//g, "\\");
    }
    return p.startsWith("//") ? p.replace(/\//g, "\\") : p;
  }

  with(change: {
    scheme?: string;
    authority?: string | null;
    path?: string | null;
    query?: string | null;
    fragment?: string | null;
  }): Uri {
    // undefined keeps a part, null clears it (VS Code's `with`; D261: null kept it).
    const part = (v: string | null | undefined, old: string) => (v === undefined ? old : (v ?? ""));
    return new Uri(
      change.scheme ?? this.scheme,
      part(change.authority, this.authority),
      part(change.path, this.path),
      part(change.query, this.query),
      part(change.fragment, this.fragment),
    );
  }

  toString(skipEncoding = false): string {
    const enc = (s: string) => (skipEncoding ? s : encodeURIComponent(s));
    // user@host:port as VS Code writes it: the host lowercased and encoded, `@` and the port kept
    // (D261: "localhost%3A3000" broke dev server addresses in webview pages).
    const authorityText = (a: string) => {
      if (skipEncoding) return a;
      const at = a.lastIndexOf("@");
      const user = at >= 0 ? `${a.slice(0, at).split(":").map(encodeURIComponent).join(":")}@` : "";
      const host = at >= 0 ? a.slice(at + 1) : a;
      if (host.startsWith("[")) return user + host;
      const colon = host.lastIndexOf(":");
      return colon >= 0
        ? `${user}${encodeURIComponent(host.slice(0, colon)).toLowerCase()}${host.slice(colon)}`
        : `${user}${encodeURIComponent(host).toLowerCase()}`;
    };
    // VS Code writes a drive letter in lowercase ("file:///c%3A/x").
    const path = (
      DRIVE.test(this.path)
        ? `/${(this.path[1] ?? "").toLowerCase()}${this.path.slice(2)}`
        : this.path
    )
      .split("/")
      .map((seg) => enc(seg))
      .join("/");
    const authority =
      this.authority || this.scheme === "file" ? `//${authorityText(this.authority)}` : "";
    // A `#` in the query stays encoded (it would start the fragment when parsed again).
    const query = this.query
      ? `?${skipEncoding ? this.query : encodeURI(this.query).replace(/#/g, "%23")}`
      : "";
    const fragment = this.fragment ? `#${enc(this.fragment)}` : "";
    return `${this.scheme}:${authority}${path}${query}${fragment}`;
  }

  toJSON(): unknown {
    return {
      $mid: 1,
      scheme: this.scheme,
      authority: this.authority,
      path: this.path,
      query: this.query,
      fragment: this.fragment,
      fsPath: this.fsPath,
      external: this.toString(),
    };
  }
}

export class RelativePattern {
  readonly baseUri: Uri;
  readonly base: string;

  constructor(
    base: Uri | string | { uri: Uri },
    readonly pattern: string,
  ) {
    const uri =
      typeof base === "string"
        ? Uri.file(base)
        : Uri.isUri(base)
          ? base
          : (base as { uri: Uri }).uri;
    this.baseUri = uri;
    this.base = uri.fsPath;
  }
}

export class ThemeIcon {
  static readonly File = new ThemeIcon("file");
  static readonly Folder = new ThemeIcon("folder");

  constructor(
    readonly id: string,
    readonly color?: ThemeColor,
  ) {}
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class MarkdownString {
  value: string;
  isTrusted?: boolean | { enabledCommands: string[] };
  supportThemeIcons?: boolean;
  supportHtml?: boolean;
  baseUri?: Uri;

  constructor(value = "", supportThemeIcons = false) {
    this.value = value;
    this.supportThemeIcons = supportThemeIcons;
  }

  appendText(value: string): MarkdownString {
    this.value += value.replace(/[\\`*_{}[\]()#+\-.!]/g, "\\$&").replace(/\n/g, "\n\n");
    return this;
  }
  appendMarkdown(value: string): MarkdownString {
    this.value += value;
    return this;
  }
  appendCodeblock(value: string, language = ""): MarkdownString {
    this.value += `\n\`\`\`${language}\n${value}\n\`\`\`\n`;
    return this;
  }
}

export class SnippetString {
  value: string;
  private tab = 1;

  constructor(value = "") {
    this.value = value;
  }

  static isSnippetString(v: unknown): v is SnippetString {
    return (
      v instanceof SnippetString ||
      (!!v &&
        typeof (v as SnippetString).value === "string" &&
        typeof (v as SnippetString).appendTabstop === "function")
    );
  }

  appendText(text: string): SnippetString {
    this.value += text.replace(/[$}\\]/g, "\\$&");
    return this;
  }
  appendTabstop(n = this.tab++): SnippetString {
    this.value += `$${n}`;
    return this;
  }
  appendPlaceholder(
    value: string | ((s: SnippetString) => unknown),
    n = this.tab++,
  ): SnippetString {
    if (typeof value === "function") {
      const nested = new SnippetString();
      nested.tab = this.tab;
      value(nested);
      this.tab = nested.tab;
      this.value += `\${${n}:${nested.value}}`;
    } else this.value += `\${${n}:${value.replace(/[$}\\]/g, "\\$&")}}`;
    return this;
  }
  appendChoice(values: string[], n = this.tab++): SnippetString {
    this.value += `\${${n}|${values.map((v) => v.replace(/[|,$}\\]/g, "\\$&")).join(",")}|}`;
    return this;
  }
  appendVariable(
    name: string,
    defaultValue: string | ((s: SnippetString) => unknown),
  ): SnippetString {
    if (typeof defaultValue === "function") {
      const nested = new SnippetString();
      nested.tab = this.tab;
      defaultValue(nested);
      this.tab = nested.tab;
      this.value += `\${${name}:${nested.value}}`;
    }
    // VS Code's: the default escaped, and no ":" without one.
    else
      this.value += defaultValue
        ? `\${${name}:${defaultValue.replace(/[$}]/g, "\\$&")}}`
        : `\${${name}}`;
    return this;
  }
}

/** A snippet's text without its tab stops (placeholders keep their text, a choice its first). */
export function snippetText(snippet: string): string {
  let out = snippet;
  for (let i = 0; i < 5; i++)
    out = out.replace(/\$\{\d+:([^{}]*)\}/g, "$1").replace(/\$\{\d+\|([^,|}]*)[^}]*\|\}/g, "$1");
  return out.replace(/\$\{?\d+\}?/g, "").replace(/\\([$}\\])/g, "$1");
}

export enum EndOfLine {
  LF = 1,
  CRLF = 2,
}

export class TextEdit {
  newEol?: EndOfLine;

  constructor(
    public range: Range,
    public newText: string,
  ) {}

  static replace(range: Range, newText: string): TextEdit {
    return new TextEdit(range, newText);
  }
  static insert(position: Position, newText: string): TextEdit {
    return new TextEdit(new Range(position, position), newText);
  }
  static delete(range: Range): TextEdit {
    return new TextEdit(range, "");
  }
  static setEndOfLine(eol: EndOfLine): TextEdit {
    const edit = new TextEdit(new Range(0, 0, 0, 0), "");
    edit.newEol = eol;
    return edit;
  }
}

export type WorkspaceEditEntry =
  | { kind: "edit"; uri: Uri; edit: TextEdit }
  | {
      kind: "create";
      uri: Uri;
      options?: { overwrite?: boolean; ignoreIfExists?: boolean; contents?: Uint8Array };
    }
  | {
      kind: "rename";
      from: Uri;
      to: Uri;
      options?: { overwrite?: boolean; ignoreIfExists?: boolean };
    }
  | { kind: "delete"; uri: Uri; options?: { recursive?: boolean; ignoreIfNotExists?: boolean } };

/** A SnippetTextEdit (extraTypes.ts): its snippet and range. */
type SnippetEditLike = { snippet: { value: string }; range: unknown };

export class WorkspaceEdit {
  private readonly ops: WorkspaceEditEntry[] = [];

  get size(): number {
    return new Set([
      ...this.ops.map((o) => (o.kind === "rename" ? o.from : o.uri).toString()),
      ...this.notebookOps.map((o) => o.uri.toString()),
    ]).size;
  }

  replace(uri: Uri, range: Range, newText: string): void {
    this.ops.push({ kind: "edit", uri, edit: new TextEdit(range, newText) });
  }
  insert(uri: Uri, position: Position, newText: string): void {
    this.replace(uri, new Range(position, position), newText);
  }
  delete(uri: Uri, range: Range): void {
    this.replace(uri, range, "");
  }
  has(uri: Uri): boolean {
    const key = uri.toString();
    return this.ops.some((o) => (o.kind === "rename" ? o.from : o.uri).toString() === key);
  }
  set(
    uri: Uri,
    edits:
      | readonly (
          | TextEdit
          | SnippetEditLike
          | [TextEdit | SnippetEditLike, unknown]
          | { newCells: unknown }
        )[]
      | null
      | undefined,
  ): void {
    const key = uri.toString();
    for (let i = this.ops.length - 1; i >= 0; i--) {
      const op = this.ops[i];
      if (op?.kind === "edit" && op.uri.toString() === key) this.ops.splice(i, 1);
    }
    this.notebookOps = this.notebookOps.filter((o) => o.uri.toString() !== key);
    for (const e of edits ?? []) {
      const edit = Array.isArray(e) ? e[0] : e;
      // A SnippetTextEdit: its text without the tab stops (it was taken for a notebook edit).
      const snippet = (edit as { snippet?: { value?: unknown }; range?: unknown } | undefined)
        ?.snippet?.value;
      const range = (edit as { range?: unknown } | undefined)?.range;
      if (typeof snippet === "string" && Range.isRange(range)) {
        const r =
          range instanceof Range ? range : new Range((range as Range).start, (range as Range).end);
        this.ops.push({ kind: "edit", uri, edit: new TextEdit(r, snippetText(snippet)) });
        continue;
      }
      // A NotebookEdit (cells): applied by the shim's notebooks through the IDE's cell commands.
      if (!edit || typeof (edit as { newText?: unknown }).newText !== "string") {
        if (edit) this.notebookOps.push({ uri, edit });
        continue;
      }
      this.ops.push({ kind: "edit", uri, edit: edit as TextEdit });
    }
  }
  /** NotebookEdits given to `set`, in order (D265: applied after the text edits). */
  notebookOps: { uri: Uri; edit: unknown }[] = [];
  get(uri: Uri): TextEdit[] {
    const key = uri.toString();
    return this.ops.flatMap((o) => (o.kind === "edit" && o.uri.toString() === key ? [o.edit] : []));
  }
  createFile(
    uri: Uri,
    options?: { overwrite?: boolean; ignoreIfExists?: boolean; contents?: Uint8Array },
  ): void {
    this.ops.push({ kind: "create", uri, ...(options && { options }) });
  }
  renameFile(
    oldUri: Uri,
    newUri: Uri,
    options?: { overwrite?: boolean; ignoreIfExists?: boolean },
  ): void {
    this.ops.push({ kind: "rename", from: oldUri, to: newUri, ...(options && { options }) });
  }
  deleteFile(uri: Uri, options?: { recursive?: boolean; ignoreIfNotExists?: boolean }): void {
    this.ops.push({ kind: "delete", uri, ...(options && { options }) });
  }
  entries(): [Uri, TextEdit[]][] {
    const map = new Map<string, [Uri, TextEdit[]]>();
    for (const o of this.ops) {
      if (o.kind !== "edit") continue;
      const key = o.uri.toString();
      const entry = map.get(key) ?? [o.uri, []];
      entry[1].push(o.edit);
      map.set(key, entry);
    }
    return [...map.values()];
  }
  /** Every operation in order (convert.ts applies them). */
  operations(): readonly WorkspaceEditEntry[] {
    return this.ops;
  }
}

export class Location {
  range: Range;

  constructor(
    public uri: Uri,
    rangeOrPosition: Range | Position,
  ) {
    this.range =
      rangeOrPosition instanceof Range || Range.isRange(rangeOrPosition)
        ? (rangeOrPosition as Range)
        : new Range(rangeOrPosition as Position, rangeOrPosition as Position);
  }
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export enum DiagnosticTag {
  Unnecessary = 1,
  Deprecated = 2,
}

export class DiagnosticRelatedInformation {
  constructor(
    public location: Location,
    public message: string,
  ) {}
}

export class Diagnostic {
  source?: string;
  code?: string | number | { value: string | number; target: Uri };
  relatedInformation?: DiagnosticRelatedInformation[];
  tags?: DiagnosticTag[];

  constructor(
    public range: Range,
    public message: string,
    public severity: DiagnosticSeverity = DiagnosticSeverity.Error,
  ) {}
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3,
  Four = 4,
  Five = 5,
  Six = 6,
  Seven = 7,
  Eight = 8,
  Nine = 9,
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

export enum TextEditorRevealType {
  Default = 0,
  InCenter = 1,
  InCenterIfOutsideViewport = 2,
  AtTop = 3,
}

export enum TextEditorSelectionChangeKind {
  Keyboard = 1,
  Mouse = 2,
  Command = 3,
}

export enum TextEditorCursorStyle {
  Line = 1,
  Block = 2,
  Underline = 3,
  LineThin = 4,
  BlockOutline = 5,
  UnderlineThin = 6,
}

export enum TextEditorLineNumbersStyle {
  Off = 0,
  On = 1,
  Relative = 2,
  Interval = 3,
}

export enum OverviewRulerLane {
  Left = 1,
  Center = 2,
  Right = 4,
  Full = 7,
}

export enum DecorationRangeBehavior {
  OpenOpen = 0,
  ClosedClosed = 1,
  OpenClosed = 2,
  ClosedOpen = 3,
}

export enum TextDocumentSaveReason {
  Manual = 1,
  AfterDelay = 2,
  FocusOut = 3,
}

export enum TextDocumentChangeReason {
  Undo = 1,
  Redo = 2,
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export enum FilePermission {
  Readonly = 1,
}

export enum FileChangeType {
  Changed = 1,
  Created = 2,
  Deleted = 3,
}

export class FileSystemError extends Error {
  constructor(
    messageOrUri?: string | Uri,
    readonly code = "Unknown",
  ) {
    super(Uri.isUri(messageOrUri) ? messageOrUri.toString(true) : (messageOrUri ?? code));
    this.name = `${code} (FileSystemError)`;
  }
  static FileNotFound(m?: string | Uri): FileSystemError {
    return new FileSystemError(m, "FileNotFound");
  }
  static FileExists(m?: string | Uri): FileSystemError {
    return new FileSystemError(m, "FileExists");
  }
  static FileNotADirectory(m?: string | Uri): FileSystemError {
    return new FileSystemError(m, "FileNotADirectory");
  }
  static FileIsADirectory(m?: string | Uri): FileSystemError {
    return new FileSystemError(m, "FileIsADirectory");
  }
  static NoPermissions(m?: string | Uri): FileSystemError {
    return new FileSystemError(m, "NoPermissions");
  }
  static Unavailable(m?: string | Uri): FileSystemError {
    return new FileSystemError(m, "Unavailable");
  }
}

export enum QuickPickItemKind {
  Separator = -1,
  Default = 0,
}

/** VS Code's built-in quick input buttons (a multi-step pick's "Back"): a class, as VS Code's. */
export class QuickInputButtons {
  static readonly Back: { iconPath: ThemeIcon; tooltip?: string } = {
    iconPath: new ThemeIcon("arrow-left"),
    tooltip: "Back",
  };

  private constructor() {}
}

export enum QuickInputButtonLocation {
  Title = 1,
  Inline = 2,
  Input = 3,
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export enum TreeItemCheckboxState {
  Unchecked = 0,
  Checked = 1,
}

export enum ExtensionMode {
  Production = 1,
  Development = 2,
  Test = 3,
}

export enum ExtensionKind {
  UI = 1,
  Workspace = 2,
}

export enum UIKind {
  Desktop = 1,
  Web = 2,
}

export enum LogLevel {
  Off = 0,
  Trace = 1,
  Debug = 2,
  Info = 3,
  Warning = 4,
  Error = 5,
}

export enum ColorThemeKind {
  Light = 1,
  Dark = 2,
  HighContrast = 3,
  HighContrastLight = 4,
}

export enum EnvironmentVariableMutatorType {
  Replace = 1,
  Append = 2,
  Prepend = 3,
}

export enum TerminalLocation {
  Panel = 1,
  Editor = 2,
}

export enum TerminalExitReason {
  Unknown = 0,
  Shutdown = 1,
  Process = 2,
  User = 3,
  Extension = 4,
}

export enum TaskScope {
  Global = 1,
  Workspace = 2,
}

export enum TaskRevealKind {
  Always = 1,
  Silent = 2,
  Never = 3,
}

export enum TaskPanelKind {
  Shared = 1,
  Dedicated = 2,
  New = 3,
}

export enum DebugConsoleMode {
  Separate = 0,
  MergeWithParent = 1,
}

export enum TestRunProfileKind {
  Run = 1,
  Debug = 2,
  Coverage = 3,
}

export enum CommentMode {
  Editing = 0,
  Preview = 1,
}

export enum CommentThreadCollapsibleState {
  Collapsed = 0,
  Expanded = 1,
}

export enum NotebookCellKind {
  Markup = 1,
  Code = 2,
}

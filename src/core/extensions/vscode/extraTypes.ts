// VS Code API types the `vscode` shim offers for extensions to construct and test with
// `instanceof` (tabs, inline values, snippet edits, terminal links and profiles, telemetry values,
// drag and drop, timeline, debug threads, chat and MCP parts) and proposed-API names that
// installed extensions use (ports, debug visualizations, verbose hovers, notebook variables,
// test results). Plain data classes as VS Code defines them. DOM-free.

import { Hover } from "./languageTypes";
import { type Position, Range, type Uri } from "./types";

// ---- Tabs (window.tabGroups) ----

export class TabInputText {
  constructor(readonly uri: Uri) {}
}
export class TabInputTextDiff {
  constructor(
    readonly original: Uri,
    readonly modified: Uri,
  ) {}
}
export class TabInputCustom {
  constructor(
    readonly uri: Uri,
    readonly viewType: string,
  ) {}
}
export class TabInputWebview {
  constructor(readonly viewType: string) {}
}
export class TabInputNotebook {
  constructor(
    readonly uri: Uri,
    readonly notebookType: string,
  ) {}
}
export class TabInputNotebookDiff {
  constructor(
    readonly original: Uri,
    readonly modified: Uri,
    readonly notebookType: string,
  ) {}
}
export class TabInputTerminal {}
/** Proposed (interactiveWindow). */
export class TabInputInteractiveWindow {
  constructor(
    readonly uri: Uri,
    readonly inputBoxUri: Uri,
  ) {}
}

// ---- Inline values (debugging) ----

export class InlineValueText {
  constructor(
    readonly range: unknown,
    readonly text: string,
  ) {}
}
export class InlineValueVariableLookup {
  constructor(
    readonly range: unknown,
    readonly variableName?: string,
    readonly caseSensitiveLookup = true,
  ) {}
}
export class InlineValueEvaluatableExpression {
  constructor(
    readonly range: unknown,
    readonly expression?: string,
  ) {}
}

// ---- Edits ----

export class SnippetTextEdit {
  keepWhitespace?: boolean;
  constructor(
    public range: unknown,
    public snippet: { value: string },
  ) {}
  static replace(range: unknown, snippet: { value: string }) {
    return new SnippetTextEdit(range, snippet);
  }
  static insert(position: Position, snippet: { value: string }) {
    // An empty Range at the position, as VS Code's (it was a plain pair: `range.isEmpty` failed).
    return new SnippetTextEdit(new Range(position, position), snippet);
  }
}

// ---- Terminals ----

export class TerminalLink {
  constructor(
    public startIndex: number,
    public length: number,
    public tooltip?: string,
  ) {}
}
export class TerminalProfile {
  constructor(public options: unknown) {}
}
export enum TerminalShellExecutionCommandLineConfidence {
  Low = 0,
  Medium = 1,
  High = 2,
}

// ---- Telemetry ----

export class TelemetryTrustedValue<T = unknown> {
  constructor(readonly value: T) {}
}

// ---- Drag and drop, paste ----

export class DataTransferItem {
  constructor(readonly value: unknown) {}
  asString(): Promise<string> {
    return Promise.resolve(
      typeof this.value === "string" ? this.value : JSON.stringify(this.value),
    );
  }
  asFile(): undefined {
    return undefined;
  }
}
export class DataTransfer {
  private readonly items = new Map<string, DataTransferItem>();
  get(mimeType: string): DataTransferItem | undefined {
    return this.items.get(mimeType.toLowerCase());
  }
  set(mimeType: string, value: DataTransferItem): void {
    this.items.set(mimeType.toLowerCase(), value);
  }
  forEach(
    callback: (item: DataTransferItem, mimeType: string, transfer: DataTransfer) => void,
    thisArg?: unknown,
  ): void {
    for (const [mime, item] of this.items) callback.call(thisArg, item, mime, this);
  }
  *[Symbol.iterator](): IterableIterator<[string, DataTransferItem]> {
    yield* this.items;
  }
}
export class DocumentDropOrPasteEditKind {
  static readonly Empty = new DocumentDropOrPasteEditKind("");
  static readonly Text = new DocumentDropOrPasteEditKind("text");
  static readonly TextUpdateImports = new DocumentDropOrPasteEditKind("text.updateImports");
  constructor(readonly value: string) {}
  append(...parts: string[]): DocumentDropOrPasteEditKind {
    return new DocumentDropOrPasteEditKind([this.value, ...parts].filter(Boolean).join("."));
  }
  intersects(other: DocumentDropOrPasteEditKind): boolean {
    return this.contains(other) || other.contains(this);
  }
  contains(other: DocumentDropOrPasteEditKind): boolean {
    return (
      this.value === "" || other.value === this.value || other.value.startsWith(`${this.value}.`)
    );
  }
}
export class DocumentDropEdit {
  constructor(
    public insertText: unknown,
    public title?: string,
    public kind?: DocumentDropOrPasteEditKind,
  ) {}
}
export class DocumentPasteEdit {
  constructor(
    public insertText: unknown,
    public title: string,
    public kind: DocumentDropOrPasteEditKind,
  ) {}
}

// ---- Timeline, debug ----

export class TimelineItem {
  label: string;
  resourceUri?: unknown;
  id?: string;
  description?: string;
  iconPath?: unknown;
  tooltip?: unknown;
  command?: unknown;
  contextValue?: string;
  accessibilityInformation?: unknown;

  /** VS Code's two constructors: a label, or the Uri of what the item is (named after it). */
  constructor(
    labelOrUri: string | { path?: unknown },
    public timestamp: number,
  ) {
    if (typeof labelOrUri === "string") this.label = labelOrUri;
    else {
      this.resourceUri = labelOrUri;
      const path = typeof labelOrUri?.path === "string" ? labelOrUri.path : "";
      this.label = path.slice(path.lastIndexOf("/") + 1);
    }
  }
}

/** Why a timeline is asked for (VS Code's TimelineTriggerKind). */
export enum TimelineTriggerKind {
  Invoke = 1,
  Automatic = 2,
}
export class DebugThread {
  constructor(
    readonly session: unknown,
    readonly threadId: number,
  ) {}
}
export class DebugStackFrame {
  constructor(
    readonly session: unknown,
    readonly threadId: number,
    readonly frameId: number,
  ) {}
}
/** Proposed (debugVisualization). */
export class DebugVisualization {
  iconPath?: unknown;
  visualization?: unknown;
  constructor(public name: string) {}
}

// ---- Language model, chat, MCP ----

export class LanguageModelDataPart {
  constructor(
    public data: Uint8Array,
    public mimeType: string,
  ) {}
  static image(data: Uint8Array, mimeType: string) {
    return new LanguageModelDataPart(data, mimeType);
  }
  static json(value: unknown, mimeType = "text/x-json") {
    return new LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(value)), mimeType);
  }
  static text(value: string, mimeType = "text/plain") {
    return new LanguageModelDataPart(new TextEncoder().encode(value), mimeType);
  }
}
export class ChatResponseFileTreePart {
  constructor(
    public value: unknown[],
    public baseUri: Uri,
  ) {}
}
export class ChatResponseAnchorPart {
  constructor(
    public value: unknown,
    public title?: string,
  ) {}
}
export class ChatResponseReferencePart {
  constructor(
    public value: unknown,
    public iconPath?: unknown,
  ) {}
}
export class ChatResponseCommandButtonPart {
  constructor(public value: unknown) {}
}
export class McpStdioServerDefinition {
  cwd?: Uri;
  constructor(
    public label: string,
    public command: string,
    public args: string[] = [],
    public env: Record<string, string | number | null> = {},
    public version?: string,
  ) {}
}
export class McpHttpServerDefinition {
  constructor(
    public label: string,
    public uri: Uri,
    public headers: Record<string, string> = {},
    public version?: string,
  ) {}
}

// ---- Enums ----

export enum InputBoxValidationSeverity {
  Info = 1,
  Warning = 2,
  Error = 3,
}
export enum SyntaxTokenType {
  Other = 0,
  Comment = 1,
  String = 2,
  RegEx = 3,
}

// ---- Proposed APIs installed extensions use ----

/** portsAttributes (debugpy, Jupyter: "don't offer to forward this port"). */
export enum PortAutoForwardAction {
  Notify = 1,
  OpenBrowser = 2,
  OpenPreview = 3,
  Silent = 4,
  Ignore = 5,
  OpenBrowserOnce = 6,
}
export class PortAttributes {
  constructor(public autoForwardAction: PortAutoForwardAction) {}
}
/** editorHoverVerbosityLevel (pyrefly). */
export enum HoverVerbosityAction {
  Increase = 0,
  Decrease = 1,
}
export class VerboseHover extends Hover {
  constructor(
    contents: ConstructorParameters<typeof Hover>[0],
    range?: ConstructorParameters<typeof Hover>[1],
    public canIncreaseVerbosity?: boolean,
    public canDecreaseVerbosity?: boolean,
  ) {
    super(contents, range);
  }
}
/** notebookVariableProvider (Jupyter). */
export enum NotebookVariablesRequestKind {
  Named = 1,
  Indexed = 2,
}
/** notebookMessaging (Jupyter). */
export class NotebookRendererScript {
  constructor(
    public uri: Uri,
    public provides: string | readonly string[] = [],
  ) {}
}
/** testObserver (Python). */
export enum TestResultState {
  Queued = 1,
  Running = 2,
  Passed = 3,
  Failed = 4,
  Skipped = 5,
  Errored = 6,
}

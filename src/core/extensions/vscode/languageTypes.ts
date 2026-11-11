// The `vscode` shim's language-feature classes (D256): what providers return in VS Code
// (CompletionItem, Hover, CodeAction, DocumentSymbol, SemanticTokens…), from its documented API.
// DOM-free.

import type {
  Location,
  MarkdownString,
  Position,
  Range,
  SnippetString,
  TextEdit,
  ThemeIcon,
  Uri,
  WorkspaceEdit,
} from "./types";

export interface Command {
  title: string;
  command: string;
  tooltip?: string;
  arguments?: unknown[];
}

export enum CompletionItemKind {
  Text = 0,
  Method = 1,
  Function = 2,
  Constructor = 3,
  Field = 4,
  Variable = 5,
  Class = 6,
  Interface = 7,
  Module = 8,
  Property = 9,
  Unit = 10,
  Value = 11,
  Enum = 12,
  Keyword = 13,
  Snippet = 14,
  Color = 15,
  File = 16,
  Reference = 17,
  Folder = 18,
  EnumMember = 19,
  Constant = 20,
  Struct = 21,
  Event = 22,
  Operator = 23,
  TypeParameter = 24,
  User = 25,
  Issue = 26,
}

export enum CompletionItemTag {
  Deprecated = 1,
}

export enum CompletionTriggerKind {
  Invoke = 0,
  TriggerCharacter = 1,
  TriggerForIncompleteCompletions = 2,
}

export enum InsertTextFormat {
  PlainText = 1,
  Snippet = 2,
}

export class CompletionItem {
  kind?: CompletionItemKind;
  tags?: CompletionItemTag[];
  detail?: string;
  documentation?: string | MarkdownString;
  sortText?: string;
  filterText?: string;
  preselect?: boolean;
  insertText?: string | SnippetString;
  range?: Range | { inserting: Range; replacing: Range };
  commitCharacters?: string[];
  keepWhitespace?: boolean;
  textEdit?: TextEdit;
  additionalTextEdits?: TextEdit[];
  command?: Command;

  constructor(
    public label: string | { label: string; detail?: string; description?: string },
    kind?: CompletionItemKind,
  ) {
    if (kind !== undefined) this.kind = kind;
  }
}

export class CompletionList {
  constructor(
    public items: CompletionItem[] = [],
    public isIncomplete = false,
  ) {}
}

export type MarkedString = string | { language: string; value: string } | MarkdownString;

export class Hover {
  contents: (MarkdownString | MarkedString)[];

  constructor(
    contents: MarkdownString | MarkedString | (MarkdownString | MarkedString)[],
    public range?: Range,
  ) {
    this.contents = Array.isArray(contents) ? contents : [contents];
  }
}

export class ParameterInformation {
  constructor(
    public label: string | [number, number],
    public documentation?: string | MarkdownString,
  ) {}
}

export class SignatureInformation {
  parameters: ParameterInformation[] = [];
  activeParameter?: number;

  constructor(
    public label: string,
    public documentation?: string | MarkdownString,
  ) {}
}

export class SignatureHelp {
  signatures: SignatureInformation[] = [];
  activeSignature = 0;
  activeParameter = 0;
}

export enum SignatureHelpTriggerKind {
  Invoke = 1,
  TriggerCharacter = 2,
  ContentChange = 3,
}

export enum SymbolKind {
  File = 0,
  Module = 1,
  Namespace = 2,
  Package = 3,
  Class = 4,
  Method = 5,
  Property = 6,
  Field = 7,
  Constructor = 8,
  Enum = 9,
  Interface = 10,
  Function = 11,
  Variable = 12,
  Constant = 13,
  String = 14,
  Number = 15,
  Boolean = 16,
  Array = 17,
  Object = 18,
  Key = 19,
  Null = 20,
  EnumMember = 21,
  Struct = 22,
  Event = 23,
  Operator = 24,
  TypeParameter = 25,
}

export enum SymbolTag {
  Deprecated = 1,
}

export class DocumentSymbol {
  children: DocumentSymbol[] = [];
  tags?: SymbolTag[];

  constructor(
    public name: string,
    public detail: string,
    public kind: SymbolKind,
    public range: Range,
    public selectionRange: Range,
  ) {}
}

export class SymbolInformation {
  location: Location;
  tags?: SymbolTag[];
  containerName = "";

  constructor(
    public name: string,
    public kind: SymbolKind,
    containerNameOrLocation: string | Location,
    location?: Location,
  ) {
    if (typeof containerNameOrLocation === "string") {
      this.containerName = containerNameOrLocation;
      this.location = location as Location;
    } else this.location = containerNameOrLocation;
  }
}

export class CodeActionKind {
  static readonly Empty = new CodeActionKind("");
  static readonly QuickFix = new CodeActionKind("quickfix");
  static readonly Refactor = new CodeActionKind("refactor");
  static readonly RefactorExtract = new CodeActionKind("refactor.extract");
  static readonly RefactorInline = new CodeActionKind("refactor.inline");
  static readonly RefactorMove = new CodeActionKind("refactor.move");
  static readonly RefactorRewrite = new CodeActionKind("refactor.rewrite");
  static readonly Source = new CodeActionKind("source");
  static readonly SourceOrganizeImports = new CodeActionKind("source.organizeImports");
  static readonly SourceFixAll = new CodeActionKind("source.fixAll");
  static readonly Notebook = new CodeActionKind("notebook");

  constructor(readonly value: string) {}

  append(part: string): CodeActionKind {
    return new CodeActionKind(this.value ? `${this.value}.${part}` : part);
  }
  intersects(other: CodeActionKind): boolean {
    return this.contains(other) || other.contains(this);
  }
  contains(other: CodeActionKind): boolean {
    return (
      this.value === "" || other.value === this.value || other.value.startsWith(`${this.value}.`)
    );
  }
}

export enum CodeActionTriggerKind {
  Invoke = 1,
  Automatic = 2,
}

export class CodeAction {
  edit?: WorkspaceEdit;
  diagnostics?: unknown[];
  command?: Command;
  isPreferred?: boolean;
  disabled?: { reason: string };

  constructor(
    public title: string,
    public kind?: CodeActionKind,
  ) {}
}

export class CodeLens {
  constructor(
    public range: Range,
    public command?: Command,
  ) {}

  get isResolved(): boolean {
    return !!this.command;
  }
}

export enum DocumentHighlightKind {
  Text = 0,
  Read = 1,
  Write = 2,
}

export class DocumentHighlight {
  constructor(
    public range: Range,
    public kind: DocumentHighlightKind = DocumentHighlightKind.Text,
  ) {}
}

export enum FoldingRangeKind {
  Comment = 1,
  Imports = 2,
  Region = 3,
}

export class FoldingRange {
  constructor(
    public start: number,
    public end: number,
    public kind?: FoldingRangeKind,
  ) {}
}

export class DocumentLink {
  tooltip?: string;

  constructor(
    public range: Range,
    public target?: Uri,
  ) {}
}

export class Color {
  constructor(
    readonly red: number,
    readonly green: number,
    readonly blue: number,
    readonly alpha: number,
  ) {}
}

export class ColorInformation {
  constructor(
    public range: Range,
    public color: Color,
  ) {}
}

export class ColorPresentation {
  textEdit?: TextEdit;
  additionalTextEdits?: TextEdit[];

  constructor(public label: string) {}
}

export enum InlayHintKind {
  Type = 1,
  Parameter = 2,
}

export class InlayHintLabelPart {
  tooltip?: string | MarkdownString;
  location?: Location;
  command?: Command;

  constructor(public value: string) {}
}

export class InlayHint {
  tooltip?: string | MarkdownString;
  textEdits?: TextEdit[];
  paddingLeft?: boolean;
  paddingRight?: boolean;

  constructor(
    public position: Position,
    public label: string | InlayHintLabelPart[],
    public kind?: InlayHintKind,
  ) {}
}

export class SemanticTokensLegend {
  constructor(
    readonly tokenTypes: string[],
    readonly tokenModifiers: string[] = [],
  ) {}
}

export class SemanticTokens {
  constructor(
    readonly data: Uint32Array,
    readonly resultId?: string,
  ) {}
}

export class SemanticTokensEdit {
  constructor(
    readonly start: number,
    readonly deleteCount: number,
    readonly data?: Uint32Array,
  ) {}
}

export class SemanticTokensEdits {
  constructor(
    readonly edits: SemanticTokensEdit[],
    readonly resultId?: string,
  ) {}
}

/** Builds VS Code's relative token encoding (5 numbers per token). */
export class SemanticTokensBuilder {
  private tokens: [number, number, number, number, number][] = [];

  constructor(private readonly legend?: SemanticTokensLegend) {}

  push(
    line: number,
    char: number,
    length: number,
    tokenType: number,
    tokenModifiers?: number,
  ): void;
  push(range: Range, tokenType: string, tokenModifiers?: readonly string[]): void;
  push(
    a: number | Range,
    b: number | string,
    c?: number | readonly string[],
    d?: number,
    e?: number,
  ): void {
    if (typeof a === "number") {
      this.tokens.push([a, b as number, (c as number) ?? 0, d ?? 0, e ?? 0]);
      return;
    }
    if (!this.legend) throw new Error("SemanticTokensBuilder needs a legend for push(range, type)");
    const type = this.legend.tokenTypes.indexOf(b as string);
    if (type < 0 || !a.isSingleLine) return;
    let mods = 0;
    for (const m of (c as readonly string[] | undefined) ?? []) {
      const i = this.legend.tokenModifiers.indexOf(m);
      if (i >= 0) mods |= 1 << i;
    }
    this.tokens.push([
      a.start.line,
      a.start.character,
      a.end.character - a.start.character,
      type,
      mods,
    ]);
  }

  build(resultId?: string): SemanticTokens {
    const sorted = [...this.tokens].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const data = new Uint32Array(sorted.length * 5);
    let line = 0;
    let char = 0;
    sorted.forEach(([l, ch, len, type, mods], i) => {
      data[i * 5] = l - line;
      data[i * 5 + 1] = l === line ? ch - char : ch;
      data[i * 5 + 2] = len;
      data[i * 5 + 3] = type;
      data[i * 5 + 4] = mods;
      line = l;
      char = ch;
    });
    return new SemanticTokens(data, resultId);
  }
}

export class SelectionRange {
  constructor(
    public range: Range,
    public parent?: SelectionRange,
  ) {}
}

export class CallHierarchyItem {
  detail?: string;
  tags?: SymbolTag[];
  data?: unknown;

  constructor(
    public kind: SymbolKind,
    public name: string,
    detail: string,
    public uri: Uri,
    public range: Range,
    public selectionRange: Range,
  ) {
    this.detail = detail;
  }
}

export class CallHierarchyIncomingCall {
  constructor(
    public from: CallHierarchyItem,
    public fromRanges: Range[],
  ) {}
}

export class CallHierarchyOutgoingCall {
  constructor(
    public to: CallHierarchyItem,
    public fromRanges: Range[],
  ) {}
}

export class TypeHierarchyItem extends CallHierarchyItem {}

export class InlineCompletionItem {
  filterText?: string;

  constructor(
    public insertText: string | SnippetString,
    public range?: Range,
    public command?: Command,
  ) {}
}

export class InlineCompletionList {
  constructor(public items: InlineCompletionItem[]) {}
}

export enum InlineCompletionTriggerKind {
  Invoke = 0,
  Automatic = 1,
}

export class EvaluatableExpression {
  constructor(
    public range: Range,
    public expression?: string,
  ) {}
}

export class LinkedEditingRanges {
  constructor(
    public ranges: Range[],
    public wordPattern?: RegExp,
  ) {}
}

export class TreeItem {
  id?: string;
  label?: string | { label: string; highlights?: [number, number][] };
  description?: string | boolean;
  tooltip?: string | MarkdownString;
  iconPath?: string | Uri | ThemeIcon | { light: string | Uri; dark: string | Uri };
  resourceUri?: Uri;
  command?: Command;
  contextValue?: string;
  checkboxState?: number | { state: number; tooltip?: string };
  accessibilityInformation?: { label: string; role?: string };
  collapsibleState?: number;

  constructor(labelOrUri: string | { label: string } | Uri, collapsibleState?: number) {
    if (
      typeof labelOrUri === "string" ||
      (labelOrUri && "label" in labelOrUri && !("scheme" in labelOrUri))
    )
      this.label = labelOrUri as string | { label: string };
    else this.resourceUri = labelOrUri as Uri;
    if (collapsibleState !== undefined) this.collapsibleState = collapsibleState;
  }
}

export enum LanguageStatusSeverity {
  Information = 0,
  Warning = 1,
  Error = 2,
}

export enum IndentAction {
  None = 0,
  Indent = 1,
  IndentOutdent = 2,
  Outdent = 3,
}

export enum DocumentPasteTriggerKind {
  Automatic = 0,
  PasteAs = 1,
}

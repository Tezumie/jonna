// The subset of LSP 3.17 types the client uses. Positions are 0-based, characters in UTF-16 code
// units (the default encoding, = JS string indices).

export interface Position {
  line: number;
  character: number;
}
export interface Range {
  start: Position;
  end: Position;
}
export interface Location {
  uri: string;
  range: Range;
}
export interface LocationLink {
  targetUri: string;
  targetRange: Range;
  targetSelectionRange: Range;
  originSelectionRange?: Range;
}
export interface TextEdit {
  range: Range;
  newText: string;
}
export interface Diagnostic {
  range: Range;
  severity?: 1 | 2 | 3 | 4;
  code?: string | number;
  source?: string;
  message: string;
  tags?: number[];
}
export interface MarkupContent {
  kind: "plaintext" | "markdown";
  value: string;
}
export type MarkedString = string | { language: string; value: string };
export interface Hover {
  contents: MarkupContent | MarkedString | MarkedString[];
  range?: Range;
}
export interface CompletionItem {
  label: string | { label: string };
  kind?: number;
  detail?: string;
  documentation?: string | MarkupContent;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  insertTextFormat?: 1 | 2;
  textEdit?: TextEdit | { newText: string; insert: Range; replace: Range };
  additionalTextEdits?: TextEdit[];
  commitCharacters?: string[];
  preselect?: boolean;
  deprecated?: boolean;
  tags?: number[];
  data?: unknown;
}
export interface CompletionList {
  isIncomplete: boolean;
  items: CompletionItem[];
}
export interface SignatureHelp {
  signatures: {
    label: string;
    documentation?: string | MarkupContent;
    parameters?: { label: string | [number, number]; documentation?: string | MarkupContent }[];
    activeParameter?: number;
  }[];
  activeSignature?: number;
  activeParameter?: number;
}
export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}
export interface SymbolInformation {
  name: string;
  kind: number;
  location: Location;
  containerName?: string;
}
export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: (
    | { textDocument: { uri: string; version?: number | null }; edits: TextEdit[] }
    | { kind: string }
  )[];
}

export interface ServerCapabilities {
  textDocumentSync?:
    | number
    | { openClose?: boolean; change?: number; save?: boolean | { includeText?: boolean } };
  completionProvider?: { triggerCharacters?: string[]; resolveProvider?: boolean };
  hoverProvider?: boolean | object;
  signatureHelpProvider?: { triggerCharacters?: string[]; retriggerCharacters?: string[] };
  definitionProvider?: boolean | object;
  typeDefinitionProvider?: boolean | object;
  implementationProvider?: boolean | object;
  referencesProvider?: boolean | object;
  documentHighlightProvider?: boolean | object;
  documentSymbolProvider?: boolean | object;
  documentFormattingProvider?: boolean | object;
  documentRangeFormattingProvider?: boolean | object;
  renameProvider?: boolean | { prepareProvider?: boolean };
  codeActionProvider?: boolean | { codeActionKinds?: string[]; resolveProvider?: boolean };
  workspaceSymbolProvider?: boolean | object;
  /** Multi-root support (D251): `changeNotifications` true (or a registration id) takes changes. */
  workspace?: {
    workspaceFolders?: { supported?: boolean; changeNotifications?: boolean | string };
  };
  codeLensProvider?: { resolveProvider?: boolean };
  inlayHintProvider?: boolean | { resolveProvider?: boolean };
  semanticTokensProvider?: {
    legend: { tokenTypes: string[]; tokenModifiers: string[] };
    full?: boolean | { delta?: boolean };
    range?: boolean;
  };
  foldingRangeProvider?: boolean | object;
  selectionRangeProvider?: boolean | object;
  declarationProvider?: boolean | object;
  documentLinkProvider?: { resolveProvider?: boolean };
  /** Pull diagnostics (LSP 3.17, D200): the client asks per document. */
  diagnosticProvider?: {
    identifier?: string;
    interFileDependencies?: boolean;
    /** The server answers workspace/diagnostic (D204). */
    workspaceDiagnostics?: boolean;
  };
  linkedEditingRangeProvider?: boolean | object;
  callHierarchyProvider?: boolean | object;
  typeHierarchyProvider?: boolean | object;
  colorProvider?: boolean | object;
  executeCommandProvider?: { commands?: string[] };
  [key: string]: unknown;
}

export interface Command {
  title: string;
  command: string;
  arguments?: unknown[];
}

export interface CodeAction {
  title: string;
  kind?: string;
  diagnostics?: Diagnostic[];
  isPreferred?: boolean;
  disabled?: { reason: string };
  edit?: WorkspaceEdit;
  command?: Command;
  data?: unknown;
}

export interface CodeLens {
  range: Range;
  command?: Command;
  data?: unknown;
}

export interface InlayHint {
  position: Position;
  label: string | { value: string; tooltip?: string | MarkupContent }[];
  kind?: number;
  tooltip?: string | MarkupContent;
  paddingLeft?: boolean;
  paddingRight?: boolean;
}

export interface FoldingRange {
  startLine: number;
  endLine: number;
  kind?: string;
}

export interface SelectionRange {
  range: Range;
  parent?: SelectionRange;
}

export interface DocumentLink {
  range: Range;
  target?: string;
  tooltip?: string;
}

/** $/progress values (work done progress). */
export interface WorkDoneProgress {
  kind: "begin" | "report" | "end";
  title?: string;
  message?: string;
  percentage?: number;
}

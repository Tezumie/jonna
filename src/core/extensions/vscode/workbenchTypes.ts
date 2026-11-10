// The `vscode` shim's classes for the debugger, tasks, tests, notebooks and chat (D257), from VS
// Code's documented API; the namespaces that take them are debug.ts, workbench.ts, testing.ts,
// notebooks.ts and chat.ts. DOM-free.

import type { Location, MarkdownString, Position, Range, Uri } from "./types";

// ---- Debugger ----

export class DebugAdapterExecutable {
  constructor(
    readonly command: string,
    readonly args: string[] = [],
    readonly options?: { cwd?: string; env?: Record<string, string> },
  ) {}
}

export class DebugAdapterServer {
  constructor(
    readonly port: number,
    readonly host?: string,
  ) {}
}

export class DebugAdapterNamedPipeServer {
  constructor(readonly path: string) {}
}

export class DebugAdapterInlineImplementation {
  constructor(
    readonly implementation: {
      handleMessage(message: unknown): void;
      onDidSendMessage: (listener: (message: unknown) => void) => { dispose(): unknown };
      dispose?(): unknown;
    },
  ) {}
}

let breakpointSeq = 0;

export class Breakpoint {
  readonly id: string;

  constructor(
    readonly enabled = true,
    readonly condition?: string,
    readonly hitCondition?: string,
    readonly logMessage?: string,
  ) {
    this.id = `bp${++breakpointSeq}`;
  }
}

export class SourceBreakpoint extends Breakpoint {
  constructor(
    readonly location: Location,
    enabled?: boolean,
    condition?: string,
    hitCondition?: string,
    logMessage?: string,
  ) {
    super(enabled, condition, hitCondition, logMessage);
  }
}

export class FunctionBreakpoint extends Breakpoint {
  constructor(
    readonly functionName: string,
    enabled?: boolean,
    condition?: string,
    hitCondition?: string,
    logMessage?: string,
  ) {
    super(enabled, condition, hitCondition, logMessage);
  }
}

export enum DebugConfigurationProviderTriggerKind {
  Initial = 1,
  Dynamic = 2,
}

// ---- Tasks ----

export class TaskGroup {
  static readonly Clean = new TaskGroup("clean", "Clean");
  static readonly Build = new TaskGroup("build", "Build");
  static readonly Rebuild = new TaskGroup("rebuild", "Rebuild");
  static readonly Test = new TaskGroup("test", "Test");
  isDefault?: boolean;

  constructor(
    readonly id: string,
    readonly label: string,
  ) {}
}

export enum ShellQuoting {
  Escape = 1,
  Strong = 2,
  Weak = 3,
}

type ShellArg = string | { value: string; quoting: ShellQuoting };

/** VS Code's ShellExecutionOptions: its own shell is `executable` with `shellArgs` (D261). */
export interface ShellExecutionOptions {
  cwd?: string;
  env?: Record<string, string>;
  executable?: string;
  shellArgs?: string[];
}

export class ShellExecution {
  readonly commandLine?: string;
  readonly command?: ShellArg;
  readonly args?: ShellArg[];
  readonly options?: ShellExecutionOptions;

  constructor(
    commandOrLine: ShellArg,
    argsOrOptions?: ShellArg[] | ShellExecutionOptions,
    options?: ShellExecutionOptions,
  ) {
    if (Array.isArray(argsOrOptions)) {
      this.command = commandOrLine;
      this.args = argsOrOptions;
      if (options) this.options = options;
    } else {
      this.commandLine = typeof commandOrLine === "string" ? commandOrLine : commandOrLine.value;
      if (argsOrOptions) this.options = argsOrOptions;
    }
  }
}

export class ProcessExecution {
  readonly args: string[];
  readonly options?: { cwd?: string; env?: Record<string, string> };

  constructor(
    readonly process: string,
    argsOrOptions?: string[] | { cwd?: string; env?: Record<string, string> },
    options?: { cwd?: string; env?: Record<string, string> },
  ) {
    this.args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    const o = Array.isArray(argsOrOptions) ? options : argsOrOptions;
    if (o) this.options = o;
  }
}

export class CustomExecution {
  constructor(
    readonly callback: (resolvedDefinition: Record<string, unknown>) => Promise<unknown> | unknown,
  ) {}
}

export class Task {
  definition: Record<string, unknown>;
  scope: unknown;
  name: string;
  source: string;
  execution?: ShellExecution | ProcessExecution | CustomExecution;
  problemMatchers: string[];
  isBackground = false;
  detail?: string;
  group?: TaskGroup;
  presentationOptions: {
    reveal?: number;
    focus?: boolean;
    panel?: number;
    clear?: boolean;
    close?: boolean;
    echo?: boolean;
    showReuseMessage?: boolean;
  } = {};
  runOptions: Record<string, unknown> = {};

  constructor(
    definition: Record<string, unknown>,
    scopeOrName: unknown,
    nameOrSource: string,
    sourceOrExecution?: string | ShellExecution | ProcessExecution | CustomExecution,
    executionOrMatchers?: ShellExecution | ProcessExecution | CustomExecution | string | string[],
    problemMatchers?: string | string[],
  ) {
    this.definition = definition;
    // The deprecated form: Task(definition, name, source, execution, problemMatchers).
    if (typeof scopeOrName === "string" && typeof sourceOrExecution !== "string") {
      this.scope = undefined;
      this.name = scopeOrName;
      this.source = nameOrSource;
      if (sourceOrExecution) this.execution = sourceOrExecution;
      this.problemMatchers = matcherList(executionOrMatchers as string | string[] | undefined);
      return;
    }
    this.scope = scopeOrName;
    this.name = nameOrSource;
    this.source = String(sourceOrExecution ?? "");
    if (
      executionOrMatchers &&
      typeof executionOrMatchers === "object" &&
      !Array.isArray(executionOrMatchers)
    )
      this.execution = executionOrMatchers;
    this.problemMatchers = matcherList(problemMatchers);
  }
}

function matcherList(v: string | string[] | undefined): string[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

// ---- Tests ----

export class TestTag {
  constructor(readonly id: string) {}
}

export class TestMessage {
  expectedOutput?: string;
  actualOutput?: string;
  location?: Location;
  contextValue?: string;

  constructor(public message: string | MarkdownString) {}

  static diff(message: string | MarkdownString, expected: string, actual: string): TestMessage {
    const m = new TestMessage(message);
    m.expectedOutput = expected;
    m.actualOutput = actual;
    return m;
  }
}

export class TestMessageStackFrame {
  constructor(
    public label: string,
    public uri?: Uri,
    public position?: Position,
  ) {}
}

export class TestRunRequest {
  constructor(
    readonly include?: readonly unknown[],
    readonly exclude?: readonly unknown[],
    readonly profile?: unknown,
    readonly continuous = false,
    readonly preserveFocus = true,
  ) {}
}

export class TestCoverageCount {
  constructor(
    public covered: number,
    public total: number,
  ) {}
}

export class FileCoverage {
  constructor(
    readonly uri: Uri,
    public statementCoverage: TestCoverageCount,
    public branchCoverage?: TestCoverageCount,
    public declarationCoverage?: TestCoverageCount,
    public includesTests?: unknown[],
  ) {}

  static fromDetails(uri: Uri, details: readonly unknown[]): FileCoverage {
    const statements = details.filter(
      (d): d is StatementCoverage => d instanceof StatementCoverage,
    );
    const covered = statements.filter((s) =>
      typeof s.executed === "number" ? s.executed > 0 : s.executed,
    ).length;
    const file = new FileCoverage(uri, new TestCoverageCount(covered, statements.length));
    (file as { details?: readonly unknown[] }).details = details;
    return file;
  }
}

export class StatementCoverage {
  constructor(
    public executed: number | boolean,
    public location: Position | Range,
    public branches: BranchCoverage[] = [],
  ) {}
}

export class BranchCoverage {
  constructor(
    public executed: number | boolean,
    public location?: Position | Range,
    public label?: string,
  ) {}
}

export class DeclarationCoverage {
  constructor(
    public name: string,
    public executed: number | boolean,
    public location: Position | Range,
  ) {}
}

// ---- Notebooks ----

export class NotebookCellOutputItem {
  constructor(
    readonly data: Uint8Array,
    readonly mime: string,
  ) {}

  static text(value: string, mime = "text/plain"): NotebookCellOutputItem {
    return new NotebookCellOutputItem(new TextEncoder().encode(value), mime);
  }
  static json(value: unknown, mime = "text/x-json"): NotebookCellOutputItem {
    return NotebookCellOutputItem.text(JSON.stringify(value, undefined, "\t"), mime);
  }
  static stdout(value: string): NotebookCellOutputItem {
    return NotebookCellOutputItem.text(value, "application/vnd.code.notebook.stdout");
  }
  static stderr(value: string): NotebookCellOutputItem {
    return NotebookCellOutputItem.text(value, "application/vnd.code.notebook.stderr");
  }
  static error(
    value: Error | { name: string; message: string; stack?: string },
  ): NotebookCellOutputItem {
    return NotebookCellOutputItem.text(
      JSON.stringify({ name: value.name, message: value.message, stack: value.stack }),
      "application/vnd.code.notebook.error",
    );
  }
}

export class NotebookCellOutput {
  readonly id: string;

  constructor(
    public items: NotebookCellOutputItem[],
    public metadata?: Record<string, unknown>,
  ) {
    this.id = `o${Math.random().toString(36).slice(2, 10)}`;
  }
}

export class NotebookCellData {
  outputs?: NotebookCellOutput[];
  metadata?: Record<string, unknown>;
  executionSummary?: { executionOrder?: number; success?: boolean };

  constructor(
    public kind: number,
    public value: string,
    public languageId: string,
  ) {}
}

export class NotebookData {
  metadata?: Record<string, unknown>;

  constructor(public cells: NotebookCellData[]) {}
}

export class NotebookRange {
  readonly start: number;
  readonly end: number;

  /** VS Code's checks: no negative bounds, and the two in order. */
  constructor(start: number, end: number) {
    if (start < 0 || end < 0) throw new Error("Illegal argument: start and end must be >= 0");
    this.start = Math.min(start, end);
    this.end = Math.max(start, end);
  }

  get isEmpty(): boolean {
    return this.start === this.end;
  }

  /** A copy with other bounds (VS Code's NotebookRange.with). */
  with(change: { start?: number; end?: number }): NotebookRange {
    const start = change.start ?? this.start;
    const end = change.end ?? this.end;
    return start === this.start && end === this.end ? this : new NotebookRange(start, end);
  }
}

/** VS Code's NotebookEdit (D261): built as VS Code builds them; the IDE doesn't apply them yet. */
export class NotebookEdit {
  newNotebookMetadata?: Record<string, unknown>;

  constructor(
    public range: NotebookRange,
    public newCells: NotebookCellData[],
  ) {}

  static replaceCells(range: NotebookRange, newCells: NotebookCellData[]): NotebookEdit {
    return new NotebookEdit(range, newCells);
  }

  static insertCells(index: number, newCells: NotebookCellData[]): NotebookEdit {
    return new NotebookEdit(new NotebookRange(index, index), newCells);
  }

  static deleteCells(range: NotebookRange): NotebookEdit {
    return new NotebookEdit(range, []);
  }

  static updateCellMetadata(index: number, newCellMetadata: Record<string, unknown>): NotebookEdit {
    const edit = new NotebookEdit(new NotebookRange(index, index + 1), []);
    (edit as { newCellMetadata?: Record<string, unknown> }).newCellMetadata = newCellMetadata;
    return edit;
  }

  static updateNotebookMetadata(newNotebookMetadata: Record<string, unknown>): NotebookEdit {
    const edit = new NotebookEdit(new NotebookRange(0, 0), []);
    edit.newNotebookMetadata = newNotebookMetadata;
    return edit;
  }
}

export class NotebookCellStatusBarItem {
  tooltip?: string;
  command?: string | { command: string; title: string; arguments?: unknown[] };

  constructor(
    public text: string,
    public alignment: number,
  ) {}
}

export enum NotebookCellStatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum NotebookControllerAffinity {
  Default = 1,
  Preferred = 2,
}

export enum NotebookEditorRevealType {
  Default = 0,
  InCenter = 1,
  InCenterIfOutsideViewport = 2,
  AtTop = 3,
}

// ---- Chat and language models ----

export enum LanguageModelChatMessageRole {
  User = 1,
  Assistant = 2,
}

export class LanguageModelTextPart {
  constructor(public value: string) {}
}

export class LanguageModelChatMessage {
  content: LanguageModelTextPart[];

  constructor(
    public role: LanguageModelChatMessageRole,
    content: string | readonly (LanguageModelTextPart | { value?: unknown })[],
    public name?: string,
  ) {
    // Parts stay what they are (tool calls and results, data); only plain `{ value }` objects
    // become text parts (every part used to become text, and tool calls were lost).
    this.content =
      typeof content === "string"
        ? [new LanguageModelTextPart(content)]
        : content.map((p) =>
            p && typeof p === "object" && Object.getPrototypeOf(p) !== Object.prototype
              ? (p as LanguageModelTextPart)
              : new LanguageModelTextPart(typeof p?.value === "string" ? p.value : ""),
          );
  }

  static User(
    content: string | readonly LanguageModelTextPart[],
    name?: string,
  ): LanguageModelChatMessage {
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.User, content, name);
  }
  static Assistant(
    content: string | readonly LanguageModelTextPart[],
    name?: string,
  ): LanguageModelChatMessage {
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, content, name);
  }
}

export class LanguageModelToolResult {
  constructor(public content: unknown[]) {}
}

export class LanguageModelPromptTsxPart {
  constructor(public value: unknown) {}
}

export class LanguageModelToolCallPart {
  constructor(
    public callId: string,
    public name: string,
    public input: unknown,
  ) {}
}

export class LanguageModelToolResultPart {
  constructor(
    public callId: string,
    public content: unknown[],
  ) {}
}

export enum LanguageModelChatToolMode {
  Auto = 1,
  Required = 2,
}

export class LanguageModelError extends Error {
  constructor(
    message?: string,
    readonly code = "Unknown",
  ) {
    super(message);
    this.name = "LanguageModelError";
  }
  static NoPermissions(message?: string): LanguageModelError {
    return new LanguageModelError(message, "NoPermissions");
  }
  static NotFound(message?: string): LanguageModelError {
    return new LanguageModelError(message, "NotFound");
  }
  static Blocked(message?: string): LanguageModelError {
    return new LanguageModelError(message, "Blocked");
  }
}

export class ChatResponseMarkdownPart {
  value: MarkdownString | string;
  constructor(value: string | MarkdownString) {
    this.value = value;
  }
}

export class ChatResponseProgressPart {
  constructor(public value: string) {}
}

export class ChatRequestTurn {
  constructor(
    readonly prompt: string,
    readonly command: string | undefined,
    readonly references: readonly unknown[],
    readonly participant: string,
  ) {}
}

export class ChatResponseTurn {
  constructor(
    readonly response: readonly unknown[],
    readonly result: unknown,
    readonly participant: string,
    readonly command?: string,
  ) {}
}

export enum ChatResultFeedbackKind {
  Unhelpful = 0,
  Helpful = 1,
}

// ---- File decorations (D258) ----

export class FileDecoration {
  propagate?: boolean;

  constructor(
    public badge?: string,
    public tooltip?: string,
    public color?: { id: string },
  ) {}
}

// ---- Comments and authentication ----

export enum CommentThreadState {
  Unresolved = 0,
  Resolved = 1,
}

export class AuthenticationSessionAccountInformationShim {
  constructor(
    readonly id: string,
    readonly label: string,
  ) {}
}

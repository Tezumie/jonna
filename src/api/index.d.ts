// Types for third-party extension authors (docs/extensions.md, D102). An extension's main file
// runs in a sandboxed worker with one global, `ide`; add
//   /// <reference path="path/to/index.d.ts" />
// (or copy this file) to get completions. It mirrors `WorkerApi` in src/core/extensions/rpc.ts.

declare namespace IdeExtension {
  interface Disposable {
    dispose(): void;
  }

  interface TreeItem {
    id: string;
    label: string;
    description?: string;
    tooltip?: string;
    /** An icon name from the IDE's icon set (listed in the extension template's README). */
    icon?: string;
    /** An image of yours instead (D258): a file in your folder, and one for dark themes. */
    iconPath?: string;
    iconPathDark?: string;
    /** Has children (asked for when the row expands). */
    collapsible?: boolean;
    /** Runs when the row is clicked (as the extension: permissions apply). */
    command?: { id: string; input?: unknown };
    /** The label in bold (unread, new, current). */
    strong?: boolean;
    /** Up to 4 buttons shown on hover at the row's end; each runs its command (as the extension). */
    actions?: { icon: string; title: string; command: { id: string; input?: unknown } }[];
    /**
     * Its kind for `menus["view/item/context"]`: their `when` tests it as `viewItem`
     * ("viewItem == task"). A menu item runs its command with `{ item: { id, label, view,
     * contextValue?, description? } }`.
     */
    contextValue?: string;
    /** A checkbox before the label (VS Code's TreeItemCheckboxState: Unchecked 0, Checked 1). */
    checkboxState?: "checked" | "unchecked" | 0 | 1 | boolean;
  }

  /** `ide.ui.createOutputChannel(name)`: the extension's own channel in the Output tab. */
  interface OutputChannel {
    readonly name: string;
    /** Text; a newline ends a line (text after the last one waits for the rest of its line). */
    append(text: string): void;
    appendLine(text: string): void;
    /** Clears the channel, then appends `text`. */
    replace(text: string): void;
    clear(): void;
    /** Opens the Output tab on this channel. */
    show(preserveFocus?: boolean): void;
    hide(): void;
    /** A line at that level (log.level, default info, hides trace and debug). */
    trace(message: string, ...args: unknown[]): void;
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string | Error, ...args: unknown[]): void;
    /** Stops writing to it; its lines stay in the Output tab for the session. */
    dispose(): void;
  }

  /** Text before a line's code (`ide.editor.setLineAnnotations`): a blame gutter's "Ann   3 d". */
  interface LineAnnotation {
    /** 1-based. */
    line: number;
    /** Plain text, 80 characters at most. Give every line the same width so the code stays aligned. */
    text: string;
    /** How much it stands out: 0 (the accent color) to 4 (faint, the default). */
    tone?: number;
    /** Plain text shown when the pointer is on it. */
    hover?: string;
  }

  /** Every `ide.git` call may name a repository: its root, folder-relative path or folder name. */
  interface GitRepositoryOption {
    repository?: string;
  }

  interface GitRepository {
    root: string;
    name: string;
    kind: "workspace" | "submodule" | "nested" | string;
    /** The one Source control shows (and calls without `repository` use). */
    selected: boolean;
    branch: string | null;
  }

  interface GitBlameHunk {
    /** 1-based lines start..end (inclusive) last changed by `commit`. */
    start: number;
    end: number;
    commit: {
      hash: string;
      author: string;
      authorMail: string;
      /** Seconds since the epoch. */
      time: number;
      summary: string;
      /** Not committed yet (the editor's unsaved or uncommitted lines). */
      uncommitted: boolean;
      /** The file's path in that commit. */
      filename: string;
      previous: string | null;
    };
  }

  interface GitLineLogEntry {
    hash: string;
    parents: string[];
    author: string;
    email: string;
    time: number;
    subject: string;
    /** The file's repository-relative path in that commit. */
    path: string | null;
    /** What the commit changed in those lines (diff hunks). */
    diff: string;
    added: number;
    removed: number;
  }

  interface GitChangedFile {
    /** "A", "M", "D", "R"… */
    status: string;
    /** Repository-relative, with "/". */
    path: string;
    origPath: string | null;
  }

  interface GitHubNotification {
    id: string;
    unread: boolean;
    reason: string;
    updated_at: string;
    subject: { title: string; type: string; url: string | null };
    repository: { full_name: string; html_url: string };
  }

  interface TreeProvider {
    getChildren(parent?: TreeItem): TreeItem[] | Promise<TreeItem[]>;
    /** Rows dragged onto a row of the view (`target` undefined: below the rows). */
    handleDrop?(target: TreeItem | undefined, sources: TreeItem[]): unknown;
    /** VS Code's TreeDragAndDropController (its handleDrop takes the rows, not a DataTransfer). */
    dragAndDropController?: {
      handleDrop(target: TreeItem | undefined, sources: TreeItem[]): unknown;
    };
    onDidChangeCheckboxState?(changes: { item: TreeItem; checked: boolean }[]): unknown;
  }

  /** A link to the IDE for an extension (`<ide.env.uriScheme>://<extension id>/path?query#fragment`). */
  interface Uri {
    scheme: string;
    authority: string;
    path: string;
    /** Still encoded: `new URLSearchParams(uri.query)`. */
    query: string;
    fragment: string;
    text: string;
    toString(): string;
  }

  /** A folder of the open workspace (VS Code's WorkspaceFolder, with a path for its uri). */
  interface WorkspaceFolder {
    /** Absolute. */
    readonly path: string;
    /** The name the workspace shows for it (a multi-root workspace file can rename folders). */
    readonly name: string;
    /** Its place: 0 is the first folder (the primary, what `root()` returns). */
    readonly index: number;
  }

  /** Folders added to or taken out of the workspace (not when it opens or closes). */
  interface WorkspaceFoldersChangeEvent {
    readonly added: readonly WorkspaceFolder[];
    readonly removed: readonly WorkspaceFolder[];
  }

  /**
   * VS Code's RelativePattern, as a plain object: `pattern` is matched against paths relative to
   * `base` (a WorkspaceFolder, or any absolute folder path).
   */
  interface RelativePattern {
    base: string | { path: string };
    pattern: string;
  }

  /** VS Code's WorkspaceEdit: operations applied in the order they're added. */
  interface WorkspaceEdit {
    replace(path: string, range: TextRange, text: string): void;
    insert(path: string, position: { line: number; column: number }, text: string): void;
    delete(path: string, range: TextRange): void;
    set(path: string, edits: (TextRange & { text: string })[]): void;
    createFile(
      path: string,
      options?: { overwrite?: boolean; ignoreIfExists?: boolean; contents?: string },
    ): void;
    renameFile(
      from: string,
      to: string,
      options?: { overwrite?: boolean; ignoreIfExists?: boolean },
    ): void;
    /** The user confirms; it goes to the app's trash. */
    deleteFile(path: string, options?: { recursive?: boolean; ignoreIfNotExists?: boolean }): void;
    readonly size: number;
  }

  interface WillSaveEvent {
    path: string;
    /** The file's language, or the notebook's type. */
    languageId: string;
    reason: "manual" | "afterDelay" | "focusOut";
    /** Call while handling the event; a text file's promise may resolve with edits (`TextEdit[]`). 1.5 s. */
    waitUntil(thenable: unknown): void;
  }

  interface Comment {
    /** Markdown, or VS Code's MarkdownString. */
    body: string | { value: string };
    author: { name: string };
    label?: string;
    timestamp?: Date | number;
    /** VS Code's CommentReaction (D255): an emoji or short label, how many, whether you're one. */
    reactions?: { label: string; count?: number; authorHasReacted?: boolean }[];
  }

  interface CommentThread extends Disposable {
    readonly id: string;
    readonly path: string;
    range: TextRange;
    comments: readonly Comment[];
    /** VS Code's CommentThreadCollapsibleState: Collapsed 0, Expanded 1. */
    collapsibleState: "collapsed" | "expanded" | 0 | 1;
    label?: string;
    canReply: boolean;
    contextValue?: string;
    state?: "resolved" | "unresolved" | 0 | 1;
  }

  interface CommentController extends Disposable {
    readonly id: string;
    readonly label: string;
    commentingRangeProvider?: {
      provideCommentingRanges(document: { path: string; languageId: string }): Answer<TextRange[]>;
    };
    /** Replies, and the first comment of a thread the user starts on a line it allows. */
    replyHandler?: (reply: { thread: CommentThread; text: string }) => unknown;
    /** The user picked one of a comment's reactions (D255): toggle theirs, update `reactions`. */
    reactionHandler?: (
      comment: Comment,
      reaction: { label: string; count?: number; authorHasReacted?: boolean },
    ) => unknown;
    /** The user edited a comment in place (D255): change its `body` (and the thread's comments). */
    editHandler?: (edit: { thread: CommentThread; comment: Comment; text: string }) => unknown;
    createCommentThread(
      path: string,
      range: TextRange,
      comments: readonly Comment[],
    ): CommentThread;
  }

  interface LanguageModelChatMessage {
    role: "user" | "assistant";
    content: string;
  }

  interface LanguageModelChat {
    readonly id: string;
    readonly name: string;
    readonly vendor: string;
    readonly family: string;
    readonly version: string;
    readonly maxInputTokens: number;
    /** Rejects when language model access is off or the user didn't allow the extension. */
    sendRequest(
      messages: readonly LanguageModelChatMessage[],
      options?: { justification?: string },
      token?: CancellationToken,
    ): Promise<{ text: AsyncIterable<string>; stream: AsyncIterable<{ value: string }> }>;
    countTokens(text: string | LanguageModelChatMessage): Promise<number>;
  }

  interface ChatResponseStream {
    markdown(value: string | { value: string }): void;
    progress(value: string): void;
    reference(value: unknown): void;
    anchor(value: unknown, title?: string): void;
    button(command: { title?: string; command?: string }): void;
  }

  /** 1-based lines and columns, end column exclusive; no columns: whole lines. */
  interface TextRange {
    startLine: number;
    startColumn?: number;
    endLine?: number;
    endColumn?: number;
  }

  /** An item of a call or type hierarchy (VS Code's CallHierarchyItem / TypeHierarchyItem). */
  interface HierarchyItem {
    name: string;
    /** "function", "method", "class", "interface"… (default "function"). */
    kind?: string;
    detail?: string;
    /** A file of the folder. */
    path: string;
    range: TextRange;
    /** Where its name is (default: the range). */
    selectionRange?: TextRange;
    /** Yours: given back when you're asked about the item (JSON, at most 10 KB). */
    data?: unknown;
  }

  /** A call into (`from`) or out of (`to`) an item, and the call sites in the calling item. */
  interface HierarchyCall {
    from?: HierarchyItem;
    to?: HierarchyItem;
    fromRanges: TextRange[];
  }

  /** VS Code's SelectionRange: a range and the one around it. */
  interface SelectionRange {
    range: TextRange;
    parent?: SelectionRange;
  }

  interface StatusBarItemOptions {
    /** Unique within the extension; setting it again updates the item. */
    id: string;
    /** Text, with `$(icon-name)` for an icon of the IDE's set. */
    text: string;
    tooltip?: string;
    /** One of the extension's own commands, run on click. */
    command?: string;
    input?: unknown;
    alignment?: "left" | "right";
    /** Higher: closer to the edge. */
    priority?: number;
    /** What the item is (VS Code's StatusBarItem.name), for screen readers. */
    name?: string;
    /**
     * Needs attention: a warning or error background (VS Code's statusBarItem.warningBackground /
     * errorBackground), or the text alone in that color.
     */
    tone?: "warning" | "error" | "warning-text" | "error-text";
  }

  interface Diagnostic {
    line: number;
    column?: number;
    endLine?: number;
    endColumn?: number;
    message: string;
    /** "hint": shown faintly in the editor (three dots), not in Problems (VS Code's Hint). */
    severity?: "error" | "warning" | "info" | "hint";
    code?: string;
    /** A web page about the code (VS Code's `code.target`): the code shows as its link. */
    codeTarget?: string;
    /** Who reports it ("pyright", "eslint"; default: the extension's name). */
    source?: string;
    /** "unnecessary": drawn faded (unused code); "deprecated": struck through. */
    tags?: ("unnecessary" | "deprecated")[];
    /** Other places that explain it (VS Code's relatedInformation). */
    relatedInformation?: (TextRange & { path: string; message: string })[];
  }

  /** A hover's Markdown and the range it highlights (1-based, end column exclusive). */
  interface HoverWithRange {
    contents: string;
    range?: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  }

  /**
   * A provider's second argument (VS Code's CancellationToken): it fires when the editor no
   * longer needs the answer (the user typed on, moved away, or the request was replaced). There
   * are no time limits: a provider may take as long as it needs and stop when this fires.
   */
  interface CallToken {
    readonly isCancellationRequested: boolean;
    onCancellationRequested(listener: () => void): Disposable;
  }

  /** The notebook cell a provider is asked about (VS Code's `vscode-notebook-cell:` documents). */
  interface CellOfNotebook {
    /** The notebook file. */
    notebook: string;
    id: string;
    /** The cell's text now. */
    text: string;
  }

  /**
   * What a hover or completion provider is asked about (1-based). Providers are asked about the
   * folder's files and any document open in the editor: untitled ones, files elsewhere on disk
   * and notebook cells (`cell`; `path` is then the cell's own name in the editor).
   */
  interface ProviderContext {
    path: string;
    languageId: string;
    line: number;
    column: number;
    /** The word at the position ("" between words). */
    word: string;
    /** The line's text before the position. */
    linePrefix: string;
    cell?: CellOfNotebook;
  }

  /** How a completion provider was asked (VS Code's CompletionContext), with its context. */
  interface CompletionContext {
    /** "incomplete": typing on after a list that said `isIncomplete`. */
    triggerKind?: "invoke" | "triggerCharacter" | "incomplete";
    triggerCharacter?: string;
  }

  /** What a whole-document provider is asked about (symbols, code lens, semantic tokens). */
  interface DocumentContext {
    path: string;
    languageId: string;
    cell?: CellOfNotebook;
  }

  /** A range with every field set (1-based; end column exclusive). */
  interface FullRange {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  }

  interface FormattingContext extends DocumentContext {
    tabSize: number;
    insertSpaces: boolean;
  }

  interface CodeActionContext extends DocumentContext {
    range: FullRange;
    /** The problems (any source's) in the range. */
    diagnostics: (FullRange & {
      message: string;
      severity: "error" | "warning" | "info" | "hint";
      source?: string;
      code?: string;
    })[];
    /** The kind asked for ("quickfix", "source.organizeImports"…), if any. */
    only?: string;
  }

  /** A place in a file (in the open folder; relative or absolute). */
  type Location = TextRange & { path: string };

  type TextEdit = TextRange & { text: string };

  /** An edit in any file of the folder (default: the one asked about). */
  type FileEdit = TextEdit & { path?: string };

  interface CodeAction {
    title: string;
    kind?: string;
    isPreferred?: boolean;
    edits?: FileEdit[];
    /** One of the extension's own commands, run when chosen (after the edits). */
    command?: string;
    input?: unknown;
  }

  interface SignatureHelp {
    signatures: {
      label: string;
      documentation?: string;
      parameters?: (string | { label: string | [number, number]; documentation?: string })[];
    }[];
    activeSignature?: number;
    activeParameter?: number;
  }

  interface DocumentSymbol extends TextRange {
    name: string;
    detail?: string;
    /** LSP's names: "class", "function", "method", "variable", "constant", "enumMember"… */
    kind: string;
    selectionRange?: TextRange;
    children?: DocumentSymbol[];
  }

  /** Where a rename applies: a range (its own fields, or `range`) and the box's starting text. */
  type RenameLocation = (TextRange | { range: TextRange }) & { placeholder?: string };

  /** The lens shows above the range's first line; the whole range is kept. */
  interface CodeLens extends TextRange {
    title: string;
    /** One of the extension's own commands, run on click. */
    command?: string;
    input?: unknown;
  }

  interface InlayHint {
    line: number;
    column: number;
    /** Its text, or parts that each may go somewhere (Ctrl+click), run a command or explain. */
    label: string | InlayHintLabelPart[];
    kind?: "type" | "parameter";
    tooltip?: string;
    paddingLeft?: boolean;
    paddingRight?: boolean;
    /** Edits made when the hint is double-clicked (VS Code's textEdits: "insert this type"). */
    textEdits?: TextEdit[];
    /** Yours: with `resolve` registered, the hint is completed (tooltip…) when hovered. */
    resolveId?: string;
  }

  interface InlayHintLabelPart {
    value: string;
    tooltip?: string;
    /** Where Ctrl+click on the part goes (a type's definition). */
    location?: Location;
    /** One of the extension's own commands, run on click. */
    command?: string;
    input?: unknown;
  }

  /**
   * What the debugger shows after a line while paused (VS Code's InlineValue): text as it is, a
   * variable looked up in the stopped frame's scopes (default name: the range's text), or an
   * expression evaluated there (default: the range's text).
   */
  type InlineValue =
    | { kind: "text"; range: TextRange; text: string }
    | { kind: "variable"; range: TextRange; name?: string; caseSensitive?: boolean }
    | { kind: "expression"; range: TextRange; expression?: string };

  interface SemanticToken {
    line: number;
    column: number;
    length: number;
    /** One of the legend's tokenTypes. */
    type: string;
    modifiers?: string[];
  }

  type Answer<T> = T | null | undefined | Promise<T | null | undefined>;

  interface ProgressOptions {
    location?: "notification" | "window";
    title?: string;
    cancellable?: boolean;
  }

  interface Progress {
    /** `increment`: percent of the whole done since the last report (they add up to 100). */
    report(value: { message?: string; increment?: number }): void;
  }

  interface CancellationToken {
    readonly isCancellationRequested: boolean;
    onCancellationRequested(listener: () => void): Disposable;
  }

  /** VS Code's CompletionItemKind names (its icon in the list). */
  type CompletionKind =
    | "text"
    | "method"
    | "function"
    | "constructor"
    | "field"
    | "variable"
    | "class"
    | "interface"
    | "module"
    | "property"
    | "unit"
    | "value"
    | "enum"
    | "keyword"
    | "snippet"
    | "color"
    | "file"
    | "reference"
    | "folder"
    | "enumMember"
    | "constant"
    | "struct"
    | "event"
    | "operator"
    | "typeParameter"
    | "user"
    | "issue";

  interface CompletionItem {
    label: string;
    /** Faint text right after the label (a signature) and at the row's end (a module). */
    labelDetail?: string;
    labelDescription?: string;
    /** Default: the label. */
    insertText?: string;
    /** `insertText` is a snippet (`${1:name}`; also implied by kind "snippet"). */
    snippet?: boolean;
    detail?: string;
    /** Markdown. */
    documentation?: string;
    kind?: CompletionKind;
    /** Drawn struck through (VS Code's CompletionItemTag.Deprecated). */
    deprecated?: boolean;
    /**
     * What it replaces (default: the word at the cursor), 1-based, on the cursor's line. With
     * `replaceRange`, `range` is what's replaced on insert and `replaceRange` on replace (VS
     * Code's { inserting, replacing }; editor.suggest.insertMode picks).
     */
    range?: TextRange;
    replaceRange?: TextRange;
    sortText?: string;
    filterText?: string;
    preselect?: boolean;
    /** Typing one of these accepts the item first (VS Code's commitCharacters). */
    commitCharacters?: string[];
    /** Edits elsewhere made with it (an auto-import), 1-based. */
    additionalTextEdits?: TextEdit[];
    /**
     * Run after it's inserted: one of the extension's own commands, or the editor's
     * "editor.action.triggerSuggest" / "editor.action.triggerParameterHints".
     */
    command?: string;
    input?: unknown;
    /** Yours: with `resolve` registered, the item is completed (documentation…) when selected. */
    resolveId?: string;
  }

  /**
   * Completions with `isIncomplete`: typing on asks the provider again instead of filtering this
   * list (VS Code's CompletionList).
   */
  interface CompletionList {
    items: CompletionItem[];
    isIncomplete?: boolean;
  }

  /** Who ran a command (its handler's second argument). */
  interface CommandContext {
    caller: "user" | "agent" | "extension" | "other";
  }

  interface SpawnOptions {
    /** A program on PATH or an absolute path (`${ide.extension.path}/kernel.js` with "node"…). */
    command: string;
    args?: string[];
    /**
     * Default: the open folder (the first one). Inside one of the workspace's folders (relative
     * or absolute) or inside the extension's folder.
     */
    cwd?: string;
    /** Added to the IDE's environment. */
    env?: Record<string, string>;
    /** "lines" (default): each stdout line arrives as a string. "ndjson": as parsed JSON (a line that isn't JSON arrives as its text). */
    framing?: "lines" | "ndjson";
  }

  interface ProcessHandle {
    readonly id: string;
    /** "lines": text, a line each (several for a multi-line string). "ndjson": a value sent as one JSON line. */
    send(data: string | object): Promise<void>;
    /** Output written before the first listener was added is delivered to it (up to 1000 lines). */
    onMessage(listener: (message: unknown) => void): Disposable;
    onStderr(listener: (line: string) => void): Disposable;
    /** `signal` is "SIGKILL" when kill() or the IDE ended it. */
    onExit(listener: (code: number | null, signal?: string) => void): Disposable;
    kill(): Promise<void>;
    /** Closes its input: it reads end-of-file. */
    closeStdin(): Promise<void>;
    /** Ctrl+C (SIGINT; on Windows a Ctrl+C on the program's console). Rejects if it can't be sent. */
    interrupt(): Promise<void>;
  }

  interface QuickPickItem {
    label: string;
    description?: string;
    /** An icon of the IDE's set ("zap"). */
    icon?: string;
    /** More about it: shown as the row's tooltip. */
    detail?: string;
    /** Starts a group: a line above the item with this name (VS Code's separators, D234). */
    separator?: string;
    /** Checked at first (`canPickMany`). */
    picked?: boolean;
  }

  /** The editor tabs ("tabs.didChange" events): VS Code's window.tabGroups as data. */
  interface TabsSnapshot {
    groups: {
      id: string;
      /** 1-based, in the order the groups are laid out (VS Code's ViewColumn). */
      viewColumn: number;
      isActive: boolean;
      tabs: {
        /** For `ide.ui.closeTabs`. */
        id: string;
        label: string;
        kind: "text" | "textDiff" | "custom" | "webview" | "notebook" | "terminal" | "other";
        /** A path or a URI ("scheme:…"): the file of text, custom and notebook tabs. */
        uri?: string;
        /** A diff's sides. */
        original?: string;
        modified?: string;
        /** A custom editor's or a webview panel's type. */
        viewType?: string;
        isActive: boolean;
        isDirty: boolean;
        isPreview: boolean;
        isPinned: boolean;
      }[];
    }[];
  }

  /** A title bar or row button of a live quick input: an icon of the IDE's set. */
  interface QuickInputButton {
    icon?: string;
    tooltip?: string;
    /** VS Code's QuickInputButtons.Back (drawn at the title's left). */
    back?: boolean;
  }

  /** A row of a live quick pick (`ide.ui.quickInput`). */
  interface QuickInputItem {
    label: string;
    description?: string;
    detail?: string;
    icon?: string;
    /** Starts a group: a line above the row with this name. */
    separator?: string;
    /** Shown whatever is typed. */
    alwaysShow?: boolean;
    buttons?: QuickInputButton[];
  }

  /** A live quick input's properties (VS Code's QuickPick / InputBox); send the changed ones. */
  interface QuickInputProps {
    title?: string;
    step?: number;
    totalSteps?: number;
    buttons?: QuickInputButton[];
    placeholder?: string;
    prompt?: string;
    value?: string;
    valueSelection?: [number, number];
    password?: boolean;
    items?: QuickInputItem[];
    activeIndexes?: number[];
    selectedIndexes?: number[];
    canSelectMany?: boolean;
    matchOnDescription?: boolean;
    matchOnDetail?: boolean;
    sortByLabel?: boolean;
    keepScrollPosition?: boolean;
    /** A progress line while you fill it. */
    busy?: boolean;
    enabled?: boolean;
    /** Stays open when it loses the focus. */
    ignoreFocusOut?: boolean;
    /** Shown under the box; only "error" holds Enter back. null clears it. */
    validation?: { message: string; severity: "info" | "warning" | "error" } | null;
  }

  /** What the user did in a live quick input (indexes are positions in the last `items` sent). */
  type QuickInputEvent =
    | { kind: "value"; value: string }
    | { kind: "active"; indexes: number[] }
    | { kind: "selection"; indexes: number[] }
    | { kind: "accept" }
    | { kind: "button"; index: number }
    | { kind: "itemButton"; item: number; button: number }
    | { kind: "hide" };

  interface QuickInputHandle {
    readonly id: string;
    /** Sends changed properties (merged and sent once per turn). */
    update(props: QuickInputProps): void;
    /** Closes it; the "hide" event follows. */
    hide(): void;
    /** True once "hide" was reported. */
    readonly hidden: boolean;
  }

  interface FetchResponse {
    status: number;
    ok: boolean;
    headers: Record<string, string>;
    text(): string;
    json(): unknown;
  }

  /** A notebook as `ide.notebooks` serializers read and write it (cells in Jupyter's terms). */
  interface NotebookData {
    cells: {
      id?: string;
      kind: "code" | "markdown" | "raw";
      source: string;
      metadata?: Record<string, unknown>;
      /** nbformat outputs: { output_type: "stream" | "display_data" | "execute_result" | "error", … }. */
      outputs?: Record<string, unknown>[];
      executionCount?: number | null;
      /** Your format's own fields the editor doesn't use: given back to serialize() as they were. */
      extra?: Record<string, unknown>;
    }[];
    metadata?: Record<string, unknown>;
    /** Your format's own fields the editor doesn't use: given back to serialize() as they were. */
    extra?: Record<string, unknown>;
  }

  /**
   * What a kernel sends while a cell runs: `stream` { name: "stdout" | "stderr", text },
   * `display` / `result` { data: a mime bundle ("text/plain", "text/html", "image/png" base64…),
   * metadata?, count? }, `update_display` { transient: { display_id }, data }, `error` { ename,
   * evalue, traceback }, `clear` { wait? }.
   */
  interface KernelEvent {
    type: string;
    [key: string]: unknown;
  }

  interface KernelOption {
    id: string;
    label: string;
    detail?: string;
    /** Its cells' language ("python"). */
    language?: string;
    /** Every language it runs (VS Code's supportedLanguages): first in a cell's language picker. */
    languages?: string[];
    /** Your own data for starting it (JSON). */
    data?: unknown;
  }

  /** The cell a kernel runs (D204). */
  interface ExecutingCell {
    id: string;
    index: number;
    /** The cell's own language (metadata.vscode.languageId) or the notebook's. */
    language: string;
    metadata: Record<string, unknown>;
  }

  /** An item in a cell's status row (D204). */
  interface CellStatusItem {
    text: string;
    tooltip?: string;
    /** One of your commands, run with { path, cellId }. */
    command?: string;
    alignment?: "left" | "right";
  }

  interface CellStatusContext {
    path: string;
    notebookType: string;
    cell: {
      id: string;
      index: number;
      kind: string;
      language: string;
      source: string;
      metadata: Record<string, unknown>;
      executionCount: number | null;
      outputs: number;
    };
  }

  interface KernelContext {
    /** The open folder, the notebook file and its type. */
    root: string;
    path: string;
    notebookType: string;
    cwd?: string;
  }

  interface Kernel {
    /**
     * Runs a cell: send outputs with `run.emit` (as they come: they stream into the cell),
     * clear them with `run.clear` (`wait`: when the next output comes), ask the user with
     * `run.input`; `run.cell` is the cell (D204).
     */
    execute(
      code: string,
      run: {
        cell?: ExecutingCell;
        emit(event: KernelEvent): void;
        clear(options?: { wait?: boolean }): void;
        input(prompt: string, options?: { password?: boolean }): Promise<string>;
      },
    ): Promise<{ status?: "ok" | "error" | "aborted"; count?: number | null }>;
    interrupt?(): void | Promise<void>;
    restart?(): void | Promise<void>;
    shutdown?(): void | Promise<void>;
    complete?(
      code: string,
      cursor: number,
    ):
      | { matches: string[]; start: number; end: number }
      | null
      | Promise<{
          matches: string[];
          start: number;
          end: number;
        } | null>;
    inspect?(code: string, cursor: number): string | Promise<string>;
    variables?():
      | { name: string; type: string; value: string; size: string }[]
      | null
      | Promise<{ name: string; type: string; value: string; size: string }[] | null>;
    /** Jupyter widget messages from the page to the kernel. */
    comm?(
      kind: "comm_msg" | "comm_close",
      commId: string,
      data: unknown,
      metadata: unknown,
      buffers: string[],
    ): boolean | Promise<boolean>;
    /**
     * A message from the notebook's output page (a renderer preload's postKernelMessage, D295):
     * only for sources registered with `messaging`.
     */
    message?(message: unknown): void;
  }

  interface KernelHost {
    setStatus(status: "starting" | "idle" | "busy" | "dead"): void;
    /** `mode: "jupyter"`: a Jupyter kernel (widgets are live; `kernel` is its kernelspec name). */
    setInfo(info: { display?: string; language?: string; kernel?: string; mode?: "jupyter" }): void;
    /** Outputs that belong to no running cell (with `parent` for a widget's). */
    emit(event: KernelEvent): void;
    comm(message: {
      kind: "comm_open" | "comm_msg" | "comm_close";
      content: { comm_id: string } & Record<string, unknown>;
    }): void;
    /** The kernel ended by itself. */
    exited(reason?: string): void;
  }

  // ---- Terminals, tasks, source control, debug adapters, sign-ins, file systems (D233) ----

  interface TerminalDimensions {
    columns: number;
    rows: number;
  }

  /** What a pseudoterminal writes with: text (ANSI sequences allowed; "\r\n" for a new line). */
  interface PseudoterminalIo {
    write(text: string): void;
    /** Ends the terminal; `code` is its exit code. */
    exit(code?: number): void;
  }

  /** VS Code's Pseudoterminal, as functions: the extension is the terminal's program. */
  interface Pseudoterminal {
    /** The terminal is shown: start writing. */
    open(dimensions: TerminalDimensions, io: PseudoterminalIo): void | Promise<void>;
    /** What the user typed ("\r" for Enter). */
    input?(data: string): void;
    resize?(dimensions: TerminalDimensions): void;
    /** The user (or the IDE) closed it. */
    close?(): void;
  }

  interface TerminalOptions {
    /** The tab's title. */
    name?: string;
    /** A pseudoterminal ("terminal"); without it, a shell ("shell" and a trusted folder). */
    pty?: Pseudoterminal;
    /** The shell to start (default: the user's default profile). */
    shellPath?: string;
    shellArgs?: string[];
    /** Inside the open folder. */
    cwd?: string;
    env?: Record<string, string>;
    /** Take the focus (default false); the tab is always shown. */
    focus?: boolean;
    /**
     * Open the tab behind the panel's active one, not shown until `show()` (VS Code's
     * createTerminal); the shell starts anyway.
     */
    background?: boolean;
    /**
     * No tab at all (VS Code's hideFromUser, D388): it runs hidden until `show()`, and isn't
     * saved with the folder.
     */
    hidden?: boolean;
    /** Not saved with the folder: gone after a restart (VS Code's isTransient, D388). */
    transient?: boolean;
    /** What happens to it, from the moment it's created. */
    onEvent?(event: TerminalEvent): void;
  }

  /**
   * What happens to a terminal you made: its process id, closing (`reason` as VS Code's
   * TerminalExitReason: 2 its process ended, 3 the user closed it), being the active terminal,
   * the user typing in it, and shell integration (its folder, each command's start and end).
   */
  type TerminalEvent =
    | { kind: "started"; pid: number | null }
    | { kind: "closed"; code?: number; reason: number }
    | { kind: "active"; active: boolean }
    | { kind: "interacted" }
    | { kind: "shellIntegration"; cwd: string }
    | { kind: "cwd"; cwd: string }
    | { kind: "commandStart"; commandLine: string; cwd: string }
    | { kind: "commandEnd"; commandLine: string; exitCode?: number };

  /** A link found in a terminal line (VS Code's TerminalLink). */
  interface TerminalLink {
    /** Where it starts in the line (0-based) and how long it is. */
    startIndex: number;
    length: number;
    tooltip?: string;
  }

  interface ExtensionTerminal {
    readonly id: string;
    readonly name: string;
    /** Types into the terminal (Enter after it unless `addNewLine` is false). */
    sendText(text: string, addNewLine?: boolean): Promise<void>;
    /** Writes to a pseudoterminal's screen (kept until it has opened). */
    write(text: string): void;
    show(focus?: boolean): Promise<void>;
    /** Closes it. */
    dispose(): void;
  }

  type TaskExecution =
    | {
        kind: "shell";
        commandLine: string;
        cwd?: string;
        env?: Record<string, string>;
        /** A shell other than the default (VS Code's `options.executable` / `shellArgs`). */
        shell?: { executable: string; args?: string[] };
      }
    | {
        kind: "process";
        process: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
      }
    /** VS Code's CustomExecution ("terminal"): the task runs in the pseudoterminal `start` returns. */
    | {
        kind: "custom";
        start(definition: Record<string, unknown>): Pseudoterminal | Promise<Pseudoterminal>;
      };

  /** A task a provider offers (VS Code's Task); listed as "<type>: <name>". */
  interface ProvidedTask {
    name: string;
    /** Its tasks.json shape; `type` is the provider's. */
    definition?: Record<string, unknown>;
    detail?: string;
    group?: "build" | "test" | { kind: "build" | "test"; isDefault?: boolean };
    isBackground?: boolean;
    /** "$tsc", a matcher object, or a list (tasks.json's `problemMatcher`). */
    problemMatchers?: unknown;
    presentation?: {
      reveal?: "always" | "silent" | "never";
      focus?: boolean;
      panel?: "shared" | "dedicated" | "new";
      clear?: boolean;
      close?: boolean;
    };
    /** Shell and process tasks need "shell"; custom ones "terminal". */
    execution: TaskExecution;
  }

  interface ResourceDecorations {
    /** One or two characters after the name ("M"). */
    letter?: string;
    tooltip?: string;
    strikeThrough?: boolean;
    faded?: boolean;
    /** The theme's color for it. */
    tone?: "added" | "modified" | "deleted" | "renamed" | "conflict" | "untracked" | "ignored";
  }

  /** VS Code's SourceControlResourceState. */
  interface ResourceState {
    /** A file in the open folder (relative or absolute), or a URI of your own file system. */
    path: string;
    decorations?: ResourceDecorations;
    /** One of your commands, run on click (default: the file opens). */
    command?: { command: string; input?: unknown };
  }

  interface SourceControlResourceGroup {
    readonly id: string;
    label: string;
    hideWhenEmpty: boolean;
    /** Set a new list to update the view. */
    resourceStates: ResourceState[];
    dispose(): void;
  }

  /** VS Code's SourceControl: shown as a section of the Source control view. */
  interface SourceControl {
    readonly id: string;
    readonly label: string;
    readonly inputBox: {
      value: string;
      placeholder: string;
      visible: boolean;
      /** The user typed in it. */
      onDidChange(listener: (value: string) => void): Disposable;
    };
    /** The activity badge's number (default: every resource). */
    count: number | undefined;
    /** The commit button: one of your commands, run with `input` (default { value }). */
    acceptInputCommand: { command: string; title?: string; input?: unknown } | undefined;
    /** The text a file is compared with in the editor's change bars. */
    quickDiffProvider:
      | {
          provideOriginal(
            path: string,
          ): string | null | undefined | Promise<string | null | undefined>;
        }
      | undefined;
    createResourceGroup(id: string, label: string): SourceControlResourceGroup;
    dispose(): void;
  }

  /** A DAP message (request, response or event). */
  type DapMessage = Record<string, unknown>;

  type DebugAdapterDescriptor =
    /** A program speaking DAP over stdio ("shell", trusted folder). */
    | {
        kind: "executable";
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
      }
    /** An adapter already listening on this computer. */
    | { kind: "server"; port: number; host?: string }
    /** An adapter in your code: `start` gets `send` (messages to the IDE). */
    | {
        kind: "inline";
        start(send: (message: DapMessage) => void): {
          handleMessage(message: DapMessage): void;
          dispose?(): void;
        };
      };

  interface DebugSessionInfo {
    id: string;
    type: string;
    name: string;
    configuration: Record<string, unknown>;
    /** The session it runs under (D295). */
    parentSession?: string;
  }

  /** A debug session (VS Code's DebugSession, without its methods: ide.debug has them). */
  interface DebugSessionSummary {
    id: string;
    name: string;
    type: string;
    /** Its configuration as resolved (in session events). */
    configuration?: Record<string, unknown>;
    /** The id of the session it runs under. */
    parentSession?: string;
    /** Its configuration's folder. */
    workspaceFolder?: string;
  }

  /** VS Code's DebugSessionOptions, as the IDE takes them. */
  interface DebugStartOptions {
    /** The id of the session to start under (its child in the call stack, ended with it). */
    parentSession?: string;
    /** VS Code's lifecycleManagedByParent: restarted and stopped with its parent. */
    lifecycleManagedByParent?: boolean;
    /** "separate" (default) or "mergeWithParent": its output in the parent's console. */
    consoleMode?: "separate" | "mergeWithParent";
    noDebug?: boolean;
    suppressDebugToolbar?: boolean;
    suppressDebugStatusbar?: boolean;
    suppressDebugView?: boolean;
    suppressSaveBeforeStart?: boolean;
    /** The folder a configuration name is looked up in. */
    folder?: string;
  }

  interface DebugFunctionBreakpoint {
    name: string;
    enabled: boolean;
    condition?: string;
    hitCondition?: string;
  }

  /** VS Code's AuthenticationSession. */
  interface AuthenticationSession {
    id: string;
    accessToken: string;
    account: { id: string; label: string };
    scopes: string[];
  }

  interface AuthenticationProvider {
    /** The sessions (with every scope in `scopes`). Without it, the IDE keeps them in the keychain. */
    getSessions?(
      scopes?: string[],
    ): AuthenticationSession[] | undefined | Promise<AuthenticationSession[] | undefined>;
    /** Signs in (open a page, ask for a token…); throw when the user cancels. */
    createSession(scopes: string[]): AuthenticationSession | Promise<AuthenticationSession>;
    removeSession?(sessionId: string): void | Promise<void>;
  }

  type FileType = "file" | "directory";

  interface FileStatInfo {
    type: FileType;
    size?: number;
    /** Milliseconds since the epoch. */
    mtime?: number;
    readonly?: boolean;
  }

  /** VS Code's FileSystemProvider; every path is a URI of its scheme ("memfs:/a/b.txt"). */
  interface FileSystemProvider {
    stat(path: string): FileStatInfo | Promise<FileStatInfo>;
    readDirectory(path: string): [string, FileType][] | Promise<[string, FileType][]>;
    /** Text (UTF-8) or bytes. */
    readFile(path: string): string | Uint8Array | Promise<string | Uint8Array>;
    writeFile?(
      path: string,
      content: Uint8Array,
      options: { create: boolean; overwrite: boolean },
    ): void | Promise<void>;
    createDirectory?(path: string): void | Promise<void>;
    delete?(path: string, options: { recursive: boolean }): void | Promise<void>;
    rename?(from: string, to: string, options: { overwrite: boolean }): void | Promise<void>;
    /** Called once for the root; report changes with `fireDidChange`. */
    watch?(path: string, options: { recursive: boolean }): Disposable | undefined;
  }

  // ---- D234: more language providers, decoration types, editor events, watchers, env ----

  interface DocumentHighlight extends TextRange {
    kind?: "text" | "read" | "write";
  }

  interface FoldingRange {
    startLine: number;
    endLine: number;
    kind?: "comment" | "imports" | "region";
  }

  /** `target`: a web address (https, http, mailto) or a file of the folder (`line`, `column`). */
  interface DocumentLink extends TextRange {
    target: string;
    line?: number;
    column?: number;
    tooltip?: string;
  }

  /** Each part 0..1. */
  interface Color {
    red: number;
    green: number;
    blue: number;
    alpha: number;
  }

  interface ColorInformation extends TextRange {
    color: Color;
  }

  interface ColorPresentation {
    label: string;
    edit?: TextEdit;
  }

  interface InlineCompletionItem {
    insertText: string;
    /** Default: the cursor. */
    range?: TextRange;
    /** One of the extension's own commands, run when it's accepted. */
    command?: string;
    input?: unknown;
  }

  interface WorkspaceSymbol extends TextRange {
    name: string;
    /** LSP's names ("function", "class"…). */
    kind?: string;
    path: string;
    container?: string;
  }

  /**
   * A color: a theme name ("error", "warning", "info", "success", "accent", "muted", "subtle",
   * "label1"…"label6", "errorBackground"…), VS Code's `{ id: "editorError.foreground" }`, or a
   * literal ("#e5534b", the CSS color functions). Theme names follow the user's theme.
   */
  type ColorValue = string | { id: string };

  interface DecorationAttachmentOptions {
    contentText: string;
    color?: ColorValue;
    backgroundColor?: ColorValue;
    fontStyle?: "italic" | "normal";
    fontWeight?: "bold" | "normal";
    /** "1em", or a number of em (0 to 4). */
    margin?: string | number;
  }

  /** VS Code's DecorationRenderOptions, the parts the IDE draws. */
  interface DecorationTypeOptions {
    color?: ColorValue;
    backgroundColor?: ColorValue;
    borderColor?: ColorValue;
    borderStyle?: "solid" | "dashed" | "dotted";
    /** 1 to 3 px. */
    borderWidth?: string | number;
    borderRadius?: string | number;
    outlineColor?: ColorValue;
    fontStyle?: "italic" | "normal";
    fontWeight?: "bold" | "normal";
    textDecoration?: "underline" | "line-through" | "none" | "underline dotted" | "underline wavy";
    opacity?: string | number;
    isWholeLine?: boolean;
    before?: DecorationAttachmentOptions;
    after?: DecorationAttachmentOptions;
    overviewRulerColor?: ColorValue;
    overviewRulerLane?: "left" | "center" | "right" | "full";
    /** A colored bar beside the line numbers. */
    gutterColor?: ColorValue;
    light?: DecorationTypeOptions;
    dark?: DecorationTypeOptions;
  }

  /** A range of a decoration type: `hover` Markdown, `before` / `after` text instead of the type's. */
  type DecorationOptions = TextRange & { hover?: string; before?: string; after?: string };

  interface TextEditorDecorationType extends Disposable {
    readonly key: string;
    /** Replaces this type's ranges in `path` (default: the active editor's file); [] clears. */
    set(path: string | undefined, ranges: DecorationOptions[]): Promise<void>;
    /** Clears this type's ranges in every file. */
    clear(): Promise<void>;
  }

  interface FileSystemWatcher extends Disposable {
    onDidCreate(listener: (path: string) => void): Disposable;
    onDidChange(listener: (path: string) => void): Disposable;
    onDidDelete(listener: (path: string) => void): Disposable;
  }

  type PanelColumn = number | "main" | "beside" | "bottom" | "right";
  type PanelShowOptions = PanelColumn | { viewColumn?: PanelColumn; preserveFocus?: boolean };
  /** Accepted for VS Code's sake: scripts always run, hidden pages stay loaded. */
  interface WebviewPanelOptions {
    enableScripts?: boolean;
    retainContextWhenHidden?: boolean;
    enableFindWidget?: boolean;
    localResourceRoots?: unknown[];
  }
  interface Webview {
    /** The page; setting it loads it again (messages sent meanwhile wait for the new page). */
    html: string;
    readonly options: WebviewPanelOptions;
    /** In the page: `addEventListener("message", e => e.data?.ns === "ide-webview" && …e.data.message)`. */
    postMessage(message: unknown): Promise<boolean>;
    /** The page sends with `parent.postMessage({ ns: "ide-webview", message }, "*")`. */
    onDidReceiveMessage(listener: (message: unknown) => void): Disposable;
    /** A file of yours as the page addresses it (relative to your folder). */
    asWebviewUri(path: string): string;
    /** For a page's own CSP meta tag: "'self'". */
    readonly cspSource: string;
  }
  interface WebviewPanel {
    readonly viewType: string;
    title: string;
    /** An icon of the IDE's set for the tab. */
    iconPath: string | undefined;
    readonly webview: Webview;
    readonly options: WebviewPanelOptions;
    readonly visible: boolean;
    readonly active: boolean;
    /** Its editor group, counted in layout order from 1 (VS Code's viewColumn); undefined at first. */
    readonly viewColumn: number | undefined;
    reveal(viewColumn?: PanelColumn, preserveFocus?: boolean): void;
    onDidChangeViewState(listener: (e: { webviewPanel: WebviewPanel }) => void): Disposable;
    /** The user closed the tab, or you disposed it. */
    onDidDispose(listener: () => void): Disposable;
    dispose(): void;
  }
  interface TestItemCollection extends Iterable<[string, TestItem]> {
    readonly size: number;
    add(item: TestItem): void;
    delete(id: string): void;
    get(id: string): TestItem | undefined;
    replace(items: readonly TestItem[]): void;
    forEach(callback: (item: TestItem, collection: TestItemCollection) => void): void;
  }
  interface TestItem {
    readonly id: string;
    label: string;
    description: string | undefined;
    /** Its file, a path of the open folder (VS Code's uri). */
    uri: string | undefined;
    /** 1-based lines. */
    range: { startLine: number; endLine?: number } | undefined;
    canResolveChildren: boolean;
    busy: boolean;
    error: string | undefined;
    sortText: string | undefined;
    /** Its tags (VS Code's TestTag, D255): a profile with a tag runs only items that have it. */
    tags: readonly { id: string }[];
    readonly children: TestItemCollection;
    readonly parent: TestItem | undefined;
  }
  interface TestRunRequest {
    readonly include?: readonly TestItem[];
    readonly exclude?: readonly TestItem[];
    readonly profile?: TestRunProfile;
  }
  interface TestRunProfile {
    label: string;
    readonly kind: "run" | "debug" | "coverage";
    isDefault: boolean;
    /** Only for items with this tag (VS Code's TestRunProfile.tag, D255). */
    tag: { id: string } | undefined;
    runHandler: (request: TestRunRequest, token: CancellationToken) => void | Promise<void>;
    dispose(): void;
  }
  type TestMessage = string | { message: string; expectedOutput?: string; actualOutput?: string };
  interface TestRun {
    readonly name: string | undefined;
    readonly token: CancellationToken;
    enqueued(test: TestItem): void;
    started(test: TestItem): void;
    skipped(test: TestItem): void;
    passed(test: TestItem, duration?: number): void;
    failed(test: TestItem, message: TestMessage | readonly TestMessage[], duration?: number): void;
    errored(test: TestItem, message: TestMessage | readonly TestMessage[], duration?: number): void;
    /**
     * A file's coverage (a coverage profile's run, D255: VS Code's addCoverage with its statements
     * given at once); the Testing view shows it when the run ends.
     */
    addCoverage(coverage: {
      /** A path of the open folder. */
      path: string;
      /** Each line with code and how many times it ran. */
      lines: { line: number; count: number }[] | [line: number, count: number][];
      branches?: [line: number, taken: number, total: number][];
      functions?: { name: string; line?: number; hits: number }[];
    }): void;
    appendOutput(output: string, location?: unknown, test?: TestItem): void;
    end(): void;
  }
  interface TestController {
    readonly id: string;
    label: string;
    readonly items: TestItemCollection;
    createTestItem(id: string, label: string, uri?: string): TestItem;
    /** `kind`: "run" | "debug" | "coverage", or VS Code's TestRunProfileKind 1 | 2 | 3. */
    createRunProfile(
      label: string,
      kind: "run" | "debug" | "coverage" | 1 | 2 | 3,
      runHandler: TestRunProfile["runHandler"],
      isDefault?: boolean,
    ): TestRunProfile;
    createTestRun(request: TestRunRequest, name?: string, persist?: boolean): TestRun;
    resolveHandler: ((item: TestItem | undefined) => void | Promise<void>) | undefined;
    dispose(): void;
  }
  interface Api {
    /** `path`: the extension's folder on disk (absolute), e.g. for a script it ships. */
    readonly extension: { id: string; version: string; path: string };
    readonly env: {
      platform: "windows" | "macos" | "linux";
      /** The IDE's name as it shows it (D234). */
      appName: string;
      /** The user's language ("en-US"). */
      language: string;
      /** The scheme of links to the IDE: `<uriScheme>://<extension id>/…` reach its URI handler. */
      uriScheme: string;
      /**
       * An id for this installation of the IDE (VS Code's machineId): random, made once, not
       * derived from the machine; the same in every window (D255).
       */
      machineId: string;
      /** An id for this window's session: new each time the window starts. */
      sessionId: string;
      /** Opens a web page (https, http, mailto) in the system's browser. */
      openExternal(url: string): Promise<boolean>;
      /** "clipboard". */
      clipboard: { readText(): Promise<string>; writeText(text: string): Promise<void> };
    };
    /** Comment threads in files ("fs.read"; VS Code's comments API). */
    comments: { createCommentController(id: string, label: string): CommentController };
    /** "@name" participants (asked with extensions.askChatParticipant). */
    chat: {
      createChatParticipant(
        id: string,
        handler: (
          request: { prompt: string; command?: string; model: LanguageModelChat },
          context: { history: unknown[] },
          stream: ChatResponseStream,
          token: CancellationToken,
        ) => unknown,
        options?: { name?: string; description?: string },
      ): Disposable & { readonly id: string; readonly name: string };
    };
    /** The user's model: only while they turned on extensions.languageModelAccess (and allowed it). */
    lm: {
      selectChatModels(selector?: {
        vendor?: string;
        family?: string;
        id?: string;
      }): Promise<LanguageModelChat[]>;
      LanguageModelChatMessage: {
        User(content: string): LanguageModelChatMessage;
        Assistant(content: string): LanguageModelChatMessage;
      };
    };
    /**
     * A small JSON store for the open folder (VS Code's workspaceState, D234); for a multi-root
     * workspace, for its workspace file (D251).
     */
    workspaceState: {
      get<T = unknown>(key: string): Promise<T | undefined>;
      set(key: string, value: unknown): Promise<void>;
    };
    /**
     * Notebooks (D202): the IDE's notebook editor opens your file formats (declared in
     * `contributes.notebooks`) and runs cells on your kernels, Jupyter-style.
     */
    notebooks: {
      registerSerializer(
        type: string,
        serializer: {
          deserialize(text: string): NotebookData | Promise<NotebookData>;
          serialize(notebook: NotebookData): string | Promise<string>;
        },
      ): Disposable;
      /**
       * A message for the output pages of the notebooks running a kernel of `source` (one of
       * yours, registered with `messaging`; `path`: one notebook's): its preloads'
       * onDidReceiveKernelMessage. True when a page took it.
       */
      postKernelMessage(source: string, message: unknown, path?: string): Promise<boolean>;
      registerKernelSource(source: {
        id: string;
        label: string;
        /** The notebook types it runs (default: every one, Jupyter notebooks included). */
        notebookTypes?: string[];
        /**
         * Its kernels talk with their notebooks' output page (VS Code's controller messaging,
         * D295): the page runs extensions' preloads and renderers for every output.
         */
        messaging?: boolean;
        find(context: KernelContext): KernelOption[] | Promise<KernelOption[]>;
        start(
          option: KernelOption,
          context: KernelContext,
          host: KernelHost,
        ): Kernel | Promise<Kernel>;
        /**
         * Rows of the kernel picker below the kernels (VS Code's kernel source actions, D204):
         * "Existing server…", "Connect to a cluster…". `run` asks what it needs and returns the
         * kernel to use (then started like a found one), or nothing.
         */
        actions?: {
          id: string;
          label: string;
          detail?: string;
          run(context: KernelContext): KernelOption | undefined | Promise<KernelOption | undefined>;
        }[];
      }): Disposable;
      /**
       * Items in cells' status rows (D204): `notebookType` one of yours, or "*" for every one.
       * Needs "fs.read" (the provider is told each cell's text).
       */
      registerCellStatusBarItemProvider(
        notebookType: string,
        provide: (
          context: CellStatusContext,
        ) => CellStatusItem[] | undefined | Promise<CellStatusItem[] | undefined>,
      ): Disposable;
      /**
       * Messages with one of your `contributes.notebookRenderers` (D204): the renderer's
       * `context.postMessage` arrives here; `postMessage` reaches its frames (every notebook's,
       * or `path`'s only).
       */
      createRendererMessaging(rendererId: string): {
        postMessage(message: unknown, options?: { path?: string }): Promise<void>;
        onDidReceiveMessage(
          listener: (event: { message: unknown; path: string }) => void,
        ): Disposable;
      };
    };
    commands: {
      /**
       * Handles one of the commands declared in `contributes.commands`. Its input was checked
       * against the command's `input` schema, if it declared one.
       */
      register(
        id: string,
        handler: (input: unknown, context: CommandContext) => unknown,
      ): Disposable;
      /** Runs any IDE command (permissions apply: git.* needs "git", `read` effects "fs.read", `write` ones "fs.write"). */
      execute<T = unknown>(id: string, input?: unknown): Promise<T>;
    };
    state: {
      /** `ide://` state paths (e.g. ide://editors/active needs "fs.read"; its own ide://ext/<id>/… paths need nothing). */
      get<T = unknown>(path: string): Promise<T>;
      /**
       * Fills a state path agents and scripts can read: under `ide://ext/<extension id>/` (or a
       * path a bundled extension declares in `contributes.state`). The getter answers within 2 s
       * or the reader gets `{ error }`. At most 20 paths; gone when the extension stops.
       */
      register(
        path: string,
        getter: (context: { params: Record<string, string> }) => unknown,
      ): Disposable;
    };
    /**
     * files.didCreate | files.didRename | files.didDelete | files.didSave | files.didChange |
     * documents.didOpen, documents.didClose (D256), notebook.didOpen | notebook.didChange | notebook.didSave |
     * notebook.didClose ({ path, notebookType }; didChange also `cells`) | notebook.didRunCell
     * ({ path, notebookType, cellId, status, executionCount }) ("fs.read", D204);
     * tabs.didChange (TabsSnapshot: every editor group and its tabs, at once and on every change;
     * VS Code's window.tabGroups; "fs.read", D295); debug.didStartSession |
     * debug.didTerminateSession | debug.didChangeActiveSession | debug.didChangeBreakpoints |
     * debug.didReceiveCustomEvent | debug.didChangeActiveStackItem ("fs.read");
     * documents.didChange ({ path }: an open file's text was edited, unsaved; at most every
     * 250 ms per file; "fs.read") and git.didChange ({ root }; "git") (D208);
     * workspace.didOpen | workspace.willClose | workspace.didClose
     * ({ path } with "fs.read", else {}; willClose also has `reason`: "folder" | "window"; the
     * path is the first folder's), workspace.didChangeFolders ({ added, removed }: folders added
     * to or taken out of a multi-root workspace, with "fs.read", else {}; D251) and
     * workspace.didChangeTrust ({ trusted }) need no permission. editor.didChangeActive |
     * editor.didChangeSelection | editor.didChangeVisibleRange ("fs.read", D234; or use
     * `ide.editor.onDidChange…`).
     */
    events: { on(type: string, listener: (payload: unknown) => void): Disposable };
    /** Context keys its keybindings' and menus' `when` clauses can test: "<extension id>.<name>". */
    context: {
      /** A string, number or boolean; null or undefined removes it. Cleared when it stops. */
      set(key: string, value: string | number | boolean | null | undefined): Promise<void>;
    };
    /** Programs it runs: needs "shell" and a trusted folder (the user is asked once). */
    process: {
      /** At most 8 at a time; all are killed when the extension stops or the folder closes. */
      spawn(options: SpawnOptions): Promise<ProcessHandle>;
    };
    workspace: {
      isTrusted(): Promise<boolean>;
      /** Asks the user to trust the folder if they haven't decided; resolves whether it's trusted. */
      requireTrust(reason: string): Promise<boolean>;
      onDidChangeTrust(listener: (trusted: boolean) => void): Disposable;
      /**
       * The first folder (the primary): in a multi-root workspace see `folders()` /
       * `workspaceFolders` for all of them. Needs "fs.read".
       */
      root(): Promise<string | null>;
      /** Every folder of the workspace, the first first; [] with nothing open. Needs "fs.read". */
      folders(): Promise<WorkspaceFolder[]>;
      /**
       * The folder holding `path` (absolute, or relative as the fs calls take it), the innermost
       * when folders nest; null outside them. Needs "fs.read".
       */
      folderOf(path: string): Promise<WorkspaceFolder | null>;
      /** Folders were added to or taken out of the workspace. Needs "fs.read". */
      onDidChangeFolders(listener: (event: WorkspaceFoldersChangeEvent) => void): Disposable;
      /**
       * VS Code's workspaceFolders, kept current: undefined with nothing open. Needs "fs.read"
       * (undefined without it).
       */
      readonly workspaceFolders: readonly WorkspaceFolder[] | undefined;
      /** @deprecated The first folder's path (VS Code's rootPath); use `workspaceFolders`. */
      readonly rootPath: string | undefined;
      /**
       * The workspace's name: the folder's, or "<file> (Workspace)" / "Untitled (Workspace)" for
       * a multi-root one; undefined with nothing open. Needs "fs.read".
       */
      readonly name: string | undefined;
      /**
       * The `.code-workspace` file of a multi-root workspace (an untitled one's lives in the IDE's
       * data folder); undefined for a single folder. Needs "fs.read".
       */
      readonly workspaceFile: string | undefined;
      /** VS Code's getWorkspaceFolder: the folder holding an absolute `path`, if any. */
      getWorkspaceFolder(path: string): WorkspaceFolder | undefined;
      /**
       * VS Code's asRelativePath: `path` relative to its folder with "/", the folder's name in
       * front when there are several folders (or as `includeWorkspaceFolder` says); a path
       * outside every folder comes back as it is.
       */
      asRelativePath(path: string, includeWorkspaceFolder?: boolean): string;
      /** VS Code's onDidChangeWorkspaceFolders (same as `onDidChangeFolders`). */
      onDidChangeWorkspaceFolders(
        listener: (event: WorkspaceFoldersChangeEvent) => void,
      ): Disposable;
      /**
       * VS Code's updateWorkspaceFolders: takes `deleteCount` folders out from `start` and adds
       * `foldersToAdd` (absolute paths). Returns false for invalid input, when nothing would
       * change or while an earlier update is still under way; true when the change was asked for
       * (it happens shortly after; `onDidChangeWorkspaceFolders` tells). The user is asked before
       * folders are added; added folders go at the end with their folder's name (a `name` isn't
       * applied), and the IDE doesn't reorder or rename folders this way (such a change returns
       * false); taking out the first
       * folder reopens the workspace with the next one first; the last folder can't be taken out.
       * Needs "fs.read" and "fs.write".
       */
      updateWorkspaceFolders(
        start: number,
        deleteCount: number | undefined | null,
        ...foldersToAdd: { path: string; name?: string }[]
      ): boolean;
      fs: {
        /**
         * Paths are relative to the open folder (or absolute inside it); in a multi-root
         * workspace absolute in any of its folders, or relative with a folder's name first
         * ("api/src/main.ts"; else relative to the first folder). Needs "fs.read".
         */
        read(path: string): Promise<string>;
        /** A file's bytes as base64 (images…; 8 MB at most). Needs "fs.read". */
        readBase64(path: string): Promise<string>;
        /** Writes binary data given as base64 (16 MB at most). Needs "fs.write". */
        writeBase64(path: string, data: string): Promise<void>;
        /** Needs "fs.write". */
        write(path: string, text: string): Promise<void>;
        stat(
          path: string,
        ): Promise<{ kind: string; size: number; mtimeMs: number; readonly: boolean }>;
        list(path: string): Promise<{ name: string; path: string; kind: string }[]>;
      };
      /**
       * Searches the workspace's files (every folder; respects .gitignore) without touching the
       * search view.
       * Needs "fs.read". At most `maxResults` (default 2000, up to 20000) matching lines.
       */
      /** VS Code's applyEdit ("fs.write"): resolves false when it can't be applied. */
      applyEdit(edit: WorkspaceEdit): Promise<boolean>;
      createWorkspaceEdit(): WorkspaceEdit;
      /** Before a text file is saved ("fs.read"; edits need "fs.write"). */
      onWillSaveTextDocument(listener: (event: WillSaveEvent) => void): Disposable;
      onWillSaveNotebookDocument(listener: (event: WillSaveEvent) => void): Disposable;
      findText(
        query: string,
        options?: {
          isRegex?: boolean;
          matchCase?: boolean;
          wholeWord?: boolean;
          include?: string[];
          exclude?: string[];
          maxResults?: number;
        },
      ): Promise<{
        matches: { path: string; rel: string; line: number; text: string }[];
        truncated: boolean;
      }>;
      /**
       * Serves a URI scheme (VS Code's registerFileSystemProvider, D233): "<scheme>:/…" files
       * open in the editor (read and saved through the provider) and show in a section of the
       * Explorer. Built-in schemes are refused. Without `writeFile` (or with `isReadonly`) it's
       * read-only.
       */
      registerFileSystemProvider(
        scheme: string,
        provider: FileSystemProvider,
        options?: { label?: string; isReadonly?: boolean },
      ): Disposable & {
        fireDidChange(changes: { path: string; kind: "created" | "changed" | "deleted" }[]): void;
      };
      /**
       * Files of the workspace's folders whose path relative to their folder matches `include`
       * ("**" + "/*.md"; a RelativePattern: relative to its base, only under it) and not
       * `exclude` (.gitignored files aren't listed); absolute paths, 10000 at most. "fs.read"
       * (D234, D251).
       */
      findFiles(
        include: string | RelativePattern,
        exclude?: string,
        maxResults?: number,
      ): Promise<string[]>;
      /**
       * Created, changed (saved or written) and deleted files of the workspace's folders whose
       * path relative to their folder matches `glob` (a RelativePattern: relative to its base;
       * VS Code's createFileSystemWatcher; a rename is a delete and a create). "fs.read" (D234,
       * D251).
       */
      createFileSystemWatcher(
        glob: string | RelativePattern,
        options?: { ignoreCreate?: boolean; ignoreChange?: boolean; ignoreDelete?: boolean },
      ): FileSystemWatcher;
    };
    /** The active text editor ("fs.read" to look, "fs.write" to type into it). */
    editor: {
      active(): Promise<{
        path: string;
        language: string;
        cursor: { line: number; column: number };
        selectedText: string;
        /** The first selection (the cursor when nothing is selected), 1-based. */
        selection: { startLine: number; startColumn: number; endLine: number; endColumn: number };
      } | null>;
      /** Types `text` at the cursor (replacing selected text), like the user typing it. */
      insert(text: string): Promise<void>;
      /** Opens a file in the editor ("fs.read"). */
      open(
        path: string,
        /**
         * VS Code's showTextDocument options (D255): `selection` selects a range (instead of
         * `line` / `column`), `preserveFocus` keeps focus where it is, `toSide` opens it beside
         * the focused group. `with` (VS Code's `vscode.openWith`, D419) says how: "text" is
         * the text editor even where the file has a viewer of its own, any other value a
         * viewer's id (a custom editor's view type); without it the file's default opens.
         */
        options?: {
          line?: number;
          column?: number;
          preview?: boolean;
          selection?: TextRange;
          preserveFocus?: boolean;
          toSide?: boolean;
          with?: string;
        },
      ): Promise<void>;
      /** A file's text as the editor has it (unsaved edits included; default: the active one). */
      text(path?: string): Promise<string>;
      /** Replaces a range ("fs.write"): in the editor when open (one undoable edit), else on disk. */
      replace(range: TextRange, text: string, path?: string): Promise<void>;
      /** Selects a range in the active editor ("fs.read"). */
      select(range: TextRange): Promise<void>;
      /**
       * Decorates ranges of a file (default: the active one) with a theme style ("fs.read"); the
       * same `key` again replaces them, no ranges clears them. `after`: faint text after each range.
       */
      decorate(
        key: string,
        options: {
          path?: string;
          style: "highlight" | "underline" | "error" | "warning" | "info" | "faded" | "strong";
          ranges: (TextRange & { hover?: string })[];
          after?: string;
        },
      ): Promise<void>;
      clearDecorations(key?: string): Promise<void>;
      /**
       * Text before each line of a file ("fs.read"), like a blame gutter: the cursor skips it, the
       * hover shows on it. The same file again replaces them; null or [] removes them. At most
       * 20000 lines and 50 files; one extension's annotations per file.
       */
      setLineAnnotations(path: string, annotations: LineAnnotation[] | null): Promise<void>;
      /** Every editor's cursor (VS Code's TextEditorOptions.cursorStyle, or its 1–6); null resets. */
      setOptions(options: {
        cursorStyle?:
          | "line"
          | "block"
          | "underline"
          | "line-thin"
          | "block-outline"
          | "underline-thin"
          | number
          | null;
      }): Promise<void>;
      /**
       * VS Code's createTextEditorDecorationType ("fs.read", D234): colors, borders, fonts,
       * before / after text, the overview ruler and a gutter bar; `set` puts it on ranges of a
       * file. At most 50 types.
       */
      createDecorationType(options: DecorationTypeOptions): TextEditorDecorationType;
      /** Another file's editor became active, or none (null). "fs.read" (D234). */
      onDidChangeActive(
        listener: (editor: { path: string; language: string } | null) => void,
      ): Disposable;
      /** The active editor's selections moved (1-based). "fs.read" (D234). */
      onDidChangeSelection(
        listener: (event: {
          path: string;
          selections: {
            startLine: number;
            startColumn: number;
            endLine: number;
            endColumn: number;
          }[];
        }) => void,
      ): Disposable;
      /** The active editor scrolled: its first and last visible lines. "fs.read" (D234). */
      onDidChangeVisibleRange(
        listener: (event: { path: string; startLine: number; endLine: number }) => void,
      ): Disposable;
      /**
       * Another notebook became active (null: none), or its selected cells changed: the
       * notebook's path and the selected cells' indexes. "fs.read" (D265).
       */
      onDidChangeNotebook(
        listener: (editor: { path: string; selection: number[] } | null) => void,
      ): Disposable;
    };
    /**
     * Problems and language providers in files ("fs.read"; the ones that change files also
     * "fs.write"). As in VS Code, there are no time limits: every provider gets a CallToken as
     * its second argument (after its context), which fires when the editor no longer needs the
     * answer. Places providers answer with may be anywhere on disk; edits stay in the folder.
     */
    languages: {
      /** Replaces the extension's problems for `path` (Problems view and squiggles). */
      setDiagnostics(path: string, items: Diagnostic[]): Promise<void>;
      clearDiagnostics(path?: string): Promise<void>;
      /** Every language the editor knows (its own and extensions'), by id (VS Code's getLanguages). */
      getLanguages(): Promise<string[]>;
      /**
       * A language's comments, brackets, word pattern, indentation and Enter rules (D258, VS
       * Code's setLanguageConfiguration) in language-configuration.json's shape; merged over the
       * language's own until disposed.
       */
      setLanguageConfiguration(
        languageId: string,
        configuration: Record<string, unknown>,
      ): Disposable;
      /**
       * Markdown shown on hover ("*" for every language). `{ contents, range }` highlights that
       * range (1-based, end column exclusive) instead of the word under the pointer.
       */
      registerHoverProvider(
        languages: string | string[],
        provide: (
          context: ProviderContext,
          token: CallToken,
        ) =>
          | string
          | HoverWithRange
          | null
          | undefined
          | Promise<string | HoverWithRange | null | undefined>,
      ): Disposable;
      /**
       * Suggestions; a CompletionList with `isIncomplete` is asked again as the user types. With
       * `resolve`, items carrying a `resolveId` are completed when selected (documentation,
       * detail, additionalTextEdits: VS Code's resolveCompletionItem).
       */
      registerCompletionProvider(
        languages: string | string[],
        provide: (
          context: ProviderContext & CompletionContext,
          token: CallToken,
        ) => CompletionItem[] | CompletionList | Promise<CompletionItem[] | CompletionList>,
        options?: {
          triggerCharacters?: string[];
          resolve?: (
            item: { resolveId: string },
            token: CallToken,
          ) => Answer<Partial<CompletionItem>>;
        },
      ): Disposable;
      /** Go to definition (F12, Ctrl+click, peek). */
      registerDefinitionProvider(
        languages: string | string[],
        provide: (context: ProviderContext) => Answer<Location | Location[]>,
      ): Disposable;
      /** Find all references (Shift+F12). */
      registerReferenceProvider(
        languages: string | string[],
        provide: (context: ProviderContext & { includeDeclaration: boolean }) => Answer<Location[]>,
      ): Disposable;
      /** Format document ("fs.write"). */
      registerDocumentFormattingProvider(
        languages: string | string[],
        provide: (context: FormattingContext) => Answer<TextEdit[]>,
      ): Disposable;
      /** Format selection ("fs.write"). */
      registerRangeFormattingProvider(
        languages: string | string[],
        provide: (context: FormattingContext & { range: FullRange }) => Answer<TextEdit[]>,
      ): Disposable;
      /**
       * Quick fixes and refactorings (the light bulb, Ctrl+.; "fs.write"). With `resolve` (VS
       * Code's resolveCodeAction), actions may come without `edits`: `resolve` gets the chosen
       * one and fills in its `edits` (or returns the action with them); nothing else of it changes.
       */
      registerCodeActionProvider(
        languages: string | string[],
        provide: (context: CodeActionContext) => Answer<CodeAction[]>,
        options?: { resolve?: (action: CodeAction) => Answer<CodeAction> },
      ): Disposable;
      /**
       * Rename symbol (F2; "fs.write"). Throw to refuse, with the reason as the message.
       * `prepare` (VS Code's prepareRename) runs before the rename box opens: the range renamed
       * (it must contain the position) and the text the box starts with, null for the word there,
       * or throw to refuse (the message shows at the symbol).
       */
      registerRenameProvider(
        languages: string | string[],
        provide: (context: ProviderContext & { newName: string }) => Answer<FileEdit[]>,
        options?: { prepare?: (context: ProviderContext) => Answer<RenameLocation> },
      ): Disposable;
      registerSignatureHelpProvider(
        languages: string | string[],
        provide: (
          context: ProviderContext & { triggerCharacter?: string },
        ) => Answer<SignatureHelp>,
        options?: { triggerCharacters?: string[]; retriggerCharacters?: string[] },
      ): Disposable;
      /** The Outline, breadcrumbs and Go to symbol in editor. */
      registerDocumentSymbolProvider(
        languages: string | string[],
        provide: (context: DocumentContext) => Answer<DocumentSymbol[]>,
      ): Disposable;
      registerCodeLensProvider(
        languages: string | string[],
        provide: (context: DocumentContext) => Answer<CodeLens[]>,
      ): Disposable;
      /** With `resolve`, hints carrying a `resolveId` are completed when hovered (VS Code's). */
      registerInlayHintsProvider(
        languages: string | string[],
        provide: (context: DocumentContext & { range: FullRange }) => Answer<InlayHint[]>,
        options?: { resolve?: (hint: { resolveId: string }) => Answer<Partial<InlayHint>> },
      ): Disposable;
      /**
       * Colors by meaning; `legend.tokenTypes` are VS Code's standard names ("function"…). The
       * editor asks again after `refresh()` or when `options.onDidChange` fires (VS Code's
       * onDidChangeSemanticTokens). With `range: true` the provider is asked about the visible
       * range only (`context.range`; VS Code's DocumentRangeSemanticTokensProvider).
       */
      registerSemanticTokensProvider(
        languages: string | string[],
        provide: (context: DocumentContext & { range?: FullRange }) => Answer<SemanticToken[]>,
        legend: { tokenTypes: string[]; tokenModifiers?: string[] },
        options?: { onDidChange?: (listener: () => void) => Disposable; range?: boolean },
      ): Disposable & { refresh(): void };
      // D234: the rest of VS Code's common language providers.
      registerTypeDefinitionProvider(
        languages: string | string[],
        provide: (context: ProviderContext) => Answer<Location | Location[]>,
      ): Disposable;
      /** Go to implementations (Ctrl+F12). */
      registerImplementationProvider(
        languages: string | string[],
        provide: (context: ProviderContext) => Answer<Location | Location[]>,
      ): Disposable;
      registerDeclarationProvider(
        languages: string | string[],
        provide: (context: ProviderContext) => Answer<Location | Location[]>,
      ): Disposable;
      /** The symbol's other uses in the file, highlighted while the cursor is on it. */
      registerDocumentHighlightProvider(
        languages: string | string[],
        provide: (context: ProviderContext) => Answer<DocumentHighlight[]>,
      ): Disposable;
      registerFoldingRangeProvider(
        languages: string | string[],
        provide: (context: DocumentContext) => Answer<FoldingRange[]>,
      ): Disposable;
      /** Ctrl+click links: web addresses (opened by the system) or files of the folder. */
      registerDocumentLinkProvider(
        languages: string | string[],
        provide: (context: DocumentContext) => Answer<DocumentLink[]>,
      ): Disposable;
      /** Swatches and the color picker; without `presentations` a pick is written as hex. */
      registerColorProvider(
        languages: string | string[],
        provide: (context: DocumentContext) => Answer<ColorInformation[]>,
        options?: {
          presentations?: (
            context: DocumentContext & { color: Color; range: FullRange },
          ) => Answer<(ColorPresentation | string)[]>;
        },
      ): Disposable;
      /** Edits as the user types a trigger character ("fs.write"; editor.formatOnType). */
      registerOnTypeFormattingProvider(
        languages: string | string[],
        provide: (
          context: ProviderContext & { ch: string; tabSize: number; insertSpaces: boolean },
        ) => Answer<TextEdit[]>,
        triggerCharacters: string[],
      ): Disposable;
      /** Ghost text at the cursor (Tab accepts it); 5 s at most. */
      registerInlineCompletionProvider(
        languages: string | string[],
        provide: (
          context: ProviderContext & { explicit: boolean },
        ) => Answer<
          (InlineCompletionItem | string)[] | { items: (InlineCompletionItem | string)[] }
        >,
      ): Disposable;
      /** Go to symbol in workspace (Ctrl+T, "#" in quick open); files of the folder only. */
      registerWorkspaceSymbolProvider(
        provide: (context: { query: string }) => Answer<WorkspaceSymbol[]>,
      ): Disposable;
      /**
       * Ranges edited together as the user types in one (an HTML tag's name at both ends), VS
       * Code's LinkedEditingRangeProvider; `wordPattern` (a RegExp source) limits what's typed.
       */
      registerLinkedEditingRangeProvider(
        languages: string | string[],
        provide: (
          context: ProviderContext,
        ) => Answer<TextRange[] | { ranges: TextRange[]; wordPattern?: string }>,
      ): Disposable;
      /** Expand / shrink selection (Shift+Alt+Right / Left): each position's ranges, inside out. */
      registerSelectionRangeProvider(
        languages: string | string[],
        provide: (
          context: DocumentContext & { positions: { line: number; column: number }[] },
        ) => Answer<(SelectionRange | TextRange[])[]>,
      ): Disposable;
      /** Show call hierarchy (Shift+Alt+H) for files no language server answers for. */
      registerCallHierarchyProvider(
        languages: string | string[],
        provider: {
          prepareCallHierarchy(context: ProviderContext): Answer<HierarchyItem | HierarchyItem[]>;
          provideCallHierarchyIncomingCalls(
            context: DocumentContext & { item: HierarchyItem },
          ): Answer<HierarchyCall[]>;
          provideCallHierarchyOutgoingCalls(
            context: DocumentContext & { item: HierarchyItem },
          ): Answer<HierarchyCall[]>;
        },
      ): Disposable;
      /** Show type hierarchy: a type's supertypes and subtypes. */
      registerTypeHierarchyProvider(
        languages: string | string[],
        provider: {
          prepareTypeHierarchy(context: ProviderContext): Answer<HierarchyItem | HierarchyItem[]>;
          provideTypeHierarchySupertypes(
            context: DocumentContext & { item: HierarchyItem },
          ): Answer<HierarchyItem[]>;
          provideTypeHierarchySubtypes(
            context: DocumentContext & { item: HierarchyItem },
          ): Answer<HierarchyItem[]>;
        },
      ): Disposable;
      /**
       * What the debugger shows the value of under the pointer while paused (VS Code's
       * EvaluatableExpressionProvider): a range, and the expression when it isn't its text.
       */
      registerEvaluatableExpressionProvider(
        languages: string | string[],
        provide: (
          context: ProviderContext,
        ) => Answer<{ range: TextRange; expression?: string } | null>,
      ): Disposable;
      /**
       * The values the debugger shows at the end of lines while paused (VS Code's
       * InlineValuesProvider): asked about `range` (up to the stopped line) of the stopped file;
       * for its language they replace the debugger's own word matching.
       */
      registerInlineValuesProvider(
        languages: string | string[],
        provide: (
          context: DocumentContext & { range: FullRange; frameId: number; stoppedLine: number },
        ) => Answer<InlineValue[]>,
      ): Disposable;
    };
    ui: {
      /** Resolves with the clicked action's label (undefined without actions). */
      notify(
        message: string,
        options?: { kind?: "info" | "success" | "warning" | "error"; actions?: string[] },
      ): Promise<string | undefined>;
      showQuickPick<T extends QuickPickItem>(
        items: T[],
        /**
         * `matchOnDescription`: typing filters on the description too (D234); `activeIndex`: the
         * row active at first (VS Code's activeItems).
         */
        options?: {
          placeholder?: string;
          matchOnDescription?: boolean;
          canPickMany?: false;
          activeIndex?: number;
        },
      ): Promise<T | undefined>;
      /** Several items (VS Code's canPickMany; `picked` items start checked). */
      showQuickPick<T extends QuickPickItem>(
        items: T[],
        options: { placeholder?: string; matchOnDescription?: boolean; canPickMany: true },
      ): Promise<T[] | undefined>;
      /**
       * A live quick pick or input box (VS Code's createQuickPick / createInputBox): `update`
       * changes its properties while it's open (items filled in as they're found, `busy`,
       * validation as the user types), and `listener` hears what the user does — the typed
       * value, the active and selected rows (indexes into the last `items` sent), Enter (the box
       * stays open until you `hide` it), title and row buttons, and its end ("hide", once).
       */
      quickInput: {
        open(
          kind: "pick" | "input",
          props: QuickInputProps,
          listener: (event: QuickInputEvent) => void,
        ): QuickInputHandle;
      };
      /**
       * Closes editor tabs by their ids (from the "tabs.didChange" event's snapshots, VS Code's
       * tabGroups.close): true when all closed (a tab with unsaved changes may stay).
       */
      closeTabs(ids: string[], preserveFocus?: boolean): Promise<boolean>;
      /** Links to the IDE for this extension (one handler; activation "onUri"). */
      registerUriHandler(handler: { handleUri(uri: Uri): unknown }): Disposable;
      /**
       * A modal dialog (the IDE adds which extension asks). Resolves with the chosen action's
       * label; undefined when cancelled (Escape, `cancel`'s button, or the extension stopped).
       */
      showDialog(options: {
        title: string;
        message: string;
        /** 1 to 4, left to right: put the main one last. */
        actions: { label: string; variant?: "primary" | "danger" }[];
        /** A cancel button's label. */
        cancel?: string;
      }): Promise<string | undefined>;
      /**
       * Badges, colors and tooltips on files in the Explorer (D258, VS Code's
       * registerFileDecorationProvider; "fs.read"): `badge` 1–2 characters, `color` a theme name
       * or VS Code's color id ("gitDecoration.modifiedResourceForeground"). `fireDidChange`
       * (some paths, or all) asks again.
       */
      registerFileDecorationProvider(provider: {
        provideFileDecoration(
          path: string,
        ): Answer<{ badge?: string; tooltip?: string; color?: string }>;
      }): Disposable & { fireDidChange(paths?: string[]): void };
      /** The system's open dialog (D257): the paths the user picked, or undefined. */
      showOpenDialog(options?: {
        title?: string;
        defaultPath?: string;
        /** Folders instead of files. */
        folders?: boolean;
        many?: boolean;
        filters?: { name: string; extensions: string[] }[];
      }): Promise<string[] | undefined>;
      /** The system's save dialog (D257): the path the user chose, or undefined. */
      showSaveDialog(options?: {
        title?: string;
        defaultPath?: string;
      }): Promise<string | undefined>;
      showInput(options?: {
        prompt?: string;
        value?: string;
        placeholder?: string;
        /** Masks what is typed (a token, D234). */
        password?: boolean;
        /** A validation problem shown at first (VS Code's InputBox.validationMessage). */
        error?: string;
      }): Promise<string | undefined>;
      /** Rows of a `"type": "tree"` view from `contributes.views`. */
      registerTreeView(
        viewId: string,
        provider: TreeProvider,
      ): {
        refresh(): void;
        /** A line above the rows (what's shown, or why nothing is); "" removes it. */
        setMessage(message: string): void;
        onDidChangeCheckboxState(
          listener: (changes: { item: TreeItem; checked: boolean }[]) => void,
        ): Disposable;
        /**
         * Shows a row (D258): `path` is its id with its parents' ids, top first (expanded on the
         * way); `select` (default true), `focus`, `expand` it.
         */
        reveal(
          path: string[],
          options?: { select?: boolean; focus?: boolean; expand?: boolean },
        ): Promise<void>;
        /** The user selected rows (D258). */
        onDidChangeSelection(listener: (items: TreeItem[]) => void): Disposable;
        /** A row was expanded or collapsed (VS Code's onDidExpandElement / onDidCollapseElement). */
        onDidChangeExpansion(listener: (item: TreeItem, expanded: boolean) => void): Disposable;
        /** A number on the view's activity bar icon (VS Code's TreeView.badge); 0 removes it. */
        setBadge(badge: { value: number; tooltip?: string } | undefined): void;
      } & Disposable;
      /**
       * Whether one of its views shows (VS Code's TreeView / WebviewView `visible`): `visible`
       * answers now, `listener` hears the changes until disposed.
       */
      watchView(
        viewId: string,
        listener: (visible: boolean) => void,
      ): { visible: Promise<boolean> } & Disposable;
      /**
       * Its own channel in the Output tab, named `name` (id `ext.<extension id>~<name>`; at most
       * 10). `console` output still goes to Extension host.
       */
      createOutputChannel(name: string): OutputChannel;
      /**
       * Shows that `task` is under way (VS Code's `window.withProgress`) until it settles, as a
       * toast ("notification", with Cancel when `cancellable`) or in the status bar ("window").
       * Resolves or rejects as the task does.
       */
      withProgress<T>(
        options: ProgressOptions,
        task: (progress: Progress, token: CancellationToken) => T | Promise<T>,
      ): Promise<T>;
      /**
       * A `"type": "webview"` view, or a file viewer (`contributes.viewers`): messages to and from
       * its page (a viewer has only postMessage / onMessage: the user opens it on a file). A
       * viewer's page gets `{ ns: "ide-webview", file: { path, name, text, canSave } }` (`error`
       * instead of `text` when unreadable) and saves with `{ ns: "ide-webview", save: text }`
       * ("fs.write"; docs/extensions.md).
       */
      webview(viewId: string): {
        /** `instance`: one tab of a `codePage` viewer (D257); default: every page of the view. */
        postMessage(message: unknown, instance?: number): Promise<void>;
        /**
         * The page of a view or viewer declared with `"codePage": true` (D257, VS Code's webview
         * views and custom editors): your code writes it, served from your folder's origin like
         * a panel's. A viewer's tabs are told `{ ide: "viewerOpened", path, instance }` and their
         * page's messages arrive as `{ ide: "viewerMessage", instance, message }`.
         */
        setHtml(html: string, instance?: number): Promise<void>;
        /** A viewer tab has unsaved changes (D258): its tab shows it and closing it asks. */
        setDirty(dirty: boolean, instance: number): Promise<void>;
        onMessage(listener: (message: unknown) => void): Disposable;
        /**
         * Shows the view. `background`: its tab opens behind the active one and nothing takes
         * the focus (a side bar view: nothing opens) (D269).
         */
        reveal(options?: { background?: boolean }): Promise<void>;
        /** Shows the view's tab in a window of its own (panel and editor views). */
        openInWindow(options?: { width?: number; height?: number }): Promise<void>;
      };
      /**
       * A page your code writes, in a tab of its own (VS Code's `window.createWebviewPanel`):
       * set `panel.webview.html`; it's served from your folder's origin (relative URLs reach your
       * files; same CSP and theme message as a `"type": "webview"` view). `showOptions`: "main"
       * (default), "beside", "bottom", "right", a ViewColumn number (-2 beside), or
       * `{ viewColumn, preserveFocus }`. At most 50 open. Panels don't come back after a restart.
       */
      createWebviewPanel(
        viewType: string,
        title: string,
        showOptions?: PanelShowOptions,
        options?: WebviewPanelOptions,
      ): WebviewPanel;
      /** An item in the status bar (at most 10); `update` changes it, `dispose` removes it. */
      createStatusBarItem(options: StatusBarItemOptions): {
        update(options: Partial<Omit<StatusBarItemOptions, "id">>): Promise<void>;
      } & Disposable;
    };
    settings: {
      /**
       * The extension's own settings, editor.*, workbench.*, files.* ones and those its manifest
       * lists in `readsSettings` (never agent/ai/mcp/accounts/http/lsp or secret-like keys).
       */
      get<T = unknown>(key: string): Promise<T>;
      /** Its own settings and the `readsSettings` ones that changed. */
      onChange(listener: (keys: string[]) => void): Disposable;
      /**
       * Writes a setting (VS Code's WorkspaceConfiguration.update; "fs.write", D234): its own, or
       * one a folder's settings could set (never user-only ones or credentials').
       */
      update(key: string, value: unknown, target?: "user" | "workspace"): Promise<void>;
    };
    /**
     * Read-only git ("git"), through the IDE's own git and its repositories (a named one, else
     * the one `path` is in, else the one Source control shows). Changing a repository is the
     * IDE's `git.*` commands (`ide.commands.execute("git.stashApply", { index })`…).
     */
    git: {
      repositories(): Promise<GitRepository[]>;
      /** Who last changed each line; the editor's unsaved text unless `useEditorText: false`. */
      blame(
        path: string,
        options?: GitRepositoryOption & { useEditorText?: boolean },
      ): Promise<GitBlameHunk[]>;
      /**
       * The commits that changed lines start..end (`git log -L`), newest first, with their diffs;
       * `limit` ≤ 200 (default 50). Also needs "fs.read".
       */
      lineLog(
        path: string,
        startLine: number,
        endLine: number,
        options?: GitRepositoryOption & { limit?: number },
      ): Promise<GitLineLogEntry[]>;
      /** The files that differ from `left` to `right` (HEAD); `mergeBase`: since they forked. */
      diffNames(
        left: string,
        right?: string,
        options?: GitRepositoryOption & { mergeBase?: boolean },
      ): Promise<GitChangedFile[]>;
      /** The full hash `rev` names. */
      revParse(rev: string, options?: GitRepositoryOption): Promise<string>;
      /** Where two refs forked. */
      mergeBase(left: string, right: string, options?: GitRepositoryOption): Promise<string>;
      refs(options?: GitRepositoryOption): Promise<{
        branches: {
          name: string;
          remote: boolean;
          current: boolean;
          upstream: string | null;
          commit: string;
          subject: string;
        }[];
        tags: string[];
      }>;
      stashes(
        options?: GitRepositoryOption,
      ): Promise<{ index: number; message: string; time: number }[]>;
      /**
       * A file's text at `rev`: "" (the index), "HEAD" (default) or a commit hash; null if absent.
       * Also needs "fs.read".
       */
      show(path: string, rev?: string, options?: GitRepositoryOption): Promise<string | null>;
      /**
       * A repository's HEAD, index or refs changed (a commit, checkout, stash, fetch…): `root` is
       * its root, "" when the repositories or the selected one changed.
       */
      onDidChange(listener: (event: { root: string }) => void): Disposable;
    };
    /** GitHub through the user's own `gh` sign-in ("github"). */
    github: {
      /** Unread notifications (`all`: read ones too). */
      notifications(options?: { all?: boolean }): Promise<GitHubNotification[]>;
      markNotificationRead(id: string): Promise<void>;
      markAllNotificationsRead(): Promise<void>;
    };
    /**
     * Terminals (D233): a pseudoterminal you serve ("terminal"), or a shell you choose ("shell"
     * and a trusted folder), shown as an ordinary terminal tab.
     */
    terminals: {
      create(options: TerminalOptions): Promise<ExtensionTerminal>;
      /**
       * Links in terminal lines ("terminal": the line's text goes to the extension, D264): VS
       * Code's TerminalLinkProvider.
       */
      registerLinkProvider<L extends TerminalLink = TerminalLink>(provider: {
        provideTerminalLinks(context: {
          line: string;
          terminal: { name: string };
        }): L[] | Promise<L[]>;
        handleTerminalLink(link: L): unknown;
      }): Disposable;
      /**
       * A terminal profile your manifest declares (`contributes.terminal.profiles`, D264): when
       * the user picks it, `open` makes the terminal (with `create`).
       */
      registerProfileProvider(id: string, provider: { open(): unknown }): Disposable;
      /**
       * Sets all of this extension's changes to new terminals' environment ("shell"; [] clears
       * them): `value` replaces `variable`, or goes after (append) or before (prepend) its value.
       * Terminals started from then on get them; they go when the extension stops.
       */
      setEnvironment(
        changes: { variable: string; value: string; type: "replace" | "append" | "prepend" }[],
      ): Promise<void>;
    };
    /** Task providers (D233): their tasks join Run task and `tasks.run`. */
    tasks: {
      /** `type` must be in `contributes.taskDefinitions`. */
      registerTaskProvider(
        type: string,
        provider: {
          provideTasks(): ProvidedTask[] | undefined | Promise<ProvidedTask[] | undefined>;
          /** A tasks.json entry of your type (VS Code's resolveTask); nothing drops it. */
          resolveTask?(
            definition: Record<string, unknown>,
          ): ProvidedTask | undefined | Promise<ProvidedTask | undefined>;
        },
      ): Disposable;
    };
    /** Source control (D233): yours shows below git's in the Source control view. */
    scm: {
      createSourceControl(options: { id: string; label: string; rootPath?: string }): SourceControl;
    };
    /** Debug adapters (D233) for the types of `contributes.debuggers`. */
    debug: {
      // ---- D255: VS Code's breakpoints and sessions ----
      /** Every breakpoint ("fs.read"): id, kind, path (workspace-relative), line, enabled… */
      breakpoints(): Promise<
        {
          id: number;
          /** "line" (in a file), "function" or "data". */
          kind?: string;
          path?: string;
          line?: number;
          enabled?: boolean;
          condition?: string;
          hitCondition?: string;
          logMessage?: string;
          verified?: boolean;
        }[]
      >;
      /** Adds line breakpoints, or replaces one at the same line ("fs.write"). */
      addBreakpoints(
        list: {
          path: string;
          line: number;
          condition?: string;
          hitCondition?: string;
          logMessage?: string;
          /** False: added disabled. */
          enabled?: boolean;
        }[],
      ): Promise<void>;
      /** Removes breakpoints by id ("fs.write"). */
      removeBreakpoints(ids: number[]): Promise<void>;
      /** Function breakpoints ("fs.read"). */
      functionBreakpoints(): Promise<DebugFunctionBreakpoint[]>;
      /** Adds function breakpoints ("fs.write"). */
      addFunctionBreakpoints(list: DebugFunctionBreakpoint[]): Promise<void>;
      /** Removes function breakpoints by their functions' names ("fs.write"). */
      removeFunctionBreakpoints(names: string[]): Promise<void>;
      /** A line breakpoint as session `sessionId` placed it (DAP's Breakpoint), or null. */
      protocolBreakpoint(sessionId: string, id: number): Promise<Record<string, unknown> | null>;
      /** The focused session, or null ("fs.read"). */
      activeDebugSession(): Promise<DebugSessionSummary | null>;
      /** Every running session ("fs.read"). */
      debugSessions(): Promise<DebugSessionSummary[]>;
      /**
       * Starts a launch.json configuration by name, or a whole configuration ("shell"): VS Code's
       * startDebugging. Resolves with the new session's id (none: a resolver cancelled it).
       */
      startDebugging(
        configuration: string | Record<string, unknown>,
        options?: DebugStartOptions,
      ): Promise<{ session?: string }>;
      /** Stops one session, or every one ("shell"). */
      stopDebugging(sessionId?: string): Promise<void>;
      /** A Debug Adapter Protocol request to a session (default: the focused one); "shell". */
      customRequest(
        command: string,
        args?: Record<string, unknown>,
        sessionId?: string,
      ): Promise<unknown>;
      /** Writes to the debug console (VS Code's activeDebugConsole.append). */
      appendToConsole(text: string): Promise<void>;
      /** "fs.read" for these. */
      onDidStartDebugSession(listener: (session: DebugSessionSummary) => void): Disposable;
      onDidTerminateDebugSession(listener: (session: DebugSessionSummary) => void): Disposable;
      onDidChangeActiveDebugSession(
        listener: (session: DebugSessionSummary | null) => void,
      ): Disposable;
      onDidChangeBreakpoints(listener: () => void): Disposable;
      /** An event of a session's adapter's own (VS Code's onDidReceiveDebugSessionCustomEvent). */
      onDidReceiveCustomEvent(
        listener: (e: { session: DebugSessionSummary; event: string; body: unknown }) => void,
      ): Disposable;
      /** The focused thread or frame changed (null: none; VS Code's activeStackItem). */
      onDidChangeActiveStackItem(
        listener: (
          item: { session: DebugSessionSummary; threadId: number; frameId?: number } | null,
        ) => void,
      ): Disposable;
      /**
       * VS Code's resolveDebugConfiguration (D234): fill in or change a configuration of your type
       * before it starts (null cancels). Its type and request stay; `program`, `args`, `cwd` and
       * `stopOnEntry` as launch.json gave them win in the launch request.
       * `provideDebugConfigurations` (VS Code's): configurations offered in "Add configuration…"
       * (each with a `name`; the type is yours). Activation `"onDebugInitialConfigurations"` starts
       * you for it. `triggerKind` "initial" (default) or "dynamic": both are offered there.
       */
      registerDebugConfigurationProvider(
        type: string,
        provider: {
          resolveDebugConfiguration?(
            configuration: Record<string, unknown>,
            folder?: string | null,
          ): Answer<Record<string, unknown>>;
          /**
           * VS Code's second step (D295): the configuration with its variables filled in, after
           * the preLaunchTask ran; null / undefined cancels the launch.
           */
          resolveDebugConfigurationWithSubstitutedVariables?(
            configuration: Record<string, unknown>,
            folder?: string | null,
          ): Answer<Record<string, unknown>>;
          provideDebugConfigurations?(folder: string | null): Answer<Record<string, unknown>[]>;
        },
        triggerKind?: "initial" | "dynamic",
      ): Disposable;
      /**
       * Watches sessions' DAP messages (D258, VS Code's trackers): `type` a debug type or "*".
       * The tracker hears what the IDE sends the adapter, what the adapter sends, and the end.
       */
      registerDebugAdapterTrackerFactory(
        type: string,
        factory: {
          createDebugAdapterTracker(session: { id: string; type: string; name: string }): Answer<{
            onWillStartSession?(): void;
            onWillReceiveMessage?(message: unknown): void;
            onDidSendMessage?(message: unknown): void;
            onWillStopSession?(): void;
            onExit?(code: number | undefined, signal: string | undefined): void;
          }>;
        },
      ): Disposable;
      registerDebugAdapterDescriptorFactory(
        type: string,
        factory: {
          createDebugAdapterDescriptor(
            session: DebugSessionInfo,
          ): DebugAdapterDescriptor | undefined | Promise<DebugAdapterDescriptor | undefined>;
        },
      ): Disposable;
    };
    /** Sign-ins (D233, VS Code's authentication). */
    authentication: {
      registerAuthenticationProvider(
        id: string,
        label: string,
        provider: AuthenticationProvider,
        options?: { supportsMultipleAccounts?: boolean },
      ): Disposable & { fireDidChangeSessions(): void };
      /**
       * A session of provider `providerId`: yours freely; another extension's only after the
       * user allows it. `createIfNone` signs in (asking first for another's provider); `silent`
       * never asks.
       */
      getSession(
        providerId: string,
        scopes: string[],
        options?: { createIfNone?: boolean; forceNewSession?: boolean; silent?: boolean },
      ): Promise<AuthenticationSession | undefined>;
      onDidChangeSessions(listener: (event: { providerId: string }) => void): Disposable;
    };
    /**
     * Test controllers (VS Code's `tests.createTestController`): your tests show in the Testing
     * view beside the built-in frameworks'; its Run and Debug buttons call your run profiles.
     */
    tests: {
      createTestController(id: string, label: string): TestController;
    };
    /** Your own secrets (VS Code's SecretStorage), in the OS keychain the IDE uses for its keys. */
    secrets: {
      get(key: string): Promise<string | undefined>;
      store(key: string, value: string): Promise<void>;
      delete(key: string): Promise<void>;
    };
    /** A small JSON store kept per extension (5 MB). */
    storage: {
      get<T = unknown>(key: string): Promise<T | undefined>;
      set(key: string, value: unknown): Promise<void>;
    };
    /** HTTP(S) requests: "network" or "network:<domain>" ("*.example.com" works). */
    net: {
      fetch(
        url: string,
        init?: { method?: string; headers?: Record<string, string>; body?: string },
      ): Promise<FetchResponse>;
    };
  }
}

declare const ide: IdeExtension.Api;

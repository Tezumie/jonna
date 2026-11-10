// The `vscode` shim's text editors (D256): window.activeTextEditor kept current from the IDE's
// editor events, VS Code's TextEditor over the IDE's active editor (selections, edits, decorations,
// reveal), showTextDocument and decoration types. DOM-free and unit-tested.

import type { WorkerApi } from "../rpc";
import type { DecorationTypeOptions } from "../rpcExtras";
import { fromRange, markdownOf, pathOf, toRange } from "./convert";
import { type Documents, pathKey, type ShimTextDocument } from "./document";
import {
  EndOfLine,
  EventEmitter,
  Position,
  Range,
  Selection,
  SnippetString,
  snippetText,
  TextEdit,
  TextEditorSelectionChangeKind,
  type Uri,
  ViewColumn,
} from "./types";

type IdeSelection = { startLine: number; startColumn: number; endLine: number; endColumn: number };

const toSelection = (s: IdeSelection): Selection => {
  const r = toRange(s);
  return new Selection(r.start, r.end);
};

// A snippet's text with its tab stops and placeholders as plain text (types.ts has it, for
// WorkspaceEdit's snippet edits too).
export { snippetText };

export class ShimTextEditor {
  private current: Selection[];
  visibleRanges: Range[] = [];
  readonly viewColumn = ViewColumn.One;
  options: { tabSize: number; insertSpaces: boolean; cursorStyle?: number; lineNumbers?: number } =
    {
      tabSize: 4,
      insertSpaces: true,
    };

  constructor(
    readonly document: ShimTextDocument,
    selections: Selection[],
    private readonly ide: WorkerApi,
    private readonly docs?: Documents,
    /** Whether this is the IDE's active editor (selecting reaches only that one). */
    private readonly isActive: (editor: ShimTextEditor) => boolean = () => true,
  ) {
    this.current = selections.length ? selections : [new Selection(0, 0, 0, 0)];
  }

  get selections(): Selection[] {
    return this.current;
  }

  /** VS Code's setter selects in the editor (D261: assigning did nothing); the IDE takes the first. */
  set selections(value: Selection[]) {
    if (!value.length) return;
    this.current = [...value];
    const first = value[0];
    if (first && this.isActive(this)) void this.ide.editor.select(fromRange(first)).catch(() => {});
  }

  /** Updates what it holds without selecting (the IDE reported the selection). */
  setSelectionsFromIde(value: Selection[]): void {
    if (value.length) this.current = value;
  }

  get selection(): Selection {
    return this.current[0] ?? new Selection(0, 0, 0, 0);
  }

  set selection(s: Selection) {
    this.selections = [s];
  }

  private get path(): string {
    return pathOf(this.document.uri);
  }

  /** VS Code's TextEditor.edit: the builder's edits as one change of the file. */
  async edit(
    callback: (builder: {
      replace(location: Position | Range | Selection, value: string): void;
      insert(location: Position, value: string): void;
      delete(location: Range | Selection): void;
      setEndOfLine(eol: EndOfLine): void;
    }) => void,
    _options?: { undoStopBefore: boolean; undoStopAfter: boolean },
  ): Promise<boolean> {
    const edits: TextEdit[] = [];
    let eol: EndOfLine | undefined;
    callback({
      replace: (location, value) =>
        edits.push(
          new TextEdit(location instanceof Range ? location : new Range(location, location), value),
        ),
      insert: (location, value) => edits.push(TextEdit.insert(location, value)),
      delete: (location) => edits.push(TextEdit.delete(location)),
      setEndOfLine: (value) => {
        eol = value;
      },
    });
    if (eol !== undefined) {
      const text = this.document.getText();
      const converted =
        eol === EndOfLine.CRLF ? text.replace(/\r?\n/g, "\r\n") : text.replace(/\r\n/g, "\n");
      const end = this.document.positionAt(text.length);
      edits.push(new TextEdit(new Range(new Position(0, 0), end), converted));
    }
    if (!edits.length) return true;
    const workspaceEdit = this.ide.workspace.createWorkspaceEdit();
    workspaceEdit.set(
      this.path,
      edits.map((e) => ({ ...fromRange(e.range), text: e.newText })),
    );
    const applied = await this.ide.workspace.applyEdit(workspaceEdit);
    // As in VS Code, the document shows the edit once this resolves (D261: the next edit was
    // computed on the old text).
    if (applied) await this.docs?.sync(this.path, undefined, { dirty: true }).catch(() => {});
    return applied;
  }

  async insertSnippet(
    snippet: SnippetString,
    location?: Position | Range | readonly Position[] | readonly Range[],
  ): Promise<boolean> {
    const text = snippetText(
      SnippetString.isSnippetString(snippet) ? snippet.value : String(snippet),
    );
    const at = Array.isArray(location) ? location[0] : location;
    if (!at) {
      await this.ide.editor.insert(text);
      return true;
    }
    return this.edit((b) => b.replace(at as Position | Range, text));
  }

  setDecorations(
    type: { set(path: string | undefined, ranges: unknown[]): Promise<void> },
    ranges: readonly (Range | { range: Range; hoverMessage?: unknown; renderOptions?: unknown })[],
  ): void {
    const options = ranges.map((r) => {
      if (r instanceof Range || Range.isRange(r)) return fromRange(r);
      const o = r as {
        range: Range;
        hoverMessage?: unknown;
        renderOptions?: { before?: { contentText?: string }; after?: { contentText?: string } };
      };
      const hover = markdownOf(o.hoverMessage);
      return {
        ...fromRange(o.range),
        ...(hover && { hover }),
        ...(o.renderOptions?.before?.contentText && { before: o.renderOptions.before.contentText }),
        ...(o.renderOptions?.after?.contentText && { after: o.renderOptions.after.contentText }),
      };
    });
    void type.set(this.path, options).catch(() => {});
  }

  revealRange(range: Range, _revealType?: number): void {
    void this.ide.editor
      .open(this.path, {
        line: range.start.line + 1,
        column: range.start.character + 1,
        preserveFocus: true,
      })
      .catch(() => {});
  }

  show(_column?: ViewColumn): void {
    void this.ide.editor.open(this.path).catch(() => {});
  }

  hide(): void {}
}

/** Colors and decorations: VS Code's ThemeColor as the IDE's `{ id }`. */
function decorationOptions(v: unknown, depth = 0): DecorationTypeOptions {
  if (!v || typeof v !== "object" || depth > 3) return {};
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (
      x &&
      typeof x === "object" &&
      typeof (x as { id?: unknown }).id === "string" &&
      Object.keys(x).length <= 2
    )
      out[k] = { id: (x as { id: string }).id };
    else if (
      x &&
      typeof x === "object" &&
      (k === "before" || k === "after" || k === "light" || k === "dark")
    )
      out[k] = decorationOptions(x, depth + 1);
    else if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") out[k] = x;
  }
  // VS Code's lane is a number (OverviewRulerLane); the IDE's a name.
  if (typeof out.overviewRulerLane === "number")
    out.overviewRulerLane = (
      { 1: "left", 2: "center", 4: "right", 7: "full" } as Record<number, string>
    )[out.overviewRulerLane];
  return out as DecorationTypeOptions;
}

export function createEditors(ide: WorkerApi, docs: Documents) {
  let active: ShimTextEditor | undefined;
  const onDidChangeActiveTextEditor = new EventEmitter<ShimTextEditor | undefined>();
  const onDidChangeVisibleTextEditors = new EventEmitter<readonly ShimTextEditor[]>();
  const onDidChangeTextEditorSelection = new EventEmitter<{
    textEditor: ShimTextEditor;
    selections: readonly Selection[];
    kind: TextEditorSelectionChangeKind | undefined;
  }>();
  const onDidChangeTextEditorVisibleRanges = new EventEmitter<{
    textEditor: ShimTextEditor;
    visibleRanges: readonly Range[];
  }>();
  const onDidChangeTextEditorOptions = new EventEmitter<unknown>();
  // Latest wins: an older answer arriving late doesn't replace a newer editor.
  let generation = 0;

  const activate = async (
    path: string | null,
    language?: string,
    selections: IdeSelection[] = [],
  ) => {
    const mine = ++generation;
    if (!path) {
      if (active === undefined) return;
      active = undefined;
    } else {
      const doc = await docs.sync(path, language).catch(() => undefined);
      if (mine !== generation) return;
      if (!doc) return;
      if (
        active &&
        pathKey(pathOf(active.document.uri)) === pathKey(path) &&
        active.document === doc
      )
        return;
      active = new ShimTextEditor(doc, selections.map(toSelection), ide, docs, (x) => x === active);
    }
    onDidChangeActiveTextEditor.fire(active);
    onDidChangeVisibleTextEditors.fire(active ? [active] : []);
  };

  const ready = ide.editor
    .active()
    .then((e) => (e ? activate(e.path, e.language, [e.selection]) : undefined))
    .catch(() => undefined);

  ide.editor.onDidChangeActive((e) => void activate(e?.path ?? null, e?.language));
  ide.editor.onDidChangeSelection((e) => {
    if (!active || pathKey(pathOf(active.document.uri)) !== pathKey(e.path)) return;
    active.setSelectionsFromIde(e.selections.map(toSelection));
    onDidChangeTextEditorSelection.fire({
      textEditor: active,
      selections: active.selections,
      kind: TextEditorSelectionChangeKind.Keyboard,
    });
  });
  ide.editor.onDidChangeVisibleRange((e) => {
    if (!active || pathKey(pathOf(active.document.uri)) !== pathKey(e.path)) return;
    active.visibleRanges = [
      new Range(Math.max(0, e.startLine - 1), 0, Math.max(0, e.endLine - 1), 0),
    ];
    onDidChangeTextEditorVisibleRanges.fire({
      textEditor: active,
      visibleRanges: active.visibleRanges,
    });
  });

  const showTextDocument = async (
    target: ShimTextDocument | Uri,
    columnOrOptions?:
      | ViewColumn
      | { viewColumn?: ViewColumn; preserveFocus?: boolean; preview?: boolean; selection?: Range },
    preserveFocusArg?: boolean,
  ): Promise<ShimTextEditor> => {
    const own = "uri" in target && "getText" in target ? (target as ShimTextDocument) : undefined;
    let path = pathOf(own ? own.uri : (target as Uri));
    // Its own untitled document (openTextDocument({ content })): the IDE's untitled editor with
    // its text, which is the document from then on (D261).
    if (own && docs.isLocal(own)) {
      const made = await ide.commands.execute<{ path?: string }>("workspace.newUntitledFile", {
        text: own.getText(),
      });
      if (!made?.path) throw new Error("Couldn't open an untitled editor.");
      docs.close(path);
      path = made.path;
    }
    const options = typeof columnOrOptions === "object" ? columnOrOptions : {};
    const column = typeof columnOrOptions === "number" ? columnOrOptions : options.viewColumn;
    await ide.editor.open(path, {
      ...(options.selection && { selection: fromRange(options.selection) }),
      ...((options.preserveFocus ?? preserveFocusArg) && { preserveFocus: true }),
      ...(options.preview === false && { preview: false }),
      ...(column === ViewColumn.Beside && { toSide: true }),
    });
    const doc = await docs.sync(path);
    if (!doc) throw new Error(`Couldn't open ${path}`);
    if (!active || active.document !== doc) {
      const selection = options.selection
        ? [new Selection(options.selection.start, options.selection.end)]
        : [];
      active = new ShimTextEditor(doc, selection, ide, docs, (x) => x === active);
      generation++;
      onDidChangeActiveTextEditor.fire(active);
      onDidChangeVisibleTextEditors.fire([active]);
    }
    return active;
  };

  return {
    ready,
    get activeTextEditor() {
      return active;
    },
    get visibleTextEditors() {
      return active ? [active] : [];
    },
    onDidChangeActiveTextEditor: onDidChangeActiveTextEditor.event,
    onDidChangeVisibleTextEditors: onDidChangeVisibleTextEditors.event,
    onDidChangeTextEditorSelection: onDidChangeTextEditorSelection.event,
    onDidChangeTextEditorVisibleRanges: onDidChangeTextEditorVisibleRanges.event,
    onDidChangeTextEditorOptions: onDidChangeTextEditorOptions.event,
    onDidChangeTextEditorViewColumn: new EventEmitter<unknown>().event,
    showTextDocument,
    createTextEditorDecorationType: (options: unknown) => {
      const type = ide.editor.createDecorationType(decorationOptions(options));
      return {
        key: type.key,
        set: (path: string | undefined, ranges: unknown[]) => type.set(path, ranges as never[]),
        dispose: () => type.dispose(),
      };
    },
  };
}

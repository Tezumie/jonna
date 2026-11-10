// The engine's document (EngineDocument): a Monaco text model with the IDE's line endings,
// indentation and kept-closed state. Out of widgets.ts (the editor) since D394.

import { ILanguageFeaturesService } from "monaco-editor/editor/common/services/languageFeatures.js";
import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import type { LineMark } from "../../../core/diff/index";
import { Emitter } from "../../../core/events/index";
import { DisposableStore } from "../../../core/lifecycle/index";
import type { EngineDocument, LineEnding } from "../engine";
import * as monaco from "./core";
import { setKeptClosed } from "./keptClosed";

/** Overview-ruler colors; tokens can't be used here (Monaco wants a color value). */
const OVERVIEW: Record<
  LineMark["kind"],
  monaco.editor.IModelDecorationOverviewRulerOptions["color"]
> = {
  added: { id: "editorGutter.addedBackground" },
  modified: { id: "editorGutter.modifiedBackground" },
  deleted: { id: "editorGutter.deletedBackground" },
};

export class MonacoDocument implements EngineDocument {
  private readonly store = new DisposableStore();
  private readonly changed = this.store.add(new Emitter<void>());
  readonly onDidChangeContent = this.changed.event;

  constructor(
    readonly path: string,
    readonly model: monaco.editor.ITextModel,
    readonly readOnly: boolean,
  ) {
    const sub = model.onDidChangeContent(() => this.changed.fire());
    this.store.add({ dispose: () => sub.dispose() });
  }

  get languageId(): string {
    return this.model.getLanguageId();
  }
  get versionId(): number {
    return this.model.getAlternativeVersionId();
  }
  setEol(eol: LineEnding): void {
    // pushEOL keeps it on the undo stack (setEOL would not).
    this.model.pushEOL(
      eol === "\r\n" ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF,
    );
  }
  get eol(): LineEnding {
    return this.model.getEOL() === "\r\n" ? "\r\n" : "\n";
  }
  get lineCount(): number {
    return this.model.getLineCount();
  }
  indentation(): { insertSpaces: boolean; tabSize: number } {
    const o = this.model.getOptions();
    return { insertSpaces: o.insertSpaces, tabSize: o.tabSize };
  }
  setIndentation(options: { insertSpaces?: boolean; tabSize?: number }): void {
    this.model.updateOptions({
      ...(options.insertSpaces !== undefined && { insertSpaces: options.insertSpaces }),
      ...(options.tabSize !== undefined && {
        tabSize: options.tabSize,
        indentSize: options.tabSize,
      }),
    });
    this.changed.fire();
  }
  getText(): string {
    return this.model.getValue();
  }
  setKeptClosed(kept: boolean): void {
    setKeptClosed(this.model, kept);
  }
  private marks: string[] = [];
  setLineMarks(marks: readonly LineMark[]): void {
    this.marks = this.model.deltaDecorations(
      this.marks,
      marks.map((m) => ({
        range: new monaco.Range(m.startLine, 1, m.endLine, 1),
        options: {
          isWholeLine: true,
          linesDecorationsClassName: `quick-diff quick-diff-${m.kind}${m.staged ? " is-staged" : ""}`,
          overviewRuler: {
            color: OVERVIEW[m.kind],
            position: monaco.editor.OverviewRulerLane.Left,
          },
          // The minimap's left edge too, as VS Code's (D273).
          minimap: {
            color: OVERVIEW[m.kind],
            position: monaco.editor.MinimapPosition.Gutter,
          },
        },
      })),
    );
  }
  replaceText(text: string): void {
    const old = this.model.getValue();
    if (text === old) return;
    // Only the part that changed (common start and end kept): the cursor, folds and markers
    // outside it stay put — formatting a file doesn't throw the view to its end.
    const max = Math.min(old.length, text.length);
    let start = 0;
    while (start < max && old.charCodeAt(start) === text.charCodeAt(start)) start++;
    let end = 0;
    while (
      end < max - start &&
      old.charCodeAt(old.length - 1 - end) === text.charCodeAt(text.length - 1 - end)
    )
      end++;
    // Never split a surrogate pair or a CRLF.
    while (start > 0 && /[\uD800-\uDBFF\r]/.test(old.charAt(start - 1))) start--;
    while (end > 0 && /[\uDC00-\uDFFF\n]/.test(old.charAt(old.length - end))) end--;
    const range = monaco.Range.fromPositions(
      this.model.getPositionAt(start),
      this.model.getPositionAt(old.length - end),
    );
    this.model.pushStackElement();
    this.model.pushEditOperations(
      [],
      [{ range, text: text.slice(start, text.length - end) }],
      () => null,
    );
    this.model.pushStackElement();
  }
  async formattedText(): Promise<string | null> {
    // The provider Format document would use first (Monaco orders them by score).
    const providers: monaco.languages.DocumentFormattingEditProvider[] = StandaloneServices.get(
      ILanguageFeaturesService,
    ).documentFormattingEditProvider.ordered(this.model);
    const [provider] = providers;
    if (!provider) return null;
    const source = new monaco.CancellationTokenSource();
    try {
      const edits: monaco.languages.TextEdit[] | null | undefined =
        await provider.provideDocumentFormattingEdits(this.model, this.indentation(), source.token);
      if (!edits || this.model.isDisposed()) return null;
      // Applied to a copy of the text, last edit first (they don't overlap).
      const text = this.model.getValue();
      const spans = edits
        .map((e) => ({
          start: this.model.getOffsetAt({
            lineNumber: e.range.startLineNumber,
            column: e.range.startColumn,
          }),
          end: this.model.getOffsetAt({
            lineNumber: e.range.endLineNumber,
            column: e.range.endColumn,
          }),
          text: e.text ?? "",
        }))
        .sort((a, b) => b.start - a.start || b.end - a.end);
      let out = text;
      for (const s of spans) out = out.slice(0, s.start) + s.text + out.slice(s.end);
      return out;
    } catch {
      return null;
    } finally {
      source.dispose();
    }
  }
  dispose(): void {
    this.store.dispose();
    this.model.dispose();
  }
}

// Monaco implementation of EngineDiffEditor (the diff tab): side by side, original read-only, the
// same chrome options as the text editor, Monaco's own diff computation (editor worker).
import { Emitter } from "../../../core/events/index";
import { DisposableStore } from "../../../core/lifecycle/index";
import type { EditorOptions, EngineDiffEditor, EngineDocument } from "../engine";
import * as monaco from "./core";
import { MonacoDocument } from "./document";
import { followSize, monacoOptions, monoFont } from "./widgets";

/**
 * diffEditor.* (D200) as Monaco's diff options. An embedded diff (one file of the multi-file
 * diff, D229) always folds unchanged regions, as VS Code's multi-diff editor does.
 */
function diffOptions(options: EditorOptions, embedded = false): monaco.editor.IDiffEditorOptions {
  const d = options.diff;
  return {
    renderSideBySide: d?.sideBySide ?? true,
    ignoreTrimWhitespace: d?.ignoreTrimWhitespace ?? true,
    hideUnchangedRegions: { enabled: embedded || (d?.hideUnchangedRegions ?? false) },
  };
}

/** An embedded diff scrolls with its page: no vertical scrollbar, the wheel goes to the page. */
const EMBEDDED_SCROLL: monaco.editor.IEditorScrollbarOptions = {
  vertical: "hidden",
  verticalScrollbarSize: 0,
  alwaysConsumeMouseWheel: false,
};

export class MonacoDiffEditor implements EngineDiffEditor {
  private readonly store = new DisposableStore();
  private readonly updated = this.store.add(new Emitter<void>());
  private readonly focused = this.store.add(new Emitter<void>());
  private readonly contextMenu = this.store.add(new Emitter<{ x: number; y: number }>());
  private readonly heightChanged = this.store.add(new Emitter<void>());
  readonly onDidChangeContentHeight = this.heightChanged.event;
  readonly onDidUpdateDiff = this.updated.event;
  readonly onDidFocus = this.focused.event;
  readonly onContextMenu = this.contextMenu.event;
  private readonly diff: monaco.editor.IStandaloneDiffEditor;

  constructor(
    container: HTMLElement,
    themeName: string,
    options: EditorOptions,
    onDispose: () => void,
    private readonly embedded = false,
  ) {
    this.diff = monaco.editor.createDiffEditor(container, {
      theme: themeName,
      automaticLayout: false,
      fontFamily: monoFont(),
      originalEditable: false,
      useInlineViewWhenSpaceIsLimited: true,
      renderOverviewRuler: false,
      ...diffOptions(options, embedded),
      scrollBeyondLastLine: false,
      fixedOverflowWidgets: true,
      contextmenu: false,
      ...monacoOptions({ ...options, glyphMargin: false }),
      stickyScroll: { enabled: false },
      ...(embedded && { scrollbar: EMBEDDED_SCROLL, minimap: { enabled: false } }),
    });
    this.store.add(followSize(container, () => this.diff.layout()));
    const modified = this.diff.getModifiedEditor();
    // The shared document's quick-diff marks would repeat what the diff already shows.
    modified.updateOptions({ overviewRulerLanes: 0 });
    const subs = [
      this.diff.onDidUpdateDiff(() => this.updated.fire()),
      modified.onDidContentSizeChange((e) => e.contentHeightChanged && this.heightChanged.fire()),
      this.diff
        .getOriginalEditor()
        .onDidContentSizeChange((e) => e.contentHeightChanged && this.heightChanged.fire()),
      modified.onDidFocusEditorText(() => this.focused.fire()),
      this.diff.getOriginalEditor().onDidFocusEditorText(() => this.focused.fire()),
      modified.onContextMenu((e) => {
        e.event.preventDefault();
        const ev = e.event.browserEvent;
        this.contextMenu.fire({ x: ev.clientX, y: ev.clientY });
      }),
    ];
    this.store.add({
      dispose: () => {
        for (const sub of subs) sub.dispose();
        this.diff.setModel(null);
        this.diff.dispose();
        onDispose();
      },
    });
  }

  setDocuments(original: EngineDocument | null, modified: EngineDocument | null): void {
    const o = original instanceof MonacoDocument ? original : null;
    const m = modified instanceof MonacoDocument ? modified : null;
    this.diff.setModel(o && m ? { original: o.model, modified: m.model } : null);
    this.diff.getModifiedEditor().updateOptions({ readOnly: m?.readOnly ?? true });
  }

  setOptions(
    options: EditorOptions,
    _forLanguage?: (languageId: string, path?: string) => EditorOptions,
  ): void {
    this.diff.updateOptions({
      ...diffOptions(options, this.embedded),
      ...monacoOptions({ ...options, glyphMargin: false }),
      stickyScroll: { enabled: false },
      ...(this.embedded && { scrollbar: EMBEDDED_SCROLL, minimap: { enabled: false } }),
    });
  }

  contentHeight(): number {
    return Math.max(
      this.diff.getModifiedEditor().getContentHeight(),
      this.diff.getOriginalEditor().getContentHeight(),
    );
  }

  focus(): void {
    this.diff.getModifiedEditor().focus();
  }

  layout(): void {
    this.diff.layout();
  }

  modifiedLine(): number | null {
    return this.diff.getModifiedEditor().getPosition()?.lineNumber ?? null;
  }

  goToChange(direction: "next" | "previous"): void {
    this.diff.goToDiff(direction);
    this.diff.getModifiedEditor().focus();
  }

  revealModifiedLine(line: number): void {
    const editor = this.diff.getModifiedEditor();
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.revealLineInCenter(line);
  }

  changeCount(): number {
    return this.diff.getLineChanges()?.length ?? 0;
  }

  dispose(): void {
    this.store.dispose();
  }
}

// Inline edit support for MonacoEditor (D106): DOM blocks between lines (a view zone reserves the
// space; an overlay widget holds the node, so inputs inside it get focus and keys normally), line
// decorations, line-range replacement as one undoable edit, and ghost-text completions.

import type { Disposable } from "../../../core/lifecycle/index";
import { upperDrive } from "../../../core/paths/index";
import { editMayReturnToSuggestion } from "../ai/cache";
import type { EditorZone, InlineCompletionSource, LineRange } from "../engine";
import * as monaco from "./core";

let zoneIds = 0;

export function addZone(
  editor: monaco.editor.IStandaloneCodeEditor,
  afterLine: number,
  node: HTMLElement,
  heightPx: number,
): EditorZone {
  const id = `ide-zone-${++zoneIds}`;
  const spacer = document.createElement("div");
  const holder = document.createElement("div");
  holder.className = "editor-zone";
  holder.style.position = "absolute";
  holder.append(node);
  let zoneId: string | null = null;
  let top = -1;
  let height = heightPx;
  let after = afterLine;
  const place = () => {
    const layout = editor.getLayoutInfo();
    holder.style.top = `${top}px`;
    holder.style.left = `${layout.contentLeft}px`;
    holder.style.width = `${Math.max(120, layout.contentWidth - layout.verticalScrollbarWidth - 8)}px`;
    holder.style.height = `${height}px`;
    holder.style.display = top < 0 ? "none" : "";
  };
  const widget: monaco.editor.IOverlayWidget = {
    getId: () => id,
    getDomNode: () => holder,
    getPosition: () => null,
  };
  editor.addOverlayWidget(widget);
  const add = () =>
    editor.changeViewZones((acc) => {
      if (zoneId) acc.removeZone(zoneId);
      zoneId = acc.addZone({
        afterLineNumber: after,
        heightInPx: height,
        domNode: spacer,
        onDomNodeTop: (t) => {
          top = t;
          place();
        },
      });
    });
  add();
  const subs = [editor.onDidLayoutChange(place), editor.onDidScrollChange(place)];
  return {
    setHeight(px: number) {
      if (px === height) return;
      height = px;
      add();
      place();
    },
    moveTo(line: number) {
      after = line;
      add();
    },
    dispose() {
      for (const s of subs) s.dispose();
      editor.changeViewZones((acc) => {
        if (zoneId) acc.removeZone(zoneId);
      });
      editor.removeOverlayWidget(widget);
    },
  };
}

export function decorateLines(
  editor: monaco.editor.IStandaloneCodeEditor,
  range: LineRange,
  className: string,
): Disposable {
  const collection = editor.createDecorationsCollection([
    {
      range: new monaco.Range(range.startLine, 1, range.endLine, 1),
      options: { isWholeLine: true, className, marginClassName: className },
    },
  ]);
  return { dispose: () => collection.clear() };
}

export function replaceLines(
  editor: monaco.editor.IStandaloneCodeEditor,
  range: LineRange,
  text: string,
): LineRange {
  const model = editor.getModel();
  if (!model) return range;
  const end = Math.min(range.endLine, model.getLineCount());
  const target = new monaco.Range(range.startLine, 1, end, model.getLineMaxColumn(end));
  editor.pushUndoStop();
  editor.executeEdits("inline-edit", [{ range: target, text, forceMoveMarkers: true }]);
  editor.pushUndoStop();
  const lines = text.split(/\r?\n/).length;
  return { startLine: range.startLine, endLine: range.startLine + lines - 1 };
}

/** Registers `source` for every language; Monaco asks after each change, we wait for a pause. */
export function registerInlineCompletions(
  source: InlineCompletionSource,
  delayMs: () => number,
): Disposable {
  const provider: monaco.languages.InlineCompletionsProvider = {
    async provideInlineCompletions(model, position, context, token) {
      // Files and notebook cells (D204), not diff copies or previews.
      if (model.uri.scheme !== "file" && model.uri.scheme !== "notebook-cell") return { items: [] };
      // Asked for (editor.inlineSuggest.trigger): at once; while typing: after a pause.
      const explicit =
        context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit;
      // Enough for any token budget (the source cuts to its own) without the whole of a big
      // file.
      const here = () => at(model, model.getOffsetAt(position));
      const item = (insert: string) => ({
        insertText: insert,
        range: new monaco.Range(
          position.lineNumber,
          position.column,
          position.lineNumber,
          position.column,
        ),
      });
      // Typing through a suggestion (or back at a spot asked before): no pause, no request.
      if (!explicit && source.cached) {
        const known = source.cached({ path: upperDrive(model.uri.fsPath), ...here() });
        if (known !== undefined) return { items: known ? [item(known)] : [] };
      }
      if (!explicit) await new Promise((r) => setTimeout(r, source.delayMs?.() ?? delayMs()));
      if (token.isCancellationRequested) return { items: [] };
      const controller = new AbortController();
      const sub = token.onCancellationRequested(() => controller.abort());
      try {
        const { prefix, suffix } = here();
        const insert = await source.complete({
          path: upperDrive(model.uri.fsPath),
          languageId: model.getLanguageId(),
          prefix,
          suffix,
          line: position.lineNumber,
          signal: controller.signal,
        });
        if (!insert || token.isCancellationRequested) return { items: [] };
        return { items: [item(insert)] };
      } catch {
        return { items: [] };
      } finally {
        sub.dispose();
      }
    },
    disposeInlineCompletions() {},
  };
  const registration = monaco.languages.registerInlineCompletionsProvider(
    { pattern: "**" },
    provider,
  );
  const requery = source.hasCached ? askAgainAfterDeletes(source) : null;
  return {
    dispose: () => {
      registration.dispose();
      requery?.dispose();
    },
  };
}

/** The prefix and suffix the provider is asked with at `offset` of `model`. */
function at(model: monaco.editor.ITextModel, offset: number): { prefix: string; suffix: string } {
  const text = model.getValue();
  return {
    prefix: text.slice(Math.max(0, offset - 64_000), offset),
    suffix: text.slice(offset, offset + 24_000),
  };
}

/** Monaco's ghost-text controller, as far as asking its providers again goes (internal API). */
interface InlineCompletionsControllerShape {
  model?: { get(): { trigger(): Promise<void> } | undefined };
}
const INLINE_COMPLETIONS_CONTROLLER = "editor.contrib.inlineCompletionsController";

/**
 * Coming back to a spot shows its suggestion (m7.12). Monaco asks the provider again after
 * typing, pasting, and Backspace / Delete run as commands while the editor has the text focus,
 * and on any edit while a suggestion session is active. A word deleted (Ctrl+Backspace), a cut,
 * undo / redo, or a delete after the suggestion was dismissed (Esc, an arrow key, a click,
 * accepting) changed the text with no session: the cached suggestion for the spot was there and
 * never shown. After such an edit the provider is asked again, only when the cache has a
 * suggestion for the cursor's spot (so this never makes a model request).
 */
function askAgainAfterDeletes(source: InlineCompletionSource): Disposable {
  const watched = new Map<monaco.editor.ICodeEditor, monaco.IDisposable>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const watch = (editor: monaco.editor.ICodeEditor) => {
    if (watched.has(editor)) return;
    const changes = editor.onDidChangeModelContent((e) => {
      if (!editMayReturnToSuggestion(e.changes, e.isUndoing || e.isRedoing)) return;
      const model = editor.getModel();
      if (!model || (model.uri.scheme !== "file" && model.uri.scheme !== "notebook-cell")) return;
      if (!editor.getOption(monaco.editor.EditorOption.inlineSuggest).enabled) return;
      // The same file in a split: only the editor the user is in.
      if (
        !editor.hasTextFocus() &&
        monaco.editor
          .getEditors()
          .some((other) => other !== editor && other.getModel() === model && other.hasTextFocus())
      )
        return;
      // After Monaco's own handling of the edit (its trigger, if any, comes first).
      const timer = setTimeout(() => {
        timers.delete(timer);
        const selection = editor.getSelection();
        if (editor.getModel() !== model || !selection?.isEmpty()) return;
        const offset = model.getOffsetAt(selection.getPosition());
        if (!source.hasCached?.({ path: upperDrive(model.uri.fsPath), ...at(model, offset) }))
          return;
        const controller = editor.getContribution<
          monaco.editor.IEditorContribution & InlineCompletionsControllerShape
        >(INLINE_COMPLETIONS_CONTROLLER);
        // Not an explicit trigger: the provider answers from the cache, without a pause.
        void controller?.model
          ?.get()
          ?.trigger()
          .catch(() => undefined);
      }, 0);
      timers.add(timer);
    });
    const gone = editor.onDidDispose(() => {
      watched.get(editor)?.dispose();
      watched.delete(editor);
    });
    watched.set(editor, {
      dispose: () => {
        changes.dispose();
        gone.dispose();
      },
    });
  };
  for (const editor of monaco.editor.getEditors()) watch(editor);
  const created = monaco.editor.onDidCreateEditor(watch);
  return {
    dispose: () => {
      created.dispose();
      for (const d of watched.values()) d.dispose();
      watched.clear();
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}

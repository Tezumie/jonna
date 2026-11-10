// What an extension's language provider is asked about, from a Monaco model (extensionFeatures.ts,
// extensionProviders.ts): the document's IDE path (an untitled document's `untitled:` name, a
// notebook cell's `<notebook>.cell-<id>.<ext>` with the cell and its text), and Monaco's
// CancellationToken as an AbortSignal that reaches the extension's worker (VS Code's
// cancellation: no time limits, a request the editor drops is cancelled there too).
import type { FeatureContext } from "../../../workbench/extensionFeatures";
import { cellOfPath, type DocumentContext } from "../../../workbench/extensionProviders";
import * as monaco from "./core";

/** Aborts when Monaco cancels the request (the user typed on, moved away, closed the widget). */
export function abortSignal(token: monaco.CancellationToken): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  else {
    const sub = token.onCancellationRequested(() => {
      sub.dispose();
      controller.abort();
    });
  }
  return controller.signal;
}

/** `p`'s answer, or `fallback` when the provider failed or the request was cancelled. */
export function answerOf<T>(p: Promise<T>, fallback: T): Promise<T> {
  return p.catch(() => fallback);
}

/**
 * The IDE's path of a model: a file's path; an untitled document's `untitled:` name (its model
 * is a file Uri of that name); a notebook cell's editor name.
 */
export function modelPath(model: monaco.editor.ITextModel): string {
  const uri = model.uri;
  const fsPath = uri.scheme === "file" ? uri.fsPath : monaco.Uri.file(uri.path).fsPath;
  const untitled = /^[\\/]?(untitled:.*)$/.exec(fsPath)?.[1];
  return untitled ?? fsPath;
}

/** A notebook cell's notebook, id and text (the extension's cell document), or nothing. */
function cellPart(model: monaco.editor.ITextModel, path: string): Pick<DocumentContext, "cell"> {
  if (model.uri.scheme !== "notebook-cell") return {};
  const cell = cellOfPath(path);
  return cell ? { cell: { ...cell, text: model.getValue() } } : {};
}

export function documentContext(model: monaco.editor.ITextModel): DocumentContext {
  const path = modelPath(model);
  return { path, languageId: model.getLanguageId(), ...cellPart(model, path) };
}

export function positionContext(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): FeatureContext & Pick<DocumentContext, "cell"> {
  const word = model.getWordAtPosition(position);
  return {
    ...documentContext(model),
    line: position.lineNumber,
    column: position.column,
    word: word?.word ?? "",
    linePrefix: model.getLineContent(position.lineNumber).slice(0, position.column - 1),
  };
}

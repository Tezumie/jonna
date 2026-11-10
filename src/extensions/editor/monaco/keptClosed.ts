// Models of closed files kept for undo (D86): the file is closed, but its model lives on so undo
// survives a reopen. Language servers treat such a file as closed (didClose; their workspace
// problems for it show again, D218), and the built-in checkers' markers on it (they keep checking
// the model) stay out of Problems, as a closed file's would.
import { Emitter } from "../../../core/events/index";
import type * as monaco from "./core";

/** Kept models, each with its dispose listener (which forgets it). */
const kept = new Map<monaco.editor.ITextModel, monaco.IDisposable>();
const changed = new Emitter<{ model: monaco.editor.ITextModel; kept: boolean }>();

/** A closed file's model is kept (true), or its file was opened again (false). */
export const onDidChangeKeptClosed = changed.event;

export function isKeptClosed(model: monaco.editor.ITextModel): boolean {
  return kept.has(model);
}

export function setKeptClosed(model: monaco.editor.ITextModel, value: boolean): void {
  if (model.isDisposed() || kept.has(model) === value) return;
  if (value)
    kept.set(
      model,
      model.onWillDispose(() => {
        kept.get(model)?.dispose();
        kept.delete(model);
      }),
    );
  else {
    kept.get(model)?.dispose();
    kept.delete(model);
  }
  changed.fire({ model, kept: value });
}

// Merge conflicts in the editor (D120, like VS Code's): "Accept current change | Accept incoming
// change | Accept both changes | Resolve in merge editor" above each `<<<<<<<` block (they run
// editor.resolveConflict / git.openMergeEditor), and the two sides tinted. Models without markers cost one `includes` per edit.

import { findConflicts } from "../conflicts";
import type { EngineHost } from "../engine";
import * as monaco from "./core";

const COMMAND = "ide.resolveConflict";

export function registerConflictLens(host: EngineHost): void {
  monaco.editor.registerCommand(COMMAND, (_accessor, path: string, line: number, choice: string) =>
    choice === "mergeEditor"
      ? host.run("git.openMergeEditor", { path })
      : host.run("editor.resolveConflict", { path, line, choice }),
  );
  const changed = new monaco.Emitter<monaco.languages.CodeLensProvider>();
  const provider: monaco.languages.CodeLensProvider = {
    onDidChange: changed.event,
    provideCodeLenses: (model) => {
      if (model.uri.scheme !== "file") return { lenses: [], dispose() {} };
      const path = model.uri.fsPath;
      const lenses = findConflicts(model.getValue()).flatMap((c) => {
        const range = new monaco.Range(c.start, 1, c.start, 1);
        const lens = (title: string, choice: string) => ({
          range,
          command: { id: COMMAND, title, arguments: [path, c.start, choice] },
        });
        return [
          lens("Accept current change", "current"),
          lens("Accept incoming change", "incoming"),
          lens("Accept both changes", "both"),
          // The 3-way merge editor (D204), from any conflict of the file.
          lens("Resolve in merge editor", "mergeEditor"),
        ];
      });
      return { lenses, dispose() {} };
    },
  };
  monaco.languages.registerCodeLensProvider("*", provider);
  monaco.editor.onDidCreateModel((model) => {
    let ids: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const conflicts = findConflicts(model.getValue());
      const whole = (from: number, to: number, className: string) =>
        to < from
          ? []
          : [
              {
                range: new monaco.Range(from, 1, to, 1),
                options: { isWholeLine: true, className },
              },
            ];
      ids = model.deltaDecorations(
        ids,
        conflicts.flatMap((c) => [
          ...whole(c.start, c.start, "conflict-current-header"),
          ...whole(c.start + 1, (c.base ?? c.separator) - 1, "conflict-current"),
          ...(c.base !== undefined ? whole(c.base, c.separator - 1, "conflict-base") : []),
          ...whole(c.separator + 1, c.end - 1, "conflict-incoming"),
          ...whole(c.end, c.end, "conflict-incoming-header"),
        ]),
      );
    };
    if (model.getValue().includes("<<<<<<<")) update();
    const sub = model.onDidChangeContent(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (model.isDisposed()) return;
        if (ids.length || model.getValue().includes("<<<<<<<")) {
          update();
          changed.fire(provider);
        }
      }, 250);
    });
    model.onWillDispose(() => {
      clearTimeout(timer);
      sub.dispose();
    });
  });
}

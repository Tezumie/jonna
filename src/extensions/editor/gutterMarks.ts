// Other extensions' marks in editors' margins (services.gutterMarks: bookmarks, D143): drawn in
// every editor showing their file, and moved with their lines as text is edited (reported back
// so the stored lines follow).
import { type DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { pathKey } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import type { EngineEditor } from "./engine";
import type { EditorView } from "./view";

export function registerGutterMarks(
  sub: DisposableStore,
  services: WorkbenchServices,
  views: Map<string, EditorView>,
): void {
  const { gutterMarks } = services;
  /** Per editor and owner: what was drawn last. */
  const drawn = new Map<EngineEditor, Map<string, string>>();
  sub.add(
    effect(() => {
      const all = gutterMarks.marks.value;
      services.dock.root.value;
      const live = new Set<EngineEditor>();
      for (const view of views.values()) {
        const editor = view.engineEditor;
        const model = view.doc?.model.value;
        const path = view.doc?.path.value;
        if (!editor || !model || !path) continue;
        live.add(editor);
        const seen = drawn.get(editor) ?? new Map<string, string>();
        drawn.set(editor, seen);
        for (const [owner, byPath] of all) {
          const marks = (byPath.get(pathKey(path)) ?? []).filter((m) => m.line <= model.lineCount);
          const key = JSON.stringify([path, marks]);
          if (seen.get(owner) === key) continue;
          editor.setLineMarks(owner, marks);
          seen.set(owner, key);
        }
      }
      for (const editor of drawn.keys()) if (!live.has(editor)) drawn.delete(editor);
      return undefined;
    }),
  );
  sub.add(
    services.documents.onDidChange((path) => {
      for (const [owner, byPath] of gutterMarks.marks.peek()) {
        const marks = byPath.get(pathKey(path));
        if (!marks?.length) continue;
        for (const view of views.values()) {
          const p = view.doc?.path.value;
          const editor = view.engineEditor;
          if (!editor || !p || pathKey(p) !== pathKey(path)) continue;
          const lines = editor.lineMarkLines(owner);
          if (lines.length === marks.length && lines.some((l, i) => l !== marks[i]?.line))
            gutterMarks.moved(owner, path, lines);
          break;
        }
      }
    }),
  );
  // Text before lines (the file blame, D204): every editor of the file, again when one opens.
  const annotated = new Map<EngineEditor, { list: readonly unknown[]; model: unknown }>();
  sub.add(
    effect(() => {
      const all = gutterMarks.annotations.value;
      services.dock.root.value;
      const live = new Set<EngineEditor>();
      for (const view of views.values()) {
        const editor = view.engineEditor;
        const path = view.doc?.path.value;
        const model = view.doc?.model.value;
        if (!editor || !path || !model) continue;
        live.add(editor);
        const list = all.get(pathKey(path)) ?? [];
        const before = annotated.get(editor);
        if (before?.list === list && before.model === model) continue;
        editor.setLineAnnotations(list);
        annotated.set(editor, { list, model });
      }
      for (const editor of annotated.keys()) if (!live.has(editor)) annotated.delete(editor);
      return undefined;
    }),
  );
  sub.add(toDisposable(() => drawn.clear()));
  sub.add(toDisposable(() => annotated.clear()));
}

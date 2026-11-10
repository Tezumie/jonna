// Inline diagnostics (D140), like the Error Lens extension: the most severe problem of a line is
// written after it, in the problem's color, with a faint tint on the line — no hovering over a
// squiggle to read it. `editor.inlineDiagnostics` picks which severities ("off", "errors",
// "errorsAndWarnings", "all"). Applied to every visible editor when problems, tabs or the setting
// change.
import type { DisposableStore } from "../../core/lifecycle/index";
import { type Disposable, toDisposable } from "../../core/lifecycle/index";
import { pathKey } from "../../core/paths/index";
import { effect, type ReadonlySignal } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import type { Diagnostic, DiagnosticSeverity } from "./engine";
import type { EditorView } from "./view";

export type InlineDiagnosticsMode = "off" | "errors" | "errorsAndWarnings" | "all";

const RANK: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2, hint: 3 };
const SHOWN: Record<InlineDiagnosticsMode, number> = {
  off: -1,
  errors: 0,
  errorsAndWarnings: 1,
  all: 2,
};
/** Long messages are cut; the hover still has the whole text. */
const MAX_CHARS = 160;

/** Per line of `path`: the problem to show (most severe, then first), within `mode`. */
export function lineDiagnostics(
  all: readonly Diagnostic[],
  path: string,
  mode: InlineDiagnosticsMode,
): Map<number, Diagnostic> {
  const out = new Map<number, Diagnostic>();
  const key = pathKey(path);
  const limit = SHOWN[mode] ?? -1;
  for (const d of all) {
    if (RANK[d.severity] > limit || pathKey(d.path) !== key) continue;
    const prev = out.get(d.line);
    if (!prev || RANK[d.severity] < RANK[prev.severity]) out.set(d.line, d);
  }
  return out;
}

/** The text after the line: the first line of the message, shortened. */
export function inlineText(d: Diagnostic): string {
  const first = d.message.split("\n")[0]?.trim() ?? "";
  const text = first.length > MAX_CHARS ? `${first.slice(0, MAX_CHARS - 1)}…` : first;
  return `    ${text}`;
}

export function registerInlineDiagnostics(
  sub: DisposableStore,
  services: WorkbenchServices,
  views: Map<string, EditorView>,
  diagnostics: ReadonlySignal<readonly Diagnostic[]>,
): void {
  const applied = new Map<EditorView, { key: string; marks: Disposable[] }>();
  const clear = (view: EditorView) => {
    for (const m of applied.get(view)?.marks ?? []) m.dispose();
    applied.delete(view);
  };
  sub.add(
    effect(() => {
      const mode =
        services.settings.get<InlineDiagnosticsMode | undefined>("editor.inlineDiagnostics") ??
        "errorsAndWarnings";
      const all = diagnostics.value;
      services.dock.root.value;
      const open = new Set(views.values());
      for (const view of [...applied.keys()]) if (!open.has(view)) clear(view);
      // Each file's diagnostics, grouped once (D379): not every diagnostic scanned per editor.
      const byFile = new Map<string, Diagnostic[]>();
      for (const d of all) {
        const k = pathKey(d.path);
        const list = byFile.get(k);
        if (list) list.push(d);
        else byFile.set(k, [d]);
      }
      for (const view of open) {
        const editor = view.engineEditor;
        const doc = view.doc;
        // Re-run when this file's text loads (the editor appears then).
        const model = doc?.model.value;
        const path = doc?.path.value;
        if (!editor || !model || !path) {
          clear(view);
          continue;
        }
        const lines = lineDiagnostics(byFile.get(pathKey(path)) ?? [], path, mode);
        const key = JSON.stringify([path, [...lines].map(([l, d]) => [l, d.severity, d.message])]);
        if (applied.get(view)?.key === key) continue;
        clear(view);
        const marks: Disposable[] = [];
        for (const [line, d] of lines) {
          if (line > model.lineCount) continue;
          marks.push(
            editor.annotateLine(line, inlineText(d), `inline-diagnostic is-${d.severity}`),
          );
          marks.push(
            editor.decorateLines(
              { startLine: line, endLine: line },
              `inline-diagnostic-line is-${d.severity}`,
            ),
          );
        }
        applied.set(view, { key, marks });
      }
      return undefined;
    }),
  );
  sub.add(toDisposable(() => [...applied.keys()].forEach(clear)));
}

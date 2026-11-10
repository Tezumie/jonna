// The debugger in editors (D143): breakpoint dots in the glyph margin (`services.debugMarks`),
// the arrow and highlight on the line a stopped session is at, clicks in the margin (the debug
// extension toggles a breakpoint), and breakpoints that moved with their lines as text was
// edited (reported back so the stored lines follow, as in VS Code).
import { h, on } from "../../core/dom/index";
import { type DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { pathKey } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import { icon } from "../../ui/Icon";
import type { WorkbenchServices } from "../../workbench/services";
import type { EditorEngine, EngineEditor } from "./engine";
import type { EditorView } from "./view";

export function registerDebugMarks(
  sub: DisposableStore,
  services: WorkbenchServices,
  views: Map<string, EditorView>,
  whenEngine: (fn: (engine: EditorEngine) => void) => void,
): void {
  const marks = services.debugMarks;
  /** Per editor: the click listener, and what was drawn last. */
  const wired = new Map<EngineEditor, { dispose(): void; key: string; exec: string }>();
  const pathOf = (view: EditorView) => view.doc?.path.value;

  sub.add(
    effect(() => {
      const all = marks.breakpoints.value;
      const exec = marks.execution.value;
      services.dock.root.value;
      const live = new Set<EngineEditor>();
      for (const view of views.values()) {
        const editor = view.engineEditor;
        const doc = view.doc;
        const model = doc?.model.value;
        const path = doc?.path.value;
        if (!editor || !model || !path) continue;
        live.add(editor);
        let entry = wired.get(editor);
        if (!entry) {
          const listener = editor.onGutterClick((line) => {
            const p = pathOf(view);
            if (p) marks.gutterClick(p, line);
          });
          entry = { dispose: () => listener.dispose(), key: "", exec: "" };
          wired.set(editor, entry);
        }
        const glyphs = (all.get(pathKey(path)) ?? []).filter((g) => g.line <= model.lineCount);
        const key = JSON.stringify([path, glyphs]);
        if (entry.key !== key) {
          editor.setBreakpoints(glyphs);
          entry.key = key;
        }
        const line = exec && pathKey(exec.path) === pathKey(path) ? exec.line : null;
        const execKey = `${path}:${line}`;
        if (entry.exec !== execKey) {
          editor.setExecutionLine(line);
          entry.exec = execKey;
        }
      }
      for (const [editor, entry] of wired)
        if (!live.has(editor)) {
          entry.dispose();
          wired.delete(editor);
        }
      return undefined;
    }),
  );

  // The exception widget (D204): a zone under the line stopped at on an exception, as in VS Code;
  // its close button hides it until the next stop.
  const zones = new Map<EngineEditor, { key: string; dispose(): void }>();
  let dismissed = "";
  const drawException = () => {
    const ex = marks.exception.peek();
    const key = ex ? JSON.stringify(ex) : "";
    const live = new Set<EngineEditor>();
    for (const view of views.values()) {
      const editor = view.engineEditor;
      const path = pathOf(view);
      if (!editor || !path || !ex || key === dismissed || pathKey(ex.path) !== pathKey(path))
        continue;
      live.add(editor);
      if (zones.get(editor)?.key === key) continue;
      zones.get(editor)?.dispose();
      const close = h(
        "button",
        { class: "icon-button debug-exception-close", type: "button", "aria-label": "Close" },
        icon("x"),
      );
      const node = h(
        "div",
        { class: "debug-exception-widget", role: "alert" },
        h("div", { class: "debug-exception-title" }, ex.title, close),
        ex.message ? h("div", { class: "debug-exception-message" }, ex.message) : null,
        ...ex.stack.map((line) => h("div", { class: "debug-exception-stack" }, line)),
        ex.more ? h("div", { class: "debug-exception-stack" }, `… ${ex.more} more`) : null,
      );
      const lineHeight = editor.lineHeight();
      const rows = 1 + (ex.message ? 1 : 0) + ex.stack.length + (ex.more ? 1 : 0);
      const zone = editor.addZone(ex.line, node, rows * lineHeight + 16);
      // The message may wrap: size the zone to what was drawn.
      const frame = requestAnimationFrame(() => {
        if (node.isConnected && node.offsetHeight > 0) zone.setHeight(node.offsetHeight + 4);
      });
      const onClose = on(close, "click", () => {
        dismissed = key;
        drawException();
      });
      zones.set(editor, {
        key,
        dispose: () => {
          cancelAnimationFrame(frame);
          onClose.dispose();
          zone.dispose();
        },
      });
    }
    for (const [editor, z] of zones)
      if (!live.has(editor)) {
        z.dispose();
        zones.delete(editor);
      }
  };
  sub.add(
    effect(() => {
      marks.exception.value;
      services.dock.root.value;
      drawException();
      return undefined;
    }),
  );
  sub.add(
    toDisposable(() => {
      for (const z of zones.values()) z.dispose();
      zones.clear();
    }),
  );

  // Values on hover while paused.
  sub.add(
    effect(() => {
      const source = marks.hover.value;
      whenEngine((engine) => engine.setDebugHover(source));
      return undefined;
    }),
  );

  // Edits move the dots (the engine tracks them); the stored lines follow.
  sub.add(
    services.documents.onDidChange((path) => {
      const glyphs = marks.glyphs(path);
      if (!glyphs.length) return;
      for (const view of views.values()) {
        const p = pathOf(view);
        const editor = view.engineEditor;
        if (!editor || !p || pathKey(p) !== pathKey(path)) continue;
        const lines = editor.breakpointLines();
        if (lines.length !== glyphs.length) return;
        if (lines.some((l, i) => l !== glyphs[i]?.line)) marks.moved(path, lines);
        return;
      }
    }),
  );
  sub.add(
    toDisposable(() => {
      for (const entry of wired.values()) entry.dispose();
      wired.clear();
    }),
  );
}

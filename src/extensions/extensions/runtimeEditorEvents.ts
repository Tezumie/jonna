// The active text editor's events for extensions (D234, VS Code's window.onDidChangeActiveTextEditor,
// onDidChangeTextEditorSelection and onDidChangeTextEditorVisibleRanges): `editor.didChangeActive`,
// `editor.didChangeSelection` and `editor.didChangeVisibleRange` through `ide.events.on`. They
// need "fs.read" (they say which file is open and where). One tracker per extension reads
// ide://editors/active after the editor's activity (cursor moves, scrolling, focus) or a layout
// change, at most every 100 ms, and tells each subscriber what changed. Paths outside the folder
// (and not of an extension's file system) are reported as null. The active notebook and its
// selected cells (`notebook.didChangeEditor`, D265: VS Code's activeNotebookEditor) come from
// ide://notebook the same way, also after clicks and keys (selecting cells moves no cursor).

import { on } from "../../core/dom/index";
import { type Disposable, DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { uriScheme } from "../../workbench/extensionRegistries";
import type { WorkbenchServices } from "../../workbench/services";

export const EDITOR_EVENTS = [
  "editor.didChangeActive",
  "editor.didChangeSelection",
  "editor.didChangeVisibleRange",
  "notebook.didChangeEditor",
] as const;

export type EditorEventType = (typeof EDITOR_EVENTS)[number];

interface Snapshot {
  path: string | null;
  language: string;
  selections: { startLine: number; startColumn: number; endLine: number; endColumn: number }[];
  visibleRange: { startLine: number; endLine: number } | null;
  /** The active notebook (a notebook tab is active): its selected cells' indexes. */
  notebook?: { path: string; selection: number[] } | null;
}

/** What changed between two snapshots, as the events' payloads (DOM-free; tested). */
export function editorChanges(
  before: Snapshot | null,
  now: Snapshot,
): Partial<Record<EditorEventType, unknown>> {
  const out: Partial<Record<EditorEventType, unknown>> = {};
  if (JSON.stringify(before?.notebook ?? null) !== JSON.stringify(now.notebook ?? null))
    out["notebook.didChangeEditor"] = now.notebook ?? null;
  if (before?.path !== now.path || before?.language !== now.language)
    out["editor.didChangeActive"] = now.path ? { path: now.path, language: now.language } : null;
  if (!now.path) return out;
  if (
    before?.path !== now.path ||
    JSON.stringify(before.selections) !== JSON.stringify(now.selections)
  )
    out["editor.didChangeSelection"] = { path: now.path, selections: now.selections };
  if (
    now.visibleRange &&
    (before?.path !== now.path ||
      JSON.stringify(before.visibleRange) !== JSON.stringify(now.visibleRange))
  )
    out["editor.didChangeVisibleRange"] = { path: now.path, ...now.visibleRange };
  return out;
}

type ActiveState = {
  absolutePath?: string | null;
  language?: string;
  selections?: { start: { line: number; column: number }; end: { line: number; column: number } }[];
  visibleRange?: { startLine: number; endLine: number };
} | null;

export class ExtensionEditorEvents implements Disposable {
  private readonly listeners = new Map<string, { type: EditorEventType; send(p: unknown): void }>();
  private tracker: DisposableStore | null = null;
  private last: Snapshot | null = null;

  constructor(private readonly services: WorkbenchServices) {}

  subscribe(sub: string, type: EditorEventType, send: (payload: unknown) => void): Disposable {
    this.listeners.set(sub, { type, send });
    this.start();
    return toDisposable(() => {
      this.listeners.delete(sub);
      if (!this.listeners.size) this.stop();
    });
  }

  private start(): void {
    if (this.tracker) return;
    const store = new DisposableStore();
    this.tracker = store;
    let timer = 0;
    const soon = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void this.check(), 100);
    };
    store.add(toDisposable(() => window.clearTimeout(timer)));
    // What's shown now is the starting point (VS Code's events fire on changes only).
    void this.check(true);
    store.add(this.services.documents.onDidScroll(soon));
    // Cells selected with the mouse or keys (no cursor or tab change says so).
    store.add(on(window, "pointerup", soon));
    store.add(on(window, "keyup", soon));
    // Tabs opened, closed or switched (the last editor closing moves no cursor).
    store.add(
      effect(() => {
        this.services.dock.root.value;
        soon();
        return undefined;
      }),
    );
  }

  private stop(): void {
    this.tracker?.dispose();
    this.tracker = null;
    this.last = null;
  }

  private visible(path: string | null | undefined): string | null {
    if (!path) return null;
    // An untitled document or notebook (D267): nothing on disk to keep from it.
    if (path.startsWith("untitled:")) return path;
    if (uriScheme(path))
      return this.services.extensionFeatures.fileSystems.owns(path) ? path : null;
    // A file in any of the workspace's folders (D251).
    return this.services.workspace.contains(path) ? path : null;
  }

  private async check(prime = false): Promise<void> {
    if (!this.tracker) return;
    const { state } = this.services;
    const v = state.has("ide://editors/active")
      ? ((await state.get("ide://editors/active").catch(() => null))?.value as ActiveState)
      : null;
    if (!this.tracker) return;
    const path = this.visible(v?.absolutePath);
    const now: Snapshot = {
      path,
      language: path ? (v?.language ?? "") : "",
      selections: path
        ? (v?.selections ?? []).slice(0, 100).map((s) => ({
            startLine: s.start.line,
            startColumn: s.start.column,
            endLine: s.end.line,
            endColumn: s.end.column,
          }))
        : [],
      visibleRange: path ? (v?.visibleRange ?? null) : null,
      notebook: await this.activeNotebook(),
    };
    if (!this.tracker) return;
    const changes = editorChanges(this.last, now);
    this.last = now;
    if (prime) return;
    for (const l of this.listeners.values()) if (l.type in changes) l.send(changes[l.type] ?? null);
  }

  /** The active notebook tab's path and selected cells (null when a notebook isn't active). */
  private async activeNotebook(): Promise<Snapshot["notebook"]> {
    const { state } = this.services;
    if (!state.has("ide://notebook")) return null;
    const nb = (await state.get("ide://notebook").catch(() => null))?.value as {
      active?: { path?: string; selection?: string[]; cells?: { id: string }[] } | null;
    } | null;
    const active = nb?.active;
    const path = this.visible(active?.path);
    if (!active || !path) return null;
    const ids = (active.cells ?? []).map((c) => c.id);
    return {
      path,
      selection: (active.selection ?? []).map((id) => ids.indexOf(id)).filter((i) => i >= 0),
    };
  }

  dispose(): void {
    this.listeners.clear();
    this.stop();
  }
}

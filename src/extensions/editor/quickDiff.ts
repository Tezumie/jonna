// Quick diff in the editor (DESIGN.md §15.1): 3px gutter bars for lines added / modified / deleted
// against the git index, recomputed (debounced) as the buffer changes and when the index moves.
// Also registers open documents as the text source for hunk staging (unsaved edits count, reverts
// are one undoable edit), and offers "Stage change" / "Revert change" for the editor menu.
import {
  changeAtLine,
  diffLines,
  type LineChange,
  lineMarks,
  splitLines,
  stagedMarks,
} from "../../core/diff/index";
import type { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import type { MenuItem } from "../../ui/Menu";
import type { QuickDiffBase, WorkbenchServices } from "../../workbench/services";
import type { EditorDocument, EditorService } from "./service";

const DEBOUNCE_MS = 200;

export interface QuickDiffMenu {
  /** Menu entries for the change under `line` of `path` (none when the line is unchanged). */
  items(path: string, line: number): MenuItem[];
}

export function registerQuickDiff(
  sub: DisposableStore,
  services: WorkbenchServices,
  editors: EditorService,
): QuickDiffMenu {
  const { quickDiff, dispatcher } = services;
  // git.quickDiffBase (D200): the index (VS Code), HEAD, or the default branch's merge base.
  const quickDiffBase = (): QuickDiffBase => {
    const v = services.settings.peek<string>("git.quickDiffBase");
    return v === "head" || v === "mergeBase" ? v : "index";
  };
  // "quickDiffBase:head" / ":mergeBase": the text the bars compare with, for the diff a bar
  // click opens when they aren't against the index (D201).
  sub.add(
    quickDiff.registerContent("quickDiffBase:", (path, scheme) => {
      const which = scheme.slice("quickDiffBase:".length);
      return which === "head" || which === "mergeBase"
        ? quickDiff.original(path, which)
        : Promise.resolve(null);
    }),
  );
  const changes = new Map<EditorDocument, LineChange[]>();
  const bases = new Map<EditorDocument, string | null>();
  /** HEAD's text when the bars are against the index: staged lines show dimmed (D203). */
  const heads = new Map<EditorDocument, string | null>();
  const timers = new Map<EditorDocument, ReturnType<typeof setTimeout>>();
  // Keyed by document, not model: a closed file keeps its model (undo history) and reopening
  // binds that same model to a new document, which still needs its own listener.
  const bound = new WeakMap<EditorDocument, object>();

  const update = (doc: EditorDocument, refetch: boolean) => {
    clearTimeout(timers.get(doc));
    timers.set(
      doc,
      setTimeout(
        async () => {
          timers.delete(doc);
          const model = doc.model.peek();
          if (!model || doc.kind !== "text") return;
          let base = bases.get(doc);
          let head = heads.get(doc);
          const mode = quickDiffBase();
          if (refetch || base === undefined || head === undefined) {
            [base, head] = await Promise.all([
              quickDiff.original(doc.path.peek(), mode),
              mode === "index" ? quickDiff.original(doc.path.peek(), "head") : null,
            ]);
            // Closed (or given a new model) meanwhile: its entries were dropped and stay so, or the
            // maps would keep the document (and its text) alive.
            if (doc.model.peek() !== model) return;
            bases.set(doc, base);
            heads.set(doc, head);
          }
          if (doc.model.peek() !== model) return;
          // Nothing to compare with (not in a repository, untracked): the text isn't read at all.
          const lines = base === null && head === null ? [] : splitLines(model.getText());
          const list = base === null ? [] : diffLines(splitLines(base.replace(/^﻿/, "")), lines);
          changes.set(doc, list);
          const marks = lineMarks(list);
          // Against the index, what's staged shows too, dimmed (VS Code). Nothing staged: HEAD
          // and the index are the same text.
          const staged =
            head !== null && base !== null && head !== base
              ? stagedMarks(lineMarks(diffLines(splitLines(head.replace(/^﻿/, "")), lines)), marks)
              : [];
          model.setLineMarks([...marks, ...staged]);
        },
        refetch ? 0 : DEBOUNCE_MS,
      ),
    );
  };

  sub.add(
    effect(() => {
      for (const doc of editors.documents.value) {
        const model = doc.model.value;
        if (!model || bound.get(doc) === model || doc.kind !== "text") continue;
        bound.set(doc, model);
        bases.delete(doc);
        heads.delete(doc);
        doc.subscriptions.add(model.onDidChangeContent(() => update(doc, false)));
        doc.subscriptions.add({
          dispose: () => {
            clearTimeout(timers.get(doc));
            timers.delete(doc);
            changes.delete(doc);
            bases.delete(doc);
            heads.delete(doc);
          },
        });
        update(doc, true);
      }
      return undefined;
    }),
  );
  sub.add(
    quickDiff.onDidChange(() => {
      for (const doc of editors.documents.peek()) if (doc.model.peek()) update(doc, true);
    }),
  );
  let lastBase = quickDiffBase();
  sub.add(
    effect(() => {
      services.settings.version.value;
      const now = quickDiffBase();
      if (now === lastBase) return undefined;
      lastBase = now;
      for (const doc of editors.documents.peek()) if (doc.model.peek()) update(doc, true);
      return undefined;
    }),
  );
  sub.add({
    dispose: () => {
      for (const t of timers.values()) clearTimeout(t);
    },
  });

  sub.add(
    quickDiff.setDocuments({
      read: (path) => {
        const doc = editors.find(path);
        return doc?.kind === "text" ? (doc.model.peek()?.getText() ?? null) : null;
      },
      write: async (path, text) => {
        const doc = editors.find(path);
        const model = doc?.model.peek();
        if (!doc || !model || doc.kind !== "text") return false;
        const wasClean = !doc.dirty.peek();
        model.replaceText(text);
        // A clean file stays clean (the revert is saved); unsaved edits stay unsaved.
        if (wasClean) await editors.save(doc);
        return true;
      },
      encoding: (path) => editors.find(path)?.encoding ?? null,
    }),
  );

  return {
    items: (path, line) => {
      const doc = editors.find(path);
      const list = doc ? changes.get(doc) : undefined;
      if (!list || !changeAtLine(list, line)) return [];
      const run = (command: string) => () =>
        void dispatcher.execute(command, { path, line }).catch(() => {});
      return [
        { label: "Stage change", icon: "plus", run: run("git.stageChange") },
        {
          label: "Stage selected lines",
          icon: "plus",
          run: () => void dispatcher.execute("git.stageSelectedRanges", {}).catch(() => {}),
        },
        { label: "Revert change", icon: "undo-2", run: run("git.revertChange") },
      ];
    },
  };
}

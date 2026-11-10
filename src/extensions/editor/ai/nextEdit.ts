// Next-edit suggestions (D193): with editor.nextEdit.enabled (off by default, like every AI
// feature outside the chat), a pause after the user changes some lines asks the model what should
// change next. The suggestion shows under its lines — the lines tinted, their new text below in a
// box — and Tab goes there; Tab again applies it, Esc (or typing anything else) drops it. It never
// changes the file on its own. The completion model answers (agent.completionModel).

import { h } from "../../../core/dom/index";
import type { DisposableStore } from "../../../core/lifecycle/index";
import { DisposableStore as Store } from "../../../core/lifecycle/index";
import { effect } from "../../../core/reactive/index";
import { s } from "../../../core/schema/index";
import type { WorkbenchServices } from "../../../workbench/services";
import type { EngineEditor } from "../engine";
import { documentLanguage } from "../service";
import type { EditorView } from "../view";
import { LruMap } from "./cache";
import { NEXT_EDIT_SYSTEM, type NextEdit, nextEditPrompt, parseNextEdit } from "./nextEditPrompt";

const PAUSE_MS = 750;
const MAX_TOKENS = 600;

interface Shown {
  view: EditorView;
  edit: NextEdit;
  version: number;
  marks: Store;
}

export function registerNextEdit(
  sub: DisposableStore,
  services: WorkbenchServices,
  views: Map<string, EditorView>,
  activeView: () => EditorView | undefined,
): void {
  const { settings, languageModel, context, dispatcher } = services;
  const enabled = () => settings.peek<boolean>("editor.nextEdit.enabled") === true;
  /** Per view: its listeners, and the text as it was before the user's latest change. */
  const attached = new Map<
    EditorView,
    { store: Store; settled: string; path: string; lastBefore: string | null }
  >();
  /** The request in flight, if any. */
  let inflight: Promise<NextEdit | null> | null = null;
  let shown: Shown | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: AbortController | null = null;
  /** While a suggestion is applied (its own change isn't "the user typed"). */
  let applying = false;
  /** Predictions by their exact prompt (D224, cache.ts); asked for explicitly, the model answers anew. */
  const predictions = new LruMap<string, NextEdit | null>(32, 10 * 60_000);
  let requests = 0;
  let cacheHits = 0;

  const textOf = (view: EditorView) =>
    view.doc?.model.peek()?.getText().replace(/\r\n/g, "\n") ?? "";
  const versionOf = (view: EditorView) => view.doc?.model.peek()?.versionId ?? -1;

  const hide = () => {
    shown?.marks.dispose();
    shown = null;
    context.set("nextEditVisible", false);
  };
  const cancel = () => {
    clearTimeout(timer);
    abort?.abort();
    abort = null;
  };
  sub.add({
    dispose: () => {
      cancel();
      hide();
      for (const a of attached.values()) a.store.dispose();
    },
  });

  const show = (view: EditorView, editor: EngineEditor, edit: NextEdit) => {
    hide();
    const marks = new Store();
    marks.add(
      editor.decorateLines(
        { startLine: edit.startLine, endLine: edit.endLine },
        "next-edit-target",
      ),
    );
    const lines = edit.text.split("\n");
    const hint = h("span", { class: "next-edit-hint" });
    const node = h(
      "div",
      { class: "next-edit" },
      h("div", { class: "next-edit-head" }, h("span", null, "Next edit"), hint),
      h("pre", { class: "next-edit-text" }, edit.text || " "),
    );
    const zone = editor.addZone(edit.endLine, node, (lines.length + 1) * editor.lineHeight() + 8);
    marks.add(zone);
    const inside = () => {
      const line = editor.activeState()?.cursor.line ?? 0;
      return line >= edit.startLine && line <= edit.endLine;
    };
    const label = () => {
      hint.textContent = inside()
        ? "Tab to apply · Esc to dismiss"
        : "Tab to go there · Esc to dismiss";
    };
    label();
    marks.add(editor.onDidChangeCursor(label));
    shown = { view, edit, version: versionOf(view), marks };
    context.set("nextEditVisible", true);
  };

  /** Asks the model about `view`'s latest change; shows what it suggests. */
  const predict = async (view: EditorView, fresh: boolean): Promise<NextEdit | null> => {
    const editor = view.engineEditor;
    const doc = view.doc;
    const a = attached.get(view);
    if (!editor || !doc || !a || !languageModel.model("nextEdit")) return null;
    const text = textOf(view);
    const before = a.settled;
    a.settled = text;
    a.lastBefore = before;
    if (before === text) return null;
    const cursorLine = editor.activeState()?.cursor.line ?? 1;
    cancel();
    const controller = new AbortController();
    abort = controller;
    const version = versionOf(view);
    const prompt = nextEditPrompt({
      path: doc.path.peek(),
      languageId: documentLanguage(doc),
      text,
      before,
      cursorLine,
    });
    // The same change in the same lines (undo / redo, a change made again): the answer it had.
    const key = `${languageModel.model("nextEdit") ?? ""}\u0000${doc.path.peek()}\u0000${prompt}`;
    const known = fresh ? undefined : predictions.get(key);
    let edit: NextEdit | null;
    if (known !== undefined) {
      cacheHits++;
      if (abort === controller) abort = null;
      edit = known;
    } else {
      requests++;
      let failed = false;
      const reply = await languageModel
        .generate({
          purpose: "nextEdit",
          system: NEXT_EDIT_SYSTEM,
          prompt,
          maxTokens: MAX_TOKENS,
          signal: controller.signal,
        })
        .catch(() => {
          failed = true;
          return "";
        });
      if (abort === controller) abort = null;
      if (controller.signal.aborted) return null;
      edit = parseNextEdit(reply, text, cursorLine);
      if (!failed) predictions.set(key, edit);
    }
    // Stale: the user went on typing (or moved to another file).
    if (controller.signal.aborted || versionOf(view) !== version || activeView() !== view)
      return null;
    if (edit) show(view, editor, edit);
    return edit;
  };

  /** `predict`, remembered as the request in flight. */
  const run = (view: EditorView, fresh = false): Promise<NextEdit | null> => {
    const p = predict(view, fresh).finally(() => {
      if (inflight === p) inflight = null;
    });
    inflight = p;
    return p;
  };

  const apply = (): NextEdit | null => {
    const s0 = shown;
    if (!s0) return null;
    const editor = s0.view.engineEditor;
    if (!editor || versionOf(s0.view) !== s0.version) {
      hide();
      return null;
    }
    applying = true;
    try {
      editor.replaceLines({ startLine: s0.edit.startLine, endLine: s0.edit.endLine }, s0.edit.text);
    } finally {
      applying = false;
    }
    const a = attached.get(s0.view);
    // The applied edit is the latest change: the next prediction follows from it.
    if (a) {
      a.settled = textOf(s0.view);
      clearTimeout(timer);
      timer = setTimeout(() => void predictAfterApply(s0.view), PAUSE_MS);
    }
    hide();
    return s0.edit;
  };
  // After applying, ask again (renames ripple: the next use is the next suggestion), comparing
  // against the text before the applied edit so the model sees the change.
  let beforeApply = "";
  const predictAfterApply = async (view: EditorView) => {
    const a = attached.get(view);
    if (!a || !beforeApply) return;
    a.settled = beforeApply;
    beforeApply = "";
    await run(view);
  };

  const attach = (view: EditorView) => {
    const editor = view.engineEditor;
    const model = view.doc?.model.peek();
    const path = view.doc?.path.peek() ?? "";
    const existing = attached.get(view);
    if (existing && existing.path === path) return;
    existing?.store.dispose();
    if (!editor || !model) return;
    const store = new Store();
    const entry = { store, settled: textOf(view), path, lastBefore: null as string | null };
    attached.set(view, entry);
    store.add(
      model.onDidChangeContent(() => {
        if (applying) return;
        if (shown?.view === view) hide();
        cancel();
        if (!enabled() || activeView() !== view) {
          entry.settled = textOf(view);
          return;
        }
        timer = setTimeout(() => void run(view), PAUSE_MS);
      }),
    );
    store.add(
      editor.onKeyDown((e) => {
        if (!shown || shown.view !== view) return;
        if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
        if (e.key === "Escape") {
          e.preventDefault();
          hide();
        } else if (e.key === "Tab" && !editor.hasOpenWidget() && !editor.tabTaken?.()) {
          e.preventDefault();
          const line = editor.activeState()?.cursor.line ?? 0;
          const { startLine, endLine } = shown.edit;
          if (line >= startLine && line <= endLine) {
            beforeApply = textOf(view);
            apply();
          } else editor.revealPosition(startLine, 1);
        }
      }),
    );
  };

  sub.add(
    effect(() => {
      settings.version.value;
      services.dock.root.value;
      const on = enabled();
      if (!on) {
        cancel();
        hide();
        predictions.clear();
      }
      for (const view of [...attached.keys()])
        if (!on || ![...views.values()].includes(view)) {
          attached.get(view)?.store.dispose();
          attached.delete(view);
        }
      if (on)
        for (const view of views.values()) {
          // Re-run when a file's text loads (its editor appears then).
          view.doc?.model.value;
          attach(view);
        }
      return undefined;
    }),
  );

  const requireOn = () => {
    if (!enabled()) throw new Error("Next-edit suggestions are off (editor.nextEdit.enabled).");
  };
  sub.add(
    dispatcher.register({
      id: "editor.nextEdit.suggest",
      title: "Suggest the next edit",
      category: "Edit",
      description:
        "Asks the model now what should change next after the latest edit in the active editor, and shows it (Tab goes there, Tab applies). Returns the suggestion (lines and text) or null.",
      input: s.empty(),
      effects: [],
      when: "activeEditor && nextEditEnabled",
      agent: "hidden",
      run: async () => {
        requireOn();
        const view = activeView();
        if (!view) throw new Error("No editor is active.");
        attach(view);
        if (inflight) await inflight;
        if (shown?.view === view) return { suggestion: shown.edit };
        // Already asked about this change (the pause after typing): ask again, now.
        const a = attached.get(view);
        if (a && a.settled === textOf(view) && a.lastBefore !== null) a.settled = a.lastBefore;
        return { suggestion: await run(view, true) };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "editor.nextEdit.accept",
      title: "Apply the suggested next edit",
      category: "Edit",
      description: "Applies the next-edit suggestion that is showing.",
      input: s.empty(),
      effects: ["write"],
      when: "nextEditVisible",
      agent: "hidden",
      run: () => {
        requireOn();
        if (!shown) throw new Error("No next-edit suggestion is showing.");
        beforeApply = textOf(shown.view);
        return { applied: apply() };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "editor.nextEdit.dismiss",
      title: "Dismiss the suggested next edit",
      category: "Edit",
      description: "Hides the next-edit suggestion that is showing.",
      input: s.empty(),
      effects: [],
      when: "nextEditVisible",
      agent: "hidden",
      run: () => {
        hide();
      },
    }),
  );
  sub.add(
    effect(() => {
      settings.version.value;
      context.set("nextEditEnabled", enabled());
      return undefined;
    }),
  );
  sub.add(
    services.state.register("ide://editor/nextEdit", {
      description:
        "Next-edit suggestions: whether they're on (editor.nextEdit.enabled), the suggestion showing (lines and new text) or null, how many model requests were made, and how many times a remembered prediction for the very same change answered instead (cache).",
      get: () => ({
        enabled: enabled(),
        model: languageModel.model("nextEdit"),
        showing: shown ? { path: shown.view.doc?.path.peek() ?? null, ...shown.edit } : null,
        requests,
        cache: { size: predictions.size, hits: cacheHits },
      }),
    }),
  );
}

// The editor's AI features (D106): inline edit (`editor.inlineEdit`, Ctrl+K, reviewed per hunk: D172) and ghost-text
// completions (editor.inlineCompletions.enabled). Both generate through services.languageModel,
// which the agent extension provides with the same models as the agent panel.
import type { DisposableStore } from "../../../core/lifecycle/index";
import { effect } from "../../../core/reactive/index";
import { s } from "../../../core/schema/index";
import type { WorkbenchServices } from "../../../workbench/services";
import type { EditorService } from "../service";
import { documentLanguage } from "../service";
import type { EditorView } from "../view";
import { registerInlineCompletions } from "./completions";
import { InlineEdit } from "./inlineEdit";

export function registerEditorAi(
  sub: DisposableStore,
  services: WorkbenchServices,
  editors: EditorService,
  activeView: () => EditorView | undefined,
): void {
  const { dispatcher, context, languageModel, notifications, keyboard, settings } = services;
  let current: InlineEdit | null = null;
  sub.add({ dispose: () => current?.dispose() });

  sub.add(
    dispatcher.register({
      id: "editor.inlineEdit",
      title: "Edit with AI…",
      category: "Edit",
      description:
        "Rewrites the selected lines (or the cursor's line) of the active editor with the model: shows a prompt above them, or with `instruction` runs right away and waits. The change is shown hunk by hunk until each is accepted or rejected (editor.inlineEdit.acceptHunk / rejectHunk), or all at once (editor.inlineEdit.accept / reject). Returns the hunks. `startLine`/`endLine` pick other lines.",
      input: s.object({
        instruction: s.string().describe("What to change, e.g. 'add error handling'").optional(),
        startLine: s.integer().describe("First line (1-based)").optional(),
        endLine: s.integer().describe("Last line (1-based, inclusive)").optional(),
      }),
      effects: ["write"],
      when: "activeEditor && aiInlineEdit",
      agent: "hidden",
      run: async ({ instruction, startLine, endLine }) => {
        const view = activeView();
        // A just-opened file shows a preview until the editor engine has loaded.
        for (let i = 0; view && !view.engineEditor && i < 100; i++)
          await new Promise((r) => setTimeout(r, 100));
        const editor = view?.engineEditor;
        const doc = view?.doc;
        if (!view || !editor || !doc) throw new Error("No editor is active.");
        if (doc.model.peek()?.readOnly) throw new Error("This editor is read-only.");
        current?.dispose();
        const selected = editor.selectedLines();
        const range =
          startLine !== undefined
            ? { startLine, endLine: endLine ?? startLine }
            : (selected ?? { startLine: 1, endLine: 1 });
        const edit = new InlineEdit(
          editor,
          range,
          {
            model: languageModel,
            path: doc.path.peek(),
            languageId: documentLanguage(doc),
            text: () => doc.model.peek()?.getText().replace(/\r\n/g, "\n") ?? "",
            versionId: () => doc.model.peek()?.versionId ?? -1,
            setPhase: (phase) => {
              context.set("inlineEditVisible", phase !== null);
              context.set("inlineEditReview", phase === "review");
            },
            keyLabel: (command) => keyboard.labelFor(command),
            notifyError: (message) => notifications.show("error", `Edit with AI: ${message}`),
            run: (command, input) => void dispatcher.execute(command, input).catch(() => {}),
            onDidChange: (listener) => {
              const model = doc.model.peek();
              return model ? model.onDidChangeContent(listener) : { dispose() {} };
            },
          },
          () => {
            if (current === edit) current = null;
          },
        );
        current = edit;
        // Its editor tab closed: the edit goes too (its keys would stay bound otherwise).
        const tabId = view.tabId;
        const watch = effect(() => {
          services.dock.root.value;
          if (!services.dock.findTab(tabId)) queueMicrotask(() => edit.dispose());
          return undefined;
        });
        edit.onClosed(() => watch.dispose());
        if (instruction) await edit.run(instruction);
        return { ...edit.state, text: editor.linesText(edit.state.range) };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "editor.inlineEdit.accept",
      title: "Accept AI edit",
      category: "Edit",
      description: "Keeps the inline edit's new text.",
      input: s.empty(),
      effects: ["write"],
      when: "inlineEditReview",
      agent: "hidden",
      run: () => {
        if (!current) throw new Error("No inline edit is open.");
        current.accept();
      },
    }),
  );
  for (const accept of [true, false])
    sub.add(
      dispatcher.register({
        id: accept ? "editor.inlineEdit.acceptHunk" : "editor.inlineEdit.rejectHunk",
        title: accept ? "Accept AI change" : "Reject AI change",
        category: "Edit",
        description: accept
          ? "Keeps one change (hunk) of the inline edit: `index`, or the first one not reviewed yet. The edit closes when every change is reviewed."
          : "Undoes one change (hunk) of the inline edit, putting its old lines back: `index`, or the first one not reviewed yet.",
        input: s.object({
          index: s.integer({ min: 0 }).describe("The change's index (0-based)").optional(),
        }),
        effects: ["write"],
        when: "inlineEditReview",
        agent: "hidden",
        run: ({ index }) => {
          const edit = current;
          if (!edit) throw new Error("No inline edit is open.");
          edit.resolveHunk(accept, index);
          // The edit may have closed (every change reviewed): its final state.
          return edit.state;
        },
      }),
    );
  sub.add(
    dispatcher.register({
      id: "editor.inlineEdit.reject",
      title: "Reject AI edit",
      category: "Edit",
      description: "Restores the text from before the inline edit (or closes its prompt).",
      input: s.empty(),
      effects: ["write"],
      when: "inlineEditVisible",
      agent: "hidden",
      run: () => {
        if (!current) throw new Error("No inline edit is open.");
        current.reject();
      },
    }),
  );

  // Ctrl+K opens the prompt and may still start a chord (Ctrl+K Ctrl+O…): when the next key
  // finished one, the prompt that nobody typed in goes away (keyboard.ts, D172).
  sub.add(
    effect(() => {
      if (keyboard.chordAfterCommand.value?.command === "editor.inlineEdit")
        current?.closeIfUntouched();
      return undefined;
    }),
  );

  // Off unless the user turns it on (no AI in the editor by default).
  sub.add(
    effect(() => {
      settings.version.value;
      context.set("aiInlineEdit", settings.peek<boolean>("editor.inlineEdit.enabled") === true);
      return undefined;
    }),
  );

  // Ghost-text completions (D204: FIM, context, limits): off unless enabled.
  registerInlineCompletions(sub, services, editors, activeView);
}

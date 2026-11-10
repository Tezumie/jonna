// "Format document with…" and "Format selection with…" (VS Code's
// editor.action.formatDocument.multiple / formatSelection.multiple, formatActionsMultiple.ts):
// pick one of the formatters for the active file, whatever editor.defaultFormatter says, or
// "Configure default formatter…" to set the language's default and format with it. Agents name
// the formatter by its owner's id instead of picking.

import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { pickDefaultFormatter } from "./engine";
import {
  CONFIGURE_FORMATTER_ROW,
  FORMAT_WITH_PLACEHOLDER,
  formatterIndex,
  formatWithRows,
} from "./formatterChoice";
import type { EditorView } from "./view";

export function registerFormatWith(
  sub: DisposableStore,
  services: WorkbenchServices,
  activeView: () => EditorView | undefined,
  /** The language's name as people know it ("Python"). */
  languageName: (languageId: string) => Promise<string>,
): void {
  const { dispatcher, settings } = services;
  const formatWith = async (kind: "file" | "selection", formatter: string | undefined) => {
    const view = activeView();
    const editor = view?.engineEditor;
    const model = view?.doc?.model.peek();
    const path = view?.doc?.path.peek();
    if (!editor || !model || !path) throw new Error("No active text editor");
    const formatters = editor.formatters(kind);
    let index: number;
    if (formatter !== undefined) {
      index = formatterIndex(formatters, formatter);
      if (index < 0)
        throw new Error(
          formatters.length
            ? `No formatter "${formatter}" for this file. Formatters: ${formatters.map((f) => f.id).join(", ")}.`
            : "No formatter for this file.",
        );
    } else {
      const configured =
        settings.peekForLanguageAt<string | null>(
          "editor.defaultFormatter",
          model.languageId,
          path,
        ) || undefined;
      const { rows, activeIndex } = formatWithRows(formatters, configured);
      const pick = await services.quickInput.pick(rows, {
        placeholder: FORMAT_WITH_PLACEHOLDER,
        activeIndex,
      });
      if (!pick) return { formatter: null };
      if (pick.id === CONFIGURE_FORMATTER_ROW) {
        // VS Code formats with the one just made the default.
        const chosen = await pickDefaultFormatter(services, {
          languageId: model.languageId,
          languageName: await languageName(model.languageId),
          formatters,
        });
        if (chosen === undefined) return { formatter: null };
        index = chosen;
      } else index = Number(pick.id);
    }
    const chosen = formatters[index];
    if (!chosen || !(await editor.formatWith(kind, index)))
      throw new Error("This file can't be formatted (read-only, or the formatter went away).");
    return { formatter: chosen.id };
  };
  const input = s.object({
    formatter: s
      .string()
      .describe(
        "The formatter's owner id (an extension id such as `esbenp.prettier-vscode`, or `builtin.language-servers` / `builtin.editor`); without it a picker opens",
      )
      .optional(),
  });
  sub.add(
    dispatcher.register({
      id: "editor.formatDocumentWith",
      title: "Format document with…",
      category: "Editor",
      description:
        "Formats the active editor's file with a chosen formatter (one of the extensions' or the IDE's own for its language), whatever editor.defaultFormatter says; without `formatter` a picker lists them, with 'Configure default formatter…' to set the language's default. The file is changed in the editor, not saved. Returns the formatter's id, or null when cancelled.",
      input,
      effects: ["write"],
      when: "activeEditor",
      agent: "discoverable",
      run: ({ formatter }) => formatWith("file", formatter),
    }),
  );
  sub.add(
    dispatcher.register({
      id: "editor.formatSelectionWith",
      title: "Format selection with…",
      category: "Editor",
      description:
        "Formats the active editor's selection (the cursor's line without one) with a chosen range formatter, whatever editor.defaultFormatter says; without `formatter` a picker lists them, with 'Configure default formatter…'. Returns the formatter's id, or null when cancelled.",
      input,
      effects: ["write"],
      when: "activeEditor",
      agent: "discoverable",
      run: ({ formatter }) => formatWith("selection", formatter),
    }),
  );
}

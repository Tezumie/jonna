// Monaco's formatter selector (FormattingConflicts, as VS Code's DefaultFormatter sets it): Format
// document, Format selection and format on save all go through it, so editor.defaultFormatter
// and the "multiple formatters" question (../formatterChoice.ts) decide which formatter runs.
// A provider's owner rides on its `extensionId` (Monaco copies it onto the document formatters
// it makes from range formatters); one without is the editor's built-in formatting.
import { ILanguageFeaturesService } from "monaco-editor/editor/common/services/languageFeatures.js";
import {
  FormattingConflicts,
  getRealAndSyntheticDocumentFormattersOrdered,
} from "monaco-editor/editor/contrib/format/browser/format.js";
import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import type { EngineHost } from "../engine";
import { EDITOR_FORMATTER, type FormatterOption } from "../formatterChoice";
import * as monaco from "./core";

type Provider = { displayName?: string; extensionId?: unknown };

/** Marks `provider` as `owner`'s formatter (its id for editor.defaultFormatter). */
export function formatterOwnedBy<T extends object>(provider: T, owner: string): T {
  Object.assign(provider, { extensionId: owner });
  return provider;
}

/** Monaco's FormattingMode: Explicit (the user asked), Silent (a save). */
const SILENT = 2;
/** Monaco's FormattingKind: File, Selection. */
const SELECTION = 2;

/** Formats run by a save (they ask with a notice, not a dialog, as VS Code's do). */
let silentRuns = 0;

/** Runs `format` as a save's formatting: a choice of formatter is asked with a notice. */
export async function formatSilently<T>(format: () => Promise<T>): Promise<T> {
  silentRuns++;
  try {
    return await format();
  } finally {
    silentRuns--;
  }
}

function optionOf(provider: Provider): FormatterOption {
  const id = typeof provider.extensionId === "string" ? provider.extensionId : EDITOR_FORMATTER;
  const name = provider.displayName;
  return {
    id,
    label: id === EDITOR_FORMATTER ? `Editor${name ? ` (${name})` : ""}` : name || id,
  };
}

/** The language's name as people know it ("TypeScript"): Monaco's first alias, or its id. */
function languageName(languageId: string): string {
  const info = monaco.languages.getLanguages().find((l) => l.id === languageId);
  return info?.aliases?.[0] ?? languageId;
}

/**
 * The formatter "Format document with…" picked for one model: the selector returns it instead of
 * asking (VS Code's formatActionsMultiple runs the provider itself; going through the selector
 * keeps Monaco's own edit application, cancellation and undo stop).
 */
let forced: { model: monaco.editor.ITextModel; index: number } | null = null;

/**
 * The formatters for `model` as the selector receives them: document formatters, then range
 * formatters of owners without one (Monaco's getRealAndSyntheticDocumentFormattersOrdered) for a
 * file; range formatters for a selection.
 */
export function formattersFor(
  model: monaco.editor.ITextModel,
  kind: "file" | "selection",
): FormatterOption[] {
  const features = StandaloneServices.get(ILanguageFeaturesService) as {
    documentFormattingEditProvider: unknown;
    documentRangeFormattingEditProvider: { ordered(model: unknown): Provider[] };
  };
  const providers: Provider[] =
    kind === "file"
      ? getRealAndSyntheticDocumentFormattersOrdered(
          features.documentFormattingEditProvider,
          features.documentRangeFormattingEditProvider,
          model,
        )
      : features.documentRangeFormattingEditProvider.ordered(model);
  return providers.map(optionOf);
}

/** Runs `format` (a format action on `model`) with the `index`th of formattersFor's list. */
export async function formatWithChosen<T>(
  model: monaco.editor.ITextModel,
  index: number,
  format: () => Promise<T>,
): Promise<T> {
  forced = { model, index };
  try {
    return await format();
  } finally {
    forced = null;
  }
}

/** Installs the selector; disposing restores Monaco's (the first formatter). */
export function installFormatterChoice(host: EngineHost): monaco.IDisposable {
  return FormattingConflicts.setFormatterSelector(
    async (
      formatters: Provider[],
      model: monaco.editor.ITextModel,
      mode: number,
      kind: number,
    ): Promise<Provider | undefined> => {
      if (!formatters.length) return undefined;
      if (forced && forced.model === model) return formatters[forced.index];
      if (!host.chooseFormatter) return formatters[0];
      const index = await host.chooseFormatter({
        path: model.uri.fsPath,
        languageId: model.getLanguageId(),
        languageName: languageName(model.getLanguageId()),
        formatters: formatters.map(optionOf),
        kind: kind === SELECTION ? "selection" : "file",
        silent: mode === SILENT || silentRuns > 0,
      });
      return index === undefined ? undefined : formatters[index];
    },
  ) as monaco.IDisposable;
}

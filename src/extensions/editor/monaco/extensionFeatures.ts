// Third-party extensions in the editor (D176): their hover and completion providers (the others in
// extensionProviders.ts) and their decorations, from services.extensionFeatures. Providers answer
// through the extension's worker with no time limit, as in VS Code: Monaco's cancellation (the
// user typed on or moved away) reaches the extension's token instead (providerContext.ts).
// Completions keep VS Code's shape: incomplete lists asked again as the user types, items
// resolved when selected, commit characters, insert and replace ranges, snippets, label details.
// Decorations use the IDE's classes (theme colors), never the extension's own CSS.

import {
  type DecorationTypeStyle,
  decorationTypeCss,
} from "../../../workbench/extensionDecorationTypes";
import {
  COMPLETION_EDITOR_COMMANDS,
  type CompletionEntry,
  type CompletionKind,
  type CompletionResult,
  completionColumns,
  type EditorDecoration,
  type LanguageFeature,
  type TextRange,
} from "../../../workbench/extensionFeatures";
import type { ProviderCommand } from "../../../workbench/extensionProviders";
import type { EngineHost } from "../engine";
import * as monaco from "./core";
import { registerExtensionProviders } from "./extensionProviders";
import { abortSignal, answerOf, positionContext } from "./providerContext";

/** A completion's own range, when Monaco can use it (completionColumns). */
function ownRange(range: TextRange | undefined, position: monaco.Position): monaco.Range | null {
  const columns = completionColumns(range, position.lineNumber, position.column);
  return columns
    ? new monaco.Range(position.lineNumber, columns[0], position.lineNumber, columns[1])
    : null;
}

const K = monaco.languages.CompletionItemKind;
const KIND: Record<CompletionKind, monaco.languages.CompletionItemKind> = {
  text: K.Text,
  method: K.Method,
  function: K.Function,
  constructor: K.Constructor,
  field: K.Field,
  variable: K.Variable,
  class: K.Class,
  interface: K.Interface,
  module: K.Module,
  property: K.Property,
  unit: K.Unit,
  value: K.Value,
  enum: K.Enum,
  keyword: K.Keyword,
  snippet: K.Snippet,
  color: K.Color,
  file: K.File,
  reference: K.Reference,
  folder: K.Folder,
  enumMember: K.EnumMember,
  constant: K.Constant,
  struct: K.Struct,
  event: K.Event,
  operator: K.Operator,
  typeParameter: K.TypeParameter,
  user: K.User,
  issue: K.Issue,
};

/** Edits elsewhere made with a completion (an auto-import). */
function additionalEdits(
  edits: CompletionEntry["additionalTextEdits"],
): monaco.languages.TextEdit[] | undefined {
  if (!Array.isArray(edits)) return undefined;
  return edits
    .slice(0, 50)
    .filter((e) => e && Number.isFinite(e.startLine) && e.startLine >= 1)
    .map((e) => ({
      range: new monaco.Range(
        e.startLine,
        e.startColumn ?? 1,
        e.endLine ?? e.startLine,
        e.endColumn ?? e.startColumn ?? 1,
      ),
      text: String(e.text),
    }));
}

/**
 * What runs after a completion is inserted: the editor's own suggest / parameter hints (as
 * VS Code runs them), or the extension's command (checked as its own by the host).
 */
function completionCommand(
  command: NonNullable<CompletionEntry["command"]>,
  toCommand: (cmd: ProviderCommand, title: string) => monaco.languages.Command,
): monaco.languages.Command {
  return (COMPLETION_EDITOR_COMMANDS as readonly string[]).includes(command.id)
    ? { id: command.id, title: "" }
    : toCommand(command, "");
}

/** Registers every feature's providers; disposing removes them all. */
export function registerExtensionFeatures(
  features: readonly LanguageFeature[],
  host: EngineHost,
): monaco.IDisposable {
  const disposables: monaco.IDisposable[] = [];
  for (const f of features) {
    const selector: monaco.languages.LanguageSelector = f.languages.includes("*")
      ? "*"
      : [...f.languages];
    const mine = (model: monaco.editor.ITextModel) =>
      (f.schemes ?? ["file"]).includes(model.uri.scheme);
    // Definition, references, formatting, code actions… (extensionProviders.ts).
    const { toCommand } = registerExtensionProviders(f, selector, host, disposables);
    const hover = f.hover;
    if (hover)
      disposables.push(
        monaco.languages.registerHoverProvider(selector, {
          provideHover: async (model, position, token) => {
            if (!mine(model)) return null;
            const answer = await answerOf(
              hover(positionContext(model, position), abortSignal(token)),
              null,
            );
            if (!answer || token.isCancellationRequested) return null;
            const text = typeof answer === "string" ? answer : answer.contents;
            // The extension's own range (VS Code's Hover.range), else the word under the pointer.
            const own = typeof answer === "string" ? undefined : answer.range;
            const word = own ? null : model.getWordAtPosition(position);
            return {
              // Extension Markdown: no HTML, no command links.
              contents: [{ value: String(text).slice(0, 20_000), isTrusted: false }],
              ...(own && {
                range: new monaco.Range(own.startLine, own.startColumn, own.endLine, own.endColumn),
              }),
              ...(word && {
                range: new monaco.Range(
                  position.lineNumber,
                  word.startColumn,
                  position.lineNumber,
                  word.endColumn,
                ),
              }),
            };
          },
        }),
      );
    const completion = f.completion;
    const resolve = completion?.resolve;
    /** Items to resolve when selected, with the extension's id for each. */
    const resolveIds = new WeakMap<monaco.languages.CompletionItem, string>();
    if (completion)
      disposables.push(
        monaco.languages.registerCompletionItemProvider(selector, {
          triggerCharacters: [...completion.triggerCharacters],
          provideCompletionItems: async (model, position, context, token) => {
            if (!mine(model)) return { suggestions: [] };
            const how = monaco.languages.CompletionTriggerKind;
            const answer = await answerOf<readonly CompletionEntry[] | CompletionResult>(
              completion.provide(
                {
                  ...positionContext(model, position),
                  // VS Code's CompletionContext (typing on after an incomplete list, a trigger).
                  triggerKind:
                    context.triggerKind === how.TriggerForIncompleteCompletions
                      ? "incomplete"
                      : context.triggerKind === how.TriggerCharacter
                        ? "triggerCharacter"
                        : "invoke",
                  ...(context.triggerCharacter && { triggerCharacter: context.triggerCharacter }),
                },
                abortSignal(token),
              ),
              [],
            );
            if (token.isCancellationRequested) return { suggestions: [] };
            const { items, isIncomplete } = Array.isArray(answer)
              ? { items: answer as readonly CompletionEntry[], isIncomplete: false }
              : (answer as CompletionResult);
            // VS Code's default: the word before the cursor on insert, the whole word on replace.
            const before = model.getWordUntilPosition(position);
            const at = model.getWordAtPosition(position);
            const insert = new monaco.Range(
              position.lineNumber,
              before.startColumn,
              position.lineNumber,
              position.column,
            );
            const replace = new monaco.Range(
              position.lineNumber,
              before.startColumn,
              position.lineNumber,
              Math.max(position.column, at?.endColumn ?? position.column),
            );
            const suggestions = items
              .filter((i) => i && typeof i.label === "string")
              .map((i): monaco.languages.CompletionItem => {
                // Its own range (D261: `./path/`, `--var`, `@dec` replaced more than a word)
                // when it's on the cursor's line and reaches the cursor, as Monaco needs.
                const own = ownRange(i.range, position);
                const ownReplace =
                  own && i.replaceRange ? ownRange(i.replaceRange, position) : null;
                const item: monaco.languages.CompletionItem = {
                  label:
                    i.labelDetail || i.labelDescription
                      ? {
                          label: i.label,
                          ...(i.labelDetail && { detail: i.labelDetail }),
                          ...(i.labelDescription && { description: i.labelDescription }),
                        }
                      : i.label,
                  kind: KIND[i.kind ?? "text"] ?? K.Text,
                  insertText: typeof i.insertText === "string" ? i.insertText : i.label,
                  ...((i.snippet || i.kind === "snippet") && {
                    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                  }),
                  ...(i.deprecated && { tags: [monaco.languages.CompletionItemTag.Deprecated] }),
                  ...(i.detail && { detail: String(i.detail) }),
                  ...(i.documentation && {
                    documentation: { value: String(i.documentation), isTrusted: false },
                  }),
                  ...(typeof i.sortText === "string" && { sortText: i.sortText }),
                  ...(typeof i.filterText === "string" && { filterText: i.filterText }),
                  ...(i.preselect === true && { preselect: true }),
                  ...(i.commitCharacters?.length && { commitCharacters: [...i.commitCharacters] }),
                  ...(i.additionalTextEdits && {
                    additionalTextEdits: additionalEdits(i.additionalTextEdits),
                  }),
                  ...(i.command && { command: completionCommand(i.command, toCommand) }),
                  range: own
                    ? ownReplace
                      ? { insert: own, replace: ownReplace }
                      : own
                    : { insert, replace },
                };
                if (i.resolveId) resolveIds.set(item, i.resolveId);
                return item;
              });
            // Incomplete: Monaco asks again as the user types (VS Code's isIncomplete).
            return { suggestions, ...(isIncomplete && { incomplete: true }) };
          },
          ...(resolve && {
            resolveCompletionItem: async (item: monaco.languages.CompletionItem, token) => {
              const resolveId = resolveIds.get(item);
              if (!resolveId) return item;
              const more = await answerOf(resolve({ resolveId }, abortSignal(token)), null);
              if (!more || token.isCancellationRequested) return item;
              // As VS Code: resolving fills in details; what's inserted and where stay.
              return {
                ...item,
                ...(more.detail && { detail: more.detail }),
                ...(more.documentation && {
                  documentation: { value: more.documentation, isTrusted: false },
                }),
                ...(more.additionalTextEdits && {
                  additionalTextEdits: additionalEdits(more.additionalTextEdits),
                }),
                ...(more.command && { command: completionCommand(more.command, toCommand) }),
              };
            },
          }),
        }),
      );
  }
  return {
    dispose: () => {
      for (const d of disposables) d.dispose();
    },
  };
}

/** Puts extensions' decorations on the models of their files (also models opened later). */
export class ExtensionDecorations implements monaco.IDisposable {
  private list: readonly EditorDecoration[] = [];
  /** Decoration ids per model (by its uri). */
  private readonly applied = new Map<string, string[]>();
  private readonly created = monaco.editor.onDidCreateModel((model) => this.applyTo(model));
  private readonly removed = monaco.editor.onWillDisposeModel((model) =>
    this.applied.delete(model.uri.toString()),
  );

  /** Extensions' decoration types' rules (D234), one stylesheet for the window. */
  private sheet: HTMLStyleElement | null = null;
  private sheetKey = "";

  set(list: readonly EditorDecoration[]): void {
    const before = new Set(this.applied.keys());
    this.list = list;
    this.updateSheet();
    for (const model of monaco.editor.getModels()) {
      if (model.uri.scheme !== "file") continue;
      before.delete(model.uri.toString());
      this.applyTo(model);
    }
    for (const gone of before) this.applied.delete(gone);
  }

  private applyTo(model: monaco.editor.ITextModel): void {
    if (model.uri.scheme !== "file") return;
    const key = model.uri.toString();
    const target = monaco.Uri.file(model.uri.fsPath).toString();
    const mine = this.list.filter((d) => monaco.Uri.file(d.path).toString() === target);
    const next = mine.flatMap((d) => d.ranges.map((r) => toDecoration(model, d, r)));
    const ids = model.deltaDecorations(this.applied.get(key) ?? [], next);
    if (ids.length) this.applied.set(key, ids);
    else this.applied.delete(key);
  }

  /** Writes the rules of every decoration type in use (values were checked by the host). */
  private updateSheet(): void {
    const types = new Map<number, DecorationTypeStyle>();
    for (const d of this.list) if (d.custom) types.set(d.custom.id, d.custom.style);
    const key = [...types.keys()].sort((a, b) => a - b).join(",");
    if (key === this.sheetKey) return;
    this.sheetKey = key;
    if (!types.size) {
      this.sheet?.remove();
      this.sheet = null;
      return;
    }
    if (!this.sheet) {
      this.sheet = document.createElement("style");
      this.sheet.dataset.owner = "extension-decoration-types";
      document.head.append(this.sheet);
    }
    this.sheet.textContent = [...types]
      .map(([id, style]) => decorationTypeCss(`ext-dt-${id}`, style))
      .join("\n");
  }

  dispose(): void {
    this.sheet?.remove();
    this.sheet = null;
    this.created.dispose();
    this.removed.dispose();
    for (const model of monaco.editor.getModels()) {
      const ids = this.applied.get(model.uri.toString());
      if (ids) model.deltaDecorations(ids, []);
    }
    this.applied.clear();
  }
}

function toDecoration(
  model: monaco.editor.ITextModel,
  d: EditorDecoration,
  r: EditorDecoration["ranges"][number],
): monaco.editor.IModelDeltaDecoration {
  const lines = model.getLineCount();
  const startLine = Math.min(Math.max(1, Math.floor(r.startLine)), lines);
  const endLine = Math.min(Math.max(startLine, Math.floor(r.endLine ?? startLine)), lines);
  const whole = r.startColumn === undefined && r.endColumn === undefined;
  const range = new monaco.Range(
    startLine,
    whole ? 1 : Math.max(1, r.startColumn ?? 1),
    endLine,
    whole ? model.getLineMaxColumn(endLine) : (r.endColumn ?? model.getLineMaxColumn(endLine)),
  );
  if (d.custom) return customDecoration(range, whole, d.custom, r);
  const cls = `ext-deco-${d.style}`;
  return {
    range,
    options: {
      ...(whole ? { isWholeLine: true, className: cls } : { inlineClassName: cls }),
      ...(r.hover && { hoverMessage: { value: String(r.hover), isTrusted: false } }),
      ...(d.after && {
        after: { content: ` ${String(d.after).slice(0, 120)}`, inlineClassName: "ext-deco-after" },
      }),
      ...(d.mapped && {
        overviewRuler: {
          color: resolvedColor("var(--accent)"),
          position: monaco.editor.OverviewRulerLane.Left,
        },
        minimap: {
          color: resolvedColor("var(--accent)"),
          position: monaco.editor.MinimapPosition.Gutter,
        },
      }),
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    },
  };
}

/** A theme token's current value (the overview ruler is drawn on a canvas: no CSS variables). */
function resolvedColor(color: string): string {
  const token = /^var\((--[\w-]+)\)$/.exec(color)?.[1];
  if (!token) return color;
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || color;
}

const RULER_LANES = {
  left: 1,
  center: 2,
  right: 4,
  full: 7,
} as const;

/** A range of an extension's decoration type (D234): its class, before / after text, ruler, gutter. */
function customDecoration(
  range: monaco.Range,
  whole: boolean,
  custom: NonNullable<EditorDecoration["custom"]>,
  r: EditorDecoration["ranges"][number],
): monaco.editor.IModelDeltaDecoration {
  const cls = `ext-dt-${custom.id}`;
  const { style } = custom;
  const lineWide = whole || style.isWholeLine;
  const before = r.before ?? style.before?.contentText;
  const after = r.after ?? style.after?.contentText;
  return {
    range,
    options: {
      ...(lineWide ? { isWholeLine: true, className: cls } : { inlineClassName: cls }),
      ...(r.hover && { hoverMessage: { value: String(r.hover), isTrusted: false } }),
      ...(before && { before: { content: before, inlineClassName: `${cls}-before` } }),
      ...(after && { after: { content: after, inlineClassName: `${cls}-after` } }),
      ...(style.overviewRuler && {
        overviewRuler: {
          color: resolvedColor(style.overviewRuler.color),
          position: RULER_LANES[style.overviewRuler.lane],
        },
      }),
      ...(style.gutterColor && { linesDecorationsClassName: `${cls}-gutter` }),
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    },
  };
}

// An extension's language providers beyond hover and completion (VS Code's
// `languages.register…Provider`; DOM-free checks in workbench/extensionProviders.ts): each asks
// the extension's worker (a "provider" call, `target` its id) and checks what comes back. It's
// asked about the folder's files and any other document open in the editor (canAsk); places it
// answers with (definitions, references, links) may be anywhere on disk (read-only), edits only
// in the folder, and commands it attaches (code lenses, code actions) must be its own. A
// provider's second calls (rename's prepare, a code action's resolve and release) are
// "provider" calls to `<id>.<part>`. The editor's cancellation reaches the worker (`signal`).
import type { Event } from "../../core/events/index";
import type { FeatureContext, LanguageFeature } from "../../workbench/extensionFeatures";
import {
  type DocumentContext,
  encodeSemanticTokens,
  normalizeCodeActions,
  normalizeCodeLenses,
  normalizeColorPresentations,
  normalizeColors,
  normalizeDocumentLinks,
  normalizeEvaluatable,
  normalizeFileEdits,
  normalizeFoldingRanges,
  normalizeHierarchyCalls,
  normalizeHierarchyItems,
  normalizeHighlights,
  normalizeInlayHint,
  normalizeInlayHints,
  normalizeInlineCompletions,
  normalizeInlineValues,
  normalizeLegend,
  normalizeLinkedEditing,
  normalizeLocations,
  normalizeRenameLocation,
  normalizeResolvedEdits,
  normalizeSelectionRanges,
  normalizeSignatureHelp,
  normalizeSymbols,
  normalizeTextEdits,
  normalizeWorkspaceSymbols,
  type PathResolver,
  type ProviderFeature,
} from "../../workbench/extensionProviders";

/** A provider's second calls: rename's prepare, a code action's resolve and release. */
export type ProviderPart =
  | "prepare"
  | "resolve"
  | "release"
  | "presentations"
  // D255: a call hierarchy's and a type hierarchy's second calls.
  | "incoming"
  | "outgoing"
  | "supertypes"
  | "subtypes";

export interface ProviderDeps {
  /**
   * Asks the worker's provider `id` (or one of its parts: the "provider" call `<id>.<part>`);
   * `signal` cancels it (the worker's token fires).
   */
  ask(context: unknown, part?: ProviderPart, signal?: AbortSignal): Promise<unknown>;
  /** Fires when the extension refreshes the provider (semantic tokens). */
  changed: Event<void>;
  /** Whether the extension may be asked about this document (the folder's or one open). */
  canAsk(path: string): boolean;
  /** A place from the extension it only points to (anywhere on disk; throws when unusable). */
  resolve: PathResolver;
  /** A path the extension may change (in the folder, not in .git). */
  resolveWritable: PathResolver;
  ownCommand(id: string): boolean;
}

const chars = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [])
    .filter((t): t is string => typeof t === "string" && t.length === 1)
    .slice(0, 10);

/** The part of a LanguageFeature for `feature`, with its registration `options`. */
export function providerFeature(
  feature: ProviderFeature,
  options: Record<string, unknown>,
  deps: ProviderDeps,
): Partial<LanguageFeature> {
  const { ask, canAsk, resolve } = deps;
  const at = <C extends { path: string }, T>(
    empty: T,
    convert: (raw: unknown, context: C) => T,
    part?: ProviderPart,
  ): ((context: C, signal?: AbortSignal) => Promise<T>) => {
    return async (context: C, signal?: AbortSignal) => {
      if (!canAsk(context.path)) return empty;
      return convert(await ask(context, part, signal), context);
    };
  };
  switch (feature) {
    case "definition":
      return { definition: at([], (raw) => normalizeLocations(raw, resolve)) };
    case "references":
      return { references: at([], (raw) => normalizeLocations(raw, resolve)) };
    case "formatting":
      return { formatting: at([], normalizeTextEdits) };
    case "rangeFormatting":
      return { rangeFormatting: at([], normalizeTextEdits) };
    case "codeActions":
      return {
        codeActions: at([], (raw, c: DocumentContext) =>
          normalizeCodeActions(raw, deps.resolveWritable, c.path, deps.ownCommand),
        ),
        // Registered with a resolve callback: edits come when an action is chosen.
        ...(options.resolve === true && {
          resolveCodeAction: at(
            [],
            (raw, c: DocumentContext) => normalizeResolvedEdits(raw, deps.resolveWritable, c.path),
            "resolve",
          ),
          releaseCodeActions: (resolveIds: readonly string[]) => {
            if (resolveIds.length) void ask({ resolveIds }, "release").catch(() => {});
          },
        }),
      };
    case "rename":
      return {
        rename: at([], (raw, c: FeatureContext) =>
          normalizeFileEdits(raw, deps.resolveWritable, c.path),
        ),
        ...(options.prepare === true && {
          prepareRename: at(null, normalizeRenameLocation, "prepare"),
        }),
      };
    case "signatureHelp":
      return {
        signatureHelp: {
          triggerCharacters: chars(options.triggerCharacters),
          retriggerCharacters: chars(options.retriggerCharacters),
          provide: at(null, normalizeSignatureHelp),
        },
      };
    case "documentSymbols":
      return { documentSymbols: at([], normalizeSymbols) };
    case "codeLens":
      return { codeLens: at([], (raw) => normalizeCodeLenses(raw, deps.ownCommand)) };
    case "inlayHints":
      return {
        inlayHints: at([], (raw) => normalizeInlayHints(raw, resolve, deps.ownCommand)),
        // Registered with a resolve callback: a hint is filled in when hovered.
        ...(options.resolve === true && {
          resolveInlayHint: at(
            null,
            (raw) => normalizeInlayHint(raw, resolve, deps.ownCommand),
            "resolve",
          ),
        }),
      };
    case "typeDefinition":
      return { typeDefinition: at([], (raw) => normalizeLocations(raw, resolve)) };
    case "implementation":
      return { implementation: at([], (raw) => normalizeLocations(raw, resolve)) };
    case "declaration":
      return { declaration: at([], (raw) => normalizeLocations(raw, resolve)) };
    case "documentHighlights":
      return { documentHighlights: at([], normalizeHighlights) };
    case "foldingRanges":
      return { foldingRanges: at([], normalizeFoldingRanges) };
    case "documentLinks":
      return { documentLinks: at([], (raw) => normalizeDocumentLinks(raw, resolve)) };
    case "colors":
      return {
        colors: {
          provide: at([], normalizeColors),
          // Registered with a presentations callback: asked how a picked color is written.
          ...(options.presentations === true && {
            presentations: at([], normalizeColorPresentations, "presentations"),
          }),
        },
      };
    case "onTypeFormatting": {
      const triggers = chars(options.triggerCharacters);
      if (!triggers.length)
        throw new Error("An on-type formatting provider needs triggerCharacters.");
      return {
        onTypeFormatting: { triggerCharacters: triggers, provide: at([], normalizeTextEdits) },
      };
    }
    case "inlineCompletions":
      return {
        inlineCompletions: at([], (raw) => normalizeInlineCompletions(raw, deps.ownCommand)),
      };
    case "workspaceSymbols":
      // Asked with a query, not about a file: answers are files of the folder only.
      return {
        workspaceSymbols: async (context: { query: string }) =>
          normalizeWorkspaceSymbols(await ask(context), resolve),
      };
    case "linkedEditingRanges":
      return { linkedEditingRanges: at(null, normalizeLinkedEditing) };
    case "selectionRanges":
      return {
        selectionRanges: at([], (raw, c: { path: string; positions: unknown[] }) =>
          normalizeSelectionRanges(raw, c.positions.length),
        ),
      };
    case "callHierarchy": {
      const items = (raw: unknown) => normalizeHierarchyItems(raw, resolve);
      return {
        callHierarchy: {
          prepare: at([], items),
          incoming: at([], (raw) => normalizeHierarchyCalls(raw, resolve, "from"), "incoming"),
          outgoing: at([], (raw) => normalizeHierarchyCalls(raw, resolve, "to"), "outgoing"),
        },
      };
    }
    case "typeHierarchy": {
      const items = (raw: unknown) => normalizeHierarchyItems(raw, resolve);
      return {
        typeHierarchy: {
          prepare: at([], items),
          supertypes: at([], items, "supertypes"),
          subtypes: at([], items, "subtypes"),
        },
      };
    }
    case "evaluatableExpressions":
      return { evaluatableExpression: at(null, normalizeEvaluatable) };
    case "inlineValues":
      return { inlineValues: at([], normalizeInlineValues) };
    case "semanticTokens": {
      const legend = normalizeLegend(options.legend);
      if (!legend.tokenTypes.length)
        throw new Error("A semantic tokens provider needs a legend with tokenTypes.");
      const provide = at([], (raw) => encodeSemanticTokens(raw, legend));
      // VS Code's DocumentRangeSemanticTokensProvider: asked about the visible range.
      if (options.range === true) return { rangeSemanticTokens: { legend, provide } };
      return { semanticTokens: { legend, provide, onDidChange: deps.changed } };
    }
  }
}

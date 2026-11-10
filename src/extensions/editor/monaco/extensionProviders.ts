// Third-party extensions' language providers beyond hover and completion (definition,
// references, formatting, code actions, rename, signature help, symbols, code lens, inlay hints,
// semantic tokens) in Monaco, beside extensionFeatures.ts. What the extension answered was
// already checked by the extensions host (workbench/extensionProviders.ts); here it's turned into
// Monaco's shapes. As in VS Code there are no time limits: Monaco's cancellation reaches the
// extension (providerContext.ts), and the worker's own call limit ends a provider that never
// answers. Edits to files that aren't open open them first (as rename does for language
// servers), and commands on lenses, code actions and inlay hints run through the dispatcher.
// Rename's prepare step, code actions and inlay hints resolved later and semantic tokens' refresh
// map to Monaco's resolveRenameLocation, resolveCodeAction, resolveInlayHint and onDidChange.
import type {
  FeatureContext,
  LanguageFeature,
  TextRange,
} from "../../../workbench/extensionFeatures";
import {
  colorHexDigits,
  type FullRange,
  type HighlightEntry,
  type InlayHintEntry,
  type ProviderCommand,
  type ProviderFileEdit,
  type ProviderLocation,
  type RenameLocationEntry,
  resolveRange,
  SYMBOL_KINDS,
  type SymbolEntry,
} from "../../../workbench/extensionProviders";
import type { EngineHost } from "../engine";
import * as monaco from "./core";
import { addEvaluatableSource } from "./evaluatable";
import { formatterOwnedBy } from "./formatterChoice";
import { ensureModels } from "./peek";
import { abortSignal, answerOf, documentContext, positionContext } from "./providerContext";

/**
 * The debugger's hover asks for an evaluatable expression with no cancellation of its own: an
 * extension gets this long before the hover takes the word under the pointer instead.
 */
const EVALUATABLE_MS = 1500;

const fromRange = (r: monaco.IRange): FullRange => ({
  startLine: r.startLineNumber,
  startColumn: r.startColumn,
  endLine: r.endLineNumber,
  endColumn: r.endColumn,
});

/** `range` in `model` (clamped; no columns: whole lines). */
function toRange(model: monaco.editor.ITextModel, range: TextRange): monaco.Range {
  const r = resolveRange(range, model.getLineCount(), (n) => model.getLineLength(n));
  return new monaco.Range(r.startLine, r.startColumn, r.endLine, r.endColumn);
}

/** A range in a file that may have no model (whole lines get a wide end column). */
function rangeIn(path: string, range: TextRange): monaco.Range {
  const model = monaco.editor.getModel(monaco.Uri.file(path));
  if (model) return toRange(model, range);
  const endLine = range.endLine ?? range.startLine;
  return new monaco.Range(
    range.startLine,
    range.startColumn ?? 1,
    endLine,
    range.endColumn ?? Number.MAX_SAFE_INTEGER,
  );
}

async function toLocations(
  host: EngineHost,
  list: ProviderLocation[],
): Promise<monaco.languages.Location[]> {
  // Peek and the references list show other files' text: their models exist first.
  await ensureModels(
    host,
    list.map((l) => l.path),
  );
  return list.map((l) => ({ uri: monaco.Uri.file(l.path), range: rangeIn(l.path, l) }));
}

/**
 * Edits across files. A rename's files are opened as documents (unsaved) so nothing is lost; a
 * code action's (offered at every cursor move) only get models, as language servers' do.
 */
async function toWorkspaceEdit(
  host: EngineHost,
  edits: ProviderFileEdit[],
  open: boolean,
): Promise<monaco.languages.WorkspaceEdit> {
  const files = [...new Set(edits.map((e) => e.path))];
  if (open) await host.openDocuments(files);
  else await ensureModels(host, files);
  return {
    edits: edits.map((e) => ({
      resource: monaco.Uri.file(e.path),
      textEdit: { range: rangeIn(e.path, e), text: e.text },
      versionId: undefined,
    })),
  };
}

function toSymbols(
  model: monaco.editor.ITextModel,
  list: SymbolEntry[],
): monaco.languages.DocumentSymbol[] {
  return list.map((s) => {
    const range = toRange(model, s.range);
    const selection = toRange(model, s.selectionRange);
    return {
      name: s.name,
      detail: s.detail,
      kind: Math.max(0, SYMBOL_KINDS.indexOf(s.kind)) as monaco.languages.SymbolKind,
      tags: [],
      range,
      // Monaco wants the selection inside the range.
      selectionRange: range.containsRange(selection) ? selection : range,
      children: toSymbols(model, s.children),
    };
  });
}

type ToCommand = (cmd: ProviderCommand | undefined, title: string) => monaco.languages.Command;

/** An inlay hint in Monaco's shape: parts keep where they go, their commands and tooltips. */
function toInlayHint(
  model: monaco.editor.ITextModel,
  h: InlayHintEntry,
  toCommand: ToCommand,
): monaco.languages.InlayHint {
  return {
    position: { lineNumber: h.line, column: h.column },
    label:
      typeof h.label === "string"
        ? h.label
        : h.label.map((p) => ({
            label: p.value,
            ...(p.tooltip && { tooltip: { value: p.tooltip, isTrusted: false } }),
            ...(p.location && {
              location: {
                uri: monaco.Uri.file(p.location.path),
                range: rangeIn(p.location.path, p.location),
              },
            }),
            ...(p.command && { command: toCommand(p.command, p.value) }),
          })),
    ...(h.kind && {
      kind:
        h.kind === "type"
          ? monaco.languages.InlayHintKind.Type
          : monaco.languages.InlayHintKind.Parameter,
    }),
    ...(h.tooltip && { tooltip: { value: h.tooltip, isTrusted: false } }),
    ...(h.paddingLeft && { paddingLeft: true }),
    ...(h.paddingRight && { paddingRight: true }),
    // Double-clicking the hint makes these (VS Code's "insert the inferred type").
    ...(h.textEdits?.length && {
      textEdits: h.textEdits.map((e) => ({ range: toRange(model, e), text: e.text })),
    }),
  };
}

let commandSeq = 0;

/**
 * Registers `f`'s providers (other than hover and completion) into `disposables`; returns how a
 * command its answers carry becomes Monaco's (completions use it too).
 */
export function registerExtensionProviders(
  f: LanguageFeature,
  selector: monaco.languages.LanguageSelector,
  host: EngineHost,
  disposables: monaco.IDisposable[],
): { toCommand: ToCommand } {
  const mine = (model: monaco.editor.ITextModel) =>
    (f.schemes ?? ["file"]).includes(model.uri.scheme);
  const add = (d: monaco.IDisposable) => disposables.push(d);
  const { definition, references, formatting, rangeFormatting, codeActions, rename } = f;
  const { signatureHelp, documentSymbols, codeLens, inlayHints, semanticTokens } = f;

  // Lenses' and code actions' commands are the extension's own (checked by the host).
  let runCommand: string | undefined;
  // Only commands this extension's answers carried (checked as its own by the host) run here:
  // the Monaco command is reachable by id (a keybinding), with any arguments (D233).
  const issued = new Set<string>();
  const toCommand: ToCommand = (cmd, title) => {
    if (!cmd) return { id: "", title };
    issued.add(cmd.id);
    if (!runCommand) {
      runCommand = `ext.${f.owner}.run.${++commandSeq}`;
      add(
        monaco.editor.registerCommand(runCommand, (_accessor, c: ProviderCommand | undefined) => {
          if (!c || typeof c.id !== "string" || !issued.has(c.id)) return;
          void host.run(c.id, c.input ?? {}).catch(() => {});
        }),
      );
    }
    return { id: runCommand, title, arguments: [cmd] };
  };

  if (definition)
    add(
      monaco.languages.registerDefinitionProvider(selector, {
        provideDefinition: async (model, position, token) => {
          if (!mine(model)) return null;
          const list = await answerOf(
            definition(positionContext(model, position), abortSignal(token)),
            [],
          );
          return token.isCancellationRequested ? null : toLocations(host, list);
        },
      }),
    );
  if (references)
    add(
      monaco.languages.registerReferenceProvider(selector, {
        provideReferences: async (model, position, context, token) => {
          if (!mine(model)) return null;
          const list = await answerOf(
            references(
              {
                ...positionContext(model, position),
                includeDeclaration: context.includeDeclaration,
              },
              abortSignal(token),
            ),
            [],
          );
          return token.isCancellationRequested ? null : toLocations(host, list);
        },
      }),
    );
  // Its owner is what editor.defaultFormatter names (formatterChoice.ts); its name, the picker's.
  const formatterId = f.formatterId ?? f.owner;
  const formatterName = f.ownerName ?? formatterId;
  if (formatting)
    add(
      monaco.languages.registerDocumentFormattingEditProvider(selector, {
        ...formatterOwnedBy({}, formatterId),
        displayName: formatterName,
        provideDocumentFormattingEdits: async (model, options, token) => {
          if (!mine(model)) return null;
          const edits = await answerOf(
            formatting(
              {
                ...documentContext(model),
                tabSize: options.tabSize,
                insertSpaces: options.insertSpaces,
              },
              abortSignal(token),
            ),
            [],
          );
          if (token.isCancellationRequested) return null;
          return edits.map((e) => ({ range: toRange(model, e), text: e.text }));
        },
      }),
    );
  if (rangeFormatting)
    add(
      monaco.languages.registerDocumentRangeFormattingEditProvider(selector, {
        ...formatterOwnedBy({}, formatterId),
        displayName: formatterName,
        provideDocumentRangeFormattingEdits: async (model, range, options, token) => {
          if (!mine(model)) return null;
          const edits = await answerOf(
            rangeFormatting(
              {
                ...documentContext(model),
                tabSize: options.tabSize,
                insertSpaces: options.insertSpaces,
                range: fromRange(range),
              },
              abortSignal(token),
            ),
            [],
          );
          if (token.isCancellationRequested) return null;
          return edits.map((e) => ({ range: toRange(model, e), text: e.text }));
        },
      }),
    );
  // Actions offered without edits, to resolve when chosen: the extension's id and the document.
  const unresolved = new WeakMap<
    monaco.languages.CodeAction,
    { id: string; model: monaco.editor.ITextModel }
  >();
  const { resolveCodeAction, releaseCodeActions } = f;
  if (codeActions)
    add(
      monaco.languages.registerCodeActionProvider(selector, {
        // A property, not a method: Monaco passes it on unbound.
        ...(resolveCodeAction && {
          resolveCodeAction: async (action: monaco.languages.CodeAction, token) => {
            const at = unresolved.get(action);
            if (!at || at.model.isDisposed()) return action;
            const edits = await answerOf(
              resolveCodeAction(
                { ...documentContext(at.model), resolveId: at.id },
                abortSignal(token),
              ),
              [],
            );
            if (token.isCancellationRequested || !edits.length) return action;
            // Monaco takes only `edit` from the answer (VS Code too).
            return { ...action, edit: await toWorkspaceEdit(host, edits, false) };
          },
        }),
        provideCodeActions: async (model, range, context, token) => {
          if (!mine(model)) return null;
          const severity = (s: monaco.MarkerSeverity) =>
            s === monaco.MarkerSeverity.Error
              ? "error"
              : s === monaco.MarkerSeverity.Warning
                ? "warning"
                : s === monaco.MarkerSeverity.Info
                  ? "info"
                  : "hint";
          const list = await answerOf(
            codeActions(
              {
                ...documentContext(model),
                range: fromRange(range),
                diagnostics: context.markers.slice(0, 50).map((m) => ({
                  ...fromRange(m),
                  message: m.message,
                  severity: severity(m.severity),
                  ...(m.source && { source: m.source }),
                  ...(typeof m.code === "string" && { code: m.code }),
                  ...(m.code && typeof m.code === "object" && { code: m.code.value }),
                })),
                ...(context.only && { only: context.only }),
              },
              abortSignal(token),
            ),
            [],
          );
          // The extension keeps resolvable actions until the list is let go.
          const resolveIds = list.flatMap((a) => (a.resolveId ? [a.resolveId] : []));
          const release = () => releaseCodeActions?.(resolveIds);
          if (token.isCancellationRequested) {
            release();
            return null;
          }
          const actions = await Promise.all(
            list.map(async (a): Promise<monaco.languages.CodeAction> => {
              const action: monaco.languages.CodeAction = {
                title: a.title,
                ...(a.kind && { kind: a.kind }),
                ...(a.isPreferred && { isPreferred: true }),
                ...(a.edits && { edit: await toWorkspaceEdit(host, a.edits, false) }),
                ...(a.command && { command: toCommand(a.command, a.title) }),
              };
              if (a.resolveId && !a.edits) unresolved.set(action, { id: a.resolveId, model });
              return action;
            }),
          );
          return { actions, dispose: release };
        },
      }),
    );
  const { prepareRename } = f;
  if (rename)
    add(
      monaco.languages.registerRenameProvider(selector, {
        ...(prepareRename && {
          resolveRenameLocation: async (model, position, token) => {
            if (!mine(model)) return null;
            let answer: RenameLocationEntry | null;
            try {
              answer = await prepareRename(positionContext(model, position), abortSignal(token));
            } catch (err) {
              if (token.isCancellationRequested) return null;
              // The extension refused: Monaco shows the reason at the position.
              const reason = err instanceof Error ? err.message : String(err);
              const word = model.getWordAtPosition(position);
              return {
                range: word
                  ? new monaco.Range(
                      position.lineNumber,
                      word.startColumn,
                      position.lineNumber,
                      word.endColumn,
                    )
                  : monaco.Range.fromPositions(position),
                text: word?.word ?? "",
                rejectReason: reason.slice(0, 300) || "This can't be renamed.",
              };
            }
            if (!answer || token.isCancellationRequested) return null;
            const range = toRange(model, answer.range);
            // As VS Code: a range that doesn't hold the position is ignored (the word is used).
            if (!range.containsPosition(position)) return null;
            return { range, text: answer.placeholder ?? model.getValueInRange(range) };
          },
        }),
        provideRenameEdits: async (model, position, newName, token) => {
          if (!mine(model)) return null as never;
          try {
            const edits = await rename(
              { ...positionContext(model, position), newName },
              abortSignal(token),
            );
            if (token.isCancellationRequested) return { edits: [] };
            return toWorkspaceEdit(host, edits, true);
          } catch (err) {
            // The extension refused: its reason is shown at the symbol.
            const reason = err instanceof Error ? err.message : String(err);
            return { edits: [], rejectReason: reason.slice(0, 300) };
          }
        },
      }),
    );
  if (signatureHelp)
    add(
      monaco.languages.registerSignatureHelpProvider(selector, {
        signatureHelpTriggerCharacters: [...signatureHelp.triggerCharacters],
        signatureHelpRetriggerCharacters: [...signatureHelp.retriggerCharacters],
        provideSignatureHelp: async (model, position, token, context) => {
          if (!mine(model)) return null;
          const help = await answerOf(
            signatureHelp.provide(
              {
                ...positionContext(model, position),
                ...(context.triggerCharacter && { triggerCharacter: context.triggerCharacter }),
                ...(context.isRetrigger && { isRetrigger: true }),
              },
              abortSignal(token),
            ),
            null,
          );
          if (!help || token.isCancellationRequested) return null;
          return {
            value: {
              signatures: help.signatures.map((s) => ({
                label: s.label,
                ...(s.documentation && {
                  documentation: { value: s.documentation, isTrusted: false },
                }),
                parameters: s.parameters.map((p) => ({
                  label: p.label,
                  ...(p.documentation && {
                    documentation: { value: p.documentation, isTrusted: false },
                  }),
                })),
              })),
              activeSignature: help.activeSignature,
              activeParameter: help.activeParameter,
            },
            dispose: () => {},
          };
        },
      }),
    );
  if (documentSymbols)
    add(
      monaco.languages.registerDocumentSymbolProvider(selector, {
        displayName: f.owner,
        provideDocumentSymbols: async (model, token) => {
          if (!mine(model)) return null;
          const list = await answerOf(
            documentSymbols(documentContext(model), abortSignal(token)),
            [],
          );
          return token.isCancellationRequested ? null : toSymbols(model, list);
        },
      }),
    );
  if (codeLens)
    add(
      monaco.languages.registerCodeLensProvider(selector, {
        provideCodeLenses: async (model, token) => {
          if (!mine(model)) return null;
          const list = await answerOf(codeLens(documentContext(model), abortSignal(token)), []);
          if (token.isCancellationRequested) return null;
          return {
            lenses: list.map((l) => ({
              // The whole range (Monaco shows the lens above its first line), as VS Code keeps it.
              range: toRange(model, l.range),
              command: toCommand(l.command, l.title),
            })),
            dispose: () => {},
          };
        },
      }),
    );
  if (inlayHints) {
    const { resolveInlayHint } = f;
    // Hints offered to be filled in when hovered: the extension's id and the document.
    const toResolve = new WeakMap<
      monaco.languages.InlayHint,
      { id: string; model: monaco.editor.ITextModel }
    >();
    add(
      monaco.languages.registerInlayHintsProvider(selector, {
        provideInlayHints: async (model, range, token) => {
          if (!mine(model)) return null;
          const list = await answerOf(
            inlayHints({ ...documentContext(model), range: fromRange(range) }, abortSignal(token)),
            [],
          );
          if (token.isCancellationRequested) return null;
          return {
            hints: list.map((h) => {
              const hint = toInlayHint(model, h, toCommand);
              if (h.resolveId) toResolve.set(hint, { id: h.resolveId, model });
              return hint;
            }),
            dispose: () => {},
          };
        },
        ...(resolveInlayHint && {
          resolveInlayHint: async (hint: monaco.languages.InlayHint, token) => {
            const at = toResolve.get(hint);
            if (!at || at.model.isDisposed()) return hint;
            const resolved = await answerOf(
              resolveInlayHint(
                { ...documentContext(at.model), resolveId: at.id },
                abortSignal(token),
              ),
              null,
            );
            if (!resolved || token.isCancellationRequested) return hint;
            // As VS Code: resolving fills in the tooltip, parts and edits; the position stays.
            const more = toInlayHint(at.model, resolved, toCommand);
            return {
              ...hint,
              label: more.label,
              ...(more.tooltip && { tooltip: more.tooltip }),
              ...(more.textEdits && { textEdits: more.textEdits }),
            };
          },
        }),
      }),
    );
  }
  registerMoreProviders(f, selector, host, mine, add, toCommand);
  const tokensChanged = semanticTokens?.onDidChange;
  if (semanticTokens)
    add(
      monaco.languages.registerDocumentSemanticTokensProvider(selector, {
        // The extension's refresh (VS Code's onDidChangeSemanticTokens): Monaco asks again.
        ...(tokensChanged && {
          onDidChange: (listener: () => void) => tokensChanged(() => listener()),
        }),
        getLegend: () => semanticTokens.legend,
        provideDocumentSemanticTokens: async (model, _lastResultId, token) => {
          if (!mine(model)) return null;
          const data = await answerOf(
            semanticTokens.provide(documentContext(model), abortSignal(token)),
            [],
          );
          return token.isCancellationRequested ? null : { data: new Uint32Array(data) };
        },
        releaseDocumentSemanticTokens: () => {},
      }),
    );
  // VS Code's DocumentRangeSemanticTokensProvider: the visible range, while full tokens come.
  const rangeTokens = f.rangeSemanticTokens;
  if (rangeTokens)
    add(
      monaco.languages.registerDocumentRangeSemanticTokensProvider(selector, {
        getLegend: () => rangeTokens.legend,
        provideDocumentRangeSemanticTokens: async (model, range, token) => {
          if (!mine(model)) return null;
          const data = await answerOf(
            rangeTokens.provide(
              { ...documentContext(model), range: fromRange(range) },
              abortSignal(token),
            ),
            [],
          );
          return token.isCancellationRequested ? null : { data: new Uint32Array(data) };
        },
      }),
    );
  return { toCommand };
}

const HIGHLIGHT_KINDS = {
  text: 0,
  read: 1,
  write: 2,
} as const satisfies Record<HighlightEntry["kind"], monaco.languages.DocumentHighlightKind>;

/** `p`, or null after `ms` (a request with no cancellation of its own). */
function within<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.catch(() => null),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * D234: type definition, implementation, declaration, document highlights, folding ranges,
 * document links, colors, on-type formatting and inline completions.
 */
function registerMoreProviders(
  f: LanguageFeature,
  selector: monaco.languages.LanguageSelector,
  host: EngineHost,
  mine: (model: monaco.editor.ITextModel) => boolean,
  add: (d: monaco.IDisposable) => void,
  toCommand: ToCommand,
): void {
  const { typeDefinition, implementation, declaration, documentHighlights } = f;
  const { foldingRanges, documentLinks, colors, onTypeFormatting, inlineCompletions } = f;
  const locations =
    (provide: (c: FeatureContext, signal?: AbortSignal) => Promise<ProviderLocation[]>) =>
    async (
      model: monaco.editor.ITextModel,
      position: monaco.Position,
      token: monaco.CancellationToken,
    ) => {
      if (!mine(model)) return null;
      const list = await answerOf(
        provide(positionContext(model, position), abortSignal(token)),
        [],
      );
      return token.isCancellationRequested ? null : toLocations(host, list);
    };
  if (typeDefinition)
    add(
      monaco.languages.registerTypeDefinitionProvider(selector, {
        provideTypeDefinition: locations(typeDefinition),
      }),
    );
  if (implementation)
    add(
      monaco.languages.registerImplementationProvider(selector, {
        provideImplementation: locations(implementation),
      }),
    );
  if (declaration)
    add(
      monaco.languages.registerDeclarationProvider(selector, {
        provideDeclaration: locations(declaration),
      }),
    );
  if (documentHighlights)
    add(
      monaco.languages.registerDocumentHighlightProvider(selector, {
        provideDocumentHighlights: async (model, position, token) => {
          if (!mine(model)) return null;
          const list = await answerOf(
            documentHighlights(positionContext(model, position), abortSignal(token)),
            [],
          );
          if (token.isCancellationRequested) return null;
          return list.map((h) => ({
            range: toRange(model, h.range),
            kind: HIGHLIGHT_KINDS[h.kind],
          }));
        },
      }),
    );
  if (foldingRanges)
    add(
      monaco.languages.registerFoldingRangeProvider(selector, {
        provideFoldingRanges: async (model, _context, token) => {
          if (!mine(model)) return null;
          const list = await answerOf(
            foldingRanges(documentContext(model), abortSignal(token)),
            [],
          );
          if (token.isCancellationRequested) return null;
          const lines = model.getLineCount();
          return list
            .filter((r) => r.startLine < lines)
            .map((r) => ({
              start: r.startLine,
              end: Math.min(r.endLine, lines),
              ...(r.kind && { kind: new monaco.languages.FoldingRangeKind(r.kind) }),
            }));
        },
      }),
    );
  if (documentLinks)
    add(
      monaco.languages.registerLinkProvider(selector, {
        provideLinks: async (model, token) => {
          if (!mine(model)) return { links: [] };
          const list = await answerOf(
            documentLinks(documentContext(model), abortSignal(token)),
            [],
          );
          if (token.isCancellationRequested) return { links: [] };
          return {
            links: list.map((l) => {
              const t = l.target;
              // A file opens through the editor opener (`L<line>,<col>`, as the IDE's own path
              // links); a web address through the system.
              const url =
                "url" in t
                  ? t.url
                  : monaco.Uri.file(t.path).with({
                      fragment: t.line ? `L${t.line}${t.column ? `,${t.column}` : ""}` : "",
                    });
              return {
                range: toRange(model, l.range),
                url,
                ...(l.tooltip && { tooltip: l.tooltip }),
              };
            }),
          };
        },
      }),
    );
  if (colors)
    add(
      monaco.languages.registerColorProvider(selector, {
        provideDocumentColors: async (model, token) => {
          if (!mine(model)) return null;
          const list = await answerOf(
            colors.provide(documentContext(model), abortSignal(token)),
            [],
          );
          if (token.isCancellationRequested) return null;
          return list.map((c) => ({ range: toRange(model, c.range), color: c.color }));
        },
        provideColorPresentations: async (model, info, token) => {
          const fallback = [{ label: `#${colorHexDigits(info.color)}` }];
          if (!mine(model) || !colors.presentations) return fallback;
          const list = await answerOf(
            colors.presentations(
              { ...documentContext(model), color: info.color, range: fromRange(info.range) },
              abortSignal(token),
            ),
            [],
          );
          if (token.isCancellationRequested || !list.length) return fallback;
          return list.map((p) => ({
            label: p.label,
            ...(p.edit && { textEdit: { range: toRange(model, p.edit), text: p.edit.text } }),
          }));
        },
      }),
    );
  if (onTypeFormatting) {
    const [first, ...more] = onTypeFormatting.triggerCharacters;
    if (first)
      add(
        monaco.languages.registerOnTypeFormattingEditProvider(selector, {
          autoFormatTriggerCharacters: [first, ...more],
          provideOnTypeFormattingEdits: async (model, position, ch, options, token) => {
            if (!mine(model)) return null;
            const edits = await answerOf(
              onTypeFormatting.provide(
                {
                  ...positionContext(model, position),
                  ch,
                  tabSize: options.tabSize,
                  insertSpaces: options.insertSpaces,
                },
                abortSignal(token),
              ),
              [],
            );
            if (token.isCancellationRequested) return null;
            return edits.map((e) => ({ range: toRange(model, e), text: e.text }));
          },
        }),
      );
  }
  if (inlineCompletions)
    add(
      monaco.languages.registerInlineCompletionsProvider(selector, {
        provideInlineCompletions: async (model, position, context, token) => {
          if (!mine(model)) return { items: [] };
          const explicit =
            context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit;
          const list = await answerOf(
            inlineCompletions(
              { ...positionContext(model, position), explicit },
              abortSignal(token),
            ),
            [],
          );
          if (token.isCancellationRequested) return { items: [] };
          return {
            items: list.map((item) => ({
              insertText: item.insertText,
              range: item.range ? toRange(model, item.range) : monaco.Range.fromPositions(position),
              ...(item.command && { command: toCommand(item.command, "Accept") }),
            })),
          };
        },
        disposeInlineCompletions: () => {},
      }),
    );
  // D255: linked editing, Expand selection, and what the debugger's hover evaluates.
  const { linkedEditingRanges, selectionRanges, evaluatableExpression } = f;
  if (linkedEditingRanges)
    add(
      monaco.languages.registerLinkedEditingRangeProvider(selector, {
        provideLinkedEditingRanges: async (model, position, token) => {
          if (!mine(model)) return null;
          const found = await answerOf(
            linkedEditingRanges(positionContext(model, position), abortSignal(token)),
            null,
          );
          if (!found || token.isCancellationRequested) return null;
          return {
            ranges: found.ranges.map((r) => toRange(model, r)),
            ...(found.wordPattern && { wordPattern: new RegExp(found.wordPattern) }),
          };
        },
      }),
    );
  if (selectionRanges)
    add(
      monaco.languages.registerSelectionRangeProvider(selector, {
        provideSelectionRanges: async (model, positions, token) => {
          if (!mine(model)) return null;
          const chains = await answerOf(
            selectionRanges(
              {
                ...documentContext(model),
                positions: positions.map((p) => ({ line: p.lineNumber, column: p.column })),
              },
              abortSignal(token),
            ),
            [],
          );
          if (token.isCancellationRequested || !chains.length) return null;
          return chains.map((chain) => chain.map((r) => ({ range: toRange(model, r) })));
        },
      }),
    );
  if (evaluatableExpression)
    add(
      addEvaluatableSource(async (model, position) => {
        if (!mine(model)) return null;
        const controller = new AbortController();
        const found = await within(
          evaluatableExpression(positionContext(model, position), controller.signal),
          EVALUATABLE_MS,
        );
        controller.abort();
        if (!found) return null;
        const range = toRange(model, found.range);
        return { range, expression: found.expression ?? model.getValueInRange(range) };
      }),
    );
}

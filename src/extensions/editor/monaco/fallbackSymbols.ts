// Document symbols for languages with no language service running (D114): Markdown headings and
// declarations found line by line (../symbols.ts), for breadcrumbs, the Outline and "Go to symbol".
// A language server that provides symbols for a language takes over: this provider then answers
// with nothing for it.
import { type FoundSymbol, findSymbols, HEURISTIC_LANGUAGES } from "../symbols";
import * as monaco from "./core";

/** Languages a language server currently gives symbols for (count of servers). */
const serverLanguages = new Map<string, number>();

export function serverProvidesSymbols(languages: readonly string[]): monaco.IDisposable {
  for (const l of languages) serverLanguages.set(l, (serverLanguages.get(l) ?? 0) + 1);
  return {
    dispose: () => {
      for (const l of languages) {
        const n = (serverLanguages.get(l) ?? 1) - 1;
        if (n > 0) serverLanguages.set(l, n);
        else serverLanguages.delete(l);
      }
    },
  };
}

const K = monaco.languages.SymbolKind;
const KINDS: Record<string, monaco.languages.SymbolKind> = {
  function: K.Function,
  method: K.Method,
  class: K.Class,
  struct: K.Struct,
  enum: K.Enum,
  interface: K.Interface,
  module: K.Module,
  namespace: K.Namespace,
  key: K.Key,
  string: K.String,
};

function toMonaco(
  model: monaco.editor.ITextModel,
  s: FoundSymbol,
): monaco.languages.DocumentSymbol {
  const end = Math.min(s.endLine, model.getLineCount());
  const line = model.getLineContent(s.line);
  return {
    name: s.name,
    detail: "",
    kind: KINDS[s.kind] ?? K.Variable,
    tags: [],
    range: new monaco.Range(s.line, 1, end, model.getLineMaxColumn(end)),
    selectionRange: new monaco.Range(s.line, s.column, s.line, line.length + 1),
    children: s.children.map((c) => toMonaco(model, c)),
  };
}

export function registerFallbackSymbols(): void {
  monaco.languages.registerDocumentSymbolProvider(HEURISTIC_LANGUAGES, {
    displayName: "built-in",
    provideDocumentSymbols: (model) => {
      const language = model.getLanguageId();
      if (serverLanguages.has(language)) return [];
      // Huge files: skip (a language server would be the right tool there).
      if (model.getValueLength() > 2_000_000) return [];
      return findSymbols(language, model.getValue()).map((s) => toMonaco(model, s));
    },
  });
}

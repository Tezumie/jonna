// More of the editor engine's options as settings (D128), by VS Code's names: each `editor.*` key
// maps to an engine option path ("scrollbar.verticalScrollbarSize"). The settings' schemas are in
// extension.json; this table is the mapping, applied as one nested options object. DOM-free.

/** [setting key, engine option path, default] — the default is also the schema's. */
export const ADVANCED_EDITOR_SETTINGS: readonly [string, string, unknown][] = [
  ["editor.lineHeight", "lineHeight", 0],
  ["editor.fontWeight", "fontWeight", "normal"],
  ["editor.fontLigatures", "fontLigatures", false],
  ["editor.letterSpacing", "letterSpacing", 0],
  ["editor.cursorStyle", "cursorStyle", "line"],
  ["editor.cursorBlinking", "cursorBlinking", "blink"],
  ["editor.cursorSmoothCaretAnimation", "cursorSmoothCaretAnimation", "off"],
  ["editor.cursorWidth", "cursorWidth", 2],
  ["editor.smoothScrolling", "smoothScrolling", false],
  ["editor.mouseWheelZoom", "mouseWheelZoom", false],
  ["editor.scrollBeyondLastLine", "scrollBeyondLastLine", true],
  ["editor.scrollbar.verticalScrollbarSize", "scrollbar.verticalScrollbarSize", 12],
  ["editor.scrollbar.horizontalScrollbarSize", "scrollbar.horizontalScrollbarSize", 12],
  ["editor.renderLineHighlight", "renderLineHighlight", "line"],
  ["editor.wrappingIndent", "wrappingIndent", "same"],
  ["editor.renderControlCharacters", "renderControlCharacters", true],
  ["editor.renderFinalNewline", "renderFinalNewline", "on"],
  ["editor.guides.indentation", "guides.indentation", true],
  ["editor.guides.bracketPairs", "guides.bracketPairs", false],
  ["editor.matchBrackets", "matchBrackets", "always"],
  ["editor.folding", "folding", true],
  ["editor.showFoldingControls", "showFoldingControls", "mouseover"],
  ["editor.minimap.side", "minimap.side", "right"],
  ["editor.minimap.size", "minimap.size", "proportional"],
  ["editor.minimap.renderCharacters", "minimap.renderCharacters", true],
  ["editor.minimap.maxColumn", "minimap.maxColumn", 120],
  ["editor.stickyScroll.maxLineCount", "stickyScroll.maxLineCount", 5],
  ["editor.wordWrapColumn", "wordWrapColumn", 80],
  ["editor.autoClosingBrackets", "autoClosingBrackets", "languageDefined"],
  ["editor.autoClosingQuotes", "autoClosingQuotes", "languageDefined"],
  ["editor.autoSurround", "autoSurround", "languageDefined"],
  ["editor.formatOnPaste", "formatOnPaste", false],
  ["editor.formatOnType", "formatOnType", false],
  ["editor.linkedEditing", "linkedEditing", false],
  ["editor.columnSelection", "columnSelection", false],
  ["editor.occurrencesHighlight", "occurrencesHighlight", "singleFile"],
  ["editor.selectionHighlight", "selectionHighlight", true],
  ["editor.quickSuggestions", "quickSuggestions", true],
  ["editor.suggestOnTriggerCharacters", "suggestOnTriggerCharacters", true],
  ["editor.acceptSuggestionOnEnter", "acceptSuggestionOnEnter", "on"],
  ["editor.tabCompletion", "tabCompletion", "off"],
  ["editor.parameterHints.enabled", "parameterHints.enabled", true],
  ["editor.hover.enabled", "hover.enabled", true],
  ["editor.hover.delay", "hover.delay", 300],
  ["editor.inlayHints.enabled", "inlayHints.enabled", "on"],
  ["editor.codeLens", "codeLens", true],
  ["editor.colorDecorators", "colorDecorators", true],
  ["editor.dragAndDrop", "dragAndDrop", true],
  ["editor.emptySelectionClipboard", "emptySelectionClipboard", true],
  ["editor.multiCursorModifier", "multiCursorModifier", "alt"],
  ["editor.unicodeHighlight.ambiguousCharacters", "unicodeHighlight.ambiguousCharacters", true],
  ["editor.padding.top", "padding.top", 8],
  // One flat option name in the engine ("semanticHighlighting.enabled"), not nested (D204).
  ["editor.semanticHighlighting.enabled", "=semanticHighlighting.enabled", true],
];

/**
 * Engine options from the settings' values, nested by path. `editor.lineHeight` 0 means "the
 * IDE's own" (1.6 × the font size) and is left out.
 */
export function advancedEngineOptions(get: (key: string) => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, path, fallback] of ADVANCED_EDITOR_SETTINGS) {
    const value = get(key) ?? fallback;
    if (key === "editor.lineHeight" && !value) continue;
    if (path.startsWith("=")) {
      out[path.slice(1)] = value;
      continue;
    }
    const parts = path.split(".");
    let at = out;
    for (const part of parts.slice(0, -1)) {
      at[part] ??= {};
      at = at[part] as Record<string, unknown>;
    }
    at[parts[parts.length - 1] as string] = value;
  }
  return out;
}

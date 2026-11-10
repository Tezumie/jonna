// Builds the Monaco theme from the computed design tokens (DESIGN.md §15.1): Shiki provides syntax
// colors, these colors are merged on top. Re-run on every theme/accent/override change.
import { type Rgba, toHex, withAlpha } from "../../core/themes/color";
import type { ThemeService } from "../../workbench/theme";
import type { EditorTheme } from "./engine";

type Spec = [monacoKey: string, token: string, alpha?: number];

/** Monaco color key → semantic token (optionally scaled to an alpha). */
const MAP: Spec[] = [
  ["editor.background", "--bg-surface"],
  ["editorGutter.background", "--bg-surface"],
  ["editor.foreground", "--fg-default"],
  ["editorLineNumber.foreground", "--fg-disabled"],
  ["editorLineNumber.activeForeground", "--fg-muted"],
  ["editor.lineHighlightBackground", "--bg-hover"],
  ["editor.selectionBackground", "--accent", 0.35],
  ["editor.inactiveSelectionBackground", "--accent", 0.18],
  ["editor.selectionHighlightBackground", "--fg-default", 0.08],
  ["editor.wordHighlightBackground", "--fg-default", 0.08],
  ["editor.wordHighlightStrongBackground", "--fg-default", 0.08],
  ["editor.findMatchBackground", "--status-warning-fg", 0.35],
  ["editor.findMatchHighlightBackground", "--status-warning-fg", 0.16],
  ["editorCursor.foreground", "--fg-default"],
  ["editorBracketMatch.border", "--border-strong"],
  ["editorIndentGuide.background1", "--border-subtle"],
  ["editorIndentGuide.activeBackground1", "--border-strong"],
  ["editorRuler.foreground", "--border-subtle"],
  ["editorWhitespace.foreground", "--fg-disabled", 0.5],
  ["editorError.foreground", "--status-danger-fg"],
  ["editorWarning.foreground", "--status-warning-fg"],
  ["editorInfo.foreground", "--status-info-fg"],
  ["editorGutter.addedBackground", "--diff-added-fg"],
  ["editorGutter.modifiedBackground", "--diff-modified-fg"],
  ["editorGutter.deletedBackground", "--diff-removed-fg"],
  ["diffEditor.insertedLineBackground", "--diff-added-bg"],
  ["diffEditor.insertedTextBackground", "--diff-added-bg-strong"],
  ["diffEditor.removedLineBackground", "--diff-removed-bg"],
  ["diffEditor.removedTextBackground", "--diff-removed-bg-strong"],
  ["editorWidget.background", "--bg-overlay"],
  ["editorWidget.foreground", "--fg-default"],
  ["editorWidget.border", "--border-default"],
  ["editorWidget.resizeBorder", "--border-strong"],
  ["editorHoverWidget.foreground", "--fg-default"],
  ["editorHoverWidget.statusBarBackground", "--bg-surface-raised"],
  ["editorSuggestWidget.foreground", "--fg-default"],
  ["editorSuggestWidget.highlightForeground", "--fg-default"],
  ["editorSuggestWidget.focusHighlightForeground", "--fg-default"],
  ["editorSuggestWidget.selectedForeground", "--fg-default"],
  ["editorSuggestWidgetStatus.foreground", "--fg-subtle"],
  ["editorParameterHint.background", "--bg-overlay"],
  ["editorFind.matchBorder", "--status-warning-fg", 0],
  ["textLink.foreground", "--accent-text"],
  ["textLink.activeForeground", "--accent-text"],
  ["descriptionForeground", "--fg-muted"],
  ["icon.foreground", "--fg-muted"],
  ["toolbar.hoverBackground", "--bg-hover"],
  ["inputOption.activeForeground", "--fg-default"],
  ["inputValidation.errorBorder", "--status-danger-fg"],
  ["inputValidation.errorBackground", "--bg-overlay"],
  ["foreground", "--fg-default"],
  ["editorHoverWidget.background", "--bg-overlay"],
  ["editorHoverWidget.border", "--border-default"],
  ["editorSuggestWidget.background", "--bg-overlay"],
  ["editorSuggestWidget.border", "--border-default"],
  ["editorSuggestWidget.selectedBackground", "--bg-selected-focus"],
  ["editorStickyScroll.background", "--bg-surface"],
  ["editorStickyScroll.border", "--border-subtle"],
  ["editorStickyScrollHover.background", "--bg-hover"],
  ["input.background", "--bg-input-raised"],
  ["input.foreground", "--fg-default"],
  ["input.border", "--border-default"],
  ["inputOption.activeBackground", "--accent-subtle"],
  ["inputOption.activeBorder", "--accent-border"],
  ["focusBorder", "--focus-ring"],
  ["widget.shadow", "--bg-scrim"],
  ["scrollbar.shadow", "--bg-app", 0],
  ["scrollbarSlider.background", "--fg-subtle", 0.35],
  ["scrollbarSlider.hoverBackground", "--fg-subtle", 0.5],
  ["scrollbarSlider.activeBackground", "--fg-subtle", 0.5],
  ["editorOverviewRuler.border", "--bg-surface", 0],
  ["minimap.background", "--bg-surface"],
  ["minimapSlider.background", "--bg-hover"],
  ["list.hoverBackground", "--bg-hover"],
  ["list.activeSelectionBackground", "--bg-selected-focus"],
  ["list.activeSelectionForeground", "--fg-default"],
  ["list.highlightForeground", "--fg-default"],
  ["list.focusHighlightForeground", "--fg-default"],
  // Peek (definition / references / implementations, D116): an inset editor in the editor's own
  // colors, a raised title and result list — not Monaco's blue defaults.
  ["peekView.border", "--accent-border"],
  ["peekViewTitle.background", "--bg-surface-raised"],
  ["peekViewTitleLabel.foreground", "--fg-default"],
  ["peekViewTitleDescription.foreground", "--fg-muted"],
  ["peekViewEditor.background", "--bg-surface-sunken"],
  ["peekViewEditorGutter.background", "--bg-surface-sunken"],
  ["peekViewEditorStickyScroll.background", "--bg-surface-sunken"],
  ["peekViewEditorStickyScrollGutter.background", "--bg-surface-sunken"],
  ["peekViewEditor.matchHighlightBackground", "--status-warning-fg", 0.28],
  ["peekViewResult.background", "--bg-surface-raised"],
  ["peekViewResult.fileForeground", "--fg-default"],
  ["peekViewResult.lineForeground", "--fg-muted"],
  ["peekViewResult.matchHighlightBackground", "--status-warning-fg", 0.28],
  ["peekViewResult.selectionBackground", "--bg-selected-focus"],
  ["peekViewResult.selectionForeground", "--fg-default"],
  // Problems peek (F8), the quick pick ("Go to symbol in editor", Ctrl+Shift+O), hints.
  ["editorMarkerNavigation.background", "--bg-surface-sunken"],
  ["editorMarkerNavigationError.background", "--status-danger-fg"],
  ["editorMarkerNavigationError.headerBackground", "--status-danger-fg", 0.12],
  ["editorMarkerNavigationWarning.background", "--status-warning-fg"],
  ["editorMarkerNavigationWarning.headerBackground", "--status-warning-fg", 0.12],
  ["editorMarkerNavigationInfo.background", "--status-info-fg"],
  ["editorMarkerNavigationInfo.headerBackground", "--status-info-fg", 0.12],
  ["quickInput.background", "--bg-overlay"],
  ["quickInput.foreground", "--fg-default"],
  ["quickInputTitle.background", "--bg-surface-raised"],
  ["quickInputList.focusBackground", "--bg-selected-focus"],
  ["quickInputList.focusForeground", "--fg-default"],
  ["pickerGroup.foreground", "--fg-muted"],
  ["pickerGroup.border", "--border-subtle"],
  ["list.focusOutline", "--focus-ring", 0],
  ["editorInlayHint.background", "--fg-default", 0.06],
  ["editorInlayHint.foreground", "--fg-subtle"],
  ["editorCodeLens.foreground", "--fg-subtle"],
  ["editorGhostText.foreground", "--fg-subtle"],
  ["editorLink.activeForeground", "--accent-text"],
  ["editorLightBulb.foreground", "--status-warning-fg"],
  ["editorLightBulbAutoFix.foreground", "--accent-text"],
  ["badge.background", "--accent"],
  ["badge.foreground", "--fg-on-accent"],
  ["editorBracketHighlight.unexpectedBracket.foreground", "--status-danger-fg"],
];

export function editorThemeFromTokens(theme: ThemeService): EditorTheme {
  const colors: Record<string, string> = {};
  const cache = new Map<string, Rgba | null>();
  for (const [key, token, alpha] of MAP) {
    if (!cache.has(token)) cache.set(token, theme.color(token));
    const c = cache.get(token);
    if (!c) continue;
    colors[key] = toHex(alpha === undefined ? c : withAlpha(c, alpha));
  }
  // Bracket match: transparent fill (DESIGN.md §15.1).
  const surface = theme.color("--bg-surface");
  if (surface) colors["editorBracketMatch.background"] = toHex(withAlpha(surface, 0));
  const kind = theme.theme.peek();
  const custom = theme.syntaxTheme;
  if (custom) return { kind, syntax: custom.name, colors, syntaxTheme: custom.json };
  const syntax = theme.token("--syntax-theme") || (kind === "light" ? "light-plus" : "dark-plus");
  return { kind, syntax, colors };
}

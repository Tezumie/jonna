// VS Code's `--vscode-*` CSS variables for VS Code extensions' pages (D260), from the IDE's
// tokens. VS Code gives a webview every theme color as `--vscode-<id with . as ->`; pages style
// themselves with them (their own background, inputs, buttons, badges…). The colors extensions'
// pages use most are here, each the IDE token that plays that part. DOM-free and unit-tested.

/** Where the IDE puts the theme of the moment in a VS Code page's bridge (D260: no white first paint). */
export const INITIAL_THEME_SLOT = "/*ide-theme*/null";

/**
 * Where the IDE puts the webview's own key for its saved state (`getState` / `setState`, D263):
 * an extension's pages share one origin, so one key for all made a new panel restore another
 * page's state (the session it showed, the kind of page it was).
 */
export const STATE_KEY_SLOT = '"vscode-state"/*ide-state-key*/';

/**
 * Where the IDE puts a page's state saved before a restart (a restored webview panel's: VS
 * Code's getState() returns it), used when the session has none of its own yet.
 */
export const INITIAL_STATE_SLOT = "/*ide-page-state*/undefined";

/** VS Code color id → the IDE token that plays its part. */
export const VSCODE_WEBVIEW_COLORS: Readonly<Record<string, string>> = {
  foreground: "--fg-default",
  descriptionForeground: "--fg-muted",
  disabledForeground: "--fg-disabled",
  errorForeground: "--status-danger-fg",
  focusBorder: "--focus-ring",
  "widget.border": "--border-default",
  "widget.shadow": "--bg-scrim",
  "selection.background": "--accent-subtle",
  "icon.foreground": "--fg-muted",
  "sash.hoverBorder": "--accent",
  contrastBorder: "--border-subtle",

  "editor.background": "--bg-surface",
  "editor.foreground": "--fg-default",
  "editor.selectionBackground": "--accent-subtle",
  "editor.inactiveSelectionBackground": "--bg-selected",
  "editor.lineHighlightBackground": "--bg-hover",
  "editor.findMatchHighlightBackground": "--accent-subtle",
  "editorLineNumber.foreground": "--fg-subtle",
  "editorLineNumber.activeForeground": "--fg-muted",
  "editorCursor.foreground": "--fg-default",
  "editorWidget.background": "--bg-overlay",
  "editorWidget.foreground": "--fg-default",
  "editorWidget.border": "--border-default",
  "editorHoverWidget.background": "--bg-overlay",
  "editorHoverWidget.foreground": "--fg-default",
  "editorHoverWidget.border": "--border-default",
  "editorSuggestWidget.background": "--bg-overlay",
  "editorSuggestWidget.foreground": "--fg-default",
  "editorSuggestWidget.border": "--border-default",
  "editorSuggestWidget.selectedBackground": "--bg-selected",
  "editorSuggestWidget.highlightForeground": "--accent-text",
  "editorGroupHeader.tabsBackground": "--bg-app",
  "editorError.foreground": "--status-danger-fg",
  "editorWarning.foreground": "--status-warning-fg",
  "editorInfo.foreground": "--status-info-fg",
  "editorGutter.addedBackground": "--diff-added-fg",
  "editorGutter.modifiedBackground": "--diff-modified-fg",
  "editorGutter.deletedBackground": "--diff-removed-fg",
  "diffEditor.insertedTextBackground": "--diff-added-bg-strong",
  "diffEditor.removedTextBackground": "--diff-removed-bg-strong",
  "diffEditor.insertedLineBackground": "--diff-added-bg",
  "diffEditor.removedLineBackground": "--diff-removed-bg",

  "sideBar.background": "--bg-app",
  "sideBar.foreground": "--fg-default",
  "sideBar.border": "--border-subtle",
  "sideBarTitle.foreground": "--fg-default",
  "sideBarSectionHeader.background": "--bg-app",
  "sideBarSectionHeader.foreground": "--fg-default",
  "sideBarSectionHeader.border": "--border-subtle",
  "activityBar.background": "--bg-app",
  "activityBar.foreground": "--fg-default",
  "panel.background": "--bg-surface",
  "panel.border": "--border-default",
  "panelTitle.activeForeground": "--fg-default",
  "panelTitle.inactiveForeground": "--fg-muted",
  "panelSection.border": "--border-subtle",
  "panelSectionHeader.background": "--bg-surface",
  "titleBar.activeBackground": "--bg-app",
  "titleBar.activeForeground": "--fg-default",
  "statusBar.background": "--bg-app",
  "statusBar.foreground": "--fg-muted",
  "tab.activeBackground": "--bg-surface",
  "tab.activeForeground": "--fg-default",
  "tab.inactiveBackground": "--bg-app",
  "tab.inactiveForeground": "--fg-muted",
  "tab.border": "--border-subtle",

  "button.background": "--accent",
  "button.foreground": "--fg-on-accent",
  "button.hoverBackground": "--accent-hover",
  "button.border": "--accent-border",
  "button.secondaryBackground": "--bg-chip",
  "button.secondaryForeground": "--fg-default",
  "button.secondaryHoverBackground": "--bg-hover",
  "input.background": "--bg-input",
  "input.foreground": "--fg-default",
  "input.border": "--border-default",
  "input.placeholderForeground": "--fg-subtle",
  "inputOption.activeBackground": "--accent-subtle",
  "inputOption.activeBorder": "--accent-border",
  "inputOption.activeForeground": "--fg-default",
  "inputValidation.errorBackground": "--status-danger-bg",
  "inputValidation.errorBorder": "--status-danger-border",
  "inputValidation.warningBackground": "--status-warning-bg",
  "inputValidation.warningBorder": "--status-warning-border",
  "inputValidation.infoBackground": "--status-info-bg",
  "inputValidation.infoBorder": "--status-info-border",
  "dropdown.background": "--bg-input",
  "dropdown.foreground": "--fg-default",
  "dropdown.border": "--border-default",
  "dropdown.listBackground": "--bg-overlay",
  "checkbox.background": "--bg-input",
  "checkbox.foreground": "--fg-default",
  "checkbox.border": "--border-default",
  "badge.background": "--bg-chip",
  "badge.foreground": "--fg-default",
  "activityBarBadge.background": "--accent",
  "activityBarBadge.foreground": "--fg-on-accent",
  "progressBar.background": "--accent",
  "keybindingLabel.background": "--bg-chip",
  "keybindingLabel.foreground": "--fg-default",
  "keybindingLabel.border": "--border-default",
  "keybindingLabel.bottomBorder": "--border-strong",

  "list.hoverBackground": "--bg-hover",
  "list.hoverForeground": "--fg-default",
  "list.activeSelectionBackground": "--bg-selected-focus",
  "list.activeSelectionForeground": "--fg-default",
  "list.inactiveSelectionBackground": "--bg-selected",
  "list.inactiveSelectionForeground": "--fg-default",
  "list.focusOutline": "--focus-ring",
  "list.highlightForeground": "--accent-text",
  "list.errorForeground": "--status-danger-fg",
  "list.warningForeground": "--status-warning-fg",
  "tree.indentGuidesStroke": "--border-default",
  "menu.background": "--bg-overlay",
  "menu.foreground": "--fg-default",
  "menu.border": "--border-default",
  "menu.selectionBackground": "--bg-selected-focus",
  "menu.selectionForeground": "--fg-default",
  "menu.separatorBackground": "--border-subtle",
  "quickInput.background": "--bg-overlay",
  "quickInput.foreground": "--fg-default",
  "pickerGroup.foreground": "--accent-text",
  "pickerGroup.border": "--border-subtle",
  "notifications.background": "--bg-overlay",
  "notifications.foreground": "--fg-default",
  "notifications.border": "--border-default",
  "scrollbar.shadow": "--bg-scrim",
  "scrollbarSlider.background": "--scrollbar-thumb",
  "scrollbarSlider.hoverBackground": "--scrollbar-thumb-hover",
  "scrollbarSlider.activeBackground": "--scrollbar-thumb-active",

  "textLink.foreground": "--accent-text",
  "textLink.activeForeground": "--accent-text",
  "textPreformat.foreground": "--fg-default",
  "textPreformat.background": "--bg-chip",
  "textBlockQuote.background": "--bg-surface-sunken",
  "textBlockQuote.border": "--border-strong",
  "textCodeBlock.background": "--bg-surface-sunken",
  "textSeparator.foreground": "--border-default",

  "chat.requestBackground": "--bg-surface-raised",
  "chat.requestBorder": "--border-subtle",
  "chat.slashCommandBackground": "--accent-subtle",
  "chat.slashCommandForeground": "--accent-text",
  "chat.avatarBackground": "--bg-chip",
  "chat.avatarForeground": "--fg-default",
  "interactive.activeCodeBorder": "--accent-border",
  "interactive.inactiveCodeBorder": "--border-subtle",

  "notificationsErrorIcon.foreground": "--status-danger-fg",
  "notificationsWarningIcon.foreground": "--status-warning-fg",
  "notificationsInfoIcon.foreground": "--status-info-fg",
  "problemsErrorIcon.foreground": "--status-danger-fg",
  "problemsWarningIcon.foreground": "--status-warning-fg",
  "problemsInfoIcon.foreground": "--status-info-fg",
  "testing.iconPassed": "--status-success-fg",
  "testing.iconFailed": "--status-danger-fg",
  "gitDecoration.addedResourceForeground": "--status-success-fg",
  "gitDecoration.modifiedResourceForeground": "--git-modified-fg",
  "gitDecoration.deletedResourceForeground": "--status-danger-fg",
  "gitDecoration.untrackedResourceForeground": "--status-success-fg",
  "gitDecoration.ignoredResourceForeground": "--fg-subtle",
  "charts.foreground": "--fg-default",
  "charts.lines": "--border-default",
  "charts.red": "--status-danger-fg",
  "charts.orange": "--status-warning-fg",
  "charts.yellow": "--label-3",
  "charts.green": "--status-success-fg",
  "charts.blue": "--accent",
  "charts.purple": "--label-6",

  "terminal.background": "--bg-surface",
  "terminal.foreground": "--fg-default",
  "terminal.ansiBlack": "--terminal-ansi-black",
  "terminal.ansiRed": "--terminal-ansi-red",
  "terminal.ansiGreen": "--terminal-ansi-green",
  "terminal.ansiYellow": "--terminal-ansi-yellow",
  "terminal.ansiBlue": "--terminal-ansi-blue",
  "terminal.ansiMagenta": "--terminal-ansi-magenta",
  "terminal.ansiCyan": "--terminal-ansi-cyan",
  "terminal.ansiWhite": "--terminal-ansi-white",
  "terminal.ansiBrightBlack": "--terminal-ansi-bright-black",
  "terminal.ansiBrightRed": "--terminal-ansi-bright-red",
  "terminal.ansiBrightGreen": "--terminal-ansi-bright-green",
  "terminal.ansiBrightYellow": "--terminal-ansi-bright-yellow",
  "terminal.ansiBrightBlue": "--terminal-ansi-bright-blue",
  "terminal.ansiBrightMagenta": "--terminal-ansi-bright-magenta",
  "terminal.ansiBrightCyan": "--terminal-ansi-bright-cyan",
  "terminal.ansiBrightWhite": "--terminal-ansi-bright-white",

  "symbolIcon.functionForeground": "--syntax-function",
  "symbolIcon.methodForeground": "--syntax-function",
  "symbolIcon.variableForeground": "--syntax-variable",
  "symbolIcon.classForeground": "--syntax-keyword",
  "symbolIcon.stringForeground": "--syntax-string",
};

/** Font variables VS Code sets beside the colors (sizes in px, as VS Code writes them). */
const FONT_VARS: Readonly<Record<string, string>> = {
  "--vscode-font-family": "--font-ui",
  "--vscode-editor-font-family": "--font-mono",
  "--vscode-font-size": "--text-md",
  "--vscode-editor-font-size": "--text-md",
};

/** "editorWidget.background" → "--vscode-editorWidget-background". */
export function vscodeColorVar(id: string): string {
  return `--vscode-${id.replace(/\./g, "-")}`;
}

/**
 * The `--vscode-*` variables of the current theme, `read` giving an IDE token's value (empty when
 * the theme has none, which leaves that variable out).
 */
export function vscodeWebviewVars(read: (token: string) => string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [id, token] of Object.entries(VSCODE_WEBVIEW_COLORS)) {
    const value = read(token).trim();
    if (value) vars[vscodeColorVar(id)] = value;
  }
  for (const [name, token] of Object.entries(FONT_VARS)) {
    const value = read(token).trim();
    if (value) vars[name] = value;
  }
  vars["--vscode-font-weight"] = "normal";
  vars["--vscode-editor-font-weight"] = "normal";
  return vars;
}

/** VS Code's body class for a theme kind ("vscode-dark", "vscode-light", "vscode-high-contrast"). */
export function vscodeThemeClass(kind: string): string {
  if (/high|hc/i.test(kind))
    return /light/i.test(kind) ? "vscode-high-contrast-light" : "vscode-high-contrast";
  return /light/i.test(kind) ? "vscode-light" : "vscode-dark";
}

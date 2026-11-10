// VS Code theme import (DESIGN.md §19): maps a VS Code-format theme's `colors` onto our semantic
// tokens. The result is applied at runtime as overrides on top of the built-in theme of the same
// kind. Unmapped keys are ignored; tokens with no source keep the base theme's value.
// M1.5 ships the mapping + apply/clear; the "import a theme file" UI arrives with settings (M2).

import { parseCssColor, type Rgba } from "./color";

export interface VsCodeTheme {
  type?: "dark" | "light" | "hc" | string;
  colors?: Record<string, string>;
}

/** Token → VS Code keys, first match wins. */
export const TOKEN_SOURCES: Record<string, readonly string[]> = {
  "--bg-app": ["titleBar.activeBackground", "activityBar.background"],
  "--bg-surface": ["editor.background"],
  "--bg-surface-sunken": ["input.background", "sideBar.background"],
  // The side bar when set apart (workbench.sideBarColor "distinct", D275).
  "--bg-sidebar": ["sideBar.background"],
  "--bg-surface-raised": ["editorWidget.background", "dropdown.background"],
  // Menus, tooltips, pickers. A theme without menu colors (Night Owl) gets VS Code's own
  // fallbacks: its widgets', dropdowns' and hovers' background (D258).
  "--bg-overlay": [
    "menu.background",
    "quickInput.background",
    "editorWidget.background",
    "dropdown.background",
    "editorHoverWidget.background",
  ],
  // Scrollbar thumbs (D258): the theme's, everywhere (the editor's already were).
  "--scrollbar-thumb": ["scrollbarSlider.background"],
  "--scrollbar-thumb-near": ["scrollbarSlider.hoverBackground", "scrollbarSlider.background"],
  "--scrollbar-thumb-hover": ["scrollbarSlider.hoverBackground"],
  "--scrollbar-thumb-active": ["scrollbarSlider.activeBackground"],
  "--fg-default": ["editor.foreground", "foreground"],
  "--fg-muted": ["descriptionForeground", "tab.inactiveForeground"],
  "--fg-subtle": ["editorLineNumber.activeForeground"],
  "--accent": ["focusBorder", "button.background"],
  // The second accent (D276): not a VS Code color; a built-in theme of ours sets it (Claude
  // Dark's blue). Others keep the accent.
  "--accent-secondary": ["secondaryAccent"],
  "--status-danger-fg": ["editorError.foreground"],
  "--status-warning-fg": ["editorWarning.foreground"],
  "--status-danger-solid": ["statusBarItem.errorBackground", "inputValidation.errorBorder"],
  "--status-warning-solid": ["statusBarItem.warningBackground"],
  "--status-success-fg": ["gitDecoration.addedResourceForeground"],
  "--git-modified-fg": ["gitDecoration.modifiedResourceForeground"],
  "--diff-added-bg": ["diffEditor.insertedLineBackground"],
  "--diff-removed-bg": ["diffEditor.removedLineBackground"],
  "--terminal-ansi-black": ["terminal.ansiBlack"],
  "--terminal-ansi-red": ["terminal.ansiRed"],
  "--terminal-ansi-green": ["terminal.ansiGreen"],
  "--terminal-ansi-yellow": ["terminal.ansiYellow"],
  "--terminal-ansi-blue": ["terminal.ansiBlue"],
  "--terminal-ansi-magenta": ["terminal.ansiMagenta"],
  "--terminal-ansi-cyan": ["terminal.ansiCyan"],
  "--terminal-ansi-white": ["terminal.ansiWhite"],
  "--terminal-ansi-bright-black": ["terminal.ansiBrightBlack"],
  "--terminal-ansi-bright-red": ["terminal.ansiBrightRed"],
  "--terminal-ansi-bright-green": ["terminal.ansiBrightGreen"],
  "--terminal-ansi-bright-yellow": ["terminal.ansiBrightYellow"],
  "--terminal-ansi-bright-blue": ["terminal.ansiBrightBlue"],
  "--terminal-ansi-bright-magenta": ["terminal.ansiBrightMagenta"],
  "--terminal-ansi-bright-cyan": ["terminal.ansiBrightCyan"],
  "--terminal-ansi-bright-white": ["terminal.ansiBrightWhite"],
  // Source control's Graph (D210).
  "--scm-graph-ref": ["scmGraph.historyItemRefColor", "charts.blue"],
  "--scm-graph-remote": ["scmGraph.historyItemRemoteRefColor", "charts.purple"],
  "--scm-graph-tag": ["charts.yellow"],
  "--scm-graph-base": ["scmGraph.historyItemBaseRefColor", "charts.orange"],
  "--scm-graph-lane-0": ["scmGraph.foreground1"],
  "--scm-graph-lane-1": ["scmGraph.foreground2"],
  "--scm-graph-lane-2": ["scmGraph.foreground3"],
  "--scm-graph-lane-3": ["scmGraph.foreground4"],
  "--scm-graph-lane-4": ["scmGraph.foreground5"],
  // Inline values while debugging.
  "--debug-inline-value-fg": ["editor.inlineValuesForeground"],
  "--debug-inline-value-bg": ["editor.inlineValuesBackground"],
};

const COLOR = /^#[0-9a-f]{3,8}$/i;

/** Surfaces text sits on: a theme color only counts if the theme's text reads on it. */
const SURFACES = new Set([
  "--bg-app",
  "--bg-surface",
  "--bg-surface-sunken",
  "--bg-surface-raised",
  "--bg-overlay",
  "--bg-sidebar",
]);
/** Accents should be colors; a near-gray "accent" (a dark focus border) keeps the base one. */
const ACCENTS = new Set(["--accent", "--accent-secondary"]);
/**
 * Dimmed text: a theme color as bright as its main text isn't one (D273: Claude Dark's active
 * line number is its text color, so placeholders and hints came out bright); the base stays.
 */
const DIMMED = new Set(["--fg-subtle"]);
const MIN_DIMMED_CONTRAST = 1.5;

function luminance(c: Rgba): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

export function contrast(a: Rgba, b: Rgba): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** How colorful (0 gray … 1 pure hue); unlike saturation, near-black blues stay low. */
function chroma(c: Rgba): number {
  return (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) / 255;
}

/** Text on a surface needs this contrast (WCAG AA for body text). */
const MIN_TEXT_CONTRAST = 4.5;

/**
 * Token overrides for a VS Code theme plus the base kind it should sit on. The IDE uses one text
 * color on every surface, so a surface color the theme's text can't be read on is left out (Slack
 * Ochin's dark title bar, side bar and menus in a light theme): the base theme's surface of the
 * same kind takes its place. Borders keep the base theme's (themes' panel borders are often
 * loud accents meant for one line, not every divider).
 */
export function mapVsCodeTheme(theme: VsCodeTheme): {
  kind: "dark" | "light";
  tokens: Record<string, string>;
} {
  const tokens: Record<string, string> = {};
  const colors = theme.colors ?? {};
  const kind = theme.type === "light" ? "light" : "dark";
  const valid = (v: unknown): v is string => typeof v === "string" && COLOR.test(v);
  const fgSource = TOKEN_SOURCES["--fg-default"]?.map((k) => colors[k]).find(valid);
  const fg = parseCssColor(fgSource ?? (kind === "light" ? "#1f1f1f" : "#e6e6e6"));
  for (const [token, keys] of Object.entries(TOKEN_SOURCES)) {
    const value = keys
      .map((k) => colors[k])
      .find((v) => {
        if (!valid(v)) return false;
        const c = parseCssColor(v);
        if (!c) return false;
        if (SURFACES.has(token) && fg && c.a > 0.5 && contrast(c, fg) < MIN_TEXT_CONTRAST)
          return false;
        if (ACCENTS.has(token) && chroma(c) < 0.12) return false;
        if (DIMMED.has(token) && fg && contrast(c, fg) < MIN_DIMMED_CONTRAST) return false;
        return true;
      });
    if (value) tokens[token] = value;
  }
  // Text on the accent (primary buttons, badges) stays readable (D190): the theme's button text
  // when it contrasts with the accent, else black or white (a yellow accent got white text).
  const own = [colors["button.foreground"], colors["badge.foreground"]].find(valid);
  if (tokens["--accent"] && own) tokens["--fg-on-accent"] = own;
  Object.assign(tokens, readableOnAccent(tokens));
  return { kind, tokens };
}

/** Button text on the accent needs this (WCAG AA for large / bold UI text). */
const MIN_ACCENT_TEXT_CONTRAST = 3;

/**
 * A theme's accent with text that can't be read on it (an extension theme's yellow accent with
 * the base theme's white, D190): black or white instead, whichever reads better.
 */
export function readableOnAccent(tokens: Record<string, string>): Record<string, string> {
  const accent = tokens["--accent"] ? parseCssColor(tokens["--accent"]) : null;
  if (!accent) return {};
  const current = parseCssColor(tokens["--fg-on-accent"] ?? "#ffffff");
  if (current && contrast(current, accent) >= MIN_ACCENT_TEXT_CONTRAST) return {};
  return { "--fg-on-accent": readableTextOn(accent) };
}

/** Black or white, whichever reads better on `background`. */
export function readableTextOn(background: Rgba): string {
  const black = { r: 0, g: 0, b: 0, a: 1 };
  const white = { r: 255, g: 255, b: 255, a: 1 };
  return contrast(black, background) > contrast(white, background) ? "#000000" : "#ffffff";
}

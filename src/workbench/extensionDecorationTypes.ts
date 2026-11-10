// Text editor decoration types for extensions (D234, VS Code's
// `window.createTextEditorDecorationType`): how a set of ranges looks — text and background
// colors, a border, font style and weight, text decoration, opacity, whole lines, text before and
// after, a mark in the overview ruler and a bar in the gutter, with light and dark variants. What
// the extension sends is untrusted: every value is checked here (DOM-free, unit-tested) so the
// editor can put it into a stylesheet as it is. Colors are the IDE's theme names ("error",
// "warning", "label3"…, or VS Code's ThemeColor ids for them) which follow the theme, or a literal
// color an extension's user chose (Better Comments' and Peacock's settings): hex digits or the CSS
// color functions, numbers only.

/** A checked CSS color: a `var(--token)` of the theme, or a literal. */
export type CssColor = string;

/** Theme names an extension can use, and the tokens they are. */
const THEME_COLORS: Record<string, string> = {
  error: "--status-danger-fg",
  warning: "--status-warning-fg",
  info: "--status-info-fg",
  success: "--status-success-fg",
  errorBackground: "--status-danger-bg",
  warningBackground: "--status-warning-bg",
  infoBackground: "--status-info-bg",
  successBackground: "--status-success-bg",
  accent: "--accent",
  accentBackground: "--accent-subtle",
  foreground: "--fg-default",
  muted: "--fg-muted",
  subtle: "--fg-subtle",
  border: "--border-default",
  label1: "--label-1",
  label2: "--label-2",
  label3: "--label-3",
  label4: "--label-4",
  label5: "--label-5",
  label6: "--label-6",
};

/** VS Code's ThemeColor ids extensions use most, as the theme names above. */
const VSCODE_THEME_COLORS: Record<string, string> = {
  "editorError.foreground": "error",
  "editorWarning.foreground": "warning",
  "editorInfo.foreground": "info",
  errorForeground: "error",
  "editorError.background": "errorBackground",
  "editorWarning.background": "warningBackground",
  "editorInfo.background": "infoBackground",
  "editorOverviewRuler.errorForeground": "error",
  "editorOverviewRuler.warningForeground": "warning",
  "editorOverviewRuler.infoForeground": "info",
  "editorCodeLens.foreground": "subtle",
  "editorLineNumber.foreground": "subtle",
  descriptionForeground: "muted",
  "textLink.foreground": "accent",
  focusBorder: "accent",
  "editor.findMatchHighlightBackground": "accentBackground",
  "terminal.ansiRed": "label1",
  "terminal.ansiYellow": "label3",
  "terminal.ansiGreen": "label4",
  "terminal.ansiCyan": "label5",
  "terminal.ansiBlue": "accent",
  "terminal.ansiMagenta": "label6",
  "gitDecoration.addedResourceForeground": "success",
  "gitDecoration.modifiedResourceForeground": "warning",
  "gitDecoration.deletedResourceForeground": "error",
  // D258: what file decorations use most.
  "gitDecoration.untrackedResourceForeground": "success",
  "gitDecoration.ignoredResourceForeground": "subtle",
  "gitDecoration.conflictingResourceForeground": "error",
  "gitDecoration.renamedResourceForeground": "info",
  "gitDecoration.stageModifiedResourceForeground": "warning",
  "gitDecoration.stageDeletedResourceForeground": "error",
  "gitDecoration.submoduleResourceForeground": "accent",
  "list.errorForeground": "error",
  "list.warningForeground": "warning",
  "list.highlightForeground": "accent",
  "problemsErrorIcon.foreground": "error",
  "problemsWarningIcon.foreground": "warning",
  "problemsInfoIcon.foreground": "info",
  "charts.red": "error",
  "charts.orange": "warning",
  "charts.yellow": "label3",
  "charts.green": "success",
  "charts.blue": "accent",
  "charts.purple": "label6",
  "charts.foreground": "foreground",
};

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOR_FUNCTION = /^(?:rgb|rgba|hsl|hsla)\([\d\s.,%/+-]{1,60}\)$/i;

/** The theme token a theme name stands for ("--status-danger-fg"), or undefined. */
export function themeToken(name: string): string | undefined {
  return THEME_COLORS[VSCODE_THEME_COLORS[name] ?? name];
}

/** A color the extension gave (a name, `{ id }`, hex or a color function), checked; or undefined. */
export function toCssColor(raw: unknown): CssColor | undefined {
  const name =
    typeof raw === "string"
      ? raw.trim()
      : raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string"
        ? (raw as { id: string }).id
        : undefined;
  if (!name) return undefined;
  const token = themeToken(name);
  if (token) return `var(${token})`;
  if (name === "transparent") return name;
  if (HEX.test(name) || COLOR_FUNCTION.test(name)) return name;
  return undefined;
}

export interface DecorationLook {
  color?: CssColor;
  backgroundColor?: CssColor;
  /** A border all round (`borderStyle` default solid, `borderWidth` 1 to 3 px). */
  borderColor?: CssColor;
  borderStyle?: "solid" | "dashed" | "dotted";
  borderWidth?: number;
  /** 0 to 8 px. */
  borderRadius?: number;
  outlineColor?: CssColor;
  fontStyle?: "italic" | "normal";
  fontWeight?: "bold" | "normal";
  textDecoration?: "underline" | "line-through" | "none" | "underline dotted" | "underline wavy";
  /** 0.1 to 1. */
  opacity?: number;
}

/** Text before or after each range (VS Code's ThemableDecorationAttachmentRenderOptions). */
export interface DecorationAttachment {
  contentText: string;
  color?: CssColor;
  backgroundColor?: CssColor;
  fontStyle?: "italic" | "normal";
  fontWeight?: "bold" | "normal";
  /** Space between it and the code, 0 to 4 em (default: a small gap). */
  marginEm?: number;
}

export interface DecorationTypeStyle {
  look: DecorationLook;
  light?: DecorationLook;
  dark?: DecorationLook;
  isWholeLine: boolean;
  before?: DecorationAttachment;
  after?: DecorationAttachment;
  /** A mark at the range's height in the scrollbar. */
  overviewRuler?: { color: CssColor; lane: "left" | "center" | "right" | "full" };
  /** A colored bar beside the line numbers (VS Code's gutter icon, as a color). */
  gutterColor?: CssColor;
}

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
  allowed.includes(v as T) ? (v as T) : undefined;

const clamp = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined;

/** VS Code writes "1px", "2px solid"…: the number of pixels. */
const pixels = (v: unknown): number | undefined =>
  clamp(typeof v === "string" ? Number.parseFloat(v) : v, 0, 8);

/** Plain text for before/after (no line breaks or control characters), 120 characters at most. */
export function cleanContent(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what's removed
  const text = v.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 120);
  return text || undefined;
}

function toLook(raw: unknown): DecorationLook {
  const r = record(raw);
  const look: DecorationLook = {};
  const color = toCssColor(r.color);
  if (color) look.color = color;
  const background = toCssColor(r.backgroundColor);
  if (background) look.backgroundColor = background;
  const border = toCssColor(r.borderColor);
  if (border) {
    look.borderColor = border;
    look.borderStyle = pick(r.borderStyle, ["solid", "dashed", "dotted"] as const) ?? "solid";
    look.borderWidth = Math.round(Math.max(1, Math.min(3, pixels(r.borderWidth) ?? 1)));
  }
  const radius = pixels(r.borderRadius);
  if (radius !== undefined) look.borderRadius = Math.round(radius);
  const outline = toCssColor(r.outlineColor);
  if (outline) look.outlineColor = outline;
  const fontStyle = pick(r.fontStyle, ["italic", "normal"] as const);
  if (fontStyle) look.fontStyle = fontStyle;
  const fontWeight =
    r.fontWeight === "bold" || r.fontWeight === "700"
      ? "bold"
      : r.fontWeight === "normal"
        ? "normal"
        : undefined;
  if (fontWeight) look.fontWeight = fontWeight;
  const decoration = pick(r.textDecoration, [
    "underline",
    "line-through",
    "none",
    "underline dotted",
    "underline wavy",
  ] as const);
  if (decoration) look.textDecoration = decoration;
  const opacity = clamp(typeof r.opacity === "string" ? Number(r.opacity) : r.opacity, 0.1, 1);
  if (opacity !== undefined) look.opacity = opacity;
  return look;
}

function toAttachment(raw: unknown): DecorationAttachment | undefined {
  const r = record(raw);
  const contentText = cleanContent(r.contentText);
  if (!contentText) return undefined;
  const out: DecorationAttachment = { contentText };
  const color = toCssColor(r.color);
  if (color) out.color = color;
  const background = toCssColor(r.backgroundColor);
  if (background) out.backgroundColor = background;
  const fontStyle = pick(r.fontStyle, ["italic", "normal"] as const);
  if (fontStyle) out.fontStyle = fontStyle;
  if (r.fontWeight === "bold" || r.fontWeight === "normal") out.fontWeight = r.fontWeight;
  const margin =
    typeof r.margin === "string" && /^\s*[\d.]+\s*(em|ch)?\s*$/.test(r.margin)
      ? Number.parseFloat(r.margin)
      : clamp(r.margin, 0, 4);
  if (margin !== undefined && Number.isFinite(margin))
    out.marginEm = Math.min(4, Math.max(0, margin));
  return out;
}

const empty = (look: DecorationLook) => Object.keys(look).length === 0;

/** An extension's decoration type options, checked (throws when nothing would show). */
export function normalizeDecorationType(raw: unknown): DecorationTypeStyle {
  const r = record(raw);
  const out: DecorationTypeStyle = { look: toLook(r), isWholeLine: r.isWholeLine === true };
  const light = toLook(r.light);
  if (!empty(light)) out.light = light;
  const dark = toLook(r.dark);
  if (!empty(dark)) out.dark = dark;
  const before = toAttachment(r.before);
  if (before) out.before = before;
  const after = toAttachment(r.after);
  if (after) out.after = after;
  const ruler = toCssColor(r.overviewRulerColor);
  if (ruler)
    out.overviewRuler = {
      color: ruler,
      lane: pick(r.overviewRulerLane, ["left", "center", "right", "full"] as const) ?? "center",
    };
  const gutter = toCssColor(r.gutterColor);
  if (gutter) out.gutterColor = gutter;
  // One that shows nothing is allowed, as in VS Code (Jupyter makes some only to mark ranges).
  return out;
}

/** The CSS declarations of a look (values were checked by normalizeDecorationType). */
export function lookCss(look: DecorationLook): string {
  const parts: string[] = [];
  if (look.color) parts.push(`color: ${look.color}`);
  if (look.backgroundColor) parts.push(`background-color: ${look.backgroundColor}`);
  if (look.borderColor)
    parts.push(
      `border: ${look.borderWidth ?? 1}px ${look.borderStyle ?? "solid"} ${look.borderColor}`,
    );
  if (look.borderRadius !== undefined) parts.push(`border-radius: ${look.borderRadius}px`);
  if (look.outlineColor) parts.push(`outline: 1px solid ${look.outlineColor}`);
  if (look.fontStyle) parts.push(`font-style: ${look.fontStyle}`);
  if (look.fontWeight) parts.push(`font-weight: ${look.fontWeight}`);
  if (look.textDecoration) parts.push(`text-decoration: ${look.textDecoration}`);
  if (look.opacity !== undefined) parts.push(`opacity: ${look.opacity}`);
  return parts.join("; ");
}

/** The CSS of an attachment's text. */
export function attachmentCss(a: DecorationAttachment, side: "before" | "after"): string {
  return [
    lookCss({
      ...(a.color && { color: a.color }),
      ...(a.backgroundColor && { backgroundColor: a.backgroundColor }),
      ...(a.fontStyle && { fontStyle: a.fontStyle }),
      ...(a.fontWeight && { fontWeight: a.fontWeight }),
    }),
    `margin-${side === "before" ? "right" : "left"}: ${a.marginEm ?? 0.5}em`,
  ]
    .filter(Boolean)
    .join("; ");
}

/**
 * The stylesheet for one decoration type, class `cls`: the range, its light / dark variants
 * (under Monaco's theme classes), the before / after text and the gutter bar.
 */
export function decorationTypeCss(cls: string, style: DecorationTypeStyle): string {
  const rules: string[] = [];
  const add = (selector: string, css: string) => {
    if (css) rules.push(`${selector} { ${css}; }`);
  };
  add(`.${cls}`, lookCss(style.look));
  if (style.light)
    add(`.monaco-editor.vs .${cls}, .monaco-editor.hc-light .${cls}`, lookCss(style.light));
  if (style.dark)
    add(`.monaco-editor.vs-dark .${cls}, .monaco-editor.hc-black .${cls}`, lookCss(style.dark));
  if (style.before) add(`.${cls}-before`, attachmentCss(style.before, "before"));
  if (style.after) add(`.${cls}-after`, attachmentCss(style.after, "after"));
  if (style.gutterColor)
    add(`.${cls}-gutter`, `border-left: 3px solid ${style.gutterColor}; margin-left: 3px`);
  return rules.join("\n");
}

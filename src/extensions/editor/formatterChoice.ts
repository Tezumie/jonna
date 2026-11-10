// Which formatter formats a file when several can (VS Code's `editor.defaultFormatter` and its
// "multiple formatters" choice, formatActionsMultiple.ts): the configured one (an extension's id,
// per language too: `"[python]": { "editor.defaultFormatter": "ms-python.black-formatter" }`);
// else the only one; else the user is asked (a dialog when they asked to format, a notice on a
// save) and their pick is saved for the language. The IDE's own formatters count as owners too:
// its language servers (`builtin.language-servers`) and the editor's built-in TypeScript, JSON,
// CSS and HTML formatting (`builtin.editor`). DOM-free and unit-tested; the editor engine asks
// it from Monaco's formatter selector (monaco/formatterChoice.ts).

/** The owner id of the IDE's language servers' formatters. */
export const LANGUAGE_SERVERS_FORMATTER = "builtin.language-servers";
/** The owner id of the editor's built-in formatters (Monaco's TypeScript, JSON, CSS, HTML). */
export const EDITOR_FORMATTER = "builtin.editor";

export interface FormatterOption {
  /** Its owner's id (what editor.defaultFormatter names). */
  id: string;
  /** What the picker shows. */
  label: string;
}

/** The formatter to use (`index` into the list), or why the user must choose. */
export type FormatterAnalysis = { index: number } | { message: string };

/** Ids compared as VS Code's ExtensionIdentifier.equals: case doesn't matter. */
export function sameFormatterId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Formatters of one group never compete: an extension's, or the IDE's own ("builtin."). */
function ownerGroup(id: string): string {
  return id.toLowerCase().startsWith("builtin.") ? "builtin." : id.toLowerCase();
}

/** VS Code puts a language name with spaces in quotes. */
function quoted(name: string): string {
  return /\s/.test(name) ? `'${name}'` : name;
}

/**
 * VS Code's _analyzeFormatter. `installed(id)` is the display name of an enabled extension with
 * that id (the configured formatter exists but can't format this file), or undefined.
 */
export function analyzeFormatters(
  formatters: readonly FormatterOption[],
  configured: string | undefined,
  languageName: string,
  kind: "file" | "selection",
  installed: (id: string) => string | undefined = () => undefined,
): FormatterAnalysis {
  if (configured) {
    const index = formatters.findIndex((f) => sameFormatterId(f.id, configured));
    if (index >= 0) return { index };
    const name = installed(configured);
    if (name)
      return {
        message:
          kind === "file"
            ? `Extension '${name}' is configured as formatter but it cannot format '${languageName}'-files`
            : `Extension '${name}' is configured as formatter but it can only format '${languageName}'-files as a whole, not selections or parts of it.`,
      };
  } else if (new Set(formatters.map((f) => ownerGroup(f.id))).size === 1) {
    // One owner (VS Code: one formatter). The IDE's own (its language servers and the editor's
    // built-in formatting) count as one: they never made anyone choose before an extension came.
    return { index: 0 };
  }
  return {
    message: configured
      ? `Extension '${configured}' is configured as formatter but not available. Select a different default formatter to continue.`
      : `There are multiple formatters for ${quoted(languageName)} files. One of them should be configured as default formatter.`,
  };
}

/** The picker's question (VS Code's). */
export function pickFormatterPlaceholder(languageName: string): string {
  return `Select a default formatter for ${quoted(languageName)} files`;
}

/**
 * The owners of formatters as the picker lists them: one row per formatter (VS Code lists each
 * provider; two of one owner keep their own labels).
 */
export function formatterRows(
  formatters: readonly FormatterOption[],
): { id: string; label: string; description: string }[] {
  return formatters.map((f, i) => ({ id: String(i), label: f.label, description: f.id }));
}

/** The row of "Format document with…" that sets the default instead (VS Code's last row). */
export const CONFIGURE_FORMATTER_ROW = "configure";

/** "Format document with…"'s question (VS Code's showFormatterPick). */
export const FORMAT_WITH_PLACEHOLDER = "Select a formatter";

/**
 * "Format document with…" / "Format selection with…" rows (VS Code's showFormatterPick): each
 * formatter (its index as the id), the configured default marked "(default)" and active, then
 * "Configure default formatter…". `activeIndex` is the default's row (0 without one).
 */
export function formatWithRows(
  formatters: readonly FormatterOption[],
  configured: string | undefined,
): {
  rows: { id: string; label: string; description?: string; separator?: string }[];
  activeIndex: number;
} {
  let activeIndex = 0;
  const rows: { id: string; label: string; description?: string; separator?: string }[] =
    formatters.map((f, i) => {
      const isDefault = !!configured && sameFormatterId(f.id, configured);
      if (isDefault) activeIndex = i;
      return {
        id: String(i),
        label: f.label,
        description: isDefault ? `(default) ${f.id}` : f.id,
      };
    });
  rows.push({
    id: CONFIGURE_FORMATTER_ROW,
    label: "Configure default formatter…",
    ...(rows.length > 0 && { separator: "" }),
  });
  return { rows, activeIndex };
}

/**
 * The formatter named `id` (an owner id, case aside) among `formatters`: its index, or -1. An
 * agent's or extension's "format with" names the formatter instead of picking.
 */
export function formatterIndex(formatters: readonly FormatterOption[], id: string): number {
  return formatters.findIndex((f) => sameFormatterId(f.id, id));
}

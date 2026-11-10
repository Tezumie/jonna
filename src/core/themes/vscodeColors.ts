// A VS Code color theme's own workbench colors (its JSON's `colors`), for the editor and the
// terminal to use where the theme sets them (D361: the terminal's selection matches the editor's).
// DOM-free and tested.

/** A VS Code theme JSON's `colors` (valid hex values only). */
export function themeColors(json: unknown): Record<string, string> {
  const colors = (json as { colors?: unknown } | null)?.colors;
  if (!colors || typeof colors !== "object") return {};
  return Object.fromEntries(
    Object.entries(colors as Record<string, unknown>).filter(
      (e): e is [string, string] => typeof e[1] === "string" && /^#[0-9a-f]{3,8}$/i.test(e[1]),
    ),
  );
}

/**
 * The terminal's selection color in a theme, as VS Code picks it: `terminal.selectionBackground`,
 * else the editor's `editor.selectionBackground`; undefined when the theme sets neither.
 */
export function terminalSelection(json: unknown): string | undefined {
  const colors = themeColors(json);
  return colors["terminal.selectionBackground"] ?? colors["editor.selectionBackground"];
}

// `workbench.colorCustomizations` (VS Code's, and what Peacock writes) (D248): the user's (and the
// folder's) colors over the theme. Keys are our tokens ("--accent") or VS Code's color ids
// ("titleBar.activeBackground"): the title bar, activity bar and status bar get tokens of their
// own (color-customizations.css reads them, falling back to the shell's), and the ids a theme
// maps (importer.ts TOKEN_SOURCES) map the same way here. A `"[Theme name]": { … }` block applies
// only under that theme. DOM-free and unit-tested.

import { TOKEN_SOURCES } from "./importer";

/** VS Code ids for the window's bars → their own tokens (unset: the shell's colors). */
export const REGION_TOKENS: Record<string, string> = {
  "titleBar.activeBackground": "--bg-titlebar",
  "titleBar.activeForeground": "--fg-titlebar",
  "activityBar.background": "--bg-activitybar",
  "activityBar.foreground": "--fg-activitybar",
  "activityBar.inactiveForeground": "--fg-activitybar-inactive",
  "activityBarBadge.background": "--bg-activitybar-badge",
  "activityBarBadge.foreground": "--fg-activitybar-badge",
  "statusBar.background": "--bg-statusbar",
  "statusBar.foreground": "--fg-statusbar",
  "statusBarItem.hoverBackground": "--bg-statusbar-hover",
};

/** Ids a theme maps to the shell (`--bg-app`): here they're the bars', not every surface. */
const SHELL_IDS = new Set(["titleBar.activeBackground", "activityBar.background"]);

/** A hex color (VS Code's color settings are hex, with an optional alpha). */
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/** Our own token names, and a value that can't break out of the declaration. */
const TOKEN = /^--[a-z][a-z0-9-]*$/;
const SAFE_VALUE = /^[^;{}<>]{1,200}$/;

/**
 * Token values for `workbench.colorCustomizations` objects, later ones winning (user, then the
 * folder's). `themeName` selects "[Theme name]" blocks. Unknown ids and bad values are left out.
 */
export function mapColorCustomizations(
  layers: readonly unknown[],
  themeName = "",
): Record<string, string> {
  const merged: Record<string, string> = {};
  const take = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string") merged[key] = v;
    }
  };
  for (const layer of layers) {
    take(layer);
    // "[Dark+]": { … } and "[Dark+][Light+]" blocks for the theme in use (VS Code's).
    if (layer && typeof layer === "object" && !Array.isArray(layer))
      for (const [key, block] of Object.entries(layer as Record<string, unknown>)) {
        const names = [...key.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]?.trim().toLowerCase());
        if (names.length && names.includes(themeName.toLowerCase())) take(block);
      }
  }
  const tokens: Record<string, string> = {};
  // Theme ids first, then the bars' own, then our tokens: the more specific wins.
  for (const [token, ids] of Object.entries(TOKEN_SOURCES)) {
    const value = ids
      .filter((id) => !SHELL_IDS.has(id))
      .map((id) => merged[id])
      .find((v) => v !== undefined && HEX.test(v));
    if (value) tokens[token] = value;
  }
  for (const [id, token] of Object.entries(REGION_TOKENS)) {
    const value = merged[id];
    if (value !== undefined && HEX.test(value)) tokens[token] = value;
  }
  for (const [key, value] of Object.entries(merged))
    if (TOKEN.test(key) && SAFE_VALUE.test(value)) tokens[key] = value;
  return tokens;
}

// The main status bar's cursor item, worded like VS Code's.
import type { SelectionStatus } from "./engine";

/**
 * "Ln 3, Col 7", "Ln 3, Col 7 (12 selected)", "3 selections" or
 * "3 selections (40 characters selected)" for several cursors.
 */
export function selectionLabel(status: SelectionStatus): string {
  const { cursor, selections, characters } = status;
  if (selections > 1)
    return characters > 0
      ? `${selections} selections (${characters} characters selected)`
      : `${selections} selections`;
  const at = `Ln ${cursor.line}, Col ${cursor.column}`;
  return characters > 0 ? `${at} (${characters} selected)` : at;
}

// Document colors (textDocument/documentColor, colorPresentation): which languages a server's
// color provider is registered for, and its answers in the engine's terms. DOM-free; tested.
import type { Range, TextEdit } from "./types";

/**
 * Languages the editor's built-in services already find colors in (Monaco's CSS mode for css,
 * scss and less, its JSON mode for json and jsonc, both with `colors: true`): a server's colors
 * there would show every swatch twice.
 */
export const BUILTIN_COLOR_LANGUAGES: ReadonlySet<string> = new Set([
  "css",
  "scss",
  "less",
  "json",
  "jsonc",
]);

/** The languages of a server that get its color provider. */
export function colorProviderLanguages(languages: readonly string[]): string[] {
  return languages.filter((l) => !BUILTIN_COLOR_LANGUAGES.has(l));
}

/** LSP's Color: each channel 0–1 (the same as the engine's). */
export interface Color {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

export interface ColorInformation {
  range: Range;
  color: Color;
}

export interface ColorPresentation {
  label: string;
  textEdit?: TextEdit;
  additionalTextEdits?: TextEdit[];
}

const clamp = (n: unknown): number =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;

/** The server's colors, with anything malformed left out and channels kept in 0–1. */
export function validColors(answer: unknown): ColorInformation[] {
  if (!Array.isArray(answer)) return [];
  const out: ColorInformation[] = [];
  for (const entry of answer as unknown[]) {
    const c = entry as Partial<ColorInformation> | null;
    if (!c?.range?.start || !c.range.end || !c.color) continue;
    out.push({
      range: c.range,
      color: {
        red: clamp(c.color.red),
        green: clamp(c.color.green),
        blue: clamp(c.color.blue),
        alpha: c.color.alpha === undefined ? 1 : clamp(c.color.alpha),
      },
    });
  }
  return out;
}

/** The server's presentations (the picker's header cycles through them); unlabeled ones dropped. */
export function validPresentations(answer: unknown): ColorPresentation[] {
  if (!Array.isArray(answer)) return [];
  return (answer as unknown[]).filter(
    (p): p is ColorPresentation =>
      !!p && typeof (p as Partial<ColorPresentation>).label === "string",
  );
}

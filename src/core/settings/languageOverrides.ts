// Language-specific settings (VS Code's `"[python]": { "editor.tabSize": 4 }`, also several
// languages in one key, `"[javascript][typescript]"`): the block keys, the languages they name, and
// the values a layer gives one language. A block's value wins over the same key outside blocks in
// every layer (VS Code: language-specific user settings beat plain workspace ones). DOM-free, tested.

/** VS Code language ids that are named differently here (the editor's ids). */
const LANGUAGE_ALIASES: Record<string, string> = {
  typescriptreact: "tsx",
  javascriptreact: "jsx",
  makefile: "make",
};

/** The IDE's id for a language id written in settings (VS Code's names accepted). */
export function normalizeLanguageId(id: string): string {
  const trimmed = id.trim();
  return LANGUAGE_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

const OVERRIDE_KEY = /^\s*(\[[^[\]]+\]\s*)+$/;

/** True for a language block's key: `[python]`, `[javascript][typescript]`. */
export function isLanguageOverrideKey(key: string): boolean {
  return OVERRIDE_KEY.test(key);
}

/** The languages a block's key names (normalized; empty for other keys). */
export function overrideLanguages(key: string): string[] {
  if (!isLanguageOverrideKey(key)) return [];
  return [...key.matchAll(/\[([^[\]]+)\]/g)].map((m) => normalizeLanguageId(m[1] ?? ""));
}

/** The key of one language's own block. */
export function languageOverrideKey(language: string): string {
  return `[${language.trim()}]`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The values a layer sets for `language`: every block that names it, in the file's order (a later
 * block wins, as in VS Code).
 */
export function languageValues(
  layer: Readonly<Record<string, unknown>>,
  language: string,
): Record<string, unknown> {
  const id = normalizeLanguageId(language);
  const out: Record<string, unknown> = {};
  for (const [key, block] of Object.entries(layer)) {
    if (!isObject(block) || !overrideLanguages(key).includes(id)) continue;
    Object.assign(out, block);
  }
  return out;
}

/** Every language a layer has a block for. */
export function overriddenLanguages(layer: Readonly<Record<string, unknown>>): string[] {
  const out = new Set<string>();
  for (const [key, block] of Object.entries(layer))
    if (isObject(block)) for (const id of overrideLanguages(key)) out.add(id);
  return [...out];
}

/**
 * Keys inside language blocks whose values differ between two versions of a layer (so a change
 * to `[python].editor.tabSize` is reported as a change to `editor.tabSize`).
 */
export function changedOverrideKeys(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): string[] {
  const out = new Set<string>();
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!isLanguageOverrideKey(key)) continue;
    const a = isObject(before[key]) ? (before[key] as Record<string, unknown>) : {};
    const b = isObject(after[key]) ? (after[key] as Record<string, unknown>) : {};
    for (const inner of new Set([...Object.keys(a), ...Object.keys(b)]))
      if (JSON.stringify(a[inner]) !== JSON.stringify(b[inner])) out.add(inner);
  }
  return [...out];
}

/** A layer's one-language block (`[language]` exactly) with `key` set, or removed (undefined). */
export function withLanguageValue(
  layer: Readonly<Record<string, unknown>>,
  language: string,
  key: string,
  value: unknown,
): Record<string, unknown> | undefined {
  const current = layer[languageOverrideKey(language)];
  const block: Record<string, unknown> = isObject(current) ? { ...current } : {};
  if (value === undefined) delete block[key];
  else block[key] = value;
  return Object.keys(block).length ? block : undefined;
}

/**
 * A block with only the settings `valid` accepts (an import keeps what applies here); undefined
 * when nothing is left or it isn't an object.
 */
export function validBlock(
  block: unknown,
  valid: (key: string, value: unknown) => boolean,
): Record<string, unknown> | undefined {
  if (!isObject(block)) return undefined;
  const out = Object.fromEntries(Object.entries(block).filter(([k, v]) => valid(k, v)));
  return Object.keys(out).length ? out : undefined;
}

// Merging a lower workspace folder (.vscode, the legacy folder name) into the IDE's own (D189): how a
// file both folders have is combined. The IDE's own always wins; what only the lower one has is
// added. DOM-free and unit-tested.
import { parseJsonc } from "../core/settings/jsonc";
import { setJsoncProperty } from "../core/settings/jsoncEdit";

const objectOf = (text: string): Record<string, unknown> | null => {
  const parsed = parseJsonc(text);
  return parsed.ok &&
    parsed.value &&
    typeof parsed.value === "object" &&
    !Array.isArray(parsed.value)
    ? (parsed.value as Record<string, unknown>)
    : null;
};

/**
 * settings.json: the lower folder's keys the IDE's own doesn't set are added (comments kept).
 * Null when the IDE's own file can't be read as JSON (it's left alone rather than rewritten).
 */
export function mergeSettingsText(
  own: string,
  lower: Record<string, unknown>,
): { text: string; added: string[] } | null {
  const ownValues = objectOf(own.trim() ? own : "{}");
  if (!ownValues) return null;
  let text = own.trim() ? own : "{}\n";
  const added: string[] = [];
  for (const [key, value] of Object.entries(lower)) {
    if (key in ownValues) continue;
    text = setJsoncProperty(text, key, value);
    added.push(key);
  }
  return { text, added };
}

/**
 * tasks.json (`tasks` by `label`), launch.json (`configurations` by `name`): entries only the
 * lower file has are appended. Null when either file can't be read as JSON.
 */
export function mergeNamedListText(
  own: string,
  lower: string,
  listKey: string,
  nameKey: string,
): { text: string; added: string[] } | null {
  const a = objectOf(own);
  const b = objectOf(lower);
  if (!a || !b) return null;
  const mine = Array.isArray(a[listKey]) ? (a[listKey] as unknown[]) : [];
  const theirs = Array.isArray(b[listKey]) ? (b[listKey] as unknown[]) : [];
  const nameOf = (x: unknown) =>
    x && typeof x === "object" ? (x as Record<string, unknown>)[nameKey] : undefined;
  const names = new Set(mine.map(nameOf).filter((n) => n !== undefined));
  const json = new Set(mine.map((x) => JSON.stringify(x)));
  // Named entries the IDE's own lacks by name; unnamed ones it lacks as written.
  const extra = theirs.filter((x) => {
    const n = nameOf(x);
    return n !== undefined ? !names.has(n) : !json.has(JSON.stringify(x));
  });
  if (!extra.length) return { text: own, added: [] };
  return {
    text: setJsoncProperty(own, listKey, [...mine, ...extra]),
    added: extra.map((x) => String(nameOf(x) ?? "(unnamed)")),
  };
}

/** A memory topic or other notes file: the lower file's lines the IDE's own lacks are appended. */
export function mergeLinesText(own: string, lower: string): { text: string; added: number } {
  const have = new Set(own.split(/\r?\n/).map((l) => l.trim()));
  const extra = lower
    .split(/\r?\n/)
    .filter((l) => l.trim() && !have.has(l.trim()))
    // A topic file's own heading isn't a note.
    .filter((l) => !/^#\s/.test(l));
  if (!extra.length) return { text: own, added: 0 };
  const base = own.endsWith("\n") || !own ? own : `${own}\n`;
  return { text: `${base}${extra.join("\n")}\n`, added: extra.length };
}

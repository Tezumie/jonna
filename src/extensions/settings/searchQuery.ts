// The settings search's filters, VS Code's: `@modified` (changed in this scope), `@id:a,b` (those
// keys), `@ext:<extension id>` (what an extension contributes), `@tag:<tag>` (declared `tags`, and
// "ai" for the agent's and AI features' settings), `@lang:<language>` (the settings a language can
// set for itself, VS Code's language-overridable ones: the editor's and the save-time files.* ones;
// the settings editor then shows and edits the `"[language]": {…}` block, D201). Filters combine
// (all must hold) and the rest of the text is searched as before. DOM-free and tested.
import type { SettingInfo } from "../../core/settings/schema";

export interface SettingsQuery {
  /** The words searched in titles, keys and descriptions (lowercase, filters removed). */
  text: string;
  modified: boolean;
  ids: string[];
  extensions: string[];
  tags: string[];
  languages: string[];
}

export function parseSettingsQuery(query: string): SettingsQuery {
  const out: SettingsQuery = {
    text: "",
    modified: false,
    ids: [],
    extensions: [],
    tags: [],
    languages: [],
  };
  const words: string[] = [];
  for (const word of query.trim().toLowerCase().split(/\s+/)) {
    const m = /^@(id|ext|tag|lang):(.*)$/.exec(word);
    if (word === "@modified") out.modified = true;
    else if (m) {
      const values = (m[2] ?? "").split(",").filter(Boolean);
      if (m[1] === "id") out.ids.push(...values);
      else if (m[1] === "ext") out.extensions.push(...values);
      else if (m[1] === "tag") out.tags.push(...values);
      else out.languages.push(...values);
    } else if (word) words.push(word);
  }
  out.text = words.join(" ");
  return out;
}

/** Whether the query has a filter (not only words). */
export function hasFilter(q: SettingsQuery): boolean {
  return (
    q.modified ||
    q.ids.length > 0 ||
    q.extensions.length > 0 ||
    q.tags.length > 0 ||
    q.languages.length > 0
  );
}

/** A setting's tags: the declared ones, plus "ai" for the agent's and AI features' settings. */
export function settingTags(s: SettingInfo): string[] {
  const tags = (s.tags ?? []).map((t) => t.toLowerCase());
  if (/^(agent|ai features)$/i.test(s.category) || /^(agent|ai|inlineEdit)\./.test(s.key))
    tags.push("ai");
  return [...new Set(tags)];
}

/** files.* settings read per document (at open and save). */
const LANGUAGE_FILE_SETTINGS = new Set([
  "files.eol",
  "files.trimTrailingWhitespace",
  "files.insertFinalNewline",
  "files.encoding",
  "files.autoGuessEncoding",
]);

/** editor.* settings that are the IDE's, not a document's: they don't vary by language. */
const NOT_PER_LANGUAGE =
  /^editor\.(fileStatusBar|inlineCompletions|inlineDiagnostics|inlineEdit|nextEdit|projectFormatters|vimMode|updateImportsOnFileMove)\b/;

/**
 * Whether a language can set `s` for itself (`"[python]": { … }`, D201): VS Code's
 * language-overridable settings, the ones read per document.
 */
export function isLanguageSetting(s: SettingInfo): boolean {
  if (s.scope === "user" || /^ai features$/i.test(s.category)) return false;
  if (LANGUAGE_FILE_SETTINGS.has(s.key)) return true;
  return s.key.startsWith("editor.") && !NOT_PER_LANGUAGE.test(s.key);
}

export function matchesSetting(
  s: SettingInfo,
  q: SettingsQuery,
  isModified: (key: string) => boolean,
): boolean {
  if (q.modified && !isModified(s.key)) return false;
  if (q.ids.length && !q.ids.includes(s.key.toLowerCase())) return false;
  if (q.extensions.length) {
    const ext = (s.extension ?? "").toLowerCase();
    // The full id, or its last part ("terminal" for builtin.terminal).
    if (!ext || !q.extensions.some((e) => e === ext || ext.endsWith(`.${e}`))) return false;
  }
  if (q.tags.length) {
    const tags = settingTags(s);
    if (!q.tags.every((t) => tags.includes(t))) return false;
  }
  if (q.languages.length && !isLanguageSetting(s)) return false;
  if (!q.text) return true;
  return `${s.category} ${s.section ?? ""} ${s.title} ${s.key} ${s.description}`
    .toLowerCase()
    .includes(q.text);
}

/** The page title for a filtered search. */
export function filterTitle(q: SettingsQuery, count: number): string {
  if (
    q.modified &&
    !q.text &&
    !q.ids.length &&
    !q.extensions.length &&
    !q.tags.length &&
    !q.languages.length
  )
    return "Changed settings";
  const found = `${count} setting${count === 1 ? "" : "s"} found`;
  // The first language's block is what the editor shows and changes.
  return q.languages.length ? `${found} for ${q.languages[0]} files` : found;
}

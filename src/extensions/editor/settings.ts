// editor.* and files.* settings (contributed in extension.json) → the engine's options and the
// save-time fixes (files.trimTrailingWhitespace, files.insertFinalNewline: pure, applied as one
// undoable edit before writing, keeping the file's line endings). Missing or unregistered values fall
// back to the schema defaults.
import type { SettingsService } from "../../workbench/settings";
import { advancedEngineOptions } from "./advancedSettings";
import type { EditorOptions, LineEnding } from "./engine";

// Save-time text fixes from settings (files.trimTrailingWhitespace, files.insertFinalNewline).
// Pure; applied to the document as one undoable edit before writing. Keeps the file's line endings.
export interface SaveOptions {
  trimTrailingWhitespace: boolean;
  insertFinalNewline: boolean;
}

/**
 * `keepLines` (1-based): lines a cursor is on, left alone by an auto save (VS Code does the same):
 * an afterDelay save mid-typing mustn't eat the space just typed, or add a newline under the cursor.
 */
export function applySaveTransforms(
  text: string,
  eol: LineEnding,
  options: SaveOptions,
  keepLines?: ReadonlySet<number>,
): string {
  let out = text;
  if (options.trimTrailingWhitespace) {
    if (!keepLines?.size) out = out.replace(/[ \t]+(?=\r?\n|$)/g, "");
    else
      out = out
        .split("\n")
        .map((line, i) => (keepLines.has(i + 1) ? line : line.replace(/[ \t]+(?=\r?$)/, "")))
        .join("\n");
  }
  const lastLine = out.split("\n").length;
  if (
    options.insertFinalNewline &&
    out.length > 0 &&
    !out.endsWith("\n") &&
    !keepLines?.has(lastLine)
  )
    out += eol;
  return out;
}

// editor.* and files.* settings (contributed in extension.json) → the engine's options and the
// save-time fixes. Missing or unregistered values fall back to the schema defaults.
export interface EditorSettings {
  editor: EditorOptions;
  files: SaveOptions & {
    eol: "auto" | LineEnding;
    /** files.encoding: for files that aren't valid UTF-8 (D200). */
    encoding: string;
    autoGuessEncoding: boolean;
  };
  formatOnSave: boolean;
  autoSave: { mode: "off" | "afterDelay" | "onFocusChange" | "onWindowChange"; delay: number };
}

export const DEFAULT_SETTINGS: EditorSettings = {
  editor: {
    fontSize: 14,
    tabSize: 4,
    wordWrap: "on",
    stickyScroll: true,
    minimap: true,
    renderWhitespace: "selection",
    insertSpaces: true,
    fontFamily: "",
    lineNumbers: "on",
    rulers: [],
    bracketPairColorization: true,
  },
  files: {
    eol: "auto",
    trimTrailingWhitespace: false,
    insertFinalNewline: false,
    encoding: "utf8",
    autoGuessEncoding: false,
  },
  formatOnSave: false,
  autoSave: { mode: "off", delay: 1000 },
};

/** files.eol applies to files without a line ending yet; "auto" means LF. */
export function newFileEol(settings: EditorSettings): LineEnding {
  return settings.files.eol === "\r\n" ? "\r\n" : "\n";
}

/**
 * The settings for documents of `language` (its `"[language]": {…}` blocks win, D201); without
 * one, the plain values. With `path`, for that file: its folder's own settings first in a
 * multi-root workspace (D251; the same as without it for one folder).
 */
export function editorSettings(
  settings: Pick<SettingsService, "peekForLanguageAt">,
  language?: string | null,
  path?: string | null,
): EditorSettings {
  const get = <T>(key: string, fallback: T): T =>
    settings.peekForLanguageAt<T>(key, language, path) ?? fallback;
  return {
    editor: {
      fontSize: get("editor.fontSize", 14),
      tabSize: get("editor.tabSize", 4),
      wordWrap: get("editor.wordWrap", "off"),
      stickyScroll: get("editor.stickyScroll.enabled", true),
      minimap: get("editor.minimap.enabled", true),
      renderWhitespace: get("editor.renderWhitespace", "selection"),
      insertSpaces: get("editor.insertSpaces", true),
      fontFamily: get("editor.fontFamily", ""),
      lineNumbers: get("editor.lineNumbers", "on"),
      rulers: get<unknown[]>("editor.rulers", []).filter((n): n is number => typeof n === "number"),
      bracketPairColorization: get("editor.bracketPairColorization.enabled", true),
      autoClosingTags: get("editor.autoClosingTags", true),
      vimMode: get("editor.vimMode", false),
      advanced: advancedEngineOptions((key) => settings.peekForLanguageAt(key, language, path)),
      diff: {
        sideBySide: get("diffEditor.renderSideBySide", true),
        ignoreTrimWhitespace: get("diffEditor.ignoreTrimWhitespace", true),
        hideUnchangedRegions: get("diffEditor.hideUnchangedRegions.enabled", false),
      },
    },
    files: {
      eol: get("files.eol", "auto"),
      trimTrailingWhitespace: get("files.trimTrailingWhitespace", false),
      insertFinalNewline: get("files.insertFinalNewline", false),
      encoding: get("files.encoding", "utf8"),
      autoGuessEncoding: get("files.autoGuessEncoding", false),
    },
    formatOnSave: get("editor.formatOnSave", false),
    autoSave: { mode: get("files.autoSave", "off"), delay: get("files.autoSaveDelay", 1000) },
  };
}

/**
 * The code action kinds to run before a save (VS Code's `editor.codeActionsOnSave`): an object of
 * kind → "explicit" (Ctrl+S only) / "always" (auto-save too) / "never" (or true / false, the
 * older form), or a list of kinds (explicit). Any "source.*" kind a language server offers.
 */
export function codeActionsOnSave(value: unknown, explicit: boolean): string[] {
  const out: string[] = [];
  const want = (kind: string, mode: unknown) => {
    const on =
      mode === "always" ||
      mode === true ||
      (explicit && (mode === "explicit" || mode === undefined));
    if (on && kind.startsWith("source.") && !out.includes(kind)) out.push(kind);
  };
  if (Array.isArray(value)) {
    for (const k of value) if (typeof k === "string") want(k, undefined);
  } else if (value && typeof value === "object") {
    for (const [k, mode] of Object.entries(value)) want(k, mode);
  }
  return out;
}

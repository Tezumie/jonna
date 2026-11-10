// The settings editor's "Folder" scope (D251): in a multi-root workspace each folder has its own
// settings (`<folder>/<IDE folder>/settings.json`, and its `.vscode/settings.json`, read as one
// folder layer: SettingsService's `getAt`). The editor shows that layer and writes the IDE's own
// file of the folder (`SettingsService.updateAt`), as the workspace scope did with one folder.
// The "Workspace" scope is then the workspace file's `settings`.
import { languageOverrideKey } from "../../core/settings/languageOverrides";
import type { SettingsScope } from "../../core/settings/model";
import type { SettingsService } from "../../workbench/settings";

/** A scope of the settings editor: "folder" is one folder of a multi-root workspace. */
export type EditScope = SettingsScope | "folder";

/** What a folder layer sets for `key` (in its `[language]` block with a language). */
export function folderLayerValue(
  layer: Readonly<Record<string, unknown>>,
  key: string,
  language?: string,
): unknown {
  if (!language) return layer[key];
  const block = layer[languageOverrideKey(language)];
  return block && typeof block === "object" && !Array.isArray(block)
    ? (block as Record<string, unknown>)[key]
    : undefined;
}

/** The folder's own value for `key` (undefined: it doesn't set it). */
export function inspectFolder(
  settings: Pick<SettingsService, "folderValues">,
  folder: string,
  key: string,
  language?: string,
): unknown {
  return folderLayerValue(settings.folderValues(folder), key, language);
}

/** What the folder's files get for `key` without the folder's own value (what it inherits). */
export function folderInherited(
  settings: Pick<SettingsService, "model" | "peekAt">,
  folder: string,
  key: string,
  language?: string,
): unknown {
  const { model } = settings;
  if (language) {
    // The folder's language block is what's edited: below it, another layer's block, then the
    // folder's (or the window's) plain value.
    const other = model.resolveForLanguage(key, language);
    if (other.language) return other.value;
    return settings.peekAt(key, folder);
  }
  return model.resolve(key).value;
}

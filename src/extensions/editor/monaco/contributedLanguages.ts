// Extensions' languages in Monaco (D102, D200): each registered once (its extensions, names,
// patterns and first line join the language's, also for a language the editor knows), and its
// language-configuration.json read when a file of the language first opens (or now, when one is
// open) and merged over the editor's own configuration field by field, as VS Code merges them.
// An extension that goes takes its configuration with it.
import type { ContributedLanguage } from "../engine";
import { toLanguageConfiguration } from "../languageConfiguration";
import * as monaco from "./core";
import { builtinConfigurationSet } from "./languageConfig";

export class ContributedLanguages {
  private readonly registered = new WeakSet<ContributedLanguage>();
  private readonly configurations = new Map<ContributedLanguage, { dispose(): void }>();

  set(languages: readonly ContributedLanguage[]): void {
    for (const lang of languages) {
      if (this.registered.has(lang)) continue;
      this.registered.add(lang);
      monaco.languages.register({
        id: lang.id,
        extensions: [...lang.extensions],
        filenames: [...lang.filenames],
        aliases: [...lang.aliases],
        ...(lang.filenamePatterns?.length && { filenamePatterns: [...lang.filenamePatterns] }),
        ...(lang.firstLine && { firstLine: lang.firstLine }),
      });
    }
    for (const [lang, applied] of [...this.configurations])
      if (!languages.includes(lang)) {
        applied.dispose();
        this.configurations.delete(lang);
      }
    for (const lang of languages) {
      const read = lang.configuration;
      if (read && !this.configurations.has(lang))
        this.configurations.set(lang, applyConfiguration(lang.id, read));
    }
  }
}

/** Reads and sets `languageId`'s configuration when the language is first used (or now). */
function applyConfiguration(languageId: string, read: () => Promise<unknown>): { dispose(): void } {
  let disposed = false;
  let registration: { dispose(): void } | undefined;
  const apply = () => {
    // After the editor's own (set once its module loads), so this one wins where both say.
    void builtinConfigurationSet(languageId)
      .then(read)
      .then((raw) => {
        if (disposed) return;
        registration = monaco.languages.setLanguageConfiguration(
          languageId,
          toLanguageConfiguration(raw) as monaco.languages.LanguageConfiguration,
        );
      })
      .catch(() => {});
  };
  let subscription: { dispose(): void } | undefined;
  // onLanguage fires once per language: one already in use is configured now.
  if (monaco.editor.getModels().some((m) => m.getLanguageId() === languageId)) apply();
  else
    subscription = monaco.languages.onLanguage(languageId, () => {
      subscription?.dispose();
      apply();
    });
  return {
    dispose: () => {
      disposed = true;
      subscription?.dispose();
      registration?.dispose();
    },
  };
}

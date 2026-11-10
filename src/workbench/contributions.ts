// Declarative contributions from installed extensions (D102), shared between the extensions host
// (which adds them) and the parts that use them: languages and grammars and snippets (editor),
// color themes (appearance), problem matchers (tasks). Plain signals of entries; each add returns
// a Disposable.
import type { IconThemeDocument } from "../core/iconTheme/index";
import { type Disposable, toDisposable } from "../core/lifecycle/index";
import { type Signal, signal } from "../core/reactive/index";
import type { ProductIconThemeEntry } from "./productIcons";

export interface LanguageEntry {
  id: string;
  extensions: readonly string[];
  filenames: readonly string[];
  aliases: readonly string[];
  /** Globs on the name (or the path, with a `/`): VS Code's `filenamePatterns`. */
  filenamePatterns?: readonly string[];
  /** A RegExp source tried on a file's first line: VS Code's `firstLine`. */
  firstLine?: string;
  /**
   * language-configuration.json, read when a file of the language first opens (D200); merged
   * over the editor's own configuration of a language it knows, as VS Code merges them.
   */
  configuration?: () => Promise<unknown>;
  /** Extension id. */
  source: string;
}

/**
 * A TextMate grammar an extension contributes (VS Code's `contributes.grammars`): a language's
 * (replacing the editor's own for it, the last one registered winning, as in VS Code) or an
 * injection into other grammars' scopes (`injectTo`).
 */
export interface GrammarEntry {
  scopeName: string;
  /** The editor's language id it tokenizes (none for an injection or a grammar others include). */
  language?: string;
  injectTo?: readonly string[];
  embeddedLanguages?: Readonly<Record<string, string>>;
  tokenTypes?: Readonly<Record<string, string>>;
  /** The grammar's JSON, read when it's first needed. */
  load(): Promise<unknown>;
  /** Extension id. */
  source: string;
}

/** Semantic token selectors ("type.modifier", "*.declaration") → TextMate scopes (VS Code's). */
export interface SemanticTokenScopesEntry {
  /** The editor's language id it applies to (none: every language). */
  language?: string;
  scopes: Readonly<Record<string, readonly string[]>>;
  /** Custom token types → the type each falls back to (`semanticTokenTypes`' superType). */
  superTypes?: Readonly<Record<string, string>>;
  source: string;
}

export interface SnippetEntry {
  language: string;
  name: string;
  prefix: string;
  body: string;
  description: string;
  source: string;
}

export interface ColorThemeEntry {
  /** What the theme picker shows and `workbench.colorTheme` stores. */
  label: string;
  kind: "dark" | "light";
  /** The VS Code theme JSON (colors + tokenColors), includes resolved. */
  load(): Promise<unknown>;
  source: string;
}

/** A file icon theme (D132): VS Code's JSON, and how to get a URL for one of its files. */
export interface LoadedIconTheme {
  doc: IconThemeDocument;
  /** A URL for `path` (relative to the theme's JSON file): an image or a font. */
  url(path: string): Promise<string>;
}

export interface IconThemeEntry {
  /** What `workbench.iconTheme` stores (VS Code's ids). */
  id: string;
  label: string;
  source: string;
  /** null: the IDE's own minimal icons. */
  load(): Promise<LoadedIconTheme | null>;
}

/** A named problem matcher or pattern from an extension (tasks name it "$name"). */
export interface ProblemMatcherEntry {
  name: string;
  /** The matcher's definition (problemMatchers) or the pattern (problemPatterns). */
  definition: unknown;
  source: string;
}

export class Contributions {
  readonly problemMatchers: Signal<readonly ProblemMatcherEntry[]> = signal([]);
  readonly problemPatterns: Signal<readonly ProblemMatcherEntry[]> = signal([]);
  readonly languages: Signal<readonly LanguageEntry[]> = signal([]);
  readonly grammars: Signal<readonly GrammarEntry[]> = signal([]);
  readonly semanticTokenScopes: Signal<readonly SemanticTokenScopesEntry[]> = signal([]);
  readonly snippets: Signal<readonly SnippetEntry[]> = signal([]);
  readonly themes: Signal<readonly ColorThemeEntry[]> = signal([]);
  readonly iconThemes: Signal<readonly IconThemeEntry[]> = signal([]);
  /** Product icon themes (D267). */
  readonly productIconThemes: Signal<readonly ProductIconThemeEntry[]> = signal([]);

  private add<T>(target: Signal<readonly T[]>, entries: readonly T[]): Disposable {
    if (!entries.length) return toDisposable(() => {});
    target.value = [...target.peek(), ...entries];
    return toDisposable(() => {
      target.value = target.peek().filter((e) => !entries.includes(e));
    });
  }

  addLanguages(entries: readonly LanguageEntry[]): Disposable {
    return this.add(this.languages, entries);
  }

  addGrammars(entries: readonly GrammarEntry[]): Disposable {
    return this.add(this.grammars, entries);
  }

  addSemanticTokenScopes(entries: readonly SemanticTokenScopesEntry[]): Disposable {
    return this.add(this.semanticTokenScopes, entries);
  }

  addSnippets(entries: readonly SnippetEntry[]): Disposable {
    return this.add(this.snippets, entries);
  }

  addThemes(entries: readonly ColorThemeEntry[]): Disposable {
    return this.add(this.themes, entries);
  }

  addIconThemes(entries: readonly IconThemeEntry[]): Disposable {
    return this.add(this.iconThemes, entries);
  }

  addProductIconThemes(entries: readonly ProductIconThemeEntry[]): Disposable {
    return this.add(this.productIconThemes, entries);
  }

  addProblemMatchers(
    matchers: readonly ProblemMatcherEntry[],
    patterns: readonly ProblemMatcherEntry[],
  ): Disposable {
    const a = this.add(this.problemMatchers, matchers);
    const b = this.add(this.problemPatterns, patterns);
    return toDisposable(() => {
      a.dispose();
      b.dispose();
    });
  }
}

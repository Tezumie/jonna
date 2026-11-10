// TextMate tokenization for Monaco the way VS Code does it (D132): Shiki's grammars produce
// encoded tokens (the same 32-bit layout as Monaco's: language, standard token type, bracket bit,
// font style, foreground), which go to Monaco unchanged through `tokenizeEncoded`, and Monaco's
// color map is set to the TextMate theme's. No per-token scope lookups or allocations, comments
// and strings are known as such (brackets inside them aren't paired), and each language is
// registered once when its grammar loads — nothing else is re-tokenized. Any Shiki / VS Code
// theme works: its color map is the theme's own.
import { Color } from "monaco-editor/base/common/color.js";
import { ILanguageService } from "monaco-editor/editor/common/languages/language.js";
import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import { IStandaloneThemeService } from "monaco-editor/editor/standalone/common/standaloneTheme.js";
import type { HighlighterCore } from "shiki/core";
import { INITIAL, type StateStack } from "shiki/textmate";
import { type GrammarScopeRules, grammarConfiguration } from "../grammarRules";
import * as monaco from "./core";
import {
  configureGrammar,
  dropInjections,
  type Grammar,
  setGrammarInjection,
} from "./grammarInternals";

const LANGUAGE_MASK = 0xff;
const TOKEN_TYPE_MASK = 0x300;
const BALANCED_BRACKETS = 0x400;
const FOREGROUND_OFFSET = 15;
const FOREGROUND_MASK = 0xff8000;
/** Longer lines aren't tokenized (one default token), as in VS Code. */
const MAX_LINE = 20_000;
/** Per line; a grammar that takes longer stops there for this line. */
const TIME_LIMIT_MS = 500;

class TokenState implements monaco.languages.IState {
  constructor(readonly stack: StateStack) {}
  clone(): TokenState {
    return this;
  }
  equals(other: monaco.languages.IState): boolean {
    return (
      other instanceof TokenState && (other.stack === this.stack || other.stack.equals(this.stack))
    );
  }
}

const INITIAL_STATE = new TokenState(INITIAL);

export class TextMateTokens {
  /** Each tokenized language's provider and the grammar it uses (Shiki's name for it). */
  private readonly registered = new Map<
    string,
    { dispose(): void; grammar: string; rules?: GrammarScopeRules }
  >();

  constructor(private readonly highlighter: HighlighterCore) {}

  /**
   * Makes `theme` (a loaded Shiki theme) the tokenization theme and Monaco's color map its color
   * map. Call after Monaco's own theme was set (that resets the map). Re-tokenizes open models
   * when the map changed (token colors are indices into it).
   */
  applyTheme(theme: string): void {
    this.theme = theme;
    const changed = this.pushColorMap();
    if (changed)
      for (const [lang, { grammar, rules }] of [...this.registered])
        this.register(lang, grammar, rules);
  }
  private theme = "";
  private mapKey = "";
  private known = 0;
  private refresh = 0;

  /**
   * Gives Monaco the TextMate registry's color map. TextMate adds a theme's colors to its map as
   * tokens first use them, so the map grows: tokens report ids past the known end, and the map
   * is pushed again (one frame later, once per batch). True when it changed.
   */
  private pushColorMap(): boolean {
    const { colorMap } = this.highlighter.setTheme(this.theme);
    this.known = colorMap.length;
    const key = colorMap.join(",");
    if (key === this.mapKey) return false;
    const grew = this.mapKey !== "" && key.startsWith(this.mapKey);
    this.mapKey = key;
    const colors: unknown[] = colorMap.map((c, i) =>
      i === 0 || !c ? null : Color.Format.CSS.parseHex(c.startsWith("#") ? c : `#${c}`),
    );
    StandaloneServices.get(IStandaloneThemeService).setColorMapOverride(colors);
    // Only new colors: existing tokens keep their ids (no re-tokenizing).
    return !grew;
  }

  private colorSeen(id: number): void {
    if (id < this.known || this.refresh) return;
    this.refresh = requestAnimationFrame(() => {
      this.refresh = 0;
      this.pushColorMap();
    });
  }

  /**
   * Tokenizes `languageId` with a loaded Shiki grammar (again, if it was already): its own, or
   * `grammarName` (an extension's grammar for the language, VS Code's way). `rules`: its
   * embedded languages and token types (VS Code's grammar contribution fields).
   */
  register(languageId: string, grammarName = languageId, rules?: GrammarScopeRules): void {
    this.registered.get(languageId)?.dispose();
    const languages = StandaloneServices.get(ILanguageService) as {
      languageIdCodec: {
        encodeLanguageId(id: string): number;
        decodeLanguageId(id: number): string;
      };
      requestRichLanguageFeatures(id: string): void;
    };
    const codec = languages.languageIdCodec;
    const encodedId = codec.encodeLanguageId(languageId);
    const shared = this.highlighter.getLanguage(grammarName);
    this.dropRemovedInjections(shared);
    const config = rules && grammarConfiguration(rules, (id) => codec.encodeLanguageId(id));
    const configured = config
      ? this.configuredGrammar(grammarName, shared, encodedId, config)
      : null;
    const grammar = configured ?? shared;
    if (configured) this.dropRemovedInjections(configured);
    if (config && configured)
      // The embedded languages' comments, brackets and pairs are their configurations: loaded
      // when a language is first used (VS Code requests them for embedded languages too).
      for (const id of new Set(Object.values(config.embeddedLanguages)))
        if (id !== encodedId) languages.requestRichLanguageFeatures(codec.decodeLanguageId(id));
    const plain = new Uint32Array([0, (1 << FOREGROUND_OFFSET) | encodedId | BALANCED_BRACKETS]);
    const provider: monaco.languages.EncodedTokensProvider = {
      getInitialState: () => INITIAL_STATE,
      tokenizeEncoded: (line, state) => {
        const prev = state as TokenState;
        if (line.length >= MAX_LINE) return { tokens: plain, endState: prev };
        const result = grammar.tokenizeLine2(line, prev.stack, TIME_LIMIT_MS);
        const tokens = result.tokens;
        for (let i = 1; i < tokens.length; i += 2) {
          // The grammar's own language bits → Monaco's id for this language (bracket and
          // comment rules come from it), unless the configured grammar set them from its
          // embedded languages; "other" tokens may hold brackets (comments, strings and regexes
          // don't).
          let m = tokens[i] ?? 0;
          if (!configured || (m & LANGUAGE_MASK) === 0) m = (m & ~LANGUAGE_MASK) | encodedId;
          if ((m & TOKEN_TYPE_MASK) === 0) m |= BALANCED_BRACKETS;
          tokens[i] = m >>> 0;
          this.colorSeen((m & FOREGROUND_MASK) >>> FOREGROUND_OFFSET);
        }
        return {
          tokens,
          endState: result.ruleStack === prev.stack ? prev : new TokenState(result.ruleStack),
        };
      },
    };
    const registration = monaco.languages.setTokensProvider(languageId, provider);
    this.registered.set(languageId, {
      grammar: grammarName,
      ...(rules && { rules }),
      dispose: () => registration.dispose(),
    });
  }

  /**
   * `shared` configured with the embedded languages and token types (grammarInternals.ts): one
   * copy per grammar and configuration, kept. Null when it can't be made: the plain grammar then
   * tokenizes as before.
   */
  private configuredGrammar(
    grammarName: string,
    shared: Grammar,
    initialLanguage: number,
    config: NonNullable<ReturnType<typeof grammarConfiguration>>,
  ): Grammar | null {
    const key = JSON.stringify([initialLanguage, config]);
    const cached = this.configured.get(grammarName);
    if (cached?.key === key && cached.base === shared) return cached.grammar;
    (cached?.grammar as { dispose?(): void } | undefined)?.dispose?.();
    this.configured.delete(grammarName);
    const grammar = configureGrammar(shared, initialLanguage, config);
    if (grammar) this.configured.set(grammarName, { key, base: shared, grammar });
    return grammar;
  }
  /** Configured copies of grammars (configuredGrammar), by Shiki's grammar name. */
  private readonly configured = new Map<string, { key: string; base: Grammar; grammar: Grammar }>();
  /** Injection grammars of extensions no longer installed (their scope names). */
  private readonly removedInjections = new Set<string>();

  /** Every compiled grammar: Shiki's and the configured copies. */
  private allGrammars(): Set<Grammar> {
    const out = new Set<Grammar>();
    for (const name of this.highlighter.getLoadedLanguages()) {
      try {
        out.add(this.highlighter.getLanguage(name));
      } catch {
        // An alias of a language that failed to load.
      }
    }
    for (const c of this.configured.values()) out.add(c.grammar);
    return out;
  }

  /**
   * An injection grammar (`scope`, injected into `injectTo`) was loaded after (`present`) or
   * removed while grammars it targets were in use: their injections are gathered again and
   * their languages tokenize again, without a restart (VS Code's).
   */
  setInjection(scope: string, injectTo: readonly string[], present: boolean): void {
    if (present) this.removedInjections.delete(scope);
    else this.removedInjections.add(scope);
    let changed = false;
    for (const grammar of this.allGrammars())
      if (setGrammarInjection(grammar, scope, injectTo, present)) changed = true;
    if (changed)
      for (const [lang, { grammar, rules }] of [...this.registered])
        this.register(lang, grammar, rules);
  }

  /** Leaves injections of uninstalled extensions out of a grammar compiled after they went. */
  private dropRemovedInjections(grammar: Grammar): void {
    if (this.removedInjections.size) dropInjections(grammar, this.removedInjections);
  }

  has(languageId: string): boolean {
    return this.registered.has(languageId);
  }
}

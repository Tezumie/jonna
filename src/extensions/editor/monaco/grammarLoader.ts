// Which TextMate grammar tokenizes each language, loaded once when a file of it first opens: the
// editor's own (grammars.ts) or an extension's, which replaces it as in VS Code (the last one
// registered for the language wins; grammarRules.ts decides), with the injection grammars aimed
// at its scopes loaded first (TextMate gathers a grammar's injections when it first tokenizes)
// and the grammars it includes by scope. Changing extensions re-tokenizes the languages whose
// grammar changed, and those an injection grammar joined or left. A grammar's `embeddedLanguages`
// and `tokenTypes` (or the editor's own, BUILTIN_SCOPE_RULES) go to the tokenizer (textmate.ts).
import type { HighlighterCore, LanguageRegistration } from "shiki/core";
import type { ContributedGrammar } from "../engine";
import {
  BUILTIN_SCOPE_RULES,
  BUILTIN_SCOPES,
  grammarsByScope,
  includedScopes,
  injectionsFor,
  languageGrammar,
  renameGrammarScope,
} from "../grammarRules";
import { PLAINTEXT } from "../languages";
import * as monaco from "./core";
import { GRAMMARS } from "./grammars";
import type { TextMateTokens } from "./textmate";

export class GrammarLoader {
  private grammars: readonly ContributedGrammar[] = [];
  private byScope = new Map<string, ContributedGrammar>();
  /** Each language's grammar in use (an extension's, or "builtin") and its loading. */
  private readonly chosen = new Map<
    string,
    { key: ContributedGrammar | "builtin"; done: Promise<void> }
  >();
  /** The editor's grammars loaded into the highlighter, by language. */
  private readonly builtins = new Map<string, Promise<string | null>>();
  /** Extensions' grammars loaded, with the name the highlighter knows each by. */
  private readonly contributed = new Map<ContributedGrammar, Promise<string | null>>();
  /** Scopes the highlighter compiled (it keeps one grammar per scope name for good). */
  private readonly compiledScopes = new Set<string>();
  /** Injection grammars loaded, with the scope name each was compiled under. */
  private readonly injected = new Map<ContributedGrammar, string>();
  private seq = 0;

  constructor(
    private readonly highlighter: HighlighterCore,
    private readonly tokens: TextMateTokens,
  ) {}

  /** Whether `languageId` has a grammar (the editor's or an extension's). */
  has(languageId: string): boolean {
    return !!GRAMMARS[languageId] || !!languageGrammar(this.grammars, languageId);
  }

  /** Extensions' grammars now: languages whose grammar changed tokenize again with the new one. */
  set(grammars: readonly ContributedGrammar[]): void {
    this.grammars = grammars;
    this.byScope = grammarsByScope(grammars);
    void this.updateInjections(grammars);
    const languages = new Set([
      ...this.chosen.keys(),
      ...monaco.editor.getModels().map((m) => m.getLanguageId()),
    ]);
    for (const id of languages) void this.ensure(id);
  }

  /**
   * Injection grammars that came or went while grammars they inject into were in use (an
   * extension installed, updated or removed): a new one is loaded and joins them, a removed one
   * leaves them, and their languages tokenize again — VS Code applies these without a restart.
   */
  private async updateInjections(grammars: readonly ContributedGrammar[]): Promise<void> {
    const now = new Set(grammars);
    for (const [g, scope] of [...this.injected])
      if (!now.has(g)) {
        this.injected.delete(g);
        this.contributed.delete(g);
        this.tokens.setInjection(scope, g.injectTo ?? [], false);
      }
    const compiled = [...this.compiledScopes];
    for (const g of injectionsFor(grammars, compiled)) {
      if (this.contributed.has(g)) continue;
      const name = await this.loadContributed(g, new Set()).catch(() => null);
      const scope = this.injected.get(g);
      // Superseded meanwhile (another set() removed it): leave it out.
      if (!name || !scope || this.grammars !== grammars) continue;
      this.tokens.setInjection(scope, g.injectTo ?? [], true);
    }
  }

  /** Loads `languageId`'s grammar (once per choice) and tokenizes the language with it. */
  ensure(languageId: string): Promise<void> {
    if (languageId === PLAINTEXT) return Promise.resolve();
    const grammar = languageGrammar(this.grammars, languageId);
    if (!grammar && !GRAMMARS[languageId]) return Promise.resolve();
    const key = grammar ?? "builtin";
    const current = this.chosen.get(languageId);
    if (current?.key === key) return current.done;
    const done = (async () => {
      const name = grammar
        ? await this.loadContributed(grammar, new Set())
        : await this.loadBuiltin(languageId);
      // Another choice may have replaced this one while it loaded.
      if (this.chosen.get(languageId)?.key !== key || !name) return;
      if (this.highlighter.getLoadedLanguages().includes(name))
        this.tokens.register(
          languageId,
          name,
          grammar
            ? {
                ...(grammar.embeddedLanguages && { embeddedLanguages: grammar.embeddedLanguages }),
                ...(grammar.tokenTypes && { tokenTypes: grammar.tokenTypes }),
              }
            : BUILTIN_SCOPE_RULES[languageId],
        );
    })().catch((err: unknown) => console.error(`Failed to load grammar "${languageId}"`, err));
    this.chosen.set(languageId, { key, done });
    return done;
  }

  /** The editor's own grammar of `languageId` (its embedded languages with it). */
  private loadBuiltin(languageId: string): Promise<string | null> {
    let pending = this.builtins.get(languageId);
    if (!pending) {
      const load = GRAMMARS[languageId];
      pending = load
        ? load().then(async (mod) => {
            const regs = mod.default;
            await this.loadInjections(regs.map((r) => r.scopeName));
            await this.highlighter.loadLanguage(...regs);
            for (const r of regs) this.compiledScopes.add(r.scopeName);
            return languageId;
          })
        : Promise.resolve(null);
      this.builtins.set(languageId, pending);
    }
    return pending;
  }

  /** Injection grammars aimed at any of `scopes`, loaded before those scopes' grammars. */
  private async loadInjections(scopes: readonly string[], visiting = new Set<object>()) {
    for (const g of injectionsFor(this.grammars, scopes))
      await this.loadContributed(g, visiting).catch(() => null);
  }

  /**
   * An extension's grammar, under a name of its own. What it includes from other grammars loads
   * first (an extension's by scope, or the editor's own); a scope the highlighter already
   * compiled (the editor's grammar it replaces, loaded before the extension came) is renamed.
   */
  private loadContributed(g: ContributedGrammar, visiting: Set<object>): Promise<string | null> {
    const loaded = this.contributed.get(g);
    if (loaded) return loaded;
    // Grammars including each other: the one being loaded is left to the highlighter.
    if (visiting.has(g)) return Promise.resolve(null);
    visiting.add(g);
    const pending = (async () => {
      let json = (await g.load()) as Record<string, unknown>;
      if (!json || typeof json !== "object") throw new Error(`${g.scopeName}: not a grammar`);
      for (const scope of includedScopes(json, g.scopeName)) {
        const other = this.byScope.get(scope);
        if (other && other !== g) await this.loadContributed(other, visiting).catch(() => null);
        else {
          const builtin = BUILTIN_SCOPES[scope];
          if (builtin) await this.loadBuiltin(builtin).catch(() => null);
        }
      }
      await this.loadInjections([g.scopeName], visiting);
      let scopeName = g.scopeName;
      if (this.compiledScopes.has(scopeName)) {
        scopeName = `${g.scopeName}.ext${++this.seq}`;
        json = renameGrammarScope(json, g.scopeName, scopeName) as Record<string, unknown>;
      }
      const name = `ext-grammar-${++this.seq}`;
      const registration = {
        ...json,
        name,
        scopeName,
        ...(g.injectTo?.length && { injectTo: [...g.injectTo] }),
      } as unknown as LanguageRegistration;
      await this.highlighter.loadLanguage(registration);
      this.compiledScopes.add(scopeName);
      if (g.injectTo?.length) this.injected.set(g, scopeName);
      return name;
    })();
    this.contributed.set(g, pending);
    // A failed load is tried again next time (the file may be fixed).
    pending.catch(() => this.contributed.delete(g));
    return pending;
  }
}

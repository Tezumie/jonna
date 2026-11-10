// What Shiki's TextMate registry doesn't offer, done through vscode-textmate's own Grammar and
// SyncRegistry (MIT): Shiki compiles each grammar once without VS Code's `embeddedLanguages` and
// `tokenTypes`, and TextMate gathers a grammar's injections once, from the list its registry kept
// when the grammar first loaded. DOM-free (no Monaco), tested against the real Shiki. Every reach
// into a private field is checked: when vscode-textmate changes, these answer null / false and
// the plain grammar keeps tokenizing as before.
import type { HighlighterCore } from "shiki/core";

export type Grammar = ReturnType<HighlighterCore["getLanguage"]>;

/** The fields of vscode-textmate's Grammar and SyncRegistry used here. */
interface GrammarInternals {
  _rootScopeName?: unknown;
  _onigLib?: unknown;
  _injections?: unknown;
  balancedBracketSelectors?: unknown;
  _grammarRepository?: {
    lookup?(scope: string): unknown;
    _injectionGrammars?: unknown;
  };
}

/** A grammar's root scope and its registry's injection lists, or null. */
function internalsOf(
  grammar: Grammar,
): { g: GrammarInternals; root: string; lists: Map<string, string[]> } | null {
  const g = grammar as unknown as GrammarInternals;
  const root = g._rootScopeName;
  const lists = g._grammarRepository?._injectionGrammars;
  if (typeof root !== "string" || !(lists instanceof Map)) return null;
  return { g, root, lists: lists as Map<string, string[]> };
}

/**
 * A copy of `shared` made with VS Code's grammar configuration: `initialLanguage` for its own
 * code and `embeddedLanguages` (scope → engine language id) / `tokenTypes` (scope → standard token
 * type) — the TextMate registry's `loadGrammarWithConfiguration`, which Shiki calls without them.
 * It shares the registry (theme, included grammars, injections). Null when it can't be made.
 */
export function configureGrammar(
  shared: Grammar,
  initialLanguage: number,
  config: { embeddedLanguages: Record<string, number>; tokenTypes: Record<string, number> },
): Grammar | null {
  const g = shared as unknown as GrammarInternals;
  const root = g._rootScopeName;
  const repository = g._grammarRepository;
  if (typeof root !== "string" || typeof repository?.lookup !== "function" || !g._onigLib)
    return null;
  const raw = repository.lookup(root);
  const Ctor = (shared as object).constructor as unknown;
  if (!raw || typeof Ctor !== "function") return null;
  try {
    const grammar = new (Ctor as new (...args: unknown[]) => Grammar)(
      root,
      raw,
      initialLanguage,
      config.embeddedLanguages,
      config.tokenTypes,
      g.balancedBracketSelectors ?? null,
      repository,
      g._onigLib,
    );
    return typeof grammar.tokenizeLine2 === "function" ? grammar : null;
  } catch {
    return null;
  }
}

/** Whether `root` is `target` or inside it, as TextMate matches `injectTo`. */
function injectsInto(root: string, injectTo: readonly string[]): boolean {
  return injectTo.some((t) => root === t || root.startsWith(`${t}.`));
}

/**
 * Adds (`present`) or removes the injection grammar `scope` from the injections of `grammar`
 * when `injectTo` names its root scope, so they're gathered again on its next line. True when
 * it applies to this grammar (its tokens are then stale).
 */
export function setGrammarInjection(
  grammar: Grammar,
  scope: string,
  injectTo: readonly string[],
  present: boolean,
): boolean {
  const it = internalsOf(grammar);
  if (!it || !injectsInto(it.root, injectTo)) return false;
  const list = it.lists.get(it.root) ?? [];
  const next = present
    ? list.includes(scope)
      ? list
      : [...list, scope]
    : list.filter((s) => s !== scope);
  if (next !== list) it.lists.set(it.root, next);
  it.g._injections = null;
  return true;
}

/**
 * Leaves the injection grammars in `removed` out of `grammar`'s injections (one compiled after
 * they went: Shiki's resolver still lists them), and has them gathered again.
 */
export function dropInjections(grammar: Grammar, removed: ReadonlySet<string>): void {
  const it = internalsOf(grammar);
  const list = it?.lists.get(it.root);
  if (!it || !list) return;
  if (list.some((s) => removed.has(s)))
    it.lists.set(
      it.root,
      list.filter((s) => !removed.has(s)),
    );
  it.g._injections = null;
}

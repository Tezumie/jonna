// Which TextMate scopes color a semantic token (D204), as VS Code's token classification decides:
// selectors ("type", "type.modifier", "*.declaration", with a language or for all) each give
// scopes to try; the best match goes first (a type 100, each modifier 100 more, a language 10
// more; a later registration wins a tie), and a custom type falls back to its superType. The
// editor's defaults are VS Code's for the standard types; extensions add theirs
// (`semanticTokenScopes`, `semanticTokenTypes`). DOM-free, tested.

export interface SemanticScopeRules {
  /** The editor's language id it applies to (none: all). */
  language?: string;
  /** Selector → scopes, most wanted first. */
  scopes: Readonly<Record<string, readonly string[]>>;
  /** Custom type → the type it falls back to. */
  superTypes?: Readonly<Record<string, string>>;
}

/** Standard semantic token types → TextMate scopes (VS Code's defaults). */
const TYPE_SCOPES: Record<string, readonly string[]> = {
  comment: ["comment"],
  string: ["string"],
  keyword: ["keyword.control"],
  number: ["constant.numeric"],
  regexp: ["constant.regexp"],
  operator: ["keyword.operator"],
  namespace: ["entity.name.namespace"],
  type: ["entity.name.type", "support.type"],
  struct: ["entity.name.type.struct"],
  class: ["entity.name.type.class", "support.class"],
  interface: ["entity.name.type.interface"],
  enum: ["entity.name.type.enum"],
  typeParameter: ["entity.name.type.parameter"],
  function: ["entity.name.function", "support.function"],
  member: ["entity.name.function.member", "support.function"],
  method: ["entity.name.function.member", "support.function"],
  macro: ["entity.name.function.preprocessor"],
  variable: ["variable.other.readwrite", "entity.name.variable"],
  parameter: ["variable.parameter"],
  property: ["variable.other.property"],
  enumMember: ["variable.other.enummember"],
  event: ["variable.other.event"],
  decorator: ["entity.name.decorator", "entity.name.function"],
  label: ["entity.name.label"],
};

/** Type + modifier pairs with scopes of their own (checked before the type's). */
const MODIFIER_SCOPES: Record<string, readonly string[]> = {
  "variable.readonly.defaultLibrary": ["support.constant"],
  "variable.readonly": ["variable.other.constant"],
  "property.readonly": ["variable.other.constant.property"],
  "type.defaultLibrary": ["support.type"],
  "class.defaultLibrary": ["support.class"],
  "interface.defaultLibrary": ["support.type"],
  "variable.defaultLibrary": ["support.variable", "support.other.variable"],
  "property.defaultLibrary": ["support.variable.property"],
  "function.defaultLibrary": ["support.function"],
  "member.defaultLibrary": ["support.function"],
  "method.defaultLibrary": ["support.function"],
};

const DEFAULTS: SemanticScopeRules = { scopes: { ...TYPE_SCOPES, ...MODIFIER_SCOPES } };

/** A type and the types it falls back to (its superType chain; at most a few). */
function typeChain(type: string, rules: readonly SemanticScopeRules[]): string[] {
  const chain = [type];
  for (let i = 0; i < 5; i++) {
    const last = chain[chain.length - 1] ?? "";
    let next: string | undefined;
    for (const r of rules) next = r.superTypes?.[last] ?? next;
    if (!next || chain.includes(next)) break;
    chain.push(next);
  }
  return chain;
}

/**
 * The scopes to try for a token, the best match first: the editor's defaults, then `contributed`
 * (registered later, so they win a tie). A super type's matches count less than the type's own.
 */
export function semanticScopes(
  type: string,
  modifiers: readonly string[],
  language?: string,
  contributed: readonly SemanticScopeRules[] = [],
): string[] {
  const rules = [DEFAULTS, ...contributed];
  const types = typeChain(type, rules);
  const has = new Set(modifiers);
  const matches: { score: number; order: number; scopes: readonly string[] }[] = [];
  for (const [ruleIndex, rule] of rules.entries())
    for (const [entryIndex, [selector, scopes]] of Object.entries(rule.scopes).entries()) {
      // A later registration wins a tie; within one, its first selector.
      const order = ruleIndex * 100_000 - entryIndex;
      const [head = "", selectorLanguage] = selector.split(":");
      const lang = rule.language ?? selectorLanguage?.trim();
      if (lang && lang !== language) continue;
      const [t = "", ...mods] = head.trim().split(".");
      if (!mods.every((m) => has.has(m))) continue;
      const depth = types.indexOf(t);
      if (t !== "*" && depth < 0) continue;
      // The type's own beats its super type's; "*" matches any type, least.
      const typeScore = t === "*" ? 0 : 100 - Math.min(depth, 9) * 10;
      matches.push({
        score: typeScore + mods.length * 100 + (lang ? 10 : 0),
        order,
        scopes,
      });
    }
  matches.sort((a, b) => b.score - a.score || b.order - a.order);
  const out: string[] = [];
  for (const m of matches) for (const s of m.scopes) if (!out.includes(s)) out.push(s);
  return out;
}

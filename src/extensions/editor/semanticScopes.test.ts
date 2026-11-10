import assert from "node:assert/strict";
import { test } from "node:test";
import { type SemanticScopeRules, semanticScopes } from "./semanticScopes";

test("semanticScopes: the editor's defaults, type and modifier pairs first", () => {
  assert.deepEqual(semanticScopes("function", []), ["entity.name.function", "support.function"]);
  assert.deepEqual(semanticScopes("variable", ["readonly"]).slice(0, 1), [
    "variable.other.constant",
  ]);
  assert.equal(semanticScopes("variable", ["readonly", "defaultLibrary"])[0], "support.constant");
  assert.deepEqual(semanticScopes("unknownType", []), []);
});

test("semanticScopes: extensions' selectors, languages and super types (semanticTokenScopes)", () => {
  const rules: SemanticScopeRules[] = [
    {
      language: "python",
      scopes: { module: ["entity.name.namespace"], selfParameter: ["variable.language.self"] },
    },
    { scopes: { "*.declaration": ["meta.declaration"], "class.builtin": ["support.class"] } },
    { scopes: {}, superTypes: { selfParameter: "parameter", customFn: "function" } },
  ];
  // A custom type in its language.
  assert.equal(semanticScopes("module", [], "python", rules)[0], "entity.name.namespace");
  assert.deepEqual(semanticScopes("module", [], "rust", rules), []);
  // Its own scopes first, then its super type's.
  assert.deepEqual(semanticScopes("selfParameter", [], "python", rules), [
    "variable.language.self",
    "variable.parameter",
  ]);
  // A super type only.
  assert.deepEqual(semanticScopes("customFn", [], "python", rules), [
    "entity.name.function",
    "support.function",
  ]);
  // A type with a modifier beats the type alone; "*" matches any type, least.
  assert.deepEqual(semanticScopes("class", ["builtin", "declaration"], undefined, rules), [
    "support.class",
    "meta.declaration",
    "entity.name.type.class",
  ]);
});

test("semanticScopes: an extension's selector wins a tie with the editor's", () => {
  const rules = [{ scopes: { function: ["entity.name.function.custom"] } }];
  assert.equal(semanticScopes("function", [], undefined, rules)[0], "entity.name.function.custom");
  // A language-specific selector beats a general one.
  const byLanguage = [
    { language: "python", scopes: { function: ["a"] } },
    { scopes: { function: ["b"] } },
  ];
  assert.equal(semanticScopes("function", [], "python", byLanguage)[0], "a");
  assert.equal(semanticScopes("function", [], "go", byLanguage)[0], "b");
  // A selector naming its language (VS Code's "type:language").
  assert.equal(
    semanticScopes("function", [], "go", [{ scopes: { "function:go": ["c"] } }])[0],
    "c",
  );
});

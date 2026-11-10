import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUILTIN_SCOPE_RULES,
  grammarConfiguration,
  grammarsByScope,
  includedScopes,
  injectionsFor,
  languageGrammar,
  renameGrammarScope,
} from "./grammarRules";

test("languageGrammar: the last grammar registered for a language wins (VS Code's)", () => {
  const a = { scopeName: "source.python", language: "python" };
  const b = { scopeName: "source.python.magic", language: "python" };
  const injection = { scopeName: "python.injection", injectTo: ["source.python"] };
  assert.equal(languageGrammar([a, injection, b], "python"), b);
  assert.equal(languageGrammar([a], "rust"), undefined);
  assert.equal(languageGrammar([injection], "python"), undefined);
  assert.equal(grammarsByScope([a, { ...a, language: "x" }]).get("source.python")?.language, "x");
});

test("injectionsFor: a grammar's scope, or one inside the scope injected into", () => {
  const md = { scopeName: "markdown.math", injectTo: ["text.html.markdown"] };
  const html = { scopeName: "html.inject", injectTo: ["text.html"] };
  const py = { scopeName: "py.inject", injectTo: ["source.python"] };
  const list = [md, html, py];
  assert.deepEqual(injectionsFor(list, ["text.html.markdown"]), [md, html]);
  assert.deepEqual(injectionsFor(list, ["source.python"]), [py]);
  assert.deepEqual(injectionsFor(list, ["source.pythonic"]), []);
  assert.deepEqual(injectionsFor(list, ["text.html.basic", "source.css"]), [html]);
});

test("includedScopes and renameGrammarScope", () => {
  const grammar = {
    scopeName: "source.req",
    patterns: [{ include: "#comment" }, { include: "source.python" }, { include: "$self" }],
    repository: {
      comment: { patterns: [{ include: "source.req#other" }, { include: "text.html.basic#tag" }] },
    },
  };
  assert.deepEqual(includedScopes(grammar, "source.req").sort(), [
    "source.python",
    "text.html.basic",
  ]);
  const renamed = renameGrammarScope(grammar, "source.req", "source.req.ext1") as typeof grammar;
  assert.equal(renamed.scopeName, "source.req.ext1");
  assert.equal(renamed.repository.comment.patterns[0]?.include, "source.req.ext1#other");
  assert.equal(renamed.patterns[1]?.include, "source.python");
  // The original is left as it was.
  assert.equal(grammar.repository.comment.patterns[0]?.include, "source.req#other");
});

test("grammarConfiguration: embedded languages as engine ids, token types as numbers", () => {
  const ids: Record<string, number> = { html: 3, css: 4, tsx: 5 };
  const encode = (id: string) => ids[id] ?? 0;
  assert.deepEqual(
    grammarConfiguration(
      {
        embeddedLanguages: {
          "source.css": "css",
          "meta.embedded.block.typescriptreact": "typescriptreact",
          "source.unknown": "nothing-known",
        },
        tokenTypes: { "meta.tag string.quoted": "other", "comment.x": "comment", y: "bogus" },
      },
      encode,
    ),
    {
      // VS Code's ids are the editor's (typescriptreact is tsx); unknown languages are skipped.
      embeddedLanguages: { "source.css": 4, "meta.embedded.block.typescriptreact": 5 },
      tokenTypes: { "meta.tag string.quoted": 0, "comment.x": 1 },
    },
  );
  // Nothing that applies: the plain grammar.
  assert.equal(grammarConfiguration({ embeddedLanguages: { a: "nope" } }, encode), undefined);
  assert.equal(grammarConfiguration({}, encode), undefined);
});

test("the editor's own HTML and Markdown grammars say which language their blocks are", () => {
  assert.equal(BUILTIN_SCOPE_RULES.html?.embeddedLanguages?.["source.css"], "css");
  assert.equal(BUILTIN_SCOPE_RULES.html?.tokenTypes?.["meta.tag string.quoted"], "other");
  assert.equal(
    BUILTIN_SCOPE_RULES.markdown?.embeddedLanguages?.["meta.embedded.block.python"],
    "python",
  );
});

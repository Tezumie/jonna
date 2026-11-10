import assert from "node:assert/strict";
import { test } from "node:test";
import { parseManifest } from "./thirdParty";

test("parseManifest: a VS Code package's languages, grammars and semantic token scopes", () => {
  const m = parseManifest(
    {
      name: "python",
      publisher: "ms-python",
      version: "1.0.0",
      contributes: {
        languages: [
          {
            id: "pip-requirements",
            aliases: ["pip requirements"],
            filenames: ["constraints.txt"],
            filenamePatterns: ["*-requirements.txt", "requirements-*.txt", 3],
            firstLine: "^#!.*pip",
            configuration: "./languages/pip-requirements.json",
          },
        ],
        grammars: [
          {
            language: "pip-requirements",
            scopeName: "source.pip-requirements",
            path: "./syntaxes/pip-requirements.tmLanguage.json",
          },
          {
            scopeName: "markdown.python.codeblock",
            path: "./syntaxes/md.json",
            injectTo: ["text.html.markdown", 1],
            embeddedLanguages: { "meta.embedded.block.python": "python", bad: 2 },
            tokenTypes: { "string.quoted.docstring": "other" },
          },
        ],
        semanticTokenScopes: [
          { language: "python", scopes: { selfParameter: ["variable.language.self"], x: [] } },
          { scopes: {} },
        ],
        semanticTokenTypes: [{ id: "selfParameter", superType: "parameter" }, { nope: 1 }],
      },
    },
    "package.json",
  );
  const c = m.contributes;
  assert.deepEqual(c.languages[0]?.filenamePatterns, ["*-requirements.txt", "requirements-*.txt"]);
  assert.equal(c.languages[0]?.firstLine, "^#!.*pip");
  assert.deepEqual(c.languages[0]?.filenames, ["constraints.txt"]);
  assert.equal(c.grammars.length, 2);
  assert.equal(c.grammars[0]?.injectTo, undefined);
  assert.deepEqual(c.grammars[1]?.injectTo, ["text.html.markdown"]);
  assert.deepEqual(c.grammars[1]?.embeddedLanguages, { "meta.embedded.block.python": "python" });
  assert.deepEqual(c.grammars[1]?.tokenTypes, { "string.quoted.docstring": "other" });
  assert.deepEqual(c.semanticTokenScopes, [
    { language: "python", scopes: { selfParameter: ["variable.language.self"] } },
  ]);
  assert.deepEqual(c.semanticTokenTypes, [{ id: "selfParameter", superType: "parameter" }]);
});

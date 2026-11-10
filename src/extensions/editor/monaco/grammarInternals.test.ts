// The TextMate internals grammarInternals.ts reaches into, checked against the real Shiki: a
// grammar configured with VS Code's embeddedLanguages / tokenTypes, and injection grammars that
// join or leave a grammar already in use. A Shiki update that breaks these fails here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHighlighterCore, type LanguageRegistration } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { configureGrammar, dropInjections, setGrammarInjection } from "./grammarInternals";

const LANGUAGE_MASK = 0xff;
const TOKEN_TYPE_MASK = 0x300;
const TOKEN_TYPE_OFFSET = 8;

const host = {
  name: "host-lang",
  scopeName: "source.host",
  patterns: [
    { name: "string.quoted.host", match: '"[^"]*"' },
    {
      begin: "<<",
      end: ">>",
      contentName: "source.guest",
      patterns: [{ name: "keyword.guest", match: "\\bguest\\b" }],
    },
  ],
} as unknown as LanguageRegistration;

const injection = {
  name: "todo-injection",
  scopeName: "todo.injection",
  injectTo: ["source.host"],
  injectionSelector: "L:source.host",
  // A comment scope: without a theme, only the token type tells it apart.
  patterns: [{ name: "comment.todo", match: "\\bTODO\\b" }],
} as unknown as LanguageRegistration;

async function highlighter() {
  return createHighlighterCore({
    engine: createJavaScriptRegexEngine({ forgiving: true }),
    langs: [host],
    themes: [],
  });
}

/** Each token's start, language and standard type. */
function tokens(
  grammar: ReturnType<Awaited<ReturnType<typeof highlighter>>["getLanguage"]>,
  line: string,
) {
  const { tokens: t } = grammar.tokenizeLine2(line, null as never);
  const out: { start: number; language: number; type: number }[] = [];
  for (let i = 0; i < t.length; i += 2)
    out.push({
      start: t[i] ?? 0,
      language: (t[i + 1] ?? 0) & LANGUAGE_MASK,
      type: ((t[i + 1] ?? 0) & TOKEN_TYPE_MASK) >>> TOKEN_TYPE_OFFSET,
    });
  return out;
}

test("a configured grammar marks embedded code with its language and applies token types", async () => {
  const h = await highlighter();
  const shared = h.getLanguage("host-lang");
  const configured = configureGrammar(shared, 7, {
    embeddedLanguages: { "source.guest": 9 },
    tokenTypes: { "string.quoted.host": 0 },
  });
  assert.ok(configured);
  const line = '"s" <<guest>>';
  const plain = tokens(shared, line);
  // Shiki's own: one language, the string a string.
  assert.ok(plain.every((t) => t.language === 1));
  assert.equal(plain[0]?.type, 2);
  const mine = tokens(configured, line);
  // The string is "other" now (brackets in it pair), and the code between << >> is the guest's.
  assert.equal(mine[0]?.type, 0);
  assert.equal(mine[0]?.language, 7);
  const guest = mine.find((t) => t.start === line.indexOf("guest"));
  assert.equal(guest?.language, 9);
  h.dispose();
});

test("an injection grammar loaded after its target was used joins it, and leaves it", async () => {
  const h = await highlighter();
  const grammar = h.getLanguage("host-lang");
  const line = "a TODO b";
  // Used before the injection came: its injections were gathered (none).
  const before = tokens(grammar, line);
  await h.loadLanguage(injection);
  // TextMate kept the old list: no change until it's told.
  assert.deepEqual(tokens(grammar, line), before);
  assert.equal(setGrammarInjection(grammar, "todo.injection", ["source.host"], true), true);
  const after = tokens(grammar, line);
  assert.ok(
    after.some((t) => t.start === line.indexOf("TODO") && t.type === 1),
    "TODO is a comment token of its own",
  );
  // A grammar it doesn't target is left alone.
  assert.equal(setGrammarInjection(grammar, "todo.injection", ["source.other"], true), false);
  // Removed (its extension uninstalled): gone again.
  assert.equal(setGrammarInjection(grammar, "todo.injection", ["source.host"], false), true);
  assert.deepEqual(tokens(grammar, line), before);
  // dropInjections leaves removed ones out of a list that still names them.
  setGrammarInjection(grammar, "todo.injection", ["source.host"], true);
  dropInjections(grammar, new Set(["todo.injection"]));
  assert.deepEqual(tokens(grammar, line), before);
  h.dispose();
});

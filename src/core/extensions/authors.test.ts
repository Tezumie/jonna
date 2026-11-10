import assert from "node:assert/strict";
import { test } from "node:test";
import { acpAuthor, agentAuthor } from "../../extensions/extensions/newAuthors";
import { authorsText, parseAuthor, parseAuthors } from "./authors";
import { parseManifest } from "./thirdParty";

test("parseAuthors: authors, else author and contributors, without repeats (D185)", () => {
  assert.deepEqual(
    parseAuthors({
      authors: [
        { name: "Claude", url: "https://claude.ai", avatar: "brand:anthropic" },
        { name: "Tezumie", github: "Tezumie" },
        "tezumie",
        { github: "octo" },
      ],
      author: "ignored when authors is there",
    }),
    [
      { name: "Claude", url: "https://claude.ai", avatar: "brand:anthropic" },
      { name: "Tezumie", github: "Tezumie" },
      { name: "octo", github: "octo" },
    ],
  );
  // npm's forms; a github.com URL gives the GitHub name.
  assert.deepEqual(
    parseAuthors({
      author: "Ada Lovelace <ada@example.com> (https://github.com/ada)",
      contributors: [{ name: "Bob", url: "https://bob.example" }, 3, null],
    }),
    [
      { name: "Ada Lovelace", url: "https://github.com/ada", github: "ada" },
      { name: "Bob", url: "https://bob.example" },
    ],
  );
  assert.deepEqual(parseAuthors({}), []);
});

test("parseAuthor: nothing loads from elsewhere but GitHub and the IDE's brand marks", () => {
  assert.deepEqual(
    parseAuthor({
      name: "X",
      avatar: "https://evil.example/p.png",
      url: "javascript:alert(1)",
      github: "-bad",
    }),
    { name: "X" },
  );
  assert.equal(parseAuthor({ url: "https://x" }), null);
  assert.equal(parseAuthor(""), null);
});

test("authorsText: names like a contributors line", () => {
  const a = (name: string) => ({ name });
  assert.equal(authorsText([a("A")]), "A");
  assert.equal(authorsText([a("A"), a("B")]), "A and B");
  assert.equal(authorsText([a("A"), a("B"), a("C")]), "A, B and C");
  assert.equal(authorsText([a("A"), a("B"), a("C"), a("D")]), "A, B and 2 more");
});

test("parseManifest keeps a single author as the authors list", () => {
  const m = parseManifest(
    { id: "a.b", version: "1.0.0", author: { name: "Ann", url: "https://a.example" } },
    "extension.json",
  );
  assert.equal(m.author, "Ann");
  assert.deepEqual(m.authors, [{ name: "Ann", url: "https://a.example" }]);
});

test("agentAuthor / acpAuthor: the agent behind a model or program", () => {
  assert.equal(agentAuthor("anthropic/claude-opus-5-5").name, "Claude");
  assert.equal(agentAuthor("anthropic/claude-opus-5-5").avatar, "brand:anthropic");
  assert.equal(agentAuthor("openai/gpt-5").avatar, "brand:openai");
  assert.equal(agentAuthor("ollama/qwen3:8b").name, "qwen3:8b");
  assert.equal(agentAuthor(null).name, "Agent");
  assert.equal(acpAuthor("claude-code").name, "Claude Code");
  assert.equal(acpAuthor("my-agent").name, "my-agent");
});

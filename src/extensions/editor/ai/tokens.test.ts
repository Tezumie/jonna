import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFimPrompt, splitBudget } from "./fim";
import { charsPerToken, estimateTokens, tokenizerProfile } from "./tokens";

// cl100k_base counts of these snippets (measured with gpt-tokenizer, outside the repo).
const TS = `export function rankSnippets(input: { current: string; max?: number }): Snippet[] {\n  const max = input.max ?? 4;\n  for (const doc of input.documents) {\n    if (doc.path === input.current.path) continue;\n  }\n  return out.sort((a, b) => b.score - a.score).slice(0, max);\n}\n`;
const TS_CL100K = 77;
const PY = `def parse_version(text: str) -> tuple[int, int]:\n    major, minor = text.split(".")[:2]\n    return int(major), int(minor)\n\n\nclass Version:\n    def __init__(self, major: int, minor: int) -> None:\n        self.major = major\n        self.minor = minor\n`;
const PY_CL100K = 68;

const near = (actual: number, expected: number, within: number) =>
  assert.ok(
    Math.abs(actual - expected) <= expected * within,
    `${actual} is not within ${within * 100} % of ${expected}`,
  );

test("token estimate follows cl100k on code (D224)", () => {
  const gpt = tokenizerProfile("openai/gpt-4o");
  assert.equal(gpt.name, "large-bpe");
  near(estimateTokens(TS, gpt), TS_CL100K, 0.15);
  near(estimateTokens(PY, gpt), PY_CL100K, 0.15);
  assert.equal(estimateTokens("", gpt), 0);
  // Identifier parts, digit groups, punctuation runs.
  assert.equal(estimateTokens("parseHTTPRequest", gpt), 3);
  assert.equal(estimateTokens("123456", gpt), 2);
  assert.equal(estimateTokens("123456", tokenizerProfile("ollama/qwen2.5-coder:1.5b")), 6);
});

test("tokenizer families by model name", () => {
  assert.equal(tokenizerProfile("ollama/qwen2.5-coder:1.5b-base").name, "large-bpe-digits");
  assert.equal(tokenizerProfile("ollama/deepseek-coder:1.3b").name, "large-bpe-digits");
  assert.equal(tokenizerProfile("ollama/starcoder2:3b").name, "large-bpe-digits");
  assert.equal(tokenizerProfile("ollama/codellama:7b-code").name, "sentencepiece");
  assert.equal(tokenizerProfile("ollama/mistral:7b").name, "sentencepiece");
  assert.equal(tokenizerProfile("ollama/llama3.2:3b").name, "large-bpe");
  assert.equal(tokenizerProfile("anthropic/claude-sonnet-4").name, "large-bpe");
  assert.equal(tokenizerProfile("custom/whatever").name, "default");
  assert.equal(tokenizerProfile(null).name, "default");
  // A smaller vocabulary: more tokens for the same code.
  assert.ok(
    estimateTokens(TS, tokenizerProfile("codellama")) >
      estimateTokens(TS, tokenizerProfile("gpt-4o")),
  );
});

test("the prompt budget uses the measured characters per token", () => {
  const sample = TS.repeat(4);
  const ratio = charsPerToken(sample, tokenizerProfile("gpt-4o"));
  assert.ok(ratio > 3 && ratio < 5.5, String(ratio));
  assert.equal(charsPerToken("short"), 4);
  const ctx = {
    path: "a.ts",
    languageId: "typescript",
    prefix: sample.repeat(20),
    suffix: "",
    snippets: [],
  };
  assert.equal(splitBudget(ctx, 1000, 3).prefix, 3000);
  const { prompt } = buildFimPrompt(ctx, 1000, 3);
  assert.ok(prompt.length <= 3000);
  // About the budget in tokens, by the same estimate.
  near(estimateTokens(prompt, tokenizerProfile("gpt-4o")), 3000 / ratio, 0.2);
});

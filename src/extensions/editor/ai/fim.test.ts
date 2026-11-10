import assert from "node:assert/strict";
import { test } from "node:test";
import { fimStyle, suggestCompletionModel } from "../../../core/agent/completionModels";
import {
  changedRegion,
  identifiers,
  jaccard,
  lineWindows,
  RecentEdits,
  rankSnippets,
} from "./context";
import {
  buildChatPrompt,
  buildFimPrompt,
  cleanFim,
  expectsSingleLine,
  fitSnippets,
  head,
  lineComment,
  shapeCompletion,
  splitBudget,
  tail,
} from "./fim";

test("FIM endpoints by provider (D204)", () => {
  const p = (kind: "ollama" | "openai" | "anthropic", baseUrl: string) => ({ kind, baseUrl });
  assert.equal(fimStyle(p("ollama", "http://127.0.0.1:11434"), "auto"), "ollama");
  assert.equal(fimStyle(p("openai", "https://codestral.mistral.ai/v1"), "auto"), "mistral");
  assert.equal(fimStyle(p("openai", "https://api.mistral.ai/v1"), "auto"), "mistral");
  assert.equal(fimStyle(p("openai", "https://api.deepseek.com"), "auto"), "deepseek");
  assert.equal(fimStyle(p("openai", "https://openrouter.ai/api/v1"), "auto"), null);
  assert.equal(fimStyle(p("openai", "http://localhost:8080/v1"), "always"), "openai");
  assert.equal(fimStyle(p("anthropic", "https://api.anthropic.com"), "always"), null);
  assert.equal(fimStyle(p("openai", "https://api.anthropic.com/v1"), "always"), null);
  assert.equal(fimStyle(p("ollama", "http://x"), "never"), null);
  // A look-alike host isn't Mistral's.
  assert.equal(fimStyle(p("openai", "https://notmistral.ai.example.com"), "auto"), null);
});

const ctx = {
  path: "src/app.py",
  languageId: "python",
  prefix: "def add(a, b):\n    return ",
  suffix: "\n\nprint(add(1, 2))\n",
  snippets: [
    {
      path: "src/util.py",
      text: "def sub(a, b):\n    return a - b\n",
      kind: "open" as const,
      score: 0.4,
    },
    { path: "src/x.py", text: "x = 1", kind: "edit" as const, score: 0.9 },
  ],
};

test("the FIM prompt: snippets as comments, the path, the prefix; the suffix apart", () => {
  const { prompt, suffix } = buildFimPrompt(ctx, 2048);
  assert.equal(
    prompt,
    [
      "# Recently edited in src/x.py:",
      "# x = 1",
      "",
      "# Compare this snippet from src/util.py:",
      "# def sub(a, b):",
      "#     return a - b",
      "",
      "# Path: src/app.py",
      "def add(a, b):",
      "    return ",
    ].join("\n"),
  );
  assert.equal(suffix, ctx.suffix);
  assert.equal(lineComment("typescript"), "//");
  assert.equal(lineComment("sql"), "--");
});

test("the budget keeps the code nearest the cursor", () => {
  const long = {
    ...ctx,
    prefix: `${"x = 1\n".repeat(2000)}y = `,
    suffix: `${"z = 2\n".repeat(2000)}`,
    snippets: [],
  };
  const b = splitBudget(long, 256);
  assert.ok(b.prefix + b.suffix + b.snippets <= 256 * 4);
  const { prompt, suffix } = buildFimPrompt(long, 256);
  assert.ok(prompt.endsWith("x = 1\ny = "));
  assert.ok(prompt.length <= 256 * 4);
  assert.ok(suffix.startsWith("z = 2\n") && suffix.length <= 256 * 4 * 0.2);
  assert.equal(tail("abc\ndef", 3), "def");
  assert.equal(head("abc\ndef", 5), "abc\nd");
  // Snippets that don't fit are left out whole, best first.
  assert.deepEqual(
    fitSnippets(ctx.snippets, 60).map((s) => s.path),
    ["src/x.py"],
  );
});

test("the chat prompt carries the same context", () => {
  const p = buildChatPrompt(ctx, 2048);
  assert.ok(p.startsWith("Context from other files"));
  assert.ok(p.includes("--- src/x.py (edited recently)\nx = 1"));
  assert.ok(p.includes("def add(a, b):\n    return <cursor>\n\nprint"));
  assert.ok(!buildChatPrompt({ ...ctx, snippets: [] }, 2048).includes("Context from"));
});

test("suggestions: one line mid-line, several at a line's end, cut where the file goes on", () => {
  assert.equal(expectsSingleLine("foo)\nbar"), true);
  assert.equal(expectsSingleLine(")\nbar"), false);
  assert.equal(expectsSingleLine(""), false);
  assert.equal(shapeCompletion("a + b\nmore", "x)\n", 10), "a + b");
  assert.equal(
    shapeCompletion(
      "if x:\n        y()\n    return 1\nprint(add(1, 2))\nmore",
      "\nprint(add(1, 2))\n",
      10,
    ),
    "if x:\n        y()\n    return 1",
  );
  assert.equal(shapeCompletion("1\n2\n3\n4", "", 2), "1\n2");
  assert.equal(shapeCompletion("   \n", "", 5), null);
  assert.equal(shapeCompletion("foo", "foo()\n", 5), null);
  // Ending with what follows the cursor on its line: that part goes.
  assert.equal(shapeCompletion("a, b)", ")\n", 5), "a, b");
});

test("a fast local code model is suggested", () => {
  const m = (model: string, size: number, extra: object = {}) => ({
    key: `ollama/${model}`,
    model,
    providerKind: "ollama" as const,
    size,
    ...extra,
  });
  assert.equal(
    suggestCompletionModel([
      m("llama3.1:8b", 4.7e9),
      m("qwen2.5-coder:7b", 4.7e9),
      m("qwen2.5-coder:1.5b-base", 1e9),
      m("qwen2.5-coder:0.5b", 4e8),
      m("deepseek-coder-v2:cloud", 1e3, { remote: true }),
    ]),
    "ollama/qwen2.5-coder:1.5b-base",
  );
  assert.equal(suggestCompletionModel([m("qwen2.5-coder:0.5b", 4e8)]), "ollama/qwen2.5-coder:0.5b");
  assert.equal(suggestCompletionModel([m("llama3.1:8b", 4.7e9)]), null);
  assert.equal(
    suggestCompletionModel([{ key: "or/codestral", model: "codestral", providerKind: "openai" }]),
    null,
  );
});

// ---- Context ----

test("similar windows of other open files rank first", () => {
  assert.deepEqual([...identifiers("a.b(cd, e_f)")], ["cd", "e_f"]);
  assert.equal(jaccard(new Set(["a", "b"]), new Set(["b", "c"])), 1 / 3);
  assert.equal(jaccard(new Set(), new Set(["a"])), 0);
  assert.deepEqual(
    lineWindows("1\n2\n3\n4\n5", 2, 2).map((w) => w.startLine),
    [1, 3, 5],
  );
  const snippets = rankSnippets({
    current: { path: "/w/a.ts", prefix: "const total = sumPrices(cart.items, taxRate);\n" },
    documents: [
      { path: "/w/a.ts", text: "const total = sumPrices(cart.items)" },
      {
        path: "/w/prices.ts",
        text: "export function sumPrices(items, taxRate) {\n  return items;\n}",
      },
      { path: "/w/other.ts", text: "unrelated words entirely here" },
      { path: "/w/empty.ts", text: "  " },
    ],
    edits: [],
  });
  assert.deepEqual(
    snippets.map((s) => s.path),
    ["/w/prices.ts"],
  );
});

test("recent edits: the changed lines, newest first, the cursor's own left out", () => {
  assert.deepEqual(changedRegion("a\nb\nc\nd", "a\nB\nc\nd", 1), { line: 1, text: "a\nB\nc" });
  assert.deepEqual(changedRegion("a\nb\nc", "a\nc", 0), { line: 2, text: "c" });
  assert.equal(changedRegion("same", "same"), null);
  const edits = new RecentEdits(3);
  edits.record("/w/a.ts", "x\ny", "x\ny2", 1000);
  edits.record("/w/a.ts", "x\ny2", "x\ny23", 2000); // the same place: one entry
  edits.record("/w/b.ts", "1", "2", 3000);
  assert.deepEqual(
    edits.all().map((e) => [e.path, e.at]),
    [
      ["/w/b.ts", 3000],
      ["/w/a.ts", 2000],
    ],
  );
  edits.moved("/w/b.ts", "/w/c.ts");
  assert.equal(edits.all()[0]?.path, "/w/c.ts");
  const ranked = rankSnippets({
    current: { path: "/w/a.ts", prefix: "x\n" },
    documents: [],
    edits: edits.all(),
    cursorLine: 2,
    now: 3000,
  });
  assert.deepEqual(
    ranked.map((s) => [s.path, s.kind]),
    [["/w/c.ts", "edit"]],
  );
  edits.moved("/w/c.ts", null);
  assert.equal(edits.all().length, 1);
});

test("FIM special tokens are cut", () => {
  assert.equal(cleanFim("a + b<|endoftext|>junk"), "a + b");
  assert.equal(cleanFim("<|fim_middle|>x<EOT>"), "x");
  assert.equal(cleanFim("plain"), "plain");
});

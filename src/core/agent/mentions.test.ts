import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contextMentionCard,
  excerpt,
  formatContextMention,
  parseContextMention,
  symbolCode,
  withoutHiddenFiles,
} from "./mentions";

test("mention values round-trip and name their cards", () => {
  const commit = formatContextMention("commit", "1a2b3c4d5e", "Fix  the\nbuild");
  assert.equal(commit, "@commit 1a2b3c4d5e Fix the build");
  assert.deepEqual(parseContextMention(commit), {
    kind: "commit",
    arg: "1a2b3c4d5e",
    name: "Fix the build",
  });
  assert.deepEqual(parseContextMention("@git"), { kind: "git", arg: "", name: "" });
  assert.equal(parseContextMention("@problems"), null);
  assert.equal(parseContextMention("@gitx"), null);
  assert.deepEqual(contextMentionCard(commit), { label: "1a2b3c4 Fix the build", icon: "history" });
  assert.equal(contextMentionCard("@chat s-123 Login bug")?.label, "Login bug");
  assert.equal(contextMentionCard("@symbol src/a.ts:12 parseRule")?.label, "parseRule");
  assert.equal(contextMentionCard("@branch")?.label, "Branch changes");
  assert.equal(contextMentionCard("@web https://x"), undefined);
});

test("excerpt keeps the start and the end", () => {
  assert.equal(excerpt("short", 100), "short");
  const long = `${"a".repeat(500)}${"z".repeat(500)}`;
  const out = excerpt(long, 200);
  assert.ok(out.startsWith("a".repeat(50)));
  assert.ok(out.endsWith("z".repeat(150)));
  assert.match(out, /800 characters left out/);
});

test("symbolCode: the definition up to the next one", () => {
  const ts = "import x;\n\nexport function a() {\n  return 1;\n}\n\nexport function b() {}\n";
  assert.equal(symbolCode(ts, 3), "3: export function a() {\n4:   return 1;\n5: }");
  const py = "class A:\n    def f(self):\n        return 1\n\n    def g(self):\n        pass\n";
  assert.equal(symbolCode(py, 2), "2:     def f(self):\n3:         return 1");
  assert.equal(symbolCode("one line", 5), "1: one line");
});

test("withoutHiddenFiles drops excluded files' sections (D200)", () => {
  const diff =
    "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n" +
    "diff --git a/.env b/.env\n@@ -1 +1 @@\n-KEY=1\n+KEY=2\n";
  const out = withoutHiddenFiles(diff, (p) => p === ".env");
  assert.ok(out.includes("src/a.ts"));
  assert.ok(!out.includes("KEY="));
  assert.ok(out.includes("Left out, excluded from the agent: .env"));
  assert.equal(
    withoutHiddenFiles(diff, () => false),
    diff,
  );
});

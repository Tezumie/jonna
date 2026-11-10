import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentIgnore, DEFAULT_AGENT_IGNORE, parseIgnoreLine } from "./ignore";

test("defaults hide secrets, not their examples", () => {
  const ig = new AgentIgnore(DEFAULT_AGENT_IGNORE);
  for (const p of [".env", ".env.local", "apps/web/.env.production", "certs/server.key", "id_rsa"])
    assert.equal(ig.ignored(p), true, p);
  for (const p of [".env.example", "src/env.ts", "id_rsa.pub", "README.md", "keys.ts"])
    assert.equal(ig.ignored(p), false, p);
});

test("gitignore syntax: anchors, folders, negation, comments", () => {
  const ig = new AgentIgnore([
    "# private things",
    "",
    "/secrets/",
    "*.log",
    "!keep.log",
    "build/**/cache",
    "docs/internal/*.md",
  ]);
  assert.equal(ig.size, 5);
  assert.equal(ig.ignored("secrets", true), true);
  assert.equal(ig.ignored("secrets/a.txt"), true);
  // Anchored: only at the top.
  assert.equal(ig.ignored("pkg/secrets/a.txt"), false);
  assert.equal(ig.ignored("a/b/debug.log"), true);
  assert.equal(ig.ignored("a/keep.log"), false);
  assert.equal(ig.ignored("build/x/y/cache/z.bin"), true);
  assert.equal(ig.ignored("docs/internal/plan.md"), true);
  assert.equal(ig.ignored("docs/plan.md"), false);
  // A folder-only rule doesn't hide a file of that name.
  assert.equal(new AgentIgnore(["tmp/"]).ignored("tmp"), false);
  assert.equal(new AgentIgnore(["tmp/"]).ignored("tmp/a"), true);
  // Files inside an excluded folder can't be brought back.
  assert.equal(new AgentIgnore(["private/", "!private/ok.txt"]).ignored("private/ok.txt"), true);
  assert.equal(parseIgnoreLine("   "), null);
  assert.equal(parseIgnoreLine("\\#literal")?.negate, false);
});

test("other spellings of an excluded file are excluded too (D199)", () => {
  const ig = new AgentIgnore(DEFAULT_AGENT_IGNORE);
  for (const p of [
    ".ENV",
    "Secrets.JSON",
    "KEYS/ID_RSA",
    ".env.",
    ".env ",
    ".env::$DATA",
    "a\\.env",
  ])
    assert.equal(ig.ignored(p), true, p);
  assert.equal(ig.ignored("src/main.ts"), false);
});

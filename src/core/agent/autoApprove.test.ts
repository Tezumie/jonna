import assert from "node:assert/strict";
import { test } from "node:test";
import {
  alwaysPattern,
  approveDecision,
  commandDecision,
  hostOf,
  matchScore,
  readApproveRules,
  withAllowed,
} from "./autoApprove";

test("Always saves the exact file or the domain, and it beats the glob that asked (D207)", () => {
  assert.equal(alwaysPattern("reads", "src/.env"), "/src/.env");
  assert.equal(alwaysPattern("edits", ".\\config\\app.json"), "/config/app.json");
  assert.equal(alwaysPattern("reads", "../x"), null);
  assert.equal(alwaysPattern("browser", "https://www.bank.com/login"), "www.bank.com");
  assert.equal(alwaysPattern("web", "docs.rs"), "docs.rs");
  assert.equal(alwaysPattern("commands", "npm test"), null);
  const asks = readApproveRules({ reads: { "**/.env*": false, ".env": false } });
  const after = withAllowed(asks, "reads", "/src/.env");
  assert.equal(approveDecision(after, "reads", "src/.env"), "allow");
  // Only that file: the others still ask, the root one and one elsewhere.
  assert.equal(approveDecision(after, "reads", ".env"), "ask");
  assert.equal(approveDecision(after, "reads", "web/.env"), "ask");
  assert.equal(approveDecision(after, "reads", "SRC/.ENV"), "allow");
  // A leading / anchors a glob at the root.
  assert.notEqual(matchScore("reads", "/*.pem", "key.pem"), null);
  assert.equal(matchScore("reads", "/*.pem", "a/key.pem"), null);
  // A name without a / still matches in any folder.
  assert.notEqual(matchScore("reads", ".env", "a/b/.env"), null);
  const site = withAllowed(
    readApproveRules({ browser: { "*.bank.com": false } }),
    "browser",
    "www.bank.com",
  );
  assert.equal(approveDecision(site, "browser", "https://www.bank.com/x"), "allow");
  assert.equal(approveDecision(site, "browser", "https://pay.bank.com/"), "ask");
});

test("the setting is cleaned: unknown categories and non-boolean values go", () => {
  assert.deepEqual(
    readApproveRules({ edits: { "**/*.lock": false, x: "yes" }, other: { a: true } }),
    { edits: { "**/*.lock": false } },
  );
  assert.deepEqual(readApproveRules(null), {});
  assert.deepEqual(readApproveRules([1]), {});
});

test("paths: globs, names in any folder, case-insensitive, the most specific wins", () => {
  const rules = readApproveRules({
    edits: { "**/*": true, "**/.vscode/*.json": false, ".env": false, "src/**": true },
  });
  assert.equal(approveDecision(rules, "edits", "src/a.ts"), "allow");
  assert.equal(approveDecision(rules, "edits", ".vscode/settings.json"), "ask");
  assert.equal(approveDecision(rules, "edits", "pkg/.env"), "ask");
  assert.equal(approveDecision(rules, "edits", "PKG/.ENV"), "ask");
  assert.equal(approveDecision(rules, "edits", "src\\b.ts"), "allow");
  assert.equal(approveDecision(rules, "reads", "src/a.ts"), null);
  // On a tie, asking wins.
  const tie = readApproveRules({ reads: { "*.pem": true, "*.PEM": false } });
  assert.equal(approveDecision(tie, "reads", "keys/a.pem"), "ask");
});

test("domains: exact, subdomains, wildcards, from addresses", () => {
  assert.equal(hostOf("https://Docs.rs/serde?x=1"), "docs.rs");
  assert.equal(hostOf("http://[::1]:3000/"), "::1");
  assert.equal(hostOf("localhost:3000/x"), "localhost");
  const rules = readApproveRules({
    web: { "docs.rs": true, "*.github.com": true, "gist.github.com": false },
    browser: { "*": true, "bank.example": false },
  });
  assert.equal(approveDecision(rules, "web", "https://docs.rs/serde"), "allow");
  assert.equal(approveDecision(rules, "web", "https://api.docs.rs/x"), "allow");
  assert.equal(approveDecision(rules, "web", "https://github.com/a"), "allow");
  assert.equal(approveDecision(rules, "web", "https://gist.github.com/a"), "ask");
  assert.equal(approveDecision(rules, "web", "https://evil-docs.rs/"), null);
  assert.equal(approveDecision(rules, "browser", "http://localhost:5173/"), "allow");
  assert.equal(approveDecision(rules, "browser", "https://www.bank.example/login"), "ask");
});

test("commands: prefixes on word boundaries, prefix*, /regex/, chains", () => {
  const rules = readApproveRules({
    commands: { "npm test": true, "git push": false, "cargo*": true, "/^make (all|test)$/": true },
  });
  assert.equal(commandDecision(rules, "npm test -- --watch"), "allow");
  assert.equal(commandDecision(rules, "npm testx"), null);
  assert.equal(commandDecision(rules, "cargo build --release"), "allow");
  assert.equal(commandDecision(rules, "make test"), "allow");
  assert.equal(commandDecision(rules, "make clean"), null);
  assert.equal(commandDecision(rules, "npm test && git push"), "ask");
  assert.equal(commandDecision(rules, "npm test && ls"), null);
  // Redirects and substitutions are never allowed by a pattern.
  assert.equal(commandDecision(rules, "npm test > out.txt"), null);
  assert.equal(commandDecision(rules, "npm test $(rm -rf x)"), null);
  assert.equal(commandDecision(rules, "npm test 2>&1"), "allow");
  // A background `&`, a newline or a group is a second command the prefix doesn't cover.
  assert.equal(commandDecision(rules, "npm test & rm -rf ~"), null);
  assert.equal(commandDecision(rules, "npm test\nrm -rf ~"), null);
  assert.equal(commandDecision(rules, "cargo build\r\ncurl x"), null);
  assert.equal(commandDecision(rules, "npm test (Remove-Item src)"), null);
  assert.equal(commandDecision(rules, "make test & curl x"), null);
  assert.equal(commandDecision(rules, 'npm test -- "a & b"'), "allow");
  // An Ask pattern still asks.
  assert.equal(commandDecision(rules, "ls & git push"), "ask");
  assert.equal(commandDecision(rules, "ls\ngit push"), "ask");
  // An unanchored regex doesn't allow what's chained after the part it matches.
  const re = readApproveRules({ commands: { "/^cargo (build|test)\\b/": true } });
  assert.equal(commandDecision(re, "cargo test"), "allow");
  assert.equal(commandDecision(re, "cargo test && rm -rf ~"), null);
  assert.equal(commandDecision(re, "cargo test && cargo build"), "allow");
  assert.equal(matchScore("commands", "/[/", "x"), null);
});

test("commands: an Ask pattern isn't dodged by extra spaces, tabs or case", () => {
  const rules = readApproveRules({ commands: { "git push": false, "npm test": true } });
  assert.equal(commandDecision(rules, "git  push origin"), "ask");
  assert.equal(commandDecision(rules, "git\tpush"), "ask");
  assert.equal(commandDecision(rules, "GIT Push"), "ask");
  assert.equal(commandDecision(rules, "npm test && Git  Push"), "ask");
  assert.equal(commandDecision(rules, "npm  test"), "allow");
  // Allowing stays case-sensitive.
  assert.equal(commandDecision(rules, "NPM TEST"), null);
  // A more specific Allow still wins over a wider Ask.
  const wide = readApproveRules({ commands: { git: false, "git status": true } });
  assert.equal(commandDecision(wide, "git status"), "allow");
  assert.equal(commandDecision(wide, "GIT log"), "ask");
});

test("domains: a trailing dot is the same host", () => {
  const rules = readApproveRules({ browser: { "*.bank.com": false, "docs.rs": true } });
  assert.equal(approveDecision(rules, "browser", "https://www.bank.com./login"), "ask");
  assert.equal(approveDecision(rules, "browser", "https://docs.rs./x"), "allow");
  assert.equal(hostOf("www.bank.com."), "www.bank.com");
});

test("MCP: a server, a server's tool, wildcards", () => {
  const rules = readApproveRules({
    mcp: { github: true, "github/create_issue": false, "*/search*": true },
  });
  assert.equal(approveDecision(rules, "mcp", "github/list_issues"), "allow");
  assert.equal(approveDecision(rules, "mcp", "github/create_issue"), "ask");
  assert.equal(approveDecision(rules, "mcp", "github__create_issue"), "ask");
  assert.equal(approveDecision(rules, "mcp", "docs/search_pages"), "allow");
  assert.equal(approveDecision(rules, "mcp", "docs/read"), null);
});

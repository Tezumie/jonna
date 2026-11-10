import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fieldsOf,
  frontMatterFor,
  frontMatterOf,
  newRule,
  parseSubagentField,
  renderSubagentRules,
  ruleMatchesRef,
  ruleScope,
  rulesForSubagent,
  scopesFor,
  setFrontMatter,
  subagentRulesForFile,
} from "./ruleEditing";
import { classifyRule, type LoadedRule, rulesForFile } from "./rules";
import { parseSubagentFile } from "./subagents";

const loaded = (path: string, text: string): LoadedRule => {
  const rule = classifyRule({ path, text });
  assert.ok(rule, path);
  return { ...rule, text: rule.body };
};

test("a subagent's reads get the folder and matching-files rules it may have (D207)", () => {
  const rules = [
    loaded("AGENTS.md", "Root"),
    loaded("web/AGENTS.md", "Web"),
    loaded(".cursor/rules/ts.mdc", "---\nglobs: *.ts\n---\nTS"),
    loaded(".cursor/rules/only-rev.mdc", "---\nglobs: *.ts\nsubagents: reviewer\n---\nR"),
    loaded(".cursor/rules/nobody.mdc", "---\nglobs: *.ts\nsubagents: none\n---\nN"),
  ];
  const covering = rulesForFile(rules, "web/a.ts");
  const paths = (def: Parameters<typeof rulesForSubagent>[1]) =>
    subagentRulesForFile(covering, rulesForSubagent(rules, def), def)
      .map((r) => r.path)
      .sort();
  assert.deepEqual(paths({ name: "general" }), [".cursor/rules/ts.mdc", "web/AGENTS.md"]);
  // The one naming the reviewer is in its prompt already: not attached again.
  assert.deepEqual(paths({ name: "reviewer" }), [".cursor/rules/ts.mdc", "web/AGENTS.md"]);
  // Omitting the project's rules: none, unless a rule names it.
  assert.deepEqual(paths({ name: "explore", omitRules: true }), []);
  assert.deepEqual(
    subagentRulesForFile(covering, [], { name: "reviewer", omitRules: true }).map((r) => r.path),
    [".cursor/rules/only-rev.mdc"],
  );
});

test("scope model: each activation has a scope, and each kind of file the scopes it can hold", () => {
  assert.equal(ruleScope(loaded("AGENTS.md", "x")), "always");
  assert.equal(ruleScope(loaded("pkg/AGENTS.md", "x")), "folder");
  assert.equal(ruleScope(loaded(".cursor/rules/a.mdc", "---\nglobs: *.ts\n---\nA")), "globs");
  assert.equal(
    ruleScope(loaded(".cursor/rules/a.mdc", "---\ndescription: When testing\n---\nA")),
    "description",
  );
  assert.equal(ruleScope(loaded(".cursor/rules/a.mdc", "A")), "manual");
  assert.deepEqual(scopesFor("cursor", ".cursor/rules/a.mdc"), [
    "always",
    "globs",
    "description",
    "manual",
  ]);
  assert.equal(scopesFor("cursor", "web/.cursor/rules/a.mdc")[0], "folder");
  assert.deepEqual(scopesFor("claudeRules", ".claude/rules/a.md"), ["always", "globs"]);
  assert.deepEqual(scopesFor("agents", "AGENTS.md"), []);
});

test("Claude Code's .claude/rules: paths globs, or always on", () => {
  const scoped = loaded(".claude/rules/api.md", '---\npaths: "src/api/**/*.ts"\n---\nAPI rules');
  assert.equal(scoped.source, "claudeRules");
  assert.equal(scoped.activation, "files");
  assert.deepEqual(scoped.globs, ["src/api/**/*.ts"]);
  assert.equal(scoped.body, "API rules");
  assert.equal(loaded(".claude/rules/all.md", "Always").activation, "always");
});

test("front matter is set and removed in place; the body and other keys stay", () => {
  const text = "---\ndescription: Old\nglobs:\n  - a.ts\n  - b.ts\nkeep: yes\n---\nBody\n";
  const next = setFrontMatter(text, { description: "New", globs: null, alwaysApply: "true" });
  assert.equal(next, "---\ndescription: New\nkeep: yes\nalwaysApply: true\n---\nBody\n");
  assert.equal(setFrontMatter("Body\n", { description: "D" }), "---\ndescription: D\n---\nBody\n");
  // Nothing left: no empty front matter.
  assert.equal(setFrontMatter("---\na: 1\n---\nBody", { a: null }), "Body");
  // Windows line ends stay.
  assert.equal(setFrontMatter("---\r\na: 1\r\n---\r\nB", { a: "2" }), "---\r\na: 2\r\n---\r\nB");
});

test("each kind of file says a scope its own way", () => {
  assert.deepEqual(frontMatterFor("cursor", { scope: "globs", globs: ["*.ts", "*.tsx"] }), {
    description: null,
    globs: "*.ts,*.tsx",
    alwaysApply: "false",
  });
  assert.equal(frontMatterFor("cursor", { scope: "always" }).alwaysApply, "true");
  assert.equal(frontMatterFor("instructions", { scope: "always" }).applyTo, '"**"');
  assert.equal(
    frontMatterFor("instructions", { scope: "globs", globs: ["**/*.py"] }).applyTo,
    '"**/*.py"',
  );
  assert.equal(frontMatterFor("claudeRules", { scope: "always" }).paths, null);
  assert.equal(frontMatterFor("cursor", { scope: "manual", subagents: [] }).subagents, "none");
  // A rewritten file reads back as what was set.
  for (const [source, path] of [
    ["cursor", ".cursor/rules/x.mdc"],
    ["instructions", ".github/instructions/x.instructions.md"],
    ["claudeRules", ".claude/rules/x.md"],
  ] as const) {
    const text = setFrontMatter(
      "Body\n",
      frontMatterFor(source, { scope: "globs", globs: ["src/**"] }),
    );
    const rule = loaded(path, text);
    assert.equal(ruleScope(rule), "globs", path);
    assert.deepEqual(rule.globs, ["src/**"], path);
  }
});

test("new rules from templates", () => {
  const cursor = newRule("cursor", "Testing Rules", {
    scope: "description",
    description: "When writing tests",
  });
  assert.equal(cursor.path, ".cursor/rules/testing-rules.mdc");
  assert.equal(loaded(cursor.path, cursor.text).activation, "requested");
  const nested = newRule("cursor", "web", { scope: "always", folder: "web" });
  assert.equal(nested.path, "web/.cursor/rules/web.mdc");
  assert.equal(loaded(nested.path, nested.text).activation, "folder");
  const copilot = newRule("copilot", "Python", { scope: "globs", globs: ["**/*.py"] });
  assert.equal(copilot.path, ".github/instructions/python.instructions.md");
  assert.deepEqual(loaded(copilot.path, copilot.text).globs, ["**/*.py"]);
  const claude = newRule("claude", "API", { scope: "globs", globs: ["src/api/**"] });
  assert.equal(claude.path, ".claude/rules/api.md");
  assert.equal(frontMatterOf(claude.text).paths, "src/api/**");
  const fresh = newRule("agents", "Style", { scope: "always", body: "Use tabs." }, null);
  assert.deepEqual(fresh, {
    path: "AGENTS.md",
    text: "# AGENTS.md\n\n## Style\n\nUse tabs.\n",
    append: false,
  });
  const section = newRule(
    "agents",
    "Tests",
    { scope: "always", body: "Run npm test." },
    "# Rules\nx",
  );
  assert.equal(section.append, true);
  assert.equal(section.text, "\n\n## Tests\n\nRun npm test.\n");
  assert.equal(newRule("agents", "x", { scope: "folder", folder: "pkg/" }).path, "pkg/AGENTS.md");
});

test("subagents: the default, names, none, and a definition's own list", () => {
  const rules = [
    loaded("AGENTS.md", "Root"),
    loaded(
      ".cursor/rules/tests.mdc",
      "---\nalwaysApply: false\nsubagents: reviewer, test-runner\n---\nT",
    ),
    loaded(".cursor/rules/main-only.mdc", "---\nalwaysApply: true\nsubagents: none\n---\nM"),
    loaded(".cursor/rules/style.mdc", "---\ndescription: Style guide\n---\nS"),
    loaded(".cursor/rules/everyone.mdc", "---\nsubagents: *\n---\nE"),
  ];
  // A subagent-only rule isn't in the main agent's prompt (manual for it).
  assert.equal(rules[1]?.activation, "manual");
  assert.deepEqual(rules[1]?.subagents, ["reviewer", "test-runner"]);
  assert.equal(rules[1]?.body, "T");
  const names = (def: Parameters<typeof rulesForSubagent>[1]) =>
    rulesForSubagent(rules, def).map((r) => r.path);
  assert.deepEqual(names({ name: "reviewer" }), [
    "AGENTS.md",
    ".cursor/rules/tests.mdc",
    ".cursor/rules/everyone.mdc",
  ]);
  assert.deepEqual(names({ name: "general" }), ["AGENTS.md", ".cursor/rules/everyone.mdc"]);
  assert.deepEqual(names({ name: "plan", omitRules: true }), [".cursor/rules/everyone.mdc"]);
  assert.deepEqual(names({ name: "docs", rules: ["style"], omitRules: true }), [
    ".cursor/rules/style.mdc",
    ".cursor/rules/everyone.mdc",
  ]);
  assert.ok(ruleMatchesRef({ path: ".github/instructions/py.instructions.md" }, "py"));
  assert.ok(!ruleMatchesRef({ path: "a/py.md" }, "b/py.md"));
  const text = renderSubagentRules(rulesForSubagent(rules, { name: "reviewer" }));
  assert.match(text, /--- AGENTS\.md ---\nRoot/);
  assert.equal(renderSubagentRules([]), "");
  assert.deepEqual(parseSubagentField(" none "), []);
  assert.deepEqual(parseSubagentField("all"), ["*"]);
  assert.deepEqual(parseSubagentField("a, b"), ["a", "b"]);
  assert.equal(parseSubagentField(""), undefined);
  assert.deepEqual(fieldsOf(rules[1] as LoadedRule).subagents, ["reviewer", "test-runner"]);
});

test("subagent files: rules to preload and omitClaudeMd", () => {
  const def = parseSubagentFile(
    "---\nname: docs\ndescription: Writes docs\nrules: [style, .cursor/rules/x.mdc]\nomitClaudeMd: true\n---\nWrite.",
    "project",
  );
  assert.deepEqual(def?.rules, ["style", ".cursor/rules/x.mdc"]);
  assert.equal(def?.omitRules, true);
  const plain = parseSubagentFile("---\nname: a\ndescription: b\n---\nx", "project");
  assert.equal(plain?.rules, undefined);
  assert.equal(plain?.omitRules, undefined);
});

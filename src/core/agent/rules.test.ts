import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyRule,
  expandImports,
  importRefs,
  type LoadedRule,
  nestedRuleFiles,
  parseFrontMatter,
  type Rule,
  renderAttachedRules,
  renderRulesPrompt,
  ruleCovers,
  ruleInFolder,
  rulesForFile,
  splitGlobs,
} from "./rules";

const loaded = (path: string, text: string, user = false): LoadedRule => {
  const rule = classifyRule({ path, text, user });
  assert.ok(rule, path);
  return { ...rule, text: rule.body };
};

test("front matter: values, quotes and YAML lists", () => {
  const { meta, body } = parseFrontMatter(
    '---\ndescription: "Testing rules"\nglobs:\n  - "src/**/*.ts"\n  - "*.tsx"\nalwaysApply: false\n---\nBody\n',
  );
  assert.equal(meta.description, "Testing rules");
  assert.equal(meta.globs, "src/**/*.ts,*.tsx");
  assert.equal(meta.alwaysapply, "false");
  assert.equal(body, "Body\n");
  assert.deepEqual(parseFrontMatter("no front matter").meta, {});
  assert.deepEqual(splitGlobs('["a/**", "*.md" ]'), ["a/**", "*.md"]);
  assert.deepEqual(splitGlobs("src/**, test/**"), ["src/**", "test/**"]);
  assert.deepEqual(splitGlobs(undefined), []);
});

test("classify: every kind of rules file", () => {
  assert.equal(classifyRule({ path: "AGENTS.md", text: "x" })?.activation, "always");
  const nested = classifyRule({ path: "packages/api/AGENTS.md", text: "x" });
  assert.equal(nested?.activation, "folder");
  assert.equal(nested?.folder, "packages/api");
  assert.equal(classifyRule({ path: "CLAUDE.md", text: "x" })?.source, "claude");
  assert.equal(classifyRule({ path: ".cursorrules", text: "x" })?.activation, "always");
  assert.equal(
    classifyRule({ path: ".github/copilot-instructions.md", text: "x" })?.source,
    "copilot",
  );
  const always = classifyRule({
    path: ".cursor/rules/a.mdc",
    text: "---\nalwaysApply: true\n---\nA",
  });
  assert.equal(always?.activation, "always");
  assert.equal(always?.body, "A");
  const globbed = classifyRule({ path: ".cursor/rules/b.mdc", text: "---\nglobs: *.ts\n---\nB" });
  assert.equal(globbed?.activation, "files");
  assert.deepEqual(globbed?.globs, ["*.ts"]);
  assert.equal(
    classifyRule({ path: ".cursor/rules/c.mdc", text: "---\ndescription: When testing\n---\nC" })
      ?.activation,
    "requested",
  );
  assert.equal(classifyRule({ path: ".cursor/rules/d.mdc", text: "D" })?.activation, "manual");
  const applyTo = classifyRule({
    path: ".github/instructions/ts.instructions.md",
    text: '---\napplyTo: "**/*.ts,**/*.tsx"\n---\nTS',
  });
  assert.equal(applyTo?.activation, "files");
  assert.deepEqual(applyTo?.globs, ["**/*.ts", "**/*.tsx"]);
  assert.equal(
    classifyRule({
      path: ".github/instructions/all.instructions.md",
      text: "---\napplyTo: '**'\n---\nX",
    })?.activation,
    "always",
  );
  assert.equal(
    classifyRule({ path: "/home/u/.config/ide/AGENTS.md", text: "U", user: true })?.source,
    "user",
  );
  assert.equal(classifyRule({ path: "README.md", text: "x" }), null);
});

test("rules for a file: folders cover what's under them, globs match anywhere without a slash", () => {
  const rules = [
    loaded("pkg/AGENTS.md", "pkg"),
    loaded("pkg/api/AGENTS.md", "api"),
    loaded(".cursor/rules/ts.mdc", "---\nglobs: *.ts\n---\nts"),
    loaded(".github/instructions/docs.instructions.md", "---\napplyTo: docs/**\n---\ndocs"),
  ];
  assert.deepEqual(
    rulesForFile(rules, "pkg/api/x.ts").map((r) => r.path),
    ["pkg/AGENTS.md", "pkg/api/AGENTS.md", ".cursor/rules/ts.mdc"],
  );
  assert.deepEqual(
    rulesForFile(rules, "docs/guide.md").map((r) => r.path),
    [".github/instructions/docs.instructions.md"],
  );
  assert.deepEqual(rulesForFile(rules, "pkgx/a.md"), []);
  assert.deepEqual(
    rulesForFile(rules, "pkg/AGENTS.md").map((r) => r.path),
    ["pkg/AGENTS.md"],
  );
});

test("a subfolder's .cursor/rules holds under that folder; subfolders of the rules folders (D203)", () => {
  const always = classifyRule({
    path: "web/.cursor/rules/style.mdc",
    text: "---\nalwaysApply: true\n---\nweb style",
  });
  assert.equal(always?.activation, "folder");
  assert.equal(always?.folder, "web");
  const rules = [
    loaded("web/.cursor/rules/style.mdc", "---\nalwaysApply: true\n---\nweb style"),
    loaded("web/.cursor/rules/tsx.mdc", "---\nglobs: src/**/*.tsx\n---\ntsx"),
    loaded("web/.cursor/rules/rooted.mdc", "---\nglobs: web/test/**\n---\nrooted"),
    loaded("web/.cursor/rules/how.mdc", "---\ndescription: Deploying\n---\nhow"),
    loaded(".cursor/rules/team/review.mdc", "---\nglobs: *.md\n---\nreview"),
    loaded(".github/instructions/py/py.instructions.md", "---\napplyTo: '**/*.py'\n---\npy"),
  ];
  assert.deepEqual(
    rulesForFile(rules, "web/src/a/App.tsx").map((r) => r.path),
    ["web/.cursor/rules/style.mdc", "web/.cursor/rules/tsx.mdc"],
  );
  assert.deepEqual(
    rulesForFile(rules, "web/test/x.ts").map((r) => r.path),
    ["web/.cursor/rules/style.mdc", "web/.cursor/rules/rooted.mdc"],
  );
  // Outside the folder: not even the glob matches (src/**/*.tsx is web's src).
  assert.deepEqual(rulesForFile(rules, "src/b/App.tsx"), []);
  assert.deepEqual(
    rulesForFile(rules, "notes/a.md").map((r) => r.path),
    [".cursor/rules/team/review.mdc"],
  );
  assert.deepEqual(
    rulesForFile(rules, "tools/x.py").map((r) => r.path),
    [".github/instructions/py/py.instructions.md"],
  );
  const prompt = renderRulesPrompt(rules);
  assert.match(prompt, /- web\/\.cursor\/rules\/how\.mdc: Deploying \(for files in web\/\)/);
  assert.match(prompt, /- web\/\.cursor\/rules\/tsx\.mdc \(for src\/\*\*\/\*\.tsx in web\/\)/);
  assert.doesNotMatch(prompt, /web style/);
  // Picking the files from an index lookup: the root folders' own files are listed elsewhere.
  assert.deepEqual(
    nestedRuleFiles(
      [
        ".cursor/rules/a.mdc",
        ".cursor/rules/team/b.mdc",
        "a/b/.cursor/rules/deep.mdc",
        "web/.cursor/rules/x.md",
        "web/.cursor/rulesx/y.mdc",
        ".github/instructions/ts.instructions.md",
        ".github/instructions/py/py.instructions.md",
        ".github/instructions/py/notes.md",
        "web/.github/instructions/w.instructions.md",
        "src/cursor/rules.ts",
        "web/.cursor/rules/x.md",
      ],
      3,
    ),
    [
      ".cursor/rules/team/b.mdc",
      ".github/instructions/py/py.instructions.md",
      "web/.cursor/rules/x.md",
    ],
  );
});

test("imports: @paths outside code, recursive, once each, to a depth limit", async () => {
  assert.deepEqual(importRefs("See @docs/a.md and @README.md, not @alice or `@x/y.md`."), [
    "docs/a.md",
    "README.md",
  ]);
  assert.deepEqual(importRefs("```\n@inside/code.md\n```\n(@~/notes.md)"), ["~/notes.md"]);
  const files: Record<string, string> = {
    "CLAUDE.md": "Main @a.md @b.md",
    "a.md": "A text @b.md",
    "b.md": "B text @CLAUDE.md",
  };
  const io = {
    resolve: (ref: string) => ref,
    read: async (path: string) => files[path] ?? null,
  };
  const out = await expandImports(files["CLAUDE.md"] ?? "", "CLAUDE.md", io);
  assert.deepEqual(out.imported, ["a.md", "b.md"]);
  assert.match(out.text, /Imported from @a\.md:\nA text/);
  assert.equal(out.text.match(/B text/g)?.length, 1);
  // A chain longer than the limit stops.
  const chain: Record<string, string> = {};
  for (let i = 0; i < 10; i++) chain[`f${i}.md`] = `level ${i} @f${i + 1}.md`;
  const deep = await expandImports(chain["f0.md"] ?? "", "f0.md", {
    resolve: (ref) => ref,
    read: async (p) => chain[p] ?? null,
  });
  assert.equal(deep.imported.length, 5);
});

test("prompt: always-on rules in full (duplicates once), others listed", () => {
  const text = renderRulesPrompt([
    loaded("AGENTS.md", "Use tabs."),
    loaded("CLAUDE.md", "Use tabs."),
    loaded(".cursorrules", "Answer like a pirate."),
    loaded("/cfg/AGENTS.md", "Call me Sam.", true),
    loaded("pkg/AGENTS.md", "pkg"),
    loaded(".cursor/rules/t.mdc", "---\ndescription: Testing\n---\nT"),
    loaded(".cursor/rules/m.mdc", "manual"),
  ]);
  assert.match(text, /^Your own rules \(AGENTS\.md/);
  assert.equal(text.match(/Use tabs\./g)?.length, 1);
  assert.match(text, /Project rules from \.cursorrules:\nAnswer like a pirate\./);
  assert.match(text, /- pkg\/AGENTS\.md \(for files in pkg\/\)/);
  assert.match(text, /- \.cursor\/rules\/t\.mdc: Testing/);
  assert.doesNotMatch(text, /m\.mdc/);
  assert.equal(renderRulesPrompt([]), "");
  const attached = renderAttachedRules([loaded("pkg/AGENTS.md", "pkg rule")], "pkg/x.ts");
  assert.match(attached, /<rules for="pkg\/x\.ts">/);
  assert.match(attached, /pkg rule/);
  assert.equal(renderAttachedRules([], "x"), "");
});

test("another folder's rules: named with the folder, covering only it", () => {
  const root = ruleInFolder(classifyRule({ path: "AGENTS.md", text: "Use tabs." }) as Rule, "api");
  assert.equal(root.path, "api/AGENTS.md");
  assert.equal(root.activation, "always");
  assert.equal(root.folder, undefined);
  assert.match(renderRulesPrompt([{ ...root, text: root.body }]), /from api\/AGENTS\.md:/);
  const nested = ruleInFolder(classifyRule({ path: "pkg/AGENTS.md", text: "pkg" }) as Rule, "api");
  assert.equal(nested.folder, "api/pkg");
  assert.equal(ruleCovers(nested, "api/pkg/x.ts"), true);
  assert.equal(ruleCovers(nested, "pkg/x.ts"), false);
  const globbed = ruleInFolder(
    classifyRule({
      path: ".cursor/rules/ts.mdc",
      text: "---\nglobs: *.ts\n---\nTS",
    }) as Rule,
    "api",
  );
  assert.equal(globbed.activation, "files");
  assert.equal(ruleCovers(globbed, "api/src/x.ts"), true);
  assert.equal(ruleCovers(globbed, "web/src/x.ts"), false);
  assert.equal(ruleCovers(globbed, "src/x.ts"), false);
  const cursorrules = ruleInFolder(
    classifyRule({ path: ".cursorrules", text: "Pirate." }) as Rule,
    "api",
  );
  assert.match(
    renderRulesPrompt([{ ...cursorrules, text: "Pirate." }]),
    /from api\/\.cursorrules:/,
  );
  const user = classifyRule({ path: "/cfg/AGENTS.md", text: "Sam", user: true }) as Rule;
  assert.equal(ruleInFolder(user, "api"), user);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESCRIPTION_LIMIT,
  type FoundSkill,
  isValidSkillName,
  mergeSkills,
  modelSkills,
  nestedSkillDirs,
  parseSkillFile,
  parseSkillFrontMatter,
  renderFileSkills,
  renderForkedSkillTask,
  renderForkInvocation,
  renderSkillForAgent,
  renderSkillInvocation,
  renderSkillsPrompt,
  skillCoversFile,
  skillFileRel,
  skillsForFile,
  skillsUsedIn,
  skillTemplate,
  slugSkillName,
  upFrontSkills,
  withNestedSkills,
} from "./skills";

const found = (
  name: string,
  scope: "user" | "workspace",
  source: string,
  extra: Partial<FoundSkill> = {},
): FoundSkill => ({
  name,
  description: `${name} things`,
  disableModelInvocation: false,
  userInvocable: true,
  allowedTools: [],
  paths: [],
  fork: false,
  body: `# ${name}`,
  scope,
  source,
  dir: `/x/${source}/${name}`,
  file: `/x/${source}/${name}/SKILL.md`,
  warnings: [],
  ...extra,
});

test("front matter: plain, quoted, block scalars, lists, nested maps", () => {
  const parsed = parseSkillFrontMatter(
    [
      "---",
      "name: pdf-tools",
      'description: "Fill PDF forms: when asked about PDFs"',
      "when_to_use: >",
      "  Use it when the user",
      "  mentions a form.",
      "",
      "  Second paragraph.",
      "notes: |",
      "  line one",
      "  line two",
      "allowed-tools:",
      "  - Read",
      "  - Bash(python *)",
      "paths: [src/**/*.pdf, docs/*.pdf]",
      "metadata:",
      "  author: someone",
      "  version: 1",
      "disable-model-invocation: true # comment",
      "---",
      "# Body",
    ].join("\n"),
  );
  assert.ok(parsed);
  assert.equal(parsed.meta.name, "pdf-tools");
  assert.equal(parsed.meta.description, "Fill PDF forms: when asked about PDFs");
  assert.equal(parsed.meta.when_to_use, "Use it when the user mentions a form.\nSecond paragraph.");
  assert.equal(parsed.meta.notes, "line one\nline two");
  assert.deepEqual(parsed.meta["allowed-tools"], ["Read", "Bash(python *)"]);
  assert.deepEqual(parsed.meta.paths, ["src/**/*.pdf", "docs/*.pdf"]);
  assert.equal(parsed.meta.metadata, undefined);
  assert.equal(parsed.meta["disable-model-invocation"], "true");
  assert.equal(parsed.body, "# Body");
});

test("front matter: a plain value continued on the next lines, CRLF, BOM, none", () => {
  const parsed = parseSkillFrontMatter(
    "\uFEFF---\r\nname: a\r\ndescription: one\r\n  two\r\n---\r\nbody\r\n",
  );
  assert.equal(parsed?.meta.description, "one two");
  assert.equal(parsed?.body, "body\r\n");
  assert.equal(parseSkillFrontMatter("# no front matter"), null);
});

test("parseSkillFile: fields, defaults, the folder's name", () => {
  const r = parseSkillFile(
    "---\ndescription: Deploys\nargument-hint: [env]\nuser-invocable: false\nallowed-tools: Read, Bash(git status:*)\nmodel: sonnet\n---\n\nSteps\n",
    "deploy",
  );
  assert.equal(r.error, undefined);
  assert.equal(r.skill?.name, "deploy");
  assert.equal(r.skill?.description, "Deploys");
  assert.equal(r.skill?.argumentHint, "[env]");
  assert.equal(r.skill?.userInvocable, false);
  assert.equal(r.skill?.disableModelInvocation, false);
  assert.deepEqual(r.skill?.allowedTools, ["Read", "Bash(git status:*)"]);
  assert.equal(r.skill?.model, "sonnet");
  assert.equal(r.skill?.body, "Steps");
  assert.deepEqual(r.warnings, []);
});

test("parseSkillFile: invalid files say why; a differing name is a warning", () => {
  assert.match(parseSkillFile("no front matter", "x").error ?? "", /No front matter/);
  assert.match(parseSkillFile("---\nname: x\n---\n", "x").error ?? "", /No description/);
  assert.match(
    parseSkillFile("---\nname: Bad Name\ndescription: d\n---\n", "x").error ?? "",
    /isn't valid/,
  );
  const r = parseSkillFile("---\nname: other\ndescription: d\n---\n", "folder");
  assert.equal(r.skill?.name, "other");
  assert.match(r.warnings[0] ?? "", /differs/);
  const long = parseSkillFile(`---\ndescription: ${"a".repeat(2000)}\n---\n`, "long");
  assert.equal(long.skill?.description.length, DESCRIPTION_LIMIT);
  assert.equal(long.warnings.length, 1);
  const when = parseSkillFile("---\ndescription: Does x.\nwhen_to_use: Say x.\n---\n", "w");
  assert.equal(when.skill?.description, "Does x. Say x.");
  const globs = parseSkillFile("---\ndescription: d\nglobs: '*.ts'\n---\n", "g");
  assert.deepEqual(globs.skill?.paths, ["*.ts"]);
});

test("names: valid ones and slugs", () => {
  assert.ok(isValidSkillName("a-b-1"));
  assert.ok(!isValidSkillName("A"));
  assert.ok(!isValidSkillName("a--b"));
  assert.ok(!isValidSkillName("-a"));
  assert.ok(!isValidSkillName("a".repeat(65)));
  assert.equal(slugSkillName("  Deploy The App! "), "deploy-the-app");
  assert.equal(slugSkillName("***"), "");
});

test("mergeSkills: workspace overrides user, first folder wins within a scope", () => {
  const { skills, shadowed } = mergeSkills([
    found("review", "user", "~/.claude/skills"),
    found("review", "user", "~/.cursor/skills"),
    found("only-user", "user", "~/.cursor/skills"),
    found("review", "workspace", ".claude/skills"),
    found("deploy", "workspace", ".cursor/skills"),
    found("deploy", "workspace", ".claude/skills"),
  ]);
  assert.deepEqual(
    skills.map((s) => `${s.scope}:${s.name}:${s.source}`),
    [
      "user:only-user:~/.cursor/skills",
      "workspace:deploy:.cursor/skills",
      "workspace:review:.claude/skills",
    ],
  );
  assert.deepEqual(shadowed.map((s) => `${s.name}:${s.source}`).sort(), [
    "deploy:.claude/skills",
    "review:~/.claude/skills",
    "review:~/.cursor/skills",
  ]);
});

test("the prompt lists what the model may use, the tool result has the files", () => {
  const all = [
    found("a", "user", "~/.claude/skills"),
    found("b", "workspace", ".claude/skills", { disableModelInvocation: true }),
    found("c", "workspace", ".claude/skills", { paths: ["*.ts"] }),
  ];
  const usable = modelSkills(all, new Set(["a"]));
  assert.deepEqual(
    usable.map((s) => s.name),
    ["c"],
  );
  const prompt = renderSkillsPrompt(usable, (s) => `${s.source}/${s.name}/SKILL.md`);
  assert.match(prompt, /use_skill/);
  assert.match(
    prompt,
    /- c: c things \(for files matching \*\.ts\) \[\.claude\/skills\/c\/SKILL\.md\]/,
  );
  assert.equal(
    renderSkillsPrompt([], () => ""),
    "",
  );
  const skill = found("c", "workspace", ".claude/skills", {
    body: `Run ${"$"}{CLAUDE_SKILL_DIR}/scripts/x.sh`,
    allowedTools: ["Bash"],
  });
  const text = renderSkillForAgent(skill, ["SKILL.md", "ref.md", "scripts/x.sh"], "with read_file");
  assert.match(text, /Run \/x\/\.claude\/skills\/c\/scripts\/x\.sh/);
  assert.match(text, /- ref\.md\n- scripts\/x\.sh/);
  assert.doesNotMatch(text, /- SKILL\.md/);
  assert.match(text, /allowed-tools: Bash/);
  const run = renderSkillInvocation(
    found("d", "user", "u", { body: "Fix $ARGUMENTS" }),
    "it",
    [],
    "",
  );
  assert.match(run, /The user ran the skill \/d/);
  assert.match(run, /Fix it/);
});

test("skillFileRel keeps reads inside the folder", () => {
  assert.equal(skillFileRel("./ref/a.md"), "ref/a.md");
  assert.equal(skillFileRel("ref\\a.md"), "ref/a.md");
  assert.equal(skillFileRel("../x"), null);
  assert.equal(skillFileRel("a/../../x"), null);
  assert.equal(skillFileRel("/etc/passwd"), null);
  assert.equal(skillFileRel("C:/x"), null);
  assert.equal(skillFileRel(""), null);
});

test("the template", () => {
  const t = skillTemplate("my-skill");
  const r = parseSkillFile(t, "my-skill");
  assert.equal(r.skill?.name, "my-skill");
  assert.equal(r.skill?.description, "Describe when Agent should use this skill.");
  assert.match(t, /# my-skill\n\nDescribe the workflow and knowledge this skill provides\.\n$/);
});

test("D221 fields: context fork, agent, effort (and what isn't known)", () => {
  const r = parseSkillFile(
    "---\nname: audit\ndescription: Audit deps\ncontext: fork\nagent: explore\neffort: High\nmodel: haiku\n---\nAudit $ARGUMENTS",
    "audit",
  );
  assert.equal(r.skill?.fork, true);
  assert.equal(r.skill?.agent, "explore");
  assert.equal(r.skill?.effort, "high");
  assert.equal(r.skill?.model, "haiku");
  const odd = parseSkillFile("---\ndescription: x\ncontext: thread\neffort: huge\n---\nx", "odd");
  assert.equal(odd.skill?.fork, false);
  assert.equal(odd.skill?.effort, undefined);
  assert.equal(odd.warnings.length, 2);
  assert.equal(parseSkillFile("---\ndescription: x\n---\nx", "p").skill?.fork, false);
});

test("skills for a file: paths and nested folders, offered once (D221)", () => {
  const ts = found("ts-style", "workspace", ".claude/skills", { paths: ["*.ts"] });
  const docs = found("docs", "user", "~/.claude/skills", { paths: ["docs/**"] });
  const web = found("web-deploy", "workspace", "packages/web/.claude/skills", {
    nested: "packages/web",
  });
  const webCss = found("web-css", "workspace", "packages/web/.claude/skills", {
    nested: "packages/web",
    paths: ["*.css"],
  });
  const always = found("always", "user", "~/.claude/skills");
  const all = [ts, docs, web, webCss, always];
  // Up front: only the ones for everything, not nested or path-bound ones.
  assert.deepEqual(
    upFrontSkills(all).map((s) => s.name),
    ["always"],
  );
  assert.ok(skillCoversFile(ts, "src/a.ts"));
  assert.ok(!skillCoversFile(ts, "src/a.js"));
  assert.ok(skillCoversFile(docs, "docs/guide/a.md"));
  assert.ok(!skillCoversFile(docs, "src/docs/a.md"));
  assert.ok(skillCoversFile(web, "packages/web/src/app.tsx"));
  assert.ok(!skillCoversFile(web, "packages/api/src/app.ts"));
  assert.ok(skillCoversFile(webCss, "packages/web/a/b.css"));
  assert.ok(!skillCoversFile(webCss, "packages/web/a/b.ts"));
  assert.ok(!skillCoversFile(always, "anything.ts"));
  assert.deepEqual(
    skillsForFile(all, "packages/web/src/x.ts", new Set()).map((s) => s.name),
    ["ts-style", "web-deploy"],
  );
  assert.deepEqual(
    skillsForFile(all, "packages/web/src/x.ts", new Set(["ts-style"])).map((s) => s.name),
    ["web-deploy"],
  );
  const note = renderFileSkills([web], "packages/web/src/x.ts");
  assert.match(note, /Skills for packages\/web\/src\/x\.ts/);
  assert.match(note, /- web-deploy: web-deploy things/);
  assert.match(note, /use_skill/);
  assert.equal(renderFileSkills([], "a"), "");
});

test("nested skills folders between a file and the root (D221)", () => {
  assert.deepEqual(nestedSkillDirs("packages/web/src/a.ts", [".claude/skills"]), [
    "packages/web/src/.claude/skills",
    "packages/web/.claude/skills",
    "packages/.claude/skills",
  ]);
  assert.deepEqual(nestedSkillDirs("a.ts", [".claude/skills"]), []);
  // Not inside dependencies or a skills folder itself.
  assert.deepEqual(nestedSkillDirs("node_modules/x/a.js", [".claude/skills"]), []);
  assert.deepEqual(nestedSkillDirs(".claude/skills/a/SKILL.md", [".claude/skills"]), [
    ".claude/.claude/skills",
  ]);
  assert.deepEqual(nestedSkillDirs("app\\src\\a.ts", ["s1", "s2"]), [
    "app/src/s1",
    "app/src/s2",
    "app/s1",
    "app/s2",
  ]);
});

test("forked skills, pre-approval notes and skills used before a summary (D221)", () => {
  const fork = found("audit", "user", "~/.claude/skills", {
    fork: true,
    body: "Audit $ARGUMENTS",
  });
  const run = renderForkInvocation(fork, "the deps");
  assert.match(run, /The user ran the skill \/audit/);
  assert.match(run, /"name":"audit","arguments":"the deps"/);
  const task = renderForkedSkillTask(fork, "the deps", ["SKILL.md", "ref.md"], "with use_skill");
  assert.match(task, /Carry out the skill audit/);
  assert.match(task, /Audit the deps/);
  assert.match(task, /- ref\.md/);
  const mine = found("m", "user", "u", { allowedTools: ["Bash(npm test)"] });
  assert.match(renderSkillForAgent(mine, [], ""), /run without asking for the rest of this turn/);
  const theirs = found("t", "workspace", "w", { allowedTools: ["Bash(npm test)"] });
  assert.match(renderSkillForAgent(theirs, [], ""), /can't pre-approve tools/);
  assert.deepEqual(
    skillsUsedIn([
      { type: "tool", name: "use_skill", status: "done", args: { name: "a" } },
      { type: "tool", name: "use_skill", status: "error", args: { name: "b" } },
      { type: "user", context: ["The user ran the skill /c (x). Follow it:"] },
      { type: "tool", name: "use_skill", status: "done", args: { name: "/a" } },
      { type: "assistant" },
    ]),
    ["a", "c"],
  );
});

test("a nested skill whose name is taken gets its folder in front (D229, Claude Code's)", () => {
  const root = found("deploy", "workspace", ".claude/skills");
  const web = found("deploy", "workspace", ".claude/skills", { nested: "apps/web" });
  const api = found("lint", "workspace", ".claude/skills", { nested: "apps/api" });
  const again = found("deploy", "workspace", ".claude/skills", { nested: "apps/web" });
  assert.deepEqual(
    withNestedSkills([root], [web, api, again]).map((s) => s.name),
    ["deploy", "apps/web:deploy", "lint"],
  );
  assert.deepEqual(
    skillsUsedIn([{ type: "user", context: ["The user ran the skill /apps/web:deploy (x)"] }]),
    ["apps/web:deploy"],
  );
});

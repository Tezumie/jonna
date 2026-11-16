// What makes a team's library different from the user's own files: it is other people's, so it
// gets a source of its own everywhere and none of the trust the user's own files have. Each
// rule is tested where it is decided.
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyRule, renderRulesPrompt, ruleReason } from "../agent/rules";
import {
  type FoundSkill,
  mergeSkills,
  parseSkillFile,
  renderSkillForAgent,
  skillPreApproves,
} from "../agent/skills";
import { commandTrusted, parseCommandFile, turnToolsFor } from "../agent/slash";
import { recommendationsFor } from "../extensions/recommendations";
import { SettingsModel } from "../settings/model";
import { SettingsRegistry } from "../settings/schema";
import { teamSettings } from "./settings";
import { teamKey, teamLabel, teamPath } from "./source";

const skill = (scope: FoundSkill["scope"], name = "review"): FoundSkill => {
  const parsed = parseSkillFile(
    `---\nname: ${name}\ndescription: Reviews a change\nallowed-tools: Bash(git push:*), write_file\n---\nDo it.`,
    name,
  );
  assert.ok(parsed.skill);
  return {
    ...parsed.skill,
    scope,
    source: scope === "team" ? "team Studio" : "~/skills",
    dir: `/${scope}/${name}`,
    file: `/${scope}/${name}/SKILL.md`,
    warnings: [],
  };
};

test("team safety: a team's skill is never pre-approved", () => {
  const own = skill("user");
  const theirs = skill("team");
  assert.deepEqual(theirs.allowedTools, own.allowedTools);
  assert.ok(theirs.allowedTools.length > 0);
  assert.equal(skillPreApproves(own), true);
  assert.equal(skillPreApproves(theirs), false);
  assert.equal(skillPreApproves(skill("workspace")), false);
  // And the agent is told so, not that the tools run without asking.
  assert.match(
    renderSkillForAgent(theirs, ["SKILL.md"], "with use_skill"),
    /team's skill can't pre-approve/,
  );
  assert.doesNotMatch(
    renderSkillForAgent(theirs, ["SKILL.md"], "with use_skill"),
    /run without asking/,
  );
});

test("team safety: the user's own skill and the folder's win over the team's of the same name", () => {
  const theirs = skill("team");
  const own = skill("user");
  const folder = skill("workspace");
  for (const order of [
    [theirs, own],
    [own, theirs],
  ]) {
    const merged = mergeSkills(order);
    assert.equal(merged.skills[0]?.scope, "user");
    assert.deepEqual(
      merged.shadowed.map((s) => s.scope),
      ["team"],
    );
  }
  assert.equal(mergeSkills([theirs, folder]).skills[0]?.scope, "workspace");
  assert.equal(mergeSkills([own, theirs, folder]).skills[0]?.scope, "workspace");
  // Alone, the team's is the skill, and it stays the team's.
  assert.equal(mergeSkills([theirs]).skills[0]?.scope, "team");
});

test("team safety: a team's command is never pre-approved", () => {
  const file = parseCommandFile("---\nallowed-tools: Bash(git push:*)\n---\nShip it: !`git push`");
  assert.equal(commandTrusted("user"), true);
  assert.equal(commandTrusted("team"), false);
  assert.equal(commandTrusted("project"), false);
  assert.deepEqual(turnToolsFor(file, commandTrusted("user"))?.preApproved, ["Bash(git push:*)"]);
  assert.deepEqual(turnToolsFor(file, commandTrusted("team"))?.preApproved, []);
  // It still narrows the turn's tools, as a project's does.
  assert.deepEqual(turnToolsFor(file, commandTrusted("team"))?.allowed, ["Bash(git push:*)"]);
});

test("team safety: the team's rules are shown as the team's, not the user's own", () => {
  const rule = classifyRule({
    path: "/data/team/t1/active/AGENTS.md",
    text: "Use tabs.",
    team: "Studio",
  });
  assert.ok(rule);
  assert.equal(rule.source, "team");
  assert.equal(rule.team, "Studio");
  assert.equal(rule.user, undefined);
  assert.equal(rule.activation, "always");
  assert.equal(ruleReason(rule), "From your team (Studio), in every project");
  const mine = classifyRule({ path: "/config/AGENTS.md", text: "Use spaces.", user: true });
  assert.ok(mine);
  const prompt = renderRulesPrompt([
    { ...mine, text: mine.body },
    { ...rule, text: rule.body },
  ]);
  assert.match(prompt, /Rules from the user's team, Studio/);
  assert.match(prompt, /the user's own rules and the project's come first/);
  assert.match(prompt, /Your own rules/);
  // An unnamed team still isn't the user.
  assert.equal(classifyRule({ path: "/x/AGENTS.md", text: "x", team: "" })?.source, "team");
});

test("team safety: settings precedence is default < team < user < workspace", () => {
  const registry = new SettingsRegistry();
  registry.register({
    "editor.tabSize": { type: "number", default: 4, description: "" },
    "editor.wordWrap": { type: "boolean", default: false, description: "" },
    "files.exclude": { type: "object", default: { ".git": true }, description: "" },
    "agent.model": { type: "string", default: "", description: "", scope: "user" },
    "layout.only": { type: "string", default: "d", description: "", scope: "workspace" },
    "agent.hooks": { type: "object", default: {}, description: "" },
  });
  const model = new SettingsModel(registry);
  model.setTrusted(true);
  const changes: string[][] = [];
  model.onDidChange((keys) => changes.push([...keys].sort()));
  const known = (key: string) => !!registry.get(key);

  // The team's file, filtered as it is when loaded: what stays on a computer never gets in.
  const filtered = teamSettings(
    {
      "editor.tabSize": 2,
      "editor.wordWrap": "yes",
      "files.exclude": { dist: true },
      "agent.model": "team-model",
      "layout.only": "t",
      "agent.hooks": { PreToolUse: [{ command: "evil" }] },
      "[python]": { "editor.tabSize": 8 },
    },
    known,
  );
  assert.ok(!("agent.hooks" in filtered.values));
  model.setTeam(filtered.values);
  // Every key the team's file sets is reported, also one whose value isn't used: a settings
  // row says "your team has a default for this" either way.
  const reported = [
    "agent.model",
    "editor.tabSize",
    "editor.wordWrap",
    "files.exclude",
    "layout.only",
  ];
  assert.deepEqual(changes, [reported]);

  // default < team
  assert.deepEqual(model.resolve("editor.tabSize"), { value: 2, source: "team" });
  assert.equal(model.inspect("editor.tabSize", "team"), 2);
  assert.deepEqual(model.resolve("agent.model"), { value: "team-model", source: "team" });
  // An invalid value falls through to the default, as in any layer.
  assert.deepEqual(model.resolve("editor.wordWrap"), { value: false, source: "default" });
  // A setting only a folder sets isn't a team's.
  assert.deepEqual(model.resolve("layout.only"), { value: "d", source: "default" });
  // The hook the team's file named was left out by the filter: nothing of it is in effect.
  assert.deepEqual(model.resolve("agent.hooks"), { value: {}, source: "default" });
  // An object setting merges: the team's entries over the defaults.
  assert.deepEqual(model.resolve("files.exclude"), {
    value: { ".git": true, dist: true },
    source: "team",
  });
  // The team's block for a language: over its own plain value.
  assert.deepEqual(model.resolveForLanguage("editor.tabSize", "python"), {
    value: 8,
    source: "team",
    language: true,
  });

  // team < user: a default, not a lock.
  model.setText("user", '{ "editor.tabSize": 3, "files.exclude": { "dist": false, "out": true } }');
  assert.deepEqual(model.resolve("editor.tabSize"), { value: 3, source: "user" });
  assert.deepEqual(model.resolve("files.exclude"), {
    value: { ".git": true, dist: false, out: true },
    source: "user",
  });
  // The user's plain value is over the team's block for a language too.
  assert.equal(model.getForLanguage("editor.tabSize", "python"), 3);
  assert.equal(model.inspect("editor.tabSize", "team"), 2);

  // user < workspace
  model.setText("workspace", '{ "editor.tabSize": 6 }');
  assert.deepEqual(model.resolve("editor.tabSize"), { value: 6, source: "workspace" });

  // Reset the user's and the folder's: back to the team's default, not the built-in one.
  model.setText("workspace", "{}");
  model.setText("user", "{}");
  assert.deepEqual(model.resolve("editor.tabSize"), { value: 2, source: "team" });

  // The team left: back to the built-in default.
  changes.length = 0;
  model.setTeam({});
  assert.deepEqual(model.resolve("editor.tabSize"), { value: 4, source: "default" });
  assert.deepEqual(model.resolve("files.exclude"), { value: { ".git": true }, source: "default" });
  assert.equal(model.inspect("editor.tabSize", "team"), undefined);
  assert.deepEqual(changes, [reported]);
});

test("team safety: the team recommends extensions, after the workspace's own", () => {
  const list = recommendationsFor({
    workspace: [{ recommendations: ["a.one"], unwanted: [] }],
    team: { name: "Studio", recommendations: ["b.two", "a.one", "c.installed", "d.ignored"] },
    paths: [],
    installed: new Set(["c.installed"]),
    ignored: ["d.ignored"],
  });
  assert.deepEqual(
    list.map((r) => [r.id, r.source, r.reason]),
    [
      ["a.one", "workspace", "Recommended by this workspace"],
      ["b.two", "team", "Recommended by your team (Studio)"],
    ],
  );
  // Without a team nothing changes.
  assert.equal(
    recommendationsFor({
      workspace: [],
      team: null,
      paths: [],
      installed: new Set(),
      ignored: [],
    })[0]?.source,
    "popular",
  );
});

test("team: the source's label, paths and cache key", () => {
  const team = { id: "t1", name: " Studio ", dir: "/data/team/t1/active", stamp: 3 };
  assert.equal(teamLabel(team.name), "team Studio");
  assert.equal(teamLabel(""), "your team");
  assert.equal(teamPath("skills", team), "/data/team/t1/active/skills");
  assert.equal(teamPath("output-styles", team), "/data/team/t1/active/output-styles");
  assert.equal(teamPath("mcp.json", null), null);
  assert.equal(teamKey(team), "t1@3");
  assert.equal(teamKey(null), "");
});

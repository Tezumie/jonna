import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionsForTeam, publishPath, skillFiles, skillFolderOf } from "./publish";

test("team publish: the name an item is published under", () => {
  // The kinds that are one file have one name, whatever was given.
  assert.equal(publishPath("rules", undefined), "AGENTS.md");
  assert.equal(publishPath("mcp", "secrets.json"), "mcp.json");
  assert.equal(publishPath("settings", undefined), "settings.json");
  assert.equal(publishPath("extensions", "x"), "extensions.json");
  assert.equal(publishPath("commands", "commands/ship.md"), "commands/ship.md");
  assert.equal(publishPath("skills", "skills/review/"), "skills/review");
  assert.equal(publishPath("skills", "skills/review/SKILL.md"), "skills/review/SKILL.md");
  assert.throws(() => publishPath("commands", undefined), /Give `path`/);
  assert.throws(() => publishPath("commands", "../settings.json"), /isn't a name/);
  assert.throws(() => publishPath("commands", "agents/x.md"), /isn't a name/);
  assert.throws(() => publishPath("agents", "agents/secrets.json"), /isn't a name/);
  assert.equal(skillFolderOf("skills/review"), "review");
  assert.equal(skillFolderOf("skills/review/SKILL.md"), null);
  assert.equal(skillFolderOf("commands/review"), null);
});

test("team publish: a skill is its files, the SKILL.md first", () => {
  const mine = [
    "keybindings.json",
    "skills/review/scripts/run.py",
    "skills/review/SKILL.md",
    "skills/review/notes.md",
    "skills/review/a/b/c/d/too-deep.md",
    "skills/reviewer/SKILL.md",
  ];
  assert.deepEqual(skillFiles(mine, "review"), {
    paths: ["skills/review/SKILL.md", "skills/review/notes.md", "skills/review/scripts/run.py"],
    skipped: ["skills/review/a/b/c/d/too-deep.md"],
  });
  assert.throws(() => skillFiles(mine, "missing"), /no skill named missing/);
});

test("team publish: recommended extensions are ids, each once", () => {
  const made = extensionsForTeam([
    "esbenp.prettier-vscode",
    " biomejs.biome ",
    "esbenp.prettier-vscode",
    "not an id",
    "",
  ]);
  assert.deepEqual(made.recommendations, ["esbenp.prettier-vscode", "biomejs.biome"]);
  assert.deepEqual(made.refused, ["not an id"]);
  assert.deepEqual(JSON.parse(made.text), {
    recommendations: ["esbenp.prettier-vscode", "biomejs.biome"],
  });
});

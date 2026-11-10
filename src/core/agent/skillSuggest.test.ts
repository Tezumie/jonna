// D342: suggest_skill's search, card and once-per-conversation rule.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Item } from "./conversation";
import {
  type AvailableSkill,
  keywordsOf,
  noSkillResult,
  parseSkillSuggestion,
  rankSkills,
  skillScore,
  skillSuggestionRefusal,
  skillSuggestionResult,
  stem,
} from "./skillSuggest";
import { parseSkillFile } from "./skills";

const skills: AvailableSkill[] = [
  {
    name: "review-checklist",
    description: "Review a change against a checklist: correctness, edge cases, tests.",
    source: "catalog",
    tags: ["code review", "playbook", "pull request"],
  },
  {
    name: "release-notes",
    description: "Draft release notes from the commits since the last tag, in a house style.",
    source: "catalog",
    tags: ["changelog"],
  },
  {
    name: "my-review",
    description: "The team's own review rules.",
    source: "off",
    where: "~/.claude/skills",
  },
];

test("keywords: stems, stop words dropped, at most eight", () => {
  assert.equal(stem("reviews"), "review");
  assert.equal(stem("reviewing"), "review");
  assert.equal(stem("libraries"), "library");
  assert.equal(stem("class"), "class");
  assert.deepEqual(keywordsOf(["Code reviews", "the playbook"]), ["code", "review", "playbook"]);
  assert.deepEqual(keywordsOf("release notes"), ["release", "note"]);
  assert.deepEqual(keywordsOf(42), []);
  assert.equal(keywordsOf("a b c d e f g h i j k".split(" ").map((x) => `${x}x`)).length, 8);
});

test("ranking: name beats tag beats description; catalog wins a tie", () => {
  const review = rankSkills(skills, keywordsOf(["review"]));
  // Both have "review" in their name: the catalog one first.
  assert.deepEqual(
    review.map((s) => s.name),
    ["review-checklist", "my-review"],
  );
  assert.deepEqual(
    rankSkills(skills, keywordsOf(["changelog"])).map((s) => s.name),
    ["release-notes"],
  );
  const notes = skills[1] as AvailableSkill;
  assert.ok(skillScore(notes, ["release"]) > skillScore(notes, ["house"]));
  assert.deepEqual(rankSkills(skills, keywordsOf(["kubernetes"])), []);
  // A prefix of a description word counts a little, not enough on its own.
  assert.deepEqual(rankSkills(skills, ["corr"]), []);
});

test("the card's data and what the model gets back", () => {
  const card = {
    reason: "Reviews follow your checklist",
    items: [
      { name: "review-checklist", description: "x", source: "catalog" as const },
      { name: "my-review", description: "y", source: "off" as const, where: "~/.claude/skills" },
    ],
  };
  assert.deepEqual(parseSkillSuggestion(JSON.stringify(card)), card);
  assert.equal(parseSkillSuggestion(JSON.stringify({ items: [{ name: "x" }] })), null);
  assert.equal(parseSkillSuggestion("nope"), null);
  assert.match(
    skillSuggestionResult(card),
    /review-checklist, my-review \(installed, turned off\)/,
  );
  assert.match(noSkillResult(["k8s"]), /No skill to add matches k8s/);
});

test("suggest_skill: once per conversation unless taken up", () => {
  const card: Item = {
    type: "tool",
    id: "t1",
    callId: "c1",
    name: "suggest_skill",
    args: {},
    status: "done",
    detail: JSON.stringify({ items: [] }),
  };
  const user = (text: string): Item => ({ type: "user", id: `u${text}`, text });
  assert.equal(skillSuggestionRefusal([user("hi")]), null);
  assert.match(skillSuggestionRefusal([card, user("go on")]) ?? "", /already suggested skills/);
  assert.equal(skillSuggestionRefusal([card, user("is there a skill for it?")]), null);
  assert.equal(skillSuggestionRefusal([{ ...card, detail: '{"engaged":true}' }]), null);
  // Another tool's card doesn't count.
  assert.equal(skillSuggestionRefusal([{ ...card, name: "suggest_extension" }]), null);
});

test("the skill catalog's files parse, named like their files (D342)", () => {
  const dir = "src/extensions/agent/catalogSkills";
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  assert.ok(files.length >= 5);
  for (const file of files) {
    const name = file.replace(/\.md$/, "");
    const parsed = parseSkillFile(readFileSync(join(dir, file), "utf8"), name);
    assert.ok(parsed.skill, `${file}: ${parsed.error}`);
    assert.equal(parsed.skill.name, name);
    assert.deepEqual(parsed.warnings, [], file);
    assert.ok(parsed.skill.description.length > 60, file);
  }
});

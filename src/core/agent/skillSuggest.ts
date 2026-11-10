// suggest_skill (D342), the IDE's take on Claude Code's SearchSkills + SuggestSkills: the agent
// searches the skills the user could add — the IDE's skill catalog (bundled, not installed) and
// skills found on disk but turned off — and shows up to three as a card with Add. The user's click
// adds one (a catalog skill is written to their skills folder; a turned-off one is turned on).
// The card's data is kept in the call's `detail`, so it draws the same after a restart. Once per
// conversation unless the user took it up (D314's rule). DOM-free and tested.

import type { Item } from "./conversation";
import { oncePerConversation } from "./extensionSuggest";

/** A skill that can be added: what the search ranks. */
export interface AvailableSkill {
  name: string;
  description: string;
  /** "catalog": comes with the IDE, not installed; "off": installed but turned off. */
  source: "catalog" | "off";
  /** Words it's about, besides its name and description (catalog skills). */
  tags?: readonly string[];
  /** Where a turned-off one is ("~/.claude/skills", "built in"…). */
  where?: string;
}

export interface SuggestedSkill {
  name: string;
  description: string;
  source: "catalog" | "off";
  where?: string;
  /** The user added it from the card. */
  added?: boolean;
}

export interface SkillSuggestion {
  /** One line on why it helps, shown on the card. */
  reason?: string;
  items: SuggestedSkill[];
  /** The user added one from the card. */
  engaged?: boolean;
}

export const MAX_SUGGESTED_SKILLS = 3;
const MAX_KEYWORDS = 8;

/** Common words that say nothing about a skill. */
const STOP = new Set(
  "a an and the of for to in on with by or my our your this that is are be it as at from into skill skills workflow".split(
    " ",
  ),
);

/** A word reduced to a rough stem ("reviews", "reviewing" → "review"), lower case. */
export function stem(word: string): string {
  const w = word.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("es") && /(ss|sh|ch|x)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w))
    .map(stem)
    .filter(Boolean);

/** The search words from a tool's `keywords` (an array or one string): stems, at most eight. */
export function keywordsOf(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? [raw] : [];
  return [...new Set(list.flatMap(words))].slice(0, MAX_KEYWORDS);
}

/**
 * How well a skill matches the keywords: a word of its name counts most, then a tag, then a word
 * of its description; a description word starting with the keyword counts a little. 0: no match.
 */
export function skillScore(skill: AvailableSkill, keywords: readonly string[]): number {
  const name = new Set(words(skill.name.replace(/-/g, " ")));
  const tags = new Set((skill.tags ?? []).flatMap(words));
  const description = words(skill.description);
  const described = new Set(description);
  let score = 0;
  for (const k of keywords) {
    if (name.has(k)) score += 4;
    else if (tags.has(k)) score += 3;
    else if (described.has(k)) score += 2;
    else if (k.length >= 4 && description.some((w) => w.startsWith(k))) score += 1;
  }
  return score;
}

/** The skills matching the keywords, best first (a tie: catalog before turned-off, then name). */
export function rankSkills<T extends AvailableSkill>(
  skills: readonly T[],
  keywords: readonly string[],
): T[] {
  return skills
    .map((skill) => ({ skill, score: skillScore(skill, keywords) }))
    .filter((x) => x.score >= 2)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.skill.source === b.skill.source ? 0 : a.skill.source === "catalog" ? -1 : 1) ||
        a.skill.name.localeCompare(b.skill.name),
    )
    .map((x) => x.skill);
}

/** The card's data kept in a call's detail; null when there's none (or it isn't ours). */
export function parseSkillSuggestion(detail: string | undefined): SkillSuggestion | null {
  if (!detail) return null;
  try {
    const v = JSON.parse(detail) as Partial<SkillSuggestion>;
    if (!v || !Array.isArray(v.items)) return null;
    const items = v.items.filter(
      (i): i is SuggestedSkill =>
        !!i &&
        typeof i.name === "string" &&
        typeof i.description === "string" &&
        (i.source === "catalog" || i.source === "off"),
    );
    return items.length ? { ...v, items } : null;
  } catch {
    return null;
  }
}

/** Words that say the user is asking about skills (taking a suggestion up). */
const ENGAGED = /\b(skills?|playbooks?|add(?:ed|ing)? (?:it|one|that|them))\b/i;

/** Why another suggestion isn't shown now (D314's rule), or null when it may be. */
export function skillSuggestionRefusal(items: readonly Item[]): string | null {
  return oncePerConversation(
    items,
    "suggest_skill",
    ENGAGED,
    "You already suggested skills in this conversation and the user hasn't taken it up: don't suggest again unless they ask.",
  );
}

/** What the model gets back about the card. */
export function skillSuggestionResult(s: SkillSuggestion): string {
  const list = s.items
    .map((i) => `${i.name}${i.source === "off" ? " (installed, turned off)" : ""}`)
    .join(", ");
  return `Shown to the user as a card: ${list}. They add one from the card; don't describe the skills in your answer or add them yourself. Once one is added, use_skill loads it.`;
}

/** What the model gets back when nothing matched. */
export function noSkillResult(keywords: readonly string[]): string {
  return `No skill to add matches ${keywords.join(", ")}. Don't suggest one; go on with the task (the user can write their own: Customize → Skills → New).`;
}

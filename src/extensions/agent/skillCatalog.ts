// The skill catalog (D342): skills that come with the IDE but aren't installed until the user
// adds one (from suggest_skill's card or agent.addSkillFromCatalog), unlike the built-in skills
// (D255), which are always on. Adding writes the skill's SKILL.md into the user's own skills
// folder (`~/<dataFolderName>/skills/<name>`), where it can be edited like any skill. With the
// skills found on disk but turned off (agent.skills.disabled), they're what suggest_skill
// searches. Commands: agent.skillCatalog, agent.addSkillFromCatalog.

import type { AvailableSkill } from "../../core/agent/skillSuggest";
import { keywordsOf, rankSkills } from "../../core/agent/skillSuggest";
import { parseSkillFile } from "../../core/agent/skills";
import { fsIpc } from "../../core/ipc/fs";
import type { DisposableStore } from "../../core/lifecycle/index";
import { joinPath } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import debugSystematically from "./catalogSkills/debug-systematically.md?raw";
import dependencyUpdate from "./catalogSkills/dependency-update.md?raw";
import docsStyle from "./catalogSkills/docs-style.md?raw";
import prDescription from "./catalogSkills/pr-description.md?raw";
import releaseNotes from "./catalogSkills/release-notes.md?raw";
import reviewChecklist from "./catalogSkills/review-checklist.md?raw";
import writeTests from "./catalogSkills/write-tests.md?raw";
import { disabledSkills, skillsFor } from "./skills";

/** The catalog: each skill's SKILL.md and words it's about besides its description. */
const CATALOG: readonly { text: string; tags: readonly string[] }[] = [
  { text: reviewChecklist, tags: ["code review", "playbook", "pull request", "audit", "bugs"] },
  { text: releaseNotes, tags: ["changelog", "version", "release", "house style", "tag"] },
  { text: writeTests, tags: ["unit test", "testing", "coverage", "regression", "spec"] },
  { text: prDescription, tags: ["pull request", "pr", "merge request", "template", "github"] },
  { text: debugSystematically, tags: ["bug", "crash", "failing", "error", "investigate", "fix"] },
  { text: docsStyle, tags: ["documentation", "readme", "guide", "writing", "house style"] },
  {
    text: dependencyUpdate,
    tags: ["upgrade", "bump", "package", "library", "npm", "cargo", "outdated", "dependency"],
  },
];

export interface CatalogEntry extends AvailableSkill {
  source: "catalog";
  text: string;
}

/** The catalog's skills (parsed once; one that doesn't parse is left out). */
let parsed: CatalogEntry[] | null = null;
export function catalogSkills(): CatalogEntry[] {
  parsed ??= CATALOG.flatMap(({ text, tags }) => {
    const skill = parseSkillFile(text, "").skill;
    return skill
      ? [
          {
            name: skill.name,
            description: skill.description,
            source: "catalog" as const,
            tags,
            text,
          },
        ]
      : [];
  });
  return parsed;
}

/**
 * What the user could add: catalog skills not installed under that name, and skills found but
 * turned off. `query` (keywords) ranks and narrows them; without it, all of them.
 */
export async function availableSkills(
  services: WorkbenchServices,
  query?: readonly string[],
): Promise<AvailableSkill[]> {
  const loaded = await skillsFor(services).all();
  const off = disabledSkills(services);
  const installed = new Set([...loaded.skills, ...loaded.shadowed].map((x) => x.name));
  const list: AvailableSkill[] = [
    ...catalogSkills()
      .filter((c) => !installed.has(c.name))
      .map(({ text: _text, ...c }) => c),
    ...loaded.skills
      .filter((x) => off.has(x.name))
      .map(
        (x): AvailableSkill => ({
          name: x.name,
          description: x.description,
          source: "off",
          where: x.source,
        }),
      ),
  ];
  return query?.length ? rankSkills(list, query) : list;
}

/**
 * Adds one: a catalog skill is written to the user's skills folder; a skill that's turned off is
 * turned on. What it did.
 */
async function addSkill(
  services: WorkbenchServices,
  name: string,
  execute: (id: string, input: unknown) => Promise<unknown>,
): Promise<{ added: string; how: "installed" | "turned on"; path?: string }> {
  const skills = skillsFor(services);
  const loaded = await skills.all();
  const existing = loaded.skills.find((x) => x.name === name);
  if (existing) {
    if (!disabledSkills(services).has(name)) return { added: name, how: "turned on" };
    await execute("agent.setSkillEnabled", { name, enabled: true });
    return { added: name, how: "turned on" };
  }
  const entry = catalogSkills().find((c) => c.name === name);
  if (!entry) throw new Error(`No skill ${name} in the catalog or turned off.`);
  const base = await skills.userDir();
  if (!base) throw new Error("There's no user skills folder (no home folder).");
  const file = joinPath(joinPath(base, name), "SKILL.md");
  if (await fsIpc.stat(file).catch(() => null))
    throw new Error(`There's a skill called ${name} already (${file}).`);
  await fsIpc.write(file, new TextEncoder().encode(entry.text));
  skills.invalidate();
  // A catalog skill turned off by name before (it was installed once, then deleted): on again.
  if (disabledSkills(services).has(name))
    await execute("agent.setSkillEnabled", { name, enabled: true });
  return { added: name, how: "installed", path: file };
}

export function registerSkillCatalog(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher } = services;
  sub.add(
    dispatcher.register({
      id: "agent.skillCatalog",
      title: "Skills to add",
      category: "Agent",
      description:
        "Lists the skills the user could add: the IDE's skill catalog (not installed yet) and skills found on disk but turned off, and `userDir`, where adding one writes it. `keywords` ranks and narrows them (name, then tags, then description). Add one with agent.addSkillFromCatalog.",
      input: s.object({ keywords: s.array(s.string()).optional() }),
      effects: ["read"],
      agent: "discoverable",
      palette: false,
      run: async ({ keywords }) => ({
        skills: await availableSkills(services, keywords ? keywordsOf(keywords) : undefined),
        userDir: await skillsFor(services).userDir(),
      }),
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.addSkillFromCatalog",
      title: "Add an agent skill from the catalog…",
      category: "Agent",
      description:
        "Adds a skill the user chose: one from the IDE's catalog is written to the user's skills folder (~/<data folder>/skills/<name>/SKILL.md, every project); one that's turned off is turned on. New chats list it; use_skill loads it at once. Without `name`, a person picks from the list.",
      input: s.object({ name: s.string().optional() }),
      effects: ["write"],
      agent: "hidden",
      run: async ({ name }, ctx) => {
        let picked = name;
        if (!picked) {
          if (ctx.caller.kind !== "user") throw new Error("Give the skill's `name`.");
          const list = await availableSkills(services);
          if (!list.length) {
            services.notifications.show("info", "Every skill in the catalog is added already.");
            return { added: null };
          }
          const choice = await services.quickInput.pick(
            list.map((x) => ({
              id: x.name,
              label: x.name,
              description: x.source === "off" ? "turned off" : "catalog",
              detail: x.description,
            })),
            { placeholder: "Add a skill" },
          );
          if (!choice) return { added: null };
          picked = choice.id;
        }
        return addSkill(services, picked, (id, input) => ctx.execute(id, input));
      },
    }),
  );
}

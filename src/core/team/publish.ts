// What goes into a team's library when one of the user's own files is published, DOM-free: the
// name an item gets, which files a skill is, and the text of the lists (recommended
// extensions). The secret check for an mcp.json is in mcp.ts, the settings filter in
// settings.ts.
import { parseExtensionsJson } from "../extensions/recommendations";
import { type TeamKind, validItemPath } from "./items";

/** The one name the kinds that are a single file have. */
const FIXED: Partial<Record<TeamKind, string>> = {
  rules: "AGENTS.md",
  mcp: "mcp.json",
  settings: "settings.json",
  extensions: "extensions.json",
};

/** The skill a skill's folder names (`skills/review`, `skills/review/`), else null. */
export function skillFolderOf(path: string): string | null {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts.length === 2 && parts[0] === "skills" && parts[1] ? parts[1] : null;
}

/**
 * The name to publish under: the kind's own for the kinds that are one file (whatever was
 * given), else `path` as it is. Throws when it isn't a name that kind may have. A skill's
 * folder (`skills/<skill>`) is returned as given: its files are published one by one.
 */
export function publishPath(kind: TeamKind, path: string | undefined): string {
  const fixed = FIXED[kind];
  if (fixed) return fixed;
  const name = (path ?? "").trim();
  if (kind === "skills" && skillFolderOf(name)) return name.replace(/\/+$/, "");
  if (!validItemPath(kind, name))
    throw new Error(
      name
        ? `${name} isn't a name the library takes for ${kind} (${EXAMPLES[kind]}).`
        : `Give \`path\`: the file to publish (${EXAMPLES[kind]}).`,
    );
  return name;
}

const EXAMPLES: Record<TeamKind, string> = {
  rules: "AGENTS.md",
  skills: "skills/<skill> for the whole skill, or skills/<skill>/<file>",
  commands: "commands/<name>.md",
  agents: "agents/<name>.md",
  outputStyles: "output-styles/<name>.md",
  snippets: "snippets/<name>.json or snippets/<name>.code-snippets",
  mcp: "mcp.json",
  settings: "settings.json",
  extensions: "extensions.json",
};

/**
 * The files of the user's skill `skill` to publish, from the names of the user's own files
 * (`skills/<skill>/…`): the ones the library takes, `SKILL.md` first, and the ones it doesn't
 * (`skipped`). Throws when the skill has no `SKILL.md`: without it the files aren't a skill.
 */
export function skillFiles(
  files: readonly string[],
  skill: string,
): { paths: string[]; skipped: string[] } {
  const prefix = `skills/${skill}/`;
  const own = files.filter((path) => path.startsWith(prefix));
  const main = `${prefix}SKILL.md`;
  if (!own.includes(main)) throw new Error(`You have no skill named ${skill} (no ${main}).`);
  const paths = own.filter((path) => validItemPath("skills", path)).sort();
  return {
    paths: [main, ...paths.filter((path) => path !== main)],
    skipped: own.filter((path) => !paths.includes(path)),
  };
}

/**
 * The team's `extensions.json` for these ids, and the ones that aren't extension ids
 * (`publisher.name`): left out.
 */
export function extensionsForTeam(ids: readonly string[]): {
  text: string;
  recommendations: string[];
  refused: string[];
} {
  const wanted = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  const { recommendations } = parseExtensionsJson(JSON.stringify({ recommendations: wanted }));
  return {
    text: `${JSON.stringify({ recommendations }, null, 2)}\n`,
    recommendations,
    refused: wanted.filter((id) => !recommendations.includes(id)),
  };
}

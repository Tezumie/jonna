// agent-skills-suggest-m7-85: removes a release-notes skill an earlier run of the test added to
// the user skills folder (the test adds it from the catalog). The UI tests share the app's data
// with the owner's dev app, so a release-notes skill that isn't the catalog's copy is the
// owner's own: it's left alone and the test stops here.
// usage: node skill-leftover-m7-85.mjs <user skills folder>
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.argv[2] ?? "", "release-notes");
if (!process.argv[2] || !existsSync(dir)) {
  console.log("cleaned (nothing there)");
  process.exit(0);
}
const skill = join(dir, "SKILL.md");
const text = existsSync(skill) ? readFileSync(skill, "utf8").replace(/\r\n/g, "\n") : "";
const fromCatalog =
  text.startsWith("---\nname: release-notes\n") &&
  text.includes(
    "description: Draft release notes (or a CHANGELOG entry) from the commits since the last tag",
  );
if (!fromCatalog) {
  console.log(`not touching ${dir}: it isn't the catalog's copy (a skill of your own?)`);
  process.exit(1);
}
rmSync(dir, { recursive: true, force: true });
console.log("cleaned");

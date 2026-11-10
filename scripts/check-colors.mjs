// DESIGN.md §20.3: no hex/rgb/hsl color values in src/ outside the theme/token files.
// Allowed: src/styles/tokens.css, src/styles/themes/**, src/core/themes/** (color parsing/import),
// and unit tests (*.test.ts: colors there are test data, e.g. a page's CSS being parsed).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = join(import.meta.dirname, "..", "src");
const allowed = [
  ["styles", "tokens.css"],
  ["styles", "themes"],
  ["core", "themes"],
].map((p) => p.join(sep));
const pattern = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/;
const offenders = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const rel = relative(root, path);
    if (allowed.some((a) => rel === a || rel.startsWith(a + sep))) continue;
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(ts|css|html)$/.test(name) && !name.endsWith(".test.ts")) {
      readFileSync(path, "utf8")
        .split("\n")
        .forEach((line, i) => {
          // Ignore URL fragments like href="#i-name" and CSS id selectors in comments.
          const cleaned = line
            .replace(/["'`]#[a-z][\w-]*["'`]/gi, "")
            .replace(/href=["'][^"']*["']/g, "");
          if (pattern.test(cleaned))
            offenders.push(`src/${rel.split(sep).join("/")}:${i + 1}: ${line.trim()}`);
        });
    }
  }
}
walk(root);
if (offenders.length > 0) {
  console.error(`Color values outside theme files (use semantic tokens):\n${offenders.join("\n")}`);
  process.exit(1);
}
console.log("colors: ok (no hex/rgb/hsl outside theme files)");

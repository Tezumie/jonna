// A stand-in for GNU make on machines without it (the owner's Windows has none): the UI test
// runner puts this folder on PATH for scripts with `"fakeMake": true` only when no real `make` is
// found. It runs a Makefile's simple rules: `make [target…]` runs each target's prerequisites
// that are rules, then its recipe lines through sh, echoing them as make does. `make -p …` (the
// database the IDE's task detection reads) prints nothing and fails, so detection reads the
// Makefile's text instead, as it does without make.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.some((a) => a.startsWith("-"))) process.exit(2);

let text;
try {
  text = readFileSync("Makefile", "utf8");
} catch {
  console.error("make: *** No targets specified and no makefile found.  Stop.");
  process.exit(2);
}

/** Rules: target → { deps, recipe }, in file order. */
const rules = new Map();
let current = null;
for (const line of text.split(/\r?\n/)) {
  if (line.startsWith("\t")) {
    current?.recipe.push(line.slice(1));
    continue;
  }
  const m = /^([^\s:=#][^:=]*):(?!=)(.*)$/.exec(line);
  if (!m) {
    if (line.trim()) current = null;
    continue;
  }
  current = { deps: m[2].split(/\s+/).filter(Boolean), recipe: [] };
  for (const name of m[1].trim().split(/\s+/)) if (name !== ".PHONY") rules.set(name, current);
}

const done = new Set();
function build(target) {
  if (done.has(target)) return;
  done.add(target);
  const rule = rules.get(target);
  if (!rule) {
    console.error(`make: *** No rule to make target '${target}'.  Stop.`);
    process.exit(2);
  }
  for (const dep of rule.deps) if (rules.has(dep)) build(dep);
  for (const line of rule.recipe) {
    const silent = line.startsWith("@");
    const command = silent ? line.slice(1) : line;
    if (!silent) console.log(command);
    try {
      execSync(command, { stdio: "inherit", shell: "sh" });
    } catch (err) {
      console.error(`make: *** [Makefile: ${target}] Error ${err.status ?? 1}`);
      process.exit(2);
    }
  }
}

const targets = args.length ? args : [...rules.keys()].slice(0, 1);
for (const t of targets) build(t);

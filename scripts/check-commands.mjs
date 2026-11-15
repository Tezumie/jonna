// Every Tauri command the app registers (src-tauri/src/lib.rs, invoke_handler) must be listed in
// src-tauri/build.rs (which generates its `allow-*` permission) and granted in a
// capability file (src-tauri/capabilities) — otherwise the frontend gets "<command> not allowed" at run time
// (D122: git blame, clone, stash and the agent's new-folder card shipped that way).
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFile(join(root, p), "utf8");
const lib = await read("src-tauri/src/lib.rs");
// The list is `all_commands!` in lib.rs: `desktop_only [...]` (what needs a window) and
// `common [...]` (what the windowless host answers too). The desktop registers both.
const listStart = lib.indexOf("macro_rules! all_commands");
const lists = lib.slice(listStart, lib.indexOf("\n}\n", listStart));
const namesIn = (label) => {
  const from = lists.indexOf(`${label} [`);
  if (from < 0) return [];
  const body = lists.slice(from, lists.indexOf("]", from)).replace(/\/\/.*$/gm, "");
  return [...body.matchAll(/(\w+),/g)].map((m) => m[1]);
};
const desktopOnly = namesIn("desktop_only");
const common = namesIn("common");
const registered = [...desktopOnly, ...common];
const build = await read("src-tauri/build.rs");
const listed = new Set([...build.matchAll(/^\s+"(\w+)",$/gm)].map((m) => m[1]));
const caps =
  (await read("src-tauri/capabilities/default.json")) +
  (await read("src-tauri/capabilities/browser-external.json")) +
  (await read("src-tauri/capabilities/docs-render.json"));
const granted = new Set(
  [...caps.matchAll(/"allow-([\w-]+)"/g)].map((m) => m[1].replaceAll("-", "_")),
);
const seen = new Set();
const repeated = registered.filter((c) => seen.size === seen.add(c).size);
const problems = [
  ...(registered.length ? [] : ["no commands found in src-tauri/src/lib.rs (all_commands!)"]),
  ...repeated.map((c) => `${c}: listed twice in src-tauri/src/lib.rs`),
  ...registered
    .filter((c) => !listed.has(c))
    .map((c) => `${c}: not in src-tauri/build.rs COMMANDS`),
  ...[...listed]
    .filter((c) => !granted.has(c))
    .map((c) => `${c}: no "allow-${c.replaceAll("_", "-")}" in src-tauri/capabilities`),
];
if (problems.length) {
  console.error(`commands: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(
  `commands: ok (${registered.length} registered, all allowed; ${common.length} also in the windowless host)`,
);

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
const handler = lib.slice(lib.indexOf("generate_handler!["));
const registered = [...handler.slice(0, handler.indexOf("]")).matchAll(/(\w+),/g)].map((m) => m[1]);
const build = await read("src-tauri/build.rs");
const listed = new Set([...build.matchAll(/^\s+"(\w+)",$/gm)].map((m) => m[1]));
const caps =
  (await read("src-tauri/capabilities/default.json")) +
  (await read("src-tauri/capabilities/browser-external.json")) +
  (await read("src-tauri/capabilities/docs-render.json"));
const granted = new Set(
  [...caps.matchAll(/"allow-([\w-]+)"/g)].map((m) => m[1].replaceAll("-", "_")),
);
const problems = [
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
console.log(`commands: ok (${registered.length} registered, all allowed)`);

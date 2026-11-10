// Fails if any production npm dependency (direct or transitive) has a non-permissive license (D13).
// Rust crates are checked by `cargo deny check licenses` (see src-tauri/deny.toml).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED =
  /^(MIT|ISC|0BSD|BSD-2-Clause|BSD-3-Clause|Apache-2\.0|Zlib|MPL-2\.0|Unlicense|CC0-1\.0)$/;

/** An SPDX expression passes if every AND-term is satisfiable by at least one allowed OR-option. */
function permissive(expr) {
  const clean = expr.replace(/[()]/g, " ").trim();
  return clean
    .split(/\s+AND\s+/)
    .every((term) => term.split(/\s+OR\s+/).some((id) => ALLOWED.test(id.trim())));
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const tree = JSON.parse(
  execFileSync(npm, ["ls", "--omit=dev", "--all", "--json", "--long"], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024,
  }),
);

const seen = new Map();
(function visit(deps) {
  for (const [name, info] of Object.entries(deps ?? {})) {
    const key = `${name}@${info.version}`;
    if (seen.has(key) || !info.path) continue;
    const pkg = JSON.parse(readFileSync(join(info.path, "package.json"), "utf8"));
    const license =
      typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? "UNKNOWN");
    seen.set(key, license);
    visit(info.dependencies);
  }
})(tree.dependencies);

let bad = 0;
for (const [pkg, license] of [...seen].sort()) {
  const ok = permissive(license);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${license.padEnd(28)} ${pkg}`);
}
console.log(`\n${seen.size} production packages, ${bad} non-permissive.`);
process.exit(bad ? 1 : 0);

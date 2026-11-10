// Builds the bundled snapshot of the ACP agent registry (D215): src/assets/acp-registry/registry.json,
// in the published registry.json shape, with each agent's icon inlined as an SVG data URL (the app
// never loads remote images). Usage: node scripts/gen-acp-registry.mjs <registry clone>
// The clone is github.com/agentclientprotocol/registry (Apache-2.0); its files are read as data
// (JSON.parse and plain text), nothing in it is run. Left out, as the registry's own rules and
// ours say: quarantined agents (quarantine.json) and agents whose own license is GPL/LGPL/AGPL.
// The `preview` channel is dropped (the published registry.json drops it too).
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clone = process.argv[2];
if (!clone) {
  console.error("usage: node scripts/gen-acp-registry.mjs <registry clone>");
  process.exit(1);
}

const COPYLEFT = /\b(A|L)?GPL\b|\bGNU (Affero |Lesser )?General Public\b/i;
const UNSAFE_SVG =
  /<script|\son[a-z]+\s*=|javascript:|<foreignObject|<!ENTITY|<!DOCTYPE|<iframe|<embed|<object|<image|<use|<style|@import|url\(|href\s*=/i;
const MAX_ICON = 32 * 1024;

const quarantine = JSON.parse(await readFile(join(clone, "quarantine.json"), "utf8"));
const commit = await (async () => {
  try {
    const head = (await readFile(join(clone, ".git/HEAD"), "utf8")).trim();
    if (!head.startsWith("ref: ")) return head;
    const ref = head.slice(5);
    const packed = await readFile(join(clone, ".git/packed-refs"), "utf8").catch(() => "");
    const loose = await readFile(join(clone, ".git", ref), "utf8").catch(() => "");
    if (loose.trim()) return loose.trim();
    const branch = ref.split("/").pop();
    return (
      packed
        .split("\n")
        .find((l) => l.endsWith(`/${branch}`))
        ?.split(" ")[0] ?? ""
    );
  } catch {
    return "";
  }
})();

const agents = [];
const skipped = [];
for (const dir of (await readdir(clone, { withFileTypes: true })).sort((a, b) =>
  a.name.localeCompare(b.name),
)) {
  if (!dir.isDirectory() || dir.name.startsWith(".")) continue;
  const text = await readFile(join(clone, dir.name, "agent.json"), "utf8").catch(() => null);
  if (text === null) continue;
  const agent = JSON.parse(text);
  if (typeof agent.id !== "string") continue;
  if (Object.hasOwn(quarantine, agent.id)) {
    skipped.push(`${agent.id}: quarantined (${quarantine[agent.id]})`);
    continue;
  }
  if (COPYLEFT.test(String(agent.license ?? ""))) {
    skipped.push(`${agent.id}: ${agent.license} (copyleft)`);
    continue;
  }
  delete agent.preview;
  const svg = await readFile(join(clone, dir.name, "icon.svg"), "utf8").catch(() => null);
  delete agent.icon;
  if (svg && svg.length <= MAX_ICON && /<svg[\s>]/i.test(svg) && !UNSAFE_SVG.test(svg))
    agent.icon = `data:image/svg+xml,${encodeURIComponent(svg.trim().replace(/\s+/g, " "))}`;
  else if (svg) skipped.push(`${agent.id}: icon left out (unsafe or too large)`);
  agents.push(agent);
}

const out = {
  version: "1.0.0",
  source: {
    repository: "https://github.com/agentclientprotocol/registry",
    commit,
    license: "Apache-2.0",
    generated: new Date().toISOString().slice(0, 10),
  },
  agents,
};
const target = join(root, "src/assets/acp-registry/registry.json");
await writeFile(target, `${JSON.stringify(out, null, 2)}\n`);
console.log(`${agents.length} agents → ${target}`);
for (const s of skipped) console.log(`  left out ${s}`);

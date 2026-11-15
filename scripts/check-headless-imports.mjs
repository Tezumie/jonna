// Fails when logic that must run without a window imports view code: from each entry it walks
// the static import graph (as the bundler resolves it) and stops with an error at anything under
// src/ui/, src/core/dom, a `view/` folder, or a stylesheet, printing the import chain that
// reached it.
//
//   node scripts/check-headless-imports.mjs                 the entries listed below
//   node scripts/check-headless-imports.mjs <entry.ts>…     these entries instead
//   node scripts/check-headless-imports.mjs --list          every module reached, per entry
//
// Imports that are types only (`import type`) are erased and don't count. A dynamic `import()`
// is reported but not followed: its module loads only when that line runs.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** What has to stay free of view code: a chat's logic, the sessions, the models, the agent's host. */
const ENTRIES = [
  "src/extensions/agent/session.ts",
  "src/extensions/agent/sessions.ts",
  "src/extensions/agent/providers.ts",
  "src/extensions/agent/agentHost.ts",
  "src/extensions/agent/mcp.ts",
];

/** Why a module (a path from the repository root, `/` separators) is view code; null when it isn't. */
function viewReason(path) {
  if (path.startsWith("src/ui/")) return "src/ui";
  if (path === "src/core/dom.ts" || path.startsWith("src/core/dom/")) return "src/core/dom";
  if (path.endsWith(".css")) return "a stylesheet";
  if (path.startsWith("src/") && path.split("/").slice(0, -1).includes("view"))
    return "a view/ folder";
  return null;
}

const args = process.argv.slice(2);
const list = args.includes("--list");
const entries = args.filter((a) => !a.startsWith("--"));
const checked = (entries.length ? entries : ENTRIES).map((e) => e.split("\\").join("/"));

// The graph as the app's bundler sees it (loaders and `?raw` as build.mjs and scripts/test.mjs).
const result = await esbuild.build({
  absWorkingDir: root,
  entryPoints: checked,
  bundle: true,
  write: false,
  metafile: true,
  outdir: join(root, ".test-build", "headless-imports"),
  platform: "node",
  format: "esm",
  target: "node20",
  define: { __DEV__: "true" },
  loader: { ".svg": "text", ".css": "empty" },
  logLevel: "silent",
  plugins: [
    {
      name: "raw",
      setup(build) {
        build.onResolve({ filter: /\?raw$/ }, (a) => ({
          path: join(a.resolveDir, a.path.slice(0, -4)),
          namespace: "raw",
        }));
        build.onLoad({ filter: /.*/, namespace: "raw" }, async (a) => ({
          contents: await readFile(a.path, "utf8"),
          loader: "text",
        }));
      },
    },
  ],
});
const inputs = result.metafile.inputs;

let failed = false;
for (const entry of checked) {
  if (!inputs[entry]) {
    console.error(`headless imports: ${entry} isn't a module of this repository.`);
    failed = true;
    continue;
  }
  // Breadth first, so the chain printed for a module is a shortest one. View modules are found,
  // not walked into: what one pulls in follows from the import that reached it.
  const from = new Map([[entry, null]]);
  const queue = [entry];
  const dynamic = [];
  /** Each import of a view module by a module that isn't one: the imports to cut. */
  const cuts = [];
  for (let i = 0; i < queue.length; i++) {
    const path = queue[i];
    for (const edge of inputs[path]?.imports ?? []) {
      if (edge.external || !inputs[edge.path]) continue;
      if (edge.kind === "dynamic-import") {
        dynamic.push(`${path} => ${edge.path}`);
        continue;
      }
      const reason = viewReason(edge.path);
      if (reason) {
        cuts.push({ importer: path, view: edge.path, reason });
        continue;
      }
      if (from.has(edge.path)) continue;
      from.set(edge.path, path);
      queue.push(edge.path);
    }
  }
  const chain = (path) => {
    const steps = [];
    for (let at = path; at; at = from.get(at)) steps.unshift(at);
    return steps.join(" -> ");
  };
  if (cuts.length) {
    failed = true;
    console.error(`headless imports: ${entry} reaches view code through ${cuts.length} imports:`);
    for (const importer of [...new Set(cuts.map((c) => c.importer))]) {
      console.error(`  ${chain(importer)}`);
      for (const c of cuts.filter((x) => x.importer === importer))
        console.error(`      imports ${c.view} (${c.reason})`);
    }
  } else console.log(`headless imports: ok, ${entry} (${queue.length} modules, no view code)`);
  if (list) for (const p of [...queue].sort()) console.log(`  ${p}`);
  if (dynamic.length && list) {
    console.log("  dynamic imports (not followed):");
    for (const d of dynamic) console.log(`    ${d}`);
  }
}
process.exit(failed ? 1 : 0);

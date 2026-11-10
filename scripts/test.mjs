// TS unit tests without a framework (D15): esbuild bundles every src/**/*.test.ts
// into .test-build/, then `node --test` runs them. Core modules under test are DOM-free.
import { spawnSync } from "node:child_process";
import { readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// TEST_BUILD_DIR: a folder of its own, so two runs at once (parallel agents) don't delete each
// other's bundles (a name under .test-build, which is git-ignored).
const outdir = join(root, ".test-build", process.env.TEST_BUILD_DIR ?? "");
const filter = process.argv[2]; // optional substring filter: `npm test -- dispatcher`

async function findTests(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await findTests(path)));
    else if (entry.name.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

const tests = (await findTests(join(root, "src"))).filter((t) => !filter || t.includes(filter));
if (tests.length === 0) {
  console.error("No tests found.");
  process.exit(1);
}

await rm(outdir, { recursive: true, force: true });
await esbuild.build({
  entryPoints: tests.map((t) => ({
    in: t,
    out: relative(join(root, "src"), t).replace(/\.ts$/, ""),
  })),
  outdir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: "inline",
  define: { __DEV__: "true" },
  // Icons as text, as build.mjs loads them: modules that draw an icon can be tested too.
  loader: { ".svg": "text" },
  logLevel: "warning",
  // `import text from "./file?raw"` (as in build.mjs): the file's contents as a string.
  plugins: [
    {
      name: "raw",
      setup(build) {
        build.onResolve({ filter: /\?raw$/ }, (args) => ({
          path: join(args.resolveDir, args.path.slice(0, -4)),
          namespace: "raw",
        }));
        build.onLoad({ filter: /.*/, namespace: "raw" }, async (args) => ({
          contents: await readFile(args.path, "utf8"),
          loader: "text",
        }));
      },
    },
  ],
});

// One glob from the build folder (it holds only what was just built, filtered or not), not every
// path: 370 absolute paths went past Windows' command-line limit and node never started.
// From the repository root, as before (tests read fixtures relative to it).
const pattern = `${relative(root, outdir).split("\\").join("/")}/**/*.test.mjs`;
const run = spawnSync(process.execPath, ["--enable-source-maps", "--test", pattern], {
  cwd: root,
  stdio: "inherit",
});
if (run.error) console.error(run.error.message);
process.exit(run.status ?? 1);

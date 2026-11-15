// Frontend build: esbuild only (D3). Usage:
//   node build.mjs           development build to dist/
//   node build.mjs --prod    minified production build to dist/
//   node build.mjs --serve   watch + serve dist/ on :1420 with live reload (used by `tauri dev`)
//   add --with-dev to a --prod build to keep dev-only commands (for measuring release startup)
//   node build.mjs --headless [--prod]   the brain without a window, for Node, to dist-headless/
//                            (its own folder: dist/ and the window's bundle are not touched)
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const prod = args.has("--prod");
const serve = args.has("--serve");
const devFeatures = !prod || args.has("--with-dev");
const outdir = join(root, "dist");
const headlessOutdir = join(root, "dist-headless");
const DEV_PORT = 1420;

// Keep generated files (product.ts, tokens.css, tauri.conf.json) fresh.
const gen = spawnSync(process.execPath, [join(root, "scripts/gen.mjs")], { stdio: "inherit" });
if (gen.status !== 0) process.exit(gen.status ?? 1);

if (args.has("--headless")) {
  await buildHeadless();
  process.exit(0);
}

/**
 * The brain without a window (src/headless/run.ts) as ES modules for Node: `brain.mjs`, the
 * chunks it loads lazily, and `workflow.worker.mjs` (a worker thread's script, one file). The
 * extensions' view code comes along where their modules import it, and is never run: views are
 * registered and never made without a screen. Stylesheets, fonts and images are left out.
 */
async function buildHeadless() {
  // The command line's name: the product's short name in lower case, or `--cli-name=<name>`.
  const productJson = JSON.parse(await readFile(join(root, "product.json"), "utf8"));
  const cliName =
    process.argv.find((a) => a.startsWith("--cli-name="))?.slice("--cli-name=".length) ||
    String(productJson.nameShort).toLowerCase();
  await rm(headlessOutdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await mkdir(headlessOutdir, { recursive: true });
  /** @type {import("esbuild").BuildOptions} */
  const node = {
    absWorkingDir: root,
    bundle: true,
    minify: prod,
    sourcemap: prod ? false : "linked",
    platform: "node",
    format: "esm",
    target: "node20",
    outExtension: { ".js": ".mjs" },
    define: { __DEV__: JSON.stringify(devFeatures), __CLI_NAME__: JSON.stringify(cliName) },
    legalComments: prod ? "external" : "inline",
    logLevel: "info",
    loader: { ".svg": "text", ".css": "empty", ".ttf": "empty", ".woff2": "empty" },
  };
  const raw = {
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
  };
  /** The Node extension host's script is a window extension's (never started here): empty. */
  const noNodeHost = {
    name: "no-node-host",
    setup(build) {
      build.onResolve({ filter: /^virtual:node-host$/ }, () => ({
        path: "node-host",
        namespace: "no-node-host",
      }));
      build.onLoad({ filter: /.*/, namespace: "no-node-host" }, () => ({
        contents: "",
        loader: "text",
      }));
    },
  };
  const monacoEsm = {
    name: "monaco-esm",
    setup(build) {
      build.onResolve({ filter: /^monaco-vim$/ }, () => ({
        path: join(root, "node_modules/monaco-vim/dist/index.mjs"),
      }));
      build.onResolve({ filter: /^monaco-editor\/esm\/vs\// }, (a) => ({
        path: join(root, "node_modules", `${a.path.replace(/\.js$/, "")}.js`),
      }));
    },
  };
  const results = await Promise.all([
    esbuild.build({
      ...node,
      // The brain (what a front end builds on) and the command line (src/headless/cli), which
      // loads the brain only for the modes that need it; they share their chunks.
      entryPoints: { brain: "src/headless/run.ts", cli: "src/headless/cli/entry.ts" },
      outdir: headlessOutdir,
      splitting: true, // what loads lazily in the window (the editor engine, grammars) stays lazy
      chunkNames: "chunks/[name]-[hash]",
      plugins: [raw, noNodeHost, monacoEsm],
      metafile: true,
    }),
    esbuild.build({
      ...node,
      entryPoints: { "workflow.worker": "src/workers/node/workflow.ts" },
      outdir: headlessOutdir,
      metafile: true,
    }),
    // The client of `serve`, on its own: a front end imports it without the brain.
    esbuild.build({
      ...node,
      entryPoints: { "serve-client": "src/headless/cli/serveClient.ts" },
      outdir: headlessOutdir,
    }),
  ]);
  await writeLaunchers(cliName);
  await mkdir(join(root, ".build-meta"), { recursive: true });
  await writeFile(
    join(root, ".build-meta/headless-meta.json"),
    JSON.stringify({ brain: results[0].metafile, workers: results[1].metafile }),
  );
}

/**
 * The command line's launchers, in dist-headless/bin/, named `name` (by default product.json's
 * short name, lower-cased): a `.cmd` for Windows (cmd.exe and PowerShell both run it; no `.ps1`,
 * which the default execution policy refuses) and a shell script for everything else. Each
 * starts `node` on cli.mjs one folder up and passes the arguments and the exit code through.
 */
async function writeLaunchers(name) {
  const bin = join(headlessOutdir, "bin");
  await mkdir(bin, { recursive: true });
  const missing =
    'Node.js 20 or newer is needed, and "node" was not found on PATH. Install it from https://nodejs.org and try again.';
  // `where /q` looks for node without printing. The exit code is passed on by name: a script
  // that ends on an `if` leaves 0 behind when it ran through `cmd /c`.
  const cmd = [
    "@echo off",
    "setlocal",
    "where /q node",
    "if errorlevel 1 (",
    `  echo ${missing.replaceAll('"', "")} 1>&2`,
    "  exit /b 2",
    ")",
    'node "%~dp0..\\cli.mjs" %*',
    "exit /b %errorlevel%",
    "",
  ].join("\r\n");
  await writeFile(join(bin, `${name}.cmd`), cmd);
  const sh = [
    "#!/bin/sh",
    "# Follows links to this script, so it can be linked into a folder on PATH.",
    'self="$0"',
    'while [ -h "$self" ]; do',
    '  dir=$(cd -P "$(dirname "$self")" && pwd)',
    '  self=$(readlink "$self")',
    '  case "$self" in /*) ;; *) self="$dir/$self" ;; esac',
    "done",
    'dir=$(cd -P "$(dirname "$self")" && pwd)',
    "if ! command -v node >/dev/null 2>&1; then",
    `  echo '${missing}' >&2`,
    "  exit 2",
    "fi",
    'exec node "$dir/../cli.mjs" "$@"',
    "",
  ].join("\n");
  await writeFile(join(bin, name), sh);
  await chmod(join(bin, name), 0o755);
}

// On Windows a folder something else just touched (a watcher, an antivirus scan) can fail to go
// with ENOTEMPTY or EBUSY for a moment: Node retries those.
await rm(outdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
await mkdir(outdir, { recursive: true });

// The bundled file icon theme (D132): Material Icon Theme's SVGs (MIT) as they ship; its manifest
// is a lazy chunk (extensions/workbench/iconThemes.ts). Loaded only when it's the active theme.
const material = join(root, "node_modules/material-icon-theme");
const materialOut = join(outdir, "icon-themes/material");
await cp(join(material, "icons"), join(materialOut, "icons"), { recursive: true });
await cp(join(material, "LICENSE"), join(materialOut, "LICENSE"));

/** @type {import("esbuild").BuildOptions} */
const common = {
  bundle: true,
  minify: prod,
  sourcemap: prod ? false : "linked",
  target: ["es2022", "safari16", "chrome110"],
  define: { __DEV__: JSON.stringify(devFeatures) },
  legalComments: prod ? "external" : "inline",
  logLevel: "info",
  loader: { ".ttf": "file", ".woff2": "file", ".svg": "text" },
};

/**
 * `import script from "virtual:node-host"` (D255): the Node extension host
 * (src/workers/extension.node.ts) bundled for Node as CommonJS, as a string. The app's CSP doesn't
 * let it fetch its own files, so the script comes in a chunk of its own, loaded when a Node
 * extension starts; the IDE writes it to its data folder and Node runs it.
 */
const nodeHostPlugin = {
  name: "node-host",
  setup(build) {
    build.onResolve({ filter: /^virtual:node-host$/ }, () => ({
      path: "node-host",
      namespace: "node-host",
    }));
    build.onLoad({ filter: /.*/, namespace: "node-host" }, async () => {
      const entry = join(root, "src/workers/extension.node.ts");
      const result = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        minify: prod,
        platform: "node",
        format: "cjs",
        target: ["node18"],
        write: false,
        metafile: true,
        logLevel: "silent",
      });
      return {
        contents: result.outputFiles[0].text,
        loader: "text",
        watchFiles: Object.keys(result.metafile.inputs).map((f) => join(root, f)),
      };
    });
  },
};

/** `import text from "./file?raw"`: the file's contents as a string (extension templates). */
const rawPlugin = {
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
};

/**
 * monaco-vim imports Monaco by its file layout (`monaco-editor/esm/vs/…`), which Monaco's exports
 * map doesn't allow; resolve it to the same files the IDE's own Monaco imports use (D196).
 */
const monacoEsmPlugin = {
  name: "monaco-esm",
  setup(build) {
    // Its "browser" export is a UMD bundle with a second copy of parts of Monaco: the ES module.
    build.onResolve({ filter: /^monaco-vim$/ }, () => ({
      path: join(root, "node_modules/monaco-vim/dist/index.mjs"),
    }));
    build.onResolve({ filter: /^monaco-editor\/esm\/vs\// }, (args) => ({
      path: join(root, "node_modules", `${args.path.replace(/\.js$/, "")}.js`),
    }));
  },
};

/** Copies index.html, injecting the live-reload snippet in serve mode only. */
const htmlPlugin = {
  name: "html",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) return;
      let html = await readFile(join(root, "src/index.html"), "utf8");
      if (serve) {
        html = html.replace(
          "</body>",
          `<script type="module" src="./assets/livereload.js"></script></body>`,
        );
        await writeFile(
          join(outdir, "assets/livereload.js"),
          "new EventSource('/esbuild').addEventListener('change', () => location.reload());\n",
        );
      }
      await writeFile(join(outdir, "index.html"), html);
    });
  },
};

const appOptions = {
  ...common,
  entryPoints: {
    main: "src/main.ts",
    // Loaded after the shell paints (extensions/editor/loader.ts).
    monaco: "src/extensions/editor/monaco/entry.ts",
  },
  outdir: join(outdir, "assets"),
  format: "esm",
  splitting: true, // Monaco, the terminal and each grammar load lazily as separate chunks.
  chunkNames: "chunks/[name]-[hash]",
  assetNames: "media/[name]-[hash]",
  plugins: [htmlPlugin, rawPlugin, nodeHostPlugin, monacoEsmPlugin],
};

// Workers are separate entries: classic (IIFE) scripts work in every target webview.
const workerOptions = {
  ...common,
  // Language service workers load only when a file of their language opens (D56).
  entryPoints: {
    "editor.worker": "src/workers/editor.worker.ts",
    "json.worker": "src/workers/json.worker.ts",
    "css.worker": "src/workers/css.worker.ts",
    "html.worker": "src/workers/html.worker.ts",
    "ts.worker": "src/workers/ts.worker.ts",
    // Third-party extension code runs here (D102).
    "extension.worker": "src/workers/extension.worker.ts",
    // The agent's workflow scripts run here (D338).
    "workflow.worker": "src/workers/workflow.worker.ts",
  },
  outdir: join(outdir, "workers"),
  format: "iife",
};

if (serve) {
  const app = await esbuild.context(appOptions);
  const workers = await esbuild.context(workerOptions);
  await Promise.all([app.watch(), workers.watch()]);
  await app.serve({ servedir: outdir, port: DEV_PORT, host: "localhost" });
  console.log(`dev server: http://localhost:${DEV_PORT}`);
} else {
  const results = await Promise.all([
    esbuild.build({ ...appOptions, metafile: true }),
    esbuild.build({ ...workerOptions, metafile: true }),
  ]);
  // esbuild writes a copy of Monaco's stylesheet next to every lazy chunk that imports Monaco
  // (the language modes). Nothing loads those copies — monaco.css is linked once by the loader —
  // so they are removed instead of shipping ~190 KB per language.
  const chunkDir = join(outdir, "assets/chunks");
  for (const file of await readdir(chunkDir)) {
    if (file.endsWith(".css") || file.endsWith(".css.map")) await rm(join(chunkDir, file));
  }
  // Bundle metadata stays outside dist/ so it isn't shipped; `npm run size` reads it.
  await mkdir(join(root, ".build-meta"), { recursive: true });
  await writeFile(
    join(root, ".build-meta/meta.json"),
    JSON.stringify({ app: results[0].metafile, workers: results[1].metafile }),
  );
}

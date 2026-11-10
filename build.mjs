// Frontend build: esbuild only (D3). Usage:
//   node build.mjs           development build to dist/
//   node build.mjs --prod    minified production build to dist/
//   node build.mjs --serve   watch + serve dist/ on :1420 with live reload (used by `tauri dev`)
//   add --with-dev to a --prod build to keep dev-only commands (for measuring release startup)
import { spawnSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const prod = args.has("--prod");
const serve = args.has("--serve");
const devFeatures = !prod || args.has("--with-dev");
const outdir = join(root, "dist");
const DEV_PORT = 1420;

// Keep generated files (product.ts, tokens.css, tauri.conf.json) fresh.
const gen = spawnSync(process.execPath, [join(root, "scripts/gen.mjs")], { stdio: "inherit" });
if (gen.status !== 0) process.exit(gen.status ?? 1);

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

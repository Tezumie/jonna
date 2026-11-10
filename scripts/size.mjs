// Reports frontend bundle size (from the last production build) and native binary/installer sizes.
// Usage: npm run build:web && npm run size      (frontend only)
//        npm run build && npm run size          (frontend + release binary + installers)
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fmt = (n) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`;

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

const dist = join(root, "dist");
if (!existsSync(dist)) {
  console.error("dist/ missing — run `npm run build:web` first.");
  process.exit(1);
}

const files = (await walk(dist)).filter((f) => !f.endsWith(".map"));
const byExt = new Map();
let total = 0;
let totalGz = 0;
let initial = 0; // what loads before the shell paints: index.html + main.js + main.css
const rows = [];
for (const f of files) {
  const buf = await readFile(f);
  const gz = gzipSync(buf).length;
  total += buf.length;
  totalGz += gz;
  const ext = extname(f) || "(none)";
  byExt.set(ext, (byExt.get(ext) ?? 0) + buf.length);
  const rel = relative(dist, f);
  if (["index.html", "assets/main.js", "assets/main.css"].includes(rel)) initial += buf.length;
  rows.push([rel, buf.length, gz]);
}
rows.sort((a, b) => b[1] - a[1]);

console.log("\nFrontend (dist/, excluding source maps)");
console.log(`  total:            ${fmt(total)}  (gzip ${fmt(totalGz)})`);
console.log(`  initial (shell):  ${fmt(initial)}  index.html + assets/main.js + assets/main.css`);
for (const [ext, n] of [...byExt].sort((a, b) => b[1] - a[1]))
  console.log(`  ${ext.padEnd(8)}          ${fmt(n)}`);
console.log("  largest files:");
for (const [rel, n, gz] of rows.slice(0, 10))
  console.log(`    ${fmt(n).padStart(10)}  gz ${fmt(gz).padStart(9)}  ${rel}`);

// Each worker loads only when a file of its language opens (D56).
console.log("  workers (lazy):");
for (const [rel, n, gz] of rows.filter(([r]) => r.startsWith("workers/") && r.endsWith(".js")))
  console.log(`    ${fmt(n).padStart(10)}  gz ${fmt(gz).padStart(9)}  ${rel}`);

const release = join(root, "src-tauri/target/release");
// The program is named after the product (product.json's nameShort, D225); "ide" is the Cargo name.
const product = JSON.parse(await readFile(join(root, "product.json"), "utf8"));
const exe = [product.nameShort, `${product.nameShort}.exe`, "ide", "ide.exe"]
  .map((n) => join(release, n))
  .find((p) => existsSync(p));
console.log("\nNative");
if (exe)
  console.log(`  release binary:   ${fmt((await stat(exe)).size)}  (${relative(root, exe)})`);
else console.log("  release binary:   (not built — run `npm run build`)");
const bundleDir = join(release, "bundle");
if (existsSync(bundleDir)) {
  for (const f of await walk(bundleDir)) {
    if (/\.(deb|rpm|AppImage|dmg|msi|exe)$/.test(f)) {
      console.log(`  installer:        ${fmt((await stat(f)).size)}  ${relative(bundleDir, f)}`);
    }
  }
}
console.log("");

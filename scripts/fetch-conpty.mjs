// Fetches a newer ConPTY for Windows 10 (m7.12, docs/windows-pending.md): conpty.dll and
// OpenConsole.exe from Microsoft's ConPTY NuGet package (MIT, microsoft/terminal), into
// src-tauri/conpty/<arch>/ with the license. scripts/gen.mjs then bundles them next to the program,
// where the terminal loads them (src-tauri/src/pty/conpty.rs; `ide://terminals` → conpty "bundled").
//
//   node scripts/fetch-conpty.mjs [--arch x64|arm64] [--version 1.25.260930003] [--sha256 <hex>]
//
// D253: the package is Microsoft.Windows.Console.ConPTY (owner Microsoft.Terminal, a reserved
// prefix); the CI.Microsoft… repackage first pinned here is deprecated. The download is checked
// against the SHA-512 nuget.org publishes for that version (its catalog), and against
// EXPECTED_SHA256 below (or --sha256) once that's pinned. The binaries' Authenticode signatures are
// shown. Run by the owner only; nothing downloads during a build.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = "Microsoft.Windows.Console.ConPTY";
const DEFAULT_VERSION = "1.25.260930003";
/** The package's SHA-256 for DEFAULT_VERSION, pinned after the first checked download. */
const EXPECTED_SHA256 = "02b07b349af66d801159bdf9e440d4a1ce78bb951f37fc8609731665afdae7ee";

/** microsoft/terminal's license (MIT), for a package that declares it without the file. */
const MIT_NOTICE = `MIT License

Copyright (c) Microsoft Corporation. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const arch = arg("arch") ?? (process.arch === "arm64" ? "arm64" : "x64");
const version = arg("version") ?? DEFAULT_VERSION;
const pinned = (
  arg("sha256") ?? (version === DEFAULT_VERSION ? EXPECTED_SHA256 : "")
).toLowerCase();
if (!["x64", "arm64"].includes(arch)) {
  console.error(`Unknown --arch ${arch} (x64 or arm64).`);
  process.exit(1);
}

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

/** The SHA-512 (base64) nuget.org lists for this version, from its catalog. */
async function publishedHash() {
  const id = PACKAGE.toLowerCase();
  const leaf = `https://api.nuget.org/v3/registration5-semver1/${id}/${version.toLowerCase()}.json`;
  const reg = await fetch(leaf);
  if (!reg.ok) fail(`nuget.org doesn't list ${PACKAGE} ${version} (HTTP ${reg.status}).`);
  const catalogUrl = (await reg.json()).catalogEntry;
  if (typeof catalogUrl !== "string") fail("nuget.org's listing has no catalog entry.");
  const entry = await (await fetch(catalogUrl)).json();
  if (entry.packageHashAlgorithm !== "SHA512" || typeof entry.packageHash !== "string")
    fail("nuget.org's catalog entry has no SHA-512 for the package.");
  return {
    sha512: entry.packageHash,
    authors: entry.authors ?? "?",
    listed: entry.listed !== false,
  };
}

/** Every file under `dir`, as paths relative to it. */
async function walk(dir, base = dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(relative(base, full));
  }
  return out;
}

/** The package's `name` for this architecture (in a folder named after it, native first). */
function pick(files, name) {
  const matches = files.filter((f) => {
    const parts = f.toLowerCase().split(sep);
    return (
      parts.at(-1) === name.toLowerCase() && parts.some((p) => p === arch || p.endsWith(`-${arch}`))
    );
  });
  matches.sort((a, b) => Number(b.includes("native")) - Number(a.includes("native")));
  return matches[0];
}

/** Who signed a Windows binary (Authenticode), as PowerShell reports it. */
function signature(path) {
  if (process.platform !== "win32") return "not checked (not on Windows)";
  const ps = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `$s = Get-AuthenticodeSignature -LiteralPath '${path.replace(/'/g, "''")}'; "$($s.Status) $($s.SignerCertificate.Subject)"`,
    ],
    { encoding: "utf8" },
  );
  return (ps.stdout || ps.stderr || "unknown").trim();
}

const published = await publishedHash();
console.log(
  `${PACKAGE} ${version}: authors ${published.authors}${published.listed ? "" : " (unlisted)"}`,
);
const url = `https://www.nuget.org/api/v2/package/${PACKAGE}/${version}`;
console.log(`Downloading ${url}`);
const response = await fetch(url);
if (!response.ok) fail(`Download failed: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const sha512 = createHash("sha512").update(bytes).digest("base64");
const sha256 = createHash("sha256").update(bytes).digest("hex");
console.log(`${bytes.length} bytes, SHA-256 ${sha256}`);
if (sha512 !== published.sha512)
  fail("The download doesn't match the SHA-512 nuget.org publishes for it. Nothing was written.");
console.log("Matches nuget.org's published SHA-512.");
if (pinned && sha256 !== pinned) fail(`Hash mismatch: expected ${pinned}. Nothing was written.`);

// A .nupkg is a zip; Windows 10's tar (bsdtar) extracts zips, so no extra tool is needed.
const work = await mkdtemp(join(tmpdir(), "conpty-"));
try {
  const nupkg = join(work, "conpty.zip");
  await writeFile(nupkg, bytes);
  const unpacked = join(work, "pkg");
  await mkdir(unpacked);
  const tar = spawnSync("tar", ["-xf", nupkg, "-C", unpacked], { stdio: "inherit" });
  if (tar.status !== 0) throw new Error("tar couldn't extract the package");
  const files = await walk(unpacked);
  const out = join(root, "src-tauri", "conpty", arch);
  await mkdir(out, { recursive: true });
  for (const name of ["conpty.dll", "OpenConsole.exe"]) {
    const found = pick(files, name);
    if (!found)
      throw new Error(`No ${name} for ${arch} in the package. Its files:\n  ${files.join("\n  ")}`);
    const to = join(out, name);
    await copyFile(join(unpacked, found), to);
    console.log(
      `  ${join("src-tauri", "conpty", arch, name)} (from ${found}; signature: ${signature(to)})`,
    );
  }
  // The license travels with the binaries (MIT): the package's file, else (a package that only
  // declares `<license type="expression">MIT</license>`) microsoft/terminal's MIT notice.
  let license = null;
  for (const name of ["LICENSE", "LICENSE.txt", "license.txt"]) {
    license = await readFile(join(unpacked, name), "utf8").catch(() => null);
    if (license) break;
  }
  await writeFile(join(out, "LICENSE.txt"), license ?? MIT_NOTICE);
  await writeFile(join(out, "VERSION.txt"), `${PACKAGE} ${version}\nsha256 ${sha256}\n${url}\n`);
  console.log(
    pinned
      ? "Done. Run `npm run check` (regenerates tauri.conf.json with the two files bundled)."
      : `Done. Pin it: set EXPECTED_SHA256 = "${sha256}" in scripts/fetch-conpty.mjs. Then run \`npm run check\`.`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}

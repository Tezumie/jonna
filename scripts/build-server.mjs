// Builds the remote development server (src-tauri/remote-server, docs/remote.md) for the Linux
// machines a window connects to, and puts each binary where the app bundles it from:
//   src-tauri/resources/server/<target>/ide-server
// Static musl builds linked with rust-lld (shipped with Rust), so no C toolchain or glibc
// version is needed on either side. Needs the targets: `rustup target add <target>`.
//
//   node scripts/build-server.mjs            both targets
//   node scripts/build-server.mjs x86_64     one (a full triple or its first part)
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const crate = join(root, "src-tauri", "remote-server");
const TARGETS = ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"];
const BINARY = "ide-server";

const asked = process.argv.slice(2);
const targets = asked.length
  ? asked.map((a) => {
      const match = TARGETS.find((t) => t === a || t.startsWith(`${a}-`));
      if (!match) {
        console.error(`Unknown target ${a}. Known: ${TARGETS.join(", ")}`);
        process.exit(2);
      }
      return match;
    })
  : TARGETS;

const size = (bytes) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(2)} MB`
    : `${Math.round(bytes / 1024)} KB`;

let failed = false;
for (const target of targets) {
  console.log(`Building ${BINARY} for ${target}…`);
  const result = spawnSync(
    "cargo",
    ["build", "--release", "--target", target, "--manifest-path", join(crate, "Cargo.toml")],
    {
      stdio: "inherit",
      env: { ...process.env, RUSTFLAGS: "-C linker=rust-lld -C link-self-contained=yes" },
    },
  );
  const built = join(crate, "target", target, "release", BINARY);
  if (result.status !== 0 || !existsSync(built)) {
    console.error(
      `Building for ${target} failed${result.error ? `: ${result.error.message}` : ""}.`,
    );
    failed = true;
    continue;
  }
  const outDir = join(root, "src-tauri", "resources", "server", target);
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, BINARY);
  copyFileSync(built, out);
  // The executable bit matters where it is uploaded from a Unix machine.
  chmodSync(out, 0o755);
  console.log(`  ${out.slice(root.length + 1)}: ${size(statSync(out).size)}`);
}
process.exit(failed ? 1 : 0);

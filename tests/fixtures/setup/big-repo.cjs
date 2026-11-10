// A large repository for measuring (big-repo-m7-20): `big/` in the test's folder with
// `count` source files (default 100 000) across nested folders, committed, then a few changes.
// Usage: node ../setup/big-repo.cjs [count]
const { mkdirSync, writeFileSync, appendFileSync } = require("node:fs");
const { join } = require("node:path");
const { execFileSync } = require("node:child_process");

const count = Number(process.argv[2] ?? 100_000);
const root = join(process.cwd(), "big");
const started = Date.now();
const made = new Set();
for (let i = 0; i < count; i++) {
  const dir = join(
    root,
    `pkg${i % 50}`,
    `mod${Math.floor(i / 50) % 40}`,
    `part${Math.floor(i / 2000)}`,
  );
  if (!made.has(dir)) {
    mkdirSync(dir, { recursive: true });
    made.add(dir);
  }
  const name = `file${i}.ts`;
  writeFileSync(
    join(dir, name),
    `// file ${i}\nexport function handler${i}(input: number): number {\n  return input * ${i};\n}\n${i === count - 2223 ? "export const needleInTheRepo = true;\n" : ""}`,
  );
}
// The IDE's own git (status of nested repositories) can hold index.lock while this commits: a CI
// runner failed here. Tried again on that; any other error shows git's message.
const git = (...args) => {
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync("git", args, { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
      return;
    } catch (err) {
      const stderr = String(err.stderr ?? "");
      if (attempt >= 10 || !stderr.includes("index.lock")) {
        console.error(stderr);
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
};
git("init", "-q");
git("-c", "core.autocrlf=false", "add", "-A");
git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "big");
// A few working-tree changes for git status.
for (let i = 0; i < 20; i++)
  appendFileSync(join(root, `pkg${i}`, "mod0", "part0", `file${i}.ts`), "// changed\n");
console.log(`big repo: ${count} files in ${Date.now() - started} ms`);

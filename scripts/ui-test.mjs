// Runs every tests/scripts/*.jsonc against a built app (`--run-test-script`), each in a fresh copy
// of tests/fixtures/sample and a fresh profile (`--user-data-dir`). Linux without a display runs
// under xvfb-run. Usage: node scripts/ui-test.mjs [path/to/app-binary] [script-filter]
// (UI_TEST_KEEP=1 keeps each run's folder, screenshots included).
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exe = process.platform === "win32" ? "ide.exe" : "ide";
const binary = process.argv[2] ?? join(root, "src-tauri/target/debug", exe);
const filter = process.argv[3];
const scripts = (await readdir(join(root, "tests/scripts")))
  .filter((f) => f.endsWith(".jsonc") && (!filter || f.includes(filter)))
  .sort();

function run(cmd, args, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"], env });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
    child.on("error", (err) => {
      console.error(err.message);
      resolve(127);
    });
  });
}

/**
 * Starts a mock server and waits until it listens. A port still held (by a mock from a run that
 * was stopped, say) ends the run here: otherwise every test using that mock fails, far from why.
 */
function startMock(file, port) {
  const child = spawn(process.execPath, [join(root, "tests/fixtures", file), port], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let ready = false;
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      // A second port can still fail just after the first is up: give it a moment.
      if (!ready && String(chunk).includes(`on ${port}`)) {
        ready = true;
        setTimeout(() => (child.exitCode === null ? resolve(child) : null), 300);
      }
    });
    child.on("exit", (code) =>
      reject(new Error(`${file} exited (${code}): is port ${port} (or the one below) in use?`)),
    );
  });
}

// A scripted Ollama stand-in for the agent tests (port 11999), and a dev server stand-in for the
// browser tests (port 11998, with a WebSocket; 11997 for its second app), for the whole session.
let mock;
let devServer;
try {
  mock = await startMock("mock-ollama.mjs", "11999");
  devServer = await startMock("mock-devserver.mjs", "11998");
} catch (err) {
  console.error(err.message);
  mock?.kill();
  process.exit(1);
}
process.on("exit", () => {
  mock.kill();
  devServer.kill();
});
// A mock that dies mid-run fails every later test that uses it: said where it happened.
let ending = false;
for (const [name, child] of [
  ["mock-ollama", mock],
  ["mock-devserver", devServer],
])
  child.on("exit", (code) => {
    if (!ending) console.error(`\n!!! ${name} exited (${code}): later tests using it fail`);
  });

// On Windows the scripts' shell commands (`printf`, `&&`, `mkdir -p`) are bash's: their terminals
// open Git Bash there, as on CI. Tasks and the agent's commands keep the default shell.
const gitBash = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
const profileSettings =
  process.platform === "win32" && existsSync(gitBash)
    ? `${JSON.stringify({ "terminal.defaultProfile.windows": "Git Bash" }, null, 2)}\n`
    : null;

const GIT_CONFIG = `[user]
\tname = Test
\temail = test@example.com
[core]
\tautocrlf = false
[commit]
\tgpgsign = false
`;

// Whether `program` is on PATH (with Windows' extensions: .exe, .cmd).
const onPath = (program) =>
  (process.env.PATH ?? process.env.Path ?? "")
    .split(delimiter)
    .some((dir) =>
      (process.platform === "win32"
        ? [`${program}.exe`, `${program}.cmd`, `${program}.bat`, program]
        : [program]
      ).some((f) => (dir ? existsSync(join(dir, f)) : false)),
    );

// `"python:debugpy"` in `"requires"`: a Python module, importable by the python debug configs
// run (python3, else python), rather than a program on PATH.
const hasPythonModule = (module) =>
  ["python3", "python"].some(
    (python) => spawnSync(python, ["-c", `import ${module}`], { stdio: "ignore" }).status === 0,
  );

// Whether GNU make is on PATH (for `"fakeMake"` scripts).
const hasMake = (process.env.PATH ?? process.env.Path ?? "")
  .split(delimiter)
  .some((dir) =>
    (process.platform === "win32" ? ["make.exe", "make.cmd", "make"] : ["make"]).some((f) =>
      dir ? existsSync(join(dir, f)) : false,
    ),
  );

let failed = 0;
let skipped = 0;
for (const script of scripts) {
  // `"platforms": ["linux", "darwin"]` in a script: only on those OSes (zsh / fish profiles…).
  const platforms = /"platforms"\s*:\s*\[([^\]]*)\]/.exec(
    await readFile(join(root, "tests/scripts", script), "utf8"),
  )?.[1];
  if (platforms && !platforms.includes(`"${process.platform}"`)) {
    console.log(`\n=== ${script}: skipped (platforms: ${platforms.trim()})`);
    skipped++;
    continue;
  }
  // `"manual": true`: a script to look at by hand (the card gallery keeps its window open for an
  // hour): run only when named in full ("agent-card-gallery"), never in a batch or by a filter.
  const manual = /"manual"\s*:\s*true/.test(
    await readFile(join(root, "tests/scripts", script), "utf8"),
  );
  if (manual && filter !== script.replace(/\.jsonc$/, "") && filter !== script) {
    console.log(`\n=== ${script}: skipped (manual: name it in full to run it)`);
    skipped++;
    continue;
  }
  // `"requires": ["pyright-langserver"]`: programs it needs on PATH (D264), skipped without them;
  // "python:<module>" for a Python module (D400).
  const requires = /"requires"\s*:\s*\[([^\]]*)\]/.exec(
    await readFile(join(root, "tests/scripts", script), "utf8"),
  )?.[1];
  const missing = (requires ?? "")
    .split(",")
    .map((x) => x.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
    .filter((program) =>
      program.startsWith("python:") ? !hasPythonModule(program.slice(7)) : !onPath(program),
    );
  if (missing.length) {
    console.log(`\n=== ${script}: skipped (not on PATH: ${missing.join(", ")})`);
    skipped++;
    continue;
  }
  const work = await mkdtemp(join(tmpdir(), "ide-ui-test-"));
  const folder = join(work, "sample");
  await cp(join(root, "tests/fixtures/sample"), folder, { recursive: true });
  // Extensions for tests/scripts/extensions.jsonc, next to the folder ("../extensions/hello").
  await cp(join(root, "tests/fixtures/extensions"), join(work, "extensions"), { recursive: true });
  // Setup scripts a test runs from the sample copy (`node ../setup/…`), outside the sample so
  // they aren't searched or listed with it.
  await cp(join(root, "tests/fixtures/setup"), join(work, "setup"), { recursive: true });
  if (profileSettings) {
    await mkdir(join(work, "profile", "config"), { recursive: true });
    await writeFile(join(work, "profile", "config", "settings.json"), profileSettings);
  }
  // `"fakeGh": true` in a script: the GitHub CLI is tests/fixtures/fake-gh (publishing offline).
  const text = await readFile(join(root, "tests/scripts", script), "utf8");
  // `"testTimeout": seconds`: a script that needs longer than 240 s (big-repo-m7-20's 100 000 files).
  const seconds = /"testTimeout"\s*:\s*(\d+)/.exec(text)?.[1] ?? "240";
  const args = [
    folder,
    "--run-test-script",
    join(root, "tests/scripts", script),
    "--user-data-dir",
    join(work, "profile"),
    "--test-timeout",
    seconds,
  ];
  const headless = process.platform === "linux" && !process.env.DISPLAY;
  // Git as on a fresh machine, whatever this one's config says (Git for Windows' own config turns
  // on core.autocrlf; a user's may sign commits, add hooks or rename the first branch).
  await writeFile(join(work, "gitconfig"), GIT_CONFIG);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(work, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  if (/"fakeGh"\s*:\s*true/.test(text)) {
    // Windows names it `Path`: a second `PATH` key beside it lost, and the real GitHub CLI
    // published the sample to the signed-in account. The existing key, whatever its case.
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    env[pathKey] = `${join(root, "tests/fixtures/fake-gh")}${delimiter}${env[pathKey] ?? ""}`;
    // And no real GitHub token reaches a test, whatever finds `gh`.
    env.GH_TOKEN = "fake-gh-test-token";
    delete env.GITHUB_TOKEN;
  }
  // `"fakeDocker": true` (D266): docker is tests/fixtures/fake-docker, its containers WSL's Ubuntu.
  if (/"fakeDocker"\s*:\s*true/.test(text)) {
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    env[pathKey] = `${join(root, "tests/fixtures/fake-docker")}${delimiter}${env[pathKey] ?? ""}`;
    env.FAKE_DOCKER_STATE = join(work, "fake-docker.json");
  }
  // `"fakeMake": true`: Makefile tasks run against tests/fixtures/fake-make where no real make is
  // installed (Windows without MSYS make); a real one is used where there is one.
  if (/"fakeMake"\s*:\s*true/.test(text) && !hasMake) {
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    env[pathKey] = `${join(root, "tests/fixtures/fake-make")}${delimiter}${env[pathKey] ?? ""}`;
  }
  // Claude Code's folder for plugins (D375) is <work>/claude-home (CLAUDE_CONFIG_DIR, as Claude
  // Code reads it), empty unless a test puts plugins there: the real ~/.claude stays out of tests.
  env.CLAUDE_CONFIG_DIR = join(work, "claude-home");
  await mkdir(join(work, "claude-home", "plugins"), { recursive: true });
  console.log(`\n=== ${script}`);
  const code = headless
    ? await run("xvfb-run", ["-a", binary, ...args], env)
    : await run(binary, args, env);
  console.log(`=== ${script}: ${code === 0 ? "passed" : `FAILED (exit ${code})`}`);
  if (code !== 0) failed++;
  // UI_TEST_KEEP=1 keeps the run's folder to look at (its screenshots are in the sample's
  // data folder, under screenshots/).
  if (process.env.UI_TEST_KEEP) console.log(`=== kept: ${work}`);
  else await rm(work, { recursive: true, force: true }).catch(() => {});
}
const ran = scripts.length - skipped;
console.log(
  `\n${ran - failed}/${ran} test scripts passed${skipped ? ` (${skipped} skipped on this OS)` : ""}`,
);
ending = true;
mock.kill();
devServer.kill();
process.exit(failed === 0 ? 0 : 1);

// End-to-end test of the command-line agent: the real launcher (dist-headless/bin/<name>, the
// `.cmd` on Windows) over the real host program, against the fixtures' scripted model server.
// Plain Node; it builds nothing. The exit code is non-zero when a scenario fails.
//
//   node scripts/cli-e2e.mjs [--host <ide-host>] [--bundle <dist-headless>] [--keep] [filter]
//
// Build first:
//   (in src-tauri/) cargo build --no-default-features --features host --bin ide-host
//   node build.mjs --headless
// Without --host: `ide-host` in $CARGO_TARGET_DIR/debug, else src-tauri/target/debug.
//
// Everything it writes goes to a folder beside the repository, removed at the end (--keep leaves
// it): a copy of tests/fixtures/sample as the workspace (a git repository of its own), a plain
// folder with spaces and letters beyond ASCII in its name, and a profile of its own
// (`--user-data-dir`) whose user settings point at the mock. Never the user's settings, keys or
// chats; IDE_NO_KEYCHAIN keeps test keys out of the OS keychain. The model server is
// tests/fixtures/mock-ollama.mjs on a free port.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const self = fileURLToPath(import.meta.url);
const root = resolve(dirname(self), "..");
const windows = process.platform === "win32";
const product = JSON.parse(readFileSync(join(root, "product.json"), "utf8"));
const cliName = String(product.nameShort).toLowerCase();

const argv = process.argv.slice(2);
const option = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv.splice(at, 2)[1] : undefined;
};
const exe = windows ? "ide-host.exe" : "ide-host";
const host = resolve(
  option("--host") ??
    join(process.env.CARGO_TARGET_DIR ?? join(root, "src-tauri", "target"), "debug", exe),
);
const bundle = resolve(option("--bundle") ?? join(root, "dist-headless"));
const keep = argv.includes("--keep");
const filter = argv.find((a) => !a.startsWith("--"));
const launcher = join(bundle, "bin", windows ? `${cliName}.cmd` : cliName);
if (!existsSync(host)) {
  console.error(`cli-e2e: no host program at ${host} (build it, or pass --host).`);
  process.exit(2);
}
if (!existsSync(launcher) || !existsSync(join(bundle, "cli.mjs"))) {
  console.error(`cli-e2e: no command line in ${bundle} (run: node build.mjs --headless).`);
  process.exit(2);
}

const scratch = resolve(root, "..", `.cli-e2e-${process.pid}`);
const workspace = join(scratch, "sample");
const profile = join(scratch, "profile");
/** A plain folder (no repository), with spaces and letters beyond ASCII in its path. */
const plain = join(scratch, "wörk späce ünï");
const MODEL = "ollama/mock-coder:1b";
let port = 0;

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: join(scratch, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  // Git's search for a repository stops here: the scratch folder sits inside another one.
  GIT_CEILING_DIRECTORIES: scratch,
  IDE_NO_KEYCHAIN: "1",
  IDE_HOST_PATH: host,
};
for (const name of ["NO_COLOR", "FORCE_COLOR", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"])
  delete env[name];

// ---- Running the command line ------------------------------------------------------------------

/** One argument for cmd.exe's command line (quoted when it holds anything but plain characters). */
const quoted = (arg) => (/^[\w\-.:/\\=,@+]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`);

/** Starts the launcher with `args`. On Windows through cmd.exe, as a person's shell would. */
function start(args, options = {}) {
  const childEnv = { ...env, ...options.env };
  const stdio = [
    options.stdin === undefined && !options.interactive ? "ignore" : "pipe",
    "pipe",
    "pipe",
  ];
  const proc = windows
    ? spawn(
        process.env.ComSpec ?? "cmd.exe",
        ["/d", "/s", "/c", `"${[quoted(launcher), ...args.map(quoted)].join(" ")}"`],
        { env: childEnv, stdio, windowsVerbatimArguments: true, cwd: options.cwd ?? scratch },
      )
    : spawn(launcher, args, { env: childEnv, stdio, cwd: options.cwd ?? scratch });
  let stdout = "";
  let stderr = "";
  const waiters = [];
  const check = () => {
    for (const w of [...waiters]) {
      const m = w.pattern.exec(w.stream === "stderr" ? stderr.slice(w.from) : stdout.slice(w.from));
      if (m) {
        waiters.splice(waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(m);
      }
    }
  };
  proc.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
    options.onStdout?.(chunk);
    check();
  });
  proc.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
    check();
  });
  const exited = new Promise((done) => {
    proc.on("exit", (code, signal) => done({ code, signal }));
    proc.on("error", (error) => done({ code: null, signal: null, error }));
  });
  return {
    proc,
    exited,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    write: (text) => proc.stdin.write(text),
    end: () => proc.stdin.end(),
    /** Resolves when `pattern` shows up in the output written after the last match. */
    expect: (pattern, { timeout = 30_000, stream = "stdout", from } = {}) =>
      new Promise((done, failed) => {
        const w = { pattern, stream, from: from ?? 0, resolve: done };
        w.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          failed(
            new Error(
              `no ${pattern} in ${stream} after ${timeout} ms\n--- stdout\n${stdout.slice(-6000)}\n--- stderr\n${stderr.slice(-2000)}`,
            ),
          );
        }, timeout);
        waiters.push(w);
        check();
      }),
    kill: () => killTree(proc.pid),
  };
}

/** Runs the launcher to its end. `stdin`: text to pipe in (then closed). */
async function run(args, options = {}) {
  const started = Date.now();
  const child = start(args, options);
  if (options.stdin !== undefined) {
    child.proc.stdin.on("error", () => {});
    child.proc.stdin.end(options.stdin);
  }
  const timeout = options.timeout ?? 90_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeout);
  const { code } = await child.exited;
  clearTimeout(timer);
  if (timedOut)
    throw new Error(
      `still running after ${timeout} ms: ${args.join(" ")}\n--- stdout\n${child.stdout.slice(-2000)}\n--- stderr\n${child.stderr.slice(-2000)}`,
    );
  return { code, stdout: child.stdout, stderr: child.stderr, ms: Date.now() - started };
}

function killTree(pid) {
  if (!pid) return;
  if (windows) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone already.
    }
  }
}

/** Processes whose command line names the scratch folder: [{ pid, name }]. */
function scratchProcesses() {
  const needle = basename(scratch);
  if (windows) {
    const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${needle}*' } | ForEach-Object { "$($_.ProcessId)|$($_.Name)" }`;
    const out = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
    }).stdout;
    return String(out ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim().split("|"))
      .filter(([pid, name]) => pid && name && !/^powershell/i.test(name))
      .map(([pid, name]) => ({ pid: Number(pid), name }));
  }
  const out = spawnSync("ps", ["-eo", "pid=,comm=,args="], { encoding: "utf8" }).stdout;
  return String(out ?? "")
    .split("\n")
    .filter((line) => line.includes(needle))
    .map((line) => {
      const [pid, name] = line.trim().split(/\s+/);
      return { pid: Number(pid), name: basename(name ?? "") };
    });
}

const base = (...more) => ["--cwd", workspace, "--user-data-dir", profile, ...more];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const jsonOf = (text) => JSON.parse(text.trim().split("\n").at(-1));

// ---- Scenarios ---------------------------------------------------------------------------------

/** What earlier scenarios leave for later ones. */
const state = { first: null, last: null };

const scenarios = [
  {
    name: "--version, --help and a subcommand's help start nothing and exit 0",
    run: async () => {
      const version = await run(["--version"]);
      equal(version.code, 0);
      equal(
        version.stdout.trim(),
        `${cliName} ${JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version}`,
      );
      ok(version.ms < 5000, `--version took ${version.ms} ms`);
      const help = await run(["--help"]);
      equal(help.code, 0);
      for (const flag of [
        "--prompt",
        "--continue",
        "--resume",
        "--permission-mode",
        "--allow",
        "--output-format",
        "--max-steps",
        "--add-dir",
        "--user-data-dir",
        "--host",
      ])
        ok(help.stdout.includes(flag), `--help lacks ${flag}`);
      match(help.stdout, /Exit codes:/);
      for (const topic of ["exec", "sessions", "serve", "acp"]) {
        const sub = await run(["help", topic]);
        equal(sub.code, 0, topic);
        match(sub.stdout, new RegExp(`${cliName} ${topic}`));
        const flagged = await run([topic, "--help"]);
        equal(flagged.stdout, sub.stdout, `${topic} --help`);
      }
    },
  },
  {
    name: "an unknown flag is bad usage (exit 2) with a suggestion; so are bad values",
    run: async () => {
      const unknown = await run(base("-p", "x", "--permision-mode", "ask"));
      equal(unknown.code, 2);
      match(unknown.stderr, /Unknown option --permision-mode\. Did you mean --permission-mode\?/);
      equal(unknown.stdout, "");
      equal((await run(base("-p", "x", "--output-format", "xml"))).code, 2);
      equal((await run(["sessions", "frobnicate"])).code, 2);
      const noFolder = await run([
        "-p",
        "x",
        "--cwd",
        join(scratch, "nowhere"),
        "--user-data-dir",
        profile,
      ]);
      equal(noFolder.code, 2);
      match(noFolder.stderr, /Not a folder/);
    },
  },
  {
    name: "the host program missing: a clear message, exit 2",
    run: async () => {
      const r = await run(
        base("-p", "which model answers?", "--host", join(scratch, "no-such-host")),
      );
      equal(r.code, 2);
      match(r.stderr, /No host program at .*no-such-host/);
      // Something that isn't the host: it never answers the handshake.
      const wrong = await run(base("-p", "which model answers?", "--host", process.execPath));
      equal(wrong.code, 2);
      match(wrong.stderr, /Couldn't start the host/);
    },
  },
  {
    name: "one shot, text: the model from the user's settings, the answer alone on stdout",
    run: async () => {
      const r = await run(base("-p", "which model answers?"));
      equal(r.code, 0, r.stderr);
      equal(r.stdout, "Answered by mock-coder:1b\n");
      // A folder nobody trusted: said once, on stderr.
      match(r.stderr, /isn't trusted/);
      // Positional, with input that isn't a terminal, and `exec`.
      equal((await run(base("which model answers?"))).stdout, "Answered by mock-coder:1b\n");
      equal(
        (await run(["exec", "which model answers?", ...base()])).stdout,
        "Answered by mock-coder:1b\n",
      );
    },
  },
  {
    name: "a folder nobody decided about is said to be untrusted; --trust trusts it and is remembered",
    run: async () => {
      // Undecided, as in the app before its question is answered: the rules file is read (only
      // a restricted folder's isn't), and what the folder would run by itself is off.
      const before = await run(base("-p", "cli e2e: context"));
      equal(before.code, 0, before.stderr);
      match(before.stderr, /isn't trusted/);
      match(before.stdout, /rules=yes/);
      const trusted = await run(base("-p", "cli e2e: context", "--trust"));
      equal(trusted.code, 0, trusted.stderr);
      match(trusted.stdout, /rules=yes/);
      ok(!/isn't trusted/.test(trusted.stderr), "trusted, and still told it isn't");
      const after = await run(base("-p", "cli e2e: context"));
      match(after.stdout, /rules=yes/);
      ok(!/isn't trusted/.test(after.stderr), "the decision was not remembered");
    },
  },
  {
    name: "instructions as in the app: rules, memory, a skill, the user's own agent by name",
    run: async () => {
      const r = await run(base("-p", "cli e2e: context"));
      match(r.stdout, /rules=yes/);
      match(r.stdout, /memory=yes/);
      match(r.stdout, /skill=yes/);
      match(r.stdout, /agent=no/);
      const agent = await run(base("-p", "cli e2e: context", "--agent", "cli-e2e-agent"));
      equal(agent.code, 0, agent.stderr);
      match(agent.stdout, /agent=yes/);
      const unknown = await run(base("-p", "x", "--agent", "cli-e2e-agnt"));
      equal(unknown.code, 2);
      match(unknown.stderr, /No agent named cli-e2e-agnt\. Did you mean cli-e2e-agent\?/);
    },
  },
  {
    name: "a subagent by name, with its own instructions",
    run: async () => {
      const r = await run(base("-p", "cli e2e: delegate", "--permission-mode", "full-access"));
      equal(r.code, 0, r.stderr);
      match(r.stdout, /Delegated: .*Sub: instructions=yes/);
    },
  },
  {
    name: "json: one result object; a file edit lands on disk; a command allowed by --allow",
    run: async () => {
      await rm(join(workspace, "headless-e2e.txt"), { force: true });
      const r = await run(
        base("-p", "headless e2e: write and run", "--allow", "echo", "--output-format", "json"),
      );
      equal(r.code, 0, r.stderr);
      equal(r.stdout.trim().split("\n").length, 1, "one line of JSON");
      const result = JSON.parse(r.stdout);
      equal(result.type, "result");
      equal(result.ok, true);
      equal(result.exitCode, 0);
      equal(result.text, "Headless: wrote=yes ran=yes");
      equal(result.reason, "end");
      equal(result.steps, 3);
      deepEqual(result.pending, []);
      ok(result.usage.totals.requests >= 3);
      equal(
        (await readFile(join(workspace, "headless-e2e.txt"), "utf8")).trim(),
        "written with no window",
      );
      state.first = result.session;
    },
  },
  {
    name: "stream-json: every event on a line, the result last",
    run: async () => {
      await rm(join(workspace, "headless-e2e.txt"), { force: true });
      const r = await run(
        base(
          "-p",
          "headless e2e: write and run",
          "--allow",
          "echo",
          "--output-format",
          "stream-json",
        ),
      );
      equal(r.code, 0, r.stderr);
      const lines = r.stdout
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      const types = lines.map((l) => l.type);
      equal(types[0], "session");
      equal(types.at(-1), "result");
      for (const type of [
        "turn.start",
        "text",
        "tool.start",
        "tool.end",
        "edit",
        "permission.decision",
        "usage",
        "turn.end",
      ])
        ok(types.includes(type), `no ${type} event`);
      equal(
        lines
          .filter((l) => l.type === "text")
          .map((l) => l.delta)
          .join(""),
        "Headless: wrote=yes ran=yes",
      );
      const decision = lines.find((l) => l.type === "permission.decision");
      deepEqual([decision.answer, decision.by, decision.rule], ["once", "policy", "echo"]);
      equal(lines.at(-1).text, "Headless: wrote=yes ran=yes");
      equal(lines.at(-1).session, lines[0].session);
    },
  },
  {
    name: "a command that needs permission is refused with nobody to ask: exit 3",
    run: async () => {
      const r = await run(base("-p", "headless e2e: push", "--non-interactive"));
      equal(r.code, 3, r.stderr);
      equal(r.stdout, "Headless push: refused\n");
      match(r.stderr, /Refused: git push origin main/);
      const json = await run(base("-p", "headless e2e: push", "--output-format", "json"));
      equal(json.code, 3);
      const result = JSON.parse(json.stdout);
      deepEqual(
        [result.ok, result.exitCode, result.denied.length, result.denied[0].code],
        [false, 3, 1, "git push origin main"],
      );
    },
  },
  {
    name: "the same command allowed with --allow; refused by --deny even with full access",
    run: async () => {
      const allowed = await run(base("-p", "headless e2e: push", "--allow", "git push"));
      equal(allowed.code, 0, allowed.stderr);
      equal(allowed.stdout, "Headless push: ran\n");
      const mode = await run(base("-p", "headless e2e: push", "--permission-mode", "full-access"));
      equal(mode.code, 0, mode.stderr);
      equal(mode.stdout, "Headless push: ran\n");
      const denied = await run(
        base(
          "-p",
          "headless e2e: push",
          "--permission-mode",
          "full-access",
          "--deny",
          "git push",
          "--output-format",
          "json",
        ),
      );
      equal(denied.code, 3);
      const result = JSON.parse(denied.stdout);
      equal(result.denied[0].rule, "git push");
      state.last = result.session;
    },
  },
  {
    name: "settings decide when no flag does: the user's file, then --settings, then a flag",
    run: async () => {
      // The user's file alone: commands ask, and nobody is there.
      equal((await run(base("-p", "headless e2e: push"))).code, 3);
      // A flag wins over --settings, which stands above the files.
      const flag = await run(
        base(
          "-p",
          "headless e2e: push",
          "--settings",
          join(scratch, "full.json"),
          "--permission-mode",
          "ask",
        ),
      );
      equal(flag.code, 3, flag.stderr);
      // And the file alone, by its path.
      const file = await run(
        base("-p", "headless e2e: push", "--settings", join(scratch, "full.json")),
      );
      equal(file.stdout, "Headless push: ran\n", file.stderr);
      const bad = await run(base("-p", "x", "--settings", join(scratch, "missing.json")));
      equal(bad.code, 2);
    },
  },
  {
    name: "--continue goes on with the folder's last chat; --resume and --session-id by id",
    run: async () => {
      const last = await run(
        base("-p", "headless e2e: push", "--allow", "git push", "--output-format", "json"),
      );
      state.last = JSON.parse(last.stdout).session;
      const r = await run(
        base("-p", "headless e2e: recall", "--continue", "--output-format", "json"),
      );
      equal(r.code, 0, r.stderr);
      const result = JSON.parse(r.stdout);
      equal(result.text, "Headless recall: remembers");
      equal(result.session, state.last);
      const resumed = await run(
        base("-p", "headless e2e: recall", "--resume", state.first, "--output-format", "json"),
      );
      equal(JSON.parse(resumed.stdout).session, state.first);
      equal(JSON.parse(resumed.stdout).text, "Headless recall: remembers");
      const fresh = await run(base("-p", "headless e2e: recall", "--output-format", "json"));
      equal(JSON.parse(fresh.stdout).text, "Headless recall: nothing");
      const named = await run(
        base(
          "-p",
          "which model answers?",
          "--session-id",
          "cli-e2e-named",
          "--output-format",
          "json",
        ),
      );
      equal(JSON.parse(named.stdout).session, "cli-e2e-named");
      const again = await run(
        base(
          "-p",
          "headless e2e: recall",
          "--session-id",
          "cli-e2e-named",
          "--output-format",
          "stream-json",
        ),
      );
      const opened = JSON.parse(again.stdout.split("\n")[0]);
      ok(opened.items > 0, "the named chat came back");
      const none = await run(base("-p", "x", "--resume", "no-such-chat"));
      equal(none.code, 2);
      match(none.stderr, /No saved chat with the id no-such-chat/);
    },
  },
  {
    name: "sessions list and show: the chats the runs saved",
    run: async () => {
      const list = await run(["sessions", "list", ...base()]);
      equal(list.code, 0, list.stderr);
      ok(list.stdout.includes(state.first), "the first chat is listed");
      ok(list.stdout.includes("cli-e2e-named"));
      const json = await run(["sessions", "list", "--json", ...base()]);
      const chats = JSON.parse(json.stdout);
      ok(chats.length >= 8, `${chats.length} chats`);
      ok(
        chats.every((c) => c.here),
        "only this folder's",
      );
      ok(chats[0].updated >= chats.at(-1).updated, "newest first");
      const show = await run(["sessions", "show", state.first, ...base()]);
      equal(show.code, 0, show.stderr);
      match(show.stdout, /headless e2e: write and run/);
      match(show.stdout, /write_file/);
      match(show.stdout, /Headless: wrote=yes ran=yes/);
      const shown = JSON.parse(
        (await run(["sessions", "show", state.first, "--json", ...base()])).stdout,
      );
      equal(shown.id, state.first);
      ok(shown.items.some((i) => i.type === "tool" && i.name === "run_command"));
      const none = await run(["sessions", "show", "no-such-chat", ...base()]);
      equal(none.code, 2);
      // Another folder has none of them, and --all shows every folder's.
      const other = await run([
        "sessions",
        "list",
        "--json",
        "--cwd",
        plain,
        "--user-data-dir",
        profile,
      ]);
      deepEqual(JSON.parse(other.stdout), []);
      const all = JSON.parse(
        (
          await run([
            "sessions",
            "list",
            "--all",
            "--json",
            "--cwd",
            plain,
            "--user-data-dir",
            profile,
          ])
        ).stdout,
      );
      ok(all.length >= chats.length);
    },
  },
  {
    name: "limits: a timeout and a step limit end the run with exit 1",
    run: async () => {
      const timeout = await run(
        base("-p", "start the long essay", "--timeout", "2.5", "--output-format", "json"),
      );
      equal(timeout.code, 1, timeout.stderr);
      equal(JSON.parse(timeout.stdout).reason, "timeout");
      match(timeout.stderr, /time limit/);
      ok(timeout.ms < 30_000, `took ${timeout.ms} ms`);
      const steps = await run(
        base(
          "-p",
          "headless e2e: write and run",
          "--permission-mode",
          "full-access",
          "--max-steps",
          "1",
          "--output-format",
          "json",
        ),
      );
      equal(steps.code, 1, steps.stderr);
      deepEqual(
        [JSON.parse(steps.stdout).reason, JSON.parse(steps.stdout).steps],
        ["max_steps", 1],
      );
    },
  },
  {
    name: "input: piped stdin as the prompt, as context for a prompt, and --prompt-file",
    run: async () => {
      const piped = await run(base(), { stdin: "which model answers?\n" });
      equal(piped.code, 0, piped.stderr);
      equal(piped.stdout, "Answered by mock-coder:1b\n");
      const viaDash = await run(["exec", "-", ...base()], { stdin: "which model answers?" });
      equal(viaDash.stdout, "Answered by mock-coder:1b\n");
      const context = await run(base("-p", "cli e2e: context"), {
        stdin: "a log line with cli-e2e-stdin-marker\n",
      });
      match(context.stdout, /stdin=yes/);
      const without = await run(base("-p", "cli e2e: context"), { stdin: "" });
      match(without.stdout, /stdin=no/);
      const file = await run(base("--prompt-file", join(scratch, "prompt.md")));
      equal(file.stdout, "Answered by mock-coder:1b\n", file.stderr);
      const empty = await run(base(), { stdin: "   \n" });
      equal(empty.code, 2);
      match(empty.stderr, /No prompt/);
    },
  },
  {
    name: "ask and plan modes are read-only; --review holds an edit, the default writes it",
    run: async () => {
      for (const mode of ["ask", "plan"]) {
        await rm(join(workspace, "cli-e2e-mode.txt"), { force: true });
        const r = await run(
          base("-p", "cli e2e: try write", "--mode", mode, "--permission-mode", "full-access"),
        );
        equal(r.code, 0, r.stderr);
        ok(
          !existsSync(join(workspace, "cli-e2e-mode.txt")),
          `${mode} mode wrote a file: ${r.stdout}`,
        );
      }
      const review = await run(
        base("-p", "cli e2e: try write", "--review", "--output-format", "json"),
      );
      equal(review.code, 0, review.stderr);
      // As in the app: the edit is in the file and waits for review (the next session rejects
      // or accepts it).
      equal(JSON.parse(review.stdout).pending.length, 1);
      match(review.stderr, /wait for review/);
      ok(existsSync(join(workspace, "cli-e2e-mode.txt")), "the reviewed edit is not in the file");
      const later = await run(
        base("--interactive", "--resume", JSON.parse(review.stdout).session),
        {
          stdin: "/diff\n/reject\n/exit\n",
        },
      );
      match(later.stdout, /cli-e2e-mode\.txt {2}\+1 -0/);
      ok(
        !existsSync(join(workspace, "cli-e2e-mode.txt")),
        `/reject left the file: ${later.stdout}`,
      );
      const direct = await run(base("-p", "cli e2e: try write", "--output-format", "json"));
      deepEqual(JSON.parse(direct.stdout).pending, []);
      ok(existsSync(join(workspace, "cli-e2e-mode.txt")), "the edit was not written");
      await rm(join(workspace, "cli-e2e-mode.txt"), { force: true });
    },
  },
  {
    name: "hooks from the user's settings run, and an MCP server's tool is used",
    run: async () => {
      await rm(join(scratch, "hook-ran.txt"), { force: true });
      const r = await run(base("-p", "Please use the echo server", "--allow", "mcp__echo__*"));
      equal(r.code, 0, r.stderr);
      match(r.stdout, /MCP said: HELLO/);
      ok(existsSync(join(scratch, "hook-ran.txt")), "the UserPromptSubmit hook did not run");
      match(await readFile(join(scratch, "hook-ran.txt"), "utf8"), /UserPromptSubmit/);
    },
  },
  {
    name: "an external agent over ACP (the fixtures' mock agent)",
    run: async () => {
      const r = await run(
        base(
          "-p",
          "add a line to the readme",
          "--model",
          "Mock agent",
          "--permission-mode",
          "full-access",
        ),
      );
      equal(r.code, 0, r.stderr);
      match(r.stdout, /^ACP done on /);
      match(await readFile(join(workspace, "README.md"), "utf8"), /Added by ACP\./);
      const byAgent = await run(
        base(
          "-p",
          "add a line to the readme",
          "--agent",
          "Mock agent",
          "--permission-mode",
          "full-access",
          "--output-format",
          "json",
        ),
      );
      equal(byAgent.code, 0, byAgent.stderr);
      match(JSON.parse(byAgent.stdout).text, /^ACP done on /);
    },
  },
  {
    name: "a keyed provider (Anthropic's API on the mock): the key typed once, kept in the app's store, never printed",
    run: async () => {
      const keyed = ["--settings", join(scratch, "keyed.json")];
      // A key the provider rejects: no model of it is offered, and the run says what to do.
      const bad = await run(base("--interactive", ...keyed), {
        stdin: "/key claude\nbad-key\n/exit\n",
      });
      equal(bad.code, 0, bad.stderr);
      ok(!`${bad.stdout}${bad.stderr}`.includes("bad-key"), "the typed key was echoed");
      const rejected = await run(base("-p", "hello", "--model", "claude/claude-mock", ...keyed));
      equal(rejected.code, 2, rejected.stdout);
      match(rejected.stderr, /isn't available/);
      match(rejected.stderr, /What to do/);
      // A good one: stored for the provider, used by the next run, and nowhere in any output.
      const good = await run(base("--interactive", ...keyed), {
        stdin: "/key claude\nsk-cli-e2e-secret\n/model claude/claude-mock\nhello\n/exit\n",
      });
      equal(good.code, 0, good.stderr);
      match(good.stdout, /Key stored for claude/);
      match(good.stdout, /Hello from mock\./);
      const r = await run(
        base(
          "-p",
          "hello",
          "--model",
          "claude/claude-mock",
          ...keyed,
          "--verbose",
          "--output-format",
          "stream-json",
        ),
      );
      equal(r.code, 0, r.stderr);
      equal(jsonOf(r.stdout).text, "Hello from mock.");
      for (const out of [good, r])
        ok(!`${out.stdout}${out.stderr}`.includes("sk-cli-e2e-secret"), "the key was printed");
    },
  },
  {
    name: "no model configured: what to do, exit 2",
    run: async () => {
      const r = await run([
        "-p",
        "hello",
        "--cwd",
        plain,
        "--user-data-dir",
        join(scratch, "empty-profile"),
        "--settings",
        join(scratch, "nomodel.json"),
      ]);
      equal(r.code, 2, r.stdout);
      match(r.stderr, /No model is available/);
      match(r.stderr, /Ollama/);
      const json = await run([
        "-p",
        "hello",
        "--output-format",
        "json",
        "--cwd",
        plain,
        "--user-data-dir",
        join(scratch, "empty-profile"),
        "--settings",
        join(scratch, "nomodel.json"),
      ]);
      deepEqual(
        [
          JSON.parse(json.stdout).ok,
          JSON.parse(json.stdout).exitCode,
          JSON.parse(json.stdout).reason,
        ],
        [false, 2, "config"],
      );
    },
  },
  {
    name: "a folder that isn't a repository, with spaces and letters beyond ASCII; --add-dir",
    run: async () => {
      const r = await run([
        "-p",
        "headless e2e: write and run",
        "--allow",
        "echo",
        "--cwd",
        plain,
        "--user-data-dir",
        profile,
        "--output-format",
        "json",
      ]);
      equal(r.code, 0, r.stderr);
      equal(JSON.parse(r.stdout).text, "Headless: wrote=yes ran=yes");
      equal(
        (await readFile(join(plain, "headless-e2e.txt"), "utf8")).trim(),
        "written with no window",
      );
      // From inside the folder, with no --cwd.
      const here = await run(["-p", "which model answers?", "--user-data-dir", profile], {
        cwd: plain,
      });
      equal(here.stdout, "Answered by mock-coder:1b\n", here.stderr);
      // An extra folder joins the workspace for the run.
      const added = await run([
        "-p",
        "which model answers?",
        "--cwd",
        plain,
        "--add-dir",
        workspace,
        "--user-data-dir",
        profile,
        "--verbose",
      ]);
      equal(added.code, 0, added.stderr);
      equal(added.stdout, "Answered by mock-coder:1b\n");
      const missing = await run([
        "-p",
        "x",
        "--cwd",
        plain,
        "--add-dir",
        join(scratch, "nowhere"),
        "--user-data-dir",
        profile,
      ]);
      equal(missing.code, 2);
    },
  },
  {
    name: "two runs at once in the same folder and profile both finish, and both chats are saved",
    run: async () => {
      const [a, b] = await Promise.all([
        run(
          base("-p", "headless e2e: write and run", "--allow", "echo", "--output-format", "json"),
        ),
        run(base("-p", "headless e2e: push", "--allow", "git push", "--output-format", "json")),
      ]);
      equal(a.code, 0, a.stderr);
      equal(b.code, 0, b.stderr);
      const ids = [JSON.parse(a.stdout).session, JSON.parse(b.stdout).session];
      ok(ids[0] !== ids[1], "the two runs share a chat id");
      const chats = JSON.parse((await run(["sessions", "list", "--json", ...base()])).stdout);
      for (const id of ids)
        ok(
          chats.some((c) => c.id === id),
          `chat ${id} is not saved`,
        );
      // Every saved chat is whole JSON.
      const folder = join(profile, "data", "agent", "sessions");
      for (const file of await readdir(folder))
        if (file.endsWith(".json")) JSON.parse(await readFile(join(folder, file), "utf8"));
      JSON.parse(await readFile(join(profile, "data", "state.json"), "utf8"));
    },
  },
  {
    name: "output to a reader that leaves early ends quietly",
    run: async () => {
      const child = start(base("-p", "start the long essay", "--output-format", "stream-json"));
      await child.expect(/"type":"turn.start"/);
      child.proc.stdout.destroy();
      const { code } = await Promise.race([
        child.exited,
        sleep(20_000).then(() => ({ code: "still running" })),
      ]);
      if (code === "still running") child.kill();
      ok(code !== "still running", "the run went on with nobody reading");
      ok(!/EPIPE|Unexpected error/.test(child.stderr), child.stderr);
    },
  },
  {
    name: "the host dying mid-turn: a clear error, exit 1, no hang",
    run: async () => {
      const mine = () =>
        scratchProcesses()
          .filter((p) => /ide-host/i.test(p.name))
          .map((p) => p.pid);
      const before = new Set(mine());
      const child = start(base("-p", "start the long essay", "--output-format", "stream-json"));
      await child.expect(/"type":"turn.start"/);
      const hosts = mine().filter((pid) => !before.has(pid));
      equal(hosts.length, 1, `host processes of this run: ${hosts.join(",")}`);
      process.kill(hosts[0]);
      const { code } = await Promise.race([
        child.exited,
        sleep(20_000).then(() => ({ code: "still running" })),
      ]);
      if (code === "still running") child.kill();
      equal(code, 1, child.stderr);
      match(child.stderr, /host program ended unexpectedly/);
      const last = jsonOf(child.stdout);
      deepEqual([last.type, last.ok, last.exitCode], ["result", false, 1]);
    },
  },
  {
    name: "Ctrl+C on a one-shot run: exit 130, the turn stopped (signals; not on Windows)",
    skip: windows ? "a console Ctrl+C can't be sent to one child process here" : false,
    run: async () => {
      const child = start(base("-p", "start the long essay", "--output-format", "stream-json"));
      await child.expect(/"type":"turn.start"/);
      child.proc.kill("SIGINT");
      const { code } = await Promise.race([
        child.exited,
        sleep(20_000).then(() => ({ code: "still running" })),
      ]);
      if (code === "still running") child.kill();
      equal(code, 130, child.stderr);
      equal(jsonOf(child.stdout).reason, "cancelled");
    },
  },
  {
    name: "the interactive session over a pipe: a prompt, a streamed answer, a permission asked and answered, slash commands, Ctrl+C, exit",
    run: async () => {
      await rm(join(workspace, "headless-e2e.txt"), { force: true });
      const child = start(base("--interactive", "--trust", "--permission-mode", "accept-edits"), {
        interactive: true,
      });
      try {
        await child.expect(new RegExp(`${cliName} \\d+\\.\\d+`));
        await child.expect(/\/help lists the commands/);
        child.write("which model answers?\n");
        await child.expect(/Answered by mock-coder:1b/);
        // The status line: model, mode, access.
        await child.expect(/ollama\/mock-coder:1b · agent · accept-edits/);
        // Markdown passes through plain when the output isn't a terminal.
        let mark = child.stdout.length;
        child.write("cli e2e: markdown\n");
        await child.expect(/# Title\n\nSome \*\*bold\*\* and `code`\.\n\n- one\n- two/, {
          from: mark,
        });
        // A command asks; the answer is typed.
        mark = child.stdout.length;
        child.write("headless e2e: write and run\n");
        await child.expect(/write_file .*headless-e2e\.txt/, { from: mark });
        await child.expect(/echo headless-e2e-ran[\s\S]*\[y\] yes, once/, { from: mark });
        child.write("y\n");
        await child.expect(/Headless: wrote=yes ran=yes/, { from: mark });
        equal(
          (await readFile(join(workspace, "headless-e2e.txt"), "utf8")).trim(),
          "written with no window",
        );
        // Refusing: the agent is told.
        mark = child.stdout.length;
        child.write("headless e2e: push\n");
        await child.expect(/git push origin main[\s\S]*\[y\] yes, once/, { from: mark });
        child.write("n\n");
        await child.expect(/Headless push: refused/, { from: mark });
        // The agent's own question.
        mark = child.stdout.length;
        child.write("cli e2e: ask me\n");
        await child.expect(/Which color\?[\s\S]*1\. Red[\s\S]*2\. Blue/, { from: mark });
        child.write("2\n");
        await child.expect(/Asked: .*Blue/, { from: mark });
        // Slash commands: the session's own and the app's.
        mark = child.stdout.length;
        child.write("/help\n");
        await child.expect(/\/model \[name\|number\][\s\S]*The agent's commands[\s\S]*\/undo/, {
          from: mark,
        });
        mark = child.stdout.length;
        child.write("/model\n");
        await child.expect(/1 {2}ollama\/mock-coder:1b {2}\(current\)/, { from: mark });
        mark = child.stdout.length;
        child.write("/permissions\n");
        await child.expect(/Access: accept-edits/, { from: mark });
        child.write("/permissions ask\n");
        await child.expect(/Access: ask\n/, { from: mark });
        mark = child.stdout.length;
        child.write("/mode plan\n");
        await child.expect(/Mode: plan/, { from: mark });
        child.write("/mode agent\n");
        await child.expect(/Mode: agent/, { from: mark });
        mark = child.stdout.length;
        child.write("/cost\n");
        await child.expect(/Requests: \d+\nTokens: /, { from: mark });
        mark = child.stdout.length;
        child.write("/status\n");
        await child.expect(/Folder: .*sample \(trusted\)[\s\S]*Access: ask/, { from: mark });
        // Review: in the ask mode an edit waits; /diff shows it, /reject puts the file back,
        // /accept keeps it.
        await rm(join(workspace, "cli-e2e-mode.txt"), { force: true });
        mark = child.stdout.length;
        child.write("cli e2e: try write\n");
        await child.expect(/1 file waits for review/, { from: mark });
        child.write("/diff\n");
        await child.expect(/cli-e2e-mode\.txt {2}\+1 -0[\s\S]*\+x/, { from: mark });
        child.write("/reject\n");
        await child.expect(/Dropped: .*cli-e2e-mode\.txt/, { from: mark });
        ok(!existsSync(join(workspace, "cli-e2e-mode.txt")), "/reject left the file");
        mark = child.stdout.length;
        child.write("cli e2e: try write\n");
        await child.expect(/1 file waits for review/, { from: mark });
        child.write("/accept\n");
        await child.expect(/Kept: .*cli-e2e-mode\.txt/, { from: mark });
        ok(existsSync(join(workspace, "cli-e2e-mode.txt")), "/accept lost the file");
        mark = child.stdout.length;
        child.write("/diff\n");
        await child.expect(/No edits wait for review/, { from: mark });
        // A checkpoint: /undo (the app's command) puts the files back.
        child.write("/permissions accept-edits\n");
        await rm(join(workspace, "cli-e2e-mode.txt"), { force: true });
        mark = child.stdout.length;
        child.write("cli e2e: try write\n");
        await child.expect(/Write: /, { from: mark });
        ok(existsSync(join(workspace, "cli-e2e-mode.txt")), "accept-edits did not write the file");
        mark = child.stdout.length;
        child.write("/undo\n");
        // What can't be taken back is confirmed first, as the app's dialog does.
        await child.expect(/Restore files to before turn[\s\S]*\[y\] yes {2}\[n\] no/, {
          from: mark,
        });
        child.write("y\n");
        await child.expect(/\[n\] no > y\n[\s\S]*\n> /, { from: mark });
        ok(
          !existsSync(join(workspace, "cli-e2e-mode.txt")),
          `/undo left the file: ${child.stdout.slice(mark)}`,
        );
        // A message over several lines.
        mark = child.stdout.length;
        child.write("headless e2e: recall \\\nplease\n");
        await child.expect(/… please\n[\s\S]*Headless recall: remembers/, { from: mark });
        // /compact, /sessions, /new, /resume.
        mark = child.stdout.length;
        child.write("/compact\n");
        await child.expect(/Summarized \d+ messages|summarized/i, { from: mark });
        mark = child.stdout.length;
        child.write("/sessions\n");
        await child.expect(/ 1 {2}\S+ +(just now|\d+ min ago)/, { from: mark });
        mark = child.stdout.length;
        child.write("/new\n");
        await child.expect(/New chat\./, { from: mark });
        child.write("headless e2e: recall\n");
        await child.expect(/Headless recall: nothing/, { from: mark });
        mark = child.stdout.length;
        child.write(`/resume ${state.first}\n`);
        await child.expect(/Resumed/, { from: mark });
        child.write("headless e2e: recall\n");
        await child.expect(/Headless recall: remembers/, { from: mark });
        // Ctrl+C (its byte on a pipe) stops the turn; the session goes on.
        mark = child.stdout.length;
        child.write("start the long essay\n");
        await child.expect(/> start the long essay/, { from: mark });
        await sleep(1500);
        child.write("\x03");
        await child.expect(/Stopping…[\s\S]*\n> /, { from: mark });
        mark = child.stdout.length;
        child.write("which model answers?\n");
        await child.expect(/Answered by mock-coder:1b/, { from: mark });
        child.write("/exit\n");
        const { code } = await Promise.race([
          child.exited,
          sleep(20_000).then(() => ({ code: "still running" })),
        ]);
        equal(code, 0, child.stderr);
      } finally {
        child.kill();
      }
    },
  },
  {
    name: "the interactive session: lines piped at once run in order; the end of input ends it; Ctrl+C twice quits (130)",
    run: async () => {
      const r = await run(base("--interactive"), {
        stdin: "which model answers?\n/cost\nheadless e2e: recall\n",
      });
      equal(r.code, 0, r.stderr);
      match(r.stdout, /Answered by mock-coder:1b[\s\S]*Requests: 1[\s\S]*Headless recall: /);
      // An initial prompt, then the session.
      const first = await run(base("--interactive", "which model answers?"), { stdin: "/exit\n" });
      equal(first.code, 0, first.stderr);
      match(first.stdout, /> which model answers\?\nAnswered by mock-coder:1b/);
      const child = start(base("--interactive"), { interactive: true });
      try {
        await child.expect(/\/help lists the commands/);
        child.write("start the long essay\n");
        await child.expect(/> start the long essay/);
        await sleep(1000);
        child.write("\x03");
        await sleep(200);
        child.write("\x03");
        const { code } = await Promise.race([
          child.exited,
          sleep(20_000).then(() => ({ code: "still running" })),
        ]);
        equal(code, 130, child.stdout.slice(-500));
      } finally {
        child.kill();
      }
    },
  },
  {
    name: "the interactive session in a real terminal (the host's pseudo-terminal): styled Markdown, a question, Ctrl+C as a key",
    run: async () => {
      const pty = await hostPty(
        process.execPath,
        [join(bundle, "cli.mjs"), "--cwd", workspace, "--user-data-dir", profile, "--trust"],
        { IDE_NO_KEYCHAIN: "1", IDE_HOST_PATH: host, WT_SESSION: "cli-e2e" },
      );
      try {
        /** The prompt is back at the end of what the terminal shows. */
        const prompt = (from) => pty.expect(/\n> $/, { from });
        await pty.expect(/\/help lists the commands/);
        await prompt(0);
        // The prompt is drawn by readline: a line typed is echoed by it.
        pty.write("which model answers?\r");
        await pty.expect(/> which model answers\?[\s\S]*Answered by mock-coder:1b/);
        await prompt(0);
        // On a terminal the answer's Markdown is styled, and no mark is left in the text.
        let mark = pty.text.length;
        pty.write("cli e2e: markdown\r");
        await pty.expect(/Title\n\nSome bold and code\.\n\n• one\n• two/, { from: mark });
        await prompt(mark);
        // (The pseudo-terminal may redraw: the style's start just before the word is the proof.)
        // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are the point
        ok(/\x1b\[[0-9;]*1m[^\x1b]*bold/.test(pty.raw), "bold isn't styled on a terminal");
        // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are the point
        ok(/\x1b\[[0-9;]*36m[^\x1b]*code/.test(pty.raw), "code isn't styled on a terminal");
        // A permission asked inline, and refused with a key.
        mark = pty.text.length;
        pty.write("headless e2e: push\r");
        await pty.expect(/git push origin main[\s\S]*\[y\] yes, once/, { from: mark });
        pty.write("n\r");
        await pty.expect(/Headless push: refused/, { from: mark });
        await prompt(mark);
        // Ctrl+C is a key here: it stops the turn, and the prompt comes back.
        mark = pty.text.length;
        pty.write("start the long essay\r");
        await pty.expect(/start the long essay/, { from: mark });
        await sleep(1500);
        pty.write("\x03");
        await pty.expect(/Stopping…/, { from: mark });
        await prompt(mark);
        // Ctrl+C on a half-typed line clears it; twice at an empty prompt quits.
        mark = pty.text.length;
        pty.write("half a line");
        await pty.expect(/half a line/, { from: mark });
        pty.write("\x03");
        await sleep(300);
        pty.write("which model answers?\r");
        await pty.expect(/Answered by mock-coder:1b/, { from: mark });
        await prompt(mark);
        mark = pty.text.length;
        pty.write("\x03");
        await pty.expect(/Ctrl\+C again to quit/, { from: mark });
        pty.write("\x03");
        const code = await Promise.race([pty.exited, sleep(20_000).then(() => "still running")]);
        equal(code, 0, pty.text.slice(-800));
      } finally {
        await pty.close();
      }
    },
  },
  {
    name: "serve: a client attaches with the token, runs commands, reads state, follows a chat and answers its question",
    run: async () => {
      const { connectServe } = await import(pathToFileURL(join(bundle, "serve-client.mjs")).href);
      const child = start(["serve", ...base("--permission-mode", "ask")], { interactive: true });
      try {
        const line = await child.expect(/\{"type":"listening".*\}\n/);
        const listening = JSON.parse(line[0]);
        equal(listening.host, "127.0.0.1");
        ok(listening.port > 0 && listening.token.length >= 20);
        // A wrong token is refused.
        const refused = await connectServe({ port: listening.port, token: "wrong" }).then(
          () => "connected",
          (err) => err.code ?? err.message,
        );
        equal(refused, "Unauthorized");
        const client = await connectServe({
          port: listening.port,
          token: listening.token,
          client: "e2e",
        });
        equal(client.hello.protocol, 1);
        deepEqual(client.hello.caller, { kind: "frontend", name: "serve" });
        // One client at a time.
        const second = await connectServe({ port: listening.port, token: listening.token }).then(
          () => "connected",
          (err) => err.code ?? err.message,
        );
        equal(second, "Busy");
        const ws = await client.request("state", { path: "ide://workspace" });
        equal(String(ws.root).replace(/\\/g, "/"), workspace.replace(/\\/g, "/"));
        const chats = await client.request("chats");
        ok(
          chats.some((c) => c.id === state.first),
          "the earlier chats are listed",
        );
        const opened = await client.request("open", { model: MODEL });
        const events = [];
        client.onEvent((event) => {
          events.push(event);
          // The front end answers the waiting question with the app's command.
          if (event.type === "permission.request")
            void client.request("execute", {
              command: "agent.respondPermission",
              input: { session: event.session, id: event.id, answer: "once" },
            });
        });
        await client.request("subscribe", { session: opened.session });
        await rm(join(workspace, "headless-e2e.txt"), { force: true });
        const result = await client.request("send", {
          session: opened.session,
          prompt: "headless e2e: write and run",
        });
        equal(result.text, "Headless: wrote=yes ran=yes");
        equal(result.pending.length, 1, "the ask mode holds the edit for review");
        const types = events.map((e) => e.type);
        equal(types[0], "session");
        for (const type of [
          "text",
          "tool.start",
          "permission.request",
          "permission.decision",
          "turn.end",
        ])
          ok(types.includes(type), `no ${type} event`);
        const accepted = await client.request("execute", {
          command: "agent.acceptAll",
          input: { session: opened.session },
        });
        equal(accepted.accepted.length, 1);
        ok(existsSync(join(workspace, "headless-e2e.txt")));
        const session = await client.request("state", { path: "ide://agent/session" });
        equal(session.status, "idle");
        deepEqual(await client.request("state", { path: "ide://agent/hostPrompts" }), []);
        const bad = await client.request("execute", { command: "no.such.command" }).then(
          () => "ran",
          (err) => err.message,
        );
        match(bad, /no\.such\.command/);
        // A turn stopped from the client.
        const long = client.request("send", {
          session: opened.session,
          prompt: "start the long essay",
        });
        await sleep(1500);
        await client.request("stop", { session: opened.session });
        equal((await long).reason, "stopped");
        await client.request("shutdown");
        const { code } = await Promise.race([
          child.exited,
          sleep(20_000).then(() => ({ code: "still running" })),
        ]);
        equal(code, 0, child.stderr);
      } finally {
        child.kill();
      }
    },
  },
  {
    name: "acp: initialize, a session, a prompt with streamed updates, a permission asked of the client, cancel, load",
    run: async () => {
      const child = start(["acp", ...base("--model", MODEL)], { interactive: true });
      const rpc = jsonRpc(child);
      try {
        const init = await rpc.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
          clientInfo: { name: "e2e", version: "1" },
        });
        equal(init.protocolVersion, 1);
        equal(init.agentCapabilities.loadSession, true);
        equal(init.agentInfo.name, cliName);
        const created = await rpc.request("session/new", { cwd: workspace, mcpServers: [] });
        ok(created.sessionId);
        deepEqual(
          created.modes.availableModes.map((m) => m.id),
          ["ask", "accept-edits", "auto", "full-access", "plan"],
        );
        equal(created.modes.currentModeId, "ask");
        const model = created.configOptions.find((o) => o.category === "model");
        equal(model.currentValue, MODEL);
        ok(created.configOptions.some((o) => o.category === "thought_level"));
        await rpc.request("session/set_mode", {
          sessionId: created.sessionId,
          modeId: "accept-edits",
        });
        // The client is asked about the command and allows it.
        rpc.onRequest("session/request_permission", (params) => {
          rpc.asked.push(params);
          return {
            outcome: {
              outcome: "selected",
              optionId: params.options.find((o) => o.kind === "allow_once").optionId,
            },
          };
        });
        await rm(join(workspace, "headless-e2e.txt"), { force: true });
        const answer = await rpc.request("session/prompt", {
          sessionId: created.sessionId,
          prompt: [{ type: "text", text: "headless e2e: write and run" }],
        });
        equal(answer.stopReason, "end_turn");
        ok(answer.usage.inputTokens > 0);
        await sleep(300);
        const updates = rpc.updates
          .filter((u) => u.sessionId === created.sessionId)
          .map((u) => u.update);
        const text = updates
          .filter((u) => u.sessionUpdate === "agent_message_chunk")
          .map((u) => u.content.text)
          .join("");
        equal(text, "Headless: wrote=yes ran=yes");
        const calls = updates.filter((u) => u.sessionUpdate === "tool_call");
        deepEqual(
          calls.map((c) => [c.kind, c.status]),
          [
            ["edit", "in_progress"],
            ["execute", "in_progress"],
          ],
        );
        const ends = updates.filter((u) => u.sessionUpdate === "tool_call_update" && u.status);
        deepEqual(
          ends.map((c) => c.status),
          ["completed", "completed"],
        );
        const diff = ends[0].content.find((c) => c.type === "diff");
        ok(diff, "the edit's tool call carries no diff");
        equal(diff.newText.trim(), "written with no window");
        match(diff.path, /headless-e2e\.txt$/);
        equal(rpc.asked.length, 1);
        match(rpc.asked[0].toolCall.title, /echo headless-e2e-ran/);
        deepEqual(
          rpc.asked[0].options.map((o) => o.kind),
          ["allow_once", "allow_always", "reject_once"],
        );
        ok(
          updates.some(
            (u) =>
              u.sessionUpdate === "available_commands_update" &&
              u.availableCommands.some((c) => c.name === "undo"),
          ),
          "no slash commands offered",
        );
        // Refused by the client: the agent is told, and the turn still ends.
        rpc.onRequest("session/request_permission", () => ({
          outcome: { outcome: "selected", optionId: "deny" },
        }));
        rpc.updates.length = 0;
        const refused = await rpc.request("session/prompt", {
          sessionId: created.sessionId,
          prompt: [{ type: "text", text: "headless e2e: push" }],
        });
        equal(refused.stopReason, "end_turn");
        await sleep(200);
        equal(
          rpc.updates
            .map((u) => u.update)
            .filter((u) => u.sessionUpdate === "agent_message_chunk")
            .map((u) => u.content.text)
            .join(""),
          "Headless push: refused",
        );
        // The ask mode: an edit waits, and the client decides about the file with its diff.
        await rpc.request("session/set_mode", { sessionId: created.sessionId, modeId: "ask" });
        await rm(join(workspace, "cli-e2e-mode.txt"), { force: true });
        rpc.asked.length = 0;
        rpc.onRequest("session/request_permission", (params) => {
          rpc.asked.push(params);
          return { outcome: { outcome: "selected", optionId: params.options[0].optionId } };
        });
        await rpc.request("session/prompt", {
          sessionId: created.sessionId,
          prompt: [{ type: "text", text: "cli e2e: try write" }],
        });
        const review = rpc.asked.find((a) => a.toolCall.kind === "edit");
        ok(review, "no review request for the held edit");
        equal(review.toolCall.content[0].type, "diff");
        ok(existsSync(join(workspace, "cli-e2e-mode.txt")), "the accepted edit was not written");
        await rm(join(workspace, "cli-e2e-mode.txt"), { force: true });
        // Cancel.
        const long = rpc.request("session/prompt", {
          sessionId: created.sessionId,
          prompt: [{ type: "text", text: "start the long essay" }],
        });
        await sleep(1500);
        rpc.notify("session/cancel", { sessionId: created.sessionId });
        equal((await long).stopReason, "cancelled");
        // A model that isn't there is an error, not a crash.
        const noModel = await rpc
          .request("session/set_config_option", {
            sessionId: created.sessionId,
            configId: "model",
            value: "ollama/nope",
          })
          .then(
            () => "set",
            (err) => err.message,
          );
        match(noModel, /isn't available/);
        // A saved chat is loaded and replayed.
        rpc.updates.length = 0;
        const loaded = await rpc.request("session/load", {
          sessionId: state.first,
          cwd: workspace,
          mcpServers: [],
        });
        ok(loaded.modes);
        const replay = rpc.updates
          .filter((u) => u.sessionId === state.first)
          .map((u) => u.update.sessionUpdate);
        ok(
          replay.includes("user_message_chunk") &&
            replay.includes("agent_message_chunk") &&
            replay.includes("tool_call"),
          replay.join(" "),
        );
        const unknown = await rpc.request("session/prompt", { sessionId: "nope", prompt: [] }).then(
          () => "ok",
          (err) => err.message,
        );
        match(unknown, /No session nope/);
        // Nothing but the protocol was written to standard output.
        for (const l of child.stdout.split("\n")) if (l.trim()) JSON.parse(l);
        child.end();
        const { code } = await Promise.race([
          child.exited,
          sleep(20_000).then(() => ({ code: "still running" })),
        ]);
        equal(code, 0, child.stderr);
      } finally {
        child.kill();
      }
    },
  },
  {
    name: "acp driven by the IDE's own ACP client: this tool as an external agent of itself",
    run: async () => {
      // The outer run talks to the inner one (`<cli> acp`) through src/core/acp/client.ts.
      const answer = await run(
        base(
          "-p",
          "which model answers?",
          "--model",
          "Self",
          "--permission-mode",
          "full-access",
          "--output-format",
          "json",
        ),
      );
      equal(answer.code, 0, answer.stderr);
      equal(JSON.parse(answer.stdout).text, "Answered by mock-coder:1b");
      await rm(join(workspace, "headless-e2e.txt"), { force: true });
      const work = await run(
        base(
          "-p",
          "headless e2e: write and run",
          "--model",
          "Self",
          "--permission-mode",
          "full-access",
          "--output-format",
          "stream-json",
        ),
        { timeout: 120_000 },
      );
      equal(work.code, 0, work.stderr);
      const lines = work.stdout
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      equal(lines.at(-1).text, "Headless: wrote=yes ran=yes");
      ok(
        lines.some((l) => l.type === "tool.start"),
        "the inner agent's tool calls as events",
      );
      equal(
        (await readFile(join(workspace, "headless-e2e.txt"), "utf8")).trim(),
        "written with no window",
      );
      // The inner agent's question reaches the outer run's policy: refused with nobody to ask.
      const refused = await run(
        base(
          "-p",
          "headless e2e: push",
          "--model",
          "Self",
          "--permission-mode",
          "ask",
          "--output-format",
          "json",
        ),
        { timeout: 120_000 },
      );
      equal(JSON.parse(refused.stdout).text, "Headless push: refused", refused.stderr);
    },
  },
  {
    name: "nothing is left running",
    always: true,
    run: async () => {
      // Hosts end when their input closes; give the last ones a moment.
      let left = [];
      for (let i = 0; i < 20; i++) {
        left = scratchProcesses().filter((p) => p.pid !== process.pid && p.pid !== mockPid);
        if (!left.length) break;
        await sleep(500);
      }
      deepEqual(left, []);
    },
  },
];

/** A JSON-RPC peer over a child's stdin and stdout (newline-delimited), as an ACP client is. */
function jsonRpc(child) {
  let next = 1;
  let buffer = "";
  const pending = new Map();
  const handlers = new Map();
  const peer = {
    updates: [],
    asked: [],
    request: (method, params) =>
      new Promise((done, failed) => {
        const id = next++;
        const timer = setTimeout(
          () => failed(new Error(`${method} was not answered\n${child.stderr.slice(-2000)}`)),
          60_000,
        );
        pending.set(id, { done, failed, timer });
        child.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      }),
    notify: (method, params) =>
      child.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`),
    onRequest: (method, handler) => handlers.set(method, handler),
  };
  child.proc.stdout.on("data", (chunk) => {
    buffer += chunk;
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf("\n");
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.method === "session/update") peer.updates.push(message.params);
      else if (message.method && message.id !== undefined) {
        const handler = handlers.get(message.method);
        const result = handler ? handler(message.params) : null;
        child.write(
          `${JSON.stringify(handler ? { jsonrpc: "2.0", id: message.id, result } : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no handler" } })}\n`,
        );
      } else if (message.id !== undefined) {
        const waiting = pending.get(message.id);
        if (!waiting) continue;
        pending.delete(message.id);
        clearTimeout(waiting.timer);
        if (message.error) waiting.failed(new Error(message.error.message));
        else waiting.done(message.result);
      }
    }
  });
  return peer;
}

/**
 * Runs `program` in a pseudo-terminal of the host's own (the one the IDE's terminals use: ConPTY
 * on Windows), so the command line sees a real terminal: the host is started for this alone and
 * spoken to in its wire format (docs: the contract's frames).
 */
async function hostPty(program, args, extraEnv) {
  const proc = spawn(host, ["--user-data-dir", join(scratch, "pty-profile")], {
    env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  let buffer = Buffer.alloc(0);
  let nextId = 1;
  const pending = new Map();
  let onChannel = () => {};
  const send = (header) => {
    const head = Buffer.from(JSON.stringify(header), "utf8");
    const prefix = Buffer.alloc(8);
    prefix.writeUInt32LE(head.length, 0);
    prefix.writeUInt32LE(0, 4);
    proc.stdin.write(Buffer.concat([prefix, head]));
  };
  const call = (method, params = {}) =>
    new Promise((done, fail) => {
      const id = nextId++;
      pending.set(id, { done, fail });
      send({ id, method, params });
    });
  proc.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 8) return;
      const headLength = buffer.readUInt32LE(0);
      const bodyLength = buffer.readUInt32LE(4);
      if (buffer.length < 8 + headLength + bodyLength) return;
      const header = JSON.parse(buffer.subarray(8, 8 + headLength).toString("utf8"));
      const body = Buffer.from(buffer.subarray(8 + headLength, 8 + headLength + bodyLength));
      buffer = buffer.subarray(8 + headLength + bodyLength);
      if (header.channel !== undefined) {
        if (!header.end) onChannel(header.raw ? body : header.data);
      } else if (header.id !== undefined) {
        const waiting = pending.get(header.id);
        pending.delete(header.id);
        if (header.error) waiting?.fail(new Error(`${header.error.code}: ${header.error.message}`));
        else waiting?.done(header.result);
      }
    }
  });
  await call("$/hello", { protocol: 1, client: "cli-e2e" });
  await call("workspace_open", { path: workspace });
  let raw = "";
  let text = "";
  let exit = () => {};
  const exited = new Promise((done) => {
    exit = done;
  });
  const waiters = [];
  /** What the terminal shows, roughly: escape sequences taken out, line ends as "\n". */
  const plain = (s) =>
    s
      // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are the point
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[=>]/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "");
  const check = () => {
    for (const w of [...waiters]) {
      if (!w.pattern.test(text.slice(w.from))) continue;
      waiters.splice(waiters.indexOf(w), 1);
      clearTimeout(w.timer);
      w.done();
    }
  };
  let terminal = null;
  onChannel = (message) => {
    if (Buffer.isBuffer(message)) {
      raw += message.toString("utf8");
      text = plain(raw);
      if (terminal)
        void call("pty_ack", { id: terminal.id, bytes: message.length }).catch(() => {});
      check();
    } else if (message && message.exit !== undefined) exit(message.exit);
  };
  terminal = await call("pty_spawn", {
    cwd: workspace,
    cols: 120,
    rows: 40,
    onOutput: { __channel: 1 },
    shellIntegration: false,
    run: { kind: "process", command: program, args, env: extraEnv },
    profile: null,
    env: null,
  });
  return {
    get raw() {
      return raw;
    },
    get text() {
      return text;
    },
    exited,
    write: (data) => void call("pty_write", { id: terminal.id, data }).catch(() => {}),
    expect: (pattern, { timeout = 30_000, from = 0 } = {}) =>
      new Promise((done, fail) => {
        const w = { pattern, from, done };
        w.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          fail(
            new Error(`no ${pattern} on the terminal after ${timeout} ms\n${text.slice(-4000)}`),
          );
        }, timeout);
        waiters.push(w);
        check();
      }),
    close: async () => {
      await call("pty_kill", { id: terminal.id }).catch(() => {});
      proc.stdin.end();
      await Promise.race([new Promise((done) => proc.once("exit", done)), sleep(5000)]);
      killTree(proc.pid);
    },
  };
}

// ---- Setup and the run -------------------------------------------------------------------------

let mockPid = 0;

async function setup() {
  await rm(scratch, { recursive: true, force: true });
  await mkdir(join(profile, "config", "memory"), { recursive: true });
  await mkdir(join(profile, "config", "agents"), { recursive: true });
  await mkdir(plain, { recursive: true });
  await cp(join(root, "tests/fixtures/sample"), workspace, { recursive: true });
  await writeFile(
    join(scratch, "gitconfig"),
    "[user]\n\tname = Test\n\temail = test@example.com\n[core]\n\tautocrlf = false\n[commit]\n\tgpgsign = false\n",
  );
  // What a run should pick up, as in the app: the folder's rules file, a skill, a subagent; the
  // user's memory and an agent of their own.
  await writeFile(join(workspace, "AGENTS.md"), "# Rules\n\nAlways mention cli-e2e-rule-marker.\n");
  await mkdir(join(workspace, ".claude", "skills", "cli-e2e-skill"), { recursive: true });
  await writeFile(
    join(workspace, ".claude", "skills", "cli-e2e-skill", "SKILL.md"),
    "---\nname: cli-e2e-skill\ndescription: Says cli-e2e-skill-marker when asked about the e2e.\n---\n\nSay it.\n",
  );
  await mkdir(join(workspace, ".claude", "agents"), { recursive: true });
  await writeFile(
    join(workspace, ".claude", "agents", "cli-e2e-helper.md"),
    "---\nname: cli-e2e-helper\ndescription: A helper for the command line's end-to-end test.\n---\n\nYou are the helper. cli-e2e-helper-marker\n",
  );
  await writeFile(
    join(profile, "config", "memory", "cli-e2e-memory-marker.md"),
    "# Memory\n\n- The user likes cli-e2e-memory-marker.\n",
  );
  await writeFile(
    join(profile, "config", "agents", "cli-e2e-agent.md"),
    "---\nname: cli-e2e-agent\ndescription: An agent of the user's own, for the e2e.\n---\n\nYou are the e2e agent. cli-e2e-agent-marker\n",
  );
  await writeFile(join(scratch, "prompt.md"), "which model answers?\n");
  await writeFile(
    join(scratch, "hook.mjs"),
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(join(scratch, "hook-ran.txt"))}, process.argv[2] + "\\n");\n`,
  );
  const git = (...args) =>
    spawnSync("git", args, { cwd: workspace, env, stdio: "ignore" }).status === 0;
  if (!(git("init", "-q", "-b", "main") && git("add", "-A") && git("commit", "-q", "-m", "sample")))
    console.log("note: git isn't available; the workspace is a plain folder");

  port = await freePort();
  const mock = spawn(
    process.execPath,
    [join(root, "tests/fixtures/mock-ollama.mjs"), String(port)],
    {
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  mockPid = mock.pid;
  await new Promise((ready, failed) => {
    mock.stderr.on("data", (chunk) => {
      if (String(chunk).includes(`on ${port}`)) setTimeout(ready, 300);
      else process.stderr.write(chunk);
    });
    mock.once("exit", (code) => failed(new Error(`the mock model server ended (${code})`)));
  });

  const node = process.execPath;
  // The user's settings, as the app writes them: the mock as Ollama, the default model, an
  // external agent, an MCP server, a hook; and this tool as an external agent of itself.
  const settings = {
    "agent.ollama.url": `http://127.0.0.1:${port}`,
    "agent.autoTitle": false,
    "agent.model": MODEL,
    "agent.externalAgents": {
      "Mock agent": { command: node, args: [join(workspace, "tools/mock-acp.mjs")] },
      Self: {
        command: node,
        args: [join(bundle, "cli.mjs"), "acp", "--user-data-dir", profile, "--model", MODEL],
      },
    },
    "agent.mcpServers": { echo: { command: node, args: [join(workspace, "tools/mock-mcp.mjs")] } },
    "agent.hooks": {
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command: `& "${node}" "${join(scratch, "hook.mjs")}" UserPromptSubmit`,
            },
          ],
        },
      ],
    },
  };
  if (!windows)
    settings["agent.hooks"].UserPromptSubmit[0].hooks[0].command =
      `"${node}" "${join(scratch, "hook.mjs")}" UserPromptSubmit`;
  await writeFile(join(profile, "config", "settings.json"), JSON.stringify(settings, null, 2));
  await writeFile(join(scratch, "full.json"), JSON.stringify({ "agent.runCommands": "full" }));
  const provider = {
    id: "claude",
    name: "Claude",
    kind: "anthropic",
    baseUrl: `http://127.0.0.1:${port}`,
  };
  await writeFile(
    join(scratch, "keyed.json"),
    JSON.stringify({ "agent.ollama.enabled": false, "agent.providers": [provider] }),
  );
  // Nothing answers on this port: no Ollama, no provider.
  await writeFile(
    join(scratch, "nomodel.json"),
    JSON.stringify({
      "agent.ollama.url": `http://127.0.0.1:${await freePort()}`,
      "agent.autoTitle": false,
    }),
  );
  return mock;
}

const mock = await setup();
let failed = 0;
let ran = 0;
let skipped = 0;
try {
  for (const scenario of scenarios) {
    if (filter && !scenario.name.includes(filter) && !scenario.always) continue;
    if (scenario.skip) {
      skipped++;
      console.log(`skip  ${scenario.name} (${scenario.skip})`);
      continue;
    }
    ran++;
    const started = Date.now();
    try {
      await scenario.run();
      console.log(`ok    ${scenario.name} (${Date.now() - started} ms)`);
    } catch (err) {
      failed++;
      console.log(
        `FAIL  ${scenario.name}\n      ${String(err?.stack ?? err)
          .split("\n")
          .slice(0, process.env.CLI_E2E_FULL ? 400 : 40)
          .join("\n      ")}`,
      );
    }
  }
} finally {
  mock.kill();
  for (const p of scratchProcesses()) if (p.pid !== process.pid) killTree(p.pid);
  if (!keep)
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(
      (err) => console.log(`note: couldn't remove ${scratch}: ${err.message}`),
    );
  else console.log(`kept: ${scratch}`);
}
console.log(
  failed
    ? `cli-e2e: ${failed} of ${ran} scenario(s) failed`
    : `cli-e2e: ok (${ran}${skipped ? `, ${skipped} skipped` : ""})`,
);
process.exit(failed || ran === 0 ? 1 : 0);

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port: free } = server.address();
      server.close(() => done(free));
    });
  });
}

// ---- Checks ------------------------------------------------------------------------------------

function ok(value, what = "expected a true value") {
  if (!value) throw new Error(what);
}
function equal(actual, expected, what = "") {
  if (actual !== expected)
    throw new Error(
      `${what ? `${String(what).slice(0, 1500)}: ` : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
}
function deepEqual(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function match(text, pattern) {
  if (!pattern.test(String(text)))
    throw new Error(`expected ${pattern}, got ${JSON.stringify(String(text).slice(0, 1500))}`);
}

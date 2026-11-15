// End-to-end test of the brain without a window: the headless bundle (dist-headless/brain.mjs)
// over the real host program, against the fixtures' scripted model server. Plain Node; it builds
// nothing. The exit code is non-zero when a scenario fails.
//
//   node scripts/headless-e2e.mjs [--host <ide-host>] [--bundle <dist-headless>] [--keep] [filter]
//
// Build first:
//   (in src-tauri/) cargo build --no-default-features --features host --bin ide-host
//   node build.mjs --headless
// Without --host: `ide-host` in $CARGO_TARGET_DIR/debug, else src-tauri/target/debug.
//
// Everything it writes goes to a folder beside the repository, removed at the end (--keep leaves
// it): a copy of tests/fixtures/sample as the workspace and a profile of its own
// (`--user-data-dir`), never the user's settings or chats. The model server is
// tests/fixtures/mock-ollama.mjs on a free port (the UI tests use 11999 and may be running).
//
// Each scenario runs in a Node process of its own (one brain per process, and continuing a
// saved chat is a second process by definition). A scenario's process must end by itself once
// the run has: one that is still alive 10 s later fails.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const self = fileURLToPath(import.meta.url);
const root = resolve(dirname(self), "..");

// ---- A scenario's own process ------------------------------------------------------------------

if (process.argv[2] === "--child") {
  await child(JSON.parse(process.env.HEADLESS_E2E_SPEC ?? "{}"));
} else {
  await main();
}

/**
 * Runs one scenario and prints `RESULT <json>`. `spec.kind` "run": the one-shot runner
 * (`runHeadless`). "brain": a brain kept open (`openBrain`), for what the one-shot result doesn't
 * say (the commands a front end needs, the saved chats, answering a question as the front end).
 */
async function child(spec) {
  const { openBrain, runHeadless } = await import(
    pathToFileURL(join(spec.bundle, "brain.mjs")).href
  );
  const events = [];
  const hostLog = [];
  const problems = [];
  process.on("unhandledRejection", (reason) =>
    problems.push(
      `unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`,
    ),
  );
  const { warn, error } = console;
  // HEADLESS_E2E_TRACE=1: where each warning came from.
  const where = () =>
    process.env.HEADLESS_E2E_TRACE
      ? `\n${(new Error().stack ?? "").split("\n").slice(3, 10).join("\n")}`
      : "";
  console.warn = (...args) => problems.push(`warn: ${args.map(String).join(" ")}${where()}`);
  console.error = (...args) => problems.push(`error: ${args.map(String).join(" ")}${where()}`);
  const host = {
    hostBinary: spec.host,
    userDataDir: spec.profile,
    onHostLog: (text) => hostLog.push(text),
  };
  const out = { events, problems, hostLog };
  const started = Date.now();
  try {
    if (spec.kind === "run") {
      out.result = await runHeadless({
        ...host,
        ...spec.options,
        onEvent: (event) => events.push(event),
      });
    } else {
      const brain = await openBrain({
        ...host,
        ...spec.brain,
        // What a text box would be asked (an API key is typed, never a command's input).
        ...(spec.typed !== undefined && {
          policy: { quickInput: { prompt: () => spec.typed } },
        }),
      });
      try {
        out.bootMs = Date.now() - started;
        out.extensions = brain.boot.extensions;
        out.hostCommands = brain.host?.commands.length ?? 0;
        out.before = [];
        for (const step of spec.before ?? [])
          out.before.push(await brain.execute(step.command, step.input));
        const chat = await brain.open(spec.open ?? {});
        chat.onEvent((event) => {
          events.push(event);
          // The front end answers a waiting question with the command, as the person.
          if (event.type === "permission.request" && spec.answer)
            void brain
              .execute("agent.respondPermission", {
                session: chat.id,
                id: event.id,
                answer: spec.answer,
              })
              .catch((err) => problems.push(`respondPermission: ${err.message}`));
        });
        if (spec.prompt !== undefined) out.result = await chat.send(spec.prompt, spec.limits);
        out.ideTools = chat.session.externalIdeTools;
        out.chats = await brain.chats();
        out.commands = Object.fromEntries(
          (spec.commands ?? []).map((id) => [id, brain.services.dispatcher.has(id)]),
        );
        out.state = {};
        for (const path of spec.state ?? []) out.state[path] = await brain.state(path, 4000);
        out.notices = brain.boot.screenless.notifications.history
          .peek()
          .map((n) => `${n.kind}: ${n.message}`);
        // A command hidden from agents runs for the front end, and not for an agent.
        if (spec.asAgent) {
          out.asAgent = await brain.services.dispatcher
            .execute(spec.asAgent.command, spec.asAgent.input, { kind: "agent", session: chat.id })
            .then(
              () => "ran",
              (err) => `refused: ${err.message}`,
            );
        }
      } finally {
        const closing = Date.now();
        await brain.dispose();
        out.disposeMs = Date.now() - closing;
      }
    }
  } catch (err) {
    out.failure = err instanceof Error ? (err.stack ?? err.message) : String(err);
  }
  console.warn = warn;
  console.error = error;
  process.stdout.write(`RESULT ${JSON.stringify(out)}\n`);
  // Nothing may keep this process alive now. A timer that doesn't itself keep it alive tells
  // when something else does.
  setTimeout(() => {
    process.stderr.write(
      `still running 10 s after the run ended: ${[...new Set(process.getActiveResourcesInfo())].join(", ")}\n`,
    );
    process.exit(70);
  }, 10_000).unref();
}

// ---- The scenarios -----------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const option = (name) => {
    const at = args.indexOf(name);
    return at >= 0 ? args.splice(at, 2)[1] : undefined;
  };
  const exe = process.platform === "win32" ? "ide-host.exe" : "ide-host";
  const host = resolve(
    option("--host") ??
      join(process.env.CARGO_TARGET_DIR ?? join(root, "src-tauri", "target"), "debug", exe),
  );
  const bundle = resolve(option("--bundle") ?? join(root, "dist-headless"));
  const keep = args.includes("--keep");
  const filter = args.find((a) => !a.startsWith("--"));
  if (!existsSync(host)) {
    console.error(`headless-e2e: no host program at ${host} (build it, or pass --host).`);
    process.exit(2);
  }
  if (!existsSync(join(bundle, "brain.mjs"))) {
    console.error(`headless-e2e: no bundle at ${bundle} (run: node build.mjs --headless).`);
    process.exit(2);
  }

  const scratch = resolve(root, "..", `.headless-e2e-${process.pid}`);
  const workspace = join(scratch, "sample");
  const profile = join(scratch, "profile");
  await rm(scratch, { recursive: true, force: true });
  await mkdir(profile, { recursive: true });
  await cp(join(root, "tests/fixtures/sample"), workspace, { recursive: true });
  // A repository of its own, so git's look for one stops here and never reaches a repository
  // around the scratch folder. Git as on a fresh machine (as the UI test runner sets it).
  await writeFile(
    join(scratch, "gitconfig"),
    "[user]\n\tname = Test\n\temail = test@example.com\n[core]\n\tautocrlf = false\n[commit]\n\tgpgsign = false\n",
  );
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(scratch, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    // Keys these runs store stay in the scratch profile's file, out of the OS keychain.
    IDE_NO_KEYCHAIN: "1",
  };
  const git = (...gitArgs) =>
    spawnSync("git", gitArgs, { cwd: workspace, env: gitEnv, stdio: "ignore" }).status === 0;
  const repository =
    git("init", "-q", "-b", "main") && git("add", "-A") && git("commit", "-q", "-m", "sample");
  if (!repository) console.log("note: git isn't available; the workspace is a plain folder");

  const port = await freePort();
  const mock = spawn(
    process.execPath,
    [join(root, "tests/fixtures/mock-ollama.mjs"), String(port)],
    {
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  // It says on stderr when it listens (as the UI test runner waits for it).
  await new Promise((ready, failed) => {
    mock.stderr.on("data", (chunk) => {
      if (String(chunk).includes(`on ${port}`)) setTimeout(ready, 300);
      else process.stderr.write(chunk);
    });
    mock.once("exit", (code) => failed(new Error(`the mock model server ended (${code})`)));
  });

  /** Settings for these runs only: the mock as Ollama, the mock ACP agent and MCP server. */
  const settings = {
    "agent.ollama.url": `http://127.0.0.1:${port}`,
    "agent.autoTitle": false,
    "agent.externalAgents": {
      "Mock agent": { command: "node", args: [join(workspace, "tools/mock-acp.mjs")] },
    },
    "agent.mcpServers": {
      echo: { command: "node", args: [join(workspace, "tools/mock-mcp.mjs")] },
    },
  };
  /** The mock as a keyed provider speaking Anthropic's API (and no Ollama). */
  const keyed = {
    ...settings,
    "agent.ollama.enabled": false,
    "agent.providers": [
      { id: "claude", name: "Claude", kind: "anthropic", baseUrl: `http://127.0.0.1:${port}` },
    ],
  };
  const MODEL = "ollama/mock-coder:1b";
  const base = { folder: workspace, settings, trustFolder: true };
  const types = (r) => r.events.map((e) => e.type);
  const decisions = (r) =>
    r.events.flatMap((e) =>
      e.type === "permission.decision" ? [`${e.answer}/${e.by}/${e.rule ?? "-"}`] : [],
    );
  const toolEnds = (r) =>
    r.events.flatMap((e) => (e.type === "tool.end" ? [`${e.name}:${e.status}`] : []));
  /** The chat the first scenario made (the later ones continue or list it). */
  let firstSession = null;
  /** The chat of the scenario that ran last (the folder's newest). */
  let lastSession = null;

  /** @type {{ name: string, spec: object, check(r: any): Promise<void> | void }[]} */
  const scenarios = [
    {
      name: "one shot: a file written and a command run under an allow policy",
      spec: {
        kind: "run",
        options: {
          ...base,
          prompt: "headless e2e: write and run",
          model: MODEL,
          permissions: { mode: "accept-edits", allow: ["echo"], otherwise: "deny" },
        },
      },
      check: async (r) => {
        equal(r.result.reason, "end");
        equal(r.result.text, "Headless: wrote=yes ran=yes");
        equal(
          (await readFile(join(workspace, "headless-e2e.txt"), "utf8")).trim(),
          "written with no window",
        );
        deepEqual(toolEnds(r), ["write_file:done", "run_command:done"]);
        // The command asked (commands ask in this mode) and the allow list answered.
        deepEqual(decisions(r), ["once/policy/echo"]);
        equal(r.result.denied.length, 0);
        equal(r.result.steps, 3);
        deepEqual(r.result.pending, []);
        equal(types(r)[0], "session");
        ok(types(r).includes("edit"), "an edit event");
        ok(types(r).includes("tool.output"), "the command's output as it came");
        ok(types(r).includes("usage"), "usage events");
        equal(types(r).at(-1), "turn.end");
        const text = r.events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");
        equal(text, "Headless: wrote=yes ran=yes");
        firstSession = r.result.session;
      },
    },
    {
      name: "a permission the policy doesn't allow is refused, and the run goes on",
      spec: {
        kind: "run",
        options: {
          ...base,
          prompt: "headless e2e: push",
          model: MODEL,
          // Commands run by themselves in this mode, except the risky ones: a push asks.
          permissions: { mode: "auto", otherwise: "deny" },
        },
      },
      check: (r) => {
        equal(r.result.reason, "end");
        equal(r.result.text, "Headless push: refused");
        deepEqual(toolEnds(r), ["run_command:denied"]);
        deepEqual(decisions(r), ["deny/policy/-"]);
        equal(r.result.denied.length, 1);
        equal(r.result.denied[0].code, "git push origin main");
        ok(!types(r).includes("permission.request"), "nothing waited for an answer");
      },
    },
    {
      name: "the deny list refuses even with full access",
      spec: {
        kind: "run",
        options: {
          ...base,
          prompt: "headless e2e: push",
          model: MODEL,
          permissions: { mode: "full-access", deny: ["git push"] },
        },
      },
      check: (r) => {
        equal(r.result.text, "Headless push: refused");
        deepEqual(decisions(r), ["deny/policy/git push"]);
        equal(r.result.denied[0].rule, "git push");
        lastSession = r.result.session;
      },
    },
    {
      name: "the saved chat is continued in a second process",
      spec: {
        kind: "run",
        options: {
          ...base,
          prompt: "headless e2e: recall",
          continue: true,
          permissions: { otherwise: "deny" },
        },
      },
      check: (r) => {
        equal(r.result.reason, "end");
        equal(r.result.text, "Headless recall: remembers");
        const opened = r.events[0];
        equal(opened.type, "session");
        // The newest chat of the folder: the one the scenario before this made.
        equal(r.result.session, lastSession);
        ok(opened.items > 0, "the conversation came back from disk");
        equal(opened.model, MODEL);
      },
    },
    {
      name: "a front end: the commands and state it needs, a question answered as the person",
      // The file the first scenario wrote goes, so writing it is a new file again.
      before: () => rm(join(workspace, "headless-e2e.txt"), { force: true }),
      spec: {
        kind: "brain",
        brain: { ...base, permissions: { mode: "ask", otherwise: "wait" }, frontend: "e2e" },
        open: { model: MODEL },
        prompt: "headless e2e: write and run",
        answer: "once",
        commands: [
          "agent.send",
          "agent.stop",
          "agent.respondPermission",
          "agent.answer",
          "agent.acceptAll",
          "agent.rejectAll",
          "agent.reviewChange",
          "agent.setMode",
          "agent.setChatMode",
          "agent.setCommandMode",
          "agent.selectModel",
          "agent.refreshModels",
          "agent.openSession",
          "agent.newSession",
          "agent.continue",
          "agent.retry",
          "agent.compact",
          "agent.restoreCheckpoint",
          "agent.restoreToMessage",
          "agent.slash",
          "agent.deleteSession",
          "agent.renameSession",
        ],
        state: ["ide://agent", "ide://agent/session", "ide://workspace"],
        asAgent: { command: "agent.setMode", input: { autoApply: true } },
      },
      check: (r) => {
        equal(r.result.reason, "end");
        equal(r.result.text, "Headless: wrote=yes ran=yes");
        for (const e of r.extensions) equal(e.error, undefined, `${e.id} failed to activate`);
        ok(r.extensions.length >= 11, "the headless extensions activated");
        const missing = Object.entries(r.commands)
          .filter(([, there]) => !there)
          .map(([id]) => id);
        deepEqual(missing, []);
        // Edits wait for review in this mode: the file is proposed, not written.
        ok(r.result.pending.length === 1, "the edit waits for review");
        // The command's question went to the front end and its answer came back as the person's.
        const asked = r.events.filter((e) => e.type === "permission.request");
        equal(asked.length, 1);
        equal(asked[0].code, "echo headless-e2e-ran");
        deepEqual(decisions(r), ["once/user/-"]);
        const session = r.state["ide://agent/session"];
        equal(session.status, "idle");
        equal(session.model, MODEL);
        ok(r.state["ide://agent"].sessions.length >= 1);
        equal(
          String(r.state["ide://workspace"].root).replace(/\\/g, "/"),
          workspace.replace(/\\/g, "/"),
        );
        // The chats are where the app keeps them: the first scenario's is listed.
        ok(
          r.chats.some((c) => c.id === firstSession && c.here),
          "the earlier chat is listed",
        );
        ok(r.chats.length >= 4);
        // The same command the front end may run is refused to an agent: the caller kind is
        // the front end's own, not a way around the policy.
        match(r.asAgent, /^refused: Not permitted/);
        deepEqual(
          r.notices.filter((n) => n.startsWith("error")),
          [],
        );
      },
    },
    {
      name: "an external agent over ACP, with the IDE's tools",
      spec: {
        kind: "brain",
        brain: { ...base, permissions: { mode: "full-access" } },
        open: { model: "acp/Mock agent" },
        prompt: "add a line to the readme",
      },
      check: async (r) => {
        equal(r.result.reason, "end");
        match(r.result.text, /^ACP done on /);
        match(await readFile(join(workspace, "README.md"), "utf8"), /Added by ACP\./);
        // The agent was handed the IDE's own MCP server although `mcp.enabled` is off here.
        equal(r.ideTools, "on");
        ok(types(r).includes("tool.start"), "the agent's tool call as an event");
      },
    },
    {
      name: "an MCP server's tool, allowed by name",
      spec: {
        kind: "run",
        options: {
          ...base,
          prompt: "Please use the echo server",
          model: MODEL,
          permissions: { mode: "ask", allow: ["mcp__echo__*"], otherwise: "deny" },
        },
      },
      check: (r) => {
        equal(r.result.reason, "end");
        match(r.result.text, /MCP said: HELLO/);
        deepEqual(toolEnds(r), ["mcp__echo__echo:done"]);
        // A server from the user's settings asks nothing for a read-only tool; when a tool
        // does ask, the allow list answers it by the tool's name (unattended.test.ts).
        ok(!decisions(r).some((d) => d.startsWith("deny")), decisions(r).join(" "));
      },
    },
    {
      name: "a workflow script runs in a worker thread, its agents and its end message too",
      spec: {
        kind: "run",
        options: {
          ...base,
          prompt: "pkgk run a workflow",
          model: MODEL,
          permissions: { mode: "accept-edits", allow: ["run_workflow"], otherwise: "deny" },
        },
      },
      check: (r) => {
        equal(r.result.reason, "end");
        equal(r.result.text, "PkgK result: pick=alpha, cached=0");
        ok(toolEnds(r).includes("run_workflow:done"), toolEnds(r).join(" "));
        ok(r.events.filter((e) => e.type === "turn.end").length >= 2, "the end message's turn");
      },
    },
    {
      name: "a time limit stops the run",
      spec: {
        kind: "run",
        options: {
          ...base,
          prompt: "start the long essay",
          model: MODEL,
          permissions: { otherwise: "deny" },
          limits: { timeoutMs: 2500 },
        },
      },
      check: (r) => {
        equal(r.result.reason, "timeout");
        const end = r.events.findLast((e) => e.type === "turn.end");
        equal(end.reason, "stopped");
        ok(
          r.events.some((e) => e.type === "notice" && /time limit/.test(e.text)),
          "the chat says why it stopped",
        );
      },
    },
    {
      name: "an API key in the app's store reaches the provider (Anthropic's API)",
      spec: {
        kind: "brain",
        brain: { ...base, settings: keyed, permissions: { otherwise: "deny" } },
        typed: "sk-e2e-key",
        before: [{ command: "agent.setApiKey", input: { provider: "claude" } }],
        open: { model: "claude/claude-mock" },
        prompt: "hello",
      },
      check: (r) => {
        deepEqual(r.before, [{ provider: "claude", stored: true }]);
        equal(r.result.reason, "end");
        equal(r.result.text, "Hello from mock.");
        // The key is nowhere in what the run tells.
        ok(!JSON.stringify(r).includes("sk-e2e-key"), "the key appears in the run's output");
      },
    },
    {
      name: "a key the provider rejects: the provider says so and no model is offered",
      spec: {
        kind: "brain",
        brain: { ...base, settings: keyed, permissions: { otherwise: "deny" } },
        typed: "bad-key",
        before: [{ command: "agent.setApiKey", input: { provider: "claude" } }],
        open: { model: "claude/claude-mock" },
        prompt: "hello",
      },
      check: (r) => {
        match(r.failure ?? "", /isn't available/);
      },
      expectFailure: true,
    },
    {
      name: "a model nobody has is a failure to start, and everything still ends",
      spec: {
        kind: "run",
        options: { ...base, prompt: "hello", model: "ollama/no-such-model" },
      },
      check: (r) => {
        equal(r.result, undefined);
        match(r.failure ?? "", /isn't available/);
      },
      expectFailure: true,
    },
  ];

  let failed = 0;
  let ran = 0;
  try {
    for (const scenario of scenarios) {
      if (filter && !scenario.name.includes(filter)) continue;
      ran++;
      const started = Date.now();
      let outcome;
      try {
        await scenario.before?.();
        outcome = await runChild({ ...scenario.spec, host, bundle, profile }, gitEnv);
        const r = outcome.result;
        if (r.failure && !scenario.expectFailure) throw new Error(`it failed: ${r.failure}`);
        await scenario.check(r);
        // A run leaves nothing complaining behind: no warnings, no unhandled rejections.
        deepEqual(r.problems, []);
        if (outcome.code !== 0) throw new Error(`its process ended with ${outcome.code}`);
        if (outcome.lingerMs > 8000)
          throw new Error(`its process stayed ${outcome.lingerMs} ms after the run ended`);
        console.log(
          `ok    ${scenario.name} (${Date.now() - started} ms; ended ${outcome.lingerMs} ms after its result)`,
        );
      } catch (err) {
        failed++;
        console.log(
          `FAIL  ${scenario.name}\n      ${String(err?.message ?? err)
            .split("\n")
            .join("\n      ")}`,
        );
        const r = outcome?.result;
        if (r) {
          if (r.failure) console.log(`      failure: ${r.failure.split("\n").join("\n      ")}`);
          console.log(`      events: ${r.events.map((e) => e.type).join(" ")}`);
          const said = r.events.flatMap((e) =>
            e.type === "notice" || e.type === "error" ? [e.text ?? e.message] : [],
          );
          if (said.length) console.log(`      said: ${said.join(" | ")}`);
          const ends = r.events.flatMap((e) =>
            e.type === "tool.end"
              ? [`${e.name}:${e.status}: ${String(e.result).slice(0, 300)}`]
              : [],
          );
          if (ends.length) console.log(`      tools: ${ends.join("\n             ")}`);
          if (r.result) console.log(`      result: ${JSON.stringify(r.result).slice(0, 600)}`);
          if (r.problems.length) console.log(`      problems: ${r.problems.join("\n        ")}`);
          const log = r.hostLog.join("").trim().split("\n").slice(-8).join("\n        ");
          if (log) console.log(`      host log:\n        ${log}`);
        }
        if (outcome?.stderr) console.log(`      stderr: ${outcome.stderr.trim()}`);
      }
    }
  } finally {
    mock.kill();
    if (!keep) await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    else console.log(`kept: ${scratch}`);
  }
  console.log(
    failed ? `headless-e2e: ${failed} of ${ran} scenario(s) failed` : `headless-e2e: ok (${ran})`,
  );
  process.exit(failed || ran === 0 ? 1 : 0);
}

/** Runs one scenario in a process of its own; resolves with what it printed and how it ended. */
function runChild(spec, env) {
  return new Promise((done, failed) => {
    const proc = spawn(process.execPath, [self, "--child"], {
      env: { ...env, HEADLESS_E2E_SPEC: JSON.stringify(spec) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let stderr = "";
    let resultAt = 0;
    proc.stdout.setEncoding("utf8").on("data", (chunk) => {
      out += chunk;
      if (!resultAt && /^RESULT .*\n/m.test(out)) resultAt = Date.now();
    });
    proc.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    const watchdog = setTimeout(() => {
      proc.kill();
      failed(new Error(`no result after 120 s\n${stderr}`));
    }, 120_000);
    proc.on("error", failed);
    proc.on("exit", (code) => {
      clearTimeout(watchdog);
      const line = /^RESULT (.*)$/m.exec(out)?.[1];
      if (!line) {
        failed(new Error(`its process ended (${code}) without a result\n${stderr}${out}`));
        return;
      }
      done({ result: JSON.parse(line), code, stderr, lingerMs: Date.now() - resultAt });
    });
  });
}

function freePort() {
  return new Promise((done, failed) => {
    const server = createServer();
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
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
      `${what ? `${what}: ` : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
}
function deepEqual(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function match(text, pattern) {
  if (!pattern.test(String(text)))
    throw new Error(`expected ${pattern}, got ${JSON.stringify(text)}`);
}

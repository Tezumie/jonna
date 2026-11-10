// Test extension for D202 (tests/scripts/extensions-m7-3.jsonc).
const sep = ide.env.platform === "windows" ? "\\" : "/";

/** Resolves with the first message matching `test`, or rejects after `ms`. */
function waitFor(proc, test, ms = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    const sub = proc.onMessage((m) => {
      if (!test(m)) return;
      clearTimeout(timer);
      sub.dispose();
      resolve(m);
    });
  });
}

function exited(proc) {
  return new Promise((resolve) => proc.onExit((code, signal) => resolve({ code, signal })));
}

let longRunning = null;
let lastExit = null;
const trustChanges = [];

exports.activate = (ide) => {
  ide.workspace.onDidChangeTrust((trusted) => trustChanges.push(trusted));

  ide.commands.register("procs.echo", async () => {
    const proc = await ide.process.spawn({
      command: "node",
      args: [`${ide.extension.path}${sep}echo.js`],
      cwd: ide.extension.path,
      env: { PROCS_FLAG: "on" },
      framing: "ndjson",
    });
    const stderr = [];
    proc.onStderr((line) => stderr.push(line));
    const plain = [];
    proc.onMessage((m) => typeof m === "string" && plain.push(m));
    const ready = await waitFor(proc, (m) => m && m.ready);
    const pong = waitFor(proc, (m) => m && m.pong === 7);
    await proc.send({ ping: 7 });
    const answer = await pong;
    const exit = exited(proc);
    await proc.send({ quit: true });
    return { ready: ready.ready, cwd: ready.cwd, pong: answer.pong, env: answer.env, plain, stderr, exit: await exit };
  });

  ide.commands.register("procs.lines", async () => {
    const proc = await ide.process.spawn({
      command: "node",
      args: ["-e", "console.log('first');console.log('second');console.error('oops');process.exit(5)"],
    });
    const lines = [];
    const stderr = [];
    proc.onMessage((m) => lines.push(m));
    proc.onStderr((l) => stderr.push(l));
    const exit = await exited(proc);
    return { lines, stderr, exit };
  });

  ide.commands.register("procs.limit", async () => {
    const started = [];
    let error = null;
    for (let i = 0; i < 9; i++) {
      try {
        started.push(await ide.process.spawn({ command: "node", args: ["-e", "setInterval(() => {}, 1000)"] }));
      } catch (err) {
        error = err.message;
      }
    }
    const exits = started.map(exited);
    await Promise.all(started.map((p) => p.kill()));
    const results = await Promise.all(exits);
    return { started: started.length, error, signals: results.map((r) => r.signal) };
  });

  ide.commands.register("procs.running", async () => {
    longRunning = await ide.process.spawn({ command: "node", args: ["-e", "setInterval(() => {}, 1000)"] });
    lastExit = null;
    longRunning.onExit((code, signal) => {
      lastExit = { code, signal };
    });
    return { id: longRunning.id };
  });

  ide.commands.register("procs.lastExit", () => ({ exit: lastExit }));

  ide.commands.register("procs.info", async (_input, context) => ({
    platform: ide.env.platform,
    path: ide.extension.path,
    trusted: await ide.workspace.isTrusted(),
    trustChanges,
    caller: context.caller,
  }));

  ide.commands.register("procs.state", () => {
    ide.state.register("ide://ext/acme.procs/info", ({ params }) => ({
      running: longRunning ? 1 : 0,
      params,
    }));
    // Never answers: readers get an error after 2 s.
    ide.state.register("ide://ext/acme.procs/slow", () => new Promise(() => {}));
    // Not its namespace: refused (logged).
    ide.state.register("ide://procs-elsewhere", () => 1);
    return { ok: true };
  });

  ide.commands.register("procs.context", async () => {
    await ide.context.set("acme.procs.busy", true);
    let error = null;
    try {
      await ide.context.set("other.busy", true);
    } catch (err) {
      error = err.message;
    }
    return { error };
  });

  ide.commands.register("procs.settings", async () => {
    const fontSize = await ide.settings.get("terminal.fontSize");
    let agentError = null;
    try {
      await ide.settings.get("agent.model");
    } catch (err) {
      agentError = err.message;
    }
    return { fontSize, agentError };
  });

  ide.commands.register("procs.greet", (input, context) => ({
    text: `hi ${input.name}`.repeat(input.times ?? 1),
    caller: context.caller,
  }));

  ide.commands.register("procs.badInput", (input) => ({ input }));
};

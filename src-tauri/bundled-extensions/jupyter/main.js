// Jupyter kernels (D188, moved into this extension in D203): the kernels that run Jupyter
// notebooks — each Python found here with its Jupyter kernels, or plain Python when Jupyter
// isn't installed — through kernel_host.py, one process per notebook speaking one JSON message
// per line. When a Python lacks ipykernel, it offers to install it (pip, in a terminal).
//
// The .ipynb format and the notebook editor itself (cells, outputs, widgets, the run queue,
// diffs, the notebook.* commands) are the IDE's (D204, as VS Code's built-in ipynb support);
// this extension only runs cells (ide.notebooks.registerKernelSource), like VS Code's Jupyter
// extension.

const TYPE = "jupyter.notebook";
const sep = ide.env.platform === "windows" ? "\\" : "/";
const join = (...parts) =>
  parts
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, "")))
    .join(sep);
const SCRIPT = join(ide.extension.path, "kernel_host.py");

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// ---- Finding Pythons ------------------------------------------------------------------------

const exists = (path) =>
  ide.workspace.fs.stat(path).then(
    () => true,
    () => false,
  );

/** Pythons worth asking, best first: the settings, the folder's environments, PATH's. */
async function pythonCandidates(root) {
  const windows = ide.env.platform === "windows";
  const out = [];
  const add = (command, args = []) => {
    if (command && !out.some((p) => p.command === command && p.args.join(" ") === args.join(" ")))
      out.push({ command, args });
  };
  const configured =
    (await ide.settings.get("jupyter.pythonPath").catch(() => "")) ||
    (await ide.settings.get("notebook.pythonPath").catch(() => ""));
  if (configured) add(configured);
  for (const env of [".venv", "venv", "env", ".env"]) {
    const exe = windows
      ? join(root, env, "Scripts", "python.exe")
      : join(root, env, "bin", "python");
    if (await exists(exe)) add(exe);
  }
  const debugPython = await ide.settings.get("debug.pythonPath").catch(() => "");
  if (debugPython) add(debugPython);
  if (windows) {
    add("python");
    add("py", ["-3"]);
  } else {
    add("python3");
    add("python");
  }
  return out;
}

/** Runs `kernel_host.py --list` with one Python; null when it doesn't run. */
async function probe(python, cwd) {
  let proc;
  try {
    proc = await ide.process.spawn({
      command: python.command,
      args: [...python.args, "-u", SCRIPT, "--list"],
      cwd,
      env: { PYTHONIOENCODING: "utf-8" },
      framing: "ndjson",
    });
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void proc.kill().catch(() => {});
      resolve(r);
    };
    const timer = setTimeout(() => done(null), 15_000);
    proc.onMessage((m) => done(isObject(m) ? m : null));
    proc.onExit(() => done(null));
  });
}

const short = (path, root) =>
  path.startsWith(root) ? `.${path.slice(root.length).replace(/\\/g, "/")}` : path;

/** Every way to run a notebook here, each Python once (by its real executable). */
async function findKernels(root) {
  const candidates = await pythonCandidates(root);
  // A few at a time: each probe is a process, and an extension runs at most 8.
  const probes = new Array(candidates.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const i = next++;
      probes[i] = await probe(candidates[i], root);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const seen = new Set();
  const out = [];
  candidates.forEach((python, i) => {
    const r = probes[i];
    if (!r || typeof r.executable !== "string" || seen.has(r.executable)) return;
    seen.add(r.executable);
    const where = short(r.executable, root);
    if (r.jupyter && Array.isArray(r.specs))
      for (const s of r.specs)
        out.push({
          id: [python.command, ...python.args, s.name].join(" "),
          label: s.display,
          detail:
            (s.language || "python").toLowerCase() === "python"
              ? `Jupyter · ${where}`
              : `Jupyter (${s.language})`,
          // The IDE's language ids are lower case (IRkernel's kernelspec says "R").
          language: (s.language || "python").toLowerCase(),
          data: { python, kernel: s.name },
        });
    if (!r.ipykernel)
      out.push({
        id: [python.command, ...python.args, "(plain)"].join(" "),
        label: `Python ${r.python}`,
        detail: `${where} · without Jupyter (ipykernel isn't installed: magics and widgets need it)`,
        language: "python",
        data: { python, ipykernel: false, version: r.python },
      });
  });
  return out;
}

// ---- A kernel: one kernel_host.py process -----------------------------------------------------

class Kernel {
  constructor(option, context, host) {
    const d = option.data || {};
    if (!d.python || typeof d.python.command !== "string")
      throw new Error(`${option.label} can't be started (its Python is unknown).`);
    this.python = {
      command: d.python.command,
      args: Array.isArray(d.python.args) ? d.python.args : [],
    };
    this.kernel = typeof d.kernel === "string" ? d.kernel : null;
    this.mode = this.kernel ? "jupyter" : "python";
    this.cwd = context.cwd || context.root;
    this.host = host;
    this.waiting = new Map();
    this.stderr = [];
    this.seq = 0;
    this.proc = null;
    this.ready = null;
    this.stopping = false;
  }

  /** Starts the host; resolves when it said hello. Cells sent meanwhile wait for it. */
  start() {
    this.ready = this.spawn();
    return this.ready;
  }

  async spawn() {
    this.stopping = false;
    this.stderr = [];
    this.host.setStatus("starting");
    const proc = await ide.process.spawn({
      command: this.python.command,
      args: [
        ...this.python.args,
        "-u",
        SCRIPT,
        "--mode",
        this.mode,
        ...(this.kernel ? ["--kernel", this.kernel] : []),
      ],
      cwd: this.cwd,
      env: { PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
      framing: "ndjson",
    });
    this.proc = proc;
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("The kernel didn't start within 90 seconds.")),
        90_000,
      );
      this.waiting.set("hello", (e) => {
        clearTimeout(timer);
        if (e.type === "fatal") reject(new Error(String(e.error || "The kernel didn't start.")));
        else resolve();
      });
    });
    proc.onMessage((m) => {
      if (this.proc === proc && isObject(m)) this.receive(m);
    });
    proc.onStderr((line) => {
      this.stderr.push(String(line));
      if (this.stderr.length > 40) this.stderr.shift();
    });
    proc.onExit(() => {
      if (this.proc === proc) this.processExited();
    });
    try {
      await ready;
    } catch (err) {
      // Never said hello (timed out, failed): it mustn't keep running.
      this.waiting.delete("hello");
      if (this.proc === proc) this.proc = null;
      await proc.kill().catch(() => {});
      throw err;
    }
  }

  /** Waits for a start in progress (a restart); false when there's no process to talk to. */
  async alive() {
    await this.ready?.catch(() => {});
    return this.proc !== null;
  }

  receive(e) {
    if (e.type === "hello" || e.type === "fatal") {
      if (e.type === "hello")
        this.host.setInfo({
          mode: e.mode === "jupyter" ? "jupyter" : undefined,
          kernel: e.kernel,
          display: e.display,
          language: e.language,
        });
      this.waiting.get("hello")?.(e);
      this.waiting.delete("hello");
      return;
    }
    if (e.type === "status" && !e.id) {
      if (["busy", "idle", "starting", "dead"].includes(e.state)) this.host.setStatus(e.state);
      return;
    }
    if (e.type === "comm") {
      this.host.comm({
        kind: e.kind,
        content: e.content || {},
        metadata: e.metadata || {},
        buffers: Array.isArray(e.buffers) ? e.buffers : [],
      });
      return;
    }
    if (
      !e.id &&
      ["stream", "display", "update_display", "result", "error", "clear"].includes(e.type)
    ) {
      this.host.emit(e);
      return;
    }
    if (e.id) this.waiting.get(e.id)?.(e);
  }

  processExited() {
    const wasStopping = this.stopping;
    this.proc = null;
    const why = this.stderr.slice(-12).join("\n");
    this.waiting.get("hello")?.({
      type: "fatal",
      error: why || "The kernel's process ended before it started.",
    });
    this.waiting.delete("hello");
    for (const [id, handler] of [...this.waiting]) {
      handler({
        id,
        type: "error",
        ename: "KernelDied",
        evalue: why ? `The kernel stopped:\n${why}` : "The kernel stopped.",
        traceback: [],
      });
      handler({ id, type: "done", status: "error", count: null });
    }
    this.waiting.clear();
    this.exitResolve?.();
    // Shut down on purpose: the IDE knows; otherwise it crashed, with its last words.
    if (!wasStopping) this.host.exited(why);
  }

  send(message) {
    if (this.proc) void this.proc.send(message).catch(() => {});
  }

  async execute(code, run) {
    if (!(await this.alive())) {
      run.emit({
        type: "error",
        ename: "KernelDied",
        evalue: "The kernel isn't running.",
        traceback: [],
      });
      return { status: "error", count: null };
    }
    const id = `x${++this.seq}`;
    return new Promise((resolve) => {
      this.waiting.set(id, (e) => {
        if (e.type === "done") {
          this.waiting.delete(id);
          resolve({
            status: e.status === "error" || e.status === "aborted" ? e.status : "ok",
            count: e.count ?? null,
          });
        } else if (e.type === "input_request") {
          void run
            .input(String(e.prompt || ""), { password: e.password === true })
            .catch(() => "")
            .then((value) => this.send({ id, op: "input", value }));
        } else run.emit(e);
      });
      this.send({ id, op: "execute", code });
    });
  }

  async request(op, extra, type, ms) {
    if (!(await this.alive())) return null;
    return new Promise((resolve) => {
      const id = `r${++this.seq}`;
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(null);
      }, ms);
      this.waiting.set(id, (e) => {
        // An error for this request (a failed restart): no answer.
        if (e.type === "error" && type !== "done") {
          clearTimeout(timer);
          this.waiting.delete(id);
          resolve(null);
          return;
        }
        if (e.type !== type) return;
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve(e);
      });
      this.send({ id, op, ...extra });
    });
  }

  async complete(code, cursor) {
    const r = await this.request("complete", { code, cursor }, "complete", 3000);
    return r ? { matches: r.matches || [], start: r.start || 0, end: r.end || 0 } : null;
  }

  async inspect(code, cursor) {
    const r = await this.request("inspect", { code, cursor }, "inspect", 3000);
    return r?.text || "";
  }

  async variables() {
    const r = await this.request("variables", {}, "variables", 8000);
    if (!r || r.unsupported) return null;
    return r.variables;
  }

  async comm(kind, commId, data, metadata, buffers) {
    const r = await this.request(
      kind,
      { comm_id: commId, data, metadata, buffers },
      "done",
      30_000,
    );
    return r?.status === "ok";
  }

  interrupt() {
    this.send({ op: "interrupt" });
  }

  /** After ipykernel was installed: the next restart starts its Jupyter kernel (D204). */
  upgradeTo(kernelName) {
    this.kernel = kernelName;
    this.mode = "jupyter";
    this.upgraded = true;
  }

  /** Jupyter restarts its own kernel; the plain runner is started again. */
  async restart() {
    if (this.upgraded) {
      this.upgraded = false;
      await this.shutdown();
      await this.start();
      return;
    }
    if (this.mode === "jupyter" && this.proc) {
      const done = await this.request("restart", {}, "restarted", 90_000);
      // Not restarted (an error, no answer): the IDE shuts it down and starts it again.
      if (!done) throw new Error("The kernel didn't restart.");
      return;
    }
    await this.shutdown();
    await this.start();
  }

  async shutdown() {
    const proc = this.proc;
    if (!proc) return;
    this.stopping = true;
    // The host shuts its kernel down and exits (R or Julia kernels don't notice a killed
    // parent): up to 3 seconds, then it's stopped.
    const exited = new Promise((resolve) => {
      this.exitResolve = resolve;
      setTimeout(resolve, 3000);
    });
    this.send({ op: "shutdown" });
    await exited;
    this.exitResolve = null;
    await proc.kill().catch(() => {});
    this.proc = null;
  }
}

// ---- Installing ipykernel (VS Code's Jupyter extension offers the same) ------------------------

/** Pythons already offered ipykernel this session (by command line): asked once. */
const declinedInstall = new Set();

/** The kind of shell a terminal runs (its program's name): how a command line is quoted. */
function shellKind(shell) {
  const name = String(shell || "")
    .toLowerCase()
    .split(/[\\/]/)
    .pop();
  if (/^(pwsh|powershell)(\.exe)?$/.test(name)) return "powershell";
  if (/^cmd(\.exe)?$/.test(name)) return "cmd";
  if (!name) return ide.env.platform === "windows" ? "powershell" : "posix";
  return "posix";
}

/** A word of a command line: as is when it's plain, else quoted for that shell. */
function shellWord(a, kind) {
  // No "=" unquoted: cmd splits words at it, and a POSIX shell takes "a=b" first as a variable.
  if (/^[A-Za-z0-9_./:+-]+$/.test(a) || (kind !== "posix" && /^[A-Za-z0-9_./:\\+-]+$/.test(a)))
    return a;
  // PowerShell ends a single-quoted string at typographic quotes too (‘ ’ ‚ ‛): each doubled.
  if (kind === "powershell") return `'${a.replace(/['‘’‚‛]/g, "$&$&")}'`;
  if (kind === "cmd") return `"${a.replace(/"/g, '""')}"`;
  return `'${a.replace(/'/g, `'"'"'`)}'`;
}

/** The command line that runs `python -m pip install -U ipykernel` in that shell. */
function pipInstallLine(python, shell) {
  const kind = shellKind(shell);
  const exe = shellWord(python.command, kind);
  // PowerShell runs a quoted path only after "&".
  const head = kind === "powershell" && exe.startsWith("'") ? `& ${exe}` : exe;
  const args = python.args.map((x) => shellWord(x, kind));
  return [head, ...args, "-m", "pip", "install", "-U", "ipykernel"].join(" ");
}

/** The Python's Jupyter kernel when it has ipykernel now (installed since it was found), else null. */
async function jupyterSpec(python, root) {
  const r = await probe(python, root);
  return r && r.jupyter && r.ipykernel && Array.isArray(r.specs)
    ? r.specs.find((s) => (s.language || "python").toLowerCase() === "python") || null
    : null;
}

/**
 * A plain Python (no ipykernel) runs cells at once; meanwhile a notification offers to install
 * ipykernel (pip, in a terminal the user sees, like VS Code's Jupyter extension). Once it's in,
 * the kernel becomes a Jupyter one on its next restart, which the notification offers.
 */
async function offerIpykernel(kernel, python, context, version) {
  const key = [python.command, ...python.args].join(" ");
  if (declinedInstall.has(key)) return;
  declinedInstall.add(key);
  const answer = await ide.ui.notify(
    `${version ? `Python ${version}` : "This Python"} doesn't have ipykernel: cells run, but magics (%pip, %timeit), widgets and interrupting a cell need it. Install it with pip?`,
    { kind: "info", actions: ["Install ipykernel", "Not now"] },
  );
  if (answer !== "Install ipykernel") return;
  const term = await ide.commands.execute("terminal.create", { cwd: context.root });
  const result = await ide.commands.execute("terminal.runCommand", {
    command: pipInstallLine(python, term && term.shell),
    ...(term && typeof term.id === "number" && { id: term.id }),
    timeoutMs: 600000,
  });
  const spec = await jupyterSpec(python, context.root);
  if (!spec) {
    void ide.ui.notify(
      result && result.finished === null
        ? "pip runs in the terminal: once it's done, restart the kernel to use ipykernel."
        : "ipykernel couldn't be installed (the terminal says why): cells keep running without it.",
      { kind: "warning" },
    );
    if (result && result.finished === null) declinedInstall.delete(key);
    return;
  }
  kernel.upgradeTo(spec.name);
  const restart = await ide.ui.notify("ipykernel is installed. Restart the kernel to use it.", {
    kind: "success",
    actions: ["Restart kernel"],
  });
  if (restart === "Restart kernel")
    await ide.commands.execute("notebook.restart", { path: context.path }).catch(() => {});
}

ide.notebooks.registerKernelSource({
  id: "jupyter",
  label: "Jupyter",
  notebookTypes: [TYPE],
  async find(context) {
    // Finding kernels runs the folder's own Pythons (.venv): only in a trusted folder.
    if (!(await ide.workspace.requireTrust("Finding the Pythons that run notebooks"))) return [];
    return findKernels(context.root);
  },
  async start(option, context, host) {
    const d = option.data || {};
    const plain = d.ipykernel === false && d.python && typeof d.python.command === "string";
    const python = plain
      ? { command: d.python.command, args: Array.isArray(d.python.args) ? d.python.args : [] }
      : null;
    // A plain Python remembered from before ipykernel was installed: its Jupyter kernel now.
    const spec = python ? await jupyterSpec(python, context.root) : null;
    const start = spec ? { ...option, data: { python, kernel: spec.name } } : option;
    const kernel = new Kernel(start, context, host);
    await kernel.start();
    if (python && !spec) void offerIpykernel(kernel, python, context, d.version).catch(() => {});
    return kernel;
  },
});

// For tests (the IDE's unit tests load this file with a stand-in `ide`).
if (typeof module === "object" && module) module.exports = { pipInstallLine, shellKind };

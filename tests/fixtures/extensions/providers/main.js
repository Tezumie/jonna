// Test extension for the workbench providers (tests/scripts/extensions-m7-12.jsonc, D233): a
// "memfs:" file system, an echo pseudoterminal, "memo" tasks (a custom one), a source control
// over memfs, an inline "memo-dbg" debug adapter, and a "memo-auth" sign-in with a secret.
// Runs in the sandboxed worker.

const stats = {
  setup: false,
  written: {},
  echoed: "",
  taskRuns: 0,
  commits: [],
  debugRequests: [],
};

// ---- memfs: a folder in memory ----
const files = new Map([
  ["/hello.txt", "Hello from memfs\n"],
  ["/notes/todo.txt", "- write tests\n"],
]);
const dirs = new Set(["/", "/notes"]);
const pathOf = (uri) => uri.replace(/^memfs:/, "") || "/";
let touchHandle = null;

exports.activate = (ide) => {
  ide.commands.register("providers.stats", () => ({ ...stats, files: Object.fromEntries(files) }));

  // D234: hello.txt changes "elsewhere" (the provider reports it): an open editor reloads.
  ide.commands.register("providers.touch", () => {
    files.set("/hello.txt", "Changed elsewhere\n");
    touchHandle?.fireDidChange([{ path: "memfs:/hello.txt", kind: "changed" }]);
    return { ok: true };
  });

  ide.commands.register("providers.setup", async () => {
    if (stats.setup) return { ok: true };
    stats.setup = true;

    // A file system provider.
    let fsHandle = null;
    fsHandle = touchHandle = ide.workspace.registerFileSystemProvider(
      "memfs",
      {
        stat: (uri) => {
          const p = pathOf(uri).replace(/\/$/, "") || "/";
          if (dirs.has(p)) return { type: "directory" };
          if (!files.has(p)) throw new Error(`${uri} not found`);
          return { type: "file", size: files.get(p).length };
        },
        readDirectory: (uri) => {
          const base = pathOf(uri).replace(/\/$/, "");
          const out = [];
          for (const d of dirs)
            if (d !== "/" && d.slice(0, d.lastIndexOf("/")) === base) out.push([d.slice(base.length + 1), "directory"]);
          for (const f of files.keys())
            if (f.slice(0, f.lastIndexOf("/")) === base) out.push([f.slice(base.length + 1), "file"]);
          return out;
        },
        readFile: (uri) => {
          const text = files.get(pathOf(uri));
          if (text === undefined) throw new Error(`${uri} not found`);
          return text;
        },
        writeFile: (uri, content) => {
          const text = new TextDecoder().decode(content);
          files.set(pathOf(uri), text);
          stats.written[pathOf(uri)] = text;
          fsHandle?.fireDidChange([{ path: uri, kind: "changed" }]);
        },
        // D234: the Explorer section's New folder, Rename and Delete go through these.
        createDirectory: (uri) => {
          dirs.add(pathOf(uri));
        },
        delete: (uri) => {
          const p = pathOf(uri);
          files.delete(p);
          for (const f of [...files.keys()]) if (f.startsWith(`${p}/`)) files.delete(f);
          dirs.delete(p);
        },
        rename: (from, to) => {
          const a = pathOf(from);
          const b = pathOf(to);
          if (files.has(a)) {
            files.set(b, files.get(a));
            files.delete(a);
          } else if (dirs.has(a)) {
            dirs.delete(a);
            dirs.add(b);
          }
        },
      },
      { label: "Memory files" },
    );

    // Tasks: "memo: greet" runs in a pseudoterminal.
    ide.tasks.registerTaskProvider("memo", {
      provideTasks: () => [
        {
          name: "greet",
          detail: "Says hello in a pseudoterminal",
          execution: {
            kind: "custom",
            start: (definition) => ({
              open: (_dims, io) => {
                stats.taskRuns++;
                io.write(`memo task ran (${definition.type})\r\n`);
                setTimeout(() => io.exit(0), 50);
              },
            }),
          },
        },
      ],
    });

    // Source control over memfs.
    const sc = ide.scm.createSourceControl({ id: "memo", label: "Memo changes" });
    const changes = sc.createResourceGroup("changes", "Changes");
    changes.resourceStates = [
      { path: "memfs:/hello.txt", decorations: { letter: "M", tone: "modified", tooltip: "Changed" } },
      { path: "memfs:/notes/todo.txt", decorations: { letter: "A", tone: "added" } },
    ];
    sc.count = 2;
    sc.inputBox.placeholder = "Memo message";
    sc.acceptInputCommand = { command: "providers.commit", title: "Save memo" };
    sc.quickDiffProvider = {
      provideOriginal: (path) => (path === "memfs:/hello.txt" ? "Hello\n" : null),
    };
    ide.commands.register("providers.commit", () => {
      stats.commits.push(sc.inputBox.value);
      sc.inputBox.value = "";
      return { ok: true };
    });

    // An inline debug adapter: stops on entry, evaluates "memo:<expression>".
    ide.debug.registerDebugAdapterDescriptorFactory("memo-dbg", {
      createDebugAdapterDescriptor: () => ({
        kind: "inline",
        start: (send) => {
          let seq = 1;
          const out = (m) => send({ seq: seq++, ...m });
          const reply = (req, body = {}) =>
            out({ type: "response", request_seq: req.seq, command: req.command, success: true, body });
          const event = (name, body = {}) => out({ type: "event", event: name, body });
          return {
            handleMessage: (req) => {
              stats.debugRequests.push(req.command);
              switch (req.command) {
                case "initialize":
                  return reply(req, { supportsConfigurationDoneRequest: true });
                case "launch":
                  reply(req);
                  return event("initialized");
                case "configurationDone":
                  reply(req);
                  event("output", { category: "console", output: "Memo adapter running\n" });
                  return event("stopped", { reason: "entry", threadId: 1, allThreadsStopped: true });
                case "threads":
                  return reply(req, { threads: [{ id: 1, name: "memo" }] });
                case "stackTrace":
                  return reply(req, {
                    stackFrames: [{ id: 1, name: "memo main", line: 1, column: 1 }],
                    totalFrames: 1,
                  });
                case "scopes":
                  return reply(req, { scopes: [] });
                case "evaluate":
                  return reply(req, { result: `memo:${req.arguments?.expression}`, variablesReference: 0 });
                case "setBreakpoints":
                  return reply(req, { breakpoints: [] });
                case "disconnect":
                case "terminate":
                  reply(req);
                  return event("terminated");
                default:
                  return reply(req);
              }
            },
          };
        },
      }),
    });

    // A sign-in kept by the IDE (no getSessions: the sessions go to the keychain).
    ide.authentication.registerAuthenticationProvider("memo-auth", "Memo account", {
      createSession: (scopes) => ({
        id: `s-${scopes.join("-")}`,
        accessToken: "memo-token",
        account: { id: "ann", label: "Ann" },
        scopes,
      }),
    });
    return { ok: true };
  });

  // A pseudoterminal that echoes what's typed.
  ide.commands.register("providers.echoTerminal", async () => {
    let io = null;
    const terminal = await ide.terminals.create({
      name: "Echo",
      pty: {
        open: (dims, handle) => {
          io = handle;
          handle.write(`Echo terminal ready (${dims.columns}x${dims.rows})\r\n`);
        },
        input: (data) => {
          stats.echoed += data;
          // terminal.sendText sends the text and its Enter in one piece ("hi\r").
          const text = data.replace(/\r$/, "");
          if (text) io?.write(`[${text}]`);
          if (data.endsWith("\r")) io?.write("\r\n");
        },
      },
    });
    return { id: terminal.id };
  });

  ide.commands.register("providers.signIn", async () => {
    const session = await ide.authentication.getSession("memo-auth", ["read"], { createIfNone: true });
    const again = await ide.authentication.getSession("memo-auth", ["read"], { silent: true });
    return { account: session?.account.label ?? null, kept: again?.id ?? null };
  });

  ide.commands.register("providers.secret", async () => {
    await ide.secrets.store("token", "s3cret");
    const value = await ide.secrets.get("token");
    await ide.secrets.delete("token");
    return { value: value ?? null, after: (await ide.secrets.get("token")) ?? null };
  });
};

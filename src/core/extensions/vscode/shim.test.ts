// D256: the `vscode` shim end to end over the worker API (createWorkerApi) with a fake host:
// configuration, commands (VS Code's ids, arguments through the hidden command), providers,
// diagnostics, messages, documents, the context's state and unsupported calls.
import assert from "node:assert/strict";
import { test } from "node:test";
import { STATE_KEY_SLOT } from "../../themes/webviewVars";
import { createWorkerApi, type FromWorker, type RequestMessage, type ToWorker } from "../rpc";
import { createVscodeShim, type ShimFileSystem } from "./index";
import { splitCommandLine, withVscodeBridge } from "./views";

const tick = () => new Promise((r) => setTimeout(r, 0));

function harness(answers: Record<string, (p: Record<string, unknown>) => unknown> = {}) {
  const sent: FromWorker[] = [];
  let deliver: (m: ToWorker) => void = () => {};
  const texts = new Map<string, string>([["/ws/a.md", "# Title\nhello world"]]);
  const settings: Record<string, unknown> = { "acme.greeting": "hi", "editor.tabSize": 2 };
  const storage = new Map<string, unknown>();
  const defaults: Record<string, (p: Record<string, unknown>) => unknown> = {
    "editor.text": (p) => texts.get(String(p.path)) ?? "",
    "editor.active": () => null,
    "settings.get": (p) => settings[String(p.key)] ?? null,
    "storage.get": (p) => storage.get(`${String(p.scope ?? "global")}:${String(p.key)}`) ?? null,
    "storage.set": (p) => {
      storage.set(`${String(p.scope ?? "global")}:${String(p.key)}`, p.value);
      return null;
    },
    "state.get": () => ({ documents: [] }),
    "workspace.isTrusted": () => true,
    "ui.notify": () => "Yes",
    // Views show (a webview view resolves the first time it shows).
    "view.watch": () => true,
  };
  const { api } = createWorkerApi(
    {
      post: (m) => {
        sent.push(m);
        if (m.t === "req") {
          const answer = answers[m.method] ?? defaults[m.method];
          queueMicrotask(() =>
            deliver({
              t: "res",
              id: m.id,
              ok: true,
              value: answer ? answer(m.params as Record<string, unknown>) : null,
            }),
          );
        }
      },
      onMessage: (h) => (deliver = h),
    },
    {
      id: "acme.md-tools",
      version: "1.0.0",
      path: "/ext",
      appName: "Studio",
      workspace: { folders: [{ path: "/ws", name: "ws", index: 0 }], name: "ws", file: null },
    },
  );
  const requests = (method?: string) =>
    sent.filter((m): m is RequestMessage => m.t === "req" && (!method || m.method === method));
  let callId = 1000;
  const call = async (
    kind: ToWorker extends infer T ? (T extends { t: "call"; kind: infer K } ? K : never) : never,
    target: string,
    args?: unknown,
  ) => {
    const id = ++callId;
    deliver({ t: "call", id, kind, target, args });
    for (let i = 0; i < 20; i++) {
      await tick();
      const res = sent.find((m) => m.t === "res" && m.id === id);
      if (res && res.t === "res") {
        if (!res.ok) throw new Error(res.error);
        return res.value;
      }
    }
    throw new Error(`no answer to ${target}`);
  };
  const fire = (type: string, payload: unknown) => {
    for (const r of requests("events.subscribe"))
      if ((r.params as { type: string }).type === type)
        deliver({
          t: "call",
          id: ++callId,
          kind: "event",
          target: String((r.params as { sub: string }).sub),
          args: payload,
        });
  };
  const fs: ShimFileSystem = {
    readFile: async () => new TextEncoder().encode("from disk"),
    writeFile: async () => {},
    stat: async () => ({ type: 1, ctime: 0, mtime: 0, size: 0 }),
    readDirectory: async () => [],
    createDirectory: async () => {},
    delete: async () => {},
    rename: async () => {},
    copy: async () => {},
  };
  const logs: string[] = [];
  const shim = createVscodeShim({
    ide: api,
    init: {
      commands: [
        { id: "mdTools.preview" },
        { id: "markdownTools.toc", vscodeId: "markdown-tools.toc" },
        { id: "mdTools.runVscodeCommand" },
      ],
      shimCommand: "mdTools.runVscodeCommand",
      settings: ["acme.greeting"],
    },
    packageJSON: { publisher: "Acme", name: "md-tools" },
    extensionPath: "/ext",
    globalStoragePath: "/data/global",
    logPath: "/data/logs",
    fs,
    shell: "/bin/sh",
    log: (_level, text) => logs.push(text),
  });
  return {
    api,
    shim,
    vscode: shim.vscode,
    requests,
    call,
    fire,
    texts,
    storage,
    logs,
    /** Sends a message to the worker as the host would (a call, a cancel). */
    send: (m: ToWorker) => deliver(m),
    sent,
  };
}

test("configuration is read before activation and answers synchronously", async () => {
  const h = harness();
  await h.shim.ready();
  const config = h.vscode.workspace.getConfiguration("acme");
  assert.equal(config.get("greeting"), "hi");
  assert.equal(config.get("missing", 7), 7);
  assert.equal(config.greeting, "hi");
  assert.equal(h.vscode.workspace.getConfiguration("editor").get("tabSize"), 2);
  assert.equal(h.vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, "/ws");
  assert.equal(h.vscode.version, "1.106.0");
});

test("commands: VS Code's ids, the IDE's arguments, arguments kept through the hidden command", async () => {
  const h = harness();
  await h.shim.ready();
  const got: unknown[][] = [];
  h.vscode.commands.registerCommand("markdown-tools.toc", (...args: unknown[]) => {
    got.push(args);
    return "done";
  });
  const local = { some: "object" };
  h.vscode.commands.registerCommand("mdTools.local", (arg: unknown) => {
    got.push([arg]);
    return arg === local;
  });
  await tick();
  // Declared: registered with the IDE under the dispatcher's id.
  assert.ok(
    h
      .requests("commands.register")
      .some((r) => (r.params as { id: string }).id === "markdownTools.toc"),
  );
  // Not declared: only in the shim.
  assert.ok(
    !h
      .requests("commands.register")
      .some((r) => (r.params as { id: string }).id === "mdTools.local"),
  );
  assert.equal(await h.call("command", "markdownTools.toc", { path: "/ws/a.md" }), "done");
  const first = got[0]?.[0] as { fsPath: string } | undefined;
  assert.equal(first?.fsPath, "/ws/a.md");
  // A command only the shim has runs in the shim, with its arguments as they are.
  assert.equal(await h.vscode.commands.executeCommand("mdTools.local", local), true);
});

test("providers: the document and 0-based position in, the IDE's shapes out", async () => {
  const h = harness();
  await h.shim.ready();
  const { languages, Hover, MarkdownString, Location, Uri, Range, CodeLens } = h.vscode;
  languages.registerHoverProvider("markdown", {
    provideHover(
      doc: { getText(r?: unknown): string; getWordRangeAtPosition(p: unknown): unknown },
      pos: { line: number; character: number },
    ) {
      return new Hover(
        new MarkdownString(
          `**${doc.getText(doc.getWordRangeAtPosition(pos))}** at ${pos.line}:${pos.character}`,
        ),
      );
    },
  });
  languages.registerDefinitionProvider(
    { language: "markdown" },
    {
      provideDefinition: () => new Location(Uri.file("/ws/b.md"), new Range(1, 0, 1, 4)),
    },
  );
  const args = { deep: true };
  languages.registerCodeLensProvider("markdown", {
    provideCodeLenses: () => [
      new CodeLens(new Range(0, 0, 0, 1), {
        title: "Run",
        command: "mdTools.lens",
        arguments: [args],
      }),
    ],
  });
  let lensArg: unknown;
  h.vscode.commands.registerCommand("mdTools.lens", (a: unknown) => {
    lensArg = a;
  });
  await tick();
  const regs = h.requests("languages.register").map((r) => r.params as Record<string, unknown>);
  const hover = regs.find((r) => r.hover);
  assert.ok(hover);
  const ctx = {
    path: "/ws/a.md",
    languageId: "markdown",
    line: 2,
    column: 3,
    word: "hello",
    linePrefix: "he",
  };
  assert.equal(await h.call("hover", String(hover.id), ctx), "**hello** at 1:2");
  const definition = regs.find((r) => r.feature === "definition");
  assert.deepEqual(await h.call("provider", String(definition?.id), ctx), [
    { path: "/ws/b.md", startLine: 2, startColumn: 1, endLine: 2, endColumn: 5 },
  ]);
  const lens = regs.find((r) => r.feature === "codeLens");
  const lenses = (await h.call("provider", String(lens?.id), {
    path: "/ws/a.md",
    languageId: "markdown",
  })) as {
    title: string;
    command: string;
    input: unknown;
  }[];
  assert.equal(lenses[0]?.title, "Run");
  assert.equal(lenses[0]?.command, "mdTools.runVscodeCommand");
  await h.call("command", "mdTools.runVscodeCommand", lenses[0]?.input);
  assert.equal(lensArg, args);
  // The hover's document is the one workspace.textDocuments has.
  assert.equal(h.vscode.workspace.textDocuments[0]?.getText(), "# Title\nhello world");
});

test("a webview panel serializer gets VS Code's panel and the page's saved state", async () => {
  const h = harness();
  await h.shim.ready();
  const seen: unknown[] = [];
  h.vscode.window.registerWebviewPanelSerializer("mdPreview", {
    deserializeWebviewPanel(
      panel: { viewType: string; webview: { html: string } },
      state: unknown,
    ) {
      seen.push(panel.viewType, state);
      panel.webview.html = "<p>again</p>";
    },
  });
  await tick();
  assert.equal(
    (h.requests("webviewPanel.serializer")[0]?.params as { viewType?: string })?.viewType,
    "mdPreview",
  );
  await h.call("provider", "webviewPanelSerializer.mdPreview", {
    id: "restored1",
    title: "Preview",
    state: { scroll: 3 },
  });
  await tick();
  assert.deepEqual(seen, ["mdPreview", { scroll: 3 }]);
  const update = h.requests("webviewPanel.update").pop()?.params as { id: string; html: string };
  assert.equal(update.id, "restored1");
  // The page gets VS Code's page API (the bridge), as a new panel's does.
  assert.match(update.html, /acquireVsCodeApi/);
  assert.match(update.html, /<p>again<\/p>/);
});

test("log channels: the level the user picks, and its change events", async () => {
  const h = harness({ "logLevels.get": () => ({ default: 3, channels: {} }) });
  await h.shim.ready();
  const { window, env, LogLevel } = h.vscode;
  const log = window.createOutputChannel("Md log", { log: true }) as unknown as {
    readonly logLevel: number;
    debug(message: string): void;
    onDidChangeLogLevel(listener: (level: number) => void): unknown;
  };
  await tick();
  assert.equal((h.requests("output.create").pop()?.params as { log?: boolean })?.log, true);
  assert.equal(log.logLevel, LogLevel.Info);
  log.debug("hidden");
  const heard: number[] = [];
  log.onDidChangeLogLevel((l: number) => heard.push(l));
  const defaults: number[] = [];
  env.onDidChangeLogLevel((l: number) => defaults.push(l));
  await h.call("provider", "logLevels", {
    default: LogLevel.Warning,
    channels: { "ext.acme.md-tools~md-log": LogLevel.Trace },
  });
  assert.equal(log.logLevel, LogLevel.Trace);
  assert.equal(env.logLevel, LogLevel.Warning);
  assert.deepEqual(heard, [LogLevel.Trace]);
  assert.deepEqual(defaults, [LogLevel.Warning]);
  log.debug("shown");
  await tick();
  const lines = h
    .requests("output.append")
    .flatMap((r) => (r.params as { lines: { text: string }[] }).lines.map((l) => l.text));
  assert.deepEqual(lines, ["shown"]);
});

test("a hover's own range goes to the editor (1-based), for its highlight", async () => {
  const h = harness();
  await h.shim.ready();
  const { languages, Hover, Range } = h.vscode;
  languages.registerHoverProvider("markdown", {
    provideHover: () => new Hover("all of it", new Range(1, 0, 1, 11)),
  });
  await tick();
  const hover = h
    .requests("languages.register")
    .map((r) => r.params as Record<string, unknown>)
    .find((r) => r.hover);
  const ctx = { path: "/ws/a.md", languageId: "markdown", line: 2, column: 3 };
  assert.deepEqual(await h.call("hover", String(hover?.id), { ...ctx, word: "", linePrefix: "" }), {
    contents: "all of it",
    range: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 12 },
  });
});

test("diagnostics of every collection go to the IDE per file", async () => {
  const h = harness();
  await h.shim.ready();
  const { languages, Diagnostic, DiagnosticSeverity, Range, Uri } = h.vscode;
  const a = languages.createDiagnosticCollection("a");
  const b = languages.createDiagnosticCollection("b");
  const uri = Uri.file("/ws/a.md");
  a.set(uri, [new Diagnostic(new Range(0, 0, 0, 5), "bad", DiagnosticSeverity.Warning)]);
  b.set([[uri, [new Diagnostic(new Range(1, 0, 1, 1), "worse")]]]);
  await tick();
  await tick();
  const last = h.requests("languages.setDiagnostics").pop()?.params as {
    path: string;
    items: unknown[];
  };
  assert.equal(last.path, "/ws/a.md");
  assert.deepEqual(last.items, [
    { line: 1, column: 1, endLine: 1, endColumn: 6, message: "bad", severity: "warning" },
    { line: 2, column: 1, endLine: 2, endColumn: 2, message: "worse", severity: "error" },
  ]);
  assert.equal(languages.getDiagnostics(uri).length, 2);
  a.clear();
  b.dispose();
  await tick();
  await tick();
  assert.ok(h.requests("languages.clearDiagnostics").length > 0);
});

test("an extension that's stopping logs its messages instead of showing them (D386)", async () => {
  const h = harness();
  await h.shim.ready();
  // Live Server's dispose() calls its GoOffline, which says "Server is not already running".
  h.vscode.window.showInformationMessage("Server is now online", "Don't show again");
  const shown = h.requests("ui.notify").length;
  assert.equal(shown, 1);
  h.shim.beginStop();
  assert.equal(
    await h.vscode.window.showInformationMessage(
      "Server is not already running",
      "Don't show again",
    ),
    undefined,
  );
  assert.equal(await h.vscode.window.showErrorMessage("gone"), undefined);
  assert.equal(h.requests("ui.notify").length, shown);
  assert.ok(h.logs.some((l) => l.includes("not shown) info: Server is not already running")));
});

test("messages, documents from the IDE's events, the context's state, unsupported calls", async () => {
  const h = harness();
  await h.shim.ready();
  assert.equal(await h.vscode.window.showInformationMessage("Hi", "Yes", "No"), "Yes");
  const notified = h.requests("ui.notify").pop()?.params as { actions: string[] } | undefined;
  assert.deepEqual(notified?.actions, ["Yes", "No"]);

  const opened: string[] = [];
  const changed: string[] = [];
  h.vscode.workspace.onDidOpenTextDocument((d: { fileName: string }) => opened.push(d.fileName));
  h.vscode.workspace.onDidChangeTextDocument((e: { contentChanges: readonly { text: string }[] }) =>
    changed.push(e.contentChanges[0]?.text ?? ""),
  );
  h.fire("documents.didOpen", { path: "/ws/a.md", languageId: "markdown" });
  for (let i = 0; i < 5; i++) await tick();
  h.texts.set("/ws/a.md", "# Title\nhello there world");
  h.fire("documents.didChange", { path: "/ws/a.md" });
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(opened, ["/ws/a.md"]);
  assert.deepEqual(changed, ["there "]);

  const { context } = h.shim;
  assert.equal(context.globalState.get("count", 0), 0);
  await context.globalState.update("count", 3);
  assert.equal(context.globalState.get("count"), 3);
  assert.deepEqual(h.storage.get("global:vscode.globalState"), { count: 3 });
  assert.equal(context.asAbsolutePath("media/x.svg"), "/ext/media/x.svg");

  assert.equal((h.vscode.window as Record<string, unknown>).registerSomethingNew, undefined);
  assert.equal((h.vscode.window as Record<string, unknown>).registerSomethingNew, undefined);
  assert.equal(h.logs.filter((l) => l.includes("window.registerSomethingNew")).length, 1);
  assert.deepEqual(h.shim.unsupportedCalls(), [["window.registerSomethingNew", 2]]);
});

test("D257: webview views and custom editors write their pages through setHtml", async () => {
  const h = harness();
  await h.shim.ready();
  const { window } = h.vscode;
  window.registerWebviewViewProvider("mdTools.page", {
    resolveWebviewView(view: { webview: { html: string } }) {
      view.webview.html = "<html><head></head><body>view</body></html>";
    },
  });
  let docText = "";
  window.registerCustomEditorProvider("mdTools.editor", {
    resolveCustomTextEditor(doc: { getText(): string }, panel: { webview: { html: string } }) {
      docText = doc.getText();
      panel.webview.html = "<body>editor</body>";
    },
  });
  await h.call("webview", "mdTools.editor", { ide: "viewerOpened", path: "/ws/a.md", instance: 7 });
  for (let i = 0; i < 5; i++) await tick();
  const pages = h
    .requests("webview.setHtml")
    .map((r) => r.params as { viewId: string; html: string; instance?: number });
  const view = pages.find((p) => p.viewId === "mdTools.page");
  assert.ok(view?.html.includes("acquireVsCodeApi") && view.html.includes("view"));
  const editor = pages.find((p) => p.viewId === "mdTools.editor");
  assert.equal(editor?.instance, 7);
  assert.equal(docText, "# Title\nhello world");
});

test("D257: debug adapters, task providers and VS Code's git API", async () => {
  const h = harness({
    "git.repositories": () => [
      { root: "/ws", name: "ws", kind: "workspace", selected: true, branch: "main" },
    ],
    "git.refs": () => ({
      branches: [
        { name: "main", remote: false, current: true, upstream: null, commit: "abc", subject: "s" },
      ],
      tags: ["v1"],
    }),
    "state.get": (p) =>
      p.path === "ide://git/status"
        ? {
            root: "/ws",
            staged: [{ path: "/ws/a.md", status: "A" }],
            changes: [{ path: "/ws/b.md", status: "M" }],
          }
        : { documents: [] },
  });
  await h.shim.ready();
  const v = h.vscode;
  v.debug.registerDebugAdapterDescriptorFactory("mock", {
    createDebugAdapterDescriptor: () => new v.DebugAdapterExecutable("node", ["adapter.js"]),
  });
  v.tasks.registerTaskProvider("acme", {
    provideTasks: () => [
      new v.Task(
        { type: "acme" },
        v.TaskScope.Workspace,
        "build",
        "acme",
        new v.ShellExecution("make"),
      ),
    ],
  });
  await tick();
  const debugId = (h.requests("debug.register")[0]?.params as { id: string } | undefined)?.id ?? "";
  assert.deepEqual(
    await h.call("provider", debugId, {
      sessionId: "s1",
      session: { id: "s1", type: "mock", name: "x" },
    }),
    {
      kind: "executable",
      command: "node",
      args: ["adapter.js"],
    },
  );
  const tasks = (await h.call("provider", "tasks1", {})) as {
    name: string;
    execution: { commandLine: string };
  }[];
  assert.equal(tasks[0]?.name, "build");
  assert.equal(tasks[0]?.execution.commandLine, "make");

  const git = v.extensions.getExtension("vscode.git") as {
    exports: {
      getAPI(n: number): {
        repositories: {
          state: {
            HEAD?: { name?: string };
            indexChanges: { status: number }[];
            workingTreeChanges: { status: number }[];
          };
        }[];
        state: string;
      };
    };
  };
  const api = git.exports.getAPI(1);
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(api.state, "initialized");
  assert.equal(api.repositories[0]?.state.HEAD?.name, "main");
  assert.equal(api.repositories[0]?.state.indexChanges[0]?.status, 1);
  assert.equal(api.repositories[0]?.state.workingTreeChanges[0]?.status, 5);
});

test("D258: tree file icons and reveal, file decorations, language configuration, tools, commands", async () => {
  const h = harness({
    "commands.execute": (p) => ({ ran: p.id }),
  });
  await h.shim.ready();
  const v = h.vscode;
  // A tree whose rows have file icons, revealed through getParent.
  const tree = {
    getChildren: (el?: string) => (el ? (el === "a" ? ["a/1"] : []) : ["a", "b"]),
    getTreeItem: (el: string) => {
      const item = new v.TreeItem(
        el,
        el === "a" ? v.TreeItemCollapsibleState.Collapsed : v.TreeItemCollapsibleState.None,
      );
      item.iconPath = { light: v.Uri.file("/ext/l.svg"), dark: v.Uri.file("/ext/d.svg") };
      return item;
    },
    getParent: (el: string) => (el === "a/1" ? "a" : undefined),
  };
  const view = v.window.createTreeView("mdTools.links", { treeDataProvider: tree });
  const rows = (await h.call("tree", "mdTools.links", {})) as {
    id: string;
    iconPath?: string;
    iconPathDark?: string;
  }[];
  assert.equal(rows[0]?.iconPath, "/ext/l.svg");
  assert.equal(rows[0]?.iconPathDark, "/ext/d.svg");
  await view.reveal("a/1", { focus: true });
  const reveal = h.requests("tree.reveal").pop()?.params as
    | { path: string[]; focus: boolean }
    | undefined;
  assert.deepEqual(reveal?.path, ["mdTools.links/a", "mdTools.links/a/a/1"]);
  assert.equal(reveal?.focus, true);
  // Its title and description go to the view's header.
  view.title = "Links (2)";
  view.description = "main";
  await tick();
  assert.deepEqual(h.requests("view.title").pop()?.params, {
    viewId: "mdTools.links",
    title: "Links (2)",
    description: "main",
  });

  // Explorer badges.
  v.window.registerFileDecorationProvider({
    provideFileDecoration: (uri: { fsPath: string }) =>
      uri.fsPath.endsWith("a.md")
        ? new v.FileDecoration("M", "changed", new v.ThemeColor("charts.red"))
        : undefined,
  });
  await tick();
  const decoId =
    (h.requests("decorations.register")[0]?.params as { id: string } | undefined)?.id ?? "";
  assert.deepEqual(
    await h.call("provider", `decorations.${decoId}`, { paths: ["/ws/a.md", "/ws/b.md"] }),
    [
      { path: "/ws/a.md", decoration: { badge: "M", tooltip: "changed", color: "charts.red" } },
      { path: "/ws/b.md", decoration: null },
    ],
  );

  // Language configuration: RegExps travel as patterns.
  v.languages.setLanguageConfiguration("markdown", {
    wordPattern: /\w+/g,
    onEnterRules: [{ beforeText: /^#/, action: { indentAction: 0 } }],
  });
  await tick();
  const config = h.requests("languages.setConfiguration").pop()?.params as
    | { configuration: { wordPattern: unknown } }
    | undefined;
  assert.deepEqual(config?.configuration.wordPattern, { pattern: "\\w+", flags: "" });

  // VS Code's command ids run the IDE's.
  assert.deepEqual(await v.commands.executeCommand("workbench.action.files.save"), {
    ran: "editor.save",
  });
  assert.deepEqual(await v.commands.executeCommand("revealInExplorer", v.Uri.file("/ws/a.md")), {
    ran: "explorer.reveal",
  });
  const reveal2 = h.requests("commands.execute").pop()?.params as
    | { input: { path: string } }
    | undefined;
  assert.equal(reveal2?.input.path, "/ws/a.md");
});

test("D261: a terminal's shellArgs string splits as Windows reads a command line", () => {
  assert.deepEqual(splitCommandLine('-NoExit -Command "Write-Host ""hi"" there"'), [
    "-NoExit",
    "-Command",
    'Write-Host "hi" there',
  ]);
  assert.deepEqual(splitCommandLine('  /k  ""  x'), ["/k", "", "x"]);
  assert.deepEqual(splitCommandLine(""), []);
});

test("A QuickPick is a live session: shown at once, busy and items sent while open, accept keeps it", async () => {
  const h = harness();
  const vscode = h.vscode as unknown as {
    window: {
      createQuickPick(): {
        items: { label: string }[];
        busy: boolean;
        show(): void;
        hide(): void;
        onDidAccept(l: () => void): unknown;
        onDidHide(l: () => void): unknown;
        selectedItems: readonly { label: string }[];
      };
    };
  };
  const qp = vscode.window.createQuickPick();
  let accepted = "";
  let hidden = 0;
  qp.onDidAccept(() => {
    accepted = qp.selectedItems[0]?.label ?? "";
  });
  qp.onDidHide(() => hidden++);
  qp.show();
  qp.busy = true;
  await tick();
  const open = h.requests("quickInput.open")[0]?.params as { id: string; kind: string };
  assert.equal(open.kind, "pick");
  qp.items = [{ label: "one" }, { label: "two" }];
  qp.busy = false;
  await tick();
  const updates = h.requests("quickInput.update").map((r) => (r.params as { props: object }).props);
  assert.deepEqual(
    updates.map((u) => Object.keys(u).sort()),
    [["busy"], ["busy", "items", "selectedIndexes"]],
  );
  await h.call("provider", `quickInput.${open.id}`, { kind: "selection", indexes: [1] });
  await h.call("provider", `quickInput.${open.id}`, { kind: "accept" });
  assert.equal(accepted, "two");
  assert.equal(hidden, 0, "accepting doesn't hide it (VS Code's)");
  qp.hide();
  await tick();
  assert.equal(h.requests("quickInput.hide").length, 1);
  await h.call("provider", `quickInput.${open.id}`, { kind: "hide" });
  await h.call("provider", `quickInput.${open.id}`, { kind: "hide" });
  assert.equal(hidden, 1, "onDidHide fires once");
});

test("D261: breakpoints an extension adds are its own objects, and it can remove them", async () => {
  const list: { id: number; path: string; line: number }[] = [];
  const removed: number[] = [];
  const h = harness({
    "state.get": (p) => (p.path === "ide://debug" ? { breakpoints: list } : { documents: [] }),
    "commands.execute": (p) => {
      const input = p.input as { path?: string; line?: number; id?: number };
      if (p.id === "debug.setBreakpoint")
        list.push({ id: list.length + 1, path: String(input.path), line: Number(input.line) });
      if (p.id === "debug.removeBreakpoint") removed.push(Number(input.id));
      return null;
    },
  });
  const v = h.vscode as unknown as {
    SourceBreakpoint: new (location: unknown) => unknown;
    Location: new (uri: unknown, position: unknown) => unknown;
    Position: new (line: number, character: number) => unknown;
    Uri: { file(p: string): unknown };
    debug: {
      breakpoints: readonly unknown[];
      addBreakpoints(list: unknown[]): void;
      removeBreakpoints(list: unknown[]): void;
    };
  };
  const bp = new v.SourceBreakpoint(new v.Location(v.Uri.file("/ws/a.ts"), new v.Position(4, 0)));
  v.debug.addBreakpoints([bp]);
  for (let i = 0; i < 10 && !v.debug.breakpoints.length; i++) await tick();
  assert.equal(v.debug.breakpoints[0], bp);
  v.debug.removeBreakpoints([bp]);
  for (let i = 0; i < 10 && !removed.length; i++) await tick();
  assert.deepEqual(removed, [1]);
});

test("D261: openTextDocument({ content }) is untitled and open; showing it opens it in the IDE", async () => {
  let made = "";
  const h = harness({
    "commands.execute": (p) => {
      if (p.id === "workspace.newUntitledFile") {
        made = String((p.input as { text?: string }).text);
        return { path: "untitled:Untitled-7" };
      }
      return null;
    },
    "editor.text": (p) => (String(p.path) === "untitled:Untitled-7" ? made : ""),
  });
  const v = h.vscode as unknown as {
    workspace: {
      openTextDocument(o: { content: string; language: string }): Promise<{
        isUntitled: boolean;
        getText(): string;
      }>;
      textDocuments: readonly unknown[];
    };
    window: { showTextDocument(d: unknown): Promise<{ document: { getText(): string } }> };
  };
  const doc = await v.workspace.openTextDocument({ content: '{"a":1}', language: "json" });
  assert.equal(doc.isUntitled, true);
  assert.ok(v.workspace.textDocuments.includes(doc));
  const editor = await v.window.showTextDocument(doc);
  assert.equal(made, '{"a":1}');
  assert.equal(editor.document.getText(), '{"a":1}');
});

test("D263: a page's saved state has its own key, which the IDE fills in", () => {
  const page = withVscodeBridge("<html><head></head><body></body></html>");
  assert.equal(page.split(STATE_KEY_SLOT).length, 2);
  assert.ok(!page.includes('sessionStorage.getItem("vscode-state")'));
});

test("D264: terminal links come from the extension's provider, and a click goes back to it", async () => {
  const h = harness();
  let handled: unknown;
  const v = h.vscode as unknown as {
    window: {
      registerTerminalLinkProvider(p: {
        provideTerminalLinks(ctx: { line: string }): unknown[];
        handleTerminalLink(link: unknown): void;
      }): unknown;
    };
  };
  v.window.registerTerminalLinkProvider({
    provideTerminalLinks: (ctx) => {
      const at = ctx.line.indexOf("T-1");
      return at < 0 ? [] : [{ startIndex: at, length: 3, tooltip: "Ticket", id: "T-1" }];
    },
    handleTerminalLink: (link) => {
      handled = link;
    },
  });
  await tick();
  const reg = h.requests("terminals.registerLinkProvider")[0];
  const id = String((reg?.params as { id?: string } | undefined)?.id);
  const links = (await h.call("provider", id, {
    line: "see T-1 now",
    terminal: { name: "x" },
  })) as {
    key: string;
    startIndex: number;
    length: number;
    tooltip: string;
  }[];
  assert.equal(links[0]?.startIndex, 4);
  assert.equal(links[0]?.tooltip, "Ticket");
  await h.call("provider", `${id}.handle`, { key: links[0]?.key });
  assert.equal((handled as { id: string }).id, "T-1");
});

test("D264: its environment variable collection goes to the IDE", async () => {
  const h = harness();
  const ctx = h.shim.context as unknown as {
    environmentVariableCollection: { replace(n: string, v: string): void };
  };
  ctx.environmentVariableCollection.replace("PORT", "9");
  await tick();
  const sent = h.requests("terminals.setEnvironment")[0];
  assert.deepEqual((sent?.params as { changes?: unknown[] } | undefined)?.changes, [
    { variable: "PORT", value: "9", type: "replace" },
  ]);
});

test("notebooks: documents with their cells, the active editor, NotebookEdits (D265)", async () => {
  const cells = [
    { index: 0, id: "a", kind: "markdown", source: "# Title", metadata: {}, language: "markdown" },
    {
      index: 1,
      id: "b",
      kind: "code",
      source: "print(1)",
      metadata: { tags: ["x"] },
      language: "python",
      executionCount: 3,
      outputs: [{ output_type: "stream", name: "stdout", text: "1\n" }],
    },
  ];
  const ran: { id: string; input: Record<string, unknown> }[] = [];
  const h = harness({
    "commands.execute": (p) => {
      const input = (p.input ?? {}) as Record<string, unknown>;
      ran.push({ id: String(p.id), input });
      if (p.id === "notebook.read")
        return structuredClone({
          path: "/ws/n.ipynb",
          type: "jupyter-notebook",
          metadata: { k: 1 },
          cells,
        });
      if (p.id === "notebook.insertCell") {
        const index = Number(input.index);
        cells.splice(index, 0, {
          index,
          id: `new${index}`,
          kind: String(input.kind),
          source: String(input.source),
          metadata: {},
          language: "python",
        });
        return { cellId: `new${index}`, index };
      }
      return {};
    },
  });
  await h.shim.ready();
  const v = h.vscode;
  const opened: unknown[] = [];
  v.workspace.onDidOpenNotebookDocument((nb: unknown) => opened.push(nb));
  h.fire("notebook.didOpen", { path: "/ws/n.ipynb", notebookType: "jupyter-notebook" });
  for (let i = 0; i < 10 && !opened.length; i++) await tick();
  const nb = v.workspace.notebookDocuments[0];
  assert.ok(nb);
  assert.equal(opened[0], nb);
  assert.equal(nb.cellCount, 2);
  assert.equal(nb.cellAt(0)?.kind, v.NotebookCellKind.Markup);
  assert.equal(nb.cellAt(1)?.document.getText(), "print(1)");
  assert.equal(nb.cellAt(1)?.document.languageId, "python");
  assert.equal(nb.cellAt(1)?.executionSummary?.executionOrder, 3);
  assert.equal(nb.cellAt(1)?.outputs[0]?.items[0]?.mime, "application/vnd.code.notebook.stdout");
  // VS Code's ipynb layout (dropCustomMetadata): the file's metadata under `metadata`.
  assert.deepEqual(nb.metadata, {
    cells: [],
    metadata: { k: 1 },
    nbformat: 4,
    nbformat_minor: 5,
    indentAmount: " ",
  });
  assert.deepEqual(nb.cellAt(1)?.metadata, {
    execution_count: 3,
    metadata: { tags: ["x"] },
    id: "b",
  });
  assert.deepEqual(nb.cellAt(0)?.metadata, { metadata: {}, id: "a" });
  // Cells' documents are open text documents.
  const cellDoc = nb.cellAt(1)?.document;
  assert.ok(cellDoc && v.workspace.textDocuments.includes(cellDoc));

  // The active notebook editor and its selection.
  const actives: unknown[] = [];
  v.window.onDidChangeActiveNotebookEditor((e: unknown) => actives.push(e));
  h.fire("notebook.didChangeEditor", { path: "/ws/n.ipynb", selection: [1] });
  await tick();
  assert.equal(v.window.activeNotebookEditor?.notebook, nb);
  assert.deepEqual(
    [v.window.activeNotebookEditor?.selection.start, v.window.activeNotebookEditor?.selection.end],
    [1, 2],
  );
  assert.equal(actives.length, 1);

  // An edit inserting a cell, then one replacing a cell's metadata.
  const kept = nb.cellAt(1);
  const edit = new v.WorkspaceEdit();
  edit.set(nb.uri, [
    v.NotebookEdit.insertCells(1, [
      new v.NotebookCellData(v.NotebookCellKind.Code, "x = 2", "sql"),
    ]),
    v.NotebookEdit.updateCellMetadata(2, { owner: "me" }),
  ]);
  const changes: unknown[] = [];
  v.workspace.onDidChangeNotebookDocument((e: unknown) => changes.push(e));
  assert.equal(await v.workspace.applyEdit(edit), true);
  const steps = ran.filter((r) => r.id !== "notebook.read");
  assert.deepEqual(
    steps.map((r) => r.id),
    ["notebook.insertCell", "notebook.changeCellLanguage", "notebook.setMetadata"],
  );
  assert.deepEqual(steps[0]?.input, {
    path: "/ws/n.ipynb",
    index: 1,
    kind: "code",
    source: "x = 2",
  });
  assert.deepEqual(steps[2]?.input, {
    path: "/ws/n.ipynb",
    cellId: "b",
    metadata: { owner: "me", tags: null },
  });
  assert.equal(nb.cellCount, 3);
  // The cell that moved is the same object, at its new index.
  assert.equal(nb.cellAt(2), kept);
  assert.equal(kept?.index, 2);
  assert.equal(changes.length >= 1, true);
});

test("an untitled notebook from an extension's data (D267)", async () => {
  const ran: { id: string; input: Record<string, unknown> }[] = [];
  const h = harness({
    "commands.execute": (p) => {
      const input = (p.input ?? {}) as Record<string, unknown>;
      ran.push({ id: String(p.id), input });
      if (p.id === "notebook.newUntitled") return { path: "untitled:Untitled-1.ipynb" };
      if (p.id === "notebook.read")
        return {
          path: "untitled:Untitled-1.ipynb",
          type: "jupyter.notebook",
          cells: [{ index: 0, id: "a", kind: "code", source: "1 + 1", language: "python" }],
        };
      return {};
    },
  });
  await h.shim.ready();
  const v = h.vscode;
  const nb = await v.workspace.openNotebookDocument(
    "jupyter-notebook",
    new v.NotebookData([new v.NotebookCellData(v.NotebookCellKind.Code, "1 + 1", "python")]),
  );
  assert.deepEqual(ran[0]?.input, {
    type: "jupyter.notebook",
    notebook: {
      cells: [
        {
          kind: "code",
          source: "1 + 1",
          // The notebook's language (VS Code's ipynb writes a cell's only when it differs).
          metadata: {},
          executionCount: null,
        },
      ],
    },
  });
  assert.equal(nb.isUntitled, true);
  assert.equal(nb.uri.scheme, "untitled");
  assert.equal(nb.uri.toString(), "untitled:Untitled-1.ipynb");
  assert.equal(nb.notebookType, "jupyter-notebook");
  assert.equal(nb.cellAt(0)?.document.getText(), "1 + 1");
});

test("interactive.open makes an Interactive Window; its cells run by VS Code's arguments", async () => {
  const path = "untitled:Untitled-1.interactive";
  const ran: { id: string; input: Record<string, unknown> }[] = [];
  let fire: (event: string, payload: unknown) => void = () => {};
  const h = harness({
    "commands.execute": (p) => {
      const input = (p.input ?? {}) as Record<string, unknown>;
      ran.push({ id: String(p.id), input });
      if (p.id === "notebook.newUntitled") {
        // The IDE opens it and tells the shim, as its notebook editor does.
        setTimeout(() => {
          fire("notebook.didOpen", { path, notebookType: "interactive" });
          fire("notebook.didChangeEditor", { path, selection: [] });
        }, 0);
        return { path };
      }
      if (p.id === "notebook.read")
        return {
          path,
          type: "interactive",
          cells: [{ index: 0, id: "a", kind: "code", source: "x = 1", language: "python" }],
        };
      return {};
    },
  });
  fire = h.fire;
  await h.shim.ready();
  const v = h.vscode;
  const r = (await v.commands.executeCommand(
    "interactive.open",
    { viewColumn: 2, preserveFocus: true },
    undefined,
    "ms-toolsai.jupyter/k1",
    "Interactive - a.py",
  )) as { notebookUri: { toString(): string }; notebookEditor?: { notebook: unknown } };
  assert.deepEqual(ran[0], { id: "notebook.newUntitled", input: { type: "interactive" } });
  assert.equal(r.notebookUri.toString(), path);
  const nb = r.notebookEditor?.notebook as { notebookType: string; uri: unknown } | undefined;
  assert.equal(nb?.notebookType, "interactive");
  // Jupyter runs the cell it added: { ranges, document }.
  await v.commands.executeCommand("notebook.cell.execute", {
    ranges: [{ start: 0, end: 1 }],
    document: nb?.uri,
  });
  assert.deepEqual(ran.at(-1), { id: "notebook.runCell", input: { path, index: 0 } });
});

test("a webview view's show() while it's being resolved opens it in the background (D269)", async () => {
  const h = harness();
  await h.shim.ready();
  let shown: { show(preserveFocus?: boolean): void } | undefined;
  h.vscode.window.registerWebviewViewProvider("mdTools.page", {
    resolveWebviewView(view: { show(preserveFocus?: boolean): void }) {
      // As some extensions do: in VS Code the view is already being opened by then.
      view.show(true);
      shown = view;
    },
  });
  for (let i = 0; i < 5; i++) await tick();
  const reveals = () => h.requests("webview.reveal").map((r) => r.params);
  assert.deepEqual(reveals(), [{ viewId: "mdTools.page", background: true }]);
  // Asked for later (a command the user ran): it opens and shows.
  shown?.show();
  await tick();
  assert.deepEqual(reveals()[1], { viewId: "mdTools.page", background: false });
});

const markdownAt = {
  path: "/ws/a.md",
  languageId: "markdown",
  line: 1,
  column: 1,
  word: "",
  linePrefix: "",
};

test("language providers: the editor's cancellation reaches the provider's token", async () => {
  const h = harness();
  await h.shim.ready();
  let cancelled = false;
  h.vscode.languages.registerHoverProvider("markdown", {
    provideHover: (
      _doc: unknown,
      _pos: unknown,
      token: { onCancellationRequested(l: () => void): void },
    ) =>
      new Promise((resolve) =>
        token.onCancellationRequested(() => {
          cancelled = true;
          resolve(undefined);
        }),
      ),
  });
  await tick();
  const hover = h
    .requests("languages.register")
    .find((r) => (r.params as { hover?: boolean }).hover);
  const target = String((hover?.params as { id?: string } | undefined)?.id);
  h.send({ t: "call", id: 77, kind: "hover", target, args: markdownAt });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(cancelled, false);
  h.send({ t: "cancel", id: 77 });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(cancelled, true);
  assert.ok(h.sent.some((m) => m.t === "res" && m.id === 77));
});

test("completions: incomplete lists, resolve, commit characters, insert/replace, snippets, commands", async () => {
  const h = harness();
  await h.shim.ready();
  const { languages, CompletionItem, CompletionList, CompletionItemKind, SnippetString, Range } =
    h.vscode;
  let asked: { triggerKind: number } | undefined;
  languages.registerCompletionItemProvider(
    "markdown",
    {
      provideCompletionItems: (
        _d: unknown,
        _p: unknown,
        _t: unknown,
        c: { triggerKind: number },
      ) => {
        asked = c;
        const item = new CompletionItem(
          { label: "print", detail: "(x)", description: "builtins" },
          CompletionItemKind.Function,
        );
        item.insertText = new SnippetString("print(${1})");
        item.range = { inserting: new Range(1, 0, 1, 2), replacing: new Range(1, 0, 1, 5) };
        item.commitCharacters = ["("];
        item.command = { title: "", command: "editor.action.triggerParameterHints" };
        const other = new CompletionItem("os", CompletionItemKind.Module);
        return new CompletionList([item, other], true);
      },
      resolveCompletionItem: (item: { documentation?: string }) => {
        item.documentation = "Prints.";
        return item;
      },
    },
    ".",
  );
  await tick();
  const reg = h
    .requests("languages.register")
    .find((r) => (r.params as { completion?: boolean }).completion);
  const params = reg?.params as { id: string; resolve?: boolean };
  assert.equal(params.resolve, true);
  const list = (await h.call("completion", params.id, {
    ...markdownAt,
    line: 2,
    column: 3,
    triggerKind: "incomplete",
  })) as { items: Record<string, unknown>[]; isIncomplete?: boolean };
  assert.equal(asked?.triggerKind, 2);
  assert.equal(list.isIncomplete, true);
  const [first, second] = list.items;
  assert.equal(first?.label, "print");
  assert.equal(first?.labelDetail, "(x)");
  assert.equal(first?.labelDescription, "builtins");
  assert.equal(first?.insertText, "print(${1})");
  assert.equal(first?.snippet, true);
  assert.equal(first?.kind, "function");
  assert.deepEqual(first?.range, { startLine: 2, startColumn: 1, endLine: 2, endColumn: 3 });
  assert.deepEqual(first?.replaceRange, { startLine: 2, startColumn: 1, endLine: 2, endColumn: 6 });
  assert.deepEqual(first?.commitCharacters, ["("]);
  assert.equal(first?.command, "editor.action.triggerParameterHints");
  assert.equal(second?.kind, "module");
  const resolved = (await h.call("provider", `${params.id}.resolve`, {
    resolveId: first?.resolveId,
  })) as { documentation?: string };
  assert.equal(resolved.documentation, "Prints.");
});

test("inlay hints keep their parts, edits and resolve; range semantic tokens get the range", async () => {
  const h = harness();
  await h.shim.ready();
  const v = h.vscode;
  v.languages.registerInlayHintsProvider("markdown", {
    provideInlayHints: () => {
      const part = new v.InlayHintLabelPart("int");
      part.location = new v.Location(
        v.Uri.file("/elsewhere/typeshed/builtins.pyi"),
        new v.Range(9, 0, 9, 3),
      );
      const hint = new v.InlayHint(new v.Position(0, 7), [new v.InlayHintLabelPart(": "), part]);
      hint.textEdits = [v.TextEdit.insert(new v.Position(0, 7), ": int")];
      return [hint];
    },
    resolveInlayHint: (hint: { tooltip?: string }) => {
      hint.tooltip = "The type.";
      return hint;
    },
  });
  let asked: { start: { line: number } } | undefined;
  const legend = new v.SemanticTokensLegend(["variable"], []);
  v.languages.registerDocumentRangeSemanticTokensProvider(
    "markdown",
    {
      provideDocumentRangeSemanticTokens: (_d: unknown, r: typeof asked) => {
        asked = r;
        const b = new v.SemanticTokensBuilder(legend);
        b.push(1, 0, 5, 0, 0);
        return b.build();
      },
    },
    legend,
  );
  await tick();
  const regs = h.requests("languages.register").map((r) => r.params as Record<string, unknown>);
  const hints = regs.find((r) => r.feature === "inlayHints");
  assert.equal(hints?.resolve, true);
  const doc = { path: "/ws/a.md", languageId: "markdown" };
  const [hint] = (await h.call("provider", String(hints?.id), {
    ...doc,
    range: { startLine: 1, startColumn: 1, endLine: 2, endColumn: 1 },
  })) as Record<string, unknown>[];
  assert.deepEqual(hint?.label, [
    { value: ": " },
    {
      value: "int",
      location: {
        path: "/elsewhere/typeshed/builtins.pyi",
        startLine: 10,
        startColumn: 1,
        endLine: 10,
        endColumn: 4,
      },
    },
  ]);
  assert.deepEqual(hint?.textEdits, [
    { startLine: 1, startColumn: 8, endLine: 1, endColumn: 8, text: ": int" },
  ]);
  const resolved = (await h.call("provider", `${String(hints?.id)}.resolve`, {
    ...doc,
    resolveId: hint?.resolveId,
  })) as Record<string, unknown>;
  assert.equal(resolved.tooltip, "The type.");
  // A real range provider: registered as one, asked about the range.
  const tokens = regs.find((r) => r.feature === "semanticTokens");
  assert.equal(tokens?.range, true);
  const answer = await h.call("provider", String(tokens?.id), {
    ...doc,
    range: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 6 },
  });
  assert.equal(asked?.start.line, 1);
  assert.deepEqual(answer, [{ line: 2, column: 1, length: 5, type: "variable" }]);
});

test("notebook cells are vscode-notebook-cell documents; selectors score them as VS Code", async () => {
  const h = harness();
  await h.shim.ready();
  const { languages, Hover } = h.vscode;
  const seen: string[] = [];
  const provider = (name: string) => ({
    provideHover: (doc: { uri: { scheme: string }; getText(): string }) => {
      seen.push(`${name}:${doc.uri.scheme}:${doc.getText()}`);
      return new Hover("x");
    },
  });
  languages.registerHoverProvider({ language: "python" }, provider("any"));
  languages.registerHoverProvider({ scheme: "file", language: "python" }, provider("file"));
  // The notebook isn't open in the extension: a notebookType filter has no notebook to match.
  languages.registerHoverProvider({ notebookType: "*", language: "python" }, provider("nb"));
  await tick();
  const ids = h
    .requests("languages.register")
    .filter((r) => (r.params as { hover?: boolean }).hover)
    .map((r) => String((r.params as { id: string }).id));
  const cell = {
    ...markdownAt,
    path: "/ws/nb.ipynb.cell-abc.py",
    languageId: "python",
    cell: { notebook: "/ws/nb.ipynb", id: "abc", text: "x = 1" },
  };
  for (const id of ids) await h.call("hover", id, cell);
  assert.deepEqual(seen, ["any:vscode-notebook-cell:x = 1"]);
  // VS Code's score(): an empty filter matches nothing; "*" scores 5.
  const doc = { languageId: "python", uri: h.vscode.Uri.file("/ws/a.py") };
  assert.equal(languages.match({}, doc), 0);
  assert.equal(languages.match({ language: "*" }, doc), 5);
  assert.equal(languages.match({ pattern: { base: "/ws", pattern: "*.py" } }, doc), 10);
  assert.equal(languages.match({ pattern: { base: "/other", pattern: "*.py" } }, doc), 0);
});

test("diagnostics keep Hint, tags, their source, a code's link and related places", async () => {
  const h = harness();
  await h.shim.ready();
  const v = h.vscode;
  const c = v.languages.createDiagnosticCollection("pyright");
  const d = new v.Diagnostic(new v.Range(0, 0, 0, 5), "unused", v.DiagnosticSeverity.Hint);
  d.source = "Pyright";
  d.tags = [v.DiagnosticTag.Unnecessary];
  d.code = { value: "reportUnusedImport", target: v.Uri.parse("https://example.com/rules") };
  d.relatedInformation = [
    new v.DiagnosticRelatedInformation(
      new v.Location(v.Uri.file("/ws/b.md"), new v.Range(2, 0, 2, 1)),
      "here",
    ),
  ];
  c.set(v.Uri.file("/ws/a.md"), [d]);
  await tick();
  await tick();
  const last = h.requests("languages.setDiagnostics").pop()?.params as { items: unknown[] };
  assert.deepEqual(last.items, [
    {
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: 6,
      message: "unused",
      severity: "hint",
      code: "reportUnusedImport",
      codeTarget: "https://example.com/rules",
      source: "Pyright",
      tags: ["unnecessary"],
      relatedInformation: [
        {
          startLine: 3,
          startColumn: 1,
          endLine: 3,
          endColumn: 2,
          path: "/ws/b.md",
          message: "here",
        },
      ],
    },
  ]);
});

test("getLanguages lists the editor's languages by VS Code's ids; inline values providers answer", async () => {
  const h = harness({ "languages.list": () => ["plaintext", "tsx", "python", "make"] });
  await h.shim.ready();
  const ids = (await h.vscode.languages.getLanguages()) as string[];
  assert.ok(ids.includes("typescriptreact"));
  assert.ok(ids.includes("makefile"));
  assert.ok(!ids.includes("tsx"));
  const v = h.vscode;
  v.languages.registerInlineValuesProvider("markdown", {
    provideInlineValues: (_d: unknown, _r: unknown, ctx: { frameId: number }) => [
      new v.InlineValueText(new v.Range(0, 0, 0, 1), `frame ${ctx.frameId}`),
      new v.InlineValueVariableLookup(new v.Range(1, 0, 1, 5), "hello", false),
    ],
  });
  await tick();
  const reg = h
    .requests("languages.register")
    .find((r) => (r.params as { feature?: string }).feature === "inlineValues");
  const values = await h.call(
    "provider",
    String((reg?.params as { id?: string } | undefined)?.id),
    {
      path: "/ws/a.md",
      languageId: "markdown",
      range: { startLine: 1, startColumn: 1, endLine: 2, endColumn: 12 },
      frameId: 3,
      stoppedLine: 2,
    },
  );
  assert.deepEqual(values, [
    {
      kind: "text",
      range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
      text: "frame 3",
    },
    {
      kind: "variable",
      range: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 6 },
      name: "hello",
      caseSensitive: false,
    },
  ]);
});

test("audit: workspace.fs reaches the extension's own file system providers", async () => {
  const h = harness();
  await h.shim.ready();
  const { workspace, Uri, FileType, FileSystemError } = h.vscode;
  const files = new Map<string, Uint8Array>();
  const provider = {
    stat: (uri: { path: string }) => ({ type: files.has(uri.path) ? FileType.File : 0, size: 1 }),
    readDirectory: () => [...files.keys()].map((k) => [k.slice(1), FileType.File]),
    readFile: (uri: { path: string }) => {
      const data = files.get(uri.path);
      if (!data) throw FileSystemError.FileNotFound(uri as never);
      return data;
    },
    writeFile: (uri: { path: string }, content: Uint8Array) => void files.set(uri.path, content),
    onDidChangeFile: new h.vscode.EventEmitter<never>().event,
  };
  const registration = workspace.registerFileSystemProvider("memfs", provider as never);
  const a = Uri.parse("memfs:/a.txt");
  await workspace.fs.writeFile(a, new TextEncoder().encode("hi"));
  assert.equal(new TextDecoder().decode(await workspace.fs.readFile(a)), "hi");
  assert.equal((await workspace.fs.stat(a)).type, FileType.File);
  // No copy of its own: read and written through it.
  await workspace.fs.copy(a, Uri.parse("memfs:/b.txt"));
  assert.ok(files.has("/b.txt"));
  // No delete of its own: refused, as a read-only file system.
  await assert.rejects(workspace.fs.delete(a));
  assert.equal(workspace.fs.isWritableFileSystem("memfs"), true);
  registration.dispose();
  await assert.rejects(workspace.fs.readFile(a));
  assert.equal(workspace.fs.isWritableFileSystem("memfs"), undefined);
});

test("audit: a Memento keeps a value with a function as JSON; one JSON can't hold rejects", async () => {
  const h = harness();
  await h.shim.ready();
  const state = h.shim.context.globalState;
  await state.update("withMethod", { a: 1, run() {} });
  assert.deepEqual(state.get("withMethod"), { a: 1 });
  const cyclic: Record<string, unknown> = { run() {} };
  cyclic.self = cyclic;
  await assert.rejects(state.update("cyclic", cyclic));
  assert.equal(state.get("cyclic"), undefined);
});

test("vscode.execute…Provider asks the IDE's providers; cursorMove and editorScroll run in the editor", async () => {
  const ran: { action: string; args?: unknown }[] = [];
  const h = harness({
    "languages.execute": (p) =>
      p.kind === "hover"
        ? [
            {
              contents: ["**hi**"],
              range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 3 },
            },
          ]
        : [],
    "commands.execute": (p) => {
      if (p.id !== "editor.runAction") return null;
      const input = p.input as { action: string; args?: unknown };
      ran.push(input);
      // The editor refuses editorScroll from extensions: its line scrolls are used instead.
      return { ran: input.action !== "editorScroll" };
    },
  });
  await h.shim.ready();
  const { commands, Position, Uri, Hover } = h.vscode;
  const uri = Uri.file("/ws/a.md");
  const hovers = (await commands.executeCommand(
    "vscode.executeHoverProvider",
    uri,
    new Position(0, 1),
  )) as InstanceType<typeof Hover>[];
  assert.ok(hovers[0] instanceof Hover);
  const asked = h.requests("languages.execute")[0]?.params as Record<string, unknown>;
  assert.deepEqual(
    { kind: asked.kind, line: asked.line, column: asked.column },
    { kind: "hover", line: 1, column: 2 },
  );
  assert.ok(!h.logs.some((l) => l.includes("executeHoverProvider")));

  assert.equal(
    await commands.executeCommand("cursorMove", { to: "down", by: "line", value: 2 }),
    true,
  );
  assert.deepEqual(ran[0], { action: "cursorMove", args: { to: "down", by: "line", value: 2 } });
  await commands.executeCommand("editorScroll", { to: "up", by: "line", value: 2 });
  assert.deepEqual(
    ran.slice(1).map((r) => r.action),
    ["editorScroll", "scrollLineUp", "scrollLineUp"],
  );
});

test("window.activeColorTheme follows the IDE's theme kind", async () => {
  const h = harness();
  await h.shim.ready();
  const { window, ColorThemeKind } = h.vscode;
  assert.equal(window.activeColorTheme.kind, ColorThemeKind.Dark);
  const seen: number[] = [];
  window.onDidChangeActiveColorTheme((t: { kind: number }) => seen.push(t.kind));
  h.fire("theme.didChange", { kind: "light" });
  await tick();
  assert.equal(window.activeColorTheme.kind, ColorThemeKind.Light);
  // Another change that keeps the kind (density, an accent) isn't a theme change.
  h.fire("theme.didChange", { kind: "light" });
  await tick();
  assert.deepEqual(seen, [ColorThemeKind.Light]);
});

test("audit: vscode.git's state catches a change that comes while it's being read", async () => {
  let staged = [{ path: "/ws/a.md", status: "A" }];
  let changeWhileReading: (() => void) | undefined;
  const h = harness({
    "git.repositories": () => [
      { root: "/ws", name: "ws", kind: "workspace", selected: true, branch: "main" },
    ],
    // Asked after the status was read: the change lands now, and is reported.
    "git.refs": () => {
      changeWhileReading?.();
      changeWhileReading = undefined;
      return {
        branches: [
          {
            name: "main",
            remote: false,
            current: true,
            upstream: null,
            commit: "abc",
            subject: "s",
          },
        ],
        tags: [],
      };
    },
    "state.get": (p) =>
      p.path === "ide://git/status" ? { root: "/ws", staged, changes: [] } : { documents: [] },
  });
  await h.shim.ready();
  changeWhileReading = () => {
    staged = [...staged, { path: "/ws/b.md", status: "A" }];
    h.fire("git.didChange", { root: "/ws" });
  };
  const git = h.vscode.extensions.getExtension("vscode.git") as {
    exports: { getAPI(n: number): { repositories: { state: { indexChanges: unknown[] } }[] } };
  };
  const api = git.exports.getAPI(1);
  for (let i = 0; i < 30; i++) await tick();
  assert.equal(changeWhileReading, undefined);
  assert.equal(api.repositories[0]?.state.indexChanges.length, 2);
});

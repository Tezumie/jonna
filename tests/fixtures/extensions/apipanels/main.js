// Test extension for run-time webview panels (ide.ui.createWebviewPanel), the Testing API
// (ide.tests.createTestController) and provideDebugConfigurations.
const stats = { messages: [], states: [], disposed: 0, runs: [], resolved: [] };
let panel = null;

const page = (heading) => `<!doctype html>
<html><head><link rel="stylesheet" href="media/page.css"></head>
<body><h1 id="title">${heading}</h1><p id="last">none</p>
<script>
  const NS = "ide-webview";
  const post = (message) => parent.postMessage({ ns: NS, message }, "*");
  addEventListener("message", (e) => {
    if (e.data?.ns !== NS || e.data.theme || !("message" in e.data)) return;
    document.getElementById("last").textContent = JSON.stringify(e.data.message);
    post({ echo: e.data.message });
  });
  post({ ready: document.getElementById("title").textContent });
</script></body></html>`;

exports.activate = (ide) => {
  ide.commands.register("apipanels.stats", () => ({
    ...stats,
    open: !!panel,
    visible: panel?.visible ?? null,
    title: panel?.title ?? null,
  }));
  ide.commands.register("apipanels.open", () => {
    if (panel) {
      panel.reveal();
      return { ok: true, again: true };
    }
    panel = ide.ui.createWebviewPanel("apipanels.preview", "Panel one", "main", {
      enableScripts: true,
    });
    panel.webview.html = page("one");
    panel.webview.onDidReceiveMessage((m) => stats.messages.push(m));
    panel.onDidChangeViewState((e) => stats.states.push([e.webviewPanel.visible, e.webviewPanel.active]));
    panel.onDidDispose(() => {
      stats.disposed++;
      panel = null;
    });
    return { ok: true };
  });
  ide.commands.register("apipanels.post", async (input) => {
    if (!panel) return { ok: false };
    return { ok: await panel.webview.postMessage(input?.message ?? "ping") };
  });
  ide.commands.register("apipanels.retitle", () => {
    if (!panel) return { ok: false };
    panel.title = "Panel two";
    panel.webview.html = page("two");
    return { ok: true };
  });
  ide.commands.register("apipanels.close", () => {
    panel?.dispose();
    return { ok: true };
  });

  // A test controller: one file with two tests (one fails), a second file found on demand.
  const ctrl = ide.tests.createTestController("panelsTests", "Panels tests");
  const file = ctrl.createTestItem("math.spec", "math.spec", "math.spec");
  const adds = ctrl.createTestItem("adds", "adds numbers", "math.spec");
  adds.range = { startLine: 2 };
  const breaks = ctrl.createTestItem("breaks", "breaks on purpose", "math.spec");
  breaks.range = { startLine: 5 };
  file.children.replace([adds, breaks]);
  const lazy = ctrl.createTestItem("lazy.spec", "lazy.spec", "lazy.spec");
  lazy.canResolveChildren = true;
  ctrl.items.replace([file, lazy]);
  ctrl.resolveHandler = (item) => {
    stats.resolved.push(item ? item.id : null);
    if (item === lazy && lazy.children.size === 0)
      lazy.children.add(ctrl.createTestItem("found", "found later", "lazy.spec"));
  };
  const leaves = (items) => {
    const out = [];
    const walk = (it) => {
      if (it.children.size === 0) out.push(it);
      else it.children.forEach(walk);
    };
    for (const it of items) walk(it);
    return out;
  };
  const runHandler = (kind) => async (request, token) => {
    const run = ctrl.createTestRun(request, `${kind} run`);
    const roots = request.include ?? [...ctrl.items].map(([, it]) => it);
    const tests = leaves(roots);
    stats.runs.push({ kind, tests: tests.map((t) => t.id) });
    for (const t of tests) run.enqueued(t);
    for (const t of tests) {
      if (token.isCancellationRequested) break;
      run.started(t);
      run.appendOutput(`running ${t.id}\r\n`, undefined, t);
      if (t === breaks)
        run.failed(t, { message: "expected 3 to be 4", expectedOutput: "4", actualOutput: "3" }, 2);
      else run.passed(t, 1);
    }
    run.end();
  };
  ctrl.createRunProfile("Run", 1, runHandler("run"), true);
  ctrl.createRunProfile("Debug", 2, runHandler("debug"), true);

  // Add configuration… offers this provider's configurations.
  ide.debug.registerDebugConfigurationProvider("panels-dbg", {
    provideDebugConfigurations: () => [
      { name: "Panels: launch", request: "launch", program: "${workspaceFolder}/app.panels" },
    ],
  });
};

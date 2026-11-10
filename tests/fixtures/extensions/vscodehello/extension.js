// D256, D257: an extension written for VS Code (its API through `require("vscode")`), run by the
// IDE's Node host behind the shim. Its commands report what it sees, for the UI test.
const vscode = require("vscode");

const opened = [];
/** What its pages (the webview view, the custom editor) sent back. */
const pages = [];

const page = (what) => `<!doctype html><html><head><meta charset="utf-8"></head><body>
<p>${what}</p>
<script>
  const api = acquireVsCodeApi();
  window.addEventListener("message", (e) => api.postMessage({ echo: e.data, from: "${what}" }));
  api.postMessage({ ready: "${what}" });
</script></body></html>`;

exports.activate = async (context) => {
  console.log("vscode hello activated");
  // A status item set once at activation, with a codicon, as Live Server's and Claude Code's
  // (D284, D285: it must survive the folder's trust flipping, and its icon map to the IDE's).
  const live = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  live.text = "$(broadcast) Hello live";
  live.show();
  context.subscriptions.push(live);
  const diagnostics = vscode.languages.createDiagnosticCollection("hello");
  context.subscriptions.push(diagnostics);
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => opened.push(vscode.workspace.asRelativePath(doc.uri))),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("vscode-hello.info", async () => {
      await context.globalState.update("runs", (context.globalState.get("runs") ?? 0) + 1);
      const folder = vscode.workspace.workspaceFolders?.[0];
      const readme = vscode.Uri.joinPath(folder.uri, "README.md");
      const doc = await vscode.workspace.openTextDocument(readme);
      // Its own file, through workspace.fs (outside the folder).
      const own = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, "package.json"));
      diagnostics.set(readme, [
        new vscode.Diagnostic(new vscode.Range(0, 2, 0, 8), "Hello from VS Code's API", vscode.DiagnosticSeverity.Warning),
      ]);
      return {
        greeting: vscode.workspace.getConfiguration("vscodeHello").get("greeting"),
        version: vscode.version,
        runs: context.globalState.get("runs"),
        firstLine: doc.lineAt(0).text,
        word: doc.getText(doc.getWordRangeAtPosition(new vscode.Position(0, 4))),
        ownName: JSON.parse(Buffer.from(own).toString("utf8")).name,
        id: context.extension.id,
        contains: new vscode.Range(1, 2, 3, 4).contains(new vscode.Position(2, 0)),
        trusted: vscode.workspace.isTrusted,
      };
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("vscodeHello.check", () => ({
      problems: vscode.languages.getDiagnostics().length,
      opened,
      active: vscode.window.activeTextEditor
        ? vscode.workspace.asRelativePath(vscode.window.activeTextEditor.document.uri)
        : null,
    })),
  );

  // A webview view: its page is written here, and talks with acquireVsCodeApi (D257).
  let view;
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("vscodeHello.page", {
      resolveWebviewView(webviewView) {
        view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = page("view");
        webviewView.webview.onDidReceiveMessage((m) => {
          pages.push(m);
          if (m.ready) webviewView.webview.postMessage("ping view");
        });
      },
    }),
  );
  // Not resolved until it's first shown (VS Code's): its `.focus` command shows it then.
  context.subscriptions.push(
    vscode.commands.registerCommand("vscodeHello.showPage", () =>
      view ? view.show() : vscode.commands.executeCommand("vscodeHello.page.focus"),
    ),
  );

  // A custom text editor for *.hello files.
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider("vscodeHello.editor", {
      resolveCustomTextEditor(document, panel) {
        panel.webview.options = { enableScripts: true };
        panel.webview.html = page(`editor:${document.getText().trim()}`);
        panel.webview.onDidReceiveMessage((m) => {
          pages.push(m);
          if (m.ready) panel.webview.postMessage("ping editor");
        });
      },
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("vscodeHello.openHello", async () => {
      const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, "greeting.hello");
      await vscode.workspace.fs.writeFile(uri, Buffer.from("hi there\n"));
      await vscode.commands.executeCommand("vscode.open", uri);
      return uri.fsPath;
    }),
  );
  context.subscriptions.push(vscode.commands.registerCommand("vscodeHello.pages", () => pages));

  // A task provider, a test controller and a source control.
  context.subscriptions.push(
    vscode.tasks.registerTaskProvider("hello", {
      provideTasks: () => [
        new vscode.Task({ type: "hello", word: "hi" }, vscode.TaskScope.Workspace, "say hi", "hello", new vscode.ShellExecution("echo hi")),
      ],
      resolveTask: () => undefined,
    }),
  );
  const tests = vscode.tests.createTestController("helloTests", "Hello tests");
  context.subscriptions.push(tests);
  const suite = tests.createTestItem("suite", "Greeting suite");
  const good = tests.createTestItem("good", "says hello");
  const bad = tests.createTestItem("bad", "says goodbye");
  suite.children.replace([good, bad]);
  tests.items.add(suite);
  tests.createRunProfile("Run", vscode.TestRunProfileKind.Run, (request) => {
    const run = tests.createTestRun(request);
    run.passed(good, 5);
    run.failed(bad, new vscode.TestMessage("expected hello"), 3);
    run.end();
  });
  // A source control for the folder (none in an empty window, D268).
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (root) {
    const scm = vscode.scm.createSourceControl("hello", "Hello changes", root);
    context.subscriptions.push(scm);
    const group = scm.createResourceGroup("changes", "Changes");
    group.resourceStates = [{ resourceUri: vscode.Uri.joinPath(root, "notes.txt") }];
    scm.count = 1;
  }

  // D258: a tree with its own icons, revealed through getParent; badges on files; a tool for
  // the agent; Enter rules for Markdown.
  const parents = { "a/1": "a" };
  const treeView = vscode.window.createTreeView("vscodeHello.tree", {
    treeDataProvider: {
      getChildren: (el) => (el ? (el === "a" ? ["a/1"] : []) : ["a", "b"]),
      getTreeItem: (el) => {
        const item = new vscode.TreeItem(
          el,
          el === "a" ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "dot.svg");
        return item;
      },
      getParent: (el) => parents[el],
    },
  });
  context.subscriptions.push(treeView);
  context.subscriptions.push(
    vscode.commands.registerCommand("vscodeHello.reveal", () => treeView.reveal("a/1", { select: true })),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("vscodeHello.selection", () => treeView.selection),
  );
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider({
      provideFileDecoration: (uri) =>
        uri.path.endsWith("/README.md")
          ? new vscode.FileDecoration("H", "Hello's badge", new vscode.ThemeColor("charts.green"))
          : undefined,
    }),
  );
  context.subscriptions.push(
    vscode.lm.registerTool("hello_echo", {
      invoke: (options) =>
        new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`echo ${options.input.text}`)]),
    }),
  );
  context.subscriptions.push(
    vscode.languages.setLanguageConfiguration("markdown", {
      onEnterRules: [{ beforeText: /^\s*> /, action: { indentAction: vscode.IndentAction.None, appendText: "> " } }],
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("vscodeHello.git", async () => {
      const api = vscode.extensions.getExtension("vscode.git").exports.getAPI(1);
      await new Promise((r) => setTimeout(r, 1500));
      return { state: api.state, repositories: api.repositories.length };
    }),
  );

  // vscode.execute…Provider: every provider of a document, asked through the editor (its own
  // here); the theme's kind; cursorMove in the active editor.
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider("plaintext", {
      provideDocumentSymbols: () => {
        const range = new vscode.Range(0, 0, 0, 5);
        return [new vscode.DocumentSymbol("hello-symbol", "", vscode.SymbolKind.String, range, range)];
      },
    }),
    vscode.languages.registerHoverProvider("plaintext", {
      provideHover: () => new vscode.Hover("hello-hover"),
    }),
    vscode.commands.registerCommand("vscodeHello.providers", async () => {
      const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, "notes.txt");
      const symbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri);
      const hovers = await vscode.commands.executeCommand(
        "vscode.executeHoverProvider",
        uri,
        new vscode.Position(0, 1),
      );
      return {
        symbols: symbols.map((s) => s.name),
        hovers: hovers.flatMap((h) => h.contents.map((c) => (typeof c === "string" ? c : c.value))),
        theme: vscode.window.activeColorTheme.kind,
        moved: await vscode.commands.executeCommand("cursorMove", { to: "down", by: "line" }),
      };
    }),
  );

  // D388: a terminal with hideFromUser, as the Python extension's probes: no tab until show().
  let hiddenTerminal;
  context.subscriptions.push(
    vscode.commands.registerCommand("vscodeHello.hiddenTerminal", async () => {
      hiddenTerminal = vscode.window.createTerminal({ hideFromUser: true });
      hiddenTerminal.sendText("echo hidden-probe");
      await new Promise((r) => setTimeout(r, 1500));
      return { pid: (await hiddenTerminal.processId) ?? null };
    }),
    vscode.commands.registerCommand("vscodeHello.showHiddenTerminal", () => {
      hiddenTerminal?.show();
      return { shown: !!hiddenTerminal };
    }),
  );
  // D265: another extension's API, from its own process.
  context.subscriptions.push(
    vscode.commands.registerCommand("vscodeHello.otherApi", async () => {
      const ext = vscode.extensions.getExtension("acme.vscode-api");
      if (!ext) return { found: false };
      const wasActive = ext.isActive;
      const api = await ext.activate();
      const events = [];
      const sub = await api.onDidCount((n) => events.push(n));
      await api.count();
      await api.count();
      await new Promise((r) => setTimeout(r, 300));
      await sub.dispose();
      await api.count();
      await new Promise((r) => setTimeout(r, 300));
      const counter = await api.makeCounter(10);
      return {
        found: true,
        id: ext.id,
        displayName: ext.packageJSON.displayName,
        listed: vscode.extensions.all.some((e) => e.id === "acme.vscode-api"),
        wasActive,
        isActive: ext.isActive,
        same: ext.exports === api,
        version: api.version,
        home: api.home instanceof vscode.Uri ? api.home.fsPath : "not a Uri",
        sum: await api.add(2, 3),
        greeting: await api.greet("Hello"),
        counter: [await counter.next(), await counter.next()],
        events,
        missing: vscode.extensions.getExtension("acme.not-installed") === undefined,
      };
    }),
  );

  // D267: a cell that comes with its output.
  const withOutput = (cell) => {
    cell.outputs = [new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.stdout("answer 42\n")])];
    cell.executionSummary = { executionOrder: 7 };
    return cell;
  };
  // D267: an untitled notebook from data, shown.
  context.subscriptions.push(
    vscode.commands.registerCommand("vscodeHello.untitledNotebook", async () => {
      const nb = await vscode.workspace.openNotebookDocument(
        "jupyter-notebook",
        new vscode.NotebookData([withOutput(new vscode.NotebookCellData(vscode.NotebookCellKind.Code, "x = 1", "python"))]),
      );
      const editor = await vscode.window.showNotebookDocument(nb);
      return {
        untitled: nb.isUntitled,
        uri: nb.uri.toString(),
        type: nb.notebookType,
        cells: nb.cellCount,
        text: nb.cellAt(0).document.getText(),
        output: new TextDecoder().decode(nb.cellAt(0).outputs[0]?.items[0]?.data ?? new Uint8Array()),
        order: nb.cellAt(0).executionSummary?.executionOrder,
        active: vscode.window.activeNotebookEditor === editor,
      };
    }),
  );

  // D265: the active notebook editor, its cells, and NotebookEdits.
  context.subscriptions.push(
    vscode.commands.registerCommand("vscodeHello.notebook", async () => {
      const editor = vscode.window.activeNotebookEditor;
      if (!editor) return { active: false };
      const nb = editor.notebook;
      const before = nb.cellCount;
      const changed = new Promise((resolve) => {
        const d = vscode.workspace.onDidChangeNotebookDocument((e) => {
          if (!e.contentChanges.length) return;
          d.dispose();
          resolve(e.contentChanges[0].addedCells.length);
        });
      });
      const edit = new vscode.WorkspaceEdit();
      edit.set(nb.uri, [
        vscode.NotebookEdit.insertCells(0, [
          new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, "# From VS Code's API", "markdown"),
          withOutput(new vscode.NotebookCellData(vscode.NotebookCellKind.Code, "print(42)", "python")),
        ]),
        // VS Code's ipynb layout: the file's own metadata is under `metadata` (D297).
        vscode.NotebookEdit.updateNotebookMetadata({
          ...nb.metadata,
          metadata: { ...(nb.metadata.metadata ?? {}), hello: "yes" },
        }),
      ]);
      const applied = await vscode.workspace.applyEdit(edit);
      const added = await Promise.race([changed, new Promise((r) => setTimeout(() => r(-1), 3000))]);
      return {
        active: true,
        path: nb.uri.fsPath,
        type: nb.notebookType,
        before,
        after: nb.cellCount,
        applied,
        added,
        first: nb.cellAt(0).document.getText(),
        firstKind: nb.cellAt(0).kind,
        hello: nb.metadata.metadata?.hello,
        listed: vscode.workspace.notebookDocuments.includes(nb),
      };
    }),
  );

  // D264: new terminals' environment, links in terminal lines, a terminal profile.
  context.environmentVariableCollection.replace("HELLO_ENV", "from-hello");
  context.environmentVariableCollection.append("HELLO_PATH", "-tail");
  let linked = "";
  context.subscriptions.push(
    vscode.window.registerTerminalLinkProvider({
      provideTerminalLinks: (ctx) => {
        const at = ctx.line.indexOf("HELLO-42");
        return at < 0 ? [] : [{ startIndex: at, length: 8, tooltip: "Open ticket", ticket: 42 }];
      },
      handleTerminalLink: (link) => {
        linked = `ticket ${link.ticket}`;
      },
    }),
    vscode.window.registerTerminalProfileProvider("vscodeHello.shell", {
      provideTerminalProfile: () => ({ options: { name: "Hello shell" } }),
    }),
    vscode.commands.registerCommand("vscodeHello.linked", () => linked),
  );
};

exports.deactivate = () => console.log("vscode hello deactivated");

// D234 test extension: decoration types, folding / link / color / highlight / type definition /
// inline completion / workspace symbol providers for ".extras" files, the active editor's events,
// a file system watcher, findFiles, workspaceState, settings.update and env.
const stats = {
  setup: false,
  active: [],
  selections: 0,
  visible: 0,
  watched: [],
  asked: {},
  accepted: 0,
};
const ask = (what) => {
  stats.asked[what] = (stats.asked[what] ?? 0) + 1;
};

exports.activate = (ide) => {
  ide.commands.register("apiextras.stats", () => stats);
  ide.commands.register("apiextras.accepted", () => {
    stats.accepted++;
    return { ok: true };
  });

  ide.commands.register("apiextras.setup", async () => {
    if (stats.setup) return { ok: true };
    stats.setup = true;
    const L = ide.languages;
    const lang = "extrasfile";
    L.registerFoldingRangeProvider(lang, () => {
      ask("folding");
      return [{ startLine: 1, endLine: 3, kind: "region" }];
    });
    L.registerDocumentLinkProvider(lang, () => {
      ask("links");
      return [
        { startLine: 4, startColumn: 6, endColumn: 30, target: "https://example.com/docs" },
        { startLine: 5, startColumn: 6, endColumn: 14, target: "notes.md", line: 1 },
      ];
    });
    L.registerColorProvider(lang, () => {
      ask("colors");
      return [{ startLine: 6, startColumn: 7, endColumn: 14, color: { red: 1, green: 0, blue: 0, alpha: 1 } }];
    });
    L.registerDocumentHighlightProvider(lang, (ctx) => {
      ask("highlights");
      return ctx.word ? [{ startLine: 1, startColumn: 1, endColumn: 1 + ctx.word.length, kind: "write" }] : [];
    });
    L.registerTypeDefinitionProvider(lang, (ctx) => {
      ask("typeDefinition");
      return { path: ctx.path, startLine: 2 };
    });
    L.registerInlineCompletionProvider(lang, (ctx) => {
      ask("inline");
      return ctx.linePrefix.endsWith("gree")
        ? [{ insertText: "ting = hello", command: "apiextras.accepted" }]
        : [];
    });
    L.registerWorkspaceSymbolProvider(({ query }) => {
      ask("workspaceSymbols");
      return [{ name: `extrasSymbol${query}`, kind: "function", path: "sample.extras", startLine: 2 }];
    });

    // The active editor's events.
    ide.editor.onDidChangeActive((e) => stats.active.push(e ? e.path.split(/[\\/]/).pop() : null));
    ide.editor.onDidChangeSelection(() => stats.selections++);
    ide.editor.onDidChangeVisibleRange(() => stats.visible++);

    // A watcher on Markdown files.
    const watcher = ide.workspace.createFileSystemWatcher("**/*.md");
    watcher.onDidCreate((p) => stats.watched.push(`created ${p.split(/[\\/]/).pop()}`));
    watcher.onDidChange((p) => stats.watched.push(`changed ${p.split(/[\\/]/).pop()}`));
    watcher.onDidDelete((p) => stats.watched.push(`deleted ${p.split(/[\\/]/).pop()}`));
    return { ok: true };
  });

  // A decoration type (Error Lens / Better Comments style) on lines with TODO.
  let todo = null;
  ide.commands.register("apiextras.decorate", async () => {
    todo ??= ide.editor.createDecorationType({
      color: "warning",
      fontStyle: "italic",
      isWholeLine: true,
      after: { contentText: "← to do", color: "subtle", margin: "2em" },
      overviewRulerColor: "warning",
      gutterColor: "label3",
      dark: { backgroundColor: "#ffcc0011" },
    });
    const text = await ide.editor.text("sample.extras");
    const ranges = text
      .split("\n")
      .flatMap((line, i) => (line.includes("TODO") ? [{ startLine: i + 1, hover: "**Do it**" }] : []));
    await todo.set("sample.extras", ranges);
    return { decorated: ranges.length };
  });

  ide.commands.register("apiextras.findFiles", async () => {
    const found = await ide.workspace.findFiles("**/*.md", "**/node_modules/**", 50);
    return { names: found.map((p) => p.split(/[\\/]/).pop()).sort() };
  });

  ide.commands.register("apiextras.state", async () => {
    const before = (await ide.workspaceState.get("runs")) ?? 0;
    await ide.workspaceState.set("runs", before + 1);
    await ide.settings.update("apiextras.level", before + 5, "workspace");
    return {
      runs: await ide.workspaceState.get("runs"),
      level: await ide.settings.get("apiextras.level"),
      appName: ide.env.appName,
      language: ide.env.language,
    };
  });
};

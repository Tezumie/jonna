// Test extension (tests/scripts/extensions-api.jsonc, D176). Runs in the sandboxed worker.
let lastFile = null;

exports.activate = (ide) => {
  const status = ide.ui.createStatusBarItem({ id: "state", text: "$(box) Studio", command: "studio.mark" });

  ide.commands.register("studio.mark", async (input) => {
    const editor = await ide.editor.active();
    const path = input?.path ?? editor?.path;
    await ide.editor.decorate("marks", {
      path,
      style: "warning",
      ranges: [{ startLine: 1, hover: "Marked by **Studio**" }],
      after: "studio",
    });
    await ide.languages.setDiagnostics(path, [{ line: 1, message: "Studio says hi", severity: "info" }]);
    await status.update({ text: "$(circle-check) Marked" });
    return { path };
  });
  ide.commands.register("studio.edit", async () => {
    await ide.editor.replace({ startLine: 1 }, "changed by studio\n");
    return { text: await ide.editor.text() };
  });
  ide.commands.register("studio.providers", () => {
    ide.languages.registerHoverProvider("*", (ctx) => (ctx.word ? `Studio: ${ctx.word}` : null));
    ide.languages.registerCompletionProvider("plaintext", () => [{ label: "studio", kind: "keyword" }]);
    return { ok: true };
  });
  // Language providers beyond hover and completion, on .txt files (tests/scripts/extensions-m7-8.jsonc).
  let lensClicks = 0;
  ide.commands.register("studio.lensClicked", () => ({ clicks: ++lensClicks }));
  // How often the second calls ran: rename's prepare, code action resolve, token requests.
  const stats = { prepared: 0, resolved: 0, tokenRequests: 0 };
  let tokens = null;
  ide.commands.register("studio.providerStats", () => ({ ...stats }));
  // Counts from zero, then refreshes: only the refresh can ask for the tokens again.
  ide.commands.register("studio.refreshTokens", () => {
    stats.tokenRequests = 0;
    tokens?.refresh();
    return { ok: !!tokens };
  });
  ide.commands.register("studio.languageProviders", () => {
    const L = ide.languages;
    const wordsIn = (text, word) => {
      const found = [];
      text.split("\n").forEach((line, i) => {
        for (const m of line.matchAll(new RegExp(`\\b${word}\\b`, "g")))
          found.push({ startLine: i + 1, startColumn: m.index + 1, endColumn: m.index + 1 + word.length });
      });
      return found;
    };
    L.registerDefinitionProvider("plaintext", (ctx) =>
      ctx.word === "studio" ? { path: "notes.txt", startLine: 1 } : null,
    );
    L.registerReferenceProvider("plaintext", async (ctx) =>
      ctx.word ? wordsIn(await ide.editor.text(ctx.path), ctx.word).map((r) => ({ ...r, path: ctx.path })) : [],
    );
    // Trailing spaces go.
    const trim = async (ctx, from = 1, to = Infinity) =>
      (await ide.editor.text(ctx.path)).split("\n").flatMap((line, i) => {
        const n = i + 1;
        const kept = line.replace(/[ \t]+$/, "");
        return n >= from && n <= to && kept !== line
          ? [{ startLine: n, startColumn: kept.length + 1, endColumn: line.length + 1, text: "" }]
          : [];
      });
    L.registerDocumentFormattingProvider("plaintext", (ctx) => trim(ctx));
    L.registerRangeFormattingProvider("plaintext", (ctx) => trim(ctx, ctx.range.startLine, ctx.range.endLine));
    // Offered without edits; resolve (when chosen) fills them in.
    L.registerCodeActionProvider(
      "plaintext",
      async (ctx) => {
        const line = (await ide.editor.text(ctx.path)).split("\n")[ctx.range.startLine - 1] ?? "";
        const at = line.indexOf("todo");
        if (at < 0) return [];
        return [{ title: "Studio: make it TODO", kind: "quickfix", isPreferred: true, line: ctx.range.startLine, at }];
      },
      {
        resolve: (action) => {
          stats.resolved++;
          action.edits = [{ startLine: action.line, startColumn: action.at + 1, endColumn: action.at + 5, text: "TODO" }];
          return action;
        },
      },
    );
    L.registerRenameProvider(
      "plaintext",
      async (ctx) => {
        if (!ctx.word) throw new Error("Studio renames words only.");
        return wordsIn(await ide.editor.text(ctx.path), ctx.word).map((r) => ({ ...r, text: ctx.newName }));
      },
      {
        // Refuses before the rename box opens; else the word, with its text as the placeholder.
        prepare: (ctx) => {
          stats.prepared++;
          if (!ctx.word) throw new Error("Studio renames words only.");
          const start = ctx.linePrefix.length + 1 - (ctx.linePrefix.match(/\w*$/)?.[0].length ?? 0);
          return { startLine: ctx.line, startColumn: start, endColumn: start + ctx.word.length, placeholder: ctx.word };
        },
      },
    );
    L.registerSignatureHelpProvider(
      "plaintext",
      () => ({
        signatures: [{ label: "studio(name, count)", parameters: ["name", "count"], documentation: "Studio call" }],
      }),
      { triggerCharacters: ["("], retriggerCharacters: [","] },
    );
    // "# Title" lines are the outline.
    L.registerDocumentSymbolProvider("plaintext", async (ctx) =>
      (await ide.editor.text(ctx.path)).split("\n").flatMap((line, i) =>
        line.startsWith("# ") ? [{ name: line.slice(2), kind: "namespace", startLine: i + 1 }] : [],
      ),
    );
    L.registerCodeLensProvider("plaintext", () => [
      { startLine: 1, title: "Studio lens", command: "studio.lensClicked" },
    ]);
    L.registerInlayHintsProvider("plaintext", (ctx) => [
      { line: ctx.range.startLine, column: 1, label: "studio:", kind: "parameter", paddingRight: true },
    ]);
    tokens = L.registerSemanticTokensProvider(
      "plaintext",
      async (ctx) => {
        stats.tokenRequests++;
        return wordsIn(await ide.editor.text(ctx.path), "studio").map((r) => ({
          line: r.startLine,
          column: r.startColumn,
          length: 6,
          type: "keyword",
        }));
      },
      { tokenTypes: ["keyword"] },
    );
    return { ok: true };
  });
  // Progress (withProgress): runs until cancelled or 20 s; the command returns right away.
  let progressResult = null;
  ide.commands.register("studio.progress", () => {
    progressResult = "running";
    void ide.ui.withProgress({ title: "Studio work", cancellable: true }, (progress, token) =>
      new Promise((resolve) => {
        progress.report({ message: "first half", increment: 50 });
        const timer = setTimeout(() => resolve("finished"), 20000);
        token.onCancellationRequested(() => {
          clearTimeout(timer);
          resolve("cancelled");
        });
      }).then((r) => {
        progressResult = r;
      }),
    );
    return { started: true };
  });
  ide.commands.register("studio.progressResult", () => ({ result: progressResult }));
  ide.commands.register("studio.lastFile", () => ({ file: lastFile }));
  ide.commands.register("studio.pageToWindow", async () => {
    await ide.ui.webview("studio.page").openInWindow({ width: 640, height: 480 });
    return { ok: true };
  });
  ide.ui.webview("studio.viewer").onMessage((m) => {
    if (m && typeof m === "object" && "got" in m) lastFile = m.got;
  });
};

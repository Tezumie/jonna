// Test extension for tests/scripts/extensions-hooks.jsonc: the `type` override (typed letters come
// back upper case through default:type), a URI handler, applyEdit across files, will-save edits,
// a comment thread, a chat participant and a tree with checkboxes and drops.
const stats = { typed: [], uris: [], replies: [], willSave: 0, checks: [], drops: [] };
let typing = null;

exports.activate = (ide) => {
  ide.commands.register("hooks.stats", () => stats);

  ide.commands.register("hooks.setup", async () => {
    if (typing) return { ok: true, scheme: ide.env.uriScheme };
    typing = ide.commands.register("type", ({ text }) => {
      stats.typed.push(text);
      return ide.commands.execute("default:type", { text: text.toUpperCase() });
    });
    await ide.editor.setOptions({ cursorStyle: "block" });
    ide.ui.registerUriHandler({ handleUri: (uri) => stats.uris.push(`${uri.path}?${uri.query}`) });
    ide.workspace.onWillSaveTextDocument((e) => {
      stats.willSave++;
      if (e.path.endsWith("will-save.txt"))
        e.waitUntil(Promise.resolve([{ startLine: 1, startColumn: 1, endColumn: 1, text: "// saved\n" }]));
    });
    const notes = ide.comments.createCommentController("notes", "Notes");
    notes.replyHandler = ({ thread, text }) => {
      stats.replies.push(text);
      thread.comments = [...thread.comments, { body: text, author: { name: "You" } }];
    };
    const thread = notes.createCommentThread("hooks-out/a.txt", { startLine: 1 }, [
      { body: "Is this right?", author: { name: "Ann" } },
    ]);
    thread.collapsibleState = "expanded";
    ide.chat.createChatParticipant(
      "hooks.helper",
      (request, _context, stream) => stream.markdown(`You asked: ${request.prompt}`),
      { name: "helper" },
    );
    const items = [
      { id: "a", label: "Alpha", checkboxState: "unchecked" },
      { id: "b", label: "Beta", checkboxState: "checked" },
    ];
    const view = ide.ui.registerTreeView("hooks.list", {
      getChildren: (parent) => (parent ? [] : items),
      handleDrop: (target, sources) => stats.drops.push([target?.id ?? null, sources.map((s) => s.id)]),
    });
    view.onDidChangeCheckboxState((changes) =>
      stats.checks.push(...changes.map((c) => `${c.item.id}:${c.checked}`)),
    );
    return { ok: true, scheme: ide.env.uriScheme };
  });

  ide.commands.register("hooks.applyEdit", async () => {
    const edit = ide.workspace.createWorkspaceEdit();
    edit.createFile("hooks-out/a.txt", { contents: "one\ntwo\n", ignoreIfExists: true });
    edit.createFile("hooks-out/will-save.txt", { contents: "body\n", ignoreIfExists: true });
    edit.replace("hooks-out/a.txt", { startLine: 2, startColumn: 1, endColumn: 4 }, "TWO");
    edit.insert("hooks-out/a.txt", { line: 1, column: 1 }, "zero\n");
    return { applied: await ide.workspace.applyEdit(edit) };
  });

  ide.commands.register("hooks.stopTyping", () => {
    typing?.dispose();
    typing = null;
    return { ok: true };
  });
};

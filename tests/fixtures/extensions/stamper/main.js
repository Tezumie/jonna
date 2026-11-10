exports.activate = (ide) => {
  ide.commands.register("stamper.insert", async () => {
    const editor = await ide.editor.active();
    if (!editor) {
      await ide.ui.notify("Open a file first.", { kind: "warning" });
      return { inserted: false };
    }
    await ide.editor.insert("2026-10-18 12:00:00");
    return { inserted: true, path: editor.path, line: editor.cursor.line };
  });
  ide.ui.registerTreeView("stamper.items", {
    getChildren: (parent) =>
      parent ? [] : [{ id: "insert", label: "Insert timestamp", icon: "clock", command: { id: "stamper.insert" } }],
  });
};

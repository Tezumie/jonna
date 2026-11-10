// Test extension (tests/scripts/extensions.jsonc). Runs in the sandboxed worker: only `ide`.
let lastPong = null;

exports.activate = (ide) => {
  ide.commands.register("hello.greet", async (input) => {
    const greeting = await ide.settings.get("hello.greeting");
    return { text: `${greeting} ${input?.name ?? "there"}`, hasFetch: typeof fetch !== "undefined" };
  });
  ide.commands.register("hello.readNotes", async () => ({
    text: await ide.workspace.fs.read("notes.txt"),
  }));
  ide.commands.register("hello.writeNotes", async () => {
    await ide.workspace.fs.write("notes.txt", "overwritten");
    return { ok: true };
  });
  ide.commands.register("hello.fetch", async () => {
    const r = await ide.net.fetch("https://example.com/");
    return { status: r.status };
  });
  ide.commands.register("hello.openTerminal", () => ide.commands.execute("terminal.create", {}));
  ide.commands.register("hello.remember", async (input) => {
    await ide.storage.set("value", input?.value);
    return { value: await ide.storage.get("value") };
  });
  ide.commands.register("hello.ping", async () => {
    await ide.ui.webview("hello.panel").postMessage({ ping: 42 });
    return { sent: true };
  });
  ide.commands.register("hello.lastPong", () => ({ pong: lastPong }));
  ide.commands.register("hello.stamp", async () => {
    const editor = await ide.editor.active();
    if (!editor) return { inserted: false };
    await ide.editor.insert("STAMP");
    return { inserted: true, path: editor.path };
  });
  ide.commands.register("hello.setting", async () => ({
    greeting: await ide.settings.get("hello.greeting"),
  }));
  ide.ui.webview("hello.panel").onMessage((m) => {
    if (m && typeof m === "object" && "pong" in m) lastPong = m.pong;
  });
  ide.ui.registerTreeView("hello.tree", {
    getChildren(parent) {
      if (!parent)
        return [
          { id: "fruits", label: "Fruits", collapsible: true, icon: "folder" },
          { id: "greet", label: "Greet", command: { id: "hello.greet", input: { name: "tree" } } },
        ];
      if (parent.id === "fruits")
        return [
          { id: "apple", label: "Apple", description: "red" },
          { id: "pear", label: "Pear" },
        ];
      return [];
    },
  });
  console.log("hello activated");
};

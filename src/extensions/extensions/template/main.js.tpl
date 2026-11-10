// __TITLE__ — runs in a sandboxed worker. Everything goes through `ide` (types: ide.d.ts).
// Save this file and the extension reloads. Guide: docs/extensions.md in the IDE's repository,
// summarized in README.md next to this file.

exports.activate = (ide) => {
  let greetings = 0;
  // A status bar item (its command must be one of this extension's own).
  const status = ide.ui.createStatusBarItem({
    id: "greetings",
    text: "$(circle-dot) __TITLE__",
    tooltip: "Say hello",
    command: "__PREFIX__.hello",
  });

  ide.commands.register("__PREFIX__.hello", async () => {
    greetings++;
    await status.update({ text: `$(circle-check) ${greetings}` });
    await ide.ui.notify("Hello from __TITLE__!");
    return { greeted: true };
  });

  // More: ide.editor.decorate / replace, ide.languages.registerHoverProvider /
  // registerCompletionProvider / setDiagnostics (need "fs.read"), webview pages in the editor area
  // or their own window, file viewers, menus, MCP servers and agents — see README.md.

  ide.ui.registerTreeView("__PREFIX__.items", {
    getChildren(parent) {
      if (parent) return [];
      return [
        { id: "hello", label: "Say hello", icon: "circle-dot", command: { id: "__PREFIX__.hello" } },
        { id: "docs", label: "Edit main.js to change me", description: "it reloads on save" },
      ];
    },
  });
};

exports.deactivate = () => {};

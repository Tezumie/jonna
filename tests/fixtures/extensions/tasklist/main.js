// Test extension (tests/scripts/extensions-tree-menus.jsonc): row menus and an output channel.
let last = null;

exports.activate = (ide) => {
  const log = ide.ui.createOutputChannel("Task log");
  const remember = (what) => (input) => {
    last = { what, item: input?.item ?? null };
    log.appendLine(`${what}: ${input?.item?.label ?? "?"}`);
    return last;
  };
  ide.commands.register("tasklist.done", remember("done"));
  ide.commands.register("tasklist.rename", remember("rename"));
  ide.commands.register("tasklist.copyName", remember("copy"));
  ide.commands.register("tasklist.last", () => last);
  ide.commands.register("tasklist.log", () => {
    log.append("partial ");
    log.appendLine("line");
    log.warn("a warning");
    log.show();
    return { channel: log.name };
  });
  ide.ui.registerTreeView("tasklist.tree", {
    getChildren(parent) {
      if (!parent)
        return [
          { id: "today", label: "Today", collapsible: true, contextValue: "group" },
          { id: "t1", label: "Write tests", contextValue: "task" },
        ];
      if (parent.id === "today") return [{ id: "t2", label: "Review", contextValue: "task" }];
      return [];
    },
  });
};

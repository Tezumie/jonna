// A notebook format and a kernel, through ide.notebooks (D202), and the D204 surfaces: a kernel
// picker action, cell status items, an output renderer with messages, toolbar / cell commands and
// notebook events. What it saw is readable at ide://ext/acme.toybook/log.
const SEP = "\n%%\n";
const log = [];
const note = (entry) => {
  log.push(entry);
  if (log.length > 50) log.shift();
};
ide.state.register("ide://ext/acme.toybook/log", () => log);

ide.notebooks.registerSerializer("acme.toybook.book", {
  deserialize(text) {
    if (!text.trim()) return { cells: [{ kind: "code", source: "" }] };
    return {
      cells: text.split(SEP).map((source) =>
        source.startsWith("# ") ? { kind: "markdown", source } : { kind: "code", source },
      ),
    };
  },
  serialize(nb) {
    return nb.cells.map((c) => c.source).join(SEP);
  },
});

function adder(label, host) {
  let count = 0;
  let total = 0;
  host.setInfo({ display: label, language: "plaintext" });
  host.setStatus("idle");
  return {
    async execute(code, run) {
      count++;
      if (run.cell) note({ ran: run.cell.id, index: run.cell.index, language: run.cell.language });
      if (code.trim() === "ask") {
        const answer = await run.input("Number?");
        code = answer;
      }
      const stars = /^stars (\d+)$/.exec(code.trim());
      if (stars) {
        run.emit({
          type: "display",
          data: {
            "application/vnd.toybook.stars+json": { count: Number(stars[1]) },
            "text/plain": `${stars[1]} stars`,
          },
        });
        return { count };
      }
      const nums = code
        .split(/[^0-9.-]+/)
        .filter(Boolean)
        .map(Number);
      if (!nums.length || nums.some(Number.isNaN)) {
        run.emit({ type: "error", ename: "NotANumber", evalue: code, traceback: [] });
        return { status: "error", count };
      }
      const sum = nums.reduce((a, b) => a + b, 0);
      total += sum;
      run.emit({ type: "stream", name: "stdout", text: `adding ${nums.length} numbers\n` });
      run.emit({ type: "result", data: { "text/plain": String(sum) }, count });
      return { count };
    },
    variables: () => [{ name: "total", type: "number", value: String(total), size: "" }],
    complete: (code, cursor) => ({ matches: ["total"], start: cursor, end: cursor }),
    restart() {
      count = 0;
      total = 0;
    },
  };
}

ide.notebooks.registerKernelSource({
  id: "adder",
  label: "Adder",
  notebookTypes: ["acme.toybook.book"],
  find: () => [
    {
      id: "adder",
      label: "Toy adder",
      detail: "JavaScript, in the extension",
      language: "plaintext",
      languages: ["plaintext", "markdown"],
    },
  ],
  actions: [
    {
      id: "server",
      label: "Connect to a toy server…",
      detail: "asks nothing, returns a kernel",
      run: (context) => {
        note({ action: "server", path: context.path });
        return { id: "server", label: "Toy server", detail: "a pretend server", language: "plaintext" };
      },
    },
  ],
  start(option, _context, host) {
    return adder(option.id === "server" ? "Toy server" : "Toy adder", host);
  },
});

ide.notebooks.registerCellStatusBarItemProvider("acme.toybook.book", (context) =>
  context.cell.kind === "code"
    ? [{ text: `${context.cell.source.length} chars`, tooltip: "Characters in the cell" }]
    : [],
);

const stars = ide.notebooks.createRendererMessaging("acme.toybook.stars");
stars.onDidReceiveMessage(({ message, path }) => {
  note({ renderer: message, path: path.replace(/\\/g, "/").split("/").pop() });
  if (message && typeof message.drew === "number")
    void stars.postMessage({ text: `the extension saw ${message.drew} stars` }, { path });
});

ide.commands.register("acme.toybook.count", async (input) => {
  const nb = await ide.commands.execute("notebook.read", { path: input && input.path });
  note({ counted: nb.cells.length });
  return { cells: nb.cells.length };
});
ide.commands.register("acme.toybook.shout", async (input) => {
  note({ shout: input && input.cellId });
  return {};
});

for (const event of ["notebook.didOpen", "notebook.didSave", "notebook.didRunCell"])
  ide.events.on(event, (e) => note({ event, cellId: e.cellId, type: e.notebookType }));

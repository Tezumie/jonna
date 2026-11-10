import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { fromNotebookData, toNotebookData } from "../../../core/extensions/rpcNotebooks";
import { parseIpynb, serializeIpynb } from "../../../core/notebook/ipynb";
import { ansiSegments } from "./ansi";
import { jupyterOff, rememberedOption } from "./jupyter";
import {
  applyOutput,
  type NbOutput,
  type Notebook,
  notebookBackupText,
  notebookFromBackup,
  outputText,
  resolveCarriageReturns,
  toScript,
} from "./model";

// The .ipynb format is built in (D204, core/notebook/ipynb.ts); D203's notebooks kept the minor
// version among the extra fields, which still saves.
const parseNotebook = (text: string): Notebook => parseIpynb(text);
const serializeNotebook = (nb: Notebook): string => serializeIpynb(nb);

const SAMPLE = {
  cells: [
    {
      cell_type: "markdown",
      id: "intro",
      metadata: {},
      source: ["# Title\n", "Some text"],
      attachments: { "a.png": { "image/png": "AAAA" } },
    },
    {
      cell_type: "code",
      execution_count: 3,
      id: "c1",
      metadata: { tags: ["x"] },
      outputs: [
        { name: "stdout", output_type: "stream", text: ["hi\n", "there\n"] },
        {
          data: { "text/plain": ["42"], "application/json": { a: [1, 2] } },
          execution_count: 3,
          metadata: {},
          output_type: "execute_result",
        },
      ],
      source: ["x = 42\n", "x"],
    },
  ],
  metadata: { kernelspec: { name: "python3", language: "python" }, custom: { keep: true } },
  nbformat: 4,
  nbformat_minor: 5,
};

test("notebooks round-trip: unknown fields kept, lines split like Jupyter (D188)", () => {
  const text = `${JSON.stringify(SAMPLE, null, 1)}\n`;
  const nb = parseNotebook(text);
  assert.equal(nb.cells.length, 2);
  assert.equal(nb.cells[0]?.source, "# Title\nSome text");
  assert.equal(nb.cells[1]?.outputs[0]?.text, "hi\nthere\n");
  assert.deepEqual(nb.cells[1]?.outputs[1]?.data?.["application/json"], { a: [1, 2] });
  const back = JSON.parse(serializeNotebook(nb));
  assert.deepEqual(back.cells[0].attachments, SAMPLE.cells[0]?.attachments);
  assert.deepEqual(back.cells[1].source, ["x = 42\n", "x"]);
  assert.deepEqual(back.cells[1].outputs[0].text, ["hi\n", "there\n"]);
  assert.deepEqual(back.metadata.custom, { keep: true });
  assert.equal(back.cells[0].outputs, undefined);
  // Unchanged notebooks save byte for byte like Jupyter's writer.
  assert.equal(serializeNotebook(parseNotebook(serializeNotebook(nb))), serializeNotebook(nb));
});

test("notebooks: ids are fixed when missing or repeated; empty files are new notebooks", () => {
  const nb = parseNotebook(
    JSON.stringify({
      cells: [
        { cell_type: "code", id: "same", source: "", outputs: [] },
        { cell_type: "code", id: "same", source: "", outputs: [] },
        { cell_type: "code", source: "", outputs: [] },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 2,
    }),
  );
  const ids = nb.cells.map((c) => c.id);
  assert.equal(new Set(ids).size, 3);
  assert.equal(JSON.parse(serializeNotebook(nb)).nbformat_minor, 5);
  assert.equal(parseNotebook("").cells.length, 1);
  assert.throws(() => parseNotebook('{"a":1}'), /no cells/);
  // NaN from Python's json (a DataFrame in an output) reads as null.
  const nan = parseNotebook(
    '{"cells":[{"cell_type":"code","source":"","outputs":[{"output_type":"execute_result","data":{"application/json":{"v":NaN,"w":[1,-Infinity]}},"metadata":{}}]}],"metadata":{},"nbformat":4,"nbformat_minor":5}',
  );
  assert.deepEqual(nan.cells[0]?.outputs[0]?.data?.["application/json"], { v: null, w: [1, null] });
  // NaN inside a string (a cell's source) is text, kept as it is.
  const src = parseNotebook(
    '{"cells":[{"cell_type":"code","source":"print([1, NaN], \\"\\\\\\" Infinity]\\")","outputs":[{"output_type":"execute_result","data":{"application/json":[NaN]},"metadata":{}}]}],"metadata":{},"nbformat":4}',
  );
  assert.equal(src.cells[0]?.source, 'print([1, NaN], "\\" Infinity]")');
  assert.deepEqual(src.cells[0]?.outputs[0]?.data?.["application/json"], [null]);
  assert.throws(() => parseNotebook('{"cells":[],"nbformat":3}'), /too old/);
});

test("outputs: streams merge, clear waits, errors and results are stored", () => {
  const out: NbOutput[] = [];
  const state = { clearPending: false };
  applyOutput(out, { type: "stream", name: "stdout", text: "a" }, state);
  applyOutput(out, { type: "stream", name: "stdout", text: "b\n" }, state);
  applyOutput(out, { type: "stream", name: "stderr", text: "warn\n" }, state);
  assert.equal(out.length, 2);
  assert.equal(out[0]?.text, "ab\n");
  applyOutput(out, { type: "clear", wait: true }, state);
  assert.equal(out.length, 2);
  applyOutput(out, { type: "result", data: { "text/plain": "1" }, count: 4 }, state);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.execution_count, 4);
  applyOutput(
    out,
    { type: "error", ename: "E", evalue: "v", traceback: ["\u001b[31mE\u001b[0m: v"] },
    state,
  );
  assert.match(outputText(out), /1\nE: v/);
  applyOutput(out, { type: "clear" }, state);
  assert.equal(out.length, 0);
});

test("text: carriage returns, ANSI colors, script export", () => {
  assert.equal(resolveCarriageReturns("10%\r50%\r100%\ndone"), "100%\ndone");
  assert.equal(resolveCarriageReturns("abc\rX"), "Xbc");
  const segs = ansiSegments("\u001b[1;31mError\u001b[0m: \u001b[38;5;46mok\u001b[39m\u001b[2K");
  assert.equal(segs[0]?.text, "Error");
  assert.equal(segs[0]?.style.bold, true);
  assert.match(String(segs[0]?.style.fg), /ansi-red/);
  assert.equal(segs[1]?.text, ": ");
  assert.match(String(segs[2]?.style.fg), /^#[0-9a-f]{6}$/);
  assert.equal(segs.map((s) => s.text).join(""), "Error: ok");
  const nb = parseNotebook(JSON.stringify(SAMPLE));
  assert.equal(toScript(nb), "# %% [markdown]\n# # Title\n# Some text\n\n# %%\nx = 42\nx\n");
});

test("WidgetStore: comm state, Output widget capture, snapshot and saved state (D189)", async () => {
  const { WidgetStore } = await import("./widgets");
  const w = new WidgetStore();
  const sent: string[] = [];
  w.onMessage((m) => sent.push(m.message.kind));
  w.handle({
    kind: "comm_open",
    content: {
      comm_id: "s1",
      target_name: "jupyter.widget",
      data: { state: { _model_name: "IntSliderModel", value: 3 }, buffer_paths: [] },
    },
    metadata: { version: "2.1.0" },
    buffers: [],
  });
  w.handle({
    kind: "comm_msg",
    content: { comm_id: "s1", data: { method: "echo_update", state: { value: 7 } } },
  });
  w.handle({
    kind: "comm_open",
    content: {
      comm_id: "o1",
      target_name: "jupyter.widget",
      data: { state: { _model_name: "OutputModel", msg_id: "", outputs: [] } },
    },
  });
  assert.equal(w.captureFor("k1"), undefined);
  w.handle({
    kind: "comm_msg",
    content: { comm_id: "o1", data: { method: "update", state: { msg_id: "k1" } } },
  });
  assert.equal(w.captureFor("k1"), "o1");
  w.capture("o1", { type: "stream", name: "stdout", text: "v 7\n" });
  w.capture("o1", { type: "stream", name: "stdout", text: "more\n" });
  const snap = w.snapshot();
  assert.equal(snap.length, 2);
  assert.equal(snap[0]?.content.data?.state?.value, 7);
  const outputs = snap[1]?.content.data?.state?.outputs as { text: string }[];
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0]?.text, "v 7\nmore\n");
  assert.deepEqual(sent, [
    "comm_open",
    "comm_msg",
    "comm_open",
    "comm_msg",
    "comm_msg",
    "comm_msg",
  ]);
  const saved = w.toSaved();
  assert.equal(saved?.state.s1?.model_name, "IntSliderModel");
  const again = new WidgetStore();
  again.restore(saved);
  assert.ok(again.has("s1") && again.isSaved);
  // The kernel talking again replaces what the file had.
  again.handle({ kind: "comm_open", content: { comm_id: "n1", data: { state: {} } } });
  assert.ok(!again.has("s1") && again.has("n1") && !again.isSaved);
  w.reset();
  assert.equal(w.size, 0);
});

test("WidgetStore.restore: a file's malformed buffers are skipped, not thrown", async () => {
  const { WidgetStore } = await import("./widgets");
  const w = new WidgetStore();
  w.restore({
    state: {
      m1: { model_name: "M", state: {}, buffers: [null, { path: ["x"], data: "AA" }] },
    },
  });
  assert.ok(w.has("m1"));
  assert.deepEqual(w.snapshot()[0]?.buffers, ["AA"]);
});

test("needsFrame / preloadOf: outputs that run code go to a frame (D189)", async () => {
  const { needsFrame, preloadOf } = await import("./outputFrame");
  const { WidgetStore } = await import("./widgets");
  const w = new WidgetStore();
  const out = (data: Record<string, unknown>) => ({ output_type: "display_data", data });
  assert.equal(needsFrame(out({ "text/html": "<table></table>" }), w), false);
  assert.equal(needsFrame(out({ "text/html": "<div></div><script>x()</script>" }), w), true);
  assert.equal(
    needsFrame(out({ "text/html": "<script>x()</script>", "image/png": "AA" }), w),
    false,
  );
  assert.equal(needsFrame(out({ "application/vnd.plotly.v1+json": {} }), w), true);
  const view = { "application/vnd.jupyter.widget-view+json": { model_id: "m1" } };
  assert.equal(needsFrame(out(view), w), false);
  w.handle({ kind: "comm_open", content: { comm_id: "m1", data: { state: {} } } });
  assert.equal(needsFrame(out(view), w), true);
  assert.equal(preloadOf(out({ "application/vnd.bokehjs_load.v0+json": "load()" })), "load()");
  assert.equal(preloadOf(out({ "application/javascript": "init()" })), null);
});

test("diffNotebooks: by id, else by text; changed sources, outputs and kinds (D189)", async () => {
  const { diffNotebooks, sourceLines } = await import("./diff");
  const nb = (cells: unknown[]) =>
    parseNotebook(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells }));
  const code = (id: string, source: string, outputs: unknown[] = []) => ({
    id,
    cell_type: "code",
    source,
    metadata: {},
    outputs,
    execution_count: null,
  });
  const a = nb([code("a", "x = 1"), code("b", "print(x)"), code("c", "gone")]);
  const b = nb([
    code("a", "x = 2"),
    code("b", "print(x)", [{ output_type: "stream", name: "stdout", text: "2\n" }]),
    code("d", "new"),
  ]);
  const d = diffNotebooks(a, b);
  assert.deepEqual(
    d.cells.map((c) => c.change),
    ["modified", "modified", "removed", "added"],
  );
  assert.equal(d.cells[0]?.source, true);
  assert.equal(d.cells[1]?.source, false);
  assert.equal(d.cells[1]?.outputs, true);
  assert.deepEqual(d.counts, { same: 0, modified: 2, added: 1, removed: 1 });
  // No shared ids (a file without them): paired by text.
  const t1 = nb([code("p", "one"), code("q", "two"), code("r", "three")]);
  const t2 = nb([code("x", "one"), code("y", "TWO"), code("z", "three")]);
  assert.deepEqual(
    diffNotebooks(t1, t2).cells.map((c) => c.change),
    ["same", "modified", "same"],
  );
  assert.deepEqual(
    sourceLines("a\nb\nc", "a\nB\nc").map((l) => `${l.sign}${l.text}`),
    [" a", "-b", "+B", " c"],
  );
});

test("outputGroups: Bokeh's element and its script share a frame (D189)", async () => {
  const { outputGroups } = await import("./outputFrame");
  const html = { output_type: "display_data", data: { "text/html": "<div id=p></div>" } };
  const exec = {
    output_type: "display_data",
    data: { "application/javascript": "fill()", "application/vnd.bokehjs_exec.v0+json": "" },
  };
  const text = { output_type: "stream", name: "stdout", text: "hi" };
  const g = outputGroups([text, html, exec]);
  assert.deepEqual([...g.companions], [1]);
  assert.deepEqual(g.before.get(2), [html]);
  assert.equal(outputGroups([html]).companions.size, 0);
});

test("kernels remembered by earlier versions become the Jupyter extension's (D203)", () => {
  assert.deepEqual(
    rememberedOption({
      python: { command: "/r/.venv/bin/python", args: [] },
      kernel: "python3",
      label: "Python 3",
      detail: "Jupyter · ./.venv",
      language: "python",
    }),
    {
      source: "bundled.jupyter/jupyter",
      id: "/r/.venv/bin/python python3",
      label: "Python 3",
      detail: "Jupyter · ./.venv",
      language: "python",
      data: { python: { command: "/r/.venv/bin/python", args: [] }, kernel: "python3" },
    },
  );
  assert.equal(
    rememberedOption({ source: "jupyter", id: "py (plain)", label: "Python", detail: "" })?.source,
    "bundled.jupyter/jupyter",
  );
  assert.equal(rememberedOption({ source: "acme/x", id: "k", label: "K" })?.source, "acme/x");
  assert.equal(rememberedOption({ label: "nothing" }), null);
  assert.match(jupyterOff(), /Jupyter extension/);
});

test("ipynb is built in (D204): D203's extension data still saves, extra fields kept", () => {
  const text = `${JSON.stringify(SAMPLE, null, 1)}\n`;
  // A notebook as D203's extension handed it over (the minor version among the extra fields).
  const viaExtension = fromNotebookData(
    JSON.parse(JSON.stringify(toNotebookData(parseNotebook(text)))),
  );
  viaExtension.extra = { ...viaExtension.extra, nbformat_minor: 7 };
  const back = JSON.parse(serializeNotebook(viaExtension));
  assert.equal(back.nbformat_minor, 7);
  assert.equal(back.nbformat, 4);
  assert.deepEqual(back.metadata.custom, { keep: true });
  // A notebook read now keeps its minor version in its own field.
  const nb = parseNotebook(text.replace('"nbformat_minor": 5', '"nbformat_minor": 9'));
  assert.equal(nb.nbformatMinor, 9);
  assert.equal(JSON.parse(serializeNotebook(nb)).nbformat_minor, 9);
  // An unknown top-level field stays.
  const odd = parseNotebook(JSON.stringify({ ...SAMPLE, extra_top: [1] }));
  assert.deepEqual(JSON.parse(serializeNotebook(odd)).extra_top, [1]);
});

// The built-in Jupyter extension's pip command line (D204), run with a stand-in `ide`.
const jupyterExtension = (platform: string) => {
  const module = { exports: {} as Record<string, unknown> };
  const ide = {
    env: { platform },
    extension: { path: "/ext", id: "bundled.jupyter", version: "1" },
    notebooks: { registerKernelSource: () => ({}) },
  };
  runInNewContext(readFileSync("src-tauri/bundled-extensions/jupyter/main.js", "utf8"), {
    ide,
    module,
    setTimeout,
    clearTimeout,
  });
  return module.exports as {
    pipInstallLine(python: { command: string; args: string[] }, shell?: string): string;
  };
};

test("Install ipykernel: pip's command line for each shell (D204)", () => {
  const win = jupyterExtension("windows");
  const exe = { command: "C:\\Program Files\\Python312\\python.exe", args: [] };
  assert.equal(
    win.pipInstallLine(exe, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
    "& 'C:\\Program Files\\Python312\\python.exe' -m pip install -U ipykernel",
  );
  assert.equal(
    win.pipInstallLine(exe, "cmd.exe"),
    '"C:\\Program Files\\Python312\\python.exe" -m pip install -U ipykernel',
  );
  assert.equal(
    win.pipInstallLine({ command: "py", args: ["-3"] }, "pwsh"),
    "py -3 -m pip install -U ipykernel",
  );
  assert.equal(
    win.pipInstallLine({ command: "C:\\r\\.venv\\Scripts\\python.exe", args: [] }, "pwsh.exe"),
    "C:\\r\\.venv\\Scripts\\python.exe -m pip install -U ipykernel",
  );
  const posix = jupyterExtension("linux");
  assert.equal(
    posix.pipInstallLine({ command: "/home/a b/.venv/bin/python", args: [] }, "/bin/zsh"),
    "'/home/a b/.venv/bin/python' -m pip install -U ipykernel",
  );
  assert.equal(
    posix.pipInstallLine({ command: "python3", args: [] }, "bash"),
    "python3 -m pip install -U ipykernel",
  );
  // A POSIX shell would take "a=b/python" as setting a variable; cmd splits words at "=".
  assert.equal(
    posix.pipInstallLine({ command: "/opt/a=b/python", args: [] }, "bash"),
    "'/opt/a=b/python' -m pip install -U ipykernel",
  );
  assert.equal(
    win.pipInstallLine({ command: "C:\\a=b\\python.exe", args: [] }, "cmd.exe"),
    '"C:\\a=b\\python.exe" -m pip install -U ipykernel',
  );
  // PowerShell ends a single-quoted string at a typographic quote too.
  assert.equal(
    win.pipInstallLine({ command: "C:\\Users\\O’Brien\\python.exe", args: [] }, "pwsh"),
    "& 'C:\\Users\\O’’Brien\\python.exe' -m pip install -U ipykernel",
  );
});

test("a notebook's __proto__ keys are kept as keys, never prototypes", () => {
  const text =
    '{"cells":[{"cell_type":"code","source":"x","metadata":{"__proto__":{"a":1}},"execution_count":null,' +
    '"outputs":[{"output_type":"display_data","metadata":{},"data":{"__proto__":{"text/html":"<b>"},"text/plain":"hi"}}]}],' +
    '"metadata":{"__proto__":{"b":2}},"nbformat":4,"nbformat_minor":5}';
  const nb = parseNotebook(text);
  const data = nb.cells[0]?.outputs[0]?.data as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(data), Object.prototype);
  assert.equal(data["text/html"], undefined);
  const back = JSON.parse(serializeNotebook(nb));
  assert.deepEqual(Object.keys(back.metadata), ["__proto__"]);
  assert.deepEqual(Object.keys(back.cells[0].metadata), ["__proto__"]);
  assert.deepEqual(Object.keys(back.cells[0].outputs[0].data), ["__proto__", "text/plain"]);
});

test("hot exit: a notebook's backup reads back as it was; broken ones are refused", () => {
  const nb: Notebook = {
    cells: [
      {
        id: "a",
        kind: "code",
        source: "print(1)",
        metadata: { tags: ["x"] },
        outputs: [{ output_type: "stream", name: "stdout", text: "1\n" }],
        executionCount: 3,
        extra: {},
      },
      {
        id: "b",
        kind: "markdown",
        source: "# T",
        metadata: {},
        outputs: [],
        executionCount: null,
        extra: { attachments: {} },
      },
    ],
    metadata: { language_info: { name: "python" } },
    nbformat: 4,
    nbformatMinor: 5,
    extra: {},
  };
  assert.deepEqual(notebookFromBackup(notebookBackupText(nb)), nb);
  assert.equal(notebookFromBackup("not json"), null);
  assert.equal(notebookFromBackup("{}"), null);
  assert.equal(notebookFromBackup('{"cells":[{"kind":"code"}]}'), null);
  // Missing fields get defaults; outputs that aren't outputs go.
  const fixed = notebookFromBackup(
    '{"cells":[{"source":"x","kind":"weird","outputs":[1,{"output_type":"stream"}]}]}',
  );
  assert.equal(fixed?.cells[0]?.kind, "code");
  assert.equal(fixed?.cells[0]?.outputs.length, 1);
  assert.ok(fixed?.cells[0]?.id);
  assert.equal(fixed?.nbformat, 4);
});

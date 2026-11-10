// D257: the `vscode` shim's conversions for tasks, test coverage and notebooks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fromIdeNotebook, outputEvents, toIdeNotebook } from "./notebooks";
import { coverageLines } from "./testing";
import { Position, Range, TaskPanelKind, TaskRevealKind, TaskScope } from "./types";
import { shellCommandLine, shellFamily, toIdeTask } from "./workbench";
import {
  BranchCoverage,
  CustomExecution,
  NotebookCellData,
  NotebookCellOutput,
  NotebookCellOutputItem,
  NotebookData,
  ProcessExecution,
  ShellExecution,
  StatementCoverage,
  Task,
  TaskGroup,
} from "./workbenchTypes";

test("VS Code's tasks as the IDE's provided tasks", () => {
  const shell = new Task(
    { type: "acme" },
    TaskScope.Workspace,
    "build",
    "acme",
    new ShellExecution("make", ["all", "a b"], { cwd: "/w" }),
    "$gcc",
  );
  shell.group = TaskGroup.Build;
  shell.presentationOptions = { reveal: TaskRevealKind.Silent, panel: TaskPanelKind.Dedicated };
  assert.deepEqual(toIdeTask(shell), {
    name: "build",
    definition: { type: "acme" },
    group: "build",
    problemMatchers: ["$gcc"],
    presentation: { reveal: "silent", panel: "dedicated" },
    execution: { kind: "shell", commandLine: "make all 'a b'", cwd: "/w" },
  });
  const proc = new Task(
    { type: "acme" },
    TaskScope.Workspace,
    "run",
    "acme",
    new ProcessExecution("node", ["x.js"]),
  );
  assert.deepEqual(toIdeTask(proc)?.execution, {
    kind: "process",
    process: "node",
    args: ["x.js"],
  });
  const custom = toIdeTask(
    new Task({ type: "acme" }, TaskScope.Workspace, "c", "acme", new CustomExecution(() => ({}))),
  );
  assert.equal(custom?.execution.kind, "custom");
  // The deprecated constructor: Task(definition, name, source, execution).
  const old = new Task({ type: "x" }, "old", "x", new ShellExecution("echo hi"));
  assert.equal(toIdeTask(old)?.name, "old");
  assert.equal(toIdeTask(new Task({ type: "x" }, TaskScope.Workspace, "none", "x")), undefined);
});

test("statement coverage as the IDE's lines and branches", () => {
  const { lines, branches } = coverageLines([
    new StatementCoverage(3, new Range(0, 0, 1, 4)),
    new StatementCoverage(false, new Position(4, 2), [
      new BranchCoverage(true),
      new BranchCoverage(0),
    ]),
  ]);
  assert.deepEqual(lines, [
    [1, 3],
    [2, 3],
    [5, 0],
  ]);
  assert.deepEqual(branches, [[5, 1, 2]]);
});

test("notebooks: VS Code's data and outputs, the IDE's cells and nbformat", () => {
  const cell = new NotebookCellData(2, "print(1)", "python");
  cell.outputs = [
    new NotebookCellOutput([NotebookCellOutputItem.stdout("1\n")]),
    new NotebookCellOutput([
      NotebookCellOutputItem.text("<b>x</b>", "text/html"),
      new NotebookCellOutputItem(new Uint8Array([137, 80]), "image/png"),
    ]),
  ];
  cell.executionSummary = { executionOrder: 4 };
  const data = new NotebookData([cell, new NotebookCellData(1, "# hi", "markdown")]);
  const ide = toIdeNotebook(data);
  assert.equal(ide.cells[0]?.kind, "code");
  assert.equal(ide.cells[0]?.executionCount, 4);
  assert.deepEqual(ide.cells[0]?.outputs?.[0], {
    output_type: "stream",
    name: "stdout",
    text: "1\n",
  });
  assert.deepEqual((ide.cells[0]?.outputs?.[1] as { data: unknown } | undefined)?.data, {
    "text/html": "<b>x</b>",
    "image/png": "iVA=",
  });
  assert.equal(ide.cells[1]?.kind, "markdown");
  const back = fromIdeNotebook(ide);
  assert.equal(back.cells[0]?.languageId, "python");
  assert.equal(back.cells[0]?.outputs?.length, 2);
  assert.equal(new TextDecoder().decode(back.cells[0]?.outputs?.[0]?.items[0]?.data), "1\n");
  assert.deepEqual([...(back.cells[0]?.outputs?.[1]?.items[1]?.data ?? [])], [137, 80]);
  assert.deepEqual(
    outputEvents(new NotebookCellOutput([NotebookCellOutputItem.error(new Error("boom"))]))[0]
      ?.evalue,
    "boom",
  );
});

test("D261: a ShellExecution's arguments are quoted for the shell that runs them", () => {
  const parts = ["C:/Program Files/x/tool.exe", "--flag", "it's here"];
  assert.equal(
    shellCommandLine(parts, "powershell"),
    "& 'C:/Program Files/x/tool.exe' --flag 'it''s here'",
  );
  assert.equal(shellCommandLine(parts, "cmd"), `"C:/Program Files/x/tool.exe" --flag "it's here"`);
  assert.equal(shellCommandLine(["echo", "a b"], "posix"), "echo 'a b'");
  assert.equal(shellCommandLine(["npm", "test"], "powershell"), "npm test");
  // The default shell: PowerShell on Windows; the task's own executable otherwise.
  assert.equal(shellFamily(undefined, "win32"), "powershell");
  assert.equal(shellFamily(undefined, "linux"), "posix");
  assert.equal(shellFamily("C:\\Windows\\System32\\cmd.exe", "win32"), "cmd");
  assert.equal(shellFamily("/bin/bash", "win32"), "posix");
  const forCmd = new Task(
    { type: "acme" },
    TaskScope.Workspace,
    "cmd",
    "acme",
    new ShellExecution("set", ["X=1"], { executable: "cmd.exe", shellArgs: ["/d", "/c"] }),
  );
  assert.deepEqual(toIdeTask(forCmd, "win32")?.execution, {
    kind: "shell",
    commandLine: "set X=1",
    shell: { executable: "cmd.exe", args: ["/d", "/c"] },
  });
});

test("audit: an error output whose data is JSON null is shown as its text", () => {
  const item = new NotebookCellOutputItem(
    new TextEncoder().encode("null"),
    "application/vnd.code.notebook.error",
  );
  const [event] = outputEvents(new NotebookCellOutput([item]));
  assert.deepEqual(event, { type: "error", ename: "Error", evalue: "null", traceback: [] });
});

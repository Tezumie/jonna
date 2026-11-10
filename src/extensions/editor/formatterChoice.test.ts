// VS Code's editor.defaultFormatter choice (formatActionsMultiple.ts): the configured formatter,
// the only one, or a question; the IDE's own formatters count as one owner. DOM-free.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeFormatters,
  CONFIGURE_FORMATTER_ROW,
  EDITOR_FORMATTER,
  formatterIndex,
  formatterRows,
  formatWithRows,
  LANGUAGE_SERVERS_FORMATTER,
  pickFormatterPlaceholder,
} from "./formatterChoice";

const black = { id: "ms-python.black-formatter", label: "Black Formatter" };
const ruff = { id: "charliermarsh.ruff", label: "Ruff" };
const servers = { id: LANGUAGE_SERVERS_FORMATTER, label: "Language servers (pyright)" };
const editor = { id: EDITOR_FORMATTER, label: "Editor" };

test("the configured formatter wins, case aside; the only one needs no setting", () => {
  assert.deepEqual(
    analyzeFormatters([ruff, black], "MS-Python.Black-Formatter", "Python", "file"),
    { index: 1 },
  );
  assert.deepEqual(analyzeFormatters([black], undefined, "Python", "file"), { index: 0 });
  // The IDE's own formatters never made anyone choose.
  assert.deepEqual(analyzeFormatters([servers, editor], undefined, "TypeScript", "file"), {
    index: 0,
  });
});

test("several owners and none configured: VS Code's question", () => {
  assert.deepEqual(analyzeFormatters([servers, black], undefined, "Python", "file"), {
    message:
      "There are multiple formatters for Python files. One of them should be configured as default formatter.",
  });
  assert.deepEqual(analyzeFormatters([black, ruff], undefined, "Shell Script", "file"), {
    message:
      "There are multiple formatters for 'Shell Script' files. One of them should be configured as default formatter.",
  });
});

test("a configured formatter that can't format this file, or isn't there", () => {
  const installed = (id: string) => (id === ruff.id ? "Ruff" : undefined);
  assert.deepEqual(analyzeFormatters([black], ruff.id, "Python", "file", installed), {
    message: "Extension 'Ruff' is configured as formatter but it cannot format 'Python'-files",
  });
  assert.deepEqual(analyzeFormatters([black], ruff.id, "Python", "selection", installed), {
    message:
      "Extension 'Ruff' is configured as formatter but it can only format 'Python'-files as a whole, not selections or parts of it.",
  });
  assert.deepEqual(analyzeFormatters([black], "gone.formatter", "Python", "file"), {
    message:
      "Extension 'gone.formatter' is configured as formatter but not available. Select a different default formatter to continue.",
  });
});

test("the picker lists each formatter with its owner's id", () => {
  assert.deepEqual(formatterRows([black, servers]), [
    { id: "0", label: "Black Formatter", description: "ms-python.black-formatter" },
    { id: "1", label: "Language servers (pyright)", description: "builtin.language-servers" },
  ]);
  assert.equal(pickFormatterPlaceholder("Python"), "Select a default formatter for Python files");
});

test("Format document with…: each formatter, the default marked and active, then Configure", () => {
  const { rows, activeIndex } = formatWithRows([black, ruff, servers], "Charliermarsh.Ruff");
  assert.equal(activeIndex, 1);
  assert.deepEqual(rows, [
    { id: "0", label: "Black Formatter", description: "ms-python.black-formatter" },
    { id: "1", label: "Ruff", description: "(default) charliermarsh.ruff" },
    { id: "2", label: "Language servers (pyright)", description: "builtin.language-servers" },
    { id: CONFIGURE_FORMATTER_ROW, label: "Configure default formatter…", separator: "" },
  ]);
  // No default: the first row is active; no formatter at all: only Configure, no line above it.
  assert.equal(formatWithRows([black, ruff], undefined).activeIndex, 0);
  assert.deepEqual(formatWithRows([], undefined).rows, [
    { id: CONFIGURE_FORMATTER_ROW, label: "Configure default formatter…" },
  ]);
});

test("a formatter named by id, case aside", () => {
  assert.equal(formatterIndex([black, ruff], "CHARLIERMARSH.RUFF"), 1);
  assert.equal(formatterIndex([black, ruff], "gone.formatter"), -1);
});

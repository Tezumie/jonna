import assert from "node:assert/strict";
import { test } from "node:test";
import type { Diagnostic } from "./engine";
import { inlineText, lineDiagnostics } from "./inlineDiagnostics";

const d = (line: number, severity: Diagnostic["severity"], message: string, path = "/w/a.ts") =>
  ({
    path,
    line,
    severity,
    message,
    source: undefined,
    code: undefined,
    column: 1,
    endLine: line,
    endColumn: 2,
  }) satisfies Diagnostic;

test("the most severe problem per line, within the mode", () => {
  const all = [
    d(3, "warning", "unused"),
    d(3, "error", "wrong type"),
    d(5, "info", "fyi"),
    d(7, "warning", "other file", "/w/b.ts"),
  ];
  const lines = lineDiagnostics(all, "/w/a.ts", "errorsAndWarnings");
  assert.equal(lines.get(3)?.message, "wrong type");
  assert.equal(lines.has(5), false);
  assert.equal(lines.size, 1);
  assert.equal(lineDiagnostics(all, "/w/a.ts", "all").size, 2);
  assert.equal(lineDiagnostics(all, "/w/a.ts", "off").size, 0);
  assert.equal(lineDiagnostics(all, "/w/a.ts", "errors").get(3)?.severity, "error");
});

test("only the first line of a message, shortened", () => {
  assert.equal(inlineText(d(1, "error", "first\nsecond")).trim(), "first");
  assert.ok(
    inlineText(d(1, "error", "x".repeat(400)))
      .trim()
      .endsWith("…"),
  );
});

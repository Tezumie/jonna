// D207: Claude Code's /ide — diagnostics ranges, the notebook for executeCode, at_mentioned.
// D222: executeCode's images as MCP image content.
import assert from "node:assert/strict";
import { test } from "node:test";
import { outputImages } from "../notebook/nbformat";
import { atMention, executeCodeResult, ideDiagnostics, notebookForCode } from "./ideTools";

test("executeCode: a cell's images come back as image content after its text", () => {
  const png = "iVBORw0KGgo=";
  const outputs = [
    { output_type: "stream", name: "stdout", text: "hello\n" },
    // A plot: nbformat may split base64 into lines.
    {
      output_type: "display_data",
      data: { "image/png": ["iVBORw0K\n", "Ggo=\n"], "text/plain": "<Figure>" },
    },
    { output_type: "display_data", data: { "image/svg+xml": "<svg/>" } },
    { output_type: "display_data", data: { "image/jpeg": "not base64!" } },
    { output_type: "execute_result", data: { "image/webp": "UklGRg==", "image/png": png } },
  ];
  const images = outputImages(outputs);
  assert.deepEqual(images, [
    { mimeType: "image/png", data: png },
    { mimeType: "image/png", data: png },
  ]);
  assert.equal(outputImages(outputs, 1).length, 1);
  assert.equal(outputImages(outputs, 4, 15).length, 1, "a byte budget");
  const result = executeCodeResult({
    status: "ok",
    output: "hello\n[image/png] <Figure>\n[image/png]",
    images,
  });
  assert.deepEqual(result.content, [
    { type: "text", text: "hello\n<Figure>" },
    { type: "image", data: png, mimeType: "image/png" },
    { type: "image", data: png, mimeType: "image/png" },
  ]);
  assert.equal(result.isError, undefined);
  // Only an image: no empty text part.
  assert.deepEqual(
    executeCodeResult({ output: "[image/png]", images: [{ mimeType: "image/png", data: png }] })
      .content,
    [{ type: "image", data: png, mimeType: "image/png" }],
  );
  // Text only, an error, nothing at all.
  assert.deepEqual(executeCodeResult({ status: "error", output: "Traceback" }), {
    content: [{ type: "text", text: "Traceback" }],
    isError: true,
  });
  assert.deepEqual(executeCodeResult({}).content, [{ type: "text", text: "(no output)" }]);
});

test("diagnostics carry their whole range, 0-based, per file", () => {
  const out = ideDiagnostics(
    [
      {
        path: "/w/a.ts",
        line: 3,
        column: 5,
        endLine: 3,
        endColumn: 9,
        severity: "error",
        message: "bad",
        source: "ts",
        code: "2304",
      },
      { path: "/w/a.ts", line: 10, column: 1, severity: "warning", message: "no end" },
      {
        path: "/w/b.ts",
        line: 2,
        column: 4,
        endLine: 1,
        endColumn: 1,
        severity: "info",
        message: "backwards",
      },
    ],
    (p) => `file://${p}`,
  );
  assert.deepEqual(out, [
    {
      uri: "file:///w/a.ts",
      diagnostics: [
        {
          message: "bad",
          severity: "Error",
          range: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } },
          source: "ts",
          code: "2304",
        },
        {
          message: "no end",
          severity: "Warning",
          range: { start: { line: 9, character: 0 }, end: { line: 9, character: 0 } },
        },
      ],
    },
    {
      uri: "file:///w/b.ts",
      diagnostics: [
        {
          message: "backwards",
          severity: "Information",
          range: { start: { line: 1, character: 3 }, end: { line: 1, character: 3 } },
        },
      ],
    },
  ]);
  assert.equal(
    ideDiagnostics(
      [{ path: "/w/a.ts", line: 1, column: 1, severity: "error", message: "x" }],
      (p) => p,
      (p) => p === "/w/b.ts",
    ).length,
    0,
  );
});

test("executeCode runs in the active notebook, else the only one", () => {
  assert.deepEqual(
    notebookForCode({ open: ["/w/a.ipynb", "/w/b.ipynb"], active: { path: "/w/b.ipynb" } }),
    { path: "/w/b.ipynb" },
  );
  assert.deepEqual(notebookForCode({ open: ["/w/a.ipynb"], active: null }), { path: "/w/a.ipynb" });
  assert.match(
    (notebookForCode({ open: ["/w/a.ipynb", "/w/b.ipynb"] }) as { error: string }).error,
    /Several/,
  );
  assert.match((notebookForCode({ open: [] }) as { error: string }).error, /No Jupyter notebook/);
  // Another notebook type (not Jupyter) doesn't count.
  assert.ok("error" in notebookForCode({ open: ["/w/x.nb"], active: { path: "/w/x.nb" } }));
});

test("at_mentioned lines are 0-based; a selection ending at a line start leaves that line out", () => {
  assert.deepEqual(atMention("/w/a.ts", 11, 20, 5), {
    filePath: "/w/a.ts",
    lineStart: 10,
    lineEnd: 19,
  });
  assert.deepEqual(atMention("/w/a.ts", 11, 21, 1), {
    filePath: "/w/a.ts",
    lineStart: 10,
    lineEnd: 19,
  });
  assert.deepEqual(atMention("/w/a.ts", 4, 4, 1), {
    filePath: "/w/a.ts",
    lineStart: 3,
    lineEnd: 3,
  });
});

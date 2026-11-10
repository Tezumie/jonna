// A tiny language server for tests/scripts/lsp.jsonc (stdio, Content-Length framing).
// Diagnostics: a warning on every line containing "workspace". Hover: the word under the cursor.
// Definition: line 1 of the same file. Symbols: one per markdown heading.
let buffer = Buffer.alloc(0);
const docs = new Map();

function send(msg) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function diagnostics(uri) {
  const lines = (docs.get(uri) ?? "").split("\n");
  const out = [];
  lines.forEach((text, line) => {
    const at = text.indexOf("workspace");
    if (at >= 0)
      out.push({
        range: { start: { line, character: at }, end: { line, character: at + 9 } },
        severity: 2,
        source: "mock",
        message: "Mock warning: workspace",
      });
    // D200: only pulled (textDocument/diagnostic), never published.
    const pulledAt = text.indexOf("pulled");
    if (pulledAt >= 0 && pulling)
      out.push({
        range: { start: { line, character: pulledAt }, end: { line, character: pulledAt + 6 } },
        severity: 2,
        source: "mock",
        message: "Mock pulled: pulled",
      });
  });
  return out;
}

let pulling = false;

function diagnose(uri) {
  send({
    method: "textDocument/publishDiagnostics",
    params: {
      uri,
      diagnostics: diagnostics(uri).filter((d) => !d.message.startsWith("Mock pulled")),
    },
  });
}

function handle(msg) {
  const { id, method, params } = msg;
  if (d204)
    logCall(
      `${method}${method === "workspace/didChangeConfiguration" ? ` ${JSON.stringify(params.settings)}` : ""}`,
    );
  switch (method) {
    case "initialize":
      root = String(params.rootPath ?? "");
      if (d204) logCall("initialize");
      return send({
        id,
        result: {
          capabilities: {
            textDocumentSync: m77 ? { openClose: true, change: 1, save: { includeText: true } } : 1,
            hoverProvider: true,
            definitionProvider: true,
            documentSymbolProvider: true,
            completionProvider: { triggerCharacters: ["."] },
            codeActionProvider: { codeActionKinds: ["quickfix", "source.organizeImports"] },
            inlayHintProvider: true,
            diagnosticProvider: { interFileDependencies: d204, workspaceDiagnostics: d204 },
            linkedEditingRangeProvider: true,
            ...(d204 && {
              semanticTokensProvider: {
                legend: { tokenTypes: ["keyword", "variable"], tokenModifiers: [] },
                full: { delta: true },
                range: true,
              },
            }),
          },
          serverInfo: { name: "mock-lsp" },
        },
      });
    case "textDocument/didOpen":
      docs.set(params.textDocument.uri, params.textDocument.text);
      return diagnose(params.textDocument.uri);
    case "textDocument/didChange":
      docs.set(params.textDocument.uri, params.contentChanges.at(-1).text);
      return diagnose(params.textDocument.uri);
    case "textDocument/didClose":
      docs.delete(params.textDocument.uri);
      // D218 (--m77): a server that reports closed files too (pyright's workspace mode).
      if (m77)
        send({
          method: "textDocument/publishDiagnostics",
          params: {
            uri: params.textDocument.uri,
            diagnostics: [{ range, severity: 2, source: "mock", message: "Mock closed: kept" }],
          },
        });
      return;
    case "initialized":
      // D218 (--m77): problems for a file nobody opened.
      if (m77)
        send({
          method: "textDocument/publishDiagnostics",
          params: {
            uri: `file://${root.startsWith("/") ? "" : "/"}${root.replaceAll("\\", "/")}/never.md`,
            diagnostics: [{ range, severity: 2, source: "mock", message: "Mock unopened" }],
          },
        });
      return;
    case "textDocument/didSave":
      logCall(`didSave text=${JSON.stringify(params.text ?? null)}`);
      return;
    case "textDocument/hover": {
      const line =
        (docs.get(params.textDocument.uri) ?? "").split("\n")[params.position.line] ?? "";
      const word = /\w+/.exec(line.slice(params.position.character))?.[0] ?? "";
      return send({ id, result: { contents: { kind: "markdown", value: `mock hover: ${word}` } } });
    }
    case "textDocument/definition":
      return send({
        id,
        result: {
          uri: params.textDocument.uri,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
      });
    case "textDocument/documentSymbol": {
      const lines = (docs.get(params.textDocument.uri) ?? "").split("\n");
      const result = [];
      lines.forEach((text, line) => {
        if (text.startsWith("#")) {
          const range = { start: { line, character: 0 }, end: { line, character: text.length } };
          result.push({ name: text.replace(/^#+\s*/, ""), kind: 15, range, selectionRange: range });
        }
      });
      return send({ id, result });
    }
    // D199: a quick fix on every line ("Mock fix: …") and an inlay hint at the start of line 1.
    case "textDocument/codeAction": {
      // D200: "organize imports" (editor.codeActionsOnSave) puts a mark on line 1.
      if (params.context?.only?.includes("source.organizeImports"))
        return send({
          id,
          result: [
            {
              title: "Mock organize",
              kind: "source.organizeImports",
              edit: {
                changes: {
                  [params.textDocument.uri]: [
                    {
                      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                      newText: "ORGANIZED ",
                    },
                  ],
                },
              },
            },
          ],
        });
      const line = params.range.start.line;
      return send({
        id,
        result: [
          {
            title: `Mock fix: line ${line + 1}`,
            kind: "quickfix",
            isPreferred: true,
            edit: {
              changes: {
                [params.textDocument.uri]: [
                  {
                    range: { start: { line, character: 0 }, end: { line, character: 0 } },
                    newText: "FIXED ",
                  },
                ],
              },
            },
          },
        ],
      });
    }
    case "textDocument/inlayHint":
      return send({
        id,
        result: [{ position: { line: 0, character: 0 }, label: "mock-hint", paddingRight: true }],
      });
    case "textDocument/diagnostic":
      pulling = true;
      return send({ id, result: { kind: "full", items: diagnostics(params.textDocument.uri) } });
    case "textDocument/linkedEditingRange": {
      // The word under the cursor and the same word on the next line.
      const lines = (docs.get(params.textDocument.uri) ?? "").split("\n");
      const { line, character } = params.position;
      const text = lines[line] ?? "";
      const m = /\w+/.exec(text.slice(character));
      if (!m || m.index !== 0) return send({ id, result: null });
      const word = m[0];
      const next = (lines[line + 1] ?? "").indexOf(word);
      const ranges = [
        { start: { line, character }, end: { line, character: character + word.length } },
      ];
      if (next >= 0)
        ranges.push({
          start: { line: line + 1, character: next },
          end: { line: line + 1, character: next + word.length },
        });
      return send({ id, result: { ranges } });
    }
    case "textDocument/semanticTokens/full": {
      const data = tokensFor(params.textDocument.uri);
      sentTokens.set(params.textDocument.uri, data);
      return send({ id, result: { resultId: String(++semanticSeq), data } });
    }
    case "textDocument/semanticTokens/full/delta": {
      // One edit after the part both arrays share, against the result id the client has.
      logCall(`semantic delta from ${params.previousResultId}`);
      const before = sentTokens.get(params.textDocument.uri) ?? [];
      const data = tokensFor(params.textDocument.uri);
      sentTokens.set(params.textDocument.uri, data);
      let start = 0;
      while (start < before.length && start < data.length && before[start] === data[start]) start++;
      return send({
        id,
        result: {
          resultId: String(++semanticSeq),
          edits: [{ start, deleteCount: before.length - start, data: data.slice(start) }],
        },
      });
    }
    case "textDocument/semanticTokens/range":
      return send({ id, result: { data: tokensFor(params.textDocument.uri).slice(0, 5) } });
    case "workspace/diagnostic": {
      const uri = `file://${root.startsWith("/") ? "" : "/"}${root.replaceAll("\\", "/")}/closed.md`;
      const known = (params.previousResultIds ?? []).some((p) => p.value === "w1");
      // A partial result first, then the final answer.
      if (params.partialResultToken !== undefined && !known)
        send({
          method: "$/progress",
          params: {
            token: params.partialResultToken,
            value: {
              items: [
                {
                  kind: "full",
                  uri,
                  resultId: "w1",
                  items: [
                    {
                      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                      severity: 1,
                      source: "mock",
                      message: "Mock workspace: closed",
                    },
                  ],
                },
              ],
            },
          },
        });
      return send({
        id,
        result: { items: known ? [{ kind: "unchanged", uri, resultId: "w1" }] : [] },
      });
    }
    case "textDocument/completion":
      return send({ id, result: [{ label: "mockCompletion", kind: 3 }] });
    case "shutdown":
      return send({ id, result: null });
    case "exit":
      return process.exit(0);
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `unhandled ${method}` } });
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const sep = buffer.indexOf("\r\n\r\n");
    if (sep < 0) return;
    const length = Number(
      /Content-Length: *(\d+)/i.exec(buffer.subarray(0, sep).toString())?.[1] ?? 0,
    );
    if (buffer.length < sep + 4 + length) return;
    const body = buffer.subarray(sep + 4, sep + 4 + length).toString("utf8");
    buffer = buffer.subarray(sep + 4 + length);
    handle(JSON.parse(body));
  }
});
process.stderr.write("mock-lsp ready\n");

// D204 (with --d204): semantic tokens with deltas and ranges, workspace pull diagnostics (a
// problem in closed.md, which no test opens), and every call logged to .mock-lsp-calls.txt. Kept
// at the end so the lines above stay where other tests expect them (quick open's symbols).
import { appendFileSync } from "node:fs";

const d204 = process.argv.includes("--d204");
// D218 (with --m77): didSave with its text, problems for closed and unopened files.
const m77 = process.argv.includes("--m77");
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } };
let root = "";
let semanticSeq = 0;
function logCall(line) {
  if (d204 && root) appendFileSync(`${root}/.mock-lsp-calls.txt`, `${line}\n`);
}
/** A keyword token on the first 3 characters of each non-empty line (5 numbers each). */
function tokensFor(uri) {
  const out = [];
  let prev = 0;
  (docs.get(uri) ?? "").split("\n").forEach((text, line) => {
    if (!text.length) return;
    out.push(line - prev, 0, Math.min(3, text.length), 0, 0);
    prev = line;
  });
  return out;
}
/** The tokens last sent per document, which a delta is made against. */
const sentTokens = new Map();

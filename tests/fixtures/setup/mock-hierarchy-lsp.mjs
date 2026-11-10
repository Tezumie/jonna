// A tiny language server for tests/scripts/hierarchy-m7-11.jsonc (stdio, Content-Length framing):
// call and type hierarchies and document colors over a made-up text format.
//   "alpha calls beta"          alpha (a function on that line) calls beta
//   "class Child extends Base"  Child is a subtype of Base
//   "#rrggbb", "orange"         a color (the word only a server knows: the editor's own
//                               detector finds hex, rgb() and hsl() alone)
// Items are named after the word under the cursor; a function's or class's line is the one that
// starts with its name (or "class <name>").
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let buffer = Buffer.alloc(0);
const docs = new Map();

function send(msg) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function lines(uri) {
  let text = docs.get(uri);
  if (text === undefined) {
    try {
      text = readFileSync(fileURLToPath(uri), "utf8");
    } catch {
      text = "";
    }
  }
  return text.replace(/\r\n/g, "\n").split("\n");
}

const range = (line, character, length) => ({
  start: { line, character },
  end: { line, character: character + length },
});

/** The item for `name` in `uri`: its defining line (or line 0), kind 12 function or 5 class. */
function item(uri, name, kind) {
  const all = lines(uri);
  let line = all.findIndex((t) =>
    kind === 5 ? t.startsWith(`class ${name} `) || t === `class ${name}` : t.startsWith(`${name} `),
  );
  if (line < 0) line = 0;
  const at = Math.max(0, (all[line] ?? "").indexOf(name));
  return {
    name,
    kind,
    detail: kind === 5 ? "class" : "function",
    uri,
    range: range(line, 0, (all[line] ?? "").length),
    selectionRange: range(line, at, name.length),
    data: { name },
  };
}

function wordAt(uri, position) {
  const text = lines(uri)[position.line] ?? "";
  for (const m of text.matchAll(/\w+/g))
    if (m.index <= position.character && position.character <= m.index + m[0].length) return m[0];
  return null;
}

function colors(uri) {
  const out = [];
  lines(uri).forEach((text, line) => {
    for (const m of text.matchAll(/#([0-9a-fA-F]{6})\b/g)) {
      const n = Number.parseInt(m[1], 16);
      out.push({
        range: range(line, m.index, 7),
        color: {
          red: ((n >> 16) & 255) / 255,
          green: ((n >> 8) & 255) / 255,
          blue: (n & 255) / 255,
          alpha: 1,
        },
      });
    }
    for (const m of text.matchAll(/\borange\b/g))
      out.push({
        range: range(line, m.index, 6),
        color: { red: 1, green: 0.5, blue: 0, alpha: 1 },
      });
  });
  return out;
}

const hex = (c) =>
  `#${[c.red, c.green, c.blue]
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return send({
        id,
        result: {
          capabilities: {
            textDocumentSync: 1,
            callHierarchyProvider: true,
            typeHierarchyProvider: true,
            colorProvider: true,
          },
          serverInfo: { name: "mock-hierarchy-lsp" },
        },
      });
    case "textDocument/didOpen":
      docs.set(params.textDocument.uri, params.textDocument.text);
      return;
    case "textDocument/didChange":
      docs.set(params.textDocument.uri, params.contentChanges.at(-1).text);
      return;
    case "textDocument/didClose":
      docs.delete(params.textDocument.uri);
      return;
    case "textDocument/prepareCallHierarchy":
    case "textDocument/prepareTypeHierarchy": {
      const word = wordAt(params.textDocument.uri, params.position);
      const kind = method.includes("Type") ? 5 : 12;
      return send({ id, result: word ? [item(params.textDocument.uri, word, kind)] : null });
    }
    case "callHierarchy/incomingCalls": {
      const { uri, name } = params.item;
      const result = [];
      lines(uri).forEach((text, line) => {
        const m = /^(\w+) calls (\w+)/.exec(text);
        if (m && m[2] === name)
          result.push({
            from: item(uri, m[1], 12),
            fromRanges: [range(line, text.lastIndexOf(name), name.length)],
          });
      });
      return send({ id, result });
    }
    case "callHierarchy/outgoingCalls": {
      const { uri, name } = params.item;
      const result = [];
      lines(uri).forEach((text, line) => {
        const m = /^(\w+) calls (\w+)/.exec(text);
        if (m && m[1] === name)
          result.push({
            to: item(uri, m[2], 12),
            fromRanges: [range(line, text.lastIndexOf(m[2]), m[2].length)],
          });
      });
      return send({ id, result });
    }
    case "typeHierarchy/supertypes":
    case "typeHierarchy/subtypes": {
      const { uri, name } = params.item;
      const result = [];
      for (const text of lines(uri)) {
        const m = /^class (\w+) extends (\w+)/.exec(text);
        if (!m) continue;
        if (method.endsWith("supertypes") && m[1] === name) result.push(item(uri, m[2], 5));
        if (method.endsWith("subtypes") && m[2] === name) result.push(item(uri, m[1], 5));
      }
      return send({ id, result });
    }
    case "textDocument/documentColor":
      return send({ id, result: colors(params.textDocument.uri) });
    case "textDocument/colorPresentation":
      return send({
        id,
        result: [
          {
            label: hex(params.color),
            textEdit: { range: params.range, newText: hex(params.color) },
          },
        ],
      });
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
process.stderr.write("mock-hierarchy-lsp ready\n");

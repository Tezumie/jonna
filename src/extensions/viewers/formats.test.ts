import assert from "node:assert/strict";
import { test } from "node:test";
import { guessDelimiter, hexRow, parseDelimited } from "./formats";

test("hex rows: offset, grouped bytes, printable text", () => {
  const bytes = new TextEncoder().encode("Hello\n\u0001world, more text!!");
  const row = hexRow(bytes, 0);
  assert.equal(row.offset, "00000000");
  assert.equal(row.hex, "48 65 6c 6c 6f 0a 01 77  6f 72 6c 64 2c 20 6d 6f");
  assert.equal(row.text, "Hello..world, mo");
  const last = hexRow(bytes, 16);
  assert.equal(last.offset, "00000010");
  assert.equal(last.text, "re text!!");
  assert.equal(last.hex.split(" ").filter(Boolean).length, 9);
});

test("CSV: quotes, embedded delimiters and newlines, CRLF, limit", () => {
  const text = 'name,note\r\n"Smith, J","said ""hi""\nthen left"\r\nAda,ok\n';
  const { rows, truncated } = parseDelimited(text, ",");
  assert.deepEqual(rows, [
    ["name", "note"],
    ["Smith, J", 'said "hi"\nthen left'],
    ["Ada", "ok"],
  ]);
  assert.equal(truncated, false);
  const cut = parseDelimited(text, ",", 2);
  assert.equal(cut.rows.length, 2);
  assert.equal(cut.truncated, true);
  assert.equal(guessDelimiter("a.csv", "a;b;c\n1;2;3"), ";");
  assert.equal(guessDelimiter("a.tsv", "a,b"), "\t");
  assert.equal(guessDelimiter("a.csv", "a,b,c"), ",");
});

test("ZIP central directory: names, sizes, dates, folders, comment", async () => {
  const { parseZip } = await import("./formats");
  const bytes = Uint8Array.from(
    atob(
      "UEsDBBQAAAAAAAU5plgAAAAAAAAAAAAAAAAEAAAAc3JjL1BLAwQUAAAACAAFOaZYordsgxAAAADCAQAACwAAAHNyYy9tYWluLnB5KyjKzCvRMNTkKhhlDE0GAFBLAwQUAAAACAConFJdhqYQNgcAAAAFAAAACQAAAFJFQURNRS5tZMtIzcnJBwBQSwECFAMUAAAAAAAFOaZYAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAgAEAAAAAc3JjL1BLAQIUAxQAAAAIAAU5pliit2yDEAAAAMIBAAALAAAAAAAAAAAAAACAASIAAABzcmMvbWFpbi5weVBLAQIUAxQAAAAIAKicUl2GphA2BwAAAAUAAAAJAAAAAAAAAAAAAACAAVsAAABSRUFETUUubWRQSwUGAAAAAAMAAwCiAAAAiQAAAAQAbm90ZQ==",
    ),
    (c) => c.charCodeAt(0),
  );
  const zip = parseZip(bytes);
  assert.ok(zip);
  assert.equal(zip.comment, "note");
  assert.deepEqual(
    zip.entries.map((e) => [e.name, e.dir, e.size]),
    [
      ["src/", true, 0],
      ["src/main.py", false, 450],
      ["README.md", false, 5],
    ],
  );
  assert.ok((zip.entries[1]?.compressed ?? 0) < 450);
  assert.equal(zip.entries[1]?.modified?.getFullYear(), 2024);
  assert.equal(zip.entries[1]?.modified?.getMinutes(), 8);
  assert.equal(parseZip(new TextEncoder().encode("not a zip at all, just text")), null);
});

test("notebook cells and outputs", async () => {
  const { parseNotebook } = await import("./formats");
  const nb = parseNotebook({
    metadata: { language_info: { name: "python" } },
    cells: [
      { cell_type: "markdown", source: ["# Title\n", "text"] },
      {
        cell_type: "code",
        execution_count: 3,
        source: "print(1)",
        outputs: [
          { output_type: "stream", text: ["1\n"] },
          { output_type: "execute_result", data: { "text/plain": ["42"] } },
          {
            output_type: "display_data",
            data: { "image/png": "iVBO\nRw0=", "text/plain": "<img>" },
          },
          {
            output_type: "error",
            ename: "ValueError",
            evalue: "bad",
            traceback: ["\u001b[31mValueError\u001b[0m: bad"],
          },
        ],
      },
    ],
  });
  assert.ok(nb);
  assert.equal(nb.language, "python");
  assert.equal(nb.cells[0]?.source, "# Title\ntext");
  assert.equal(nb.cells[1]?.executionCount, 3);
  assert.deepEqual(nb.cells[1]?.outputs, [
    { kind: "text", text: "1\n" },
    { kind: "text", text: "42" },
    { kind: "image", mime: "image/png", data: "iVBORw0=" },
    { kind: "text", error: true, text: "ValueError: bad" },
  ]);
  assert.equal(parseNotebook({ nope: 1 }), null);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { parseToUnicode, pdfText } from "./pdfText";

/** A stream object's text: its dictionary entries and data (deflated with `flate`). */
function stream(data: string | Buffer, extra = "", flate = false): string {
  const body = flate
    ? deflateSync(Buffer.from(data as string, "latin1"))
    : Buffer.from(data as string, "latin1");
  return `<< /Length ${body.length}${flate ? " /Filter /FlateDecode" : ""} ${extra}>>\nstream\n${body.toString("latin1")}\nendstream`;
}

/** A PDF from numbered object bodies (no xref: the reader scans for objects). */
function pdf(objects: Record<number, string>, root = 1): Uint8Array {
  let out = "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n";
  for (const [num, body] of Object.entries(objects)) out += `${num} 0 obj\n${body}\nendobj\n`;
  out += `trailer\n<< /Root ${root} 0 R /Size ${Object.keys(objects).length + 1} >>\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

const helvetica =
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

test("a simple PDF: lines from Td and T*, pages in the page tree's order", async () => {
  const page1 = stream("BT /F1 12 Tf 72 720 Td (Hello, world) Tj 0 -14 Td (Second line) Tj ET");
  const page2 = stream(
    "BT /F1 12 Tf 72 720 Td (Page two) Tj T* (\\(escaped\\) \\224quoted\\224) Tj ET",
  );
  const doc = pdf({
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    // Kids listed in reverse number order: the tree's order wins.
    2: "<< /Type /Pages /Kids [6 0 R 3 0 R] /Count 2 /Resources << /Font << /F1 5 0 R >> >> >>",
    3: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
    4: page2,
    5: helvetica,
    6: "<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>",
    7: page1,
  });
  const r = await pdfText(doc);
  assert.equal(r.encrypted, false);
  assert.deepEqual(r.pages, ["Hello, world\nSecond line", "Page two\n(escaped) ”quoted”"]);
});

test("deflated content, TJ word gaps, and a Type0 font through its ToUnicode map", async () => {
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
1 begincodespacerange <0000> <FFFF> endcodespacerange
2 beginbfchar <0003> <0020> <0024> <00E9> endbfchar
1 beginbfrange <0010> <0012> <0061> endbfrange
1 beginbfrange <0020> <0021> [<0043> <006F>] endbfrange
endcmap CMapName currentdict /CMap defineresource pop end end`;
  // "abc" (range), space, "é", then "Co" (array range).
  const content =
    "BT /F2 10 Tf 50 700 Td <0010001100120003> Tj <0024> Tj ET BT /F2 10 Tf 1 0 0 1 50 680 Tm [<0020> -50 <0021>] TJ ET BT /F1 10 Tf 50 660 Td [(Wide) -400 (gap)] TJ ET";
  const doc = pdf({
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    3: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>",
    4: stream(content, "", true),
    5: helvetica,
    6: "<< /Type /Font /Subtype /Type0 /BaseFont /Abc /Encoding /Identity-H /ToUnicode 7 0 R >>",
    7: stream(cmap, "", true),
  });
  const r = await pdfText(doc);
  assert.deepEqual(r.pages, ["abc é\nCo\nWide gap"]);
});

test("objects packed in an object stream are read (PDF 1.5)", async () => {
  // Objects 2 (Pages) and 3 (Page) live in object stream 10.
  const inner2 = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  const inner3 =
    "<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>";
  const header = `2 0 3 ${inner2.length + 1} `;
  const objStm = stream(
    `${header}${inner2}\n${inner3}`,
    `/Type /ObjStm /N 2 /First ${header.length} `,
    true,
  );
  const doc = pdf({
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    4: stream("BT /F1 12 Tf 10 10 Td (Packed) Tj ET", "", true),
    5: helvetica,
    10: objStm,
  });
  assert.deepEqual((await pdfText(doc)).pages, ["Packed"]);
});

test("text inside a Form XObject is followed; a /Differences encoding is used", async () => {
  const doc = pdf({
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    3: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /XObject << /X1 6 0 R >> >> >>",
    4: stream("q /X1 Do Q"),
    5: "<< /Type /Font /Subtype /Type1 /Encoding << /Differences [65 /uni263A /fi] >> >>",
    6: stream(
      "BT /F9 12 Tf 0 0 Td (AB!) Tj ET",
      "/Type /XObject /Subtype /Form /Resources << /Font << /F9 5 0 R >> >> ",
    ),
  });
  assert.deepEqual((await pdfText(doc)).pages, ["☺fi!"]);
});

test("not a PDF throws; an encrypted one says so; a damaged catalog still finds pages", async () => {
  await assert.rejects(pdfText(new Uint8Array(Buffer.from("hello"))), /not a PDF/);
  const enc = pdf({ 1: "<< /Type /Catalog /Pages 2 0 R >>", 2: "<< /Type /Pages /Kids [] >>" });
  const withEncrypt = new Uint8Array(
    Buffer.from(
      Buffer.from(enc).toString("latin1").replace("/Size", "/Encrypt 9 0 R /Size"),
      "latin1",
    ),
  );
  assert.equal((await pdfText(withEncrypt)).encrypted, true);
  const damaged = pdf(
    {
      3: "<< /Type /Page /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
      4: stream("BT /F1 9 Tf (Orphan page) Tj ET"),
      5: helvetica,
    },
    99,
  );
  assert.deepEqual((await pdfText(damaged)).pages, ["Orphan page"]);
});

test("a negative /Length that points back at an earlier endstream doesn't loop", async () => {
  const head = "%PDF-1.7\n1 0 obj\n<< /Length 3 >>\nstream\nabc\nendstream\nendobj\n";
  const second = "2 0 obj\n<< /Length -XX >>\nstream\n";
  // From the second stream's data back to the first one's "\nendstream".
  const back = head.length + second.length - head.indexOf("\nendstream");
  const text = `${head}${second.replace("XX", String(back))}data\nendstream\nendobj\ntrailer\n<< >>\n`;
  const r = await pdfText(new Uint8Array(Buffer.from(text, "latin1")));
  assert.deepEqual(r.pages, []);
});

test("an object stream's /N past its header, and forms that call each other, stay bounded", async () => {
  const header = "2 0 ";
  const objStm = stream(
    `${header}<< /Type /Font >>`,
    `/Type /ObjStm /N 1000000000000 /First ${header.length} `,
  );
  // Each form shows "x" and calls itself many times: without a budget, 50^4 runs.
  const calls = "/X Do ".repeat(50);
  const doc = pdf({
    1: "<< /Type /Catalog /Pages 3 0 R >>",
    3: "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    4: "<< /Type /Page /Contents 5 0 R /Resources << /XObject << /X 6 0 R >> /Font << /F1 7 0 R >> >> >>",
    5: stream(`BT /F1 9 Tf (x) Tj ET ${calls}`),
    6: stream(
      `BT /F1 9 Tf (x) Tj ET ${calls}`,
      "/Type /XObject /Subtype /Form /Resources << /XObject << /X 6 0 R >> /Font << /F1 7 0 R >> >> ",
    ),
    7: helvetica,
    10: objStm,
  });
  const started = Date.now();
  const r = await pdfText(doc);
  assert.ok(Date.now() - started < 5000);
  assert.equal(r.pages.length, 1);
});

test("a ligature's uni name (several units) and an out-of-range u name don't fail the file", async () => {
  const doc = pdf({
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    3: "<< /Type /Page /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    4: stream("BT /F1 12 Tf 0 0 Td (ABC) Tj ET"),
    5: "<< /Type /Font /Subtype /Type1 /Encoding << /Differences [65 /uni00660069 /uFFFFFF /u1F600] >> >>",
  });
  assert.deepEqual((await pdfText(doc)).pages, ["fi😀"]);
});

test("many wide ToUnicode ranges stay bounded", () => {
  const started = Date.now();
  const map = parseToUnicode(`1 beginbfrange ${"<0000> <FFFF> <0041> ".repeat(3000)}endbfrange`);
  assert.ok(Date.now() - started < 3000);
  assert.equal(map.get(0), "A");
});

test("ToUnicode ranges count up in their last unit", () => {
  const map = parseToUnicode("1 beginbfrange <41> <43> <0058> endbfrange");
  assert.deepEqual(
    [...map.entries()],
    [
      [0x41, "X"],
      [0x42, "Y"],
      [0x43, "Z"],
    ],
  );
});

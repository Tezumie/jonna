import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bomEncoding,
  decodeWith,
  ENCODINGS,
  encodeText,
  encodeWith,
  encodingForWhatwgName,
  unencodable,
} from "./encodings";

test("encodings round-trip", () => {
  const text = "café – naïve";
  for (const id of ["utf8", "utf8bom", "utf16le", "utf16be"])
    assert.equal(decodeWith(encodeWith(text, id), id), text);
  assert.equal(bomEncoding(encodeWith("x", "utf16le")), "utf16le");
  const latin = encodeWith("café", "windows-1252");
  assert.deepEqual([...latin], [0x63, 0x61, 0x66, 0xe9]);
  assert.equal(decodeWith(latin, "windows-1252"), "café");
  // "–" (en dash) exists in Windows-1252 (0x96) but not in ISO 8859-1.
  assert.deepEqual(unencodable(text, "iso-8859-1"), ["–"]);
  assert.throws(() => encodeWith("日本", "windows-1252"), /can't hold/);
  assert.throws(() => encodeWith("x", "shift_jis"), /native encoder/);
});

test("multi-byte encodings are written natively and decoded by TextDecoder (D204)", async () => {
  const calls: string[] = [];
  const native = async (text: string, name: string) => {
    calls.push(name);
    if (text.includes("😀")) throw new Error('can\'t hold "😀"');
    return Uint8Array.from([0x93, 0xfa, 0x96, 0x7b]); // 日本 in Shift JIS
  };
  const bytes = await encodeText("日本", "shift_jis", native);
  assert.deepEqual(calls, ["shift_jis"]);
  assert.equal(decodeWith(bytes, "shift_jis"), "日本");
  await assert.rejects(
    encodeText("😀", "shift_jis", native),
    /Japanese \(Shift JIS\) can't hold "😀": save as UTF-8/,
  );
  // The real IPC error carries Rust's "invalid argument: " prefix.
  await assert.rejects(
    encodeText("😀", "shift_jis", async () => {
      throw new Error('invalid argument: can\'t hold "😀"');
    }),
    { message: 'Japanese (Shift JIS) can\'t hold "😀": save as UTF-8, or remove them.' },
  );
  // Table encodings never reach the native side.
  assert.deepEqual([...(await encodeText("é", "windows-1252", native))], [0xe9]);
  assert.equal(calls.length, 2);
  // Everything listed can be saved now. (Node's ICU lacks a few WHATWG decoders, such as
  // ISO 8859-16, that the webviews have, so decoders aren't checked here.)
  for (const e of ENCODINGS) assert.ok(e.canSave, e.id);
  assert.equal(unencodable("😀", "gbk").length, 0);
});

test("the detector's WHATWG names map to our ids (D204)", () => {
  assert.equal(encodingForWhatwgName("Shift_JIS")?.id, "shift_jis");
  assert.equal(encodingForWhatwgName("UTF-8")?.id, "utf8");
  assert.equal(encodingForWhatwgName("UTF-16LE")?.id, "utf16le");
  assert.equal(encodingForWhatwgName("windows-1251")?.id, "windows-1251");
  assert.equal(encodingForWhatwgName("x-user-defined"), undefined);
});

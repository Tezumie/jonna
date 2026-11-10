import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFile, diskChange, guessUtf16, isBinary, utf8Again, wantsGuess } from "./diskText";
import { encodeWith } from "./encodings";

const encode = (t: string) => new TextEncoder().encode(t);

test("decodeFile: UTF-8 with and without a BOM", () => {
  assert.deepEqual(decodeFile(encode("héllo")), {
    text: "héllo",
    binary: false,
    hadBom: false,
    notUtf8: false,
    encoding: "utf8",
  });
  const bom = decodeFile(Uint8Array.from([0xef, 0xbb, 0xbf, 0x61]));
  assert.equal(bom.text, "a");
  assert.ok(bom.hadBom);
  assert.ok(!bom.notUtf8);
});

test("decodeFile: Windows-1252 text is flagged, not silently replaced", () => {
  // "café" in Windows-1252: a lone 0xE9 is invalid UTF-8.
  const latin1 = decodeFile(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]));
  assert.ok(latin1.notUtf8);
  assert.ok(!latin1.binary);
  assert.ok(latin1.text.startsWith("caf"));
});

test("decodeFile: binary wins over encoding checks", () => {
  const binary = decodeFile(Uint8Array.from([0x00, 0xe9, 0x01]));
  assert.ok(binary.binary);
  assert.ok(!binary.notUtf8);
  assert.equal(binary.text, "");
  assert.ok(isBinary(Uint8Array.from([0x61, 0x00])));
  assert.ok(!isBinary(encode("plain")));
});

test("diskChange: the echo of our own save after more typing isn't external", () => {
  assert.equal(diskChange("a", "a", "old"), "same");
  assert.equal(diskChange("saved", "saved and typed on", "saved"), "ownWrite");
  assert.equal(diskChange("theirs", "saved and typed on", "saved"), "external");
  assert.equal(diskChange("theirs", "mine", undefined), "external");
});

test("decodeFile: files.encoding and files.autoGuessEncoding (D200)", () => {
  const latin = Uint8Array.from([0x63, 0x61, 0x66, 0xe9]); // "café" in Windows-1252
  assert.equal(decodeFile(latin).notUtf8, true);
  const fallback = decodeFile(latin, undefined, { fallback: "windows-1252" });
  assert.equal(fallback.text, "café");
  assert.equal(fallback.notUtf8, false);
  assert.equal(fallback.encoding, "windows-1252");
  assert.equal(decodeFile(latin, undefined, { guess: true }).encoding, "windows-1252");
  // Valid UTF-8 stays UTF-8 whatever the fallback.
  assert.equal(decodeFile(encode("é"), undefined, { fallback: "windows-1252" }).encoding, "utf8");
  // Shift JIS can be written back now (D204): a fallback to it opens writable.
  assert.equal(decodeFile(latin, undefined, { fallback: "shift_jis" }).notUtf8, false);
  // UTF-16 LE without a BOM is guessed, not taken for binary.
  const le = Uint8Array.from([..."hello world"].flatMap((c) => [c.charCodeAt(0), 0]));
  const guessed = decodeFile(le, undefined, { guess: true });
  assert.equal(guessed.encoding, "utf16le");
  assert.equal(guessed.text, "hello world");
  assert.equal(guessUtf16(encode("plain text here")), null);
  assert.equal(decodeFile(le).binary, true);
});

test("decodeFile: the detector's guess (D204)", () => {
  const sjis = Uint8Array.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]); // 日本語 in Shift JIS
  assert.ok(wantsGuess(sjis, true));
  assert.ok(!wantsGuess(sjis, false));
  assert.ok(!wantsGuess(encode("日本語"), true));
  assert.ok(!wantsGuess(Uint8Array.from([0xff, 0xfe, 0x61, 0]), true));
  const read = decodeFile(sjis, undefined, { guess: true, guessed: "Shift_JIS" });
  assert.equal(read.encoding, "shift_jis");
  assert.equal(read.text, "日本語");
  assert.equal(read.notUtf8, false);
  // The guess wins over files.encoding (VS Code); no guess falls back to it, then Windows-1252.
  assert.equal(
    decodeFile(sjis, undefined, { guess: true, guessed: "shift_jis", fallback: "gbk" }).encoding,
    "shift_jis",
  );
  assert.equal(
    decodeFile(sjis, undefined, { guess: true, guessed: null, fallback: "gbk" }).encoding,
    "gbk",
  );
  assert.equal(
    decodeFile(sjis, undefined, { guess: true, guessed: "utf-8" }).encoding,
    "windows-1252",
  );
  // Without guessing the guess is ignored.
  assert.equal(decodeFile(sjis, undefined, { guessed: "shift_jis" }).notUtf8, true);
});

test("utf8Again: a read-only file rewritten as UTF-8 reads as UTF-8 (D218)", () => {
  assert.deepEqual(utf8Again(encode("café")), { text: "café", encoding: "utf8", hadBom: false });
  assert.deepEqual(utf8Again(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])), {
    text: "a",
    encoding: "utf8bom",
    hadBom: true,
  });
  // UTF-16 with its BOM.
  assert.deepEqual(utf8Again(new Uint8Array([0xff, 0xfe, 0x61, 0x00])), {
    text: "a",
    encoding: "utf16le",
    hadBom: true,
  });
  // Still not UTF-8 (Latin-1 "café"), or binary now: no.
  assert.equal(utf8Again(new Uint8Array([0x63, 0x61, 0x66, 0xe9])), null);
  assert.equal(utf8Again(new Uint8Array([0x61, 0x00, 0x62])), null);
});

test("decodeFile + encodeWith: a closed file edited on disk keeps its BOM and UTF-16", () => {
  const files = [
    encode("plain"),
    new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x62]),
    new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x62, 0x00]),
    new Uint8Array([0xfe, 0xff, 0x00, 0x61, 0x00, 0x62]),
  ];
  for (const bytes of files) {
    const disk = decodeFile(bytes);
    assert.ok(!disk.binary && !disk.notUtf8);
    assert.deepEqual(encodeWith(disk.text, disk.encoding), bytes);
  }
});

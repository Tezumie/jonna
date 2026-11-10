import assert from "node:assert/strict";
import { test } from "node:test";
import {
  badgeOf,
  decodeText,
  isBigPaste,
  MAX_TEXT_CHARS,
  previewOf,
  sentAttachment,
  textUpload,
  uploadBytes,
  uploadContext,
  uploadFileName,
} from "./attachments";

test("attachments: big pastes, binary detection, previews", () => {
  assert.ok(!isBigPaste("short"));
  assert.ok(isBigPaste("x".repeat(1500)));
  assert.ok(isBigPaste("a\n".repeat(15)));
  const enc = new TextEncoder();
  assert.equal(decodeText(enc.encode("﻿hello")), "hello");
  assert.equal(decodeText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2])), null);
  assert.equal(decodeText(new Uint8Array(200).fill(0xff)), null);
  assert.equal(
    previewOf("# Title\n\n==================\n------------\n\nBody text\n"),
    "# Title\n======\nBody text",
  );
});

test("attachments: context, sent record, badges", () => {
  const big = textUpload("notes.md", "a ``` b\nline 2");
  assert.equal(big.lines, 2);
  assert.equal(uploadContext(big), "Attached file notes.md:\n````\na ``` b\nline 2\n````");
  const pasted = textUpload("Pasted text", "x".repeat(MAX_TEXT_CHARS + 5), true);
  assert.ok(pasted.truncated);
  assert.match(uploadContext(pasted) ?? "", /^Pasted text \(truncated\):/);
  assert.deepEqual(sentAttachment(big), {
    kind: "text",
    name: "notes.md",
    preview: "a ``` b\nline 2",
    text: "a ``` b\nline 2",
    lines: 2,
  });
  assert.equal(badgeOf({ kind: "text", name: "x", pasted: true }), "PASTED");
  assert.equal(badgeOf({ kind: "image", name: "art.PNG" }), "PNG");
  assert.equal(badgeOf({ kind: "text", name: "Makefile" }), "FILE");
  assert.equal(badgeOf({ kind: "text", name: "a.typescript" }), "TYPESC");
});

test("uploads saved into the project: names and bytes", () => {
  assert.equal(
    uploadFileName({ kind: "image", name: "Screenshot", data: "data:image/jpeg;base64,AA==" }),
    "Screenshot.jpg",
  );
  assert.equal(uploadFileName({ kind: "image", name: "a/b/shot.png", data: "x" }), "shot.png");
  assert.equal(
    uploadFileName({ kind: "text", name: "Pasted text", data: "x", pasted: true }),
    "pasted.txt",
  );
  assert.equal(uploadFileName({ kind: "text", name: 'no:te?"s', data: "x" }), "notes.txt");
  assert.deepEqual(
    [...uploadBytes({ kind: "image", data: "data:image/png;base64,AAEC" })],
    [0, 1, 2],
  );
  assert.deepEqual([...uploadBytes({ kind: "text", data: "é" })], [195, 169]);
});

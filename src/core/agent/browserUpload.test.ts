import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptMatches,
  describeFiles,
  mimeType,
  planTransfer,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_FILES,
  uploadSources,
} from "./browserUpload";

test("D339: upload sources from files and screenshot ids, in order", () => {
  assert.deepEqual(uploadSources({ files: ["a.png", " b.txt "], screenshot: "shot2" }), [
    { kind: "path", path: "a.png" },
    { kind: "path", path: "b.txt" },
    { kind: "screenshot", id: "shot2" },
  ]);
  assert.deepEqual(uploadSources({ files: "one.pdf" }), [{ kind: "path", path: "one.pdf" }]);
  assert.throws(() => uploadSources({}), /files/);
  assert.throws(
    () => uploadSources({ files: Array.from({ length: UPLOAD_MAX_FILES + 1 }, (_, i) => `${i}`) }),
    /at most/,
  );
});

test("D339: MIME types as browsers give them", () => {
  assert.equal(mimeType("Photo.JPG"), "image/jpeg");
  assert.equal(mimeType("notes.txt"), "text/plain");
  assert.equal(mimeType("Makefile"), "");
  assert.equal(mimeType("archive.unknownext"), "");
});

test("D339: accept lists match extensions, wildcards and exact types", () => {
  const png = { name: "a.png", type: "image/png" };
  assert.equal(acceptMatches(undefined, png), true);
  assert.equal(acceptMatches("", png), true);
  assert.equal(acceptMatches("image/*", png), true);
  assert.equal(acceptMatches(".pdf, .PNG", png), true);
  assert.equal(acceptMatches("image/jpeg", png), false);
  assert.equal(acceptMatches("video/*,.txt", png), false);
});

test("D339: the DataTransfer plan: input or drop, one or several, notes on accept", () => {
  const a = { name: "a.png", type: "image/png", size: 1000 };
  const b = { name: "b.txt", type: "text/plain", size: 20 };
  const input = { kind: "input" as const, label: 'input "Photo" [ref=e3]', accept: "image/*" };
  assert.deepEqual(planTransfer(input, [a]), { mode: "input", files: [a], notes: [] });
  const one = planTransfer(input, [a, b]);
  assert.ok("error" in one && /takes one file/.test(one.error));
  const several = planTransfer({ ...input, multiple: true }, [a, b]);
  assert.ok("mode" in several && several.mode === "input");
  assert.ok(
    "notes" in several && several.notes.length === 1 && /b\.txt/.test(several.notes[0] ?? ""),
  );
  const disabled = planTransfer({ ...input, disabled: true }, [a]);
  assert.ok("error" in disabled && /disabled/.test(disabled.error));
  assert.deepEqual(planTransfer({ kind: "drop", label: "div" }, [a, b]), {
    mode: "drop",
    files: [a, b],
    notes: [],
  });
  const big = planTransfer({ kind: "drop", label: "div" }, [{ ...a, size: UPLOAD_MAX_BYTES + 1 }]);
  assert.ok("error" in big && /more than/.test(big.error));
  assert.ok("error" in planTransfer(input, []));
  assert.equal(describeFiles([a, { ...b, size: 3 * 1024 * 1024 }]), "a.png (1 KB), b.txt (3.0 MB)");
});

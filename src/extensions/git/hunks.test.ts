import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitIpc } from "../../core/ipc/git";
import type { WorkbenchServices } from "../../workbench/services";
import { decodeUtf8Strict, lostCharacters, revertWorkingChange, stageChange } from "./hunks";

const LOST = String.fromCharCode(0xfffd);

test("bytes that aren't UTF-8 are refused, not decoded with replacements", () => {
  assert.equal(decodeUtf8Strict(new TextEncoder().encode("café")), "café");
  // Windows-1252 "café": 0xE9 alone is not UTF-8.
  assert.equal(decodeUtf8Strict(new Uint8Array([0x63, 0x61, 0x66, 0xe9])), null);
});

test("git's text with characters lost is told from a file that holds U+FFFD itself", () => {
  assert.equal(lostCharacters(`caf${LOST}\n`, "café\n"), true);
  assert.equal(lostCharacters(`caf${LOST}\n`, null), true);
  assert.equal(lostCharacters(`a${LOST}\n`, `a${LOST}\nb\n`), false);
  assert.equal(lostCharacters("plain\n", "plain\nmore\n"), false);
});

/** An open editor holding `buffer`, and a git whose index text is `index`. */
function setup(index: string, buffer: string) {
  const written: string[] = [];
  const buffers: string[] = [];
  const services = {
    quickDiff: {
      bufferText: () => buffer,
      writeBuffer: async (_path: string, text: string) => {
        buffers.push(text);
        return true;
      },
    },
  } as unknown as WorkbenchServices;
  const ipc = {
    show: async () => index,
    writeIndex: async (_path: string, text: string) => {
      written.push(text);
    },
  } as unknown as GitIpc;
  return { services, ipc, written, buffers };
}

test("one change of a file that isn't UTF-8 is neither staged nor reverted", async () => {
  // The editor read the file in its own encoding; git's text of it is lossy.
  const t = setup(`caf${LOST}\nb\n`, "café\nB\n");
  await assert.rejects(stageChange(t.services, "/w/a.txt", 2, t.ipc), /isn't UTF-8/);
  await assert.rejects(revertWorkingChange(t.services, "/w/a.txt", 2, t.ipc), /isn't UTF-8/);
  assert.deepEqual(t.written, []);
  assert.deepEqual(t.buffers, []);
});

test("a UTF-8 file's change is staged and reverted as before", async () => {
  const t = setup("café\nb\n", "café\nB\n");
  await stageChange(t.services, "/w/a.txt", 2, t.ipc);
  assert.deepEqual(t.written, ["café\nB\n"]);
  await revertWorkingChange(t.services, "/w/a.txt", 2, t.ipc);
  assert.deepEqual(t.buffers, ["café\nb\n"]);
});

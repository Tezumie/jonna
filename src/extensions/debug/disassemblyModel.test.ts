import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addressValue,
  DisassemblyModel,
  instructionLine,
  MAX_ROWS,
  mergeInstructions,
  rowOf,
} from "./disassemblyModel";
import type { Instruction } from "./session";

const ins = (n: number, text = `op${n}`): Instruction => ({
  address: `0x${n.toString(16)}`,
  instruction: text,
});

/** A fake debugger: 4-byte instructions from 0x1000 to 0x2000; outside, "??" placeholders. */
const memory =
  (calls: [string, number, number][]) => async (ref: string, offset: number, count: number) => {
    calls.push([ref, offset, count]);
    const base = Number(addressValue(ref) ?? 0n) / 4 + offset;
    return Array.from({ length: count }, (_, i) => {
      const n = (base + i) * 4;
      return n < 0x1000 || n >= 0x2000
        ? { address: `0x${n.toString(16)}`, instruction: "??" }
        : ins(n);
    });
  };

test("instructions merge by address, sorted, placeholders and bad addresses out", () => {
  assert.equal(addressValue("0x10"), 16n);
  assert.equal(addressValue("main+4"), null);
  const merged = mergeInstructions(
    [ins(8), ins(4)],
    [
      ins(8, "newer"),
      { address: "??", instruction: "x" },
      { address: "0xc", instruction: "??" },
      ins(0),
    ],
  );
  assert.deepEqual(
    merged.map((i) => [i.address, i.instruction]),
    [
      ["0x0", "op0"],
      ["0x4", "op4"],
      ["0x8", "newer"],
    ],
  );
  assert.equal(rowOf(merged, "0x0004"), 1);
  assert.equal(rowOf(merged, "0x99"), -1);
  const many = Array.from({ length: MAX_ROWS + 10 }, (_, i) => ins(i * 4));
  assert.equal(mergeInstructions([], many, "end")[0]?.address, ins(40).address);
  assert.equal(mergeInstructions([], many, "start").length, MAX_ROWS);
  assert.match(
    instructionLine({ ...ins(4), symbol: "main", path: "/a/b.c", line: 3 }, true),
    /^=> 0x4 .*op4 {4}; main {4}; b\.c:3$/,
  );
});

test("the model opens around an address and grows at both ends until memory ends", async () => {
  const calls: [string, number, number][] = [];
  const m = new DisassemblyModel(memory(calls));
  await m.open("0x1010", 8);
  assert.deepEqual(calls[0], ["0x1010", -2, 8]);
  assert.equal(m.rows[0]?.address, "0x1008");
  assert.equal(m.rows.length, 8);
  assert.equal(await m.loadBefore(4), 2);
  assert.equal(m.rows[0]?.address, "0x1000");
  // Nothing more before: not asked again.
  assert.equal(await m.loadBefore(4), 0);
  const asked = calls.length;
  assert.equal(await m.loadBefore(4), 0);
  assert.equal(calls.length, asked);
  assert.equal(await m.loadAfter(4), 4);
  assert.equal(m.rows.at(-1)?.address, "0x1034");
  assert.deepEqual(calls.at(-1), ["0x1024", 1, 4]);
  assert.equal(m.moveTo("0x1014"), true);
  assert.equal(m.moveTo("0x5000"), false);
});

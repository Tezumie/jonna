import assert from "node:assert/strict";
import { test } from "node:test";
import { changedRect, delaysCs, GifWriter, lzwEncode, quantize, tableBits } from "./gif";

/** A GIF LZW decoder (the reading side), to check the encoder round-trips. */
function lzwDecode(data: Uint8Array, minCodeSize: number): number[] {
  // Sub-blocks → one byte stream.
  const bytes: number[] = [];
  for (let at = 0; data[at]; ) {
    const n = data[at] ?? 0;
    for (let i = 1; i <= n; i++) bytes.push(data[at + i] ?? 0);
    at += n + 1;
  }
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  let size = minCodeSize + 1;
  let table: number[][] = [];
  const resetTable = () => {
    table = [];
    for (let i = 0; i < clear; i++) table.push([i]);
    table.push([], []);
    size = minCodeSize + 1;
  };
  resetTable();
  const out: number[] = [];
  let bit = 0;
  let prev: number[] | null = null;
  for (;;) {
    let code = 0;
    for (let i = 0; i < size; i++, bit++) code |= (((bytes[bit >> 3] ?? 0) >> (bit & 7)) & 1) << i;
    if (code === clear) {
      resetTable();
      prev = null;
      continue;
    }
    if (code === end) break;
    let entry: number[];
    if (code < table.length) entry = table[code] ?? [];
    else if (prev) entry = [...prev, prev[0] ?? 0];
    else throw new Error(`bad code ${code}`);
    out.push(...entry);
    if (prev && table.length < 4096) table.push([...prev, entry[0] ?? 0]);
    if (table.length === 1 << size && size < 12) size++;
    prev = entry;
  }
  return out;
}

test("D340: a 2×2 GIF has the exact bytes of the format", () => {
  const rgba = Uint8Array.from([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
  ]);
  const gif = new GifWriter(2, 2);
  assert.equal(gif.add(rgba, 0), true);
  const bytes = gif.finish(1000);
  const expected = [
    // GIF89a, 2×2, no global table, 8-bit color resolution.
    0x47,
    0x49,
    0x46,
    0x38,
    0x39,
    0x61,
    2,
    0,
    2,
    0,
    0x70,
    0,
    0,
    // NETSCAPE2.0, loop forever.
    0x21,
    0xff,
    0x0b,
    ...[..."NETSCAPE2.0"].map((c) => c.charCodeAt(0)),
    3,
    1,
    0,
    0,
    0,
    // Graphic control: keep, 100 cs.
    0x21,
    0xf9,
    4,
    4,
    100,
    0,
    0,
    0,
    // Image 0,0 2×2 with a 4-color local table.
    0x2c,
    0,
    0,
    0,
    0,
    2,
    0,
    2,
    0,
    0x81,
    255,
    0,
    0,
    0,
    255,
    0,
    0,
    0,
    255,
    255,
    255,
    255,
    // LZW: min code size 2; clear, 0, 1, 2 (3 bits), 3, end (4 bits).
    2,
    3,
    0x44,
    0x34,
    0x05,
    0,
    0x3b,
  ];
  assert.deepEqual([...bytes], expected);
});

test("D340: LZW round-trips through table clears and code size changes", () => {
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  for (const [minCodeSize, n, colors] of [
    [8, 60000, 256],
    [2, 5000, 4],
    [4, 3000, 3],
  ] as const) {
    // Runs and noise: both long matches and a full table.
    const indices = new Uint8Array(n);
    for (let i = 0; i < n; i++) indices[i] = i % 1000 < 500 ? (i >> 6) % colors : random() % colors;
    assert.deepEqual(lzwDecode(lzwEncode(indices, minCodeSize), minCodeSize), [...indices]);
  }
  assert.deepEqual(lzwDecode(lzwEncode(new Uint8Array(0), 2), 2), []);
  assert.deepEqual(lzwDecode(lzwEncode(Uint8Array.from([1]), 2), 2), [1]);
});

test("D340: quantize keeps few colors exactly and cuts many to 256", () => {
  const few = Uint8Array.from([1, 2, 3, 255, 1, 2, 3, 255, 9, 9, 9, 255]);
  const q = quantize(few);
  assert.deepEqual([...q.colors], [1, 2, 3, 9, 9, 9]);
  assert.deepEqual([...q.indices], [0, 0, 1]);
  // A gradient of 4096 colors.
  const many = new Uint8Array(4096 * 4);
  for (let i = 0; i < 4096; i++)
    many.set([(i & 15) * 17, ((i >> 4) & 15) * 17, (i >> 8) * 17, 255], i * 4);
  const m = quantize(many);
  assert.equal(m.colors.length, 256 * 3);
  // Every pixel maps to a palette color near it.
  for (let i = 0; i < 4096; i += 37) {
    const at = (m.indices[i] ?? 0) * 3;
    for (let c = 0; c < 3; c++)
      assert.ok(Math.abs((m.colors[at + c] ?? 0) - (many[i * 4 + c] ?? 0)) <= 40, `pixel ${i}`);
  }
  assert.equal(tableBits(1), 1);
  assert.equal(tableBits(2), 1);
  assert.equal(tableBits(3), 2);
  assert.equal(tableBits(256), 8);
});

test("D340: later frames are only what changed, identical ones are skipped", () => {
  const w = 4;
  const h = 3;
  const a = new Uint8Array(w * h * 4).fill(200);
  const b = Uint8Array.from(a);
  b.set([0, 0, 0, 255], (1 * w + 2) * 4);
  b.set([0, 0, 0, 255], (2 * w + 1) * 4);
  assert.deepEqual(changedRect(a, b, w, h), { x: 1, y: 1, w: 2, h: 2 });
  assert.equal(changedRect(a, a, w, h), null);
  const gif = new GifWriter(w, h);
  assert.equal(gif.add(a, 0), true);
  assert.equal(gif.add(a, 500), false);
  assert.equal(gif.add(b, 800), true);
  assert.equal(gif.frameCount, 2);
  const bytes = gif.finish(2000);
  // The second image descriptor: at (1, 1), 2×2.
  const second = [...bytes].findIndex(
    (v, i) => i > 40 && v === 0x2c && bytes[i + 1] === 1 && bytes[i + 3] === 1,
  );
  assert.ok(second > 0);
  assert.deepEqual([...bytes.subarray(second + 5, second + 9)], [2, 0, 2, 0]);
  assert.equal(bytes[bytes.length - 1], 0x3b);
  assert.throws(() => gif.add(new Uint8Array(4), 900), /4×3/);
});

test("D340: frame delays in hundredths, at least 2", () => {
  assert.deepEqual(delaysCs([0, 1000, 1005], 2500), [100, 2, 150]);
});

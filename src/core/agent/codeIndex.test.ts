import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chunkText,
  dequantize,
  indexable,
  planUpdate,
  quantize,
  type StoredIndex,
  searchIndex,
  textHash,
} from "./codeIndex";

test("indexable: source files, not dependencies or generated files", () => {
  assert.ok(indexable("src/app.ts"));
  assert.ok(indexable("README.md"));
  assert.ok(!indexable("node_modules/x/index.js"));
  assert.ok(!indexable("web/dist/app.js"));
  assert.ok(!indexable("app.min.js"));
  assert.ok(!indexable("package-lock.json"));
  assert.ok(!indexable("logo.png"));
});

test("chunkText: overlapping windows, blank-only skipped, lines 1-based", () => {
  const text = Array.from({ length: 150 }, (_, i) => (i % 25 === 24 ? "" : `line ${i + 1}`)).join(
    "\n",
  );
  const chunks = chunkText(text);
  assert.ok(chunks.length >= 3);
  assert.equal(chunks[0]?.start, 1);
  assert.equal(chunks.at(-1)?.end, 150);
  for (let i = 1; i < chunks.length; i++)
    assert.ok((chunks[i]?.start ?? 0) <= (chunks[i - 1]?.end ?? 0), "chunks overlap");
  // A window ends after a blank line when one is near its end.
  assert.equal(chunks[0]?.end, 50);
  assert.deepEqual(chunkText("\n\n  \n"), []);
});

test("quantize round-trips to a unit vector pointing the same way", () => {
  const v = [0.1, -0.5, 0.3, 0.8, 0, -0.2, 0.05];
  const back = dequantize(quantize(v));
  assert.equal(back.length, v.length);
  const norm = Math.hypot(...v);
  let dot = 0;
  for (let i = 0; i < v.length; i++) dot += (back[i] ?? 0) * ((v[i] ?? 0) / norm);
  assert.ok(dot > 0.999, `cosine ${dot}`);
});

test("searchIndex: closest chunks first, a few per file", () => {
  const idx: StoredIndex = {
    version: 1,
    model: "m",
    root: "/w",
    files: {
      "a.ts": {
        hash: "1",
        chunks: [
          { start: 1, end: 10, v: quantize([1, 0, 0]) },
          { start: 11, end: 20, v: quantize([0.9, 0.1, 0]) },
        ],
      },
      "b.ts": { hash: "2", chunks: [{ start: 1, end: 5, v: quantize([0, 1, 0]) }] },
    },
  };
  const q = dequantize(quantize([1, 0.05, 0]));
  const hits = searchIndex(idx, new Map(), q, 10, 1);
  assert.deepEqual(
    hits.map((h) => [h.path, h.start]),
    [
      ["a.ts", 1],
      ["b.ts", 1],
    ],
  );
});

test("planUpdate: changed and new files embedded, gone files dropped", () => {
  const idx: StoredIndex = {
    version: 1,
    model: "m",
    root: "/w",
    files: { "a.ts": { hash: textHash("a"), chunks: [] }, "gone.ts": { hash: "x", chunks: [] } },
  };
  const now = new Map([
    ["a.ts", textHash("a")],
    ["b.ts", textHash("b")],
  ]);
  assert.deepEqual(planUpdate(idx, now), { embed: ["b.ts"], drop: ["gone.ts"] });
  assert.deepEqual(planUpdate(null, now).embed, ["a.ts", "b.ts"]);
  assert.notEqual(textHash("ab"), textHash("ba"));
});

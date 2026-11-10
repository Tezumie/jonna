import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentFace,
  encodeFace,
  FACE_COLORS,
  FACE_EYES,
  FACE_SHAPES,
  faceFromSeed,
  faceSvg,
  isModelIcon,
  parseFace,
  randomFace,
} from "./faces";

test("faces: a name always gets the same face, and names spread over shapes and colors", () => {
  assert.deepEqual(faceFromSeed("reviewer"), faceFromSeed("Reviewer "));
  const faces = ["reviewer", "tester", "docs", "scout", "forge", "atlas", "pulse", "chief"].map(
    faceFromSeed,
  );
  assert.ok(new Set(faces.map((f) => f.shape)).size >= 3);
  assert.ok(new Set(faces.map((f) => f.color)).size >= 3);
  for (const f of faces) {
    assert.ok(FACE_SHAPES.includes(f.shape));
    assert.ok(FACE_EYES.includes(f.eyes));
    assert.ok(f.color >= 1 && f.color <= FACE_COLORS);
  }
});

test("faces: codes round-trip, and a bad code falls back to the name's face", () => {
  const face = { shape: "blob", color: 3, eyes: "wink" } as const;
  assert.equal(encodeFace(face), "blob-3-wink");
  assert.deepEqual(parseFace("blob-3-wink"), face);
  assert.deepEqual(parseFace(" Blob-3-Wink "), face);
  for (const bad of ["blob-9-dots", "blob-0-dots", "star-1-dots", "blob-1-lasers", "", null])
    assert.equal(parseFace(bad), null);
  assert.deepEqual(agentFace("nonsense", "tester"), faceFromSeed("tester"));
  assert.deepEqual(agentFace("peak-2-happy", "tester"), {
    shape: "peak",
    color: 2,
    eyes: "happy",
  });
});

test("faces: no icon, or `model`, shows the model's logo with the name's face kept (D270)", () => {
  assert.deepEqual(agentFace(undefined, "builder"), { ...faceFromSeed("builder"), model: "" });
  assert.deepEqual(agentFace(" Model ", "builder", "acp/codex"), {
    ...faceFromSeed("builder"),
    model: "acp/codex",
  });
  assert.equal(agentFace("blob-1-dots", "builder", "acp/codex").model, undefined);
  assert.ok(isModelIcon("") && isModelIcon("model") && !isModelIcon("blob-1-dots"));
});

test("faces: randomize changes the shape or the color", () => {
  let n = 0;
  const seq = [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.9, 0.9, 0.5];
  const random = () => seq[n++ % seq.length] ?? 0;
  const current = { shape: "round", color: 1, eyes: "dots" } as const;
  const next = randomFace(current, random);
  assert.ok(next.shape !== current.shape || next.color !== current.color);
  // Even a source that always repeats itself moves on.
  const stuck = randomFace(current, () => 0);
  assert.ok(stuck.shape !== current.shape || stuck.color !== current.color);
});

test("faces: SVG uses theme tokens only, with the eyes in their own group", () => {
  for (const shape of FACE_SHAPES)
    for (const eyes of FACE_EYES) {
      const svg = faceSvg({ shape, color: 4, eyes }, 20);
      assert.match(svg, /fill="var\(--face-4\)"/);
      assert.match(svg, /class="face-eyes"/);
      assert.match(svg, /width="20"/);
      assert.doesNotMatch(svg, /#[0-9a-f]{3,6}\b|rgb\(/i);
    }
});

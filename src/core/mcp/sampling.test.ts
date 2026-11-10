// D207: sampling with images, and the review of the answer.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hintAllowed,
  readSamplingRequest,
  reviewedResult,
  SAMPLING_MAX_PROMPT_CHARS,
  samplingAudio,
  samplingContentProblem,
  samplingImageCount,
  samplingPreview,
  samplingResult,
  samplingSizeProblem,
  toChatMessages,
} from "./sampling";

const request = (content: unknown, role = "user") => {
  const r = readSamplingRequest({ messages: [{ role, content }] });
  assert.ok(r);
  return r;
};

test("a user message's PNG or JPEG goes to the model as an image", () => {
  const r = request([
    { type: "text", text: "What is this?" },
    { type: "image", mimeType: "image/png", data: "iVBORw0" },
    { type: "image", mimeType: "image/jpeg", data: "/9j/4A" },
  ]);
  assert.deepEqual(toChatMessages(r), [
    { role: "user", content: "What is this?", images: ["iVBORw0", "/9j/4A"] },
  ]);
  assert.equal(samplingImageCount(r), 2);
  assert.equal(samplingContentProblem(r, true), null);
  assert.match(samplingContentProblem(r, false) ?? "", /doesn't read images/);
  assert.match(samplingPreview(r), /\[image image\/png\]/);
});

test("other content is refused, saying why", () => {
  assert.match(
    samplingContentProblem(request({ type: "audio", mimeType: "audio/wav", data: "x" }), true) ??
      "",
    /audio needs speech to text/,
  );
  assert.match(
    samplingContentProblem(request({ type: "video", mimeType: "video/mp4", data: "x" }), true) ??
      "",
    /video content isn't supported/,
  );
  assert.match(
    samplingContentProblem(request({ type: "image", mimeType: "image/gif", data: "x" }), true) ??
      "",
    /image\/gif images aren't supported/,
  );
  assert.match(
    samplingContentProblem(
      request({ type: "image", mimeType: "image/png", data: "x" }, "assistant"),
      true,
    ) ?? "",
    /assistant/,
  );
  assert.equal(samplingContentProblem(request({ type: "text", text: "hi" }), false), null);
  assert.equal(samplingImageCount(request({ type: "text", text: "hi" })), 0);
});

test("a reviewed answer is sent as it is, edited, or not at all", () => {
  const result = samplingResult("The answer", "m");
  assert.equal(reviewedResult(result, { action: "send" }), result);
  assert.equal(reviewedResult(result, { action: "send", text: "The answer" }), result);
  assert.deepEqual(reviewedResult(result, { action: "send", text: "Edited" }), {
    ...result,
    content: { type: "text", text: "Edited" },
  });
  assert.equal(reviewedResult(result, { action: "reject" }), null);
});

// D223: audio through speech to text, a size cap, and model hints that can't cost more unasked.
test("audio in a user message is transcribed and sent as text", () => {
  const r = request([
    { type: "text", text: "Summarize" },
    { type: "audio", mimeType: "audio/mpeg", data: "SUQz" },
  ]);
  assert.equal(samplingContentProblem(r, false, true), null);
  const audio = samplingAudio(r);
  assert.equal(audio.length, 1);
  const first = audio[0];
  assert.ok(first);
  assert.deepEqual(toChatMessages(r, new Map([[first, "hello there"]])), [
    { role: "user", content: "Summarize\n[audio, transcribed]: hello there" },
  ]);
  assert.match(
    samplingContentProblem(
      request({ type: "audio", mimeType: "audio/x-foo", data: "x" }),
      true,
      true,
    ) ?? "",
    /audio\/x-foo audio isn't supported/,
  );
  assert.match(
    samplingContentProblem(
      request({ type: "audio", mimeType: "audio/wav", data: "x" }, "assistant"),
      true,
      true,
    ) ?? "",
    /assistant/,
  );
});

test("a prompt over the size cap is refused", () => {
  assert.equal(samplingSizeProblem(request({ type: "text", text: "short" })), null);
  assert.match(
    samplingSizeProblem(
      request({ type: "text", text: "x".repeat(SAMPLING_MAX_PROMPT_CHARS + 1) }),
    ) ?? "",
    /at most 200k/,
  );
  const big = readSamplingRequest({
    systemPrompt: "y".repeat(SAMPLING_MAX_PROMPT_CHARS),
    messages: [{ role: "user", content: { type: "text", text: "and more" } }],
  });
  assert.ok(big);
  assert.notEqual(samplingSizeProblem(big), null);
});

test("unasked, a model hint only picks a model that costs no more", () => {
  const cheap = { key: "a/mini", local: false, price: { input: 0.2, output: 0.8 } };
  const dear = { key: "a/big", local: false, price: { input: 15, output: 75 } };
  const local = { key: "ollama/qwen", local: true };
  const unpriced = { key: "x/unknown", local: false };
  // Asked: the user sees the model.
  assert.equal(hintAllowed(dear, cheap, true), true);
  assert.equal(hintAllowed(dear, cheap, false), false);
  assert.equal(hintAllowed(cheap, dear, false), true);
  assert.equal(hintAllowed(local, dear, false), true);
  // Never a paid model instead of a free one, nor one with no known price.
  assert.equal(hintAllowed(cheap, local, false), false);
  assert.equal(hintAllowed(unpriced, dear, false), false);
  assert.equal(hintAllowed(dear, dear, false), true);
});

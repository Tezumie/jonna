import assert from "node:assert/strict";
import { test } from "node:test";
import { brandPresetFor, presetFor } from "./catalog";
import { imageDataUrl, isImageDataUrl, MAX_IMAGE_BYTES } from "./providerImage";
import {
  matchPresets,
  normalizeName,
  presetForName,
  presetForUrl,
  stripFiller,
} from "./providerMatch";
import { PROVIDER_PRESETS } from "./providerPresets";

const top = (q: string) => matchPresets(q)[0]?.preset.id;

test("providerPresets: about twenty, unique ids, every hosted one has a key link (D212)", () => {
  const ids = PROVIDER_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(PROVIDER_PRESETS.length >= 20, `${PROVIDER_PRESETS.length}`);
  for (const p of PROVIDER_PRESETS) {
    if (p.needsKey) assert.ok(p.keyHint, p.id);
    if (!p.editAddress) assert.match(p.baseUrl, /^https?:\/\/\S+$/, p.id);
  }
  // The first rows are the ones the page always had.
  assert.deepEqual(
    PROVIDER_PRESETS.filter((p) => p.featured).map((p) => p.id),
    ["anthropic", "openai", "gemini", "xai", "openrouter", "groq", "lmstudio", "llamacpp"],
  );
});

test("normalizeName / stripFiller", () => {
  assert.equal(normalizeName("Together AI"), "togetherai");
  assert.equal(normalizeName("llama.cpp server"), "llamacppserver");
  assert.equal(stripFiller("groqai"), "groq");
  assert.equal(stripFiller("togetheraiapi"), "together");
  // Short names keep their letters: xAI and Z.ai aren't "x" and "z".
  assert.equal(stripFiller("xai"), "xai");
  assert.equal(stripFiller("zai"), "zai");
});

test("matchPresets: what people type finds the preset (D212)", () => {
  assert.equal(top("groqai"), "groq");
  assert.equal(top("Groq AI"), "groq");
  assert.equal(top("groqcloud"), "groq");
  assert.equal(top("together"), "together");
  assert.equal(top("togetherai"), "together");
  assert.equal(top("toge"), "together");
  assert.equal(top("mistral"), "mistral");
  assert.equal(top("deepseek api"), "deepseek");
  assert.equal(top("deepsek"), "deepseek"); // a typo
  assert.equal(top("huggingface"), "huggingface");
  assert.equal(top("hf"), "huggingface");
  assert.equal(top("kimi"), "moonshot");
  assert.equal(top("moonshot"), "moonshot");
  assert.equal(top("zhipu"), "zai");
  assert.equal(top("glm"), "zai");
  assert.equal(top("dashscope"), "qwen");
  assert.equal(top("grok"), "xai");
  assert.equal(top("claude"), "anthropic");
  assert.equal(top("nim"), "nvidia");
  assert.equal(top("aws"), "bedrock");
  assert.equal(top("vllm"), "vllm");
  assert.equal(top("lm studio"), "lmstudio");
  assert.equal(top("llama.cpp"), "llamacpp");
  // "openai": OpenAI first, Azure OpenAI after it.
  const openai = matchPresets("openai").map((m) => m.preset.id);
  assert.equal(openai[0], "openai");
  assert.ok(openai.includes("azure"));
});

test("matchPresets: nothing for a name of your own or one letter", () => {
  assert.deepEqual(matchPresets("g"), []);
  assert.deepEqual(matchPresets(""), []);
  assert.deepEqual(matchPresets("My office box"), []);
  assert.deepEqual(matchPresets("qqqqq"), []);
  assert.ok(matchPresets("o", PROVIDER_PRESETS, 5).length === 0);
  assert.ok(matchPresets("a", PROVIDER_PRESETS).length === 0);
  assert.ok(matchPresets("op").length <= 5);
});

test("presetForName: only a clear match", () => {
  assert.equal(presetForName("Groq")?.id, "groq");
  assert.equal(presetForName("groqai")?.id, "groq");
  assert.equal(presetForName("Together AI")?.id, "together");
  assert.equal(presetForName("Groq proxy"), undefined);
  assert.equal(presetForName("my server"), undefined);
  assert.equal(presetForName("gro"), undefined);
});

test("presetForUrl: a preset's host or a subdomain of it; never a local server (D212)", () => {
  assert.equal(presetForUrl("https://api.groq.com/openai/v1")?.id, "groq");
  assert.equal(presetForUrl("https://API.GROQ.COM")?.id, "groq");
  assert.equal(presetForUrl("https://api.together.ai/v1")?.id, "together");
  assert.equal(presetForUrl("https://my-res.openai.azure.com/openai/v1")?.id, "azure");
  assert.equal(presetForUrl("https://api.openai.com/v1")?.id, "openai");
  assert.equal(presetForUrl("https://bedrock-mantle.eu-west-1.api.aws/v1")?.id, "bedrock");
  assert.equal(presetForUrl("https://open.bigmodel.cn/api/paas/v4")?.id, "zai");
  assert.equal(presetForUrl("https://dashscope.aliyuncs.com/compatible-mode/v1")?.id, "qwen");
  assert.equal(presetForUrl("https://api.moonshot.cn/v1")?.id, "moonshot");
  assert.equal(presetForUrl("http://127.0.0.1:1234/v1"), undefined);
  assert.equal(presetForUrl("http://localhost:8000/v1"), undefined);
  assert.equal(presetForUrl("https://notgroq.com/v1"), undefined);
  assert.equal(presetForUrl("https://groq.com.evil.example/v1"), undefined);
  assert.equal(presetForUrl("not a url"), undefined);
});

test("presetFor / brandPresetFor: a hand-added provider gets its logo by host or name", () => {
  assert.equal(presetFor({ id: "mine", baseUrl: "https://api.groq.com/openai/v1" })?.id, "groq");
  assert.equal(presetFor({ id: "mine", baseUrl: "http://127.0.0.1:5000/v1" }), undefined);
  // Azure's base is the user's own: an empty preset address never matches an empty one.
  assert.equal(presetFor({ id: "mine", baseUrl: "" }), undefined);
  assert.equal(
    brandPresetFor({ id: "x", name: "Groq", baseUrl: "http://127.0.0.1:9000/v1" })?.id,
    "groq",
  );
  assert.equal(
    brandPresetFor({ id: "x", name: "Office box", baseUrl: "http://127.0.0.1:9000/v1" }),
    undefined,
  );
});

test("imageDataUrl: the type its name says, small, no scripts in an SVG (D212)", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const ok = imageDataUrl("C:\\Users\\me\\logo.PNG", png);
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.match(ok.dataUrl, /^data:image\/png;base64,/);
    assert.ok(isImageDataUrl(ok.dataUrl));
  }
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
  assert.ok(imageDataUrl("logo.svg", svg).ok);
  const evil = new TextEncoder().encode('<svg onload="alert(1)"></svg>');
  assert.equal(imageDataUrl("logo.svg", evil).ok, false);
  assert.equal(imageDataUrl("logo.png", svg).ok, false); // not a PNG inside
  assert.equal(imageDataUrl("logo.gif", png).ok, false);
  assert.equal(imageDataUrl("logo.png", new Uint8Array(0)).ok, false);
  const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
  big.set(png);
  const tooBig = imageDataUrl("logo.png", big);
  assert.equal(tooBig.ok, false);
  if (!tooBig.ok) assert.match(tooBig.error, /256 KB/);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]);
  assert.ok(imageDataUrl("a.jpeg", jpeg).ok);
  const webp = new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ");
  assert.ok(imageDataUrl("a.webp", webp).ok);
  assert.equal(isImageDataUrl("data:text/html;base64,AAAA"), false);
  assert.equal(isImageDataUrl("javascript:alert(1)"), false);
});

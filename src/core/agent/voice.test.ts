import assert from "node:assert/strict";
import { test } from "node:test";
import { ON_DEVICE, pickVoiceProvider, splitSubmitWord, voiceRoute } from "./voice";

test("voice: Groq first, then OpenAI; a chosen provider needs a model unless known (D180)", () => {
  const providers = [
    { id: "anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com" },
    { id: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1" },
    { id: "groq", kind: "openai", baseUrl: "https://api.groq.com/openai/v1" },
    { id: "local", kind: "openai", baseUrl: "http://127.0.0.1:8000" },
  ];
  assert.deepEqual(pickVoiceProvider(providers, "", ""), {
    provider: providers[2],
    model: "whisper-large-v3-turbo",
  });
  assert.equal(pickVoiceProvider(providers.slice(0, 2), "", "")?.model, "gpt-4o-mini-transcribe");
  assert.equal(pickVoiceProvider(providers, "local", ""), null);
  assert.equal(pickVoiceProvider(providers, "local", "whisper-1")?.provider.id, "local");
  assert.equal(pickVoiceProvider(providers, "anthropic", "x"), null);
  assert.equal(pickVoiceProvider([providers[0] as (typeof providers)[number]], "", ""), null);
});

test("voice: a trailing submit word sends and comes off", () => {
  assert.deepEqual(splitSubmitWord("Fix the login bug, submit.", ["submit"]), {
    text: "Fix the login bug",
    submit: true,
  });
  assert.deepEqual(splitSubmitWord("Submit the form handler fix", ["submit"]), {
    text: "Submit the form handler fix",
    submit: false,
  });
  assert.equal(splitSubmitWord("ok send it!", ["send it"]).submit, true);
  assert.equal(splitSubmitWord("resubmit", ["submit"]).submit, false);
});

test("submit words in other alphabets", () => {
  assert.deepEqual(splitSubmitWord("Привет, отправить.", ["отправить"]), {
    text: "Привет",
    submit: true,
  });
  assert.deepEqual(splitSubmitWord("resubmit", ["submit"]), { text: "resubmit", submit: false });
});

test("voiceRoute: a downloaded model first, then a keyed service, else setup (D384)", () => {
  const pick = { provider: "groq", model: "whisper-large-v3-turbo" };
  // Automatic: nothing downloaded, a key → the service; nothing at all → setup.
  assert.deepEqual(voiceRoute({ chosen: "", pick, localModel: "base", installed: [] }), {
    kind: "provider",
    provider: "groq",
    model: "whisper-large-v3-turbo",
  });
  assert.deepEqual(voiceRoute({ chosen: "", pick: null, localModel: "base", installed: [] }), {
    kind: "setup",
    model: "base",
  });
  // A downloaded model wins over a key; another downloaded one stands in for the chosen size.
  assert.deepEqual(voiceRoute({ chosen: "", pick, localModel: "base", installed: ["base"] }), {
    kind: "local",
    model: "base",
  });
  assert.deepEqual(voiceRoute({ chosen: "", pick, localModel: "small", installed: ["base"] }), {
    kind: "local",
    model: "base",
  });
  // "device": only the chosen model, else setup (even with a key).
  assert.deepEqual(
    voiceRoute({ chosen: ON_DEVICE, pick, localModel: "small", installed: ["base"] }),
    {
      kind: "setup",
      model: "small",
    },
  );
  assert.deepEqual(
    voiceRoute({ chosen: ON_DEVICE, pick: null, localModel: "x", installed: ["base"] }),
    {
      kind: "local",
      model: "base",
    },
  );
  // A named provider: that one, or setup when it can't.
  assert.equal(
    voiceRoute({ chosen: "groq", pick, localModel: "base", installed: ["base"] }).kind,
    "provider",
  );
  assert.equal(
    voiceRoute({ chosen: "gone", pick: null, localModel: "base", installed: [] }).kind,
    "setup",
  );
});

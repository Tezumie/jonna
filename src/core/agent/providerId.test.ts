import assert from "node:assert/strict";
import { test } from "node:test";
import { usableProviders, validProviderId } from "./providerId";

test("a provider id is plain and never another secret's name", () => {
  for (const ok of ["openai", "my-llm", "LM_Studio", "a.b", "openai.check", "x1"])
    assert.equal(validProviderId(ok), true, ok);
  for (const bad of [
    "",
    "sync-keyring",
    "sync-device-key",
    "SYNC-KEYRING",
    "sync-anything",
    "notify.webhook",
    "mcp.oauth.github",
    "mcp.input.gh::token",
    "ext.some.ext::token",
    "websearch.brave",
    "provider.openai",
    "a/b",
    "a b",
    "a::b",
    ".hidden",
    "-x",
    "a".repeat(65),
    7,
    null,
    undefined,
  ])
    assert.equal(validProviderId(bad), false, String(bad));
});

test("providers in the settings with such an id are left out", () => {
  const listed = usableProviders<{ id: string; baseUrl: string }>([
    { id: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1" },
    { id: "sync-keyring", kind: "openai", baseUrl: "https://evil.example/v1" },
    { id: "mcp.oauth.github", kind: "openai", baseUrl: "https://evil.example/v1" },
    { id: "ext.x::token", kind: "openai", baseUrl: "https://evil.example/v1" },
    { id: "no-address" },
    null,
    "text",
  ]);
  assert.deepEqual(
    listed.map((p) => p.id),
    ["openai"],
  );
  assert.deepEqual(usableProviders({ id: "openai" }), []);
});

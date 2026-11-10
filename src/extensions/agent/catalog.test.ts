import assert from "node:assert/strict";
import { test } from "node:test";
import { ACP_PRESETS } from "./acpAgents";
import {
  AGENT_SETUP,
  connectError,
  PROVIDER_PRESETS,
  providerId,
  withoutProvider,
  withProvider,
} from "./catalog";

test("catalog: ids are unique, every agent preset has setup info (D164)", () => {
  const ids = PROVIDER_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const p of ACP_PRESETS) assert.ok(AGENT_SETUP[p.name], p.name);
});

test("withProvider / withoutProvider replace by id", () => {
  const list = withProvider([{ id: "a", baseUrl: "x" }], { id: "a", baseUrl: "y" });
  assert.deepEqual(list, [{ id: "a", baseUrl: "y" }]);
  assert.deepEqual(withoutProvider(list, "a"), []);
  assert.deepEqual(withProvider(null, { id: "b", baseUrl: "z" }), [{ id: "b", baseUrl: "z" }]);
  assert.equal(providerId("My Server!"), "my-server");
});

test("connectError: human reasons", () => {
  assert.match(connectError("HTTP 401: invalid x-api-key"), /rejected/);
  assert.match(connectError("error sending request: connection refused"), /reach/);
  assert.match(connectError("429 Too Many Requests"), /Rate/);
});

test("presetFor: by id, else by address (D169)", async () => {
  const { presetFor } = await import("./catalog");
  assert.equal(
    presetFor({ id: "openrouter-ai", baseUrl: "https://openrouter.ai/api/v1/" })?.id,
    "openrouter",
  );
  assert.equal(presetFor({ id: "openai", baseUrl: "http://x" })?.id, "openai");
  assert.equal(presetFor({ id: "mine", baseUrl: "http://127.0.0.1:5000/v1" }), undefined);
});

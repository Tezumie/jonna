import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, runSettings } from "./launch";

test("--settings: JSON text is read as an object", () => {
  assert.deepEqual(runSettings('{"agent.model": "ollama/qwen3:8b"}'), {
    "agent.model": "ollama/qwen3:8b",
  });
  assert.deepEqual(runSettings(undefined), {});
});

test("--settings: JSON that arrives with a shell's quotes on isn't echoed (it may hold a key)", () => {
  // cmd.exe keeps single quotes: the text doesn't start with "{", so it was taken for a path
  // and printed, by this tool and again in the system's own message.
  const typed = `'{"agent.providers":[{"id":"x","apiKey":"sk-secret-0123456789abcdef"}]}'`;
  assert.throws(
    () => runSettings(typed),
    (err: unknown) =>
      err instanceof ConfigError &&
      !err.message.includes("sk-secret") &&
      !err.message.includes("apiKey") &&
      /--settings takes a JSON object/.test(err.message),
  );
});

test("--settings: a file that isn't there is named", () => {
  assert.throws(
    () => runSettings("no-such-settings-file.json"),
    (err: unknown) =>
      err instanceof ConfigError && err.message.includes("no-such-settings-file.json"),
  );
});

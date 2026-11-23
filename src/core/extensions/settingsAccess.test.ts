import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canReadSetting,
  isSecretLikeSetting,
  matchesReadsSettings,
  parseReadsSettings,
  settingsStateForExtension,
} from "./settingsAccess";

test("parseReadsSettings: keys and prefix.* patterns; credentials' areas refused", () => {
  const errors: string[] = [];
  const list = parseReadsSettings(
    [
      "debug.pythonPath",
      "markdown.*",
      "agent.model",
      "ai.*",
      "mcp.servers",
      "accounts.github",
      "http.proxy",
      "git.apiKey",
      "github.token",
      "service.password",
      "*",
      "bad key",
      3,
      "markdown.*",
    ],
    errors,
  );
  assert.deepEqual(list, ["debug.pythonPath", "markdown.*"]);
  assert.equal(errors.length, 11);
  assert.deepEqual(parseReadsSettings(undefined, []), []);
  const e2: string[] = [];
  parseReadsSettings("markdown.*", e2);
  assert.equal(e2.length, 1);
  // A pattern whose prefix would cover a blocked area ("ai" covers "ai.") is refused; "a.*" isn't.
  const e3: string[] = [];
  assert.deepEqual(parseReadsSettings(["a.*", "ai"], e3), ["a.*"]);
  assert.equal(e3.length, 1);
});

test("isSecretLikeSetting: word matches, not substrings", () => {
  for (const k of ["x.apiKey", "x.api_key", "x.authToken", "x.secret", "x.privateKey", "y.passwd"])
    assert.ok(isSecretLikeSetting(k), k);
  for (const k of [
    "workbench.keybindings",
    "editor.monkeyPatch",
    "x.tokenizer",
    "debug.pythonPath",
  ])
    assert.ok(!isSecretLikeSetting(k), k);
});

test("canReadSetting: own, editor/workbench/files, readsSettings; never blocked or secret-like", () => {
  const own = ["acme.x.token", "acme.x.size"];
  const reads = ["debug.pythonPath", "markdown.*"];
  assert.ok(canReadSetting(own, reads, "acme.x.size"));
  // Its own setting, even named like a secret (it declared it).
  assert.ok(canReadSetting(own, reads, "acme.x.token"));
  assert.ok(canReadSetting(own, reads, "editor.fontSize"));
  assert.ok(canReadSetting(own, reads, "files.exclude"));
  assert.ok(canReadSetting(own, reads, "debug.pythonPath"));
  assert.ok(canReadSetting(own, reads, "markdown.preview.fontSize"));
  assert.ok(!canReadSetting(own, reads, "markdown.apiKey"));
  assert.ok(!canReadSetting(own, reads, "debug.other"));
  assert.ok(!canReadSetting(own, reads, "agent.model"));
  assert.ok(!canReadSetting(own, ["markdown.*"], "markdown"));
  assert.ok(matchesReadsSettings(["markdown.*"], "markdown.a"));
  assert.ok(!matchesReadsSettings(["markdown.*"], "markdownx.a"));
});

test("settingsStateForExtension: only readable settings, in every part of the state", () => {
  const readable = (key: string) => canReadSetting(["todo.tags"], [], key);
  const state = {
    files: { user: "/home/u/settings.json", workspace: null },
    settings: [
      { key: "editor.fontSize", value: 14 },
      { key: "todo.tags", value: ["TODO"] },
      { key: "lsp.servers", value: { pyright: { env: { API_KEY: "s3cret" } } } },
      { key: "agent.model", value: "m" },
      { key: "github.token", value: "t" },
      "… 3 more",
    ],
    languages: {
      python: { "editor.tabSize": 4, "http.proxy": "http://user:pass@host" },
      go: { "ai.model": "m" },
    },
    associations: { "*.foo": "json" },
    problems: [{ message: 'agent.model: "m" is not valid' }],
    folders: [{ name: "a", path: "/a", set: ["editor.tabSize", "mcp.servers", 3] }],
  };
  const seen = settingsStateForExtension(state, readable);
  assert.deepEqual(seen, {
    files: state.files,
    settings: [
      { key: "editor.fontSize", value: 14 },
      { key: "todo.tags", value: ["TODO"] },
    ],
    languages: { python: { "editor.tabSize": 4 } },
    associations: { "*.foo": "json" },
    folders: [{ name: "a", path: "/a", set: ["editor.tabSize"] }],
  });
  assert.ok(!JSON.stringify(seen).includes("s3cret"));
  // A state cut to its budget (or anything unexpected) gives nothing rather than everything.
  assert.deepEqual(settingsStateForExtension("truncated", readable), {
    settings: [],
    languages: {},
  });
});

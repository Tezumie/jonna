import assert from "node:assert/strict";
import { test } from "node:test";
import builtinServers from "../languageServers/extension.json";
import {
  fieldFor,
  fieldKey,
  fieldsFor,
  getPath,
  SERVER_SETTINGS,
  serverChanges,
  setPath,
  userOverrides,
  withServerJson,
  withServerSetting,
} from "./serverSettings";
import { resolveServers } from "./servers";

const contributed = {
  pyright: {
    command: "pyright-langserver",
    languages: ["python"],
    settings: { python: { analysis: { autoSearchPaths: true } } },
  },
  gopls: { command: "gopls", languages: ["go"] },
};

test("a server's field is written to lsp.servers.<name>.settings and merged over its own (D204)", () => {
  const field = fieldFor("pyright", "python.analysis.typeCheckingMode");
  assert.equal(field.type, "enum");
  const servers = withServerSetting(undefined, "pyright", field, "strict");
  assert.deepEqual(servers, {
    pyright: { settings: { python: { analysis: { typeCheckingMode: "strict" } } } },
  });
  // The server's own settings stay (merged key by key).
  const [py] = resolveServers(contributed, servers);
  assert.deepEqual(py?.settings, {
    python: { analysis: { autoSearchPaths: true, typeCheckingMode: "strict" } },
  });
  // Back to the server's value: the override and the empty objects go.
  assert.deepEqual(withServerSetting(servers, "pyright", field, undefined), {});
  // Other keys of the entry are kept.
  const withArgs = withServerSetting({ pyright: { args: ["--x"] } }, "pyright", field, "basic");
  assert.deepEqual(withArgs.pyright?.args, ["--x"]);
});

test("names with dots (gopls) and initialization options", () => {
  const gopls = fieldsFor("gopls").find((f) => f.path[1] === "staticcheck");
  assert.ok(gopls);
  const servers = withServerSetting({}, "gopls", gopls, true);
  assert.deepEqual(servers, { gopls: { settings: { gopls: { staticcheck: true } } } });
  const ts = fieldFor("typescript", "preferences.quotePreference");
  assert.equal(ts.target, "initializationOptions");
  assert.deepEqual(withServerSetting({}, "typescript", ts, "single"), {
    typescript: { initializationOptions: { preferences: { quotePreference: "single" } } },
  });
  // A key no schema knows: split at dots, edited as JSON.
  const ad = fieldFor("zls", "zls.enable_snippets");
  assert.deepEqual(ad.path, ["zls", "enable_snippets"]);
  assert.equal(ad.type, "json");
  assert.equal(fieldKey(ad), "zls.enable_snippets");
  assert.deepEqual(setPath({ a: { b: 1, c: 2 } }, ["a", "b"], undefined), { a: { c: 2 } });
  assert.equal(getPath({ a: { "ui.x": 3 } }, ["a", "ui.x"]), 3);
  assert.equal(getPath({ a: 1 }, ["a", "b"]), undefined);
});

test("every known server is a contributed one, its fields well formed (D218: 12 servers)", () => {
  const known = Object.keys(SERVER_SETTINGS);
  assert.equal(known.length, 12);
  const contributedNames = Object.keys(builtinServers.contributes.languageServers);
  for (const name of known) {
    assert.ok(contributedNames.includes(name), `${name} isn't a built-in server`);
    const keys = new Set<string>();
    for (const f of fieldsFor(name)) {
      const key = `${f.target}:${fieldKey(f)}`;
      assert.ok(!keys.has(key), `${name}: ${key} twice`);
      keys.add(key);
      assert.ok(f.description.endsWith("."), `${name}: ${key}'s description`);
      if (f.type === "enum") {
        assert.ok(f.enum?.length, `${name}: ${key} has no values`);
        if (f.default !== undefined) assert.ok(f.enum?.includes(String(f.default)));
      }
      if (f.type === "string[]" && f.default !== undefined) assert.ok(Array.isArray(f.default));
    }
  }
  assert.deepEqual(fieldFor("taplo", "evenBetterToml.formatter.alignEntries").path, [
    "evenBetterToml",
    "formatter",
    "alignEntries",
  ]);
  assert.equal(fieldFor("ruby-lsp", "formatter").target, "initializationOptions");
});

test("the JSON fields replace the whole object; an empty one removes it", () => {
  const servers = withServerJson({ gopls: { args: ["serve"] } }, "gopls", {
    settings: { gopls: { gofumpt: true } },
  });
  assert.deepEqual(userOverrides(servers, "gopls"), {
    args: ["serve"],
    settings: { gopls: { gofumpt: true } },
  });
  assert.deepEqual(withServerJson(servers, "gopls", { settings: {} }), {
    gopls: { args: ["serve"] },
  });
  assert.deepEqual(withServerJson({}, "x", { settings: null, initializationOptions: null }), {});
});

test("only settings changed: reconfigure, no restart", () => {
  const before = resolveServers(contributed, {});
  const settingsOnly = resolveServers(contributed, {
    pyright: { settings: { python: { analysis: { typeCheckingMode: "strict" } } } },
  });
  assert.deepEqual(serverChanges(before, settingsOnly), { restart: [], reconfigure: ["pyright"] });
  const initChanged = resolveServers(contributed, { gopls: { initializationOptions: { a: 1 } } });
  assert.deepEqual(serverChanges(before, initChanged), { restart: ["gopls"], reconfigure: [] });
  const removed = resolveServers(contributed, { gopls: { enabled: false } });
  assert.deepEqual(serverChanges(before, removed), { restart: ["gopls"], reconfigure: [] });
  assert.deepEqual(serverChanges(before, before), { restart: [], reconfigure: [] });
});

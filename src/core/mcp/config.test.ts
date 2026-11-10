// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MCP config placeholders
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeServer,
  inputIds,
  mergeServers,
  parseEnvFile,
  secretId,
  serverSignature,
  substitute,
  usesRawSecret,
} from "./config";

test("the first source that names a server wins; enabled false turns it off", () => {
  const merged = mergeServers([
    {
      label: "settings",
      kind: "settings",
      inputs: [],
      servers: { a: { command: "own" }, b: { command: "x", enabled: false } },
    },
    {
      label: ".mcp.json",
      kind: "workspace",
      inputs: [],
      servers: { a: { command: "file" }, b: { command: "file" }, c: { url: "https://x" } },
    },
    { label: "ext", kind: "extension", inputs: [], servers: { d: {} } },
  ]);
  assert.deepEqual(
    merged.map((s) => [s.name, s.config.command ?? s.config.url, s.source.label]),
    [
      ["a", "own", "settings"],
      ["c", "https://x", ".mcp.json"],
    ],
  );
});

test("variables and inputs", () => {
  const c = {
    command: "npx",
    args: ["${workspaceFolder}/srv", "--key=${input:key}"],
    env: { HOME_DIR: "${userHome}", TOKEN: "${input:token}", PATHX: "${env:PATH}" },
    headers: { Authorization: "Bearer ${input:token}" },
  };
  assert.deepEqual(inputIds(c), ["key", "token"]);
  const out = substitute(c, { workspaceFolder: "/w", userHome: "/h" }, (id) =>
    id === "token" ? `\${secret:${secretId("gh", id)}}` : "k1",
  );
  assert.deepEqual(out.args, ["/w/srv", "--key=k1"]);
  assert.deepEqual(out.env, {
    HOME_DIR: "/h",
    TOKEN: "${secret:mcp.input.gh::token}",
    PATHX: "${env:PATH}",
  });
  assert.equal(out.headers?.Authorization, "Bearer ${secret:mcp.input.gh::token}");
  assert.equal(secretId("my server", "a/b"), "mcp.input.my_server::a_b");
  assert.equal(usesRawSecret({ command: "x", env: { A: "${secret:mcp.input.o::t}" } }), true);
  assert.equal(usesRawSecret(c), false);
  assert.match(describeServer(c), /env TOKEN=\$\{input:token\}/);
  assert.notEqual(serverSignature("a", { command: "x" }), serverSignature("a", { command: "y" }));
});

test("env files", () => {
  assert.deepEqual(
    parseEnvFile("# comment\nexport A=1\nB = \"two words\"\nC='x#y'\nD=plain # note\nnot a line\n"),
    { A: "1", B: "two words", C: "x#y", D: "plain" },
  );
});

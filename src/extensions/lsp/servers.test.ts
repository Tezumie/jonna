import assert from "node:assert/strict";
import { test } from "node:test";
import { expandArgs, resolveServers } from "./servers";

test("user settings override, extend and disable contributed servers", () => {
  const contributed = {
    ra: { command: "rust-analyzer", languages: ["rust"], extension: "builtin.x" },
    py: { command: "pyright-langserver", args: ["--stdio"], languages: ["python"] },
  };
  const servers = resolveServers(contributed, {
    ra: { args: ["--log"] },
    py: { enabled: false },
    mine: { command: "node", args: ["${workspaceFolder}/s.mjs"], languages: ["markdown"] },
    broken: { args: [] },
  });
  assert.deepEqual(
    servers.map((s) => [s.name, s.command, s.source]),
    [
      ["ra", "rust-analyzer", "builtin.x"],
      ["mine", "node", "settings"],
    ],
  );
  assert.deepEqual(servers[0]?.args, ["--log"]);
  assert.deepEqual(expandArgs(servers[1]?.args, "/w"), ["/w/s.mjs"]);
  assert.equal(resolveServers(contributed, "junk").length, 2);
});

test("${workspaceFolder} in a server's args is the first folder; ${workspaceFolder:Name} any (D251)", () => {
  const folders = [
    { name: "api", path: "/w/api" },
    { name: "web", path: "/w/web" },
  ];
  assert.deepEqual(
    expandArgs(
      ["${workspaceFolder}/a", "--p=${workspaceFolder:web}", "${workspaceFolder:x}"],
      "/w/api",
      folders,
    ),
    ["/w/api/a", "--p=/w/web", "${workspaceFolder:x}"],
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { snippetsFromFile } from "./userSnippets";

test("language files and scoped .code-snippets become snippet entries", () => {
  const json = { Log: { prefix: ["log", "cl"], body: ["console.log($1);", "$0"] } };
  const typed = snippetsFromFile("typescriptreact.json", json, "user");
  assert.deepEqual(
    typed.map((e) => [e.language, e.prefix]),
    [
      ["tsx", "log"],
      ["tsx", "cl"],
    ],
  );
  assert.equal(typed[0]?.body, "console.log($1);\n$0");
  const scoped = snippetsFromFile(
    "project.code-snippets",
    {
      A: { scope: "javascript, typescriptreact", prefix: "a", body: "x" },
      B: { prefix: "b", body: "y" },
    },
    "workspace",
  );
  assert.deepEqual(
    scoped.map((e) => [e.language, e.prefix]),
    [
      ["javascript", "a"],
      ["tsx", "a"],
      ["*", "b"],
    ],
  );
  assert.deepEqual(snippetsFromFile("x.code-snippets", null, "w"), []);
});

test("hot exit backs up dirty files within the limits", async () => {
  const { backupsOf } = await import("./hotExit");
  const big = "x".repeat(3 * 1024 * 1024);
  assert.deepEqual(
    backupsOf([
      { path: "/a", dirty: true, text: "edited" },
      { path: "/b", dirty: false, text: "clean" },
      { path: "/c", dirty: true, text: null },
      { path: "/d", dirty: true, text: big },
    ]),
    [{ path: "/a", text: "edited" }],
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  asText,
  closest,
  commandLine,
  errorText,
  headText,
  namespaces,
  rankCommands,
  structuredError,
} from "./toolText";

test("asText: strings stay text, values are compact JSON (D191)", () => {
  assert.equal(asText("a\nb"), "a\nb");
  assert.equal(asText({ a: 1 }), '{\n "a": 1\n}');
  assert.equal(asText(undefined), "done");
});

test("headText: keeps the beginning and says where to read on", () => {
  const text = `${"x".repeat(50)}\n${"y".repeat(50)}\n${"z".repeat(50)}`;
  const first = headText(text, 110);
  assert.ok(first.startsWith("xxxx"));
  const next = Number(first.match(/offset: (\d+)/)?.[1]);
  assert.equal(next, 101, "cut at the line end");
  const rest = headText(text, 110, next);
  assert.ok(rest.includes("zzz") && !rest.includes("more characters"));
  assert.equal(headText("short", 100), "short");
});

test("closest: did-you-mean by shared words and spelling", () => {
  const ids = ["editor.openFile", "editor.saveAll", "git.commit", "terminal.create"];
  assert.equal(closest("editor.openfiel", ids)[0], "editor.openFile");
  assert.equal(closest("git.comit", ids)[0], "git.commit");
  assert.deepEqual(closest("zzzzzzzz", ids), []);
});

test("rankCommands: namespace and id before descriptions", () => {
  const cmds = [
    {
      id: "editor.insertText",
      title: "Insert text",
      description: "Inserts text; git aware.",
      effects: ["write"],
    },
    {
      id: "git.commit",
      title: "Commit",
      description: "Commits staged changes.",
      effects: ["write"],
    },
    { id: "git.push", title: "Push", description: "Pushes.", effects: ["network"] },
  ];
  assert.deepEqual(
    rankCommands(cmds, "git")
      .map((c) => c.id)
      .slice(0, 2)
      .sort(),
    ["git.commit", "git.push"],
  );
  assert.equal(rankCommands(cmds, "git commit")[0]?.id, "git.commit");
  assert.equal(rankCommands(cmds, "nothing").length, 0);
  assert.equal(namespaces(cmds), "git (2), editor (1)");
  assert.equal(
    commandLine(cmds[1] as (typeof cmds)[number], "yes"),
    "git.commit — write — asks: yes — Commits staged changes.",
  );
});

test("structuredError: a code and a hint", () => {
  const e = structuredError(new Error('Unknown command "git.comit"'), ["git.commit"]);
  assert.equal(e.code, "unknown_command");
  assert.match(errorText(e), /Did you mean: git.commit\?/);
  assert.equal(
    structuredError(new Error('Invalid input for "x": /a required')).code,
    "invalid_input",
  );
  assert.equal(structuredError(new Error("something odd")).code, "failed");
  const denied = Object.assign(new Error('Not permitted: "x" for agent'), {
    name: "CommandError",
    code: "Denied",
  });
  assert.equal(structuredError(denied).code, "denied");
});

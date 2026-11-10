import assert from "node:assert/strict";
import { test } from "node:test";
import { expandHomePath, pathLinksIn, tokenizeCommand, wslPathToWindows } from "./features";

test("file paths with lines in terminal output", () => {
  assert.deepEqual(pathLinksIn("src/app.ts:12:5 - error TS2322"), [
    { x: 0, length: 15, path: "src/app.ts", line: 12, col: 5 },
  ]);
  assert.deepEqual(
    pathLinksIn("  at main (./lib/run.js:40:9)").map((p) => [p.path, p.line]),
    [["./lib/run.js", 40]],
  );
  assert.deepEqual(
    pathLinksIn("Foo.cs(10,3): warning").map((p) => [p.path, p.line, p.col]),
    [["Foo.cs", 10, 3]],
  );
  assert.deepEqual(pathLinksIn("version 1.2.3 ok"), []);
});

test("paths a WSL shell printed are the distribution's (D229)", () => {
  const home = "\\\\wsl.localhost\\Ubuntu\\home\\me";
  assert.equal(
    wslPathToWindows("~/src/app.ts", "Ubuntu", home),
    "\\\\wsl.localhost\\Ubuntu\\home\\me\\src\\app.ts",
  );
  assert.equal(wslPathToWindows("~/a.ts", "Ubuntu", null), "~/a.ts");
  assert.equal(
    wslPathToWindows("/etc/hosts.txt", "Ubuntu", home),
    "\\\\wsl.localhost\\Ubuntu\\etc\\hosts.txt",
  );
  assert.equal(wslPathToWindows("src/a.ts", "Ubuntu", home), "src/a.ts");
  assert.equal(wslPathToWindows("~bob/a.ts", "Ubuntu", home), "~bob/a.ts");
});

test("~/ paths in terminal output are the home folder", () => {
  assert.deepEqual(
    pathLinksIn("wrote ~/notes/todo.md:3").map((p) => [p.path, p.line]),
    [["~/notes/todo.md", 3]],
  );
  assert.equal(expandHomePath("~/notes/todo.md", "/home/me", false), "/home/me/notes/todo.md");
  assert.equal(expandHomePath("~/a.txt", "/home/me/", false), "/home/me/a.txt");
  assert.equal(expandHomePath("~/src/app.ts", "C:\\Users\\me", true), "C:\\Users\\me\\src\\app.ts");
  assert.equal(
    expandHomePath("~\\src\\app.ts", "C:\\Users\\me\\", true),
    "C:\\Users\\me\\src\\app.ts",
  );
  assert.deepEqual(
    pathLinksIn("see ~\\src\\app.ts(4,2)").map((p) => [p.path, p.line, p.col]),
    [["~\\src\\app.ts", 4, 2]],
  );
  // `~\` is only the home folder on Windows; `~user/` and plain paths stay as they are.
  assert.equal(expandHomePath("~\\a.txt", "/home/me", false), "~\\a.txt");
  assert.equal(expandHomePath("~bob/a.txt", "/home/me", false), "~bob/a.txt");
  assert.equal(expandHomePath("./a.txt", "/home/me", false), "./a.txt");
  assert.equal(expandHomePath("~/a.txt", null, false), "~/a.txt");
});

test("command tokens", () => {
  const line = 'FOO=1 npm run dev -- --port 3000 | grep "ready" && ./x.sh $HOME';
  const kinds = tokenizeCommand(line).map((t) => [line.slice(t.start, t.end), t.kind]);
  assert.deepEqual(kinds, [
    ["FOO=1", "variable"],
    ["npm", "program"],
    ["--", "flag"],
    ["--port", "flag"],
    ["3000", "number"],
    ["|", "operator"],
    ["grep", "program"],
    ['"ready"', "string"],
    ["&&", "operator"],
    ["./x.sh", "program"],
    ["$HOME", "variable"],
  ]);
});

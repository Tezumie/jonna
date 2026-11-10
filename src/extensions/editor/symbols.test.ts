import assert from "node:assert/strict";
import { test } from "node:test";
import { findSymbols } from "./symbols";

const names = (list: ReturnType<typeof findSymbols>): unknown =>
  list.map((s) => (s.children.length ? [s.name, names(s.children)] : s.name));

test("markdown headings nest by level; code fences are skipped", () => {
  const md =
    "# Title\n\nText\n\n## Install\n```sh\n# not a heading\n```\n### Windows\n## Usage\nSetext\n---\n";
  const s = findSymbols("markdown", md);
  assert.deepEqual(names(s), [["Title", [["Install", ["Windows"]], "Usage", "Setext"]]]);
  assert.equal(s[0]?.endLine, 13);
  assert.equal(s[0]?.children[0]?.endLine, 9);
});

test("python: classes and methods by indentation, docstrings skipped", () => {
  const py =
    'class A:\n    """\n    def nope():\n    """\n    def f(self):\n        pass\n\n    async def g(self): ...\n\ndef top():\n    pass\n';
  assert.deepEqual(names(findSymbols("python", py)), [["A", ["f", "g"]], "top"]);
});

test("rust, go, shell, yaml and others", () => {
  assert.deepEqual(
    names(
      findSymbols(
        "rust",
        "pub struct S;\nimpl S {\n    pub fn new() -> Self { S }\n}\nfn main() {}\n",
      ),
    ),
    ["S", ["S", ["new"]], "main"],
  );
  assert.deepEqual(
    names(
      findSymbols("go", "type T struct{}\nfunc (t *T) Run() {}\nfunc main() {\n\tif x {\n\t}\n}\n"),
    ),
    ["T", "Run", "main"],
  );
  assert.deepEqual(
    names(findSymbols("shellscript", "build() {\n  echo\n}\nfunction test {\n}\n")),
    ["build", "test"],
  );
  assert.deepEqual(
    names(
      findSymbols(
        "yaml",
        "name: ci\non:\n  push:\n    branches: [main]\njobs:\n  build:\n    runs-on: x\n",
      ),
    ),
    ["name", ["on", ["push"]], ["jobs", ["build"]]],
  );
  assert.deepEqual(names(findSymbols("toml", '[package]\nname = "x"\n[[bin]]\n')), [
    "package",
    "bin",
  ]);
  assert.deepEqual(names(findSymbols("dockerfile", "FROM node AS build\nRUN x\nFROM nginx\n")), [
    "build",
  ]);
  assert.deepEqual(findSymbols("plaintext", "def x():"), []);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { fileRecommendations, parseExtensionsJson, recommendationsFor } from "./recommendations";

test("extensions.json is JSONC; ids that aren't namespace.name are dropped", () => {
  const r = parseExtensionsJson(`{
    // The team's picks
    "recommendations": ["esbenp.prettier-vscode", "not-an-id", 3, "../x.y", "golang.Go",],
    "unwantedRecommendations": ["ms-python.python"]
  }`);
  assert.deepEqual(r.recommendations, ["esbenp.prettier-vscode", "golang.Go"]);
  assert.deepEqual(r.unwanted, ["ms-python.python"]);
  assert.deepEqual(parseExtensionsJson("{ broken"), { recommendations: [], unwanted: [] });
  assert.deepEqual(parseExtensionsJson("[1]"), { recommendations: [], unwanted: [] });
});

test("files: by extension, by name and by config pattern, each id once", () => {
  const r = fileRecommendations([
    "/w/src/main.py",
    "C:\\w\\app\\util.py",
    "/w/Dockerfile",
    "/w/.prettierrc.json",
    "/w/eslint.config.mjs",
    "/w/README",
    "/w/pubspec.yaml",
    "/w/lib/x.rs",
  ]);
  assert.deepEqual(
    r.map((x) => x.id),
    [
      "ms-python.python",
      "ms-azuretools.vscode-docker",
      "esbenp.prettier-vscode",
      "dbaeumer.vscode-eslint",
      "Dart-Code.flutter",
      "rust-lang.rust-analyzer",
    ],
  );
  assert.equal(r[0]?.reason, "For Python files");
  assert.equal(r[0]?.source, "files");
});

test("the workspace's first; installed, ignored and unwanted ones left out (any case)", () => {
  const r = recommendationsFor({
    workspace: [
      { recommendations: ["Vue.volar", "golang.go"], unwanted: [] },
      { recommendations: ["redhat.java"], unwanted: ["rust-lang.rust-analyzer"] },
    ],
    paths: ["/w/a.go", "/w/b.rs", "/w/c.py", "/w/d.md"],
    installed: new Set(["vue.volar"]),
    ignored: ["YZHANG.markdown-all-in-one"],
  });
  assert.deepEqual(
    r.map((x) => [x.id, x.source]),
    [
      ["golang.go", "workspace"],
      ["redhat.java", "workspace"],
      ["ms-python.python", "files"],
    ],
  );
});

test("nothing to recommend: popular ones, without the installed or ignored (D406)", () => {
  const r = recommendationsFor({
    workspace: [],
    paths: [],
    installed: new Set(["esbenp.prettier-vscode"]),
    ignored: ["usernamehw.errorlens"],
  });
  assert.deepEqual(
    r.map((x) => [x.id, x.source]),
    [
      ["dbaeumer.vscode-eslint", "popular"],
      ["ms-python.python", "popular"],
      ["christian-kohler.path-intellisense", "popular"],
    ],
  );
  // Anything of the folder's own: no popular ones.
  const py = recommendationsFor({
    workspace: [],
    paths: ["/w/a.py"],
    installed: new Set(),
    ignored: [],
  });
  assert.ok(py.every((x) => x.source !== "popular"));
});

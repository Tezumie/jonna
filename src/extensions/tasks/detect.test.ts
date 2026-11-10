import assert from "node:assert/strict";
import { test } from "node:test";
import { entryForDetected } from "./defaultTask";
import {
  buildKinds,
  cargoManifest,
  type DetectFolder,
  detectDepth,
  detectSyntax,
  detectTasks,
  foldersToScan,
  gradleHasApplication,
  gruntTasks,
  gulpTasks,
  MAKE_DATABASE_ARGS,
  makeDatabaseTargets,
  makefileTargets,
  type ScanEntry,
  tsconfigNames,
  wantedFiles,
} from "./detect";

const folder = (over: Partial<DetectFolder>): DetectFolder => ({
  rel: "",
  abs: "/w",
  names: [],
  files: {},
  ...over,
});

test("Makefile targets", () => {
  const text = [
    "CC := gcc",
    "FLAGS = -a:b",
    "PREFIX ?= /usr",
    "X ::= y",
    ".PHONY: all test out/app.o",
    "all: build",
    "build: main.o util.o # the program",
    "\t$(CC) -o app main.o",
    "main.o: main.c",
    "%.o: %.c",
    "test check:: build",
    "\t./app --test",
    "$(OUT): x",
    "out/app.o: x",
    "define RECIPE",
    "inside: nope",
    "endef",
    "long \\",
    "  name: x",
    "clean:",
  ].join("\n");
  assert.deepEqual(makefileTargets(text), [
    "all",
    "build",
    "test",
    "check",
    "out/app.o",
    "long",
    "name",
    "clean",
  ]);
});

/** What GNU make 4.3 printed for `make -p -n -q -r .DEFAULT` (its "# Files" section). */
const MAKE_DATABASE = [
  "# GNU Make 4.3",
  "# Variables",
  "",
  "# makefile (from 'Makefile', line 1)",
  "PROGS := alpha beta",
  "",
  "%.o: %.c",
  "#  recipe to execute (from 'Makefile', line 12):",
  "\techo",
  "",
  "# Files",
  "",
  "lint:",
  "#  Implicit rule search has not been done.",
  "#  Modification time never checked.",
  "#  File has not been updated.",
  "#  recipe to execute (from 'extra.mk', line 2):",
  "\techo lint",
  "",
  "# Not a target:",
  "extra.mk:",
  "#  Implicit rule search has been done.",
  "#  Last modified 2026-10-30 20:13:04.1647333",
  "#  File has been updated.",
  "#  Successfully updated.",
  "",
  "# makefile (from 'Makefile', line 7)",
  "debug: CFLAGS := -g",
  "debug: all",
  "#  Implicit rule search has not been done.",
  "#  Modification time never checked.",
  "#  File has not been updated.",
  "# variable set hash-table stats:",
  "# Load=1/32=3%, Rehash=0, Collisions=0/2=0%",
  "",
  "# Not a target:",
  "Makefile:",
  "#  Implicit rule search has been done.",
  "#  Last modified 2026-10-30 20:13:04.1637331",
  "#  File has been updated.",
  "#  Successfully updated.",
  "",
  "clean:",
  "#  Phony target (prerequisite of .PHONY).",
  "#  Implicit rule search has not been done.",
  "#  File does not exist.",
  "#  File has not been updated.",
  "#  recipe to execute (from 'Makefile', line 6):",
  "\trm -f x",
  "",
  "# Not a target:",
  ".DEFAULT:",
  "#  Command line target.",
  "#  Implicit rule search has been done.",
  "#  File does not exist.",
  "#  File has not been updated.",
  "",
  "all: alpha beta",
  "#  Phony target (prerequisite of .PHONY).",
  "#  Implicit rule search has not been done.",
  "#  File does not exist.",
  "#  File has not been updated.",
  "",
  "run-beta:",
  "#  Phony target (prerequisite of .PHONY).",
  "#  Implicit rule search has not been done.",
  "#  File does not exist.",
  "#  File has not been updated.",
  "#  recipe to execute (from 'Makefile', line 4):",
  "\t @echo beta",
  "",
  "# Not a target:",
  "beta:",
  "#  Implicit rule search has not been done.",
  "#  Modification time never checked.",
  "#  File has not been updated.",
  "",
  "# Not a target:",
  "src/app.c:",
  "#  Implicit rule search has not been done.",
  "#  Modification time never checked.",
  "#  File has not been updated.",
  "",
  "out/app.o: src/app.c",
  "#  Implicit rule search has not been done.",
  "#  Modification time never checked.",
  "#  File has not been updated.",
  "#  recipe to execute (from 'Makefile', line 10):",
  "\techo hi",
  "",
  "run-alpha:",
  "#  Phony target (prerequisite of .PHONY).",
  "#  Implicit rule search has not been done.",
  "#  File does not exist.",
  "#  File has not been updated.",
  "#  recipe to execute (from 'Makefile', line 4):",
  "\t @echo alpha",
  "",
  "# Not a target:",
  "alpha:",
  "#  Implicit rule search has not been done.",
  "#  Modification time never checked.",
  "#  File has not been updated.",
  "",
  ".PHONY: all clean run-alpha run-beta",
  "#  Implicit rule search has not been done.",
  "#  Modification time never checked.",
  "#  File has not been updated.",
  "",
  "# files hash-table stats:",
  "# Load=15/1024=1%, Rehash=0, Collisions=0/41=0%",
  "# VPATH Search Paths",
  "",
  "not: a-target",
].join("\n");

test("Makefile targets from make's database: generated, included and target-specific", () => {
  const order = makefileTargets("all: $(PROGS)\nclean:\ndebug: all\n");
  assert.deepEqual(order, ["all", "clean", "debug"]);
  // The text's order first, then the rest by name; not files, makefiles, patterns or .DEFAULT.
  const all = ["all", "clean", "debug", "lint", "run-alpha", "run-beta"];
  assert.deepEqual(makeDatabaseTargets(MAKE_DATABASE, order), all);
  // CRLF output (a Windows make) reads the same.
  assert.deepEqual(makeDatabaseTargets(MAKE_DATABASE.replace(/\n/g, "\r\n"), order), all);
  // Not a GNU make database (BSD make, an error): null, so the text is read instead.
  assert.equal(makeDatabaseTargets("make: *** No targets.  Stop."), null);
  assert.equal(makeDatabaseTargets(""), null);
  // A file target declared phony stays; a drive letter isn't the rule's colon.
  const windows = [
    "# Files",
    "",
    "C:/src/app.o: C:/src/app.c",
    "#  File does not exist.",
    "",
    "dist/pack: build",
    "#  Phony target (prerequisite of .PHONY).",
    "",
  ].join("\n");
  assert.deepEqual(makeDatabaseTargets(windows), ["dist/pack"]);
  assert.deepEqual(MAKE_DATABASE_ARGS, ["-p", "-n", "-q", "-r", ".DEFAULT"]);
});

test("detected make tasks use the database's targets when make ran", () => {
  const made = folder({
    names: ["Makefile"],
    files: { Makefile: "all:\n" },
    makeTargets: ["all", "run-alpha"],
  });
  assert.deepEqual(
    detectTasks(made, "linux").map((t) => t.label),
    ["make: all", "make: run-alpha"],
  );
});

test("gulp and grunt tasks", () => {
  assert.deepEqual(
    gulpTasks(
      [
        "gulp.task('legacy', () => {});",
        "exports.build = series(a, b);",
        "exports.default = build;",
        "module.exports.lint = lint;",
        "export async function watch() {}",
        "export const serve = () => {};",
        "export { clean, test as check };",
        "if (exports.x == 1) {}",
      ].join("\n"),
    ),
    ["legacy", "build", "default", "lint", "watch", "serve", "clean", "check"],
  );
  assert.deepEqual(
    gruntTasks(
      "grunt.registerTask('default', ['jshint']); grunt.registerMultiTask(\"copy\", fn); grunt.registerTask('default', x);",
    ),
    ["default", "copy"],
  );
});

test("Gradle application plugin and Cargo manifests", () => {
  assert.ok(gradleHasApplication("plugins {\n  id 'application'\n}"));
  assert.ok(gradleHasApplication('plugins {\n  id("application")\n}'));
  assert.ok(gradleHasApplication("apply plugin: 'application'"));
  assert.ok(gradleHasApplication("plugins {\n    application\n}"));
  assert.ok(!gradleHasApplication("plugins { id 'java-library' }"));
  assert.deepEqual(cargoManifest('[package]\nname = "a"\n[[bin]]\nname="x"\n[[bin]]\nname="y"'), {
    package: true,
    workspace: false,
    bins: 2,
  });
  assert.deepEqual(cargoManifest('[workspace]\nmembers = ["a"]'), {
    package: false,
    workspace: true,
    bins: 0,
  });
});

test("names", () => {
  assert.deepEqual(tsconfigNames(["tsconfig.test.json", "tsconfig.json", "jsconfig.json", "x"]), [
    "tsconfig.json",
    "tsconfig.test.json",
  ]);
  assert.deepEqual(wantedFiles(["Makefile", "README.md", "Cargo.toml", "gulpfile.js"]), [
    "Makefile",
    "Cargo.toml",
    "gulpfile.js",
  ]);
  assert.deepEqual([...buildKinds(["pom.xml", "Cargo.toml"])].sort(), ["cargo", "maven"]);
});

test("detected tasks: tsc, make, cargo", () => {
  const tasks = detectTasks(
    folder({
      names: ["tsconfig.json", "Makefile", "Cargo.toml", "node_modules"],
      files: {
        Makefile: "build:\n\tcc x\ntest:\n\t./t\ndev:\n\t./serve",
        "Cargo.toml": "[package]",
      },
      localBins: ["tsc"],
      cargoMain: true,
    }),
    "linux",
  );
  const byLabel = new Map(tasks.map((t) => [t.label, t]));
  assert.deepEqual(
    tasks.map((t) => t.label),
    [
      "tsc: build - tsconfig.json",
      "tsc: watch - tsconfig.json",
      "make: build",
      "make: test",
      "make: dev",
      "cargo: build",
      "cargo: check",
      "cargo: test",
      "cargo: run",
    ],
  );
  const build = byLabel.get("tsc: build - tsconfig.json");
  assert.equal(build?.command, "node_modules/.bin/tsc -p tsconfig.json");
  assert.equal(build?.problemMatcher, "$tsc");
  assert.deepEqual(build?.group, { kind: "build", isDefault: false });
  const watch = byLabel.get("tsc: watch - tsconfig.json");
  assert.equal(watch?.background, true);
  assert.equal(watch?.problemMatcher, "$tsc-watch");
  assert.equal(byLabel.get("make: test")?.group?.kind, "test");
  assert.equal(byLabel.get("make: dev")?.background, true);
  assert.equal(byLabel.get("cargo: test")?.problemMatcher, "$rustc");
  assert.equal(byLabel.get("cargo: build")?.cwd, "/w");
});

test("detected tasks in a subfolder, on Windows", () => {
  const tasks = detectTasks(
    folder({
      rel: "java",
      abs: "C:\\w\\java",
      names: ["build.gradle", "gradlew", "gradlew.bat", "pom.xml", "tsconfig.json", "gulpfile.js"],
      files: {
        "build.gradle": "plugins { id 'application' }",
        "gulpfile.js": "exports.default = x",
      },
    }),
    "windows",
  );
  assert.deepEqual(
    tasks.map((t) => `${t.label} | ${t.command}`),
    [
      "tsc: build - java/tsconfig.json | tsc -p tsconfig.json",
      "tsc: watch - java/tsconfig.json | tsc --watch -p tsconfig.json",
      "gradle: build - java | .\\gradlew.bat build",
      "gradle: test - java | .\\gradlew.bat test",
      "gradle: run - java | .\\gradlew.bat run",
      "maven: compile - java | mvn compile",
      "maven: test - java | mvn test",
      "maven: package - java | mvn package",
      "gulp: default - java | gulp",
    ],
  );
  const tsc = tasks[0];
  assert.deepEqual(tsc?.problemMatcher, {
    base: "$tsc",
    fileLocation: ["relative", "${workspaceFolder}/java"],
  });
  assert.equal(tsc?.source, "java/tsconfig.json");
  assert.equal(tsc?.cwd, "C:\\w\\java");
  // A Gradle root covers its subprojects.
  const skipped = detectTasks(
    folder({ rel: "app", names: ["build.gradle"], files: { "build.gradle": "" } }),
    "linux",
    new Set(["gradle"]),
  );
  assert.equal(skipped.length, 0);
});

test("a detected task's tasks.json entry keeps its folder and matcher", () => {
  const [make] = detectTasks(
    folder({ rel: "native", abs: "/w/native", names: ["Makefile"], files: { Makefile: "all:" } }),
    "linux",
  );
  assert.ok(make);
  assert.deepEqual(entryForDetected(make), {
    label: "make: all - native",
    type: "shell",
    command: "make all",
    options: { cwd: "${workspaceFolder}/native" },
    problemMatcher: { base: "$gcc", fileLocation: ["autoDetect", "${workspaceFolder}/native"] },
  });
});

test("gulp and grunt names with shell characters aren't tasks (D201)", () => {
  assert.deepEqual(gulpTasks('gulp.task("build\\n; curl x|sh", f); gulp.task("css:min", f);'), [
    "css:min",
  ]);
  assert.deepEqual(
    gruntTasks('grunt.registerTask("a && b", []); grunt.registerTask("dist", []);'),
    ["dist"],
  );
});

test("detection looks two levels down, skipping heavy folders, with a cap (D203)", async () => {
  const dir = (name: string, extra: Partial<ScanEntry> = {}): ScanEntry => ({
    name,
    kind: "dir",
    ...extra,
  });
  const file = (name: string): ScanEntry => ({ name, kind: "file" });
  const tree: Record<string, ScanEntry[]> = {
    packages: [dir("app"), dir("lib"), dir("node_modules")],
    "packages/app": [file("tsconfig.json"), dir("src")],
    "packages/lib": [file("Makefile")],
    "packages/app/src": [file("Makefile")],
    crates: [file("Cargo.toml"), dir("core")],
    "crates/core": [file("Cargo.toml")],
  };
  const listed: string[] = [];
  const list = async (rel: string) => {
    listed.push(rel);
    return tree[rel] ?? [];
  };
  const root = [
    dir("packages"),
    dir("crates"),
    dir("node_modules"),
    dir(".git"),
    dir("gen", { ignored: true }),
    dir("link", { isSymlink: true }),
    file("README.md"),
  ];
  const two = await foldersToScan(root, 2, list);
  assert.deepEqual(
    two.map((f) => f.rel),
    ["packages", "crates", "packages/app", "packages/lib", "crates/core"],
  );
  // Never listed: heavy, hidden, ignored and linked folders, or deeper than asked.
  assert.ok(!listed.some((r) => /node_modules|\.git|gen|link|src/.test(r)), listed.join());
  // A Cargo folder's members are its build's.
  assert.ok(two.find((f) => f.rel === "crates/core")?.skip.has("cargo"));
  assert.ok(!two.find((f) => f.rel === "packages/app")?.skip.has("cargo"));
  assert.deepEqual(
    (await foldersToScan(root, 1, list)).map((f) => f.rel),
    ["packages", "crates"],
  );
  assert.deepEqual(await foldersToScan(root, 0, list), []);
  assert.equal((await foldersToScan(root, 3, list)).map((f) => f.rel).at(-1), "packages/app/src");
  // The cap counts every folder listed, the shallow ones first.
  assert.deepEqual(
    (await foldersToScan(root, 2, list, 3)).map((f) => f.rel),
    ["packages", "crates", "packages/app"],
  );
  assert.equal(detectDepth(undefined), 2);
  assert.equal(detectDepth(7), 3);
  assert.equal(detectDepth(-1), 0);
  assert.equal(detectDepth(1.5), 1);
});

test("detected tasks use the POSIX form when a POSIX shell runs them on Windows", () => {
  assert.equal(detectSyntax("windows", "posix"), "linux");
  assert.equal(detectSyntax("windows", "pwsh"), "windows");
  assert.equal(detectSyntax("windows", "cmd"), "windows");
  assert.equal(detectSyntax("mac", "posix"), "mac");
});

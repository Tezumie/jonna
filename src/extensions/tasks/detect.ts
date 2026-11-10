// Task detection beyond package.json scripts (VS Code's task providers): `tsc: build` / `tsc: watch`
// per tsconfig, Makefile targets, Cargo, Gradle, Maven, gulp and grunt. Each folder looked at (the
// root and its subfolders down to task.autoDetectDepth, D203) is described by its file names and
// the text of the build files it has; this module picks the folders and turns that into tasks.
// DOM-free and tested; detectFolders.ts does the reading.
import type { TaskDefinition } from "./tasks";
import { DEFAULT_PRESENTATION, type TaskShellKind } from "./tasks";

export type Platform = "windows" | "mac" | "linux";

/** One folder: where it is, what's in it, and the build files' text (by name). */
export interface DetectFolder {
  /** Workspace-relative, "/" separated; "" for the root. */
  rel: string;
  /** Absolute path (the tasks' cwd). */
  abs: string;
  /** Names of the folder's entries. */
  names: readonly string[];
  /** Text of the files `wantedFiles` named (missing when unreadable). */
  files: Readonly<Record<string, string>>;
  /** Programs found in the folder's `node_modules/.bin` ("tsc", "gulp", "grunt"). */
  localBins?: readonly string[];
  /** The folder has `src/main.rs` (a Cargo binary to `cargo run`). */
  cargoMain?: boolean;
  /**
   * The Makefile's targets as `make -p` listed them (`makeDatabaseTargets`); missing when make
   * wasn't run (untrusted folder, no make on PATH, a timeout): the text is read instead.
   */
  makeTargets?: readonly string[];
}

/** The names make looks for, in its order. */
export const MAKEFILES = ["GNUmakefile", "makefile", "Makefile"];
const GULPFILES = ["gulpfile.js", "gulpfile.mjs", "gulpfile.cjs", "gulpfile.ts", "Gulpfile.js"];
const GRUNTFILES = ["Gruntfile.js", "gruntfile.js", "Gruntfile.cjs"];
const GRADLE = ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"];

/** Which of a folder's files detection reads (the rest are only looked at by name). */
export function wantedFiles(names: readonly string[]): string[] {
  const wanted = [...MAKEFILES, "Cargo.toml", ...GULPFILES, ...GRUNTFILES, ...GRADLE];
  return names.filter((n) => wanted.includes(n));
}

/** The tsconfig files of a folder (`tsconfig.json`, `tsconfig.build.json`…), VS Code's. */
export function tsconfigNames(names: readonly string[]): string[] {
  return names.filter((n) => /^tsconfig(\.[\w.-]+)?\.json$/.test(n)).sort();
}

/** Folders skipped when looking one level down (build output, dependencies, tool state). */
export const SKIPPED_FOLDERS = new Set([
  "node_modules",
  "target",
  "build",
  "dist",
  "out",
  "vendor",
  "venv",
  ".venv",
  "__pycache__",
  "coverage",
  "bin",
  "obj",
]);

/** An entry of a folder listing, as the scan needs it. */
export interface ScanEntry {
  name: string;
  kind: "file" | "dir";
  ignored?: boolean;
  isSymlink?: boolean;
}

/** A folder below the root to detect tasks in, with the build kinds its parents cover. */
export interface ScannedFolder {
  rel: string;
  names: string[];
  skip: Set<string>;
}

/** Most folders below the root that detection lists (D203: a monorepo stays cheap). */
export const MAX_SCANNED_FOLDERS = 80;
/** Deepest `task.autoDetectDepth`. */
export const MAX_DETECT_DEPTH = 3;

/** The setting as a depth (0…3; the default 2 when unset or not a number). */
export function detectDepth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 2;
  return Math.max(0, Math.min(MAX_DETECT_DEPTH, Math.floor(value)));
}

/** Whether detection looks into a subfolder: not ignored, hidden, a link, or build output. */
const scanned = (e: ScanEntry) =>
  e.kind === "dir" &&
  !e.isSymlink &&
  !e.ignored &&
  !e.name.startsWith(".") &&
  !SKIPPED_FOLDERS.has(e.name);

/**
 * The folders below the root that detection looks at (D203): level by level down to `depth`
 * (1: the first-level folders), at most `max` listed in all, the shallow ones first. A Cargo,
 * Gradle or Maven folder's members aren't detected again (they're its build's), so its kinds pass
 * down in `skip`. `list(rel)` lists a folder (empty when it can't be read).
 */
export async function foldersToScan(
  rootEntries: readonly ScanEntry[],
  depth: number,
  list: (rel: string) => Promise<readonly ScanEntry[]>,
  max = MAX_SCANNED_FOLDERS,
): Promise<ScannedFolder[]> {
  const out: ScannedFolder[] = [];
  let level: { rel: string; skip: Set<string> }[] = rootEntries
    .filter(scanned)
    .map((e) => ({ rel: e.name, skip: buildKinds(rootEntries.map((x) => x.name)) }));
  for (let d = 1; d <= depth && level.length && out.length < max; d++) {
    const batch = level.slice(0, max - out.length);
    const listed = await Promise.all(batch.map((f) => list(f.rel).catch(() => [])));
    const next: { rel: string; skip: Set<string> }[] = [];
    batch.forEach((f, i) => {
      const entries = listed[i] ?? [];
      const names = entries.map((e) => e.name);
      out.push({ rel: f.rel, names, skip: f.skip });
      if (d === depth) return;
      const skip = new Set([...f.skip, ...buildKinds(names)]);
      for (const e of entries) if (scanned(e)) next.push({ rel: `${f.rel}/${e.name}`, skip });
    });
    level = next;
  }
  return out;
}

// ---- Makefile ----------------------------------------------------------------------------------

/**
 * The targets a Makefile defines, in order: rule names (`build:`, `a b: deps`, `test::`), without
 * variable assignments (`X := 1`, `X = a:b`), pattern rules (`%.o:`), special targets
 * (`.PHONY`), names with `$(…)`, and files (`out/app.o`) unless declared `.PHONY`.
 */
export function makefileTargets(text: string): string[] {
  const lines = text.replace(/\\\r?\n/g, " ").split(/\r?\n/);
  const targets: string[] = [];
  const phony = new Set<string>();
  let inDefine = false;
  for (const raw of lines) {
    if (/^\s*define\b/.test(raw)) {
      inDefine = true;
      continue;
    }
    if (inDefine) {
      if (/^\s*endef\b/.test(raw)) inDefine = false;
      continue;
    }
    // Recipe lines start with a tab; comments go to the end of the line.
    if (raw.startsWith("\t")) continue;
    const line = raw.replace(/#.*$/, "");
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const head = line.slice(0, colon);
    // `X = a:b`, `X := y`, `X ::= y`, `X ?= y`: assignments, not rules.
    if (head.includes("=")) continue;
    const after = line.slice(colon + 1);
    if (/^:?=/.test(after)) continue;
    const names = head.trim().split(/\s+/);
    if (head.trim() === ".PHONY") {
      for (const n of after.replace(/^:/, "").trim().split(/\s+/)) if (n) phony.add(n);
      continue;
    }
    for (const name of names) {
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.+/-]*$/.test(name)) continue;
      if (!targets.includes(name)) targets.push(name);
    }
  }
  // A target that looks like a file (a dot or a slash in it) is left out unless it's phony.
  return targets.filter((t) => phony.has(t) || !/[./]/.test(t)).slice(0, 100);
}

/**
 * What `make` prints with `-p` (its database): GNU make's "# Files" section lists every target,
 * including those `$(foreach …)` / `$(eval …)` and included makefiles make; a "# Not a target:"
 * entry is a file make only looked at. The targets, with the same filters as `makefileTargets`
 * (no special or pattern targets, no files unless phony, not the makefiles themselves), in
 * `order` first (the text's order) and then by name. Null when it isn't a database GNU make
 * printed (another make, an error): the caller reads the text instead.
 */
export function makeDatabaseTargets(
  output: string,
  order: readonly string[] = [],
): string[] | null {
  const lines = output.split(/\r?\n/);
  const start = lines.indexOf("# Files");
  if (start < 0) return null;
  const found = new Set<string>();
  const phony = new Set<string>();
  /** No rule line yet since the last blank line, and whether "# Not a target:" came before. */
  let entryStart = true;
  let notTarget = false;
  /** The current entry's names (its "#  Phony target" note marks them phony). */
  let names: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // The section ends where the next one starts ("# files hash-table stats:", "# VPATH…").
    if (/^# (files hash-table stats|VPATH Search Paths|Finished Make data base)/.test(line)) break;
    if (line === "") {
      entryStart = true;
      notTarget = false;
      continue;
    }
    if (line === "# Not a target:") {
      notTarget = true;
      continue;
    }
    // Notes ("#  Phony target…", "#  File does not exist.") and the recipe follow the rule line.
    if (line.startsWith("#") || line.startsWith("\t")) {
      if (line.startsWith("#  Phony target")) for (const n of names) phony.add(n);
      continue;
    }
    if (!entryStart) continue;
    // A drive letter isn't the rule's colon (`C:/src/x.o: …` from a Windows make).
    const colon = line.replace(/^[A-Za-z]:[\\/]/, "  ").indexOf(":");
    const head = colon > 0 ? line.slice(0, colon).trim() : "";
    const after = line.slice(colon + 1);
    // A target-specific variable (`debug: CFLAGS := -g`) comes before its target's rule line.
    if (head && /^:?\s*[\w.-]+\s*(?:::|[:+?!])?=/.test(after)) continue;
    entryStart = false;
    names = [];
    if (!head || head.includes("=") || /^:?=/.test(after)) continue;
    if (head === ".PHONY") {
      for (const n of after.replace(/^:/, "").trim().split(/\s+/)) if (n) phony.add(n);
      continue;
    }
    if (notTarget) continue;
    names = head.split(/\s+/).filter(Boolean);
    for (const name of names) found.add(name);
  }
  const keep = (t: string) =>
    /^[A-Za-z0-9_][A-Za-z0-9_.+/-]*$/.test(t) &&
    !MAKEFILES.includes(t) &&
    !/\.mk$/.test(t) &&
    (phony.has(t) || !/[./]/.test(t));
  const targets = [...found].filter(keep);
  const ordered = order.filter((t) => targets.includes(t));
  const rest = targets.filter((t) => !ordered.includes(t)).sort();
  return [...ordered, ...rest].slice(0, 100);
}

/** The arguments detection runs make with: print the database, run nothing (`.DEFAULT`: no goal). */
export const MAKE_DATABASE_ARGS = ["-p", "-n", "-q", "-r", ".DEFAULT"] as const;

// ---- gulp / grunt -------------------------------------------------------------------------------

/**
 * Task names that go on a command line as they are (`gulp build:css`): no spaces, quotes or shell
 * characters, so a label can't hide another command (D201).
 */
const SAFE_TASK_NAME = /^[\w:.@/-]{1,100}$/;

/** gulp tasks: `exports.name =`, `export function name`, `export default`, `gulp.task("name"`. */
export function gulpTasks(text: string): string[] {
  const out: string[] = [];
  const add = (n: string | undefined) => {
    if (n && SAFE_TASK_NAME.test(n) && !out.includes(n)) out.push(n);
  };
  for (const m of text.matchAll(/\bgulp\.task\(\s*['"`]([^'"`]+)['"`]/g)) add(m[1]);
  for (const m of text.matchAll(/\bexports\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) add(m[1]);
  for (const m of text.matchAll(
    /^export\s+(?:async\s+)?(?:function\*?|const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
  ))
    add(m[1]);
  // `export { build, test as check }`
  for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm))
    for (const part of (m[1] ?? "").split(","))
      add(
        part
          .trim()
          .split(/\s+as\s+/)
          .pop()
          ?.trim(),
      );
  if (/^export\s+default\b/m.test(text) || /\bexports\.default\s*=/.test(text)) add("default");
  return out.slice(0, 100);
}

/** grunt tasks: `grunt.registerTask("name"` (and `registerMultiTask`). */
export function gruntTasks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\bregister(?:Multi)?Task\(\s*['"`]([^'"`]+)['"`]/g))
    if (m[1] && SAFE_TASK_NAME.test(m[1]) && !out.includes(m[1])) out.push(m[1]);
  return out.slice(0, 100);
}

// ---- Gradle / Cargo ----------------------------------------------------------------------------

/** Whether a Gradle build file applies the `application` plugin (so `gradle run` exists). */
export function gradleHasApplication(text: string): boolean {
  return (
    /\bid\s*\(?\s*['"]application['"]/.test(text) ||
    /apply\s*\(?\s*plugin\s*[:=]\s*['"]application['"]/.test(text) ||
    /^\s*application\s*\{/m.test(text) ||
    /^\s*`?application`?\s*$/m.test(text)
  );
}

/** What a Cargo.toml declares: a package (buildable, maybe runnable), binaries, a workspace. */
export function cargoManifest(text: string): {
  package: boolean;
  workspace: boolean;
  bins: number;
} {
  return {
    package: /^\s*\[package\]/m.test(text),
    workspace: /^\s*\[workspace\]/m.test(text),
    bins: [...text.matchAll(/^\s*\[\[bin\]\]/gm)].length,
  };
}

// ---- Tasks -------------------------------------------------------------------------------------

const looksBackground = (name: string) => /\b(dev|serve|server|start|watch|preview)\b/.test(name);

/** How a project-local program is run from its folder (`node_modules/.bin`), else from PATH. */
function program(name: string, folder: DetectFolder, platform: Platform): string {
  if (!folder.localBins?.includes(name)) return name;
  return platform === "windows"
    ? `.\\node_modules\\.bin\\${name}.cmd`
    : `node_modules/.bin/${name}`;
}

/** A wrapper script in the folder (`gradlew`, `mvnw`), else the program from PATH. */
function wrapper(folder: DetectFolder, name: string, global: string, platform: Platform): string {
  if (platform === "windows") {
    for (const ext of [".bat", ".cmd"])
      if (folder.names.includes(`${name}${ext}`)) return `.\\${name}${ext}`;
    return global;
  }
  return folder.names.includes(name) ? `./${name}` : global;
}

/** A matcher whose relative paths are read from the task's folder (not the workspace root). */
function matcherIn(name: string, folder: DetectFolder, kind = "relative"): unknown {
  return folder.rel
    ? { base: name, fileLocation: [kind, `\${workspaceFolder}/${folder.rel}`] }
    : name;
}

interface Made {
  label: string;
  command: string;
  source: string;
  group?: "build" | "test";
  background?: boolean;
  problemMatcher?: unknown;
  detail?: string;
  /** The label names the folder itself ("tsc: build - app/tsconfig.json"). */
  ownFolder?: boolean;
}

function task(m: Made, folder: DetectFolder): TaskDefinition {
  const suffix = folder.rel && !m.ownFolder ? ` - ${folder.rel}` : "";
  return {
    label: `${m.label}${suffix}`,
    command: m.command,
    spec: { kind: "shell", command: m.command },
    cwd: folder.abs,
    folder: folder.rel,
    ...(m.group && { group: { kind: m.group, isDefault: false } }),
    background: m.background ?? false,
    dependsOn: [],
    dependsOrder: "parallel",
    source: folder.rel ? `${folder.rel}/${m.source}` : m.source,
    ...(m.detail && { detail: m.detail }),
    problemMatcher: m.problemMatcher ?? [],
    presentation: DEFAULT_PRESENTATION,
    runOnFolderOpen: false,
    hide: false,
  };
}

/** Which kinds of build file a folder has (so subfolders of a Cargo or Gradle root are skipped). */
export function buildKinds(names: readonly string[]): Set<string> {
  const kinds = new Set<string>();
  if (names.includes("Cargo.toml")) kinds.add("cargo");
  if (names.some((n) => GRADLE.includes(n))) kinds.add("gradle");
  if (names.includes("pom.xml")) kinds.add("maven");
  return kinds;
}

/**
 * The platform whose command syntax detected tasks are written in: Windows' own (`.\x.cmd`) only
 * when the task shell reads it. With Git Bash (or another POSIX shell) as the default terminal
 * profile on Windows, tasks run in bash, which ate the backslashes (exit 127): they get the POSIX
 * form there (`node_modules/.bin/tsc`, `./gradlew`), whose scripts Git Bash runs.
 */
export function detectSyntax(platform: Platform, shell: TaskShellKind): Platform {
  return platform === "windows" && shell === "posix" ? "linux" : platform;
}

/**
 * The tasks found in one folder. `skip` names build kinds the root already covers (a Cargo or
 * Gradle workspace builds its members; a Maven parent its modules).
 */
export function detectTasks(
  folder: DetectFolder,
  platform: Platform,
  skip: ReadonlySet<string> = new Set(),
): TaskDefinition[] {
  const out: TaskDefinition[] = [];
  const add = (m: Made) => out.push(task(m, folder));

  // TypeScript: build and watch per tsconfig, run from the tsconfig's folder.
  const tsc = program("tsc", folder, platform);
  for (const config of tsconfigNames(folder.names)) {
    const shown = folder.rel ? `${folder.rel}/${config}` : config;
    add({
      label: `tsc: build - ${shown}`,
      ownFolder: true,
      command: `${tsc} -p ${config}`,
      source: config,
      group: "build",
      problemMatcher: matcherIn("$tsc", folder),
    });
    add({
      label: `tsc: watch - ${shown}`,
      ownFolder: true,
      command: `${tsc} --watch -p ${config}`,
      source: config,
      group: "build",
      background: true,
      problemMatcher: matcherIn("$tsc-watch", folder),
    });
  }

  // Make: one task per target.
  const makefile = MAKEFILES.find((n) => folder.files[n] !== undefined);
  if (makefile) {
    const targets = folder.makeTargets ?? makefileTargets(folder.files[makefile] ?? "");
    for (const target of targets) {
      const group =
        target === "all" || target === "build"
          ? "build"
          : target === "test" || target === "check"
            ? "test"
            : undefined;
      add({
        label: `make: ${target}`,
        command: `make ${target}`,
        source: makefile,
        ...(group && { group }),
        background: looksBackground(target),
        problemMatcher: matcherIn("$gcc", folder, "autoDetect"),
      });
    }
  }

  // Cargo: build, check, test, and run for a package with a binary.
  const cargo = folder.files["Cargo.toml"];
  if (cargo !== undefined && !skip.has("cargo")) {
    const manifest = cargoManifest(cargo);
    const matcher = matcherIn("$rustc", folder, "autoDetect");
    add({
      label: "cargo: build",
      command: "cargo build",
      source: "Cargo.toml",
      group: "build",
      problemMatcher: matcher,
    });
    add({
      label: "cargo: check",
      command: "cargo check",
      source: "Cargo.toml",
      problemMatcher: matcher,
    });
    add({
      label: "cargo: test",
      command: "cargo test",
      source: "Cargo.toml",
      group: "test",
      problemMatcher: matcher,
    });
    if (manifest.package && (folder.cargoMain || manifest.bins > 0))
      add({
        label: "cargo: run",
        command: "cargo run",
        source: "Cargo.toml",
        problemMatcher: matcher,
      });
  }

  // Gradle: build and test, run with the application plugin.
  const gradleFile = GRADLE.find((n) => folder.files[n] !== undefined);
  if (gradleFile && !skip.has("gradle")) {
    const gradle = wrapper(folder, "gradlew", "gradle", platform);
    const text = GRADLE.map((n) => folder.files[n] ?? "").join("\n");
    add({ label: "gradle: build", command: `${gradle} build`, source: gradleFile, group: "build" });
    add({ label: "gradle: test", command: `${gradle} test`, source: gradleFile, group: "test" });
    if (gradleHasApplication(text))
      add({ label: "gradle: run", command: `${gradle} run`, source: gradleFile });
  }

  // Maven: the lifecycle's common phases.
  if (folder.names.includes("pom.xml") && !skip.has("maven")) {
    const mvn = wrapper(folder, "mvnw", "mvn", platform);
    add({ label: "maven: compile", command: `${mvn} compile`, source: "pom.xml", group: "build" });
    add({ label: "maven: test", command: `${mvn} test`, source: "pom.xml", group: "test" });
    add({ label: "maven: package", command: `${mvn} package`, source: "pom.xml" });
  }

  // gulp and grunt: the tasks their files register.
  const gulpfile = GULPFILES.find((n) => folder.files[n] !== undefined);
  if (gulpfile) {
    const gulp = program("gulp", folder, platform);
    for (const name of gulpTasks(folder.files[gulpfile] ?? ""))
      add({
        label: `gulp: ${name}`,
        command: name === "default" ? gulp : `${gulp} ${name}`,
        source: gulpfile,
        ...(name === "build" && { group: "build" as const }),
        ...(name === "test" && { group: "test" as const }),
        background: looksBackground(name),
      });
  }
  const gruntfile = GRUNTFILES.find((n) => folder.files[n] !== undefined);
  if (gruntfile) {
    const grunt = program("grunt", folder, platform);
    for (const name of gruntTasks(folder.files[gruntfile] ?? ""))
      add({
        label: `grunt: ${name}`,
        command: name === "default" ? grunt : `${grunt} ${name}`,
        source: gruntfile,
        ...(name === "build" && { group: "build" as const }),
        ...(name === "test" && { group: "test" as const }),
        background: looksBackground(name),
      });
  }
  return out;
}

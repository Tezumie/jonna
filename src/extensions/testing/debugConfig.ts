// "Debug test" (D204): the launch configuration that runs one test (or a file's tests) under the
// debugger, in launch.json's shape, for `debug.start {configuration}`. Node frameworks run in
// one process so breakpoints bind: node:test runs the file itself with a name pattern, Jest with
// --runInBand, Mocha as it is; pytest and unittest run as modules under debugpy. DOM-free and
// tested.
import type { Framework, TestCase } from "./model";
import { unittestModule } from "./model";

export interface DebugTarget {
  framework: Framework;
  /** Relative to the project folder. */
  file: string;
  /** Without it: the file's tests. */
  test?: Pick<TestCase, "path" | "line">;
  /** The project folder, absolute. */
  cwd: string;
  /** The node_modules folder the runner is in (absolute; default: the project's). */
  nodeModules?: string;
}

/** The package whose script runs a Node framework's tests under the debugger. */
export function debugPackage(framework: Framework): string | null {
  return framework === "jest" ? "jest" : framework === "mocha" ? "mocha" : null;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Frameworks "Debug test" supports, and why the others aren't (shown as the error). */
export function debugUnsupported(framework: Framework): string | null {
  switch (framework) {
    case "vitest":
      return "Debugging Vitest tests isn't supported yet (its tests run in worker threads). Run `npx vitest --inspect-brk --no-file-parallelism` and attach (debug.start with an attach configuration).";
    case "playwright":
      return "Debugging Playwright tests isn't supported yet (they run in worker processes). Use `npx playwright test --debug` in a terminal.";
    case "cargo":
    case "go":
      return `Debugging ${framework === "go" ? "Go" : "Rust"} tests isn't supported yet: add a launch.json configuration (lldb-dap for Rust, a Delve adapter for Go).`;
    default:
      return null;
  }
}

/** The configuration, or null when the framework can't be debugged (see debugUnsupported). */
export function debugConfiguration(
  target: DebugTarget,
  windows: boolean,
): Record<string, unknown> | null {
  const sep = windows ? "\\" : "/";
  const abs = (rel: string) =>
    `${target.cwd.replace(/[\\/]+$/, "")}${sep}${rel.replace(/\//g, sep)}`;
  const t = target.test;
  const name = `Debug ${t ? (t.path.at(-1) ?? "test") : (target.file.split("/").pop() ?? "tests")}`;
  const base = { name, request: "launch", cwd: target.cwd, console: "integratedTerminal" };
  const fullPattern = t ? `^${escapeRegex(t.path.join(" "))}$` : "";
  const bin = (...parts: string[]) =>
    target.nodeModules
      ? `${target.nodeModules.replace(/[\\/]+$/, "")}${sep}${parts.join(sep)}`
      : abs(["node_modules", ...parts].join("/"));
  switch (target.framework) {
    case "node": {
      const ts = /\.(ts|tsx|mts|cts)$/.test(target.file);
      return {
        ...base,
        type: "node",
        program: abs(target.file),
        // Run directly, the file's tests run in this process (`--test` would start a child).
        runtimeArgs: [
          ...(ts ? ["--import", "tsx"] : []),
          ...(t ? [`--test-name-pattern=^${escapeRegex(t.path.at(-1) ?? "")}$`] : []),
        ],
        args: [],
      };
    }
    case "jest":
      return {
        ...base,
        type: "node",
        program: bin("jest", "bin", "jest.js"),
        args: [
          "--runInBand",
          "--watchAll=false",
          "--runTestsByPath",
          target.file,
          ...(t ? ["-t", fullPattern] : []),
        ],
      };
    case "mocha":
      return {
        ...base,
        type: "node",
        // _mocha runs the tests in its own process (mocha.js may start a child).
        program: bin("mocha", "bin", "_mocha"),
        args: ["--no-timeouts", ...(t ? ["--grep", fullPattern] : []), target.file],
      };
    case "pytest":
      return {
        ...base,
        type: "debugpy",
        module: "pytest",
        args: [t ? `${target.file}::${t.path.join("::")}` : target.file, "--no-header", "-q"],
        justMyCode: false,
      };
    case "unittest":
      return {
        ...base,
        type: "debugpy",
        module: "unittest",
        args: [
          "-v",
          t ? `${unittestModule(target.file)}.${t.path.join(".")}` : unittestModule(target.file),
        ],
        justMyCode: false,
      };
    default:
      return null;
  }
}

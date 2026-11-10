// Command-script tests (PLAN §14): a JSONC file of steps that run commands as `caller: test`,
// read state paths and compare results with partial expectations. The app runs one with
// `--run-test-script <file>` and exits with 0 (all passed) or 1. DOM-free and unit-tested.
import { parseJsonc } from "../settings/jsonc";

export interface TestStep {
  /** Shown in the log; defaults to the command or state path. */
  name?: string;
  /** Command id to execute. */
  run?: string;
  input?: unknown;
  /** Read a state path (`ide://…`) instead of running a command. */
  state?: string;
  /** Partial match against the result (see `matchValue`). */
  expect?: unknown;
  /** The step must fail; a string must appear in the error message. */
  expectError?: string | true;
  /** Repeat run/state until `expect` matches or this many ms pass. */
  timeoutMs?: number;
  /** Sleep this long (ms). */
  wait?: number;
  /** Print the result as JSON in the log (measurements, debugging). */
  print?: boolean;
  /** Log how long the step took (with its retries until `expect` matched). */
  time?: boolean;
  /** Start `run` and go on without waiting (a picker the next steps answer); errors are logged. */
  background?: boolean;
  /**
   * Keeps the result under this name: later steps' `input`, `state` and `expect` may say
   * `"${name.field}"` (the value itself) or embed it in a string ("ide://terminals/${t.id}/output").
   * For ids a test can't know in advance.
   */
  save?: string;
}

const WHOLE_REF = /^\$\{(\w+)((?:\.\w+)*)\}$/;
const SOME_REF = /\$\{(\w+)((?:\.\w+)*)\}/g;

function lookup(vars: Map<string, unknown>, name: string, path: string): unknown {
  let value = vars.get(name);
  for (const key of path.split(".").filter(Boolean))
    value =
      value !== null && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined;
  return value;
}

/** `${name.path}` references in a step's values replaced by saved results (see `save`). */
/** Longest string a printed value keeps whole (an inline screenshot's base64 is ~1 MB). */
const PRINTED_STRING_MAX = 2000;
/** Longest value printed with a failed expectation. */
const FAILED_VALUE_MAX = 1500;
/** Longest printed line. */
const PRINTED_LINE_MAX = 20_000;

/**
 * A step's value as `print` writes it: JSON with long strings shortened. A line of a megabyte
 * stalled CI's log reader, and the run with it (D396); a picture is read from a saved file.
 */
export function printable(value: unknown): string {
  const text =
    JSON.stringify(value, (_key, v: unknown) =>
      typeof v === "string" && v.length > PRINTED_STRING_MAX
        ? `${v.slice(0, 80)}… (${v.length} characters)`
        : v,
    ) ?? String(value);
  return text.length > PRINTED_LINE_MAX
    ? `${text.slice(0, PRINTED_LINE_MAX)}… (${text.length} characters)`
    : text;
}

export function substituteRefs(value: unknown, vars: Map<string, unknown>): unknown {
  if (!vars.size) return value;
  if (typeof value === "string") {
    const whole = WHOLE_REF.exec(value);
    if (whole?.[1] && vars.has(whole[1])) return lookup(vars, whole[1], whole[2] ?? "");
    return value.replace(SOME_REF, (ref, name: string, path: string) =>
      vars.has(name) ? String(lookup(vars, name, path)) : ref,
    );
  }
  if (Array.isArray(value)) return value.map((v) => substituteRefs(v, vars));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteRefs(v, vars)]));
  return value;
}

export interface TestScript {
  name?: string;
  /** For scripts/ui-test.mjs: the GitHub CLI is the offline stand-in (tests/fixtures/fake-gh). */
  fakeGh?: boolean;
  /**
   * For scripts/ui-test.mjs: the OSes it runs on (Node's names: "linux", "darwin", "win32"),
   * for what only some have (zsh and fish profiles); skipped elsewhere. Default: all.
   */
  platforms?: string[];
  steps: TestStep[];
}

export interface TestHost {
  execute(command: string, input: unknown): Promise<unknown>;
  state(path: string): Promise<unknown>;
  log(line: string): void;
}

export interface TestResult {
  passed: number;
  failed: number;
  failures: { step: number; name: string; message: string }[];
}

export function parseTestScript(text: string): TestScript {
  const parsed = parseJsonc(text);
  if (!parsed.ok)
    throw new Error(`test script: ${parsed.error.message} (line ${parsed.error.line})`);
  const value = parsed.value as Partial<TestScript> | null;
  if (!value || !Array.isArray(value.steps)) throw new Error('test script needs a "steps" array');
  return {
    ...(typeof value.name === "string" && { name: value.name }),
    steps: value.steps as TestStep[],
  };
}

type Matcher = {
  $gte?: number;
  $lte?: number;
  $contains?: string;
  $exists?: boolean;
  $length?: number;
  $not?: unknown;
};

function isMatcher(v: unknown): v is Matcher {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.keys(v).some((k) => k.startsWith("$"))
  );
}

/**
 * Returns undefined if `actual` matches `expected`, else a description of the first mismatch.
 * Objects match when every expected key matches (extra keys are fine); arrays match element by
 * element for the expected length; `{ $gte, $lte, $contains, $exists, $length, $not }` compare.
 */
export function matchValue(actual: unknown, expected: unknown, path = "$"): string | undefined {
  if (isMatcher(expected)) {
    const m = expected;
    if (m.$exists !== undefined && (actual !== undefined) !== m.$exists)
      return `${path}: expected ${m.$exists ? "a value" : "no value"}`;
    if (m.$gte !== undefined && !(typeof actual === "number" && actual >= m.$gte))
      return `${path}: expected ≥ ${m.$gte}, got ${JSON.stringify(actual)}`;
    if (m.$lte !== undefined && !(typeof actual === "number" && actual <= m.$lte))
      return `${path}: expected ≤ ${m.$lte}, got ${JSON.stringify(actual)}`;
    if (m.$contains !== undefined) {
      const hay = typeof actual === "string" ? actual : JSON.stringify(actual);
      if (!hay?.includes(m.$contains))
        return `${path}: expected to contain ${JSON.stringify(m.$contains)}`;
    }
    if (m.$length !== undefined) {
      const len = Array.isArray(actual) || typeof actual === "string" ? actual.length : undefined;
      if (len !== m.$length) return `${path}: expected length ${m.$length}, got ${len}`;
    }
    if (m.$not !== undefined && matchValue(actual, m.$not, path) === undefined)
      return `${path}: expected not to match ${JSON.stringify(m.$not)}`;
    return undefined;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${path}: expected an array, got ${JSON.stringify(actual)}`;
    for (let i = 0; i < expected.length; i++) {
      const miss = matchValue(actual[i], expected[i], `${path}[${i}]`);
      if (miss) return miss;
    }
    return undefined;
  }
  if (typeof expected === "object" && expected !== null) {
    if (typeof actual !== "object" || actual === null)
      return `${path}: expected an object, got ${JSON.stringify(actual)}`;
    for (const [key, value] of Object.entries(expected)) {
      const miss = matchValue((actual as Record<string, unknown>)[key], value, `${path}.${key}`);
      if (miss) return miss;
    }
    return undefined;
  }
  return Object.is(actual, expected)
    ? undefined
    : `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs every step (a failure doesn't stop the script) and logs TAP-like lines. */
export async function runTestScript(script: TestScript, host: TestHost): Promise<TestResult> {
  const result: TestResult = { passed: 0, failed: 0, failures: [] };
  host.log(`# ${script.name ?? "test script"}: ${script.steps.length} steps`);
  const vars = new Map<string, unknown>();
  for (const [i, raw] of script.steps.entries()) {
    const step: TestStep = {
      ...raw,
      ...(raw.input !== undefined && { input: substituteRefs(raw.input, vars) }),
      ...(raw.state !== undefined && { state: String(substituteRefs(raw.state, vars)) }),
      ...(raw.expect !== undefined && { expect: substituteRefs(raw.expect, vars) }),
    };
    const name =
      step.name ??
      step.run ??
      step.state ??
      (step.wait !== undefined ? `wait ${step.wait}ms` : "step");
    const started = Date.now();
    const message = await runStep(step, host, (value) => {
      if (step.save) vars.set(step.save, value);
    });
    if (message === undefined) {
      result.passed++;
      // `time`: how long the step took, for measuring (D254).
      host.log(`ok ${i + 1} - ${name}${step.time ? ` (${Date.now() - started} ms)` : ""}`);
    } else {
      result.failed++;
      result.failures.push({ step: i + 1, name, message });
      host.log(`not ok ${i + 1} - ${name}\n  # ${message.replaceAll("\n", "\n  # ")}`);
    }
  }
  host.log(`# passed ${result.passed}, failed ${result.failed}`);
  return result;
}

async function runStep(
  step: TestStep,
  host: TestHost,
  keep: (value: unknown) => void,
): Promise<string | undefined> {
  if (step.wait !== undefined && !step.run && !step.state) {
    await sleep(step.wait);
    return undefined;
  }
  if (step.background && step.run) {
    const id = step.run;
    void host.execute(id, step.input ?? {}).then(
      (value) => {
        if (step.print) host.log(`  # background ${id} → ${printable(value)}`);
      },
      (err: unknown) => {
        host.log(
          `  # background ${id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
    return undefined;
  }
  // The value a failed expectation saw, logged with the failure: a CI log is all there is to go
  // by (D400), and the step's own output (a command's) usually says why.
  let seen: { value: unknown } | undefined;
  const once = async (): Promise<string | undefined> => {
    seen = undefined;
    let value: unknown;
    try {
      value = step.run
        ? await host.execute(step.run, step.input ?? {})
        : step.state
          ? await host.state(step.state)
          : undefined;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (step.expectError === undefined) return `failed: ${msg}`;
      return step.expectError === true || msg.includes(step.expectError)
        ? undefined
        : `wrong error: ${msg}`;
    }
    if (step.expectError !== undefined) return "expected an error, but it succeeded";
    if (step.print) host.log(`  # ${printable(value)}`);
    keep(value);
    if (step.expect === undefined) return undefined;
    seen = { value };
    return matchValue(value, step.expect);
  };
  const deadline = Date.now() + (step.timeoutMs ?? 0);
  let message = await once();
  while (message !== undefined && Date.now() < deadline) {
    await sleep(100);
    message = await once();
  }
  if (message !== undefined && seen && !step.print) {
    const value = printable(seen.value);
    const shown = value.length > FAILED_VALUE_MAX ? `${value.slice(0, FAILED_VALUE_MAX)}…` : value;
    return `${message}\ngot: ${shown}`;
  }
  return message;
}

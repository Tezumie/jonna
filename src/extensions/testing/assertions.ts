// Expected and actual values of a failed assertion (D204, VS Code's "Compare expected with
// actual"), DOM-free and tested: from the values a framework reports (Jest's failureDetails,
// Mocha's err.expected / err.actual, node:test's YAML) or else from the diff it printed (Jest,
// Vitest and Playwright "- Expected / + Received", Node's assert "+ actual - expected", pytest's
// "assert a == b" and "Full diff", unittest's "a != b").

export interface ExpectedActual {
  expected: string;
  actual: string;
}

const MAX = 200_000;

/** A reported value as text: strings as they are, the rest as indented JSON. */
export function valueText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined) return "undefined";
  try {
    const s = JSON.stringify(v, null, 2);
    return s === undefined ? String(v) : s;
  } catch {
    return String(v);
  }
}

/** Both values reported (either may be a falsy value, but both keys must be there). */
export function fromValues(holder: unknown): ExpectedActual | null {
  if (!holder || typeof holder !== "object") return null;
  const o = holder as Record<string, unknown>;
  if (!("expected" in o) || !("actual" in o)) return null;
  const expected = valueText(o.expected).slice(0, MAX);
  const actual = valueText(o.actual).slice(0, MAX);
  return expected === actual ? null : { expected, actual };
}

/** Jest's `failureDetails` (one per failure message): the first with a matcher's values. */
export function fromJestFailureDetails(details: unknown): ExpectedActual | null {
  if (!Array.isArray(details)) return null;
  for (const d of details) {
    const r = (d as { matcherResult?: unknown } | null)?.matcherResult;
    const found = fromValues(r);
    if (found) return found;
  }
  return null;
}

/**
 * The lines of a printed diff under its header: `minus` lines are one side, `plus` the other, the
 * rest (two spaces in front) both. Ends at a stack trace or the end of the diff's lines.
 */
function sidesFromDiff(lines: readonly string[], start: number): { minus: string; plus: string } {
  const minus: string[] = [];
  const plus: string[] = [];
  let i = start;
  // A blank line may separate header and diff.
  while (i < lines.length && !(lines[i] ?? "").trim()) i++;
  for (; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (/^\s+at\s/.test(l) || /^\s*(?:❯|›)\s/.test(l)) break;
    if (l.startsWith("- ") || l === "-") minus.push(l.slice(2));
    else if (l.startsWith("+ ") || l === "+") plus.push(l.slice(2));
    else if (l.startsWith("  ") || l === "") {
      // A blank line followed by something that isn't diff: the diff is over.
      if (l === "") {
        const next = lines[i + 1] ?? "";
        if (!/^(?:[-+] | {2})/.test(next)) break;
      }
      minus.push(l.slice(2));
      plus.push(l.slice(2));
    } else break;
  }
  const trim = (a: string[]) => {
    while (a.length && !a.at(-1)?.trim()) a.pop();
    return a.join("\n");
  };
  return { minus: trim(minus), plus: trim(plus) };
}

/** From a failure's printed text; null when it shows no comparison. */
export function fromMessage(message: string): ExpectedActual | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
  const text = message.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").slice(0, MAX);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = (lines[i] ?? "").trim();
    // Jest / Vitest / Playwright: "- Expected  - 1" then "+ Received  + 1".
    if (/^- Expected\b/.test(l) && /^\+ Received\b/.test((lines[i + 1] ?? "").trim())) {
      const { minus, plus } = sidesFromDiff(lines, i + 2);
      if (minus !== plus) return { expected: minus, actual: plus };
    }
    // Node's assert: "+ actual - expected".
    if (/^\+ actual - expected\b/.test(l)) {
      const { minus, plus } = sidesFromDiff(lines, i + 1);
      if (minus !== plus) return { expected: minus, actual: plus };
    }
    // Jest's toBe and Playwright's matchers: "Expected: 2" then "Received: 1".
    const exp = /^Expected(?: value)?(?: string| pattern| substring)?:\s?(.*)$/.exec(l);
    if (exp) {
      for (let k = i + 1; k < Math.min(lines.length, i + 4); k++) {
        const rec = /^Received(?: value)?(?: string)?:\s?(.*)$/.exec((lines[k] ?? "").trim());
        if (rec) return { expected: unquote(exp[1] ?? ""), actual: unquote(rec[1] ?? "") };
      }
    }
  }
  return fromPytest(lines) ?? fromUnittest(lines);
}

/** `"a"` / `'a'` → a (one-line values printed quoted). */
function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t.at(-1) === t[0])
    return t.slice(1, -1).replace(/\\n/g, "\n");
  return t;
}

/** pytest's assertion rewriting: "Full diff:" (- right, + left), else "assert left == right". */
function fromPytest(lines: readonly string[]): ExpectedActual | null {
  const full = lines.findIndex((l) => /^E\s+Full diff:\s*$/.test(l));
  if (full >= 0) {
    const col = (lines[full] ?? "").indexOf("Full diff:");
    const expected: string[] = [];
    const actual: string[] = [];
    for (let i = full + 1; i < lines.length; i++) {
      const l = lines[i] ?? "";
      if (!l.startsWith("E")) break;
      const mark = l[col] ?? " ";
      const rest = l.slice(col + 2);
      if (mark === "?") continue;
      if (mark === "-") expected.push(rest);
      else if (mark === "+") actual.push(rest);
      else {
        expected.push(rest);
        actual.push(rest);
      }
    }
    if (expected.length || actual.length)
      return { expected: expected.join("\n"), actual: actual.join("\n") };
  }
  for (const l of lines) {
    const m = /^E\s+(?:AssertionError: )?assert (.+?) == (.+)$/.exec(l);
    if (m) {
      const actual = unquote(m[1] ?? "");
      const expected = unquote(m[2] ?? "");
      if (actual !== expected) return { expected, actual };
    }
  }
  return null;
}

/** unittest's assertEqual(first, second): "AssertionError: first != second". */
function fromUnittest(lines: readonly string[]): ExpectedActual | null {
  for (const l of lines) {
    const m = /^(?:E\s+)?AssertionError: (.+?) != (.+?)(?: : .*)?$/.exec(l.trim());
    if (m) return { actual: unquote(m[1] ?? ""), expected: unquote(m[2] ?? "") };
  }
  return null;
}

/**
 * node:test's YAML block (already dedented): `expected:` / `actual:` as a scalar, a `|-` block or
 * a nested map (kept as printed).
 */
export function fromTapYaml(yaml: string): ExpectedActual | null {
  const lines = yaml.split(/\r?\n/);
  const read = (key: string): string | null => {
    const i = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (i < 0) return null;
    const rest = (lines[i] ?? "").slice(key.length + 1).trim();
    const body: string[] = [];
    for (let k = i + 1; k < lines.length; k++) {
      const l = lines[k] ?? "";
      if (l && !/^\s/.test(l)) break;
      body.push(l);
    }
    const indent = Math.min(
      ...body.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)?.[0].length ?? 0),
    );
    const block = body.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join("\n");
    if (rest === "|-" || rest === "|" || rest === ">-" || rest === "") return block.trimEnd();
    if (/^'.*'$/.test(rest)) return rest.slice(1, -1).replace(/''/g, "'");
    if (/^".*"$/.test(rest)) {
      try {
        return JSON.parse(rest) as string;
      } catch {
        return rest.slice(1, -1);
      }
    }
    return rest;
  };
  const expected = read("expected");
  const actual = read("actual");
  if (expected === null || actual === null || expected === actual) return null;
  return { expected, actual };
}

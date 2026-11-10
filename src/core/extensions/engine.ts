// Whether an extension's `engines.vscode` range accepts the VS Code version the shim follows,
// as VS Code checks it (extensionValidator's isValidVersion): "*", "^1.80.0" and ">=1.80.0"
// (a pre-release suffix like "-20260204" is ignored, "^" also needs the same major), and "1.80.x".
// DOM-free and unit-tested.

const parse = (v: string): [number, number, number] | null => {
  const m = /^(\d+|x)\.(\d+|x)\.(\d+|x)/.exec(v.trim());
  if (!m) return null;
  const n = (s: string | undefined) => (s === undefined || s === "x" ? 0 : Number(s));
  return [n(m[1]), n(m[2]), n(m[3])];
};

const compare = (a: [number, number, number], b: [number, number, number]) =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

export function engineSatisfied(range: string | undefined, version: string): boolean {
  const r = (range ?? "*").trim();
  if (!r || r === "*") return true;
  const have = parse(version);
  if (!have) return true;
  const caret = r.startsWith("^");
  const atLeast = r.startsWith(">=");
  const want = parse(r.replace(/^(\^|>=|~)/, ""));
  // A range we can't read doesn't block (VS Code would warn; installing is the safer guess).
  if (!want) return true;
  if (caret && want[0] !== have[0]) return false;
  if (caret || atLeast) return compare(have, want) >= 0;
  // "1.80.x" or an exact version: that minor (VS Code treats an exact one as a minimum too).
  return compare(have, want) >= 0;
}

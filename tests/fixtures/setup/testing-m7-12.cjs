// Writes what tests/scripts/testing-m7-12.jsonc uses, in the sample copy: a Mocha project whose
// `c8` is a fake (no network to install it) that prints Mocha's JSON reporter and writes an lcov
// report with a TN: record per test, so the run has per-test coverage (D233).
const fs = require("node:fs");
const path = require("node:path");
const w = (p, t, m) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, t);
  if (m) fs.chmodSync(p, m);
};

w(
  "moc/package.json",
  '{ "name": "moc", "private": true, "devDependencies": { "mocha": "10.0.0", "c8": "9.0.0" } }\n',
);
w(
  "moc/calc.js",
  [
    "exports.add = (a, b) => a + b;",
    "exports.sub = (a, b) => a - b;",
    "exports.mul = (a, b) => {",
    "  return a * b;",
    "};",
    "",
  ].join("\n"),
);
w(
  "moc/test/calc.test.js",
  [
    "const calc = require('../calc');",
    "describe('calc', () => {",
    "  it('adds', () => {",
    "    if (calc.add(1, 2) !== 3) throw new Error('add');",
    "  });",
    "  it('subs', () => {",
    "    if (calc.sub(3, 2) !== 1) throw new Error('sub');",
    "  });",
    "});",
    "",
  ].join("\n"),
);

const fakeC8 = `#!/usr/bin/env node
// A stand-in for c8 running Mocha: the JSON reporter's output, and lcov with a TN: per test.
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const at = args.indexOf("--reports-dir");
const dir = at >= 0 ? args[at + 1] : "coverage";
const calc = path.resolve("calc.js");
const file = path.resolve("test/calc.test.js");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
  path.join(dir, "lcov.info"),
  [
    "TN:calc adds", "SF:" + calc, "DA:1,1", "DA:2,0", "DA:4,0", "end_of_record",
    "TN:calc subs", "SF:" + calc, "DA:1,0", "DA:2,1", "DA:4,0", "end_of_record",
    "",
  ].join("\\n"),
);
const t = (title) => ({ title, fullTitle: "calc " + title, file, duration: 1, err: {} });
console.log(JSON.stringify({
  stats: { passes: 2, failures: 0, pending: 0 },
  tests: [t("adds"), t("subs")],
  passes: [t("adds"), t("subs")],
  failures: [],
  pending: [],
}));
`;
w(
  "moc/node_modules/c8/package.json",
  '{ "name": "c8", "version": "9.0.0", "bin": { "c8": "bin/c8.js" } }\n',
);
w("moc/node_modules/c8/bin/c8.js", fakeC8, 0o755);
w("moc/node_modules/.bin/c8", fakeC8, 0o755);
w("moc/node_modules/.bin/c8.cmd", '@node "%~dp0\\..\\c8\\bin\\c8.js" %*\r\n');

// Writes what tests/scripts/gaps-m7-11.jsonc uses, in the sample copy: a Jest project whose `jest`
// is a fake printing the JSON reporter with a colored failure (no network needed), and a Node
// program that prints a prompt without a line break, then the rest of it, for the debug console.
const fs = require("node:fs");
const path = require("node:path");
const w = (p, t, m) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, t);
  if (m) fs.chmodSync(p, m);
};

// Jest: a failure message in color (red, bold, a 256-color and a truecolor span).
w(
  "jst/package.json",
  '{ "name": "jst", "private": true, "devDependencies": { "jest": "29.0.0" } }\n',
);
w(
  "jst/sum.test.js",
  "describe('sums', () => {\n  test('adds', () => {\n    expect(1 + 1).toBe(2);\n  });\n  test('fails', () => {\n    expect(1 + 1).toBe(3);\n  });\n});\n",
);
const fakeJest = `#!/usr/bin/env node
// A stand-in for Jest's JSON reporter (the test machine has no network to install Jest).
const path = require("node:path");
const E = "\\u001b";
const file = path.resolve("sum.test.js");
const message = E + "[1m" + E + "[31mexpect(received).toBe(expected)" + E + "[39m" + E + "[22m\\n\\nExpected: " + E + "[32m3" + E + "[39m\\nReceived: " + E + "[31m2" + E + "[39m\\n" + E + "[38;5;208morange" + E + "[0m " + E + "[38;2;10;20;30mtruecolor" + E + "[0m" + E + "[2K";
const report = {
  numFailedTests: 1,
  numPassedTests: 1,
  numPendingTests: 0,
  testResults: [
    {
      name: file,
      assertionResults: [
        { ancestorTitles: ["sums"], title: "adds", status: "passed", duration: 1, failureMessages: [], location: { line: 2 } },
        { ancestorTitles: ["sums"], title: "fails", status: "failed", duration: 2, failureMessages: [message], location: { line: 5 } },
      ],
    },
  ],
};
console.log(JSON.stringify(report));
process.exitCode = 1;
`;
w(
  "jst/node_modules/jest/package.json",
  '{ "name": "jest", "version": "29.0.0", "bin": { "jest": "bin/jest.js" } }\n',
);
w("jst/node_modules/jest/bin/jest.js", fakeJest, 0o755);
w("jst/node_modules/.bin/jest", fakeJest, 0o755);
w("jst/node_modules/.bin/jest.cmd", '@node "%~dp0\\..\\jest\\bin\\jest.js" %*\r\n');

// A prompt without a line break: it must show before the rest comes (3 s later), and the rest
// continue its line; then a progress line redrawn with a carriage return.
w(
  "dbg11/prompt.js",
  [
    "process.stdout.write('Name? ');",
    "setTimeout(() => {",
    "  process.stdout.write('Bob\\n');",
    "  process.stdout.write('10%');",
    "  setTimeout(() => process.stdout.write('\\r100%\\ndone\\n'), 600);",
    "}, 3000);",
    "",
  ].join("\n"),
);
w(
  ".vscode/launch.json",
  `${JSON.stringify(
    {
      version: "0.2.0",
      configurations: [
        {
          name: "Prompt",
          type: "node",
          request: "launch",
          // The launch variable, spelled so it isn't read as a template placeholder.
          program: `${"$"}{workspaceFolder}/dbg11/prompt.js`,
          console: "internalConsole",
        },
      ],
    },
    null,
    2,
  )}\n`,
);
console.log("gaps fixtures written");

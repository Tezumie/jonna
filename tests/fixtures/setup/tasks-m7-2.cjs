// Writes the build files tests/scripts/tasks-m7-2.jsonc detects (D201): run in the sample copy.
const fs = require("node:fs");
const w = (p, t, m) => {
  fs.mkdirSync(require("node:path").dirname(p), { recursive: true });
  fs.writeFileSync(p, t);
  if (m) fs.chmodSync(p, m);
};
w(
  "native/Makefile",
  "CC := gcc\n.PHONY: hello test\nhello:\n\techo hello-from-make\ntest: hello\n\techo testing\nout/app.o: x\n",
);
w("rusty/Cargo.toml", '[package]\nname = "rusty"\nversion = "0.1.0"\n');
w("rusty/src/main.rs", "fn main() {}\n");
w("web/tsconfig.json", "{}\n");
w("web/gulpfile.js", "exports.build = (cb) => cb();\nexports.default = exports.build;\n");
w(
  "web/node_modules/.bin/tsc",
  '#!/usr/bin/env node\nconsole.log("src/app.ts(3,7): error TS2322: Web type is wrong.");\nprocess.exit(2);\n',
  0o755,
);
w("web/node_modules/.bin/tsc.cmd", '@node "%~dp0tsc" %*\r\n');
w("jvm/build.gradle", "plugins {\n  id 'application'\n}\n");
w("jvm/gradlew", "#!/bin/sh\n", 0o755);
w("jvm/pom.xml", "<project/>\n");
w("ct/math.mjs", "export const add = (a, b) => a + b;\n");
w(
  "ct/math.test.mjs",
  "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './math.mjs';\n\ntest('adds', () => {\n  assert.equal(add(1, 2), 3);\n});\n",
);

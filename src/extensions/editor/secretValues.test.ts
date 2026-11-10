import assert from "node:assert/strict";
import { test } from "node:test";
import { coveredRanges, DEFAULT_SECRET_FILES, isSecretFile, secretRanges } from "./secretValues";

test("isSecretFile: Zed's default private files, at any depth and on Windows", () => {
  const yes = [
    "/w/.env",
    "/w/.env.local",
    "C:\\w\\api\\.env.production",
    ".env",
    "certs/server.pem",
    "/w/id.key",
    "/w/config/secrets.yml",
  ];
  for (const path of yes) assert.equal(isSecretFile(path, DEFAULT_SECRET_FILES), true, path);
  const no = ["/w/env.ts", "/w/src/my.env.ts", "/w/keys.ts", "/w/secrets.yaml.bak"];
  for (const path of no) assert.equal(isSecretFile(path, DEFAULT_SECRET_FILES), false, path);
  assert.equal(isSecretFile("/w/.env", []), false);
});

test("secretRanges: values of assignments; keys, comments and empty values stay", () => {
  const text = [
    "# Database",
    "DB_URL=postgres://u:p@host/db",
    "export API_KEY = sk-123  ",
    "EMPTY=",
    "",
    "name: app",
    "  token: abc",
    "url: http://x",
  ].join("\r\n");
  assert.deepEqual(secretRanges(text), [
    { line: 2, startColumn: 8, endColumn: 30 },
    { line: 3, startColumn: 18, endColumn: 24 },
    { line: 6, startColumn: 7, endColumn: 10 },
    { line: 7, startColumn: 10, endColumn: 13 },
    { line: 8, startColumn: 6, endColumn: 14 },
  ]);
});

test("secretRanges: a key file's body is covered, its armor lines aren't", () => {
  // The last line ends in "=" (base64 padding): still all of it, not a "key=value".
  const text =
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n  kqhkiG9w0BAQE\nAB0x==\n-----END PRIVATE KEY-----\n";
  assert.deepEqual(secretRanges(text), [
    { line: 2, startColumn: 1, endColumn: 15 },
    { line: 3, startColumn: 3, endColumn: 16 },
    { line: 4, startColumn: 1, endColumn: 7 },
  ]);
});

test("coveredRanges: the lines a cursor or selection touches show their text", () => {
  const ranges = secretRanges("A=1\nB=2\nC=3\nD=4");
  const shown = coveredRanges(ranges, [
    { startLine: 2, endLine: 2 },
    { startLine: 4, endLine: 4 },
  ]).map((r) => r.line);
  assert.deepEqual(shown, [1, 3]);
});

test("a bare base64 key ending in = padding, and file names in any case (D407)", () => {
  const key = "kDfL3TfZQ4Xb2mJ8nPq7rStUvWxYz0aBcDeFgHiJkLm=";
  assert.deepEqual(secretRanges(key), [{ line: 1, startColumn: 1, endColumn: key.length + 1 }]);
  // An empty setting stays readable.
  assert.deepEqual(secretRanges("API_KEY="), []);
  assert.equal(isSecretFile("C:\\p\\.ENV", DEFAULT_SECRET_FILES), true);
  assert.equal(isSecretFile("/w/server.KEY", DEFAULT_SECRET_FILES), true);
});

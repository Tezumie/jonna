import assert from "node:assert/strict";
import { test } from "node:test";
import { findServerUrls, ServerScanner } from "./servers";

test("finds dev server addresses", () => {
  assert.deepEqual(
    findServerUrls(
      "  \x1b[32m➜\x1b[39m  Local:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m",
    ),
    [{ url: "http://localhost:5173/", port: 5173 }],
  );
  assert.deepEqual(findServerUrls("Server running at http://0.0.0.0:3000."), [
    { url: "http://localhost:3000/", port: 3000 },
  ]);
  assert.deepEqual(findServerUrls("Express listening on port 8080"), [
    { url: "http://localhost:8080/", port: 8080 },
  ]);
  assert.deepEqual(findServerUrls("see https://example.com:443/x"), []);
});

test("URLs split across chunks", () => {
  const s = new ServerScanner();
  assert.deepEqual(s.scan(1, "ready at http://local"), []);
  assert.deepEqual(s.scan(1, "host:4321/\n"), [{ url: "http://localhost:4321/", port: 4321 }]);
});

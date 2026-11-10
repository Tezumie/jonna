import assert from "node:assert/strict";
import { test } from "node:test";
import { browserDigest } from "./browserDigest";

test("open browser tabs and their console errors go with the IDE state (D365)", () => {
  assert.equal(browserDigest([]), "");
  assert.equal(browserDigest([{ url: "about:blank" }]), "");
  assert.equal(
    browserDigest([{ tab: "b1", url: "http://localhost:5173/", title: "TaskFlow", errors: 0 }]),
    'Browser tabs open in the IDE:\n- http://localhost:5173/ "TaskFlow" (tab b1)',
  );
  const text = browserDigest([
    {
      tab: "b1",
      url: "http://localhost:5173/",
      title: "TaskFlow",
      errors: 3,
      recentErrors: [
        { text: "old" },
        { text: "TypeError: Cannot read properties of undefined (reading 'length')\n    at App" },
      ],
      failedRequests: [{ url: "/api/boards", status: 500 }],
    },
  ]);
  assert.ok(text.includes("3 console errors, 1 failed request"));
  assert.ok(
    text.includes("Latest: TypeError: Cannot read properties of undefined (reading 'length')"),
  );
  assert.ok(!text.includes("at App"));
  assert.ok(text.endsWith("Read a tab's console and failed requests with browser_console."));
});

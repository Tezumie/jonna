import assert from "node:assert/strict";
import { test } from "node:test";
import { FileDecorationService } from "./services";

test("decorations merge per field and bump the revision", () => {
  const service = new FileDecorationService();
  const before = service.revision.peek();
  const a = service.register({
    decorate: (p) => (p === "/x" ? { color: "--a", badge: "M", tooltip: "Modified" } : undefined),
  });
  service.register({
    decorate: (p) => (p === "/x" ? { color: "--b", tooltip: "1 error" } : undefined),
  });
  assert.ok(service.revision.peek() > before);
  assert.deepEqual(service.get("/x"), { color: "--b", badge: "M", tooltip: "Modified · 1 error" });
  assert.equal(service.get("/y"), undefined);
  a.dispose();
  assert.deepEqual(service.get("/x"), { color: "--b", tooltip: "1 error" });
});

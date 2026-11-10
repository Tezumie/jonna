import assert from "node:assert/strict";
import { test } from "node:test";
import { Page, problemCounts } from "./page";

test("calls wait for the bridge, then resolve with its result", async () => {
  const sent: Record<string, unknown>[] = [];
  const page = new Page(
    "p1",
    "frame",
    (m) => sent.push(m as Record<string, unknown>),
    (u) => u.replace("http://127.0.0.1:9", "http://localhost:5173"),
  );
  const call = page.call<{ snapshot: string }>("snapshot");
  page.handle({ type: "ready", url: "http://127.0.0.1:9/app", title: "App" });
  assert.equal(page.url.peek(), "http://localhost:5173/app");
  await Promise.resolve();
  const msg = sent[0] ?? {};
  assert.equal(msg.method, "snapshot");
  page.handle({ type: "result", id: msg.id, result: { snapshot: "- button" } });
  assert.deepEqual(await call, { snapshot: "- button" });
});

test("errors, console and leave", async () => {
  const sent: Record<string, unknown>[] = [];
  const page = new Page("p2", "frame", (m) => sent.push(m as Record<string, unknown>));
  page.handle({ type: "ready", url: "u", title: "" });
  page.handle({ type: "console", level: "warn", text: "careful" });
  page.handle({ type: "error", text: "boom", source: "a.js:1:2" });
  page.handle({ type: "network", method: "GET", url: "/x", status: 404 });
  page.handle({ type: "console", level: "evil", text: "ignored" });
  assert.deepEqual(problemCounts(page), { errors: 2, warnings: 1 });
  const click = page.call("click", { ref: "e1" });
  await Promise.resolve();
  page.handle({ type: "leave" });
  assert.deepEqual(await click, {
    navigating: true,
    note: "The page navigated; take a new snapshot.",
  });
  assert.equal(page.connected.peek(), false);
  page.handle({ type: "result", id: 99, error: "stray" });
  page.dispose();
});

test("D318: an emulated color scheme is applied again to each new document", async () => {
  const sent: Record<string, unknown>[] = [];
  const page = new Page("p3", "frame", (m) => sent.push(m as Record<string, unknown>));
  page.handle({ type: "ready", url: "u", title: "", doc: 1 });
  const first = page.emulateColorScheme("dark");
  await Promise.resolve();
  assert.equal(sent.at(-1)?.method, "emulate.colorScheme");
  page.handle({ type: "result", id: sent.at(-1)?.id, result: { colorScheme: "dark" } });
  await first;
  const before = sent.length;
  page.handle({ type: "ready", url: "u", title: "", doc: 1 });
  assert.equal(sent.length, before, "the same document isn't told again");
  page.handle({ type: "ready", url: "u", title: "", doc: 2 });
  await Promise.resolve();
  assert.deepEqual(sent.at(-1)?.params, { scheme: "dark" });
  page.dispose();
});

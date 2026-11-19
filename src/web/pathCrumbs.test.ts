import assert from "node:assert/strict";
import { test } from "node:test";
import { pathCrumbs } from "./pathCrumbs";

const paths = (path: string, windows: boolean) => pathCrumbs(path, windows).map((c) => c.path);
const labels = (path: string, windows: boolean) => pathCrumbs(path, windows).map((c) => c.label);

test("a path on Linux or macOS is its steps from the root", () => {
  assert.deepEqual(labels("/home/dev/projects", false), ["/", "home", "dev", "projects"]);
  assert.deepEqual(paths("/home/dev/projects", false), [
    "/",
    "/home",
    "/home/dev",
    "/home/dev/projects",
  ]);
  assert.deepEqual(paths("/", false), ["/"]);
  assert.deepEqual(paths("/home/dev/", false), ["/", "/home", "/home/dev"]);
});

test("a backslash is a letter of a name off Windows", () => {
  assert.deepEqual(labels("/tmp/a\\b", false), ["/", "tmp", "a\\b"]);
});

test("a Windows path starts at its drive", () => {
  assert.deepEqual(labels("C:\\Users\\me", true), ["C:", "Users", "me"]);
  assert.deepEqual(paths("C:\\Users\\me", true), ["C:\\", "C:\\Users", "C:\\Users\\me"]);
  assert.deepEqual(paths("C:\\", true), ["C:\\"]);
  assert.deepEqual(paths("c:/Users/me", true), ["c:\\", "c:\\Users", "c:\\Users\\me"]);
});

test("a network path starts at its server and share", () => {
  assert.deepEqual(labels("\\\\box\\share\\a\\b", true), ["\\\\box\\share", "a", "b"]);
  assert.deepEqual(paths("\\\\box\\share\\a", true), ["\\\\box\\share\\", "\\\\box\\share\\a"]);
});

test("nothing typed is no step", () => {
  assert.deepEqual(pathCrumbs("  ", false), []);
});
